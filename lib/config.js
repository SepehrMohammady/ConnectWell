'use strict';
// Central configuration. Values come from a .env file at the project root
// (KEY=VALUE lines, # comments) overridden by real environment variables.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function loadDotEnv() {
    const file = path.join(ROOT, '.env');
    if (!fs.existsSync(file)) return {};
    const out = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (!m || line.trim().startsWith('#')) continue;
        out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
}

const env = { ...loadDotEnv(), ...process.env };

const GB = 1024 ** 3;
// NaN rather than a silent default, so a typo'd value is caught by the storage
// validation below instead of quietly becoming a threshold nobody intended.
const num = (v, dflt) => (v === undefined || v === '' ? dflt : Number(v));

const config = {
    ROOT,
    PORT: parseInt(env.PORT || '3010', 10),
    HOST: env.HOST || '127.0.0.1',
    BASE_PATH: (env.BASE_PATH || '/connectwell').replace(/\/$/, ''),
    DATA_DIR: path.resolve(ROOT, env.DATA_DIR || 'data'),
    PROD: env.PROD === '1' || env.NODE_ENV === 'production',
    PUBLIC_ORIGIN: env.PUBLIC_ORIGIN || 'https://example.com',
    MAX_UPLOAD_MB: parseInt(env.MAX_UPLOAD_MB || '200', 10),
    // Ceiling on one user's live shared-file bytes. Forwarding duplicates bytes
    // from a tiny request, so without a cap a single user could amplify one file
    // into unbounded disk use; this bounds their total footprint. Generous for
    // real use; retention still reclaims old files under it.
    PER_USER_FILE_MB: parseInt(env.PER_USER_FILE_MB || '5120', 10),
    SESSION_DAYS: parseInt(env.SESSION_DAYS || '90', 10),
    STUN_URLS: (env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
        .split(',').map(s => s.trim()).filter(Boolean),
    // Optional TURN relay (coturn with use-static-auth-secret). Empty = STUN only.
    TURN_HOST: env.TURN_HOST || '',
    TURN_SECRET: env.TURN_SECRET || '',
    TURN_TTL: parseInt(env.TURN_TTL || '3600', 10),

    /* ---------------- shared-file retention ----------------
       Two independent rules, both operating only on chat uploads in
       data/uploads. Profile and group photos live in data/avatars and are never
       eligible.

       1. AGE  — anything older than FILE_RETENTION_DAYS is removed. This is the
          everyday rule and the one users are told about. 0 disables it.
       2. SIZE — an emergency backstop: if usage still reaches STORAGE_HIGH_BYTES,
          remove oldest-first until back under STORAGE_LOW_BYTES.

       Byte values win over the friendlier GB ones, and exist so tests can use
       tiny thresholds without special-casing the production code path. */
    FILE_RETENTION_DAYS: num(env.FILE_RETENTION_DAYS, 365),
    STORAGE_HIGH_BYTES: env.STORAGE_HIGH_BYTES !== undefined
        ? num(env.STORAGE_HIGH_BYTES, NaN) : num(env.STORAGE_HIGH_GB, 60) * GB,
    STORAGE_LOW_BYTES: env.STORAGE_LOW_BYTES !== undefined
        ? num(env.STORAGE_LOW_BYTES, NaN) : num(env.STORAGE_LOW_GB, 50) * GB,
    STORAGE_SWEEP_MS: num(env.STORAGE_SWEEP_MS, 900_000),
    // A row is not a candidate until its upload is long finished. The upload
    // handler inserts the row BEFORE renaming the file into place, so without
    // this a sweep can mark a just-sent file purged while its bytes land after.
    STORAGE_MIN_AGE_MS: num(env.STORAGE_MIN_AGE_MS, 3_600_000),
    // Deletion is off unless explicitly switched on. Everything else runs as a
    // dry run that only writes an audit log.
    PURGE_ENABLED: env.PURGE_ENABLED === '1',
};

/* Validate the retention settings. Anything nonsensical disables purging
   outright rather than being clamped: a swapped or mistyped threshold must never
   be interpreted as "delete until the list is empty". */
if (!(Number.isFinite(config.PER_USER_FILE_MB) && config.PER_USER_FILE_MB > 0)) {
    config.PER_USER_FILE_MB = 5120;
}

const storageProblems = [];
if (!Number.isFinite(config.STORAGE_HIGH_BYTES) || !Number.isFinite(config.STORAGE_LOW_BYTES)) {
    storageProblems.push('thresholds are not numbers');
} else if (!(config.STORAGE_LOW_BYTES > 0 && config.STORAGE_LOW_BYTES < config.STORAGE_HIGH_BYTES)) {
    storageProblems.push('need 0 < STORAGE_LOW_BYTES < STORAGE_HIGH_BYTES');
}
if (!Number.isFinite(config.FILE_RETENTION_DAYS) || config.FILE_RETENTION_DAYS < 0) {
    storageProblems.push('FILE_RETENTION_DAYS must be 0 or a positive number');
}
if (!Number.isFinite(config.STORAGE_MIN_AGE_MS) || config.STORAGE_MIN_AGE_MS < 0) {
    storageProblems.push('STORAGE_MIN_AGE_MS must be 0 or a positive number');
}
if (!Number.isFinite(config.STORAGE_SWEEP_MS) || config.STORAGE_SWEEP_MS < 0) {
    storageProblems.push('STORAGE_SWEEP_MS must be 0 or a positive number');
}
if (storageProblems.length) {
    console.error('storage: ' + storageProblems.join('; ') + ' — purging disabled');
    config.PURGE_ENABLED = false;
    config.STORAGE_SWEEP_MS = 0;
    config.FILE_RETENTION_DAYS = 0;
}

module.exports = config;
