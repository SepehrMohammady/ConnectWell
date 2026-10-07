// Notifications on this device: asking for permission, registering for
// background delivery (Web Push), showing notifications while only the page
// knows about something, telling the server whether anybody is looking, and
// acting on a notification that was tapped.
//
// Who shows a given notification, so that nothing is said twice:
//   - this device registered for background delivery -> the server pushes it
//     whenever the person is not active anywhere, and the page stays quiet;
//   - the Windows app (window.cwDesktop, from apps/desktop) -> the page hands it
//     to the app, which shows a native notification from the tray;
//   - neither (push unavailable, refused, or failed) -> the page shows it
//     itself, which works only while a window of the app is open.

import { api } from './api.js';
import { $, h, net, toast } from './core.js';
import { t } from './i18n.js';

const desktop = () => window.cwDesktop || null;

/* ---------------- the service worker ---------------- */

let workerReg = null;

// Registered once, early: it is also what makes the app installable.
export function registerWorker() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    if (!workerReg) workerReg = navigator.serviceWorker.register('sw.js').catch(() => null);
    return workerReg;
}

// `ready` never settles if registration failed, so it is raced against a clock.
async function worker(ms = 10_000) {
    if (!(await registerWorker())) return null;
    return Promise.race([
        navigator.serviceWorker.ready,
        new Promise((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
}

/* ---------------- this device ---------------- */

// Links this device's push registration to its live connections, so the server
// can spare the device that answered a call the news that it was answered.
const DEVICE_KEY = 'cw_device';
let volatileDevice = null;

function deviceId() {
    try {
        let id = localStorage.getItem(DEVICE_KEY);
        if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
            id = crypto.randomUUID();
            localStorage.setItem(DEVICE_KEY, id);
        }
        return id;
    } catch {
        // Private mode: stable for this page at least.
        if (!volatileDevice) volatileDevice = 'p' + Math.random().toString(36).slice(2, 14);
        return volatileDevice;
    }
}

/* ---------------- background delivery ---------------- */

let pushKey = null;      // the server's key, from bootstrap; null = switched off there
let pushOn = false;      // this device is registered and the server knows it

export function setPushKey(key) { pushKey = typeof key === 'string' && key ? key : null; }

function pushSupported() {
    return !desktop() && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function keyBytes(b64) {
    const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function sameKey(buf, b64) {
    const a = new Uint8Array(buf);
    const b = keyBytes(b64);
    return a.length === b.length && a.every((x, i) => x === b[i]);
}

// Brings this device in line with the server: subscribed under the server's
// current key and registered against this session. Cheap enough to run on every
// start, which is also what repairs a registration the server dropped.
export async function syncPush() {
    pushOn = false;
    if (!pushSupported() || !pushKey || Notification.permission !== 'granted') return false;
    try {
        const reg = await worker();
        if (!reg) return false;
        let sub = await reg.pushManager.getSubscription();
        // Subscribed under a key the server no longer holds: it would be refused.
        // A browser that does not expose the key is given the benefit of the doubt.
        const held = sub && sub.options && sub.options.applicationServerKey;
        if (held && !sameKey(held, pushKey)) {
            await sub.unsubscribe().catch(() => { });
            sub = null;
        }
        if (!sub) {
            sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(pushKey) });
        }
        try {
            await api('api/push/subscribe', {
                method: 'POST',
                body: { subscription: sub.toJSON(), device: deviceId(), lang: (window.cwLang && window.cwLang.code) || 'en' },
            });
        } catch (e) {
            // Rate-limited means this device registered moments ago (a burst of
            // reloads); anything else means the server does not have it.
            if (e.status !== 429) throw e;
        }
        pushOn = true;
    } catch {
        // Refused by the browser (Brave without Google push, private windows,
        // an embedded browser) or by the server. The page keeps notifying while
        // it is open; there is nothing better to fall back to.
        pushOn = false;
    }
    return pushOn;
}

// From a click, so the permission prompt is allowed to appear. Resolves to what
// the person now has: 'on', 'local' (allowed, but only while the app is open),
// 'denied', 'default' (dismissed) or 'unsupported'.
export async function enableNotifications() {
    if (desktop()) return 'on';
    if (!('Notification' in window)) return 'unsupported';
    let perm = Notification.permission;
    if (perm === 'default') {
        try { perm = await Notification.requestPermission(); } catch { /* dismissed */ }
    }
    if (perm !== 'granted') return perm;
    return (await syncPush()) ? 'on' : 'local';
}

export const isDesktopApp = () => !!desktop();

export function notificationState() {
    if (desktop()) return 'on';
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission !== 'granted') return Notification.permission;
    return pushOn ? 'on' : 'local';
}

// Signing out: this device stops receiving the account's notifications, and the
// ones already on screen go with it. The server drops the registration with the
// session regardless; this also tells the browser to forget it.
export async function forgetDevice() {
    try {
        const reg = await worker(3000);
        if (!reg) return;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
            await api('api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => { });
            await sub.unsubscribe().catch(() => { });
        }
        for (const n of await reg.getNotifications()) n.close();
    } catch { /* signing out goes ahead regardless */ }
}

// The whole path at once: this server, the push service and the device.
export async function sendTest() {
    const d = desktop();
    if (d) { d.notify({ kind: 'test', tag: 'cw-test', title: 'ConnectWell', body: t('push.test') }); return; }
    if (pushOn) {
        const reg = await worker();
        const sub = reg && await reg.pushManager.getSubscription();
        if (sub) { await api('api/push/test', { method: 'POST', body: { endpoint: sub.endpoint } }); return; }
    }
    await showHere('ConnectWell', t('push.test'), { tag: 'cw-test', data: { kind: 'test' } });
}

/* ---------------- notifications the page shows itself ---------------- */

async function showHere(title, body, { tag, sticky = false, labels = null, data = {} } = {}) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    // Through the worker where there is one: Android refuses `new Notification`
    // outright, and a click then arrives through the same path as a push's —
    // including Accept and Decline on a call.
    const reg = await worker(2000);
    if (reg) {
        await reg.showNotification(title, {
            body, tag, requireInteraction: sticky,
            icon: 'icon-192.png', badge: 'badge-96.png', data,
            actions: labels
                ? [{ action: 'answer', title: labels.answer }, { action: 'decline', title: labels.decline }]
                : [],
        }).catch(() => { });
        return;
    }
    try {
        const n = new Notification(title, { body, tag, icon: 'icon-192.png', requireInteraction: sticky });
        n.onclick = () => {
            try { window.focus(); } catch { /* some platforms refuse */ }
            handleIntent(intentFromData(data));
            n.close();
        };
    } catch { /* not allowed here */ }
}

// Called for everything the page learns about over its socket. Whether it is
// shown — and by whom — follows the rules at the top of this file. `intent` is
// where a tap should lead; `labels` names a call's Accept and Decline buttons.
// Returns true when the Windows app took it, which for a call means Windows is
// already playing the ring.
export function notifyLocal({ kind, tag, title, body, sticky = false, intent = {}, labels = null }) {
    const d = desktop();
    if (d) {
        if (isActiveNow()) return false;
        d.notify({ kind, tag, title, body, sticky, labels, ...intent });
        return true;
    }
    if (pushOn || isActiveNow()) return false;
    showHere(title, body, { tag, sticky, labels, data: { kind, ...intent } });
    return false;
}

export async function closeNotifications(tag) {
    const d = desktop();
    if (d) { d.close(tag); return; }
    const reg = await worker(2000);
    if (!reg) return;
    try { for (const n of await reg.getNotifications({ tag })) n.close(); } catch { /* none */ }
}

// The unread total, wherever this platform shows one: the Windows app's taskbar
// and tray, or an installed web app's icon badge. Called on every render of
// the conversation list, so only a change is passed on.
let shownUnread = -1;
export function setUnread(n) {
    if (n === shownUnread) return;
    shownUnread = n;
    const d = desktop();
    if (d && d.setUnread) d.setUnread(n);
    if ('setAppBadge' in navigator) {
        (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => { });
    }
}

/* ---------------- is anybody looking? ----------------
   Visible, focused and touched within the last few minutes. Reported to the
   server, which holds background notifications for whoever is active; the claim
   lapses there unless renewed, so it is repeated while it holds. */

const IDLE_MS = 5 * 60_000;
const RENEW_MS = 30_000;
let lastInput = Date.now();
let reported = null;

function isActiveNow() {
    return document.visibilityState === 'visible' && document.hasFocus()
        && Date.now() - lastInput < IDLE_MS;
}

export function reportActivity(force = false) {
    const active = isActiveNow();
    // An active claim is always re-sent (it expires); an inactive one only when
    // it is news.
    if (force || active || active !== reported) {
        net.send('active', { active, device: deviceId() });
        reported = active;
    }
}

function touched() {
    const was = isActiveNow();
    lastInput = Date.now();
    if (!was && isActiveNow()) reportActivity(true);
}

let activityStarted = false;
export function startActivityReporting() {
    if (activityStarted) return;
    activityStarted = true;
    for (const evt of ['pointerdown', 'keydown', 'touchstart', 'wheel']) {
        window.addEventListener(evt, touched, { capture: true, passive: true });
    }
    // Moving the mouse counts, but at most every few seconds.
    window.addEventListener('mousemove', () => { if (Date.now() - lastInput > 5000) touched(); }, { passive: true });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') lastInput = Date.now();
        reportActivity(true);
    });
    window.addEventListener('focus', () => { lastInput = Date.now(); reportActivity(true); });
    window.addEventListener('blur', () => reportActivity(true));
    window.addEventListener('pagehide', () => net.send('active', { active: false, device: deviceId() }));
    setInterval(() => reportActivity(false), RENEW_MS);
}

/* ---------------- where a tapped notification leads ----------------
   It can arrive three ways: in the URL fragment of a freshly opened window, as a
   message from the service worker to a window already open, or through the
   launch queue when an installed app is reopened. All three end up here, and
   wait until the app is signed in and connected — answering a call needs the
   socket. */

let intentHandler = null;
let intentsOpen = false;
let pendingIntent = null;

function intentFromData(d) {
    if (!d) return null;
    const num = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
    const intent = {
        conv: num(d.conv), msg: num(d.msg),
        call: typeof d.call === 'string' && d.call ? d.call : null,
        answer: d.answer === true || d.answer === '1',
        // Only ever from the Windows app's call toast, which has no page of its
        // own to decline from. Never read from a URL.
        decline: d.decline === true,
        admin: d.admin === true || d.admin === '1',
    };
    return intent.conv || intent.admin ? intent : null;
}

function intentFromHash(hash) {
    const q = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    return intentFromData(Object.fromEntries(q.entries()));
}

function handleIntent(intent) {
    if (!intent) return;
    pendingIntent = intent;
    if (intentsOpen && intentHandler) {
        const run = pendingIntent;
        pendingIntent = null;
        intentHandler(run);
    }
}

// The app calls this once it is signed in, has its data and its socket.
export function openIntents(handler) {
    intentHandler = handler;
    intentsOpen = true;
    handleIntent(pendingIntent);
}

// Wired before sign-in, so a tap that opened the app is not lost to the login.
export function initNotify() {
    const fromUrl = intentFromHash(location.hash);
    if (fromUrl) {
        pendingIntent = fromUrl;
        history.replaceState(null, '', location.pathname + location.search);
    }
    // An open window sent to its own address with a new fragment does not
    // reload — a browser without the launch queue reopening the app does this.
    window.addEventListener('hashchange', () => {
        const intent = intentFromHash(location.hash);
        if (!intent) return;
        history.replaceState(null, '', location.pathname + location.search);
        handleIntent(intent);
    });
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (e) => {
            if (e.data && e.data.type === 'cw-open') handleIntent(intentFromData(e.data));
        });
        // Messages wait in a queue until this is called.
        navigator.serviceWorker.startMessages();
    }
    if ('launchQueue' in window) {
        window.launchQueue.setConsumer((params) => {
            if (!params || !params.targetURL) return;
            try { handleIntent(intentFromHash(new URL(params.targetURL).hash)); } catch { /* malformed */ }
        });
    }
    const d = desktop();
    if (d && d.onOpen) d.onOpen((data) => handleIntent(intentFromData(data)));
}

/* ---------------- asking ----------------
   A slim bar above the app, not a prompt on load: the browser's own permission
   dialog only appears from a click, and a click on a bar that says why is the
   one people actually say yes to. "Not now" holds it back for a month. */

const OFFER_KEY = 'cw_notif_offer';
const OFFER_PAUSE_MS = 30 * 86400_000;

function offerSnoozed() {
    try { return Date.now() < Number(localStorage.getItem(OFFER_KEY) || 0); } catch { return false; }
}

export function offerNotifications() {
    const bar = $('notif-bar');
    if (!bar) return;
    const wanted = pushSupported() && pushKey && Notification.permission === 'default' && !offerSnoozed();
    bar.hidden = !wanted;
    if (!wanted) return;
    bar.textContent = '';
    bar.append(
        h('span', { class: 'notif-text', text: t('app.notif.banner') }),
        h('button', {
            class: 'btn small', type: 'button', text: t('app.notif.enable'),
            onclick: async () => {
                const state = await enableNotifications();
                bar.hidden = true;
                if (state === 'local') toast(t('app.notif.pushFailed'), 6000);
            },
        }),
        h('button', {
            class: 'btn small ghost', type: 'button', text: t('app.notif.later'),
            onclick: () => {
                try { localStorage.setItem(OFFER_KEY, String(Date.now() + OFFER_PAUSE_MS)); } catch { }
                bar.hidden = true;
            },
        }),
    );
}

