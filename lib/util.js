'use strict';
const crypto = require('node:crypto');

/* ---------------- passwords (scrypt) ---------------- */

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return { salt, hash };
}

function verifyPassword(password, salt, expectedHex) {
    const hash = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

/* ---------------- session tokens ---------------- */

function newToken() {
    return crypto.randomBytes(32).toString('hex');
}

function tokenHash(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/* ---------------- cookies ---------------- */

function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        try {
            out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
        } catch { /* ignore malformed cookie values */ }
    }
    return out;
}

function sessionCookie(name, value, { basePath, secure, maxAgeSec }) {
    let c = `${name}=${encodeURIComponent(value)}; Path=${basePath || '/'}; HttpOnly; SameSite=Lax`;
    if (maxAgeSec !== undefined) c += `; Max-Age=${maxAgeSec}`;
    if (secure) c += '; Secure';
    return c;
}

/* ---------------- simple in-memory rate limiter ---------------- */

const buckets = new Map();

function rateLimit(key, max, windowMs) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now >= b.reset) {
        b = { n: 0, reset: now + windowMs };
        buckets.set(key, b);
    }
    b.n += 1;
    return b.n <= max;
}

// Periodic cleanup so the map does not grow forever.
setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (now >= b.reset) buckets.delete(k);
}, 60_000).unref();

/* ---------------- validation ---------------- */

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

function validUsername(u) { return typeof u === 'string' && USERNAME_RE.test(u); }

function validDisplayName(n) {
    return typeof n === 'string' && n.trim().length >= 1 && n.trim().length <= 50;
}

function validPassword(p) { return typeof p === 'string' && p.length >= 8 && p.length <= 200; }

/* ---------------- files / mime ---------------- */

function classifyMime(mime, requested) {
    if (requested === 'voice' || requested === 'videomsg') return requested;
    if (!mime) return 'document';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'document';
}

// Mimes that are safe to render inline in the browser. Everything else is
// served as an attachment so uploaded HTML/SVG can never run in our origin.
const INLINE_MIMES = new Set([
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
    'video/mp4', 'video/webm', 'video/quicktime',
    'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/x-wav',
    'audio/webm', 'audio/ogg', 'audio/flac',
    'application/pdf',
]);

// Identify an image from its magic bytes and read its pixel dimensions, without
// decoding it (the project takes no image dependency).
//
// Two things depend on this and neither can be done on the client, because an
// attacker simply does not run our client:
//  - the served Content-Type is derived from these bytes, never from the request
//    or the database, so an HTML/script payload wearing an image name cannot be
//    executed in our own origin (CSP allows same-origin scripts)
//  - the dimensions bound a decompression bomb: a flat 30000x30000 PNG fits in a
//    few hundred KB and expands to gigabytes of RGBA in every viewer's browser
//
// Deliberately narrow: PNG, JPEG and WebP only. SVG is scriptable, GIF animates
// in a list of avatars, and neither is needed to store a square photo.
function sniffImage(buf) {
    if (!buf || buf.length < 24) return null;

    // PNG: IHDR is mandated to be the first chunk, so the size is at a fixed offset.
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
        && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
        return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }

    // JPEG: walk the marker segments until a start-of-frame carries the size.
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let off = 2;
        while (off + 9 < buf.length) {
            if (buf[off] !== 0xff) { off += 1; continue; }        // resync over fill bytes
            const marker = buf[off + 1];
            if (marker === 0xff) { off += 1; continue; }
            // Standalone markers carry no length field.
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
            if (marker === 0xda || marker === 0xd9) return null;   // reached scan data, no SOF
            const len = buf.readUInt16BE(off + 2);
            if (len < 2) return null;
            // SOF0 baseline, SOF1 extended, SOF2 progressive.
            if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
                // SOF layout: len(2) precision(1) height(2) width(2) -- height precedes width.
                return { mime: 'image/jpeg', width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) };
            }
            off += 2 + len;
        }
        return null;
    }

    // WebP: RIFF container, then one of three payload chunks.
    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const chunk = buf.toString('ascii', 12, 16);
        if (chunk === 'VP8 ') {                                   // lossy, 14-bit dims
            return { mime: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
        }
        if (chunk === 'VP8L') {                                   // lossless, packed 14-bit dims
            const bits = buf.readUInt32LE(21);
            return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
        }
        if (chunk === 'VP8X') {                                   // extended, 24-bit canvas size
            if (buf[20] & 0x02) return null;                      // ANIM flag: animated, refuse
            return {
                mime: 'image/webp',
                width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
                height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1,
            };
        }
    }

    return null;
}

// The fixed reaction palette. Server-validated so only these can ever be stored.
// Kept in lock-step with REACTIONS in public/js/chat.js — change both together.
const REACTIONS = ['👍', '👎', '❤️', '😂', '😮', '😢', '🙏', '🎉', '😡', '👏'];

function sanitizeFilename(name) {
    if (typeof name !== 'string') return 'file';
    // Strip path components, then control chars and filesystem-hostile chars.
    let base = name.substring(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
    base = base.replace(/[\u0000-\u001f"<>|:*?]/g, '').trim();
    if (base.length > 120) {
        const dot = base.lastIndexOf('.');
        const ext = dot > 0 ? base.slice(dot).slice(0, 12) : '';
        base = base.slice(0, 120 - ext.length) + ext;
    }
    return base || 'file';
}

module.exports = {
    hashPassword, verifyPassword,
    newToken, tokenHash,
    parseCookies, sessionCookie,
    rateLimit,
    validUsername, validDisplayName, validPassword,
    classifyMime, INLINE_MIMES, sanitizeFilename, sniffImage, REACTIONS,
};
