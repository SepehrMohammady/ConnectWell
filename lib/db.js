'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(config.DATA_DIR, 'uploads'), { recursive: true });

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
    created_at    INTEGER NOT NULL
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
    created_at INTEGER NOT NULL
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
`);

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

    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)'),
    sessionByHash: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),

    insertConv: db.prepare('INSERT INTO conversations (type, name, direct_key, created_by, created_at) VALUES (?,?,?,?,?)'),
    convById: db.prepare('SELECT * FROM conversations WHERE id = ?'),
    convByDirectKey: db.prepare('SELECT * FROM conversations WHERE direct_key = ?'),
    renameConv: db.prepare('UPDATE conversations SET name = ? WHERE id = ?'),
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
        'INSERT INTO messages (conversation_id, sender_id, type, content, file_name, file_size, mime, duration, created_at) VALUES (?,?,?,?,?,?,?,?,?)'),
    messageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
    lastMessage: db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1'),
    unreadCount: db.prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND id > ? AND sender_id != ? AND deleted = 0 AND type != 'system'"),
    softDeleteMessage: db.prepare(
        "UPDATE messages SET deleted = 1, content = NULL, file_name = NULL, file_size = NULL, mime = NULL, duration = NULL WHERE id = ?"),
};

function publicUser(u) {
    if (!u) return null;
    return { id: u.id, username: u.username, displayName: u.display_name, role: u.role, status: u.status };
}

function messageJson(m) {
    if (!m) return null;
    return {
        id: m.id, conversationId: m.conversation_id, senderId: m.sender_id, type: m.type,
        content: m.content, fileName: m.file_name, fileSize: m.file_size, mime: m.mime,
        duration: m.duration, deleted: !!m.deleted, createdAt: m.created_at,
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

function addMessage({ convId, senderId, type, content = null, fileName = null, fileSize = null, mime = null, duration = null }) {
    const r = stmts.insertMessage.run(convId, senderId, type, content, fileName, fileSize, mime, duration, now());
    const id = Number(r.lastInsertRowid);
    // Sender has obviously read their own message.
    stmts.setLastRead.run(id, convId, senderId);
    return messageJson(stmts.messageById.get(id));
}

module.exports = {
    db, stmts, now,
    publicUser, messageJson, convJson,
    createUser, createSession, userBySessionHash,
    getOrCreateDirect, createGroup, listConversations, messagesBefore, messagesAfter, addMessage,
};
