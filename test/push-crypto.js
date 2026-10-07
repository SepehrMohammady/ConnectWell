// Web Push crypto against the specifications' own numbers.
//   1. aes128gcm encryption reproduces RFC 8291 Appendix A byte for byte
//   2. a fresh encryption decrypts again on the receiving side
//   3. the VAPID JWT verifies with the public key and names the right audience
// A push service rejects a malformed message without saying much, so this is
// the only place a mistake here would ever be caught before production.
const crypto = require('node:crypto');
const path = require('node:path');
const wp = require(path.join(__dirname, '..', 'lib', 'webpush.js'));

let fail = 0;
const ok = (l) => console.log('  PASS ' + l);
const bad = (l, d) => { fail++; console.log('  FAIL ' + l + (d ? '\n        ' + d : '')); };
const join = (...parts) => parts.join('').replace(/\s+/g, '');

/* 1 — RFC 8291 Appendix A. The RFC prints values wrapped with spaces. */
const rfc = {
    plaintext: 'When I grow up, I want to be a watermelon',
    asPublic: join('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg', 'Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'),
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    uaPublic: join('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-', 'JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
    uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    header: join('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml',
        'mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8'),
    ciphertext: join('8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs', 'bI_0LpXMuGvnzQ'),
};

const body = wp.encrypt(Buffer.from(rfc.plaintext), rfc.uaPublic, rfc.auth, {
    salt: wp.unb64u(rfc.salt), asPrivateKey: rfc.asPrivate,
});
const want = Buffer.concat([wp.unb64u(rfc.header), wp.unb64u(rfc.ciphertext)]);
if (body.equals(want)) ok('aes128gcm encryption matches RFC 8291 Appendix A byte for byte');
else bad('aes128gcm encryption matches RFC 8291 Appendix A', 'got  ' + wp.b64u(body) + '\n        want ' + wp.b64u(want));

/* 2 — the receiving side, written out from RFC 8291 section 3. */
function decrypt(buf, uaPrivate, uaPublic, auth) {
    const salt = buf.subarray(0, 16);
    const idlen = buf[20];
    const asPublic = buf.subarray(21, 21 + idlen);
    const sealed = buf.subarray(21 + idlen);
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(wp.unb64u(uaPrivate));
    const secret = ecdh.computeSecret(asPublic);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), wp.unb64u(uaPublic), asPublic]);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, wp.unb64u(auth), keyInfo, 32));
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
    if (plain[plain.length - 1] !== 0x02) throw new Error('missing final-record delimiter');
    return plain.subarray(0, plain.length - 1).toString('utf8');
}

try {
    const text = JSON.stringify({ title: 'سلام', body: 'round trip ✓' });
    const sealed = wp.encrypt(Buffer.from(text), rfc.uaPublic, rfc.auth);
    const back = decrypt(sealed, rfc.uaPrivate, rfc.uaPublic, rfc.auth);
    if (back === text) ok('a fresh encryption decrypts on the receiving side (random salt and key)');
    else bad('round trip', 'got ' + back);
    const again = wp.encrypt(Buffer.from(text), rfc.uaPublic, rfc.auth);
    if (!again.equals(sealed)) ok('two encryptions of the same payload differ (fresh salt and ephemeral key)');
    else bad('two encryptions of the same payload differ');
} catch (e) { bad('round trip', e.message); }

try {
    wp.encrypt(Buffer.alloc(4096), rfc.uaPublic, rfc.auth);
    bad('oversized payload is refused');
} catch { ok('oversized payload is refused rather than sent'); }

/* 3 — VAPID. */
try {
    const generated = wp.generateVapidKeys();
    const keys = wp.loadVapidKeys(generated);
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc:def';
    const header = wp.vapidAuthorization(endpoint, keys, 'https://chat.example.com', Date.now());
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    if (!m) throw new Error('unexpected header shape: ' + header);
    const [h, c, s] = m[1].split('.');
    const pub = wp.unb64u(m[2]);
    const pubKey = crypto.createPublicKey({
        format: 'jwk',
        key: { kty: 'EC', crv: 'P-256', x: wp.b64u(pub.subarray(1, 33)), y: wp.b64u(pub.subarray(33)) },
    });
    const valid = crypto.verify('sha256', Buffer.from(h + '.' + c), { key: pubKey, dsaEncoding: 'ieee-p1363' }, wp.unb64u(s));
    const claims = JSON.parse(wp.unb64u(c).toString());
    const head = JSON.parse(wp.unb64u(h).toString());
    if (!valid) bad('VAPID JWT verifies with the advertised public key');
    else ok('VAPID JWT verifies with the advertised public key');
    if (head.alg === 'ES256' && wp.unb64u(s).length === 64) ok('signature is raw ES256 (64-byte r||s), not DER');
    else bad('signature is raw ES256', JSON.stringify(head));
    if (claims.aud === 'https://fcm.googleapis.com' && claims.sub === 'https://chat.example.com'
        && claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 86400) {
        ok('claims name the push service origin, the subject, and an expiry under 24h');
    } else bad('JWT claims', JSON.stringify(claims));
    if (m[2] === generated.publicKey) ok('k= carries the same key the browser subscribed with');
    else bad('k= key mismatch');
} catch (e) { bad('VAPID', e.message); }

try {
    const a = wp.generateVapidKeys();
    const b = wp.generateVapidKeys();
    wp.loadVapidKeys({ publicKey: a.publicKey, privateKey: b.privateKey });
    bad('mismatched VAPID key pair is rejected');
} catch { ok('mismatched VAPID key pair is rejected at load'); }

console.log('\n' + (fail === 0 ? 'PUSH CRYPTO PASSED' : fail + ' FAILURE(S)'));
process.exit(fail === 0 ? 0 : 1);
