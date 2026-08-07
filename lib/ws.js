'use strict';
// Realtime hub: presence, message events, typing, and WebRTC call signaling.
// This module must never require api.js/files.js (they require us).

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const config = require('./config');
const DB = require('./db');
const { parseCookies, tokenHash } = require('./util');

const COOKIE = 'cw_session';

const conns = new Map();      // connId -> { ws, userId, alive }
const userConns = new Map();  // userId -> Set<connId>
const calls = new Map();      // callId -> { id, convId, kind, parts: Map<connId, userId>, startedBy, startedAt }
const convCall = new Map();   // convId -> callId

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
    let changed = false;
    for (const [connId, uid] of [...call.parts]) {
        if (uid === userId) { call.parts.delete(connId); call.eco.delete(connId); changed = true; }
    }
    if (!changed) return;
    settleAfterRemoval(call);
    sendToUser(userId, { t: 'call:ended', d: { callId: call.id, convId, reason: 'removed' } });
}

// Close every live socket bound to a given session token (logout revocation).
function closeSessionSockets(hash) {
    for (const c of conns.values()) {
        if (c.tokenHash === hash) { try { c.ws.close(4002, 'logged out'); } catch { /* closing */ } }
    }
}

function endCall(call, reason = 'ended', { log = true } = {}) {
    calls.delete(call.id);
    convCall.delete(call.convId);
    broadcastToConv(call.convId, { t: 'call:ended', d: { callId: call.id, convId: call.convId, reason } });
    if (log) logCallEnded(call);
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
            parts: new Map(), eco: new Set(), startedBy: conn.userId, startedAt: Date.now(),
        };
        calls.set(call.id, call);
        convCall.set(convId, call.id);
        addPart(call, connId, conn.userId, !!d?.eco);
        broadcastToConv(convId, { t: 'call:state', d: callState(call) });
        broadcastToConv(convId, {
            t: 'call:ring',
            d: { callId: call.id, convId, kind, from: conn.userId },
        }, conn.userId);
    } else {
        // A call already exists in this conversation — join it instead.
        addPart(call, connId, conn.userId, !!d?.eco);
        broadcastToConv(convId, { t: 'call:state', d: callState(call) });
    }
}

function handleCallJoin(conn, connId, d) {
    const call = calls.get(String(d?.callId || ''));
    if (!call) { sendTo(connId, { t: 'call:ended', d: { callId: d?.callId, convId: null, reason: 'gone' } }); return; }
    if (!DB.stmts.isMember.get(call.convId, conn.userId)) return;
    addPart(call, connId, conn.userId, !!d?.eco);
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
    const call = calls.get(String(d?.callId || ''));
    if (!call) return;
    if (!DB.stmts.isMember.get(call.convId, conn.userId)) return;
    broadcastToConv(call.convId, { t: 'call:declined', d: { callId: call.id, userId: conn.userId } });
    // If only the caller remains and everyone else declined, keep the call up —
    // the caller's UI decides when to hang up.
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
            const conn = { ws, userId: user.id, alive: true, tokenHash: sessionHash };
            conns.set(connId, conn);
            let set = userConns.get(user.id);
            const firstConn = !set || set.size === 0;
            if (!set) { set = new Set(); userConns.set(user.id, set); }
            set.add(connId);

            if (firstConn) broadcastToAll({ t: 'presence', d: { userId: user.id, online: true } });
            sendTo(connId, { t: 'hello', d: { connId, userId: user.id, online: onlineUserIds(), calls: activeCallsSummary(user.id) } });

            ws.on('message', (raw) => {
                try { handleMessage(conn, connId, raw); } catch (e) { console.error('ws message error', e); }
            });
            ws.on('pong', () => { conn.alive = true; });
            ws.on('close', () => {
                conns.delete(connId);
                const s = userConns.get(user.id);
                if (s) {
                    s.delete(connId);
                    if (s.size === 0) {
                        userConns.delete(user.id);
                        broadcastToAll({ t: 'presence', d: { userId: user.id, online: false } });
                    }
                }
                leaveCall(connId);
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
    sendToUser, broadcastToUsers, broadcastToAll, broadcastToConv, notifyAdmins,
    onlineUserIds, kickUser, activeCallsSummary,
    endCallForConv, evictUserFromConvCall, closeSessionSockets,
};
