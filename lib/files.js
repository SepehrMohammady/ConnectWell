'use strict';
// File sharing: streaming uploads (raw body, no multipart) and authenticated
// downloads with HTTP Range support so audio/video seek + iOS playback work.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream');
const express = require('express');
const config = require('./config');
const DB = require('./db');
const ws = require('./ws');
const { rateLimit, classifyMime, INLINE_MIMES, sanitizeFilename } = require('./util');

const UPLOADS = path.join(config.DATA_DIR, 'uploads');
const router = express.Router();

const filePath = (msgId) => path.join(UPLOADS, String(msgId));

function removeMessageFile(msgId) {
    fs.promises.unlink(filePath(msgId)).catch(() => { });
}

function removeConversationFiles(convId) {
    const rows = DB.db.prepare(
        'SELECT id FROM messages WHERE conversation_id = ? AND file_size IS NOT NULL').all(convId);
    for (const r of rows) removeMessageFile(r.id);
}

// Any tmp-* files left behind by a crash are garbage once we boot fresh.
for (const f of fs.readdirSync(UPLOADS)) {
    if (f.startsWith('tmp-')) fs.promises.unlink(path.join(UPLOADS, f)).catch(() => { });
}

function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (req.user.status !== 'active') return res.status(403).json({ error: 'Account disabled' });
    next();
}

const EXT_BY_MIME = {
    'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
    'video/webm': 'webm', 'video/mp4': 'mp4', 'video/quicktime': 'mov',
};

/* ---------------- upload ---------------- */

router.post('/conversations/:id/upload', requireAuth, (req, res) => {
    const convId = Number(req.params.id);
    const conv = DB.stmts.convById.get(convId);
    if (!conv || !DB.stmts.isMember.get(convId, req.user.id)) {
        return res.status(404).json({ error: 'Conversation not found' });
    }
    if (!rateLimit('up:' + req.user.id, 20, 60_000)) {
        return res.status(429).json({ error: 'Too many uploads, wait a moment' });
    }

    const cap = config.MAX_UPLOAD_MB * 1024 * 1024;
    if (Number(req.headers['content-length'] || 0) > cap) {
        return res.status(413).json({ error: `Files can be at most ${config.MAX_UPLOAD_MB} MB` });
    }

    const mime = String(req.headers['content-type'] || 'application/octet-stream')
        .split(';')[0].trim().toLowerCase();
    const msgType = classifyMime(mime, String(req.headers['x-msg-type'] || ''));
    const durHeader = Number(req.headers['x-duration']);
    const duration = Number.isFinite(durHeader) && durHeader > 0 ? Math.round(durHeader * 10) / 10 : null;

    let fileName = '';
    try { fileName = sanitizeFilename(decodeURIComponent(String(req.headers['x-file-name'] || ''))); } catch { }
    if (!fileName || fileName === 'file') {
        const ext = EXT_BY_MIME[mime] || 'bin';
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        fileName = `${msgType === 'videomsg' ? 'video-message' : msgType === 'voice' ? 'voice-message' : 'file'}-${stamp}.${ext}`;
    }

    const tmp = path.join(UPLOADS, 'tmp-' + crypto.randomUUID());
    const out = fs.createWriteStream(tmp, { flags: 'wx' });
    let size = 0;
    let failed = false;

    const cleanup = () => { out.destroy(); fs.promises.unlink(tmp).catch(() => { }); };
    const fail = (code, msg) => {
        if (failed) return;
        failed = true;
        cleanup();
        if (!res.headersSent) res.status(code).json({ error: msg });
    };

    req.on('data', (chunk) => {
        size += chunk.length;
        if (size > cap) {
            req.unpipe(out);
            fail(413, `Files can be at most ${config.MAX_UPLOAD_MB} MB`);
            req.resume(); // drain so the connection can close cleanly
        }
    });
    req.on('aborted', () => { failed = true; cleanup(); });
    req.on('error', () => { failed = true; cleanup(); });
    out.on('error', () => fail(500, 'Could not store the file'));

    out.on('finish', () => {
        if (failed) return;
        if (size === 0) return fail(400, 'Empty file');
        let message;
        try {
            message = DB.addMessage({
                convId, senderId: req.user.id, type: msgType,
                fileName, fileSize: size, mime, duration,
            });
            fs.renameSync(tmp, filePath(message.id));
        } catch (e) {
            if (message) DB.db.prepare('DELETE FROM messages WHERE id = ?').run(message.id);
            return fail(500, 'Could not store the file');
        }
        ws.broadcastToConv(convId, { t: 'msg:new', d: { message } });
        res.json({ message });
    });

    req.pipe(out);
});

/* ---------------- download / streaming ---------------- */

router.get('/files/:id', requireAuth, (req, res) => {
    const m = DB.stmts.messageById.get(Number(req.params.id));
    if (!m || m.deleted || m.file_size == null) return res.status(404).json({ error: 'File not found' });
    if (!DB.stmts.isMember.get(m.conversation_id, req.user.id)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const p = filePath(m.id);
    let st;
    try { st = fs.statSync(p); } catch { return res.status(404).json({ error: 'File not found' }); }
    const total = st.size;

    const inline = INLINE_MIMES.has(m.mime);
    const encName = encodeURIComponent(m.file_name || 'file');
    res.set('Accept-Ranges', 'bytes');
    res.set('Content-Type', inline ? m.mime : 'application/octet-stream');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encName}`);

    const mr = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (mr && (mr[1] !== '' || mr[2] !== '')) {
        let start, end;
        if (mr[1] === '') {              // suffix range: last N bytes
            const n = parseInt(mr[2], 10);
            start = Math.max(0, total - n);
            end = total - 1;
        } else {
            start = parseInt(mr[1], 10);
            end = mr[2] === '' ? total - 1 : Math.min(parseInt(mr[2], 10), total - 1);
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total || start > end) {
            res.set('Content-Range', `bytes */${total}`);
            return res.status(416).end();
        }
        res.status(206);
        res.set('Content-Range', `bytes ${start}-${end}/${total}`);
        res.set('Content-Length', String(end - start + 1));
        streamToResponse(p, { start, end }, res);
    } else {
        res.set('Content-Length', String(total));
        streamToResponse(p, {}, res);
    }
});

// Stream a file to the response with full error handling. A read error (e.g. the
// file is unlinked mid-download via a concurrent message delete — a TOCTOU race)
// must never become an unhandled 'error' that crashes the single-process server.
function streamToResponse(p, opts, res) {
    const rs = fs.createReadStream(p, opts);
    res.on('close', () => rs.destroy());
    pipeline(rs, res, (err) => {
        if (err && !res.headersSent) res.status(404).end();
    });
}

module.exports = { router, removeMessageFile, removeConversationFiles };
