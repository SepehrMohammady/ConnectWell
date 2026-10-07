// Service worker. Two jobs: make the app installable as a PWA, and receive
// background notifications (Web Push) while no ConnectWell window is open.
//
// It deliberately does NOT cache anything. The app serves html/css/js as
// no-cache on purpose (so a deploy is picked up immediately), and it streams
// media with HTTP Range requests — caching or proxying those here would
// reintroduce staleness and break seeking. So only top-level navigations are
// passed through to the network; every other request (assets, media, the API,
// the WebSocket) is left entirely to the browser.

// skipWaiting + clients.claim take over open tabs immediately. That is safe ONLY
// because nothing is cached, so there is no old/new asset skew. If a cache is
// ever added here, revisit this — a freshly-activated worker could then serve a
// mix of stale and fresh responses to already-open pages.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
    if (event.request.mode === 'navigate') {
        event.respondWith(fetch(event.request));
    }
    // Anything else: no respondWith → the browser handles it normally, including
    // Range requests for audio/video.
});

/* ---------------- background notifications ----------------
   The server renders every notification's text in the device's language; this
   only decides how to show it. Tags carry the meaning, and the Android app
   (apps/android) reads them too, so they are a contract — change them together:
     cw-conv-<conv>   messages in a conversation, merged into one notification
     cw-ring-<conv>   an incoming call, ringing
     cw-call-<conv>   how that call ended (replaces the ringing one)
   Every push leaves a notification on screen unless a window of the app is in
   front on this device. A push that showed nothing would be charged against the
   browser's small allowance of silent pushes, and when that runs out the browser
   puts up its own generic notice instead. */

const SCOPE = self.registration.scope;
const ICON = new URL('icon-192.png', SCOPE).href;
const BADGE = new URL('badge-96.png', SCOPE).href;
const UA = self.navigator.userAgent;
const MOBILE = /Android|iPhone|iPad|iPod/i.test(UA);
// Safari's push (every iOS browser uses it) revokes a subscription whose pushes
// show nothing — even while the app is open — so there, always show.
const WEBKIT = /AppleWebKit/i.test(UA) && !/Chrome|Chromium|Android/i.test(UA);

const asset = (path) => (path ? new URL(path, SCOPE).href : ICON);

async function appWindows() {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    return all.filter((c) => c.url.startsWith(SCOPE));
}

// A window of the app in front of the person on THIS device. It has already
// shown whatever the push is about. On a phone the visible window is the one in
// use; on a desktop it may be visible behind another program, so it must also
// have focus to count.
async function appInFront() {
    if (WEBKIT) return false;
    for (const c of await appWindows()) {
        if (c.visibilityState === 'visible' && (c.focused || MOBILE)) return true;
    }
    return false;
}

self.addEventListener('push', (event) => {
    let p = null;
    try { p = event.data ? event.data.json() : null; } catch { p = null; }
    event.waitUntil(onPush(p && typeof p === 'object' ? p : {}));
});

function onPush(p) {
    switch (p.kind) {
        case 'msg': return onMessage(p);
        case 'ring': return onRing(p);
        case 'ring-end': return onRingEnd(p);
        default: return onOther(p);
    }
}

async function onMessage(p) {
    if (await appInFront()) return;
    // A burst in one conversation becomes one notification listing the latest
    // lines, not a stack of them. Sorted by id because pushes can overtake.
    const tag = 'cw-conv-' + p.conv;
    const [prev] = await self.registration.getNotifications({ tag });
    const lines = ((prev && prev.data && prev.data.lines) || []).filter((l) => l.id !== p.msg);
    lines.push({ id: p.msg, text: String(p.line || '') });
    lines.sort((a, b) => a.id - b.id);
    const kept = lines.slice(-6);
    return self.registration.showNotification(p.title || 'ConnectWell', {
        tag, renotify: true,
        body: kept.map((l) => l.text).join('\n'),
        icon: asset(p.icon), badge: BADGE, timestamp: p.ts,
        data: { kind: 'msg', conv: p.conv, msg: p.msg, lines: kept },
    });
}

async function onRing(p) {
    // Arriving well after the ring ended (a phone that was offline throughout):
    // saying "missed" is the truth; ringing now would not be.
    if (p.until && Date.now() > p.until + 60_000) return showCallOutcome(p, p.missed || p.body);
    if (await appInFront()) return;   // the window rings by itself
    const actions = p.actions
        ? [{ action: 'answer', title: p.actions.answer }, { action: 'decline', title: p.actions.decline }]
        : [];
    return self.registration.showNotification(p.title || 'ConnectWell', {
        tag: 'cw-ring-' + p.conv, renotify: true, requireInteraction: true,
        body: p.body || '', icon: asset(p.icon), badge: BADGE, timestamp: p.ts,
        // Phones without a dedicated ringtone channel at least vibrate like a call.
        vibrate: [700, 300, 700, 300, 700, 300, 700, 300, 700],
        actions,
        data: { kind: 'ring', conv: p.conv, call: p.call, video: !!p.video },
    });
}

async function closeRing(conv) {
    for (const n of await self.registration.getNotifications({ tag: 'cw-ring-' + conv })) n.close();
}

async function onRingEnd(p) {
    // Closing the ringing notification is what stops a phone's ringtone.
    await closeRing(p.conv);
    if (await appInFront()) return;
    return showCallOutcome(p, p.body);
}

function showCallOutcome(p, body) {
    return self.registration.showNotification(p.title || 'ConnectWell', {
        tag: 'cw-call-' + p.conv, silent: true,
        body: body || '', icon: asset(p.icon), badge: BADGE, timestamp: p.ts,
        data: { kind: 'call', conv: p.conv },
    });
}

async function onOther(p) {
    if (p.kind !== 'test' && await appInFront()) return;
    const tag = p.kind === 'react' ? 'cw-react-' + p.msg
        : p.kind === 'delreq' ? 'cw-delreq-' + p.msg
            : p.kind === 'conv' ? 'cw-group-' + p.conv
                : 'cw-' + String(p.kind || 'note').replace(/[^a-z]/g, '');
    return self.registration.showNotification(p.title || 'ConnectWell', {
        tag, body: p.body || '', icon: asset(p.icon), badge: BADGE, timestamp: p.ts,
        data: { kind: p.kind, conv: p.conv, msg: p.msg },
    });
}

/* ---------------- tapping a notification ---------------- */

self.addEventListener('notificationclick', (event) => {
    const n = event.notification;
    const d = n.data || {};
    n.close();
    if (d.kind === 'ring' && event.action === 'decline') {
        event.waitUntil(declineCall(d));
        return;
    }
    const intent = {};
    if (d.conv) intent.conv = d.conv;
    if (d.kind === 'react' || d.kind === 'delreq') intent.msg = d.msg;
    if (d.kind === 'ring') {
        intent.call = d.call;
        if (event.action === 'answer') intent.answer = '1';
    }
    if (d.kind === 'admin') intent.admin = '1';
    event.waitUntil(openApp(intent));
});

// An open window is focused and told where to go, which keeps a running call
// and everything already loaded. Only with no window is a new one opened, at a
// URL whose fragment the app reads on start.
async function openApp(intent) {
    const wins = await appWindows();
    const win = wins.find((c) => c.focused) || wins.find((c) => c.visibilityState === 'visible') || wins[0];
    if (win) {
        try {
            await win.focus();
            win.postMessage({ type: 'cw-open', ...intent });
            return;
        } catch { /* not allowed to focus it: open a fresh window instead */ }
    }
    const hash = new URLSearchParams(intent).toString();
    return self.clients.openWindow(SCOPE + (hash ? '#' + hash : ''));
}

// Declining needs no window: the server is told directly. The endpoint says
// which device declined, so this one is not told about it a second time.
async function declineCall(d) {
    let endpoint = null;
    try { endpoint = (await self.registration.pushManager.getSubscription())?.endpoint || null; } catch { }
    try {
        await fetch(new URL('api/calls/' + encodeURIComponent(d.call) + '/decline', SCOPE), {
            method: 'POST', credentials: 'same-origin',
            headers: { 'X-Requested-With': 'ConnectWell', 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint }),
        });
    } catch { /* offline: the caller's ring simply runs out */ }
}

/* ---------------- a subscription replaced by the browser ----------------
   Rare (Firefox does it), and the page re-registers on every start anyway; this
   just closes the gap until the app is next opened. */

self.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil(resubscribe(event));
});

function keyBytes(b64) {
    const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function resubscribe(event) {
    try {
        const old = event.oldSubscription || null;
        let sub = event.newSubscription || null;
        if (!sub) {
            let key = old && old.options && old.options.applicationServerKey;
            if (!key) {
                const r = await fetch(new URL('api/push/key', SCOPE), { credentials: 'same-origin' });
                const k = r.ok ? (await r.json()).key : null;
                if (!k) return;
                key = keyBytes(k);
            }
            sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        }
        await fetch(new URL('api/push/subscribe', SCOPE), {
            method: 'POST', credentials: 'same-origin',
            headers: { 'X-Requested-With': 'ConnectWell', 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: sub.toJSON(), replaces: old ? old.endpoint : null }),
        });
    } catch { /* the next start of the app registers again */ }
}
