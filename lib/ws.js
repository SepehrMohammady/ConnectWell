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

function callState(call) {
    return {
        callId: call.id, convId: call.convId, kind: call.kind,
        startedBy: call.startedBy, startedAt: call.startedAt,
        participants: [...call.parts].map(([connId, userId]) => ({ connId, userId })),
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
    if (call) endCall(call);
}

function evictUserFromConvCall(convId, userId) {
    const callId = convCall.get(convId);
    const call = callId ? calls.get(callId) : null;
    if (!call) return;
    let changed = false;
    for (const [connId, uid] of [...call.parts]) {
        if (uid === userId) { call.parts.delete(connId); changed = true; }
    }
    if (!changed) return;
    if (call.parts.size === 0) endCall(call);
    else broadcastToConv(call.convId, { t: 'call:state', d: callState(call) });
    sendToUser(userId, { t: 'call:ended', d: { callId: call.id, convId, reason: 'removed' } });
}

// Close every live socket bound to a given session token (logout revocation).
function closeSessionSockets(hash) {
    for (const c of conns.values()) {
        if (c.tokenHash === hash) { try { c.ws.close(4002, 'logged out'); } catch { /* closing */ } }
    }
}

function endCall(call, reason = 'ended') {
    calls.delete(call.id);
    convCall.delete(call.convId);
    broadcastToConv(call.convId, { t: 'call:ended', d: { callId: call.id, convId: call.convId, reason } });
}

function leaveCall(connId) {
    for (const call of calls.values()) {
        if (call.parts.has(connId)) {
            call.parts.delete(connId);
            if (call.parts.size === 0) {
                endCall(call);
            } else {
                broadcastToConv(call.convId, { t: 'call:state', d: callState(call) });
            }
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
            parts: new Map(), startedBy: conn.userId, startedAt: Date.now(),
        };
        calls.set(call.id, call);
        convCall.set(convId, call.id);
        call.parts.set(connId, conn.userId);
        broadcastToConv(convId, { t: 'call:state', d: callState(call) });
        broadcastToConv(convId, {
            t: 'call:ring',
            d: { callId: call.id, convId, kind, from: conn.userId },
        }, conn.userId);
    } else {
        // A call already exists in this conversation — join it instead.
        call.parts.set(connId, conn.userId);
        broadcastToConv(convId, { t: 'call:state', d: callState(call) });
    }
}

function handleCallJoin(conn, connId, d) {
    const call = calls.get(String(d?.callId || ''));
    if (!call) { sendTo(connId, { t: 'call:ended', d: { callId: d?.callId, convId: null, reason: 'gone' } }); return; }
    if (!DB.stmts.isMember.get(call.convId, conn.userId)) return;
    call.parts.set(connId, conn.userId);
    broadcastToConv(call.convId, { t: 'call:state', d: callState(call) });
}

function handleCallLeave(conn, connId, d) {
    const call = calls.get(String(d?.callId || ''));
    if (call && call.parts.has(connId)) {
        call.parts.delete(connId);
        if (call.parts.size === 0) endCall(call);
        else broadcastToConv(call.convId, { t: 'call:state', d: callState(call) });
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
