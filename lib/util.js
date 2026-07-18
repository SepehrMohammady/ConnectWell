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
    classifyMime, INLINE_MIMES, sanitizeFilename,
};
