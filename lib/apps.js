'use strict';
// The apps this server offers its members: the newest Android package (.apk)
// and Windows installer (.exe) placed in APPS_DIR. They are builds of THIS
// server, made with apps/build.mjs (docs/APPS.md), so nothing is offered until
// an operator puts one there; until then the install button falls back to the
// browser's own install of the web app.

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const KINDS = {
    android: { ext: '.apk', type: 'application/vnd.android.package-archive' },
    windows: { ext: '.exe', type: 'application/vnd.microsoft.portable-executable' },
};

const versionOf = (name) => {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(name);
    return m ? m.slice(1).map(Number) : null;
};

// By the version in the file name when both have one, so a re-copied older
// build cannot shadow a newer one; by modification time otherwise.
function newer(a, b) {
    const va = versionOf(a.name);
    const vb = versionOf(b.name);
    if (va && vb) {
        for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return va[i] > vb[i];
    }
    return a.mtimeMs > b.mtimeMs;
}

// Read on every call: the directory holds a handful of files, and a build
// dropped in is offered without a restart.
function newest(kind) {
    let names;
    try { names = fs.readdirSync(config.APPS_DIR); } catch { return null; }
    let best = null;
    for (const name of names) {
        if (path.extname(name).toLowerCase() !== KINDS[kind].ext) continue;
        const file = path.join(config.APPS_DIR, name);
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        if (!st.isFile() || st.size === 0) continue;
        const entry = { file, name, size: st.size, mtimeMs: st.mtimeMs };
        if (!best || newer(entry, best)) best = entry;
    }
    return best;
}

// What a member's device is told: enough to label the download, never a path.
// The Android app's package names let a page tell that the app opened it.
function available() {
    const out = {};
    for (const kind of Object.keys(KINDS)) {
        const f = newest(kind);
        const v = f && versionOf(f.name);
        out[kind] = f ? { version: v ? v.join('.') : null, size: f.size } : null;
    }
    if (out.android) out.android.ids = config.ANDROID_APP_ID;
    return out;
}

function send(kind, res) {
    const f = Object.hasOwn(KINDS, kind) ? newest(kind) : null;
    if (!f) return res.status(404).json({ error: 'Not available' });
    // Set first: the file sender only picks a type when none is set, and an
    // Android phone needs exactly this one to offer to install the download.
    res.type(KINDS[kind].type);
    res.set('Cache-Control', 'private, no-cache');
    res.download(f.file, f.name, (err) => {
        // A download cut short is the client's business; a file gone between
        // the lookup and the send is the only failure there is an answer for.
        if (err && !res.headersSent) res.status(404).json({ error: 'Not available' });
    });
}

module.exports = { available, send };
