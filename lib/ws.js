'use strict';
// Realtime hub: presence, message events, typing, and WebRTC call signaling.
// This module must never require api.js/files.js (they require us).

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const config = require('./config');
const DB = require('./db');
const push = require('./push');
const { parseCookies, tokenHash } = require('./util');

const COOKIE = 'cw_session';

const conns = new Map();      // connId -> { ws, userId, alive, device, activeUntil }
const userConns = new Map();  // userId -> Set<connId>
const calls = new Map();      // callId -> { id, convId, kind, parts: Map<connId, userId>, startedBy, startedAt }
const convCall = new Map();   // convId -> callId

/* ---------------- who is actively using the app ----------------
   A window reports itself active while it is visible, focused and touched in
   the last few minutes. Background notifications skip anyone active somewhere:
   that window already shows what happened.

   The claim EXPIRES unless renewed, rather than lasting until revoked. A phone
   that drops off the network mid-conversation cannot say "inactive" — its
   socket just goes quiet until the heartbeat notices — and a claim that never
   lapsed would silence that person's notifications for the whole gap. */
const ACTIVE_TTL_MS = 75_000;

const connActive = (c) => !!c && c.activeUntil > Date.now();

function isUserActive(userId) {
    const set = userConns.get(userId);
    if (!set) return false;
    for (const id of set) if (connActive(conns.get(id))) return true;
    return false;
}

function handleActive(conn, d) {
    if (typeof d?.device === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(d.device)) conn.device = d.device;
    const was = isUserActive(conn.userId);
    conn.activeUntil = d?.active === true ? Date.now() + ACTIVE_TTL_MS : 0;
    if (was && !isUserActive(conn.userId)) ringLate(conn.userId);
}

/* ---------------- send helpers ---------------- */

function sendTo(connId, obj) {
    const c = conns.get(connId);
    if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(obj));
}

function sendToUser(userId, obj) {
    const set = userConns.get(userId);
    if (!set) return;
    const s = JSON.stringify(obj);
    for (const id of set) {
        const c = conns.get(id);
        if (c && c.ws.readyState === 1) c.ws.send(s);
    }
}

function broadcastToUsers(userIds, obj) {
    for (const id of userIds) sendToUser(id, obj);
}

function broadcastToAll(obj) {
    const s = JSON.stringify(obj);
    for (const c of conns.values()) if (c.ws.readyState === 1) c.ws.send(s);
}

function notifyAdmins(obj) {
    for (const [uid] of userConns) {
        const u = DB.stmts.userById.get(uid);
        if (u && u.role === 'admin') sendToUser(uid, obj);
    }
}

function convMemberIds(convId) {
    return DB.stmts.convMembers.all(convId).map(r => r.user_id);
}

// Everyone entitled to know about a given member: the people they share a
// conversation with, and themselves. Presence and profile changes go here rather
// than to everyone, so being on the same instance as somebody is not enough to
// learn that they exist, are online, or just changed their photo.
function broadcastToKnown(userId, obj) {
    for (const row of DB.stmts.knownUserIds.all(userId, userId)) sendToUser(row.id, obj);
}

function broadcastToConv(convId, obj, exceptUserId = null) {
    for (const uid of convMemberIds(convId)) {
        if (uid !== exceptUserId) sendToUser(uid, obj);
    }
}

function onlineUserIds() {
    return [...userConns.keys()];
}

function kickUser(userId) {
    const set = userConns.get(userId);
    if (!set) return;
    for (const id of [...set]) {
        const c = conns.get(id);
        if (c) c.ws.close(4001, 'account disabled');
    }
}

/* ---------------- calls ---------------- */

// Efficiency mode is a property of the CALL, not of one participant: a low
// bitrate only helps the person on the bad connection if everybody else sends at
// it too. So the server publishes both who asked for it and the single shared
// verdict (`eco`), and every client encodes to that.
function callState(call) {
    return {
        callId: call.id, convId: call.convId, kind: call.kind,
        startedBy: call.startedBy, startedAt: call.startedAt,
        eco: call.eco.size > 0,
        ecoUsers: [...new Set([...call.eco].map((c) => call.parts.get(c)).filter(Boolean))],
        participants: [...call.parts].map(([connId, userId]) => ({
            connId, userId, eco: call.eco.has(connId),
        })),
    };
}

// Only calls in conversations the user belongs to — call metadata (who is
// calling whom, in which conversation) must not leak across conversations.
function activeCallsSummary(userId) {
    return [...calls.values()]
        .filter((call) => userId == null || DB.stmts.isMember.get(call.convId, userId))
        .map(callState);
}

// End any in-progress call for a conversation (used when the conversation is
// deleted). Ejects a user's connections from a conversation's call (used when
// a member is removed).
function endCallForConv(convId) {
    const callId = convCall.get(convId);
    const call = callId ? calls.get(callId) : null;
    // No log: the only caller is deleting the conversation, so the record would
    // be cascade-deleted moments later anyway.
    if (call) endCall(call, 'ended', { log: false });
}

function evictUserFromConvCall(convId, userId) {
    const callId = convCall.get(convId);
    const call = callId ? calls.get(callId) : null;
    if (!call) return;
    // Removed while their phone was still ringing for it: stop the ringing.
    stopRing(call, userId, 'ended');
    let changed = false;
    for (const [connId, uid] of [...call.parts]) {
        if (uid === userId) { call.parts.delete(connId); call.eco.delete(connId); changed = true; }
    }
    if (!changed) return;
    settleAfterRemoval(call);
    sendToUser(userId, { t: 'call:ended', d: { callId: call.id, convId, reason: 'removed' } });
}

/* ---------------- ringing devices that are not open ----------------
   call.pushed maps each callee whose devices were rung by background push to
   the subscriptions that rang. Every one of those devices is told how it ended,
   exactly once — which is what stops a ringing phone — except the device that
   ended it itself (it answered or declined, so it already knows). */

function ringCallee(call, userId) {
    if (isUserActive(userId) || call.pushed.has(userId)) return;
    const ids = push.ring(call, userId);
    if (ids.length) call.pushed.set(userId, new Set(ids));
}

function stopRing(call, userId, reason, except = {}) {
    const ids = call.pushed.get(userId);
    if (!ids) return;
    call.pushed.delete(userId);
    push.ringEnded(call, userId, ids, reason, except);
}

// Everyone still ringing when the ringing is over. From where they sit it was
// missed, even in a group call that others picked up.
function stopAllRings(call) {
    for (const userId of [...call.pushed.keys()]) stopRing(call, userId, 'missed');
}

const userInCall = (call, userId) => [...call.parts.values()].includes(userId);

// Somebody just stopped being active — closed the window, locked the phone —
// while a call was still ringing for them in the app. The in-page ring is no
// longer being seen, so their devices ring instead, for the time that is left.
function ringLate(userId) {
    if (isUserActive(userId)) return;
    for (const call of calls.values()) {
        if (call.startedBy === userId || call.declined.has(userId) || userInCall(call, userId)) continue;
        if (!DB.stmts.isMember.get(call.convId, userId)) continue;
        ringCallee(call, userId);
    }
}

// Close every live socket bound to a given session token (logout revocation).
function closeSessionSockets(hash) {
    for (const c of conns.values()) {
        if (c.tokenHash === hash) { try { c.ws.close(4002, 'logged out'); } catch { /* closing */ } }
    }
}

// How long a call may ring before it is given up on. Server-side so it holds
// even if the caller's tab is backgrounded or their screen locks; the ringing
// UI on both sides ends when the resulting call:ended arrives.
const NO_ANSWER_MS = Math.max(5, config.CALL_RING_SECONDS) * 1000;

function endCall(call, reason = 'ended', { log = true } = {}) {
    clearTimeout(call.noAnswerTimer);
    calls.delete(call.id);
    convCall.delete(call.convId);
    stopAllRings(call);
    broadcastToConv(call.convId, { t: 'call:ended', d: { callId: call.id, convId: call.convId, reason } });
    if (log) {
        if (call.everConnected) logCallEnded(call);
        else logMissedCall(call);
    }
}

// Distinct users, not connections: one person may be in the call from two
// devices, and that still counts as one participant for "is anyone else here".
const callUserCount = (call) => new Set(call.parts.values()).size;

// `everConnected` records that the call once had two distinct people in it. That
// is what separates a live 1:1 that has lost its peer (end it — the other side
// must not sit in a call alone) from a fresh outgoing call still ringing with
// only its caller present (keep it up).
function addPart(call, connId, userId, eco = false) {
    call.parts.set(connId, userId);
    if (eco) call.eco.add(connId); else call.eco.delete(connId);
    if (callUserCount(call) >= 2 && !call.everConnected) {
        call.everConnected = true;
        // The ring timer keeps running: a group call others picked up must still
        // stop ringing for whoever never answered. It just no longer ends the call.
        // When two people were actually together, which is the duration worth
        // logging — not the ringing that preceded it.
        call.connectedAt = Date.now();
    }
}

// A call that connected leaves a record in the conversation. Raw timestamps go in
// sysArgs so each client renders them in its own locale and timezone; `content`
// carries a timezone-free English fallback for anything that cannot read the key.
function logCallEnded(call) {
    if (!call.everConnected || !call.connectedAt) return;
    const endedAt = Date.now();
    const seconds = Math.max(1, Math.round((endedAt - call.connectedAt) / 1000));
    const mmss = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    let message;
    try {
        message = DB.addMessage({
            convId: call.convId, senderId: call.startedBy, type: 'system',
            content: (call.kind === 'video' ? 'Video call' : 'Voice call') + ' · ' + mmss,
            sysKey: call.kind === 'video' ? 'sys.call_video' : 'sys.call_voice',
            sysArgs: { startedAt: call.connectedAt, endedAt, seconds },
            // Nobody wrote this; the server did. Advancing the starter's read
            // marker here would wipe the unread badge for messages that arrived
            // while they were on the call.
            markRead: false,
        });
    } catch { return; }   // logging must never break ending the call
    broadcastToConv(call.convId, { t: 'msg:new', d: { message } });
}

// A call that ended without ever connecting was missed. It leaves two traces:
// a system line in the thread (one shared message — sysArgs.by lets each viewer
// render "missed" or "no answer" depending on which side they were), and an
// activity item for every member except the caller, delivered live so the bell
// lights up the moment the ringing stops.
function logMissedCall(call) {
    try {
        const message = DB.addMessage({
            convId: call.convId, senderId: call.startedBy, type: 'system',
            content: call.kind === 'video' ? 'Missed video call' : 'Missed voice call',
            sysKey: call.kind === 'video' ? 'sys.call_missed_video' : 'sys.call_missed_voice',
            sysArgs: { by: call.startedBy },
            markRead: false,
        });
        broadcastToConv(call.convId, { t: 'msg:new', d: { message } });

        const now = Date.now();
        // Old items expire here rather than on a timer: inserts are the only
        // writer, and 90 days of somebody's bell history is more than enough.
        DB.stmts.pruneActivity.run(now - 90 * 86400_000);
        for (const row of DB.stmts.convMembers.all(call.convId)) {
            if (row.user_id === call.startedBy) continue;
            // The thread line stands for everyone, but someone who explicitly
            // declined did not miss anything — no bell item for them.
            if (call.declined && call.declined.has(row.user_id)) continue;
            const r = DB.stmts.insertActivity.run(
                row.user_id, 'missed_call', call.convId, message.id, call.startedBy, null, now);
            sendToUser(row.user_id, {
                t: 'activity:new',
                d: {
                    item: {
                        id: Number(r.lastInsertRowid), kind: 'missed_call',
                        convId: call.convId, messageId: message.id,
                        actorId: call.startedBy, emoji: null,
                        createdAt: now, seenAt: null,
                        msgType: 'system', msgContent: null, msgFileName: null,
                        msgSysKey: message.sysKey,
                    },
                },
            });
        }
    } catch { /* logging must never break ending the call */ }
}

// A soft-deleted message keeps its row, so the ON DELETE CASCADE never fires —
// its activity has to be swept by hand. Whoever held an unseen item gets their
// corrected badge count pushed, or the bell would keep advertising a notification
// that no longer opens anything.
function clearMessageActivity(messageId) {
    const holders = DB.stmts.unseenActivityUsers.all(messageId).map((r) => r.user_id);
    DB.stmts.deleteActivityForMessage.run(messageId);
    for (const uid of holders) {
        sendToUser(uid, { t: 'activity:sync', d: { unseen: DB.stmts.unseenActivity.get(uid).n } });
    }
}

// After a connection leaves: if nobody is left, or the call was active and is now
// down to a single person, end it for everyone; otherwise just refresh the roster.
function settleAfterRemoval(call) {
    if (call.parts.size === 0 || (call.everConnected && callUserCount(call) < 2)) {
        endCall(call);
    } else {
        broadcastToConv(call.convId, { t: 'call:state', d: callState(call) });
    }
}

function leaveCall(connId) {
    for (const call of calls.values()) {
        if (call.parts.has(connId)) {
            call.parts.delete(connId); call.eco.delete(connId);
            settleAfterRemoval(call);
        }
    }
}

function handleCallStart(conn, connId, d) {
    const convId = Number(d?.convId);
    const kind = d?.kind === 'video' ? 'video' : 'audio';
    if (!DB.stmts.isMember.get(convId, conn.userId)) return;

    let call = convCall.has(convId) ? calls.get(convCall.get(convId)) : null;
    if (!call) {
        call = {
            id: crypto.randomUUID(), convId, kind,
            parts: new Map(), eco: new Set(), declined: new Set(), pushed: new Map(),
            startedBy: conn.userId, startedAt: Date.now(),
        };
        calls.set(call.id, call);
        convCall.set(convId, call.id);
        // The ring is over. Nobody picked up: end it, which also writes the
        // missed-call line and rings everyone's activity bell. Somebody did (a
        // group call): leave it running, but stop ringing the rest.
        call.noAnswerTimer = setTimeout(() => {
            const live = calls.get(call.id);
            if (!live) return;
            if (!live.everConnected) endCall(live, 'no_answer');
            else stopAllRings(live);
        }, NO_ANSWER_MS);
        addPart(call, connId, conn.userId, !!d?.eco);
        broadcastToConv(convId, { t: 'call:state', d: callState(call) });
        broadcastToConv(convId, {
            t: 'call:ring',
            d: { callId: call.id, convId, kind, from: conn.userId },
        }, conn.userId);
        // Callees not looking at the app right now hear it on their devices.
        for (const uid of convMemberIds(convId)) if (uid !== conn.userId) ringCallee(call, uid);
    } else {
        // A call already exists in this conversation — join it instead.
        addPart(call, connId, conn.userId, !!d?.eco);
        stopRing(call, conn.userId, 'answered', { device: conn.device });
        broadcastToConv(convId, { t: 'call:state', d: callState(call) });
    }
}

function handleCallJoin(conn, connId, d) {
    const call = calls.get(String(d?.callId || ''));
    if (!call) { sendTo(connId, { t: 'call:ended', d: { callId: d?.callId, convId: null, reason: 'gone' } }); return; }
    if (!DB.stmts.isMember.get(call.convId, conn.userId)) return;
    addPart(call, connId, conn.userId, !!d?.eco);
    // Answered here: the user's other ringing devices hear where it went.
    stopRing(call, conn.userId, 'answered', { device: conn.device });
    broadcastToConv(call.convId, { t: 'call:state', d: callState(call) });
}

// Toggled mid-call from the profile switch. Only a participant can set their own
// flag, and the whole call re-reads the shared verdict from the broadcast.
function handleCallEco(conn, connId, d) {
    const call = calls.get(String(d?.callId || ''));
    if (!call || !call.parts.has(connId)) return;
    const on = !!d?.eco;
    if (call.eco.has(connId) === on) return;
    if (on) call.eco.add(connId); else call.eco.delete(connId);
    broadcastToConv(call.convId, { t: 'call:state', d: callState(call) });
}

function handleCallLeave(conn, connId, d) {
    const call = calls.get(String(d?.callId || ''));
    if (call && call.parts.has(connId)) {
        call.parts.delete(connId); call.eco.delete(connId);
        settleAfterRemoval(call);
    }
}

function handleCallDecline(conn, connId, d) {
    declineCall(conn.userId, String(d?.callId || ''), { device: conn.device });
}

// Shared by the socket and by the REST route a notification's Decline button
// calls — a phone answering from its lock screen has no socket open. `except`
// names the device that declined, which needs no word about it.
function declineCall(userId, callId, except = {}) {
    const call = calls.get(callId);
    if (!call) return false;
    if (!DB.stmts.isMember.get(call.convId, userId)) return false;
    // Remembered so the bell stays quiet for them: declining is handling the
    // call, not missing it.
    call.declined.add(userId);
    stopRing(call, userId, 'declined', except);
    broadcastToConv(call.convId, { t: 'call:declined', d: { callId: call.id, userId } });
    // If only the caller remains and everyone else declined, keep the call up —
    // the caller's UI decides when to hang up.
    return true;
}

function handleRtc(conn, connId, d) {
    const call = calls.get(String(d?.callId || ''));
    if (!call) return;
    if (!call.parts.has(connId)) return;
    const target = String(d?.toConn || '');
    if (!call.parts.has(target)) return;
    sendTo(target, {
        t: 'rtc',
        d: { callId: call.id, fromConn: connId, fromUser: conn.userId, data: d.data },
    });
}

/* ---------------- connection lifecycle ---------------- */

function handleMessage(conn, connId, raw) {
    if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return;
    if (raw.length > 64 * 1024) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { t, d } = msg || {};
    switch (t) {
        case 'ping':
            sendTo(connId, { t: 'pong' });
            break;
        case 'typing': {
            const convId = Number(d?.convId);
            if (DB.stmts.isMember.get(convId, conn.userId)) {
                broadcastToConv(convId, { t: 'typing', d: { convId, userId: conn.userId } }, conn.userId);
            }
            break;
        }
        case 'call:start': handleCallStart(conn, connId, d); break;
        case 'call:join': handleCallJoin(conn, connId, d); break;
        case 'call:eco': handleCallEco(conn, connId, msg.d); break;
        case 'call:leave': handleCallLeave(conn, connId, d); break;
        case 'call:decline': handleCallDecline(conn, connId, d); break;
        case 'rtc': handleRtc(conn, connId, d); break;
        case 'active': handleActive(conn, d); break;
        default: break;
    }
}

function initWs(httpServer) {
    const wss = new WebSocketServer({ noServer: true });
    const wsPath = config.BASE_PATH + '/ws';

    httpServer.on('upgrade', (req, socket, head) => {
      // A throw here (bad request target, DB error) would otherwise be an
      // uncaughtException and take down the whole single-process server.
      try {
        const url = new URL(req.url, 'http://x');
        if (url.pathname !== wsPath) { socket.destroy(); return; }

        // Origin check: browser clients must come from our own origin.
        const origin = req.headers.origin;
        const allowed = new Set([config.PUBLIC_ORIGIN, `http://localhost:${config.PORT}`, `http://127.0.0.1:${config.PORT}`]);
        if (origin && !allowed.has(origin)) { socket.destroy(); return; }

        const cookies = parseCookies(req.headers.cookie);
        const token = cookies[COOKIE];
        const user = token ? DB.userBySessionHash(tokenHash(token)) : null;
        if (!user || user.status !== 'active') {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        const sessionHash = tokenHash(token);

        wss.handleUpgrade(req, socket, head, (ws) => {
            const connId = crypto.randomUUID();
            // Not active until the page says so: an old page that never reports
            // must not silence anybody's notifications.
            const conn = {
                ws, userId: user.id, alive: true, tokenHash: sessionHash, device: null, activeUntil: 0,
            };
            conns.set(connId, conn);
            let set = userConns.get(user.id);
            const firstConn = !set || set.size === 0;
            if (!set) { set = new Set(); userConns.set(user.id, set); }
            set.add(connId);

            if (firstConn) broadcastToKnown(user.id, { t: 'presence', d: { userId: user.id, online: true } });
            sendTo(connId, { t: 'hello', d: { connId, userId: user.id, online: onlineUserIds(), calls: activeCallsSummary(user.id) } });

            ws.on('message', (raw) => {
                try { handleMessage(conn, connId, raw); } catch (e) { console.error('ws message error', e); }
            });
            ws.on('pong', () => { conn.alive = true; });
            ws.on('close', () => {
                const wasActive = connActive(conn);
                conns.delete(connId);
                const s = userConns.get(user.id);
                if (s) {
                    s.delete(connId);
                    if (s.size === 0) {
                        userConns.delete(user.id);
                        broadcastToKnown(user.id, { t: 'presence', d: { userId: user.id, online: false } });
                    }
                }
                leaveCall(connId);
                // Closing the app mid-ring is walking away from the ring.
                if (wasActive) ringLate(user.id);
            });
            ws.on('error', () => ws.close());
        });
      } catch (e) {
        console.error('ws upgrade error', e);
        try { socket.destroy(); } catch { /* already gone */ }
      }
    });

    // Heartbeat: drop dead connections so presence stays truthful.
    setInterval(() => {
        for (const [, conn] of conns) {
            if (!conn.alive) { conn.ws.terminate(); continue; }
            conn.alive = false;
            try { conn.ws.ping(); } catch { /* closing */ }
        }
    }, 30_000).unref();

    return wss;
}

module.exports = {
    initWs,
    sendToUser, broadcastToUsers, broadcastToAll, broadcastToConv, broadcastToKnown, notifyAdmins,
    onlineUserIds, kickUser, activeCallsSummary, isUserActive, declineCall,
    endCallForConv, evictUserFromConvCall, closeSessionSockets, clearMessageActivity,
};
