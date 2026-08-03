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
const {
    rateLimit, classifyMime, INLINE_MIMES, sanitizeFilename, sniffImage, MAX_CAPTION_LEN,
} = require('./util');

const UPLOADS = path.join(config.DATA_DIR, 'uploads');
const router = express.Router();

const filePath = (msgId) => path.join(UPLOADS, String(msgId));

/* ---------------- avatar storage ----------------
   Avatars live in their own directory, never in uploads/, so a retention sweep
   over chat files can never delete somebody's profile photo.

   The token is part of the FILENAME, not just the database row. That makes every
   write a create-new rather than a rename over a file another request may have
   open, and it makes the URL genuinely immutable so it can be cached hard. */
const AVATARS = path.join(config.DATA_DIR, 'avatars');
const AVATAR_MAX_BYTES = 512 * 1024;
const AVATAR_MAX_DIM = 2048;

// Express 5 percent-decodes route params, so "%2e%2e%2f" reaches us as a real
// "../" inside a single segment. The whole key is matched here and the filename
// is rebuilt from the parsed integer -- the raw string never touches a path.
// (Number() is not a validator: Number('0x0c') === 12, Number('1e3') === 1000.)
const AVATAR_KEY_RE = /^([uc])(\d{1,10})$/;
const AVATAR_TOKEN_RE = /^[a-f0-9]{16}$/;
const avatarPath = (kind, id, token) => path.join(AVATARS, `${kind}${id}-${token}`);

function removeAvatar(kind, id, token) {
    // Defence in depth: callers pass ids from the database, but this builds a path.
    if (!token || !AVATAR_TOKEN_RE.test(token) || !Number.isInteger(id)) return;
    fs.promises.unlink(avatarPath(kind, id, token)).catch(() => { });
}

// Forwarding a file message duplicates the bytes under the new message id, so
// each copy lives and is retained (or purged) independently. Async: the copy can
// be up to MAX_UPLOAD_MB, and this process also serves every call and message —
// a sync copy would freeze the whole event loop for the copy's duration.
// COPYFILE_EXCL: the destination id was just minted, so it must not exist.
async function copyMessageFile(srcId, dstId) {
    try {
        await fs.promises.copyFile(filePath(srcId), filePath(dstId), fs.constants.COPYFILE_EXCL);
        return true;
    } catch {
        // A mid-copy failure can leave a partial destination (notably on win32,
        // where the platform does not remove it). Its name is all-digits, so it
        // would never be swept as tmp- garbage and — once its row is gone — never
        // by retention either. Clear it so it cannot become an unreapable orphan.
        await fs.promises.unlink(filePath(dstId)).catch(() => { });
        return false;
    }
}

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
for (const f of fs.readdirSync(AVATARS)) {
    if (f.startsWith('tmp-')) fs.promises.unlink(path.join(AVATARS, f)).catch(() => { });
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

    // A caption is prose, so it must NOT go through sanitizeFilename — that
    // strips everything before the last slash and drops ? : " < > | *, turning
    // "see the chart at 3/4 scale" into "4 scale". Only C0 controls are removed,
    // and newlines survive because the bubble renders pre-wrap. Over-long text is
    // truncated rather than rejected: by the time this runs the whole file has
    // already crossed the wire, and throwing it away over a caption would be
    // gratuitous.
    let caption = '';
    try {
        caption = decodeURIComponent(String(req.headers['x-caption'] || ''))
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
            .trim()
            .slice(0, MAX_CAPTION_LEN);
    } catch { caption = ''; }   // malformed percent-escape: no caption beats garbage

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
                content: caption || null,     // the file's caption
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
    // Note this returns before any Cache-Control is set below: a purged file must
    // not answer with a year-long cacheable 404. Range requests take this path
    // too, since it precedes the Range parser.
    if (!m || m.deleted || m.purged_at != null || m.file_size == null) {
        return res.status(404).json({ error: 'File not found' });
    }
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

/* ---------------- avatars ---------------- */

// Read the head of a file for sniffing. 64 KB comfortably covers a JPEG's EXIF
// block before the start-of-frame marker.
function readHead(p, size) {
    let fd;
    try {
        fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(Math.min(size, 65536));
        fs.readSync(fd, buf, 0, buf.length, 0);
        return buf;
    } catch { return null; } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
    }
}

// Stream raw image bytes to data/avatars/, validate them, and hand the caller a
// fresh token. The Content-Length pre-check is advisory only -- it is absent
// under Transfer-Encoding: chunked -- so the running counter is the real cap.
function receiveAvatar(req, res, kind, id, done) {
    const tooBig = `Image must be at most ${Math.round(AVATAR_MAX_BYTES / 1024)} KB`;
    if (Number(req.headers['content-length'] || 0) > AVATAR_MAX_BYTES) {
        return res.status(413).json({ error: tooBig });
    }

    // Staged inside data/avatars/ so the rename below cannot cross a filesystem
    // boundary and lose its atomicity.
    const tmp = path.join(AVATARS, 'tmp-' + crypto.randomUUID());
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
        if (size > AVATAR_MAX_BYTES) {
            req.unpipe(out);
            fail(413, tooBig);
            req.resume();                       // drain so the socket closes cleanly
        }
    });
    req.on('aborted', () => { failed = true; cleanup(); });
    req.on('error', () => { failed = true; cleanup(); });
    out.on('error', () => fail(500, 'Could not store the image'));

    out.on('finish', () => {
        if (failed) return;
        if (size === 0) return fail(400, 'Empty file');

        const head = readHead(tmp, size);
        if (!head) return fail(500, 'Could not read the image');

        // Trust the bytes, never the declared Content-Type: the client-side resize
        // is a convenience an attacker simply skips.
        const img = sniffImage(head);
        if (!img) return fail(415, 'Only PNG, JPEG or WebP images are accepted');
        if (img.width > AVATAR_MAX_DIM || img.height > AVATAR_MAX_DIM) {
            return fail(413, `Image must be at most ${AVATAR_MAX_DIM}x${AVATAR_MAX_DIM} pixels`);
        }

        const token = crypto.randomBytes(8).toString('hex');
        try { fs.renameSync(tmp, avatarPath(kind, id, token)); }
        catch { return fail(500, 'Could not store the image'); }
        done(token);
    });

    req.pipe(out);
}

router.get('/avatars/:key/:token', requireAuth, (req, res) => {
    // Every miss returns before any Cache-Control is set: a year-cached 404 would
    // mean an avatar never appears after the upload that would have fixed it.
    const miss = () => {
        res.set('Cache-Control', 'no-store');
        return res.status(404).json({ error: 'Not found' });
    };

    const key = AVATAR_KEY_RE.exec(req.params.key);
    if (!key || !AVATAR_TOKEN_RE.test(req.params.token)) return miss();
    const kind = key[1];
    const id = Number(key[2]);
    const token = req.params.token;

    if (kind === 'c') {
        // Conversation ids are sequential, so without a membership check any signed-in
        // user could walk c1..cN and pull every private group's photo. 404 rather than
        // 403 so the response does not confirm the group exists.
        const conv = DB.stmts.convById.get(id);
        if (!conv || conv.type !== 'group' || conv.avatar !== token) return miss();
        if (!DB.stmts.isMember.get(id, req.user.id)) return miss();
    } else {
        // Any signed-in user may see any active user's photo -- GET /users already
        // discloses the whole active roster. Blocked and deleted accounts do not.
        const u = DB.stmts.userById.get(id);
        if (!u || u.avatar !== token || u.status !== 'active') return miss();
    }

    const p = avatarPath(kind, id, token);
    let st;
    try { st = fs.statSync(p); } catch { return miss(); }

    // Re-sniff on the way out so a hand-placed or corrupted file can never dictate
    // the Content-Type we serve from our own origin.
    const img = sniffImage(readHead(p, st.size));
    if (!img) return miss();

    res.set('Content-Type', img.mime);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', 'inline; filename="avatar"');
    res.set('Content-Length', String(st.size));
    // The token is in the URL, so these bytes are immutable. private, never public:
    // this is personal data and must not land in a shared cache.
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    streamToResponse(p, {}, res);
});

// The target is always the caller. No avatar route accepts a user id for setting
// a photo, so there is no path on which one account can write another's.
router.post('/me/avatar', requireAuth, (req, res) => {
    if (!rateLimit('av:' + req.user.id, 5, 60_000)) {
        return res.status(429).json({ error: 'Too many uploads, wait a moment' });
    }
    receiveAvatar(req, res, 'u', req.user.id, (token) => {
        const prev = DB.stmts.userById.get(req.user.id).avatar;
        DB.stmts.setUserAvatar.run(token, req.user.id);
        removeAvatar('u', req.user.id, prev);
        const user = DB.publicUser(DB.stmts.userById.get(req.user.id));
        ws.broadcastToAll({ t: 'user:updated', d: { user } });
        res.json({ user });
    });
});

router.delete('/me/avatar', requireAuth, (req, res) => {
    const prev = DB.stmts.userById.get(req.user.id).avatar;
    DB.stmts.setUserAvatar.run(null, req.user.id);
    removeAvatar('u', req.user.id, prev);
    const user = DB.publicUser(DB.stmts.userById.get(req.user.id));
    ws.broadcastToAll({ t: 'user:updated', d: { user } });
    res.json({ user });
});

// A group photo is a group-identity change of the same kind as the name, so it
// follows the same rule as renaming: creator or admin.
function groupPhotoGuard(req, res) {
    const convId = Number(req.params.id);
    const conv = DB.stmts.convById.get(convId);
    if (!conv || !DB.stmts.isMember.get(convId, req.user.id)) {
        res.status(404).json({ error: 'Conversation not found' });
        return null;
    }
    if (conv.type !== 'group') {
        // created_by on a direct chat is just whoever opened it, so the creator rule
        // is meaningless there and the effect would be an unsolicited image in
        // someone else's chat list.
        res.status(400).json({ error: 'Only groups have a photo' });
        return null;
    }
    if (conv.created_by !== req.user.id && req.user.role !== 'admin') {
        res.status(403).json({ error: 'Only the group creator can change the photo' });
        return null;
    }
    return conv;
}

function announceConv(convId, res, forUserId) {
    // Refetch: the guard's row predates the update, so serializing it would
    // broadcast the OLD token to every other member.
    const updated = DB.stmts.convById.get(convId);
    ws.broadcastToConv(convId, { t: 'conv:updated', d: { conversation: DB.convJson(updated, null) } });
    res.json({ conversation: DB.convJson(updated, forUserId) });
}

router.post('/conversations/:id/avatar', requireAuth, (req, res) => {
    const conv = groupPhotoGuard(req, res);
    if (!conv) return;
    if (!rateLimit('av:' + req.user.id, 5, 60_000)) {
        return res.status(429).json({ error: 'Too many uploads, wait a moment' });
    }
    receiveAvatar(req, res, 'c', conv.id, (token) => {
        DB.stmts.setConvAvatar.run(token, conv.id);
        removeAvatar('c', conv.id, conv.avatar);
        announceConv(conv.id, res, req.user.id);
    });
});

router.delete('/conversations/:id/avatar', requireAuth, (req, res) => {
    const conv = groupPhotoGuard(req, res);
    if (!conv) return;
    DB.stmts.setConvAvatar.run(null, conv.id);
    removeAvatar('c', conv.id, conv.avatar);
    announceConv(conv.id, res, req.user.id);
});

// Moderation: an admin may CLEAR a photo but never set one. Kept separate from
// the /me routes precisely so those never learn to accept a target id.
router.delete('/admin/users/:id/avatar', requireAuth, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Bad user id' });
    const u = DB.stmts.userById.get(id);
    if (!u) return res.status(404).json({ error: 'User not found' });
    DB.stmts.setUserAvatar.run(null, id);
    removeAvatar('u', id, u.avatar);
    const user = DB.publicUser(DB.stmts.userById.get(id));
    ws.broadcastToAll({ t: 'user:updated', d: { user } });
    res.json({ user });
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

module.exports = { router, removeMessageFile, removeConversationFiles, removeAvatar, copyMessageFile };
