'use strict';
// Consent-gated deletion.
//
// A message nobody has read yet is the sender's to remove. Once somebody has
// read it, removing it takes their agreement: the people who had actually seen
// it are frozen into a vote list when the request is filed, and every one of
// them must say yes.
//
// The rules, as chosen by the owner:
//   - any single denial ends the request immediately and keeps the message;
//   - silence never approves — an unanswered request expires after a week and
//     the message stays;
//   - a message may be asked about at most MAX_REQUESTS times, with no cooldown;
//   - an approver who leaves, is blocked or is deleted has their vote WAIVED, so
//     their absence cannot stall the request forever.

const DB = require('./db');
const ws = require('./ws');
const files = require('./files');

const REQUEST_TTL_MS = 7 * 86400_000;
const MAX_REQUESTS = 3;

const reqJson = (r, votes) => ({
    id: r.id,
    messageId: r.message_id,
    convId: r.conversation_id,
    requestedBy: r.requested_by,
    state: r.state,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    total: votes.length,
    approved: votes.filter((v) => v.vote === 'yes').length,
    waived: votes.filter((v) => v.vote === 'waived').length,
    // Who still owes an answer, so a client can tell whether IT is being asked.
    // Consistent with the group read receipts this app already shares. How anyone
    // voted is never sent: naming a refuser invites private pressure.
    pending: votes.filter((v) => v.vote === null || v.vote === undefined).map((v) => v.user_id),
});

function votesOf(reqId) { return DB.stmts.delVotes.all(reqId); }

// Everything that remains genuinely undecided.
const outstanding = (votes) => votes.filter((v) => v.vote === null || v.vote === undefined);

function broadcastState(r) {
    const votes = votesOf(r.id);
    ws.broadcastToConv(r.conversation_id, {
        t: 'msg:delreq', d: { request: reqJson(r, votes) },
    });
}

// Claims the pending -> final transition. Whoever's UPDATE matches wins, so two
// near-simultaneous approvals cannot both delete and broadcast.
function settle(reqId, state) {
    const claimed = DB.stmts.settleDelReq.run(state, Date.now(), reqId);
    if (claimed.changes !== 1) return null;
    const r = DB.stmts.delReqById.get(reqId);
    if (state === 'approved') {
        const m = DB.stmts.messageById.get(r.message_id);
        if (m && !m.deleted) {
            files.removeMessageFile(m.id);
            DB.stmts.softDeleteMessage.run(m.id);
            ws.broadcastToConv(m.conversation_id, {
                t: 'msg:deleted', d: { convId: m.conversation_id, messageId: m.id },
            });
        }
    }
    broadcastState(r);
    return r;
}

// Resolves whatever the current votes imply, or leaves it pending.
function evaluate(reqId) {
    const r = DB.stmts.delReqById.get(reqId);
    if (!r || r.state !== 'pending') return r;
    if (r.expires_at <= Date.now()) return settle(reqId, 'expired') || r;
    const votes = votesOf(reqId);
    if (votes.some((v) => v.vote === 'no')) return settle(reqId, 'denied') || r;
    if (outstanding(votes).length === 0) return settle(reqId, 'approved') || r;
    return r;
}

// Expiry is enforced two ways: lazily wherever a request is read, and by a timer
// in server.js. A deploy restarts the process and its timer, so neither is
// sufficient on its own.
function expireDue() {
    for (const r of DB.stmts.expiredDelReqs.all(Date.now())) settle(r.id, 'expired');
}

// A departing member must not be able to freeze a request forever.
function waiveFor(userId, convId) {
    for (const r of DB.stmts.allPendingReqs.all()) {
        if (convId != null && r.conversation_id !== convId) continue;
        const before = votesOf(r.id);
        if (!before.some((v) => v.user_id === userId && (v.vote === null || v.vote === undefined))) continue;
        DB.stmts.waiveVote.run(Date.now(), r.id, userId);
        evaluate(r.id);
    }
}

// The requests this user still owes an answer on, for the client to prompt with.
function pendingFor(userId) {
    expireDue();
    return DB.stmts.pendingReqsForUser.all(userId).map((r) => reqJson(r, votesOf(r.id)));
}

// The open request on a message, if any — used to render its pending state.
function openRequest(messageId) {
    const r = DB.stmts.pendingDelReq.get(messageId);
    if (!r) return null;
    if (r.expires_at <= Date.now()) { settle(r.id, 'expired'); return null; }
    return reqJson(r, votesOf(r.id));
}

module.exports = {
    REQUEST_TTL_MS, MAX_REQUESTS,
    settle, evaluate, expireDue, waiveFor, pendingFor, openRequest, reqJson, votesOf, broadcastState,
};
