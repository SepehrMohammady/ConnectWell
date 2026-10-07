'use strict';
// Background notifications: who is told about what, in which language, on which
// of their devices. Delivered as Web Push so they arrive while ConnectWell is
// closed; lib/webpush.js does the protocol, this decides the policy.
//
// The rules, in one place:
//   - a message, reaction, delete request or new group notifies the people it
//     concerns, except anyone actively using the app right now — an open,
//     focused window already shows it, and a phone buzzing in your pocket for
//     the chat you are typing into is exactly the noise this avoids;
//   - a call rings the same way, and every device that rang is later told how
//     it ended (answered elsewhere, declined, missed). That message both stops
//     a ringing phone and leaves something true on screen; a push that left
//     nothing on screen would cost the browser's small silent-push allowance;
//   - nothing goes to an account that is not active, about a conversation it is
//     no longer in, or to a device whose session has ended (the table cascades
//     from sessions).
//
// Must not require ws.js at load: ws.js requires this module. The one thing it
// needs from there — whether somebody is active — is looked up at call time.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const config = require('./config');
const DB = require('./db');
const webpush = require('./webpush');

const ws = () => require('./ws');
const DAY = 86400;

/* ---------------- server key pair ----------------
   Generated once into DATA_DIR and never replaced: browsers bind a subscription
   to the public key they were given, so a new pair would silently orphan every
   device until each one happened to open the app again. */

const KEY_FILE = path.join(config.DATA_DIR, 'push-vapid.json');

function loadKeys() {
    if (!config.PUSH_ENABLED) return null;
    try {
        if (config.VAPID_PUBLIC_KEY || config.VAPID_PRIVATE_KEY) {
            return webpush.loadVapidKeys({
                publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY,
            });
        }
        let pair;
        try {
            pair = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
        } catch (err) {
            // Only a MISSING file earns a new pair. An unreadable or corrupt one
            // is a problem to report, never a reason to overwrite the keys.
            if (err.code !== 'ENOENT') throw err;
            pair = webpush.generateVapidKeys();
            fs.writeFileSync(KEY_FILE,
                JSON.stringify({ ...pair, created: new Date().toISOString() }, null, 2) + '\n',
                { mode: 0o600, flag: 'wx' });
            console.log('push: generated this server\'s key pair in ' + KEY_FILE);
        }
        return webpush.loadVapidKeys(pair);
    } catch (err) {
        console.error('push: background notifications are OFF — ' + err.message);
        return null;
    }
}

const keys = loadKeys();
const SUBJECT = config.VAPID_SUBJECT
    || (/^https:\/\//.test(config.PUBLIC_ORIGIN) ? config.PUBLIC_ORIGIN : 'mailto:admin@localhost');

/* ---------------- language ----------------
   Notification text is rendered here, per device, in the language that device
   asked for: the service worker that displays it has no dictionary, and the
   page that does may not be open. These are the app's own dictionaries, so a
   notification never says something the interface does not. */

const DICTS = {};
const LANGS = new Set(['en', 'fa']);
// public/js/i18n carries its own package.json declaring ES modules, so Node
// loads these without guessing at their format.
const dictsReady = Promise.all([...LANGS].map(async (code) => {
    try {
        const file = path.join(config.ROOT, 'public', 'js', 'i18n', code + '.js');
        DICTS[code] = (await import(pathToFileURL(file).href)).default || {};
    } catch (err) {
        console.error(`push: could not load the ${code} dictionary — ${err.message}`);
    }
}));

// The client's t(), minus the DOM: chosen language, then English, then the key.
function tr(lang, key, vars) {
    const dict = DICTS[lang] || {};
    const en = DICTS.en || {};
    let k = key;
    if (vars && typeof vars.n === 'number') {
        const suffixed = k + (vars.n === 1 ? '_one' : '_other');
        if (typeof dict[suffixed] === 'string' || typeof en[suffixed] === 'string') k = suffixed;
    }
    const raw = typeof dict[k] === 'string' ? dict[k] : (typeof en[k] === 'string' ? en[k] : key);
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (m, name) => (
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m
    ));
}

// Code-point safe, so a clipped emoji never becomes half a surrogate pair.
function clip(text, max) {
    const chars = Array.from(String(text || '').replace(/\s+/g, ' ').trim());
    return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}

const displayName = (lang, id) => DB.stmts.userById.get(id)?.display_name || tr(lang, 'core.user.fallback');
const groupName = (lang, conv) => conv.name || tr(lang, 'core.conv.group_fallback');

// Relative to the app's own scope, which is where the service worker resolves
// it. Only ever an active account's photo, as the avatar route itself enforces.
function userIcon(user) {
    return user && user.avatar && user.status === 'active' ? `api/avatars/u${user.id}/${user.avatar}` : null;
}

// What a message is, in one line — the sidebar preview's rules, so the
// notification and the conversation list never describe it differently.
function describe(lang, m) {
    const label = () => {
        switch (m.type) {
            case 'image': return tr(lang, 'app.preview.image');
            case 'video': return tr(lang, 'app.preview.video');
            case 'videomsg': return tr(lang, 'app.preview.videomsg');
            case 'audio': return tr(lang, 'app.preview.audio');
            case 'voice': return tr(lang, 'app.preview.voice');
            default: return tr(lang, 'app.preview.file', { name: m.fileName || tr(lang, 'app.preview.fileFallback') });
        }
    };
    if (m.type === 'text') return clip(m.content, 400);
    if (m.content) return tr(lang, 'app.preview.withCaption', { label: label(), caption: clip(m.content, 300) });
    return label();
}

/* ---------------- subscriptions ---------------- */

const stmts = {
    forUser: DB.db.prepare('SELECT * FROM push_subs WHERE user_id = ? ORDER BY id'),
    byEndpoint: DB.db.prepare('SELECT * FROM push_subs WHERE endpoint = ?'),
    // A browser that changes hands (sign out, someone else signs in) brings the
    // same endpoint back under a new owner: the row follows the newest sign-in.
    upsert: DB.db.prepare(
        'INSERT INTO push_subs (user_id, session_id, endpoint, p256dh, auth, device, lang, created_at) '
        + 'VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET '
        + 'user_id = excluded.user_id, session_id = excluded.session_id, p256dh = excluded.p256dh, '
        + 'auth = excluded.auth, device = excluded.device, lang = excluded.lang, failures = 0'),
    remove: DB.db.prepare('DELETE FROM push_subs WHERE id = ?'),
    removeMine: DB.db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?'),
    ok: DB.db.prepare('UPDATE push_subs SET last_ok_at = ?, failures = 0 WHERE id = ?'),
    failed: DB.db.prepare('UPDATE push_subs SET failures = failures + 1 WHERE id = ? RETURNING failures, last_ok_at'),
    count: DB.db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?'),
    oldest: DB.db.prepare(
        'SELECT id FROM push_subs WHERE user_id = ? AND endpoint != ? '
        + 'ORDER BY COALESCE(last_ok_at, created_at) ASC LIMIT ?'),
    admins: DB.db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'"),
};

// A person's devices, bounded: a browser that is reinstalled over and over must
// not leave an ever-growing fan-out behind it.
const MAX_PER_USER = 10;

// "host" means that host on the default port; "host:port" names a port too.
function allowedEndpoint(endpoint) {
    if (typeof endpoint !== 'string' || endpoint.length > 1024) return false;
    let u;
    try { u = new URL(endpoint); } catch { return false; }
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    return config.PUSH_HOSTS.some((entry) => {
        if (entry === '*') return true;
        const [h, port] = entry.split(':');
        if ((port || '') !== (u.port || '')) return false;
        return host === h || host.endsWith('.' + h);
    });
}

const validKey = (s, len) => typeof s === 'string' && s.length < 200
    && /^[A-Za-z0-9_-]+=*$/.test(s) && webpush.unb64u(s).length === len;

// `replaces` is the endpoint a browser has just swapped out for this one (the
// service worker reports it, and has no access to the page's device id or
// language — so they carry over from the row being replaced).
function subscribe({ userId, sessionId, subscription, device, lang, replaces }) {
    if (!keys) return { code: 503, error: 'Background notifications are switched off on this server' };
    const endpoint = subscription?.endpoint;
    const p256dh = subscription?.keys?.p256dh;
    const auth = subscription?.keys?.auth;
    if (!allowedEndpoint(endpoint)) return { code: 400, error: 'This push service is not accepted here' };
    if (!validKey(p256dh, 65) || webpush.unb64u(p256dh)[0] !== 0x04 || !validKey(auth, 16)) {
        return { code: 400, error: 'Malformed subscription' };
    }
    const old = typeof replaces === 'string' && replaces !== endpoint ? stmts.byEndpoint.get(replaces) : null;
    const prior = old && old.user_id === userId ? old : null;
    let dev = typeof device === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(device) ? device : null;
    let lng = LANGS.has(lang) ? lang : null;
    if (prior) { dev = dev || prior.device; lng = lng || prior.lang; }
    stmts.upsert.run(userId, sessionId, endpoint, p256dh, auth, dev, lng || 'en', Date.now());
    if (prior) stmts.remove.run(prior.id);
    const n = stmts.count.get(userId).n;
    if (n > MAX_PER_USER) {
        for (const r of stmts.oldest.all(userId, endpoint, n - MAX_PER_USER)) stmts.remove.run(r.id);
    }
    return { ok: true };
}

function unsubscribe(userId, endpoint) {
    if (typeof endpoint === 'string') stmts.removeMine.run(endpoint, userId);
}

const ownsEndpoint = (userId, endpoint) => {
    const row = typeof endpoint === 'string' ? stmts.byEndpoint.get(endpoint) : null;
    return !!row && row.user_id === userId;
};

/* ---------------- delivery ----------------
   Fire-and-forget behind a small concurrency cap: the request that triggered a
   notification never waits on a push service, and a burst (a busy group) cannot
   open hundreds of sockets at once. */

const MAX_IN_FLIGHT = 8;
const MAX_QUEUE = 5000;
const queue = [];
let inFlight = 0;

function enqueue(job) {
    if (queue.length >= MAX_QUEUE) {
        console.error('push: queue full, dropping a notification');
        return;
    }
    queue.push(job);
    pump();
}

function pump() {
    while (inFlight < MAX_IN_FLIGHT && queue.length) {
        const job = queue.shift();
        inFlight++;
        deliver(job).finally(() => { inFlight--; pump(); });
    }
}

async function deliver({ sub, build, opts }) {
    let result;
    try {
        await dictsReady;
        result = await webpush.send(sub, build(sub.lang), { keys, subject: SUBJECT, ...opts });
    } catch (err) {
        noteFailure(sub, err.name === 'TimeoutError' ? 'timed out' : err.message);
        return;
    }
    const { status } = result;
    if (status >= 200 && status < 300) {
        stmts.ok.run(Date.now(), sub.id);
    } else if (status === 404 || status === 410) {
        // The browser unsubscribed, or the push service expired the endpoint.
        // Definitive: the next visit to the app registers a fresh one.
        stmts.remove.run(sub.id);
    } else {
        noteFailure(sub, `HTTP ${status} ${result.text}`.trim());
    }
}

// Transient trouble is retried simply by the next notification. A subscription
// that has failed persistently and not worked for a week is let go — usually an
// uninstalled app whose push service answers with something other than 410.
function noteFailure(sub, why) {
    const row = stmts.failed.get(sub.id);
    if (!row) return;                         // already removed
    if (row.failures === 1 || row.failures % 20 === 0) {
        console.warn(`push: delivery to subscription ${sub.id} failed (${row.failures}x): ${why}`);
    }
    const stale = !row.last_ok_at || Date.now() - row.last_ok_at > 7 * DAY * 1000;
    if (row.failures >= 10 && stale) stmts.remove.run(sub.id);
}

// Queues a notification to each of a user's devices, optionally restricted to
// `only` (subscription ids) and skipping the device or endpoint in `except`.
// Returns the subscription ids it queued for, which is what lets a call later
// tell exactly the devices it rang how it ended.
function deliverToUser(userId, build, opts, { only = null, except = {} } = {}) {
    if (!keys) return [];
    const user = DB.stmts.userById.get(userId);
    if (!user || user.status !== 'active') return [];
    const ids = [];
    for (const sub of stmts.forUser.all(userId)) {
        if (only && !only.has(sub.id)) continue;
        if (except.device && sub.device === except.device) continue;
        if (except.endpoint && sub.endpoint === except.endpoint) continue;
        enqueue({ sub, build, opts });
        ids.push(sub.id);
    }
    return ids;
}

const isActive = (userId) => ws().isUserActive(userId);

/* ---------------- what gets notified ---------------- */

function onMessage(m) {
    if (!keys || !m || m.type === 'system') return;
    const conv = DB.stmts.convById.get(m.conversationId);
    if (!conv) return;
    const sender = DB.stmts.userById.get(m.senderId);
    const icon = conv.type === 'group' && conv.avatar ? `api/avatars/c${conv.id}/${conv.avatar}` : userIcon(sender);
    for (const row of DB.stmts.convMembers.all(conv.id)) {
        if (row.user_id === m.senderId || isActive(row.user_id)) continue;
        deliverToUser(row.user_id, (lang) => ({
            kind: 'msg', conv: conv.id, msg: m.id, ts: m.createdAt, icon,
            title: conv.type === 'group' ? groupName(lang, conv) : displayName(lang, m.senderId),
            // In a group the speaker has to be named; in a direct chat the title
            // already is the speaker.
            line: (conv.type === 'group' ? tr(lang, 'app.preview.prefixName', { name: displayName(lang, m.senderId) }) : '')
                + describe(lang, m),
        }), { urgency: 'high', ttl: DAY });
    }
}

// `m` is the raw database row of the message reacted to.
function onReaction(m, actorId, emoji) {
    if (!keys || isActive(m.sender_id)) return;
    const actor = DB.stmts.userById.get(actorId);
    const what = { type: m.type, content: m.content, fileName: m.file_name };
    deliverToUser(m.sender_id, (lang) => ({
        kind: 'react', conv: m.conversation_id, msg: m.id, ts: Date.now(), icon: userIcon(actor),
        title: displayName(lang, actorId),
        body: tr(lang, 'activity.react', { emoji }) + '\n' + clip(describe(lang, what), 120),
    }), { urgency: 'normal', ttl: DAY });
}

function onUserPending(user) {
    if (!keys) return;
    for (const { id } of stmts.admins.all()) {
        if (isActive(id)) continue;
        deliverToUser(id, (lang) => ({
            kind: 'admin', ts: Date.now(),
            title: tr(lang, 'app.admin.title'),
            body: tr(lang, 'app.toast.userPending', { name: user.display_name }),
        }), { urgency: 'normal', ttl: 7 * DAY });
    }
}

function onDeleteRequest(request, approverIds) {
    if (!keys) return;
    const requester = DB.stmts.userById.get(request.requested_by);
    for (const uid of approverIds) {
        if (isActive(uid)) continue;
        deliverToUser(uid, (lang) => ({
            kind: 'delreq', conv: request.conversation_id, msg: request.message_id, ts: Date.now(),
            icon: userIcon(requester),
            title: displayName(lang, request.requested_by),
            body: tr(lang, 'push.delreq'),
        }), { urgency: 'normal', ttl: 7 * DAY });
    }
}

// Being put in a group is worth knowing about before its first message arrives.
function onAddedToGroup(conv, actor, userIds, created) {
    if (!keys) return;
    for (const uid of userIds) {
        if (uid === actor.id || isActive(uid)) continue;
        const target = DB.stmts.userById.get(uid);
        deliverToUser(uid, (lang) => ({
            kind: 'conv', conv: conv.id, ts: Date.now(), icon: userIcon(actor),
            title: groupName(lang, conv),
            body: created
                ? tr(lang, 'sys.group_created', { name: actor.display_name })
                : tr(lang, 'sys.member_added', { actor: actor.display_name, target: target?.display_name || '' }),
        }), { urgency: 'normal', ttl: DAY });
    }
}

/* ---------------- calls ----------------
   One topic per conversation's call: if a phone was unreachable for the whole
   ring, the push service holds only the newest message for it, so it wakes to
   "missed call" instead of starting to ring for a call long over. */

const RING_MS = Math.max(5, config.CALL_RING_SECONDS) * 1000;

function ringText(lang, call) {
    const conv = DB.stmts.convById.get(call.convId);
    const video = call.kind === 'video';
    return conv && conv.type === 'group'
        ? tr(lang, video ? 'call.ring_sub_video_group' : 'call.ring_sub_voice_group', { title: groupName(lang, conv) })
        : tr(lang, video ? 'call.ring_sub_video' : 'call.ring_sub_voice');
}

// Rings one callee's devices; returns the subscription ids that were rung.
function ring(call, userId) {
    const left = call.startedAt + RING_MS - Date.now();
    if (!keys || left < 3000) return [];
    const caller = DB.stmts.userById.get(call.startedBy);
    return deliverToUser(userId, (lang) => ({
        kind: 'ring', conv: call.convId, call: call.id, video: call.kind === 'video',
        ts: call.startedAt, until: call.startedAt + RING_MS, icon: userIcon(caller),
        title: displayName(lang, call.startedBy),
        body: ringText(lang, call),
        // For a device that only receives this after the ring is over.
        missed: tr(lang, call.kind === 'video' ? 'activity.missed_video' : 'activity.missed_voice'),
        actions: { answer: tr(lang, 'ui.ring.accept'), decline: tr(lang, 'ui.ring.decline') },
    }), { urgency: 'high', ttl: Math.ceil(left / 1000), topic: 'call' + call.convId });
}

// Tells exactly the devices that rang (`subIds`) how the ring ended.
function ringEnded(call, userId, subIds, reason, except = {}) {
    if (!keys || !subIds || !subIds.size) return;
    const caller = DB.stmts.userById.get(call.startedBy);
    const video = call.kind === 'video';
    deliverToUser(userId, (lang) => ({
        kind: 'ring-end', conv: call.convId, call: call.id, video, reason, ts: Date.now(),
        icon: userIcon(caller),
        title: displayName(lang, call.startedBy),
        body: reason === 'answered' ? tr(lang, 'push.answered_elsewhere')
            : reason === 'declined' ? tr(lang, 'push.declined_elsewhere')
                : reason === 'missed' ? tr(lang, video ? 'activity.missed_video' : 'activity.missed_voice')
                    : tr(lang, 'call.ended'),
    }), { urgency: 'high', ttl: DAY, topic: 'call' + call.convId }, { only: subIds, except });
}

function sendTest(userId, endpoint) {
    const sub = typeof endpoint === 'string' ? stmts.byEndpoint.get(endpoint) : null;
    if (!keys || !sub || sub.user_id !== userId) return false;
    deliverToUser(userId, (lang) => ({
        kind: 'test', ts: Date.now(), title: 'ConnectWell', body: tr(lang, 'push.test'),
    }), { urgency: 'high', ttl: 600 }, { only: new Set([sub.id]) });
    return true;
}

module.exports = {
    publicKey: () => (keys ? keys.publicKey : null),
    subscribe, unsubscribe, ownsEndpoint, sendTest,
    onMessage, onReaction, onUserPending, onDeleteRequest, onAddedToGroup,
    ring, ringEnded, RING_MS,
    // for tests
    _tr: tr, _dictsReady: dictsReady, _allowedEndpoint: allowedEndpoint,
};
