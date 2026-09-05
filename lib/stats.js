'use strict';
// What the person running this instance needs to be able to see: how much disk
// it is using, how much is left, and how much is actually going on inside it.
//
// Everything here is read-only and computed on demand. Disk figures come from
// the filesystem rather than the database, for the same reason the retention
// sweep measures that way: the database cannot know about a failed write or a
// file removed underneath it.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const config = require('./config');
const DB = require('./db');

const DAY_MS = 86_400_000;

// Total bytes and file count of a directory, one level deep. Uploads and avatars
// are both flat, and walking deeper would only pick up things this app did not
// put there.
function dirUsage(dir) {
    let bytes = 0, files = 0;
    let names;
    try { names = fs.readdirSync(dir); } catch { return { bytes: 0, files: 0 }; }
    for (const name of names) {
        try {
            const st = fs.statSync(path.join(dir, name));
            if (st.isFile()) { bytes += st.size; files += 1; }
        } catch { /* vanished between readdir and stat */ }
    }
    return { bytes, files };
}

const fileSize = (p) => {
    try { return fs.statSync(p).size; } catch { return 0; }
};

// In WAL mode the database is three files, and the -wal one can be much the
// larger. Reporting only connectwell.db would understate it badly — the same
// trap that makes `cp` a broken backup here.
function databaseUsage() {
    const base = path.join(config.DATA_DIR, 'connectwell.db');
    const main = fileSize(base);
    const wal = fileSize(base + '-wal');
    const shm = fileSize(base + '-shm');
    return { bytes: main + wal + shm, main, wal, shm };
}

// Free space on the volume holding the data directory. statfs landed in Node 18
// and is the only portable way to ask; a platform that refuses just reports null
// rather than the panel inventing a number.
function diskSpace() {
    try {
        const st = fs.statfsSync(config.DATA_DIR);
        const total = st.blocks * st.bsize;
        const free = st.bavail * st.bsize;
        return { total, free, used: total - free };
    } catch { return null; }
}

const count = (sql, ...args) => DB.db.prepare(sql).get(...args).n;

function stats() {
    const now = Date.now();
    const uploads = dirUsage(path.join(config.DATA_DIR, 'uploads'));
    const avatars = dirUsage(path.join(config.DATA_DIR, 'avatars'));
    const database = databaseUsage();
    const ws = require('./ws');

    return {
        server: {
            version: require('../package.json').version,
            node: process.version,
            platform: `${os.type()} ${os.release()}`,
            // Of the app, not of the machine — this is what tells you whether it
            // has been restarting behind your back.
            uptimeSec: Math.round(process.uptime()),
            startedAt: now - Math.round(process.uptime() * 1000),
            memoryBytes: process.memoryUsage().rss,
            loadAvg: os.loadavg()[0],
            cpus: os.cpus().length,
        },
        storage: {
            uploads,
            avatars,
            database,
            totalBytes: uploads.bytes + avatars.bytes + database.bytes,
            disk: diskSpace(),
        },
        people: {
            active: count("SELECT COUNT(*) AS n FROM users WHERE status = 'active'"),
            pending: count("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'"),
            blocked: count("SELECT COUNT(*) AS n FROM users WHERE status = 'blocked'"),
            deleted: count("SELECT COUNT(*) AS n FROM users WHERE status = 'deleted'"),
            admins: count("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'"),
            onlineNow: ws.onlineUserIds().length,
        },
        activity: {
            conversations: count("SELECT COUNT(*) AS n FROM conversations WHERE type = 'direct'")
                + count("SELECT COUNT(*) AS n FROM conversations WHERE type = 'group'"),
            direct: count("SELECT COUNT(*) AS n FROM conversations WHERE type = 'direct'"),
            groups: count("SELECT COUNT(*) AS n FROM conversations WHERE type = 'group'"),
            messages: count('SELECT COUNT(*) AS n FROM messages WHERE deleted = 0'),
            messagesDay: count('SELECT COUNT(*) AS n FROM messages WHERE deleted = 0 AND created_at > ?', now - DAY_MS),
            messagesWeek: count('SELECT COUNT(*) AS n FROM messages WHERE deleted = 0 AND created_at > ?', now - 7 * DAY_MS),
            // Files still referenced by a live message, as opposed to bytes on
            // disk: a gap between the two is how an orphan shows up.
            files: count("SELECT COUNT(*) AS n FROM messages WHERE deleted = 0 AND file_size IS NOT NULL AND purged_at IS NULL"),
            purged: count('SELECT COUNT(*) AS n FROM messages WHERE purged_at IS NOT NULL'),
            calls: count("SELECT COUNT(*) AS n FROM messages WHERE sys_key IN ('sys.call_voice','sys.call_video')"),
            missedCalls: count("SELECT COUNT(*) AS n FROM messages WHERE sys_key IN ('sys.call_missed_voice','sys.call_missed_video')"),
        },
        // The retention rules and whether deletion is actually switched on. The
        // most important line on the whole panel is purgeEnabled.
        retention: require('./storage').status(),
    };
}

module.exports = { stats };
