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

const config = {
    ROOT,
    PORT: parseInt(env.PORT || '3010', 10),
    HOST: env.HOST || '127.0.0.1',
    BASE_PATH: (env.BASE_PATH || '/connectwell').replace(/\/$/, ''),
    DATA_DIR: path.resolve(ROOT, env.DATA_DIR || 'data'),
    PROD: env.PROD === '1' || env.NODE_ENV === 'production',
    PUBLIC_ORIGIN: env.PUBLIC_ORIGIN || 'https://example.com',
    MAX_UPLOAD_MB: parseInt(env.MAX_UPLOAD_MB || '200', 10),
    SESSION_DAYS: parseInt(env.SESSION_DAYS || '90', 10),
    STUN_URLS: (env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
        .split(',').map(s => s.trim()).filter(Boolean),
    // Optional TURN relay (coturn with use-static-auth-secret). Empty = STUN only.
    TURN_HOST: env.TURN_HOST || '',
    TURN_SECRET: env.TURN_SECRET || '',
    TURN_TTL: parseInt(env.TURN_TTL || '3600', 10),
};

module.exports = config;
