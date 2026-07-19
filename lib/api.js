'use strict';
// REST API: auth, users, conversations, messages, admin, ICE config.

const crypto = require('node:crypto');
const express = require('express');
const pkg = require('../package.json');
const config = require('./config');
const DB = require('./db');
const ws = require('./ws');
const {
    hashPassword, verifyPassword, newToken, tokenHash, parseCookies, sessionCookie,
    rateLimit, validUsername, validDisplayName, validPassword, REACTIONS,
} = require('./util');

const COOKIE = 'cw_session';
const router = express.Router();

// Constant-work credential: verified against when a username does not exist so
// login latency does not reveal whether an account exists (timing oracle).
const DUMMY_CRED = hashPassword('connectwell-nonexistent-user-placeholder');

router.use(express.json({ limit: '64kb' }));

/* ---------------- auth plumbing ---------------- */

// Secure flag follows the actual transport: true behind the HTTPS proxy
// (req.secure via trust proxy + X-Forwarded-Proto), false for local http dev.
function setSession(req, res, token) {
    res.setHeader('Set-Cookie', sessionCookie(COOKIE, token, {
        basePath: config.BASE_PATH, secure: req.secure || config.PROD, maxAgeSec: config.SESSION_DAYS * 86400,
    }));
}

function clearSession(req, res) {
    res.setHeader('Set-Cookie', sessionCookie(COOKIE, '', {
        basePath: config.BASE_PATH, secure: req.secure || config.PROD, maxAgeSec: 0,
    }));
}

router.use((req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.user = token ? DB.userBySessionHash(tokenHash(token)) : null;
    req.sessionTokenHash = token ? tokenHash(token) : null;
    next();
});

// Light CSRF defence: state-changing requests must carry our custom header
// (cross-site forms cannot set it; SameSite=Lax already blocks most vectors).
router.use((req, res, next) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)
        && req.headers['x-requested-with'] !== 'ConnectWell') {
        return res.status(403).json({ error: 'Missing request header' });
    }
    next();
});

function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (req.user.status === 'pending') return res.status(403).json({ error: 'pending' });
    if (req.user.status !== 'active') { clearSession(req, res); return res.status(403).json({ error: 'Account disabled' }); }
    next();
}

function requireAdmin(req, res, next) {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
}

const ip = (req) => req.ip || 'unknown';

/* ---------------- health ---------------- */

router.get('/health', (req, res) => res.json({ ok: true, version: pkg.version, uptime: Math.round(process.uptime()) }));

/* ---------------- auth ---------------- */

router.post('/register', (req, res) => {
    if (!rateLimit('reg:' + ip(req), 5, 3600_000)) return res.status(429).json({ error: 'Too many attempts, try later' });
    const { username, displayName, password } = req.body || {};
    if (!validUsername(username)) return res.status(400).json({ error: 'Username: 3-20 letters, digits or _' });
    if (!validDisplayName(displayName)) return res.status(400).json({ error: 'Display name: 1-50 characters' });
    if (!validPassword(password)) return res.status(400).json({ error: 'Password: at least 8 characters' });
    if (DB.stmts.userByUsername.get(username)) return res.status(409).json({ error: 'Username already taken' });

    const { salt, hash } = hashPassword(password);
    const user = DB.createUser({ username, displayName: displayName.trim(), salt, hash });

    const token = newToken();
    DB.createSession(user.id, tokenHash(token));
    setSession(req, res, token);

    if (user.status === 'pending') ws.notifyAdmins({ t: 'user:pending', d: { user: DB.publicUser(user) } });
    res.json({ user: DB.publicUser(user) });
});

router.post('/login', (req, res) => {
    if (!rateLimit('login:' + ip(req), 20, 900_000)) return res.status(429).json({ error: 'Too many attempts, try later' });
    const { username, password } = req.body || {};
    const user = typeof username === 'string' ? DB.stmts.userByUsername.get(username) : null;
    // Always run one scrypt verification (dummy when the user is absent) so the
    // response time does not reveal whether the username exists.
    const salt = user ? user.pass_salt : DUMMY_CRED.salt;
    const expected = user ? user.pass_hash : DUMMY_CRED.hash;
    const passOk = verifyPassword(String(password || ''), salt, expected);
    if (!user || user.status === 'deleted' || !passOk) {
        return res.status(401).json({ error: 'Wrong username or password' });
    }
    if (user.status === 'blocked') return res.status(403).json({ error: 'Account blocked' });
    const token = newToken();
    DB.createSession(user.id, tokenHash(token));
    setSession(req, res, token);
    res.json({ user: DB.publicUser(user) });
});

router.post('/logout', (req, res) => {
    if (req.sessionTokenHash) {
        DB.stmts.deleteSession.run(req.sessionTokenHash);
        // Tear down any live WebSocket(s) bound to this session so the realtime
        // channel is revoked too (other tabs of this browser share the cookie).
        ws.closeSessionSockets(req.sessionTokenHash);
    }
    clearSession(req, res);
    res.json({ ok: true });
});

router.get('/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (req.user.status === 'blocked' || req.user.status === 'deleted') {
        clearSession(req, res);
        return res.status(403).json({ error: 'Account disabled' });
    }
    res.json({ user: DB.publicUser(req.user) });
});

/* ---------------- profile ---------------- */

router.patch('/me', requireAuth, (req, res) => {
    const { displayName } = req.body || {};
    if (!validDisplayName(displayName)) return res.status(400).json({ error: 'Display name: 1-50 characters' });
    DB.stmts.setDisplayName.run(displayName.trim(), req.user.id);
    const user = DB.publicUser(DB.stmts.userById.get(req.user.id));
    // Every client renders this person's name in lists and headers, so tell them all.
    ws.broadcastToAll({ t: 'user:updated', d: { user } });
    res.json({ user });
});

router.post('/me/password', requireAuth, (req, res) => {
    if (!rateLimit('pw:' + req.user.id, 5, 900_000)) {
        return res.status(429).json({ error: 'Too many attempts, try later' });
    }
    const { currentPassword, newPassword } = req.body || {};
    // Prove ownership of the account before rotating the credential.
    if (!verifyPassword(String(currentPassword || ''), req.user.pass_salt, req.user.pass_hash)) {
        return res.status(403).json({ error: 'Current password is incorrect' });
    }
    if (!validPassword(newPassword)) return res.status(400).json({ error: 'Password: at least 8 characters' });

    const { salt, hash } = hashPassword(newPassword);
    DB.stmts.setPassword.run(salt, hash, req.user.id);

    // A rotated password must not leave older sessions usable. Every other
    // session is dropped; this one is kept so the caller is not signed out by
    // their own change (re-issuing a cookie here would race the WS reconnect).
    DB.stmts.deleteOtherUserSessions.run(req.user.id, req.sessionTokenHash);
    res.json({ ok: true });
});

/* ---------------- bootstrap / users ---------------- */

router.get('/bootstrap', requireAuth, (req, res) => {
    const users = DB.stmts.activeUsers.all().map(DB.publicUser);
    res.json({
        me: DB.publicUser(req.user),
        users,
        conversations: DB.listConversations(req.user.id),
        online: ws.onlineUserIds(),
        calls: ws.activeCallsSummary(req.user.id),
    });
});

router.get('/users', requireAuth, (req, res) => {
    res.json({ users: DB.stmts.activeUsers.all().map(DB.publicUser) });
});

/* ---------------- conversations ---------------- */

function memberGuard(req, res) {
    const convId = Number(req.params.id);
    const conv = DB.stmts.convById.get(convId);
    if (!conv || !DB.stmts.isMember.get(convId, req.user.id)) {
        res.status(404).json({ error: 'Conversation not found' });
        return null;
    }
    return conv;
}

router.post('/conversations', requireAuth, (req, res) => {
    const b = req.body || {};
    if (b.type === 'direct') {
        const other = DB.stmts.userById.get(Number(b.userId));
        if (!other || other.status !== 'active') return res.status(400).json({ error: 'User not available' });
        if (other.id === req.user.id) return res.status(400).json({ error: 'That is you' });
        const existing = DB.stmts.convByDirectKey.get(
            `${Math.min(req.user.id, other.id)}:${Math.max(req.user.id, other.id)}`);
        const conv = DB.getOrCreateDirect(req.user.id, other.id);
        const json = DB.convJson(conv, req.user.id);
        if (!existing) ws.sendToUser(other.id, { t: 'conv:new', d: { conversation: DB.convJson(conv, other.id) } });
        return res.json({ conversation: json });
    }
    if (b.type === 'group') {
        const name = String(b.name || '').trim();
        if (name.length < 1 || name.length > 50) return res.status(400).json({ error: 'Group name: 1-50 characters' });
        const ids = [...new Set((Array.isArray(b.memberIds) ? b.memberIds : []).map(Number))]
            .filter(id => id !== req.user.id);
        if (ids.length < 1) return res.status(400).json({ error: 'Pick at least one member' });
        for (const id of ids) {
            const u = DB.stmts.userById.get(id);
            if (!u || u.status !== 'active') return res.status(400).json({ error: 'A selected user is not available' });
        }
        const conv = DB.createGroup(name, req.user.id, ids);
        DB.addMessage({
            convId: conv.id, senderId: req.user.id, type: 'system',
            // content stays English for older clients and pre-existing rows;
            // sysKey/sysArgs let each viewer render it in their own language.
            content: `${req.user.display_name} created the group`,
            sysKey: 'sys.group_created', sysArgs: { name: req.user.display_name },
        });
        for (const uid of [req.user.id, ...ids]) {
            ws.sendToUser(uid, { t: 'conv:new', d: { conversation: DB.convJson(conv, uid) } });
        }
        return res.json({ conversation: DB.convJson(conv, req.user.id) });
    }
    res.status(400).json({ error: 'Unknown conversation type' });
});

router.get('/conversations/:id/messages', requireAuth, (req, res) => {
    const conv = memberGuard(req, res); if (!conv) return;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const after = Math.max(0, Number(req.query.after) || 0);
    if (after > 0) return res.json({ messages: DB.messagesAfter(conv.id, after, limit) });
    const before = Math.max(0, Number(req.query.before) || 0);
    res.json({ messages: DB.messagesBefore(conv.id, before, limit) });
});

router.post('/conversations/:id/messages', requireAuth, (req, res) => {
    const conv = memberGuard(req, res); if (!conv) return;
    if (!rateLimit('msg:' + req.user.id, 30, 10_000)) return res.status(429).json({ error: 'Slow down a little' });
    const content = String(req.body?.content || '').trim();
    if (!content || content.length > 4000) return res.status(400).json({ error: 'Message must be 1-4000 characters' });
    const message = DB.addMessage({ convId: conv.id, senderId: req.user.id, type: 'text', content });
    ws.broadcastToConv(conv.id, { t: 'msg:new', d: { message } });
    res.json({ message });
});

router.post('/conversations/:id/read', requireAuth, (req, res) => {
    const conv = memberGuard(req, res); if (!conv) return;
    const msgId = Number(req.body?.messageId) || 0;
    DB.stmts.setLastRead.run(msgId, conv.id, req.user.id);
    res.json({ ok: true });
});

router.post('/conversations/:id/members', requireAuth, (req, res) => {
    const conv = memberGuard(req, res); if (!conv) return;
    if (conv.type !== 'group') return res.status(400).json({ error: 'Direct chats cannot have extra members' });
    const u = DB.stmts.userById.get(Number(req.body?.userId));
    if (!u || u.status !== 'active') return res.status(400).json({ error: 'User not available' });
    if (DB.stmts.isMember.get(conv.id, u.id)) return res.status(409).json({ error: 'Already a member' });
    DB.stmts.addParticipant.run(conv.id, u.id, Date.now());
    const message = DB.addMessage({
        convId: conv.id, senderId: req.user.id, type: 'system',
        content: `${req.user.display_name} added ${u.display_name}`,
        sysKey: 'sys.member_added',
        sysArgs: { actor: req.user.display_name, target: u.display_name },
    });
    ws.sendToUser(u.id, { t: 'conv:new', d: { conversation: DB.convJson(conv, u.id) } });
    ws.broadcastToConv(conv.id, { t: 'conv:updated', d: { conversation: DB.convJson(conv, null) } });
    ws.broadcastToConv(conv.id, { t: 'msg:new', d: { message } });
    res.json({ ok: true });
});

router.delete('/conversations/:id/members/:userId', requireAuth, (req, res) => {
    const conv = memberGuard(req, res); if (!conv) return;
    if (conv.type !== 'group') return res.status(400).json({ error: 'Not a group' });
    const targetId = Number(req.params.userId);
    const isSelf = targetId === req.user.id;
    const mayManage = conv.created_by === req.user.id || req.user.role === 'admin';
    if (!isSelf && !mayManage) return res.status(403).json({ error: 'Only the group creator can remove members' });
    if (!DB.stmts.isMember.get(conv.id, targetId)) return res.status(404).json({ error: 'Not a member' });

    DB.stmts.removeParticipant.run(conv.id, targetId);
    // Eject the removed user from any in-progress call for this conversation.
    ws.evictUserFromConvCall(conv.id, targetId);
    const target = DB.stmts.userById.get(targetId);
    const remaining = DB.stmts.convMembers.all(conv.id);
    if (remaining.length === 0) {
        // Last member left: end any live call, then remove conversation + files.
        ws.endCallForConv(conv.id);
        const files = require('./files');
        files.removeConversationFiles(conv.id);
        // removeConversationFiles only walks messages, so the group photo needs
        // removing explicitly. Once the row is gone no membership check can ever
        // pass again, so it would otherwise sit on disk forever, unreachable.
        files.removeAvatar('c', conv.id, conv.avatar);
        DB.stmts.deleteConv.run(conv.id);
    } else {
        const message = DB.addMessage({
            convId: conv.id, senderId: req.user.id, type: 'system',
            content: isSelf ? `${req.user.display_name} left`
                : `${req.user.display_name} removed ${target?.display_name || 'a member'}`,
            // A distinct key when the target is unknown, so no dictionary has to
            // interpolate a placeholder word into a sentence.
            sysKey: isSelf ? 'sys.member_left'
                : (target?.display_name ? 'sys.member_removed' : 'sys.member_removed_unknown'),
            sysArgs: isSelf
                ? { name: req.user.display_name }
                : { actor: req.user.display_name, target: target?.display_name || undefined },
        });
        ws.broadcastToConv(conv.id, { t: 'conv:updated', d: { conversation: DB.convJson(conv, null) } });
        ws.broadcastToConv(conv.id, { t: 'msg:new', d: { message } });
    }
    ws.sendToUser(targetId, { t: 'conv:removed', d: { convId: conv.id } });
    res.json({ ok: true });
});

router.patch('/conversations/:id', requireAuth, (req, res) => {
    const conv = memberGuard(req, res); if (!conv) return;
    if (conv.type !== 'group') return res.status(400).json({ error: 'Not a group' });
    if (conv.created_by !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only the group creator can rename' });
    }
    const name = String(req.body?.name || '').trim();
    if (name.length < 1 || name.length > 50) return res.status(400).json({ error: 'Group name: 1-50 characters' });
    DB.stmts.renameConv.run(name, conv.id);
    const updated = DB.stmts.convById.get(conv.id);
    ws.broadcastToConv(conv.id, { t: 'conv:updated', d: { conversation: DB.convJson(updated, null) } });
    res.json({ ok: true });
});

/* ---------------- messages ---------------- */

router.delete('/messages/:id', requireAuth, (req, res) => {
    const m = DB.stmts.messageById.get(Number(req.params.id));
    if (!m || m.deleted) return res.status(404).json({ error: 'Message not found' });
    if (m.sender_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'You can only delete your own messages' });
    }
    const files = require('./files');
    files.removeMessageFile(m.id);
    DB.stmts.softDeleteMessage.run(m.id);
    ws.broadcastToConv(m.conversation_id, { t: 'msg:deleted', d: { convId: m.conversation_id, messageId: m.id } });
    res.json({ ok: true });
});

// Toggle one reaction on a message. The server decides add vs remove from the
// current state, so a double-tap or a concurrent request can never desync.
router.post('/messages/:id/react', requireAuth, (req, res) => {
    if (!rateLimit('react:' + req.user.id, 60, 60_000)) return res.status(429).json({ error: 'Slow down a little' });
    const emoji = String(req.body?.emoji || '');
    if (!REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Unknown reaction' });
    const m = DB.stmts.messageById.get(Number(req.params.id));
    // 404 rather than 403 for a non-member, so it does not reveal the message exists.
    if (!m || m.deleted || m.type === 'system' || !DB.stmts.isMember.get(m.conversation_id, req.user.id)) {
        return res.status(404).json({ error: 'Message not found' });
    }
    // Reacting is for the audience: in a direct chat only the other side, in a
    // group everyone but the sender.
    if (m.sender_id === req.user.id) {
        return res.status(403).json({ error: 'You cannot react to your own message' });
    }
    if (DB.stmts.hasReaction.get(m.id, req.user.id, emoji)) {
        DB.stmts.removeReaction.run(m.id, req.user.id, emoji);
    } else {
        DB.stmts.addReaction.run(m.id, req.user.id, emoji, Date.now());
    }
    const reactions = DB.reactionsFor(m.id);
    ws.broadcastToConv(m.conversation_id, {
        t: 'msg:reaction', d: { convId: m.conversation_id, messageId: m.id, reactions },
    });
    res.json({ reactions });
});

// Forward a message into another conversation the caller belongs to. The copy is
// tagged with the ORIGINAL owner's username — unique, unlike display names — and
// the tag survives chained forwards. Forwarding your own message carries no tag.
router.post('/messages/:id/forward', requireAuth, async (req, res) => {
    if (!rateLimit('fwd:' + req.user.id, 20, 60_000)) return res.status(429).json({ error: 'Slow down a little' });
    const m = DB.stmts.messageById.get(Number(req.params.id));
    // 404 for a non-member of the SOURCE, so it does not reveal the message exists.
    if (!m || m.deleted || m.type === 'system' || !DB.stmts.isMember.get(m.conversation_id, req.user.id)) {
        return res.status(404).json({ error: 'Message not found' });
    }
    if (m.purged_at != null) return res.status(400).json({ error: 'That file is no longer available' });

    const target = DB.stmts.convById.get(Number(req.body?.convId));
    if (!target || !DB.stmts.isMember.get(target.id, req.user.id)) {
        return res.status(404).json({ error: 'Conversation not found' });
    }

    // Forwarding a file duplicates its bytes, and that duplication is triggered by
    // a tiny request — so bound each user's total live-file footprint here, or one
    // user could amplify a single file into unbounded disk use.
    if (m.file_size != null) {
        const cap = config.PER_USER_FILE_MB * 1024 * 1024;
        if (DB.stmts.userLiveFileBytes.get(req.user.id).n + m.file_size > cap) {
            return res.status(413).json({ error: 'Your shared-files storage is full' });
        }
    }

    // The owner tag rides along verbatim on re-forwards; it only disappears when
    // the forwarder IS the original owner.
    const origin = m.fwd_from || DB.stmts.userById.get(m.sender_id)?.username || null;
    const fwdFrom = origin === req.user.username ? null : origin;

    const message = DB.addMessage({
        convId: target.id, senderId: req.user.id, type: m.type,
        content: m.content, fileName: m.file_name, fileSize: m.file_size,
        mime: m.mime, duration: m.duration, fwdFrom,
    });
    if (m.file_size != null) {
        const files = require('./files');
        if (!(await files.copyMessageFile(m.id, message.id))) {
            // Bytes gone or copy failed: drop the row and any partial destination
            // so neither a broken message nor an orphan file is left behind.
            DB.db.prepare('DELETE FROM messages WHERE id = ?').run(message.id);
            files.removeMessageFile(message.id);
            return res.status(404).json({ error: 'That file is no longer available' });
        }
    }
    ws.broadcastToConv(target.id, { t: 'msg:new', d: { message } });
    res.json({ message });
});

/* ---------------- ICE servers (STUN + optional TURN) ---------------- */

router.get('/ice', requireAuth, (req, res) => {
    const iceServers = [{ urls: config.STUN_URLS }];
    if (config.TURN_HOST && config.TURN_SECRET) {
        const expiry = Math.floor(Date.now() / 1000) + config.TURN_TTL;
        const username = `${expiry}:${req.user.id}`;
        const credential = crypto.createHmac('sha1', config.TURN_SECRET).update(username).digest('base64');
        iceServers.push({
            urls: [
                `turn:${config.TURN_HOST}:3478?transport=udp`,
                `turn:${config.TURN_HOST}:3478?transport=tcp`,
            ],
            username, credential,
        });
    }
    res.json({ iceServers });
});

/* ---------------- admin ---------------- */

router.get('/admin/users', requireAuth, requireAdmin, (req, res) => {
    res.json({ users: DB.stmts.allUsers.all().map(DB.publicUser) });
});

router.post('/admin/users/:id/approve', requireAuth, requireAdmin, (req, res) => {
    const u = DB.stmts.userById.get(Number(req.params.id));
    if (!u || u.status !== 'pending') return res.status(400).json({ error: 'User is not pending' });
    DB.stmts.setUserStatus.run('active', u.id);
    ws.broadcastToAll({ t: 'user:updated', d: { user: DB.publicUser(DB.stmts.userById.get(u.id)) } });
    res.json({ ok: true });
});

router.post('/admin/users/:id/block', requireAuth, requireAdmin, (req, res) => {
    const u = DB.stmts.userById.get(Number(req.params.id));
    if (!u || u.role === 'admin') return res.status(400).json({ error: 'Cannot block this user' });
    DB.stmts.setUserStatus.run('blocked', u.id);
    DB.stmts.deleteUserSessions.run(u.id);
    ws.kickUser(u.id);
    ws.broadcastToAll({ t: 'user:updated', d: { user: DB.publicUser(DB.stmts.userById.get(u.id)) } });
    res.json({ ok: true });
});

router.post('/admin/users/:id/unblock', requireAuth, requireAdmin, (req, res) => {
    const u = DB.stmts.userById.get(Number(req.params.id));
    if (!u || u.status !== 'blocked') return res.status(400).json({ error: 'User is not blocked' });
    DB.stmts.setUserStatus.run('active', u.id);
    ws.broadcastToAll({ t: 'user:updated', d: { user: DB.publicUser(DB.stmts.userById.get(u.id)) } });
    res.json({ ok: true });
});

router.delete('/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
    const u = DB.stmts.userById.get(Number(req.params.id));
    if (!u || u.role === 'admin') return res.status(400).json({ error: 'Cannot delete this user' });
    DB.stmts.setUserStatus.run('deleted', u.id);
    // Deletion is soft, so the row survives: without clearing the token the photo
    // would keep being broadcast in user:updated long after the account is gone.
    require('./files').removeAvatar('u', u.id, u.avatar);
    DB.stmts.setUserAvatar.run(null, u.id);
    DB.stmts.deleteUserSessions.run(u.id);
    ws.kickUser(u.id);
    ws.broadcastToAll({ t: 'user:updated', d: { user: DB.publicUser(DB.stmts.userById.get(u.id)) } });
    res.json({ ok: true });
});

/* ---------------- storage (admin) ---------------- */

// Lets the owner see exactly what a sweep would remove, against real data,
// before deletion is ever switched on.
router.get('/admin/storage', requireAuth, requireAdmin, (req, res) => {
    res.json(require('./storage').status());
});

router.post('/admin/storage/sweep', requireAuth, requireAdmin, async (req, res) => {
    try {
        const report = await require('./storage').sweep({ trigger: 'admin' });
        if (report.skipped) return res.status(409).json({ error: report.skipped });
        res.json(report);
    } catch (err) {
        console.error('storage sweep failed:', err);
        res.status(500).json({ error: 'Sweep failed' });
    }
});

/* ---------------- file routes + API 404 ---------------- */

router.use(require('./files').router);
router.use((req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = router;
