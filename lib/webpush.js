'use strict';
// Web Push on node:crypto alone: VAPID (RFC 8292) to identify this server to a
// push service, and aes128gcm payload encryption (RFC 8188 + RFC 8291) so the
// push service — Google's, Mozilla's, Microsoft's or Apple's, depending on the
// browser — relays only ciphertext it cannot read.
//
// No dependency on purpose. The whole protocol is an ECDH, two HKDFs, one
// AES-GCM and one ES256 signature, all of which node:crypto has built in, and
// test/push-crypto.js pins the encryption to the RFC's own worked example.

const crypto = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url');

/* ---------------- VAPID keys ----------------
   P-256. The public key travels as an uncompressed point (65 bytes, 0x04 prefix)
   because that is the form browsers take as `applicationServerKey`; the private
   key is the bare 32-byte scalar. */

function generateVapidKeys() {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

// Checked rather than trusted: a mangled key would otherwise surface much later
// as every push being refused with a 401 nobody connects to the cause.
function loadVapidKeys({ publicKey, privateKey }) {
    const pub = unb64u(publicKey);
    const priv = unb64u(privateKey);
    if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
    if (priv.length !== 32) throw new Error('VAPID private key must be 32 bytes');
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(priv);
    if (!ecdh.getPublicKey().equals(pub)) throw new Error('VAPID public and private keys do not belong together');
    const keyObject = crypto.createPrivateKey({
        format: 'jwk',
        key: {
            kty: 'EC', crv: 'P-256',
            x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: b64u(priv),
        },
    });
    return { publicKey: b64u(pub), keyObject };
}

/* ---------------- VAPID authorization ----------------
   A short JWT naming the push service's origin as audience. It is signed per
   audience and reused until shortly before it expires: signing on every send is
   cheap, but a burst to one service would otherwise mint a fresh token each time
   for no benefit. */

const JWT_LIFETIME_S = 12 * 3600;      // RFC 8292 allows up to 24 hours
const jwtCache = new Map();             // audience -> { header, until }

function vapidAuthorization(endpoint, keys, subject, now = Date.now()) {
    const aud = new URL(endpoint).origin;
    const cacheKey = aud + ' ' + keys.publicKey + ' ' + subject;
    const hit = jwtCache.get(cacheKey);
    if (hit && hit.until > now) return hit.header;

    const exp = Math.floor(now / 1000) + JWT_LIFETIME_S;
    const input = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })) + '.'
        + b64u(JSON.stringify({ aud, exp, sub: subject }));
    // ES256 in JOSE is the raw 64-byte r||s, not the DER that sign() emits by default.
    const sig = crypto.sign('sha256', Buffer.from(input), { key: keys.keyObject, dsaEncoding: 'ieee-p1363' });
    const header = `vapid t=${input}.${b64u(sig)}, k=${keys.publicKey}`;
    // Refreshed an hour early so a token never expires in flight.
    jwtCache.set(cacheKey, { header, until: now + (JWT_LIFETIME_S - 3600) * 1000 });
    return header;
}

/* ---------------- payload encryption ----------------
   One aes128gcm record (RFC 8188) keyed per RFC 8291: an ephemeral ECDH with
   the browser's p256dh key, mixed with its auth secret. `salt` and `asPrivateKey`
   are parameters only so the RFC's worked example can be reproduced exactly;
   real sends always take fresh random values. */

const RECORD_SIZE = 4096;

function encrypt(plaintext, p256dh, auth, { salt = crypto.randomBytes(16), asPrivateKey = null } = {}) {
    const uaPublic = unb64u(p256dh);
    const authSecret = unb64u(auth);
    if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('bad p256dh key');
    if (authSecret.length < 16) throw new Error('bad auth secret');

    const ecdh = crypto.createECDH('prime256v1');
    if (asPrivateKey) ecdh.setPrivateKey(unb64u(asPrivateKey)); else ecdh.generateKeys();
    const asPublic = ecdh.getPublicKey();
    const ecdhSecret = ecdh.computeSecret(uaPublic);

    // hkdfSync is Extract-then-Expand, which is exactly the shape of each step.
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

    // 0x02 marks the final (and only) record; no padding follows it.
    const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])]);
    if (data.length + 16 > RECORD_SIZE) throw new Error('push payload too large');
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const sealed = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);

    const header = Buffer.alloc(21);
    Buffer.from(salt).copy(header, 0);
    header.writeUInt32BE(RECORD_SIZE, 16);
    header[20] = asPublic.length;
    return Buffer.concat([header, asPublic, sealed]);
}

/* ---------------- sending ---------------- */

// Push services accept at least 4096 bytes of body. The 86-byte header and the
// 17 bytes of delimiter and tag come out of that, so callers keep payloads well
// under this and trim message text rather than risk a 413.
const MAX_PLAINTEXT = 3000;

async function send(sub, payload, { keys, subject, ttl = 86400, urgency = 'normal', topic = null, timeoutMs = 15000 }) {
    const json = Buffer.from(JSON.stringify(payload));
    if (json.length > MAX_PLAINTEXT) throw new Error('push payload too large');
    const headers = {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(Math.max(0, Math.floor(ttl))),
        Urgency: urgency,
        Authorization: vapidAuthorization(sub.endpoint, keys, subject),
    };
    // Lets the push service replace an undelivered message with a newer one on
    // the same topic — a "missed call" overtakes the ring it ended.
    if (topic) headers.Topic = topic;
    const res = await fetch(sub.endpoint, {
        method: 'POST', headers,
        body: encrypt(json, sub.p256dh, sub.auth),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
    });
    // The body is drained so the connection can be reused, and kept only for
    // the log: push services explain refusals there.
    const text = await res.text().catch(() => '');
    return { status: res.status, text: res.ok ? '' : text.slice(0, 300) };
}

module.exports = {
    generateVapidKeys, loadVapidKeys, vapidAuthorization, encrypt, send,
    MAX_PLAINTEXT, b64u, unb64u,
};
