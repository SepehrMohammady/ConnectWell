'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(config.DATA_DIR, 'uploads'), { recursive: true });
// Avatars live outside uploads/ so a retention sweep over chat files can never
// reach them. Created here because db.js is required before files.js, which
// reads this directory at module load.
fs.mkdirSync(path.join(config.DATA_DIR, 'avatars'), { recursive: true });

const db = new DatabaseSync(path.join(config.DATA_DIR, 'connectwell.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    pass_salt     TEXT NOT NULL,
    pass_hash     TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'member',   -- admin | member
    status        TEXT NOT NULL DEFAULT 'pending',  -- pending | active | blocked | deleted
    created_at    INTEGER NOT NULL,
    avatar        TEXT                              -- token; file at data/avatars/u<id>-<token>
);

CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,                       -- direct | group
    name       TEXT,
    direct_key TEXT UNIQUE,                         -- "minUserId:maxUserId" for direct
    created_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    avatar     TEXT                                 -- groups only; data/avatars/c<id>-<token>
);

CREATE TABLE IF NOT EXISTS participants (
    conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_msg_id INTEGER NOT NULL DEFAULT 0,
    joined_at        INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       INTEGER NOT NULL,
    type            TEXT NOT NULL,                  -- text|image|video|audio|voice|videomsg|document|system
    content         TEXT,
    file_name       TEXT,
    file_size       INTEGER,
    mime            TEXT,
    duration        REAL,
    deleted         INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_participants_user ON participants(user_id);

CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(message_id);
`);

/* ---------------- schema migrations ----------------
   CREATE TABLE IF NOT EXISTS above is a no-op against a database that already
   exists, so a column declared there alone would never reach an installed
   deployment. New columns are therefore declared twice: in the CREATE TABLE
   (for fresh installs) and as a guarded ALTER here (for existing ones).

   The position matters in both directions. This must run AFTER the exec above,
   or on a fresh install the tables do not exist yet and the ALTER throws; and
   BEFORE any db.prepare() below, because prepare resolves column names eagerly
   and would throw "no such column" while this module is still being required,
   killing the process before the server ever listens. */
function addColumn(table, column, decl) {
    const present = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (present) return;
    try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    } catch (err) {
        // Harmless if two processes raced us to it; anything else is real.
        if (!/duplicate column name/i.test(err.message)) throw err;
    }
}
addColumn('users', 'avatar', 'TEXT');
addColumn('conversations', 'avatar', 'TEXT');
// When the shared file was removed to reclaim storage. Distinct from `deleted`:
// the message stays, and its name/size survive so the placeholder can say what
// used to be there.
addColumn('messages', 'purged_at', 'INTEGER');
// System events ("X created the group") are STORED text, so they cannot be
// retranslated after the fact. New rows additionally record what happened as a
// key plus arguments, letting each viewer render them in their own language.
// `content` still receives the same English sentence: rows written before this
// existed have only that, and a client that has not reloaded reads only that.
addColumn('messages', 'sys_key', 'TEXT');
addColumn('messages', 'sys_args', 'TEXT');
// Original owner of a forwarded message, stored as the USERNAME (unique and
// stable in this app), not the display name. NULL when the forwarder forwarded
// their own message — the owner asked for no tag in that case.
addColumn('messages', 'fwd_from', 'TEXT');

const now = () => Date.now();

/* ---------------- users ---------------- */

const stmts = {
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    insertUser: db.prepare(
        'INSERT INTO users (username, display_name, pass_salt, pass_hash, role, status, created_at) VALUES (?,?,?,?,?,?,?)'),
    allUsers: db.prepare('SELECT * FROM users ORDER BY id'),
    activeUsers: db.prepare("SELECT * FROM users WHERE status = 'active' ORDER BY display_name COLLATE NOCASE"),
    setUserStatus: db.prepare('UPDATE users SET status = ? WHERE id = ?'),
    setDisplayName: db.prepare('UPDATE users SET display_name = ? WHERE id = ?'),
    setPassword: db.prepare('UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?'),
    setUserAvatar: db.prepare('UPDATE users SET avatar = ? WHERE id = ?'),

    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)'),
    sessionByHash: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    deleteOtherUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),

    insertConv: db.prepare('INSERT INTO conversations (type, name, direct_key, created_by, created_at) VALUES (?,?,?,?,?)'),
    convById: db.prepare('SELECT * FROM conversations WHERE id = ?'),
    convByDirectKey: db.prepare('SELECT * FROM conversations WHERE direct_key = ?'),
    renameConv: db.prepare('UPDATE conversations SET name = ? WHERE id = ?'),
    setConvAvatar: db.prepare('UPDATE conversations SET avatar = ? WHERE id = ?'),
    deleteConv: db.prepare('DELETE FROM conversations WHERE id = ?'),
    userConvs: db.prepare(
        'SELECT c.* FROM conversations c JOIN participants p ON p.conversation_id = c.id WHERE p.user_id = ? '),

    addParticipant: db.prepare('INSERT OR IGNORE INTO participants (conversation_id, user_id, joined_at) VALUES (?,?,?)'),
    removeParticipant: db.prepare('DELETE FROM participants WHERE conversation_id = ? AND user_id = ?'),
    convMembers: db.prepare('SELECT user_id FROM participants WHERE conversation_id = ? ORDER BY joined_at'),
    isMember: db.prepare('SELECT 1 FROM participants WHERE conversation_id = ? AND user_id = ?'),
    memberRow: db.prepare('SELECT * FROM participants WHERE conversation_id = ? AND user_id = ?'),
    setLastRead: db.prepare(
        'UPDATE participants SET last_read_msg_id = MAX(last_read_msg_id, ?) WHERE conversation_id = ? AND user_id = ?'),

    insertMessage: db.prepare(
        'INSERT INTO messages (conversation_id, sender_id, type, content, file_name, file_size, mime, duration, created_at, sys_key, sys_args, fwd_from) '
        + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'),
    messageById: db.prepare('SELECT * FROM messages WHERE id = ?'),

    hasReaction: db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'),
    addReaction: db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)'),
    removeReaction: db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'),
    reactionsByMessage: db.prepare('SELECT emoji, user_id FROM reactions WHERE message_id = ? ORDER BY created_at, user_id'),
    lastMessage: db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1'),
    unreadCount: db.prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND id > ? AND sender_id != ? AND deleted = 0 AND type != 'system'"),
    softDeleteMessage: db.prepare(
        "UPDATE messages SET deleted = 1, content = NULL, file_name = NULL, file_size = NULL, mime = NULL, duration = NULL WHERE id = ?"),

    /* ---- retention ----
       markPurged touches nothing but the flag: reusing softDeleteMessage would
       null the very metadata the placeholder needs and would tell the user their
       peer retracted the file. The guard clauses make it idempotent and stop it
       racing a real delete.

       purgeCandidates serves BOTH retention rules — the caller supplies the
       cutoff (retention age, or the much shorter in-flight-upload guard).
       ORDER BY id ASC is oldest-first via the monotonic primary key, which is
       immune to a clock jump in a way created_at is not. */
    markPurged: db.prepare(
        'UPDATE messages SET purged_at = ? WHERE id = ? AND purged_at IS NULL AND deleted = 0'),
    // Paginated by id so a dry run — which marks nothing — still walks forward
    // instead of re-reading the same first page forever.
    purgeCandidates: db.prepare(
        'SELECT id, conversation_id, sender_id, file_name, file_size, created_at FROM messages '
        + 'WHERE file_size IS NOT NULL AND deleted = 0 AND purged_at IS NULL '
        + 'AND created_at < ? AND id > ? ORDER BY id ASC LIMIT ?'),
    recentPurged: db.prepare(
        'SELECT id FROM messages WHERE purged_at IS NOT NULL ORDER BY purged_at DESC LIMIT ?'),
    liveFileBytes: db.prepare(
        'SELECT COALESCE(SUM(file_size), 0) AS n FROM messages '
        + 'WHERE file_size IS NOT NULL AND deleted = 0 AND purged_at IS NULL'),
    userLiveFileBytes: db.prepare(
        'SELECT COALESCE(SUM(file_size), 0) AS n FROM messages '
        + 'WHERE sender_id = ? AND file_size IS NOT NULL AND deleted = 0 AND purged_at IS NULL'),
};

function publicUser(u) {
    if (!u) return null;
    return {
        id: u.id, username: u.username, displayName: u.display_name,
        role: u.role, status: u.status, avatar: u.avatar || null,
    };
}

// Stored as JSON text. A malformed value must degrade to the English `content`
// rather than throw while serializing a conversation.
function parseSysArgs(raw) {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' ? v : null;
    } catch { return null; }
}

// Group a message's reactions into [{ emoji, userIds: [...] }], one entry per
// distinct emoji, in the order they were first added.
function reactionsFor(messageId) {
    const rows = stmts.reactionsByMessage.all(messageId);
    if (!rows.length) return [];
    const map = new Map();
    for (const r of rows) {
        if (!map.has(r.emoji)) map.set(r.emoji, []);
        map.get(r.emoji).push(r.user_id);
    }
    return [...map.entries()].map(([emoji, userIds]) => ({ emoji, userIds }));
}

function messageJson(m) {
    if (!m) return null;
    return {
        id: m.id, conversationId: m.conversation_id, senderId: m.sender_id, type: m.type,
        content: m.content, fileName: m.file_name, fileSize: m.file_size, mime: m.mime,
        duration: m.duration, deleted: !!m.deleted, createdAt: m.created_at,
        // The client renders the placeholder from this flag, never from a failed
        // request — a year-immutable cache would otherwise show some viewers the
        // file and others the placeholder for the same message.
        purged: m.purged_at != null,
        // Absent on rows written before this existed; the client falls back to
        // `content`, which is the same sentence in English.
        sysKey: m.sys_key || null,
        sysArgs: parseSysArgs(m.sys_args),
        fwdFrom: m.fwd_from || null,
        // Skip the lookup for messages that cannot carry reactions.
        reactions: (m.deleted || m.type === 'system') ? [] : reactionsFor(m.id),
    };
}

function createUser({ username, displayName, salt, hash }) {
    const isFirst = stmts.countUsers.get().n === 0;
    const role = isFirst ? 'admin' : 'member';
    const status = isFirst ? 'active' : 'pending';
    const r = stmts.insertUser.run(username, displayName, salt, hash, role, status, now());
    return stmts.userById.get(Number(r.lastInsertRowid));
}

/* ---------------- sessions ---------------- */

function createSession(userId, hash) {
    const t = now();
    stmts.insertSession.run(hash, userId, t, t + config.SESSION_DAYS * 86400_000);
}

function userBySessionHash(hash) {
    const s = stmts.sessionByHash.get(hash);
    if (!s) return null;
    if (s.expires_at < now()) { stmts.deleteSession.run(hash); return null; }
    return stmts.userById.get(s.user_id) || null;
}

setInterval(() => stmts.purgeSessions.run(Date.now()), 3600_000).unref();

/* ---------------- conversations ---------------- */

function convJson(conv, forUserId) {
    const members = stmts.convMembers.all(conv.id).map(r => r.user_id);
    const last = stmts.lastMessage.get(conv.id);
    let unread = 0;
    if (forUserId != null) {
        const p = stmts.memberRow.get(conv.id, forUserId);
        if (p) unread = stmts.unreadCount.get(conv.id, p.last_read_msg_id, forUserId).n;
    }
    return {
        id: conv.id, type: conv.type, name: conv.name, createdBy: conv.created_by,
        createdAt: conv.created_at, members, lastMessage: messageJson(last), unread,
        // Direct chats take their identity from the other participant, so a
        // conversation-level photo is meaningless there; forced null so a wrongly
        // populated row can never surface one.
        avatar: conv.type === 'group' ? (conv.avatar || null) : null,
    };
}

function getOrCreateDirect(a, b) {
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    let conv = stmts.convByDirectKey.get(key);
    if (!conv) {
        const r = stmts.insertConv.run('direct', null, key, a, now());
        conv = stmts.convById.get(Number(r.lastInsertRowid));
    }
    stmts.addParticipant.run(conv.id, a, now());
    stmts.addParticipant.run(conv.id, b, now());
    return conv;
}

function createGroup(name, creatorId, memberIds) {
    const r = stmts.insertConv.run('group', name, null, creatorId, now());
    const conv = stmts.convById.get(Number(r.lastInsertRowid));
    const ids = new Set([creatorId, ...memberIds]);
    for (const id of ids) stmts.addParticipant.run(conv.id, id, now());
    return conv;
}

function listConversations(userId) {
    return stmts.userConvs.all(userId)
        .map(c => convJson(c, userId))
        .sort((x, y) => (y.lastMessage?.createdAt || y.createdAt) - (x.lastMessage?.createdAt || x.createdAt));
}

function messagesAfter(convId, afterId, limit) {
    return db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
        .all(convId, afterId, limit).map(messageJson);
}

function messagesBefore(convId, beforeId, limit) {
    const rows = beforeId > 0
        ? db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
            .all(convId, beforeId, limit)
        : db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
            .all(convId, limit);
    return rows.reverse().map(messageJson);
}

function addMessage({
    convId, senderId, type, content = null, fileName = null, fileSize = null,
    mime = null, duration = null, sysKey = null, sysArgs = null, fwdFrom = null,
    markRead = true,
}) {
    const r = stmts.insertMessage.run(
        convId, senderId, type, content, fileName, fileSize, mime, duration, now(),
        sysKey, sysArgs ? JSON.stringify(sysArgs) : null, fwdFrom);
    const id = Number(r.lastInsertRowid);
    // Sender has obviously read their own message — but only when a person
    // actually wrote it. A record the SERVER attributes to someone must not
    // advance their read marker, or it silently clears unread messages they
    // never saw.
    if (markRead) stmts.setLastRead.run(id, convId, senderId);
    return messageJson(stmts.messageById.get(id));
}

module.exports = {
    db, stmts, now,
    publicUser, messageJson, convJson,
    createUser, createSession, userBySessionHash,
    getOrCreateDirect, createGroup, listConversations, messagesBefore, messagesAfter, addMessage,
    reactionsFor,
};
