'use strict';
// Shared-file retention.
//
// Two independent rules, both acting ONLY on chat uploads under data/uploads:
//   AGE  — remove anything older than config.FILE_RETENTION_DAYS. The everyday
//          rule, and the one users are told about.
//   SIZE — a backstop. If usage still reaches STORAGE_HIGH_BYTES, remove
//          oldest-first until back under STORAGE_LOW_BYTES. Should never fire.
//
// Profile and group photos are structurally out of reach: they live in
// data/avatars, this module never imports that path, and the only filename it
// ever unlinks is rebuilt from an integer primary key.
//
// Nothing is deleted unless config.PURGE_ENABLED is on. With it off every step
// still runs and reports, writing only the audit log — so the selection can be
// checked against real data before a single byte is lost.

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const DB = require('./db');

const UPLOADS = path.join(config.DATA_DIR, 'uploads');
const AUDIT_LOG = path.join(config.DATA_DIR, 'purge-log.jsonl');
const DAY_MS = 86_400_000;
const PAGE = 500;
const RECLAIM_LIMIT = 200;

// A chat upload is named for its message id and nothing else. Matching the whole
// name against digits excludes tmp-* staging files and anything hand-placed, so
// neither is ever counted or deleted.
const UPLOAD_NAME_RE = /^\d+$/;

let running = false;

// Disk is the source of truth for "how much are we using", because the database
// cannot know about a failed write or a file removed underneath it.
function measure() {
    let bytes = 0;
    let files = 0;
    let ignored = 0;
    let names;
    try {
        names = fs.readdirSync(UPLOADS);
    } catch (err) {
        console.error('storage: cannot read uploads dir:', err.message);
        return { bytes: 0, files: 0, ignored: 0 };
    }
    for (const name of names) {
        if (!UPLOAD_NAME_RE.test(name)) { ignored += 1; continue; }
        try {
            const st = fs.statSync(path.join(UPLOADS, name));
            if (st.isFile()) { bytes += st.size; files += 1; }
        } catch { /* vanished between readdir and stat */ }
    }
    return { bytes, files, ignored };
}

function audit(entry) {
    try {
        fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + '\n');
    } catch (err) {
        console.error('storage: could not write audit log:', err.message);
    }
}

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

// Collect every row older than `cutoff`, walking forward by id.
async function collect(cutoff, seen, out, reason, stopWhen) {
    let cursor = 0;
    for (;;) {
        const rows = DB.stmts.purgeCandidates.all(cutoff, cursor, PAGE);
        if (!rows.length) return;
        for (const row of rows) {
            if (stopWhen && stopWhen()) return;
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            out.push({ ...row, reason });
        }
        cursor = rows[rows.length - 1].id;
        if (rows.length < PAGE) return;
        await yieldToLoop();       // the process also serves chat and media
    }
}

async function sweep({ trigger = 'timer' } = {}) {
    if (running) return { skipped: 'a sweep is already running' };
    running = true;
    const startedAt = Date.now();
    try {
        const before = measure();
        const now = Date.now();

        // A row is not a candidate until its upload is certainly finished: the
        // upload handler inserts the row and only THEN renames the file into
        // place, so a younger row may have no bytes on disk yet.
        const inFlightCutoff = now - config.STORAGE_MIN_AGE_MS;

        const seen = new Set();
        const selected = [];

        // 1. AGE — never newer than the in-flight guard, whichever is stricter.
        if (config.FILE_RETENTION_DAYS > 0) {
            const ageCutoff = Math.min(now - config.FILE_RETENTION_DAYS * DAY_MS, inFlightCutoff);
            await collect(ageCutoff, seen, selected, 'age', null);
        }

        // 2. SIZE — only if age alone leaves us at or above the high-water mark.
        let projected = before.bytes - selected.reduce((n, r) => n + (r.file_size || 0), 0);
        const thresholdsUsable = Number.isFinite(config.STORAGE_HIGH_BYTES)
            && Number.isFinite(config.STORAGE_LOW_BYTES)
            && config.STORAGE_LOW_BYTES > 0
            && config.STORAGE_LOW_BYTES < config.STORAGE_HIGH_BYTES;

        if (thresholdsUsable && projected >= config.STORAGE_HIGH_BYTES) {
            const sizePicked = [];
            await collect(inFlightCutoff, seen, sizePicked, 'size',
                () => projected <= config.STORAGE_LOW_BYTES);
            // collect() pushes before we can subtract, so account here and drop
            // anything taken past the point the target was met.
            for (const row of sizePicked) {
                if (projected <= config.STORAGE_LOW_BYTES) { seen.delete(row.id); continue; }
                projected -= (row.file_size || 0);
                selected.push(row);
            }
            if (projected > config.STORAGE_LOW_BYTES) {
                console.warn('storage: nothing further is eligible; still above the low-water mark');
            }
        }

        // 3. Act. Audit first, then mark, then unlink — so an interrupted sweep
        // leaves bytes behind with a correct placeholder, never live-looking
        // media whose bytes are already gone.
        const mode = config.PURGE_ENABLED ? 'purge' : 'dry-run';
        let purged = 0;
        let freed = 0;
        let failed = 0;

        for (const row of selected) {
            // The id comes from an INTEGER PRIMARY KEY; this is belt-and-braces
            // because it is about to become a filesystem path.
            if (!Number.isInteger(row.id) || row.id <= 0) { failed += 1; continue; }

            audit({
                ts: now, mode, trigger, reason: row.reason,
                id: row.id, conversationId: row.conversation_id, senderId: row.sender_id,
                fileName: row.file_name, bytes: row.file_size, createdAt: row.created_at,
            });
            if (!config.PURGE_ENABLED) continue;

            const res = DB.stmts.markPurged.run(now, row.id);
            if (res.changes === 0) continue;          // deleted or purged under us
            try {
                fs.unlinkSync(path.join(UPLOADS, String(row.id)));
            } catch (err) {
                if (err.code !== 'ENOENT') {          // absent is the desired end state
                    failed += 1;
                    console.error('storage: unlink failed for message ' + row.id + ':', err.message);
                    continue;
                }
            }
            purged += 1;
            freed += row.file_size || 0;
        }

        // 4. Reclaim: a previous unlink may have failed after the row was marked.
        // Bounded, and cheap because almost every attempt is already ENOENT.
        let reclaimed = 0;
        if (config.PURGE_ENABLED) {
            for (const row of DB.stmts.recentPurged.all(RECLAIM_LIMIT)) {
                try {
                    fs.unlinkSync(path.join(UPLOADS, String(row.id)));
                    reclaimed += 1;
                } catch { /* ENOENT: already gone, which is the point */ }
            }
        }

        const report = {
            mode, trigger,
            before: before.bytes,
            after: config.PURGE_ENABLED ? measure().bytes : before.bytes,
            files: before.files,
            ignored: before.ignored,
            selected: selected.length,
            byAge: selected.filter((r) => r.reason === 'age').length,
            bySize: selected.filter((r) => r.reason === 'size').length,
            purged, freed, failed, reclaimed,
            tookMs: Date.now() - startedAt,
        };
        if (selected.length) console.log('storage sweep:', JSON.stringify(report));
        return report;
    } finally {
        running = false;
    }
}

function status() {
    const m = measure();
    return {
        ...m,
        liveBytesInDb: DB.stmts.liveFileBytes.get().n,
        retentionDays: config.FILE_RETENTION_DAYS,
        highBytes: config.STORAGE_HIGH_BYTES,
        lowBytes: config.STORAGE_LOW_BYTES,
        minAgeMs: config.STORAGE_MIN_AGE_MS,
        sweepMs: config.STORAGE_SWEEP_MS,
        purgeEnabled: config.PURGE_ENABLED,
        running,
    };
}

module.exports = { measure, sweep, status };
