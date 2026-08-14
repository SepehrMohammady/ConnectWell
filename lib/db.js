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

-- The activity feed: things that happened TO this user while they were not
-- looking — a call they missed, a reaction to their message. One row per
-- recipient, so the same missed group call fans out to every member. Real
-- deletes of a user or conversation cascade; messages soft-delete, so their
-- activity is cleaned up explicitly where the soft delete happens.
CREATE TABLE IF NOT EXISTS activity (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,               -- missed_call | reaction
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id      INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    actor_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji           TEXT,
    created_at      INTEGER NOT NULL,
    seen_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity(user_id, id);

-- Deleting a message somebody has already read needs their consent. The set of
-- approvers is FROZEN into del_votes when the request is filed: read positions
-- keep moving, and a set that grew as more people read could never complete.
CREATE TABLE IF NOT EXISTS del_requests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL,
    requested_by    INTEGER NOT NULL,
    state           TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|denied|expired
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    resolved_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_delreq_msg ON del_requests(message_id);
CREATE INDEX IF NOT EXISTS idx_delreq_state ON del_requests(state);

CREATE TABLE IF NOT EXISTS del_votes (
    request_id INTEGER NOT NULL REFERENCES del_requests(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL,
    vote       TEXT,                                  -- NULL until answered: yes|no
    voted_at   INTEGER,
    PRIMARY KEY (request_id, user_id)
);
`);

/* ---------------- schema migrations ----------------
   CREATE TABLE IF NOT EXISTS above is a no-op against a database that already
   exists, so a column declared there alone would never reach an installed
   deployment. Every column added after the first release therefore lives HERE
   as a guarded ALTER and NOT in the CREATE TABLE — addColumn runs on a fresh
   install too, so one declaration is enough and two would only drift.

   The position matters in both directions. This must run AFTER the exec above,
   or on a fresh install the tables do not exist yet and the ALTER throws; and
   BEFORE any db.prepare() below, because prepare resolves column names eagerly
   and would throw "no such column" while this module is still being required,
   killing the process before the server ever listens. */
function addColumn(table, column, decl) {
    const present = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (present) return false;
    try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
        return true;                 // tells callers a one-time backfill is due
    } catch (err) {
        // Harmless if two processes raced us to it; anything else is real.
        if (!/duplicate column name/i.test(err.message)) throw err;
        return false;
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
// When this message was first read by somebody other than its sender. STICKY and
// never cleared: permission to edit or freely delete is gated on it, and
// participants.last_read_msg_id cannot serve because leaving and rejoining a
// group resets that row to zero, which would hand the sender back the right to
// rewrite something the returning member had already read.
const seenAtAdded = addColumn('messages', 'seen_at', 'INTEGER');
// Set when a message's text was edited, so the client can mark it.
addColumn('messages', 'edited_at', 'INTEGER');
// Set when a removal must leave a visible "Message deleted" marker: somebody had
// already read the message, so making it vanish would be a hole in their thread.
// A message deleted before anybody read it has no such flag and disappears whole,
// because nobody could have noticed it either way.
const tombstoneAdded = addColumn('messages', 'tombstone', 'INTEGER');
// The newest message that already existed when this member joined. Everything
// older is not theirs to have read, which both floors their unread count and
// keeps them out of the audience a "seen by everyone" tick is measured against.
addColumn('participants', 'join_msg_id', 'INTEGER NOT NULL DEFAULT 0');

// One-time backfill. Without it every message that predates the column reads as
// never-seen, so a sender could silently rewrite history their recipients
// demonstrably already read — exactly what the edit rule exists to prevent. The
// truth is recoverable from the read watermarks that exist today.
if (seenAtAdded) {
    db.exec(`
        UPDATE messages SET seen_at = created_at
        WHERE seen_at IS NULL AND EXISTS (
            SELECT 1 FROM participants p
            WHERE p.conversation_id = messages.conversation_id
              AND p.user_id != messages.sender_id
              AND p.last_read_msg_id >= messages.id
        )`);
}

// The same problem in the other direction: rows deleted before this column
// existed are all NULL, so without a backfill every marker anybody has already
// seen would vanish on the deploy. Both signals that justify a marker survive in
// the data — an approved deletion request, or a message that had been read.
if (tombstoneAdded) {
    db.exec(`
        UPDATE messages SET tombstone = 1
        WHERE deleted = 1 AND (
            seen_at IS NOT NULL
            OR id IN (SELECT message_id FROM del_requests WHERE state = 'approved')
        )`);
}

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

    addParticipant: db.prepare(
        'INSERT OR IGNORE INTO participants (conversation_id, user_id, joined_at, join_msg_id) VALUES (?,?,?,?)'),
    removeParticipant: db.prepare('DELETE FROM participants WHERE conversation_id = ? AND user_id = ?'),
    // The read watermark and join floor ride along: convJson already scans exactly
    // these rows, so exposing them costs no extra query.
    convMembers: db.prepare(
        'SELECT user_id, last_read_msg_id, join_msg_id FROM participants WHERE conversation_id = ? ORDER BY joined_at'),
    isMember: db.prepare('SELECT 1 FROM participants WHERE conversation_id = ? AND user_id = ?'),
    memberRow: db.prepare('SELECT * FROM participants WHERE conversation_id = ? AND user_id = ?'),
    // Conditional rather than MAX(): MAX matches the row and rewrites it every
    // time, so changes is always 1 and the "did anything move?" guard that stops
    // a read-broadcast storm would fail open.
    setLastRead: db.prepare(
        'UPDATE participants SET last_read_msg_id = ? WHERE conversation_id = ? AND user_id = ? AND last_read_msg_id < ?'),
    // Stamps the sticky seen marker across the range a reader just caught up on.
    // Bounded by id so it stays on the (conversation_id, id) index.
    stampSeen: db.prepare(
        'UPDATE messages SET seen_at = ? WHERE conversation_id = ? AND id > ? AND id <= ? '
        + 'AND sender_id != ? AND seen_at IS NULL'),

    insertMessage: db.prepare(
        'INSERT INTO messages (conversation_id, sender_id, type, content, file_name, file_size, mime, duration, created_at, sys_key, sys_args, fwd_from) '
        + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'),
    messageById: db.prepare('SELECT * FROM messages WHERE id = ?'),

    hasReaction: db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'),
    addReaction: db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)'),
    removeReaction: db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'),
    reactionsByMessage: db.prepare('SELECT emoji, user_id FROM reactions WHERE message_id = ? ORDER BY created_at, user_id'),
    // Skips a message deleted without consent: nobody ever saw it, so it must
    // not linger as a ghost preview in the sidebar either.
    lastMessage: db.prepare(
        'SELECT * FROM messages WHERE conversation_id = ? AND NOT (deleted = 1 AND tombstone IS NULL) '
        + 'ORDER BY id DESC LIMIT 1'),
    unreadCount: db.prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND id > ? AND sender_id != ? AND deleted = 0 AND type != 'system'"),
    // Writes ONLY the text and the edit stamp. Never created_at: moving that
    // would jump day separators, reorder the sidebar, and let a sender postpone
    // retention indefinitely by re-editing.
    markTombstone: db.prepare('UPDATE messages SET tombstone = 1 WHERE id = ?'),

    /* Activity feed. Reads join participants so items in conversations the user
       has since left (or been removed from) silently drop out — the row would
       otherwise point somewhere they can no longer go. The badge count applies
       the same filter, or it would advertise items the list does not show. */
    insertActivity: db.prepare(
        'INSERT INTO activity (user_id, kind, conversation_id, message_id, actor_id, emoji, created_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?)'),
    listActivity: db.prepare(
        'SELECT a.*, m.type AS msg_type, m.content AS msg_content, m.file_name AS msg_file_name, '
        + 'm.sys_key AS msg_sys_key '
        + 'FROM activity a '
        + 'JOIN participants p ON p.conversation_id = a.conversation_id AND p.user_id = a.user_id '
        + 'LEFT JOIN messages m ON m.id = a.message_id '
        + 'WHERE a.user_id = ? ORDER BY a.id DESC LIMIT 100'),
    unseenActivity: db.prepare(
        'SELECT COUNT(*) AS n FROM activity a '
        + 'JOIN participants p ON p.conversation_id = a.conversation_id AND p.user_id = a.user_id '
        + 'WHERE a.user_id = ? AND a.seen_at IS NULL'),
    markActivitySeen: db.prepare('UPDATE activity SET seen_at = ? WHERE user_id = ? AND seen_at IS NULL'),
    // Users holding unseen rows for a message — read BEFORE deleting the rows,
    // so their badge counts can be corrected afterwards.
    unseenActivityUsers: db.prepare(
        'SELECT DISTINCT user_id FROM activity WHERE message_id = ? AND seen_at IS NULL'),
    deleteActivityForMessage: db.prepare('DELETE FROM activity WHERE message_id = ?'),
    // Un-reacting withdraws the notification: pointing someone at a reaction
    // that no longer exists would be worse than saying nothing.
    removeReactionActivity: db.prepare(
        "DELETE FROM activity WHERE kind = 'reaction' AND message_id = ? AND actor_id = ? AND emoji = ?"),
    pruneActivity: db.prepare('DELETE FROM activity WHERE created_at < ?'),
    // The highest id in the conversation, deleted or not. Distinct from
    // lastMessage, which answers "what should the sidebar show" and therefore
    // skips removals that left no marker.
    maxMessageId: db.prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?'),
    editMessage: db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?'),

    /* ---- deletion requests ---- */
    // Everyone who had actually read this message when the request was filed.
    // joinMsgId keeps a later joiner out; the sender is never their own approver.
    seenApprovers: db.prepare(
        'SELECT p.user_id FROM participants p JOIN users u ON u.id = p.user_id '
        + 'WHERE p.conversation_id = ? AND p.user_id != ? '
        + 'AND p.last_read_msg_id >= ? AND p.join_msg_id < ? '
        + "AND u.status = 'active'"),
    insertDelReq: db.prepare(
        'INSERT INTO del_requests (message_id, conversation_id, requested_by, created_at, expires_at) '
        + 'VALUES (?,?,?,?,?)'),
    insertDelVote: db.prepare('INSERT OR IGNORE INTO del_votes (request_id, user_id) VALUES (?,?)'),
    delReqById: db.prepare('SELECT * FROM del_requests WHERE id = ?'),
    pendingDelReq: db.prepare("SELECT * FROM del_requests WHERE message_id = ? AND state = 'pending'"),
    delReqCount: db.prepare('SELECT COUNT(*) AS n FROM del_requests WHERE message_id = ?'),
    delVotes: db.prepare('SELECT user_id, vote FROM del_votes WHERE request_id = ?'),
    castVote: db.prepare(
        'UPDATE del_votes SET vote = ?, voted_at = ? WHERE request_id = ? AND user_id = ? AND vote IS NULL'),
    // Waives a departed member's vote so their absence cannot stall a request.
    waiveVote: db.prepare("UPDATE del_votes SET vote = 'waived', voted_at = ? WHERE request_id = ? AND user_id = ?"),
    // Claims the transition. Four paths can resolve a request (vote, waiver,
    // expiry sweep, lazy expiry), so the winner is whoever this UPDATE matches.
    settleDelReq: db.prepare(
        "UPDATE del_requests SET state = ?, resolved_at = ? WHERE id = ? AND state = 'pending'"),
    expiredDelReqs: db.prepare("SELECT * FROM del_requests WHERE state = 'pending' AND expires_at <= ?"),
    pendingReqsForUser: db.prepare(
        "SELECT r.* FROM del_requests r JOIN del_votes v ON v.request_id = r.id "
        + "WHERE r.state = 'pending' AND v.user_id = ? AND v.vote IS NULL"),
    allPendingReqs: db.prepare("SELECT * FROM del_requests WHERE state = 'pending'"),
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
        tombstone: m.tombstone === 1,
        // Absent on rows written before this existed; the client falls back to
        // `content`, which is the same sentence in English.
        sysKey: m.sys_key || null,
        sysArgs: parseSysArgs(m.sys_args),
        fwdFrom: m.fwd_from || null,
        // Sticky: once true it never goes back, and it is what gates editing and
        // free deletion. Never derived from a live read watermark.
        seen: m.seen_at != null,
        editedAt: m.edited_at || null,
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
    const rows = stmts.convMembers.all(conv.id);
    const members = rows.map((r) => r.user_id);
    const last = stmts.lastMessage.get(conv.id);
    let unread = 0;
    if (forUserId != null) {
        const p = stmts.memberRow.get(conv.id, forUserId);
        // Floor at the join point: without it somebody added to an old group is
        // handed an unread badge for its entire history.
        if (p) {
            unread = stmts.unreadCount.get(
                conv.id, Math.max(p.last_read_msg_id, p.join_msg_id), forUserId).n;
        }
    }
    return {
        id: conv.id, type: conv.type, name: conv.name, createdBy: conv.created_by,
        createdAt: conv.created_at, members, lastMessage: messageJson(last), unread,
        // Each member's read position, so the client can decide "seen" for every
        // message on screen without a per-message query. joinMsgId keeps a late
        // joiner out of the audience for messages sent before they arrived.
        reads: rows.map((r) => ({
            userId: r.user_id, lastReadId: r.last_read_msg_id, joinMsgId: r.join_msg_id,
        })),
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
    // Brand-new conversation, so there is no history to floor against.
    stmts.addParticipant.run(conv.id, a, now(), 0);
    stmts.addParticipant.run(conv.id, b, now(), 0);
    return conv;
}

function createGroup(name, creatorId, memberIds) {
    const r = stmts.insertConv.run('group', name, null, creatorId, now());
    const conv = stmts.convById.get(Number(r.lastInsertRowid));
    const ids = new Set([creatorId, ...memberIds]);
    for (const id of ids) stmts.addParticipant.run(conv.id, id, now(), 0);
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

/* ---------------- attachment filter ----------------
   Every filterable category maps to the stored `type` (see classifyMime), which
   is why "audio but not voice notes" is expressible at all: a voice note is
   type 'voice' and a video note 'videomsg', both distinct from 'audio'.

   The type set is variable but the statement is not: six fixed slots, padded
   with a value no row can hold. This keeps user input strictly in bound
   parameters — no SQL is ever assembled from a request. */
const FILTER_TYPES = ['image', 'video', 'audio', 'voice', 'videomsg', 'document'];
const TYPE_SLOTS = FILTER_TYPES.length;

const filterStmt = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ?'
    + ' AND deleted = 0 AND file_size IS NOT NULL'          // attachments only
    + ' AND (? = 1 OR type IN (?,?,?,?,?,?))'
    + ' AND created_at >= ? AND created_at < ?'
    + ' AND (? = 0 OR id < ?)'
    + ' ORDER BY id DESC LIMIT ?');

// Whole numbers only, and never bitwise: epoch milliseconds overflow 32 bits, so
// `x | 0` would silently mangle every date bound.
const asInt = (v, dflt) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : dflt);

// An empty `types` means every attachment. from/to are epoch ms resolved from the
// viewer's LOCAL day boundaries by the client — the server never guesses a zone.
function filterMessages(convId, { types = [], from = 0, to = null, before = 0, limit = 40 } = {}) {
    const wanted = FILTER_TYPES.filter((x) => types.includes(x));
    const slots = wanted.slice(0, TYPE_SLOTS);
    // Pad with a sentinel no row can hold, so the arity never changes.
    while (slots.length < TYPE_SLOTS) slots.push(' none');
    const beforeId = Math.max(0, asInt(before, 0));
    const rows = filterStmt.all(
        convId,
        wanted.length === 0 ? 1 : 0, ...slots,
        Math.max(0, asInt(from, 0)),
        to == null ? Number.MAX_SAFE_INTEGER : Math.max(0, asInt(to, Number.MAX_SAFE_INTEGER)),
        beforeId > 0 ? 1 : 0, beforeId,
        Math.min(Math.max(1, asInt(limit, 40)), 100));
    return rows.reverse().map(messageJson);
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
    if (markRead) stmts.setLastRead.run(id, convId, senderId, id);
    return messageJson(stmts.messageById.get(id));
}

// The wire shape of one activity item. The message snippet rides along because
// the recipient's client may not have that part of the thread loaded.
function activityJson(a) {
    return {
        id: a.id, kind: a.kind, convId: a.conversation_id, messageId: a.message_id,
        actorId: a.actor_id, emoji: a.emoji || null,
        createdAt: a.created_at, seenAt: a.seen_at || null,
        msgType: a.msg_type || null,
        msgContent: a.msg_content || null,
        msgFileName: a.msg_file_name || null,
        // For missed calls this is the system message's key, which is how the
        // client tells a missed voice call from a missed video call.
        msgSysKey: a.msg_sys_key || null,
    };
}

module.exports = {
    db, stmts, now,
    publicUser, messageJson, convJson, activityJson,
    createUser, createSession, userBySessionHash,
    getOrCreateDirect, createGroup, listConversations, messagesBefore, messagesAfter, addMessage,
    reactionsFor, filterMessages, FILTER_TYPES,
};
