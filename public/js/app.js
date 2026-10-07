// App orchestrator: boot, auth, WebSocket, sidebar, modals, admin panel.

import { api, postBytes } from './api.js';
import { makeAvatar } from './avatar.js';
import {
    S, $, h, bus, net, toast, popSound, ringStop, avatarEl, userName, convTitle, convOther,
    fmtListTime, fmtSize, userAvatar, convAvatarSrc, closeControl,
} from './core.js';
import {
    initChat, openConv, closeConv, renderHeader, onMsgNew, onMsgDeleted, onTyping, markRead, reconcileActive,
    sysText, onMsgReaction, onRead, onMsgEdited, onDelReq, primeDelReqs, saveDraft, clearDrafts,
    jumpToMessage,
} from './chat.js';
import {
    initCalls, onCallState, onCallRing, onCallDeclined, onCallEnded, onRtc, updateChip, joinCall,
} from './calls.js';
import { t, applyStatic } from './i18n.js';
import { ecoOn, setEco } from './eco.js';
import { BACKGROUNDS, chatBg, setChatBg } from './bg.js';
import {
    initNotify, registerWorker, setPushKey, syncPush, enableNotifications, notificationState,
    isDesktopApp, forgetDevice, sendTest, notifyLocal, closeNotifications, setUnread,
    reportActivity, startActivityReporting, openIntents, offerNotifications,
} from './notify.js';

// A table of literal keys rather than 'app.bg.' + name: the i18n check scans the
// source for string literals, and a key assembled at runtime is invisible to it.
// Same reason THEME_TITLE_KEY below is written out in full.
const BG_LABEL_KEY = {
    plain: 'app.bg.plain', slate: 'app.bg.slate', ocean: 'app.bg.ocean',
    forest: 'app.bg.forest', sand: 'app.bg.sand', dots: 'app.bg.dots',
    grid: 'app.bg.grid', weave: 'app.bg.weave', stripe: 'app.bg.stripe',
};

let ws = null;
let wsBackoff = 1000;
let authed = false;
let booted = false;
let pendingPoll = null;

/* ---------------- views ---------------- */

function show(viewId) {
    for (const id of ['view-auth', 'view-pending', 'view-app']) $(id).hidden = id !== viewId;
}

/* ---------------- boot ---------------- */

async function boot() {
    try {
        const { user } = await api('api/me');
        if (user.status === 'pending') return showPending();
        await enterApp();
    } catch {
        show('view-auth');
    }
}

// The version comes from the server (package.json) so the badge can never drift
// from the build that is actually deployed. Year is rendered client-side.
async function initFooter() {
    let version = '';
    let brand = 'ConnectWell';
    try {
        const health = await api('api/health');
        version = health.version || '';
        brand = health.brand || brand;
    } catch { /* unreachable server: still show the copyright */ }
    // One key per shape rather than glued fragments: a translator must be able to
    // move the year and the version around each other. The brand is passed in as
    // a slot so it never enters a dictionary — it belongs to whoever runs this
    // instance and comes from their own config.
    const vars = { version, year: new Date().getFullYear(), brand };
    const label = version ? t('app.footer.copyrightVersion', vars) : t('app.footer.copyright', vars);
    for (const el of document.querySelectorAll('.app-foot')) el.textContent = label;
}

/* ---------------- notifications ----------------
   The mechanics — permission, background delivery, who shows what — live in
   notify.js. The browser's own permission is the on/off switch; there is no
   second toggle to disagree with it. */

// The tag of the notification ringing for a conversation's call, and the call
// it rang for, so a late timeout never closes a newer call's ring.
const ringTag = (convId) => 'cw-ring-' + convId;
const ringing = new Map();   // convId -> callId

function stopRingNotice(convId) {
    if (convId == null) return;
    ringing.delete(convId);
    closeNotifications(ringTag(convId));
}

function notifSection() {
    const wrap = h('div', {});
    const paint = () => {
        wrap.textContent = '';
        const line = (key) => wrap.append(h('p', { class: 'field-hint', text: t(key) }));
        const state = notificationState();
        if (state === 'unsupported') return line('app.notif.unsupported');
        if (state === 'denied') return line('app.notif.blocked');
        if (state === 'default') {
            line('app.notif.hint');
            wrap.append(h('button', {
                class: 'btn small', type: 'button', text: t('app.notif.enable'),
                onclick: async () => {
                    if (await enableNotifications() === 'local') toast(t('app.notif.pushFailed'), 6000);
                    paint();
                    offerNotifications();
                },
            }));
            return;
        }
        line('app.notif.enabled');
        // Said plainly, because it decides whether a call can reach you with the
        // app closed — and in a browser without background delivery it cannot.
        line(isDesktopApp() ? 'app.notif.desktop'
            : state === 'on' ? 'app.notif.background' : 'app.notif.foregroundOnly');
        wrap.append(h('button', {
            class: 'btn small ghost', type: 'button', text: t('app.notif.test'),
            onclick: async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                try { await sendTest(); toast(t('app.notif.testSent')); }
                catch (err) { toast(err.message); }
                btn.disabled = false;
            },
        }));
    };
    paint();
    return wrap;
}

// Where a tapped notification leads. Runs once the app is signed in and its
// socket is up (see openIntents): answering a call needs both.
function handleIntent(intent) {
    if (intent.admin) {
        if (S.me?.role === 'admin') adminModal();
        return;
    }
    if (!S.convs.has(intent.conv)) return;
    // Declined from the Windows app's call toast: no window needed for a no.
    if (intent.call && intent.decline) {
        net.send('call:decline', { callId: intent.call });
        return;
    }
    if (intent.call) {
        // Matched by conversation, not by call id: if the caller has hung up and
        // rung again, the call to pick up is the one ringing now.
        const call = S.calls.get(intent.conv);
        if (call && !call.participants.some((p) => p.userId === S.me.id)) {
            if (intent.answer) {
                joinCall(call.callId, call.convId, call.kind);
            } else {
                openConv(intent.conv);
                onCallRing({ callId: call.callId, convId: call.convId, kind: call.kind, from: call.startedBy });
            }
            return;
        }
        // Over by now: the conversation holds the record of it.
        openConv(intent.conv);
        return;
    }
    if (intent.msg) { jumpToMessage(intent.conv, intent.msg); return; }
    openConv(intent.conv);
}

/* ---------------- install (PWA) ----------------
   Chromium fires beforeinstallprompt when the app is installable and not yet
   installed; we stash it and offer our own button, which disappears once the
   app is installed (appinstalled, and the event simply stops firing). Browsers
   that do not support this — notably iOS Safari — never fire the event, so the
   button stays hidden there, which is the intended "only where supported". */

let deferredInstall = null;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    paintInstallBtn();
});
window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    paintInstallBtn();
});

function runningStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
        || window.navigator.standalone === true;
}

function paintInstallBtn() {
    const btn = $('btn-install');
    if (btn) btn.hidden = !(deferredInstall && !runningStandalone());
}

function initInstall() {
    // The service worker is what makes the app installable; without it the browser
    // never offers install. A failure here is non-fatal — install just isn't shown.
    registerWorker();
    const btn = $('btn-install');
    if (btn) {
        btn.addEventListener('click', async () => {
            if (!deferredInstall) return;
            deferredInstall.prompt();
            try { await deferredInstall.userChoice; } catch { /* dismissed */ }
            // The stashed prompt is single-use, so drop it and hide the button.
            // Chromium re-fires beforeinstallprompt on a later visit/reload if the
            // app is still installable, which brings the button back then (not
            // within this same page load).
            deferredInstall = null;
            paintInstallBtn();
        });
    }
    paintInstallBtn();   // in case beforeinstallprompt fired before this ran
}

/* ---------------- activity ----------------
   The bell: missed calls and reactions to this user's messages, collected in
   one place so nothing that happened while they were away has to be hunted for
   conversation by conversation. Clicking an item leads to the message itself. */

let activityUnseen = 0;

function paintActivityBadge() {
    const b = $('activity-badge');
    if (!b) return;
    b.hidden = activityUnseen === 0;
    b.textContent = activityUnseen > 99 ? '99+' : String(activityUnseen);
}

// One line describing what happened, in the viewer's language.
function activityLabel(item) {
    if (item.kind === 'missed_call') {
        return t(item.msgSysKey === 'sys.call_missed_video'
            ? 'activity.missed_video' : 'activity.missed_voice');
    }
    return t('activity.react', { emoji: item.emoji || '' });
}

// What the reaction landed on, so the owner knows which message before jumping.
function activitySnippet(item) {
    if (item.kind !== 'reaction') return '';
    if (item.msgType === 'text') {
        const text = item.msgContent || '';
        return text.length > 80 ? text.slice(0, 80) + '…' : text;
    }
    if (item.msgContent) return item.msgContent;   // a file's caption names it best
    return previewLabel({ type: item.msgType, fileName: item.msgFileName });
}

function activityModal() {
    openModal(async (modal, close) => {
        modal.append(h('h3', { text: t('activity.title') }));
        const list = h('div', { class: 'list' });
        modal.append(list);
        let data;
        try { data = await api('api/activity'); }
        catch (e) { toast(e.message); close(); return; }
        // Closed (backdrop tap) while the list was loading: nothing was shown,
        // so nothing may be acknowledged — or the dots and badge would vanish
        // for items the user never laid eyes on.
        if (!modal.isConnected) return;

        if (!data.items.length) {
            list.append(h('p', { class: 'field-hint', text: t('activity.empty') }));
        }
        for (const item of data.items) {
            const conv = S.convs.get(item.convId);
            const row = h('button', {
                class: 'activity-row' + (item.seenAt ? '' : ' unseen'), type: 'button',
                onclick: () => {
                    close();
                    if (S.convs.has(item.convId)) jumpToMessage(item.convId, item.messageId);
                },
            });
            const actor = S.users.get(item.actorId);
            row.append(avatarEl(userName(item.actorId), { src: userAvatar(actor) }));
            const mid = h('div', { class: 'u-mid' }, [
                h('div', { class: 'u-name', text: userName(item.actorId) }),
                h('div', { class: 'a-what', text: activityLabel(item) }),
            ]);
            const snippet = activitySnippet(item);
            if (snippet) mid.append(h('div', { class: 'a-snippet', text: snippet }));
            mid.append(h('div', { class: 'a-sub', text:
                (conv?.type === 'group' ? convTitle(conv) + ' · ' : '') + fmtListTime(item.createdAt) }));
            row.append(mid);
            if (!item.seenAt) row.append(h('span', { class: 'a-dot', 'aria-hidden': 'true' }));
            list.append(row);
        }

        // Opening the panel is the acknowledgement: the badge clears, while the
        // dots stay for this viewing so what was new is still visible.
        if (data.unseen > 0) {
            api('api/activity/seen', { method: 'POST' }).catch(() => { /* next open retries */ });
        }
        activityUnseen = 0;
        paintActivityBadge();
    });
}

function onActivityNew(item) {
    activityUnseen++;
    paintActivityBadge();
    // A missed call already rang; only a reaction earns a fresh sound, and only
    // when the owner is not looking at that conversation right now.
    if (item.kind === 'reaction' && (item.convId !== S.activeConvId || document.hidden)) {
        popSound();
    }
    // A missed call takes the place of the ring it ends; a reaction is its own.
    notifyLocal({
        kind: item.kind === 'reaction' ? 'react' : 'call',
        tag: item.kind === 'reaction' ? 'cw-react-' + item.messageId : 'cw-call-' + item.convId,
        title: userName(item.actorId),
        body: activityLabel(item),
        intent: { conv: item.convId, msg: item.kind === 'reaction' ? item.messageId : undefined },
    });
}

/* ---------------- efficiency mode ---------------- */

function ecoSection() {
    const wrap = h('div', {});
    const paint = () => {
        wrap.textContent = '';
        wrap.append(h('p', { class: 'field-hint', text: t('app.eco.hint') }));
        const seg = h('div', { class: 'seg' });
        for (const [on, key] of [[false, 'app.eco.off'], [true, 'app.eco.on']]) {
            seg.append(h('button', {
                class: 'seg-opt' + (ecoOn() === on ? ' active' : ''), type: 'button', text: t(key),
                onclick: () => { setEco(on); paint(); },
            }));
        }
        wrap.append(seg);
    };
    paint();
    return wrap;
}

/* ---------------- theme ---------------- */

// Cycles system -> light -> dark. The actual resolution lives in js/theme.js so
// the toggle and the pre-paint pass share one implementation.
const THEME_CYCLE = ['system', 'light', 'dark'];
// Keys, not text: resolving these at module scope would freeze the title in the
// language that happened to be active when this file was first evaluated.
const THEME_TITLE_KEY = {
    system: 'app.theme.title.system',
    light: 'app.theme.title.light',
    dark: 'app.theme.title.dark',
};

// Shared so the header toggle and the profile selector never disagree.
function paintThemeBtn() {
    const btn = $('btn-theme');
    if (!btn || !window.cwTheme) return;
    const pref = window.cwTheme.preference();
    btn.dataset.pref = pref;
    btn.title = t(THEME_TITLE_KEY[pref]);
}

function initTheme() {
    const btn = $('btn-theme');
    if (!btn || !window.cwTheme) return;
    paintThemeBtn();
    btn.addEventListener('click', () => {
        const cur = window.cwTheme.preference();
        const next = THEME_CYCLE[(THEME_CYCLE.indexOf(cur) + 1) % THEME_CYCLE.length];
        window.cwTheme.set(next);
        paintThemeBtn();
    });
}

function showPending() {
    show('view-pending');
    clearInterval(pendingPoll);
    pendingPoll = setInterval(async () => {
        try {
            const { user } = await api('api/me');
            if (user.status === 'active') {
                clearInterval(pendingPoll);
                await enterApp();
            }
        } catch (e) {
            if (e.status === 401 || e.status === 403) {
                clearInterval(pendingPoll);
                show('view-auth');
            }
        }
    }, 15_000);
}

async function enterApp() {
    const data = await api('api/bootstrap');
    applyBootstrap(data);
    authed = true;
    show('view-app');
    if (!booted) {
        booted = true;
        initChat();
        initCalls();
        initSidebar();
    }
    renderMe();
    renderConvList();
    connectWs();
    startActivityReporting();
    // Re-registered on every start: cheap, and it repairs a registration the
    // server dropped or a key that changed. The offer waits for the answer, so
    // it is never shown to someone who is already set up.
    syncPush().finally(offerNotifications);
}

function applyBootstrap(data) {
    S.me = data.me;
    S.users = new Map(data.users.map((u) => [u.id, u]));
    S.convs = new Map(data.conversations.map((c) => [c.id, c]));
    S.online = new Set(data.online);
    S.calls = new Map(data.calls.map((c) => [c.convId, c]));
    primeDelReqs(data.deleteRequests);
    activityUnseen = data.activityUnseen || 0;
    paintActivityBadge();
    setPushKey(data.push?.key);
    if (S.activeConvId && !S.convs.has(S.activeConvId)) closeConv();
}

async function resync() {
    try {
        const data = await api('api/bootstrap');
        applyBootstrap(data);
        renderMe();
        renderConvList();
        if (S.activeConvId) { renderHeader(); await reconcileActive(); }
        updateChip();
    } catch { /* next reconnect will retry */ }
}

/* ---------------- connection state ----------------
   The socket dropping is the visible symptom of a bad network, and on the
   connections this app is used over it happens often. Saying so plainly beats
   letting messages quietly fail to send. */

function setOnlineState(up) {
    const bar = $('conn-bar');
    if (!bar) return;
    bar.hidden = up;
    if (!up) bar.textContent = t('app.conn.lost');
    // Nothing else to do: the bar is a row in the body's column, so showing it
    // moves the interface down by exactly its own height, whatever that is.
}

/* ---------------- websocket ---------------- */

function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const base = location.pathname.replace(/\/$/, '');
    return proto + location.host + base + '/ws';
}

function connectWs() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
        wsBackoff = 1000;
        setOnlineState(true);
        resync(); // catch anything missed while offline
    };
    ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        const fn = EVENTS[msg.t];
        if (fn) fn(msg.d);
    };
    ws.onclose = (e) => {
        ws = null;
        if (authed) setOnlineState(false);
        // 4001 = account disabled, 4002 = logged out elsewhere in this browser.
        if (e.code === 4001 || e.code === 4002) { location.reload(); return; }
        if (authed) {
            setTimeout(connectWs, wsBackoff);
            wsBackoff = Math.min(wsBackoff * 2, 15_000);
        }
    };
    ws.onerror = () => ws?.close();
}

// Parameter is `type`, not `t`: a parameter named `t` would shadow the imported
// translator inside this function. The wire field is still `t`.
net.send = (type, d) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: type, d }));
};

const EVENTS = {
    hello(d) {
        S.connId = d.connId;
        S.online = new Set(d.online);
        S.calls = new Map(d.calls.map((c) => [c.convId, c]));
        renderConvList();
        updateChip();
        for (const c of d.calls) onCallState(c);
        // The server holds background notifications for whoever is active, and
        // this connection starts out counted as not.
        reportActivity(true);
        // Signed in, loaded and connected: a tapped notification can be acted on.
        openIntents(handleIntent);
    },
    'msg:new'(d) {
        const m = d.message;
        const conv = S.convs.get(m.conversationId);
        if (!conv) { resync(); return; }
        conv.lastMessage = m;
        if (m.senderId !== S.me.id && m.type !== 'system'
            && (m.conversationId !== S.activeConvId || document.hidden)) {
            conv.unread = (conv.unread || 0) + 1;
            popSound();
            // Tagged per conversation so a burst coalesces into one notification.
            notifyLocal({
                kind: 'msg', tag: 'cw-conv-' + conv.id,
                title: conv.type === 'group' ? convTitle(conv) : userName(m.senderId),
                body: previewText(conv),
                intent: { conv: conv.id },
            });
        }
        onMsgNew(m);
        renderConvList();
    },
    'msg:deleted'(d) {
        const conv = S.convs.get(d.convId);
        // Provisional only: a conv:updated with the recomputed preview and unread
        // count follows immediately, which is what actually settles the row.
        if (conv?.lastMessage?.id === d.messageId) {
            conv.lastMessage.deleted = true;
            conv.lastMessage.tombstone = !!d.tombstone;
        }
        onMsgDeleted(d.convId, d.messageId, d.tombstone);
        renderConvList();
    },
    'msg:reaction'(d) { onMsgReaction(d.convId, d.messageId, d.reactions); },
    'activity:new'(d) { onActivityNew(d.item); },
    'activity:sync'(d) { activityUnseen = d.unseen; paintActivityBadge(); },
    read(d) { onRead(d.convId, d.userId, d.lastReadId); },
    'msg:delreq'(d) { onDelReq(d.request); },
    'msg:edited'(d) {
        const conv = S.convs.get(d.message.conversationId);
        if (conv?.lastMessage?.id === d.message.id) conv.lastMessage = d.message;
        onMsgEdited(d.message);
        renderConvList();
    },
    'conv:new'(d) {
        S.convs.set(d.conversation.id, d.conversation);
        renderConvList();
        learnMembers(d.conversation);
    },
    'conv:updated'(d) {
        const conv = S.convs.get(d.conversation.id);
        const unread = conv?.unread || 0;
        // Merge read positions forward. This payload was built server-side a
        // moment ago and can land after a newer read event, which would otherwise
        // walk a settled tick backwards.
        const reads = (d.conversation.reads || []).map((r) => {
            const had = conv?.reads?.find((x) => x.userId === r.userId);
            return had ? { ...r, lastReadId: Math.max(had.lastReadId, r.lastReadId) } : r;
        });
        S.convs.set(d.conversation.id, { ...d.conversation, unread, reads });
        learnMembers(d.conversation);
        renderConvList();
        if (S.activeConvId === d.conversation.id) renderHeader();
    },
    'conv:removed'(d) {
        S.convs.delete(d.convId);
        S.msgs.delete(d.convId);
        saveDraft(d.convId, '');   // nothing left to send it to
        if (S.activeConvId === d.convId) closeConv();
        renderConvList();
    },
    presence(d) {
        if (d.online) S.online.add(d.userId);
        else S.online.delete(d.userId);
        renderConvList();
        if (S.activeConvId) renderHeader();
    },
    typing(d) { onTyping(d.convId, d.userId); },
    'user:pending'(d) {
        if (S.me.role === 'admin') {
            S.pendingCount += 1;
            renderAdminBadge();
            toast(t('app.toast.userPending', { name: d.user.displayName }));
            notifyLocal({
                kind: 'admin', tag: 'cw-admin',
                title: t('app.admin.title'),
                body: t('app.toast.userPending', { name: d.user.displayName }),
                intent: { admin: true },
            });
        }
    },
    // Someone was renamed, approved, blocked or deleted: refresh every place
    // their identity is shown. S.me and S.users.get(S.me.id) are separate
    // objects (both built from /bootstrap), so self updates must touch both or
    // lookups through S.users keep returning the stale record.
    'user:updated'(d) {
        if (!d || !d.user) return;
        const u = d.user;
        if (S.me && u.id === S.me.id) { S.me = u; S.users.set(u.id, u); renderMe(); }
        else if (u.status === 'active') S.users.set(u.id, u);
        else S.users.delete(u.id);
        renderConvList();
        if (S.activeConvId) renderHeader();
    },
    'call:state'(d) {
        onCallState(d);
        // Answered on this or another of my devices: the call notification is done.
        if (d.participants.some((p) => p.userId === S.me.id)) stopRingNotice(d.convId);
    },
    'call:ring'(d) {
        onCallRing(d);
        if (d.from === S.me.id) return;
        const conv = S.convs.get(d.convId);
        ringing.set(d.convId, d.callId);
        const byWindows = notifyLocal({
            kind: 'ring', tag: ringTag(d.convId), sticky: true,
            labels: { answer: t('ui.ring.accept'), decline: t('ui.ring.decline') },
            title: userName(d.from),
            body: conv?.type === 'group'
                ? t(d.kind === 'video' ? 'call.ring_sub_video_group' : 'call.ring_sub_voice_group', { title: convTitle(conv) })
                : t(d.kind === 'video' ? 'call.ring_sub_video' : 'call.ring_sub_voice'),
            intent: { conv: d.convId, call: d.callId },
        });
        // The Windows app's call toast is already ringing; two ringtones at once
        // would be noise. The banner in the window stays, just silent.
        if (byWindows) ringStop();
        // A backstop only: the server always ends an unanswered call, and that
        // event closes this. Checked against the call id so a newer call in the
        // same conversation is never silenced by an older one's timer.
        setTimeout(() => { if (ringing.get(d.convId) === d.callId) stopRingNotice(d.convId); }, 90_000);
    },
    'call:declined'(d) {
        onCallDeclined(d);
        // My own decline, from this or another device: nothing left to ring for.
        if (d.userId === S.me.id) {
            for (const [convId, callId] of ringing) if (callId === d.callId) stopRingNotice(convId);
        }
    },
    'call:ended'(d) {
        // Read before onCallEnded forgets the call: the event may not name it.
        const convId = d.convId ?? [...S.calls.values()].find((c) => c.callId === d.callId)?.convId;
        onCallEnded(d);
        stopRingNotice(convId);
    },
    rtc(d) { onRtc(d); },
};

/* ---------------- sidebar ---------------- */

function renderMe() {
    const el = $('sb-me');
    el.textContent = '';
    el.onclick = profileModal;          // the row itself opens the profile
    el.title = t('app.sidebar.meTitle');
    el.append(avatarEl(S.me.displayName, { online: true, src: userAvatar(S.me), zoom: true }));
    el.append(h('div', {}, [
        h('div', { text: S.me.displayName }),
        h('div', { class: 'uname', text: '@' + S.me.username }),
    ]));
    $('btn-admin').hidden = S.me.role !== 'admin';
}

// The bare type label, without the speaker prefix.
function previewLabel(m) {
    switch (m.type) {
        case 'image': return t('app.preview.image');
        case 'video': return t('app.preview.video');
        case 'videomsg': return t('app.preview.videomsg');
        case 'audio': return t('app.preview.audio');
        case 'voice': return t('app.preview.voice');
        default: return t('app.preview.file', { name: m.fileName || t('app.preview.fileFallback') });
    }
}

function previewText(conv) {
    const m = conv.lastMessage;
    if (!m) return conv.type === 'group' ? t('app.preview.groupCreated') : t('app.preview.sayHello');
    // Only a removal that left a marker in the thread is worth naming. Anything
    // else falls through to the conversation's own empty state rather than a
    // blank row, which is what a not-yet-replaced preview would otherwise be.
    if (m.deleted && !m.tombstone) {
        return conv.type === 'group' ? t('app.preview.groupCreated') : t('app.preview.sayHello');
    }
    if (m.deleted) return t('app.preview.messageDeleted');
    // The speaker prefix is one key with a {name} slot, so a translator controls
    // the separator and can put the name where the language wants it. The message
    // body is user content and is never translated, so it stays a separate append.
    const who = m.senderId === S.me.id
        ? t('app.preview.prefixYou')
        : (conv.type === 'group' ? t('app.preview.prefixName', { name: userName(m.senderId).split(' ')[0] }) : '');
    // Otherwise the sidebar advertises "📷 Photo" for a thread whose bubble
    // already reads "Removed to free space".
    if (m.purged) return who + t('app.preview.fileRemoved');
    // A captioned file reads better as its caption than as "📷 Photo".
    if (m.type !== 'text' && m.type !== 'system' && m.content) {
        return who + t('app.preview.withCaption', { label: previewLabel(m), caption: m.content });
    }
    switch (m.type) {
        case 'text': return who + (m.content || '');
        case 'image': return who + t('app.preview.image');
        case 'video': return who + t('app.preview.video');
        case 'videomsg': return who + t('app.preview.videomsg');
        case 'audio': return who + t('app.preview.audio');
        case 'voice': return who + t('app.preview.voice');
        // Same resolution as the bubble, so the sidebar cannot disagree with the
        // thread about what a system event says.
        case 'system': return sysText(m);
        default: return who + t('app.preview.file', { name: m.fileName || t('app.preview.fileFallback') });
    }
}

export function renderConvList() {
    const list = $('conv-list');
    list.textContent = '';
    const convs = [...S.convs.values()].sort((a, b) =>
        (b.lastMessage?.createdAt || b.createdAt) - (a.lastMessage?.createdAt || a.createdAt));
    for (const conv of convs) {
        const title = convTitle(conv);
        const other = convOther(conv);
        const item = h('button', {
            class: 'conv-item' + (conv.id === S.activeConvId ? ' active' : ''),
            type: 'button',
            onclick: () => { openConv(conv.id); renderConvList(); },
        });
        item.append(avatarEl(title, {
            group: conv.type === 'group',
            online: conv.type === 'direct' ? S.online.has(other) : null,
            src: convAvatarSrc(conv),
        }));
        item.append(h('div', { class: 'conv-mid' }, [
            h('div', { class: 'conv-name', text: title }),
            h('div', { class: 'conv-prev', text: previewText(conv) }),
        ]));
        const side = h('div', { class: 'conv-side' });
        const ts = conv.lastMessage?.createdAt || conv.createdAt;
        side.append(h('div', { class: 'conv-time', text: fmtListTime(ts) }));
        if (conv.unread > 0) side.append(h('div', { class: 'conv-unread', text: conv.unread > 99 ? '99+' : String(conv.unread) }));
        item.append(side);
        list.append(item);
    }
    updateTitle();
}
bus.on('convs-changed', renderConvList);
bus.on('conv-opened', () => renderConvList());
// Reading a conversation retires the notification that announced it.
bus.on('conv-opened', (convId) => closeNotifications('cw-conv-' + convId));

function updateTitle() {
    let total = 0;
    for (const c of S.convs.values()) total += c.unread || 0;
    document.title = (total > 0 ? `(${total}) ` : '') + 'ConnectWell';
    setUnread(total);
}

function renderAdminBadge() {
    const b = $('admin-badge');
    if (S.pendingCount > 0) { b.textContent = String(S.pendingCount); b.hidden = false; }
    else b.hidden = true;
}

/* ---------------- modals ---------------- */

function openModal(build) {
    const root = $('modal-root');
    root.textContent = '';
    const modal = h('div', { class: 'modal' });
    root.append(modal);
    root.hidden = false;
    // Three ways out, because the backdrop alone is not discoverable and on a
    // phone a tall modal barely leaves any backdrop to tap.
    let detach = () => { };
    const close = () => { root.hidden = true; root.textContent = ''; detach(); };
    detach = closeControl(modal, close, t('app.close'));
    root.onclick = (e) => { if (e.target === root) close(); };
    build(modal, close);
}

function userRowBtn(u, onclick) {
    const row = h('button', { class: 'user-row', type: 'button', onclick });
    row.append(avatarEl(u.displayName, { online: S.online.has(u.id), src: userAvatar(u) }));
    row.append(h('div', { class: 'u-mid' }, [
        h('div', { class: 'u-name', text: u.displayName }),
        h('div', { class: 'u-sub', text: '@' + u.username }),
    ]));
    return row;
}

// Same shape as the new-chat picker: search, avatars, one tap to add.
function addMemberModal(conv) {
    openModal((modal, close) => {
        modal.append(h('h3', { text: t('app.convInfo.addMemberTitle') }));
        const search = h('input', { type: 'search', placeholder: t('app.newChat.searchPlaceholder') });
        const list = h('div', { class: 'list' });
        modal.append(search, list);
        const render = (users, q) => {
            // Members of this group are filtered out here rather than by the
            // server: the search does not know which conversation it is for.
            const addable = users === null ? null : users.filter((u) => !conv.members.includes(u.id));
            if (searchHint(list, addable, q)) return;
            for (const u of addable) {
                list.append(userRowBtn(u, async () => {
                    try {
                        await api('api/conversations/' + conv.id + '/members', {
                            method: 'POST', body: { userId: u.id },
                        });
                        S.users.set(u.id, u);
                        close();
                    } catch (e) { toast(e.message); }
                }));
            }
        };
        attachUserSearch(search, list, render);
        search.focus();
    });
}

/* Finding somebody to talk to.

   The member list is not browsable: the server only ever hands a client the
   people they already share a conversation with, so these pickers have nothing
   to list until a search is typed. Below the minimum they show a prompt rather
   than an empty box, because "nothing here" and "I have not looked yet" are
   different things and look identical otherwise. */
const SEARCH_MIN = 3;

/* A conversation can arrive naming somebody this client has never been told
   about: a stranger found by search, or one added to a group by another member.
   The roster follows from conversations, so re-reading it is what teaches this
   client the names it now legitimately needs — without ever handing it the
   names it does not. Costs a request only when an unfamiliar id appears. */
async function learnMembers(conv) {
    const unknown = (conv?.members || []).some((id) => id !== S.me.id && !S.users.has(id));
    if (!unknown) return;
    try {
        const { users } = await api('api/users');
        for (const u of users) S.users.set(u.id, u);
        renderConvList();
        if (S.activeConvId) renderHeader();
    } catch { /* the next bootstrap settles it */ }
}

// Debounced because it goes to the server on every keystroke. The token guards
// against an earlier, slower reply landing after a later one and overwriting it.
function attachUserSearch(input, list, render) {
    let timer = null;
    let token = 0;
    const run = async () => {
        const q = input.value.trim();
        const mine = ++token;
        if (q.length < SEARCH_MIN) { render(null, q); return; }
        try {
            const { users } = await api('api/users/search?q=' + encodeURIComponent(q));
            if (mine === token) render(users, q);
        } catch (e) {
            if (mine === token) { render([], q); toast(e.message); }
        }
    };
    input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(run, 250);
    });
    render(null, '');
    return run;
}

// The prompt shown before a search is long enough to run, and the "no matches"
// line after one that found nothing.
function searchHint(list, users, q) {
    list.textContent = '';
    if (users === null) {
        list.append(h('p', { class: 'field-hint', text: t('app.search.hint', { n: SEARCH_MIN }) }));
        return true;
    }
    if (!users.length) {
        list.append(h('p', { class: 'muted', text: t('app.search.none', { q }) }));
        return true;
    }
    return false;
}

function newChatModal() {
    openModal((modal, close) => {
        modal.append(h('h3', { text: t('app.newChat.title') }));
        const search = h('input', { type: 'search', placeholder: t('app.newChat.searchPlaceholder') });
        const list = h('div', { class: 'list' });
        modal.append(search, list);
        const render = (users, q) => {
            if (searchHint(list, users, q)) return;
            for (const u of users) {
                list.append(userRowBtn(u, async () => {
                    try {
                        const { conversation } = await api('api/conversations', {
                            method: 'POST', body: { type: 'direct', userId: u.id },
                        });
                        S.users.set(u.id, u);          // just met, by name
                        S.convs.set(conversation.id, conversation);
                        close();
                        openConv(conversation.id);
                        renderConvList();
                    } catch (e) { toast(e.message); }
                }));
            }
        };
        attachUserSearch(search, list, render);
        search.focus();
    });
}

function newGroupModal() {
    openModal((modal, close) => {
        modal.append(h('h3', { text: t('app.newGroup.title') }));
        const name = h('input', { type: 'text', placeholder: t('app.newGroup.namePlaceholder'), maxlength: '50' });
        const search = h('input', { type: 'search', placeholder: t('app.newChat.searchPlaceholder') });
        const chosen = h('div', { class: 'chosen' });
        const list = h('div', { class: 'list' });
        // Keyed by id and holding the whole user, so somebody stays picked — and
        // still renders — after the search that found them is typed over.
        const picked = new Map();
        modal.append(name, search, chosen, list);

        const paintChosen = () => {
            chosen.textContent = '';
            if (!picked.size) return;
            for (const u of picked.values()) {
                const chip = h('button', {
                    class: 'chip', type: 'button', title: t('chat.reply_cancel'),
                    onclick: () => { picked.delete(u.id); paintChosen(); },
                });
                chip.append(h('span', { text: u.displayName }), h('span', { class: 'chip-x', text: '✕' }));
                chosen.append(chip);
            }
        };

        const render = (users, q) => {
            if (searchHint(list, users, q)) return;
            for (const u of users) {
                const row = h('label', { class: 'user-row' });
                const cb = h('input', { type: 'checkbox' });
                cb.checked = picked.has(u.id);
                cb.addEventListener('change', () => {
                    if (cb.checked) picked.set(u.id, u); else picked.delete(u.id);
                    paintChosen();
                });
                row.append(cb, avatarEl(u.displayName, { src: userAvatar(u) }), h('div', { class: 'u-mid' }, [
                    h('div', { class: 'u-name', text: u.displayName }),
                    h('div', { class: 'u-sub', text: '@' + u.username }),
                ]));
                list.append(row);
            }
        };
        attachUserSearch(search, list, render);
        const row = h('div', { class: 'modal-row' });
        row.append(h('div', { class: 'rec-spacer' }));
        row.append(h('button', { class: 'btn small ghost', type: 'button', text: t('app.newGroup.cancel'), onclick: close }));
        row.append(h('button', {
            class: 'btn small', type: 'button', text: t('app.newGroup.create'),
            onclick: async () => {
                try {
                    const { conversation } = await api('api/conversations', {
                        method: 'POST', body: { type: 'group', name: name.value, memberIds: [...picked.keys()] },
                    });
                    for (const u of picked.values()) S.users.set(u.id, u);
                    S.convs.set(conversation.id, conversation);
                    close();
                    openConv(conversation.id);
                    renderConvList();
                } catch (e) { toast(e.message); }
            },
        }));
        modal.append(row);
    });
}

function convInfoModal() {
    const conv = S.convs.get(S.activeConvId);
    if (!conv) return;
    openModal((modal, close) => {
        if (conv.type === 'direct') {
            const other = S.users.get(convOther(conv));
            modal.append(h('h3', { text: t('app.convInfo.directTitle') }));
            const row = h('div', { class: 'user-row' });
            row.append(avatarEl(other?.displayName || t('app.convInfo.userFallback'), {
                online: other ? S.online.has(other.id) : false, src: userAvatar(other),
            }));
            row.append(h('div', { class: 'u-mid' }, [
                h('div', { class: 'u-name', text: other?.displayName || t('app.convInfo.formerMember') }),
                // The handle and its status suffix are one key: the '@' and the '·'
                // are punctuation a translator owns. The username itself is a slot.
                h('div', {
                    class: 'u-sub',
                    text: other
                        ? t(S.online.has(other.id) ? 'app.convInfo.subOnline' : 'app.convInfo.subOffline', { username: other.username })
                        : '',
                }),
            ]));
            modal.append(row);
            return;
        }

        const mayManage = conv.createdBy === S.me.id || S.me.role === 'admin';
        modal.append(h('h3', { text: conv.name }));

        if (mayManage) {
            // Same rule the server enforces: a photo is a group-identity change,
            // so it follows the creator-or-admin rule that renaming already uses.
            const picker = photoPicker({
                src: convAvatarSrc(conv),
                name: conv.name,
                group: true,
                notify: (msg, bad) => toast(msg),
                // conv:updated arrives over the socket and refreshes S.convs, the
                // list and the header, so nothing needs patching by hand here.
                onSave: async (blob) => convAvatarSrc(
                    (await postBytes('api/conversations/' + conv.id + '/avatar', blob)).conversation),
                onRemove: async () => {
                    await api('api/conversations/' + conv.id + '/avatar', { method: 'DELETE' });
                },
            });
            modal.append(h('div', { class: 'profile-head' }, [picker.holder]));
            modal.append(picker.actions);

            const name = h('input', { type: 'text', value: conv.name, maxlength: '50' });
            const save = h('button', {
                class: 'btn small ghost', type: 'button', text: t('app.convInfo.rename'),
                onclick: async () => {
                    try { await api('api/conversations/' + conv.id, { method: 'PATCH', body: { name: name.value } }); close(); }
                    catch (e) { toast(e.message); }
                },
            });
            const r = h('div', { class: 'modal-row' });
            r.append(name, save);
            modal.append(r);
        }

        modal.append(h('p', { class: 'muted', text: t('app.convInfo.memberCount', { n: conv.members.length }) }));
        const list = h('div', { class: 'list' });
        modal.append(list);
        for (const uid of conv.members) {
            const u = uid === S.me.id ? S.me : S.users.get(uid);
            const row = h('div', { class: 'user-row' });
            row.append(avatarEl(u?.displayName || t('app.convInfo.userFallback'), { online: S.online.has(uid), src: userAvatar(u) }));
            // The creator marker wraps the whole name rather than being glued on
            // after it, so the '·' and the word order belong to the translator.
            const who = u?.displayName || t('app.convInfo.formerMember');
            row.append(h('div', { class: 'u-mid' }, [
                h('div', { class: 'u-name', text: uid === conv.createdBy ? t('app.convInfo.creator', { name: who }) : who }),
                h('div', { class: 'u-sub', text: u ? '@' + u.username : '' }),
            ]));
            if (mayManage && uid !== S.me.id) {
                row.append(h('button', {
                    class: 'btn small ghost', type: 'button', text: t('app.convInfo.removeMember'),
                    onclick: async () => {
                        try { await api('api/conversations/' + conv.id + '/members/' + uid, { method: 'DELETE' }); close(); }
                        catch (e) { toast(e.message); }
                    },
                }));
            }
            list.append(row);
        }

        {
            // A styled button opening the same searchable people list used to
            // start a chat, rather than a raw <select> the browser skins itself.
            const r = h('div', { class: 'modal-row' });
            r.append(h('button', {
                class: 'btn small', type: 'button', text: t('app.convInfo.addMember'),
                onclick: () => addMemberModal(conv),
            }));
            r.append(h('div', { class: 'rec-spacer' }));
            modal.append(r);
        }

        const r2 = h('div', { class: 'modal-row' });
        r2.append(h('div', { class: 'rec-spacer' }));
        r2.append(h('button', {
            class: 'btn small danger', type: 'button', text: t('app.convInfo.leaveGroup'),
            onclick: async () => {
                if (!confirm(t('app.convInfo.leaveConfirm'))) return;
                try { await api('api/conversations/' + conv.id + '/members/' + S.me.id, { method: 'DELETE' }); close(); }
                catch (e) { toast(e.message); }
            },
        }));
        modal.append(r2);
    });
}

/* ---------------- language ---------------- */

// Without a control before sign-in, a Farsi speaker on an English-configured
// browser cannot reach Farsi at all — and the pending screen, where a new account
// waits for approval, is exactly where they would be stuck.
function initAuthLanguage() {
    for (const card of document.querySelectorAll('.auth-card')) {
        const foot = card.querySelector('.app-foot');
        if (!foot) continue;
        const seg = languageSeg((msg) => toast(msg));
        seg.classList.add('seg-compact');
        card.insertBefore(seg, foot);
    }
}

// Changing language re-reads every string, so the page reloads. Two things must
// not be swallowed: an active call or recording would be destroyed by the reload,
// and in private mode the preference cannot be stored at all — reloading then
// would silently return the user to the language they just left.
function languageIsBusy() {
    const shown = (id) => { const el = $(id); return el && !el.hidden; };
    return shown('call-overlay') || shown('rec-bar') || shown('videomsg-modal');
}

function languageSeg(notify) {
    const seg = h('div', { class: 'seg' });
    const paint = () => {
        const cur = window.cwLang ? window.cwLang.preference() : 'device';
        seg.textContent = '';
        // Each language is labelled in itself — a Persian speaker looking for
        // Farsi should not have to read English to find it.
        for (const [value, key] of [
            ['device', 'app.lang.device'],
            ['en', 'app.lang.en'],
            ['fa', 'app.lang.fa'],
        ]) {
            seg.append(h('button', {
                class: 'seg-opt' + (cur === value ? ' active' : ''), type: 'button', text: t(key),
                onclick: () => {
                    if (!window.cwLang) return;
                    const stored = window.cwLang.set(value);
                    paint();
                    if (!stored) return notify(t('app.lang.notStored'), true);
                    if (languageIsBusy()) return notify(t('app.lang.laterBusy'));
                    location.reload();
                },
            }));
        }
    };
    paint();
    return seg;
}

/* ---------------- photo picker ---------------- */

// Shared by the profile and group-info modals. The preview renders the OUTPUT
// blob rather than the chosen file, so what you see is byte-identical to what
// gets stored — which is what makes a bad crop or a sideways phone photo obvious
// before it is saved.
function photoPicker({ src, name, group = false, onSave, onRemove, notify }) {
    let shownSrc = src;
    let previewUrl = null;
    let pending = null;

    const holder = h('div', { class: 'photo-holder' });
    const paint = () => {
        holder.textContent = '';
        holder.append(avatarEl(name, { size: 'big', group, src: previewUrl || shownSrc, zoom: true }));
    };
    const clearPreview = () => {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = null;
    };
    paint();

    const input = h('input', { type: 'file', accept: 'image/*', hidden: 'hidden' });
    input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.value = '';                       // so the same file can be chosen twice
        if (!file) return;
        try {
            pending = await makeAvatar(file);
            clearPreview();
            previewUrl = URL.createObjectURL(pending);
            paint();
            notify(t('app.photo.previewReady'));
        } catch (err) { notify(err.message, true); }
    });

    const busy = (fn) => async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try { await fn(); } catch (err) { notify(err.message, true); }
        btn.disabled = false;
    };

    const actions = h('div', { class: 'photo-actions' }, [
        input,
        h('button', { class: 'btn small ghost', type: 'button', text: t('app.photo.choose'), onclick: () => input.click() }),
        h('button', {
            class: 'btn small', type: 'button', text: t('app.photo.save'),
            onclick: busy(async () => {
                if (!pending) return notify(t('app.photo.chooseFirst'), true);
                const next = await onSave(pending);
                pending = null;
                clearPreview();
                shownSrc = next || null;
                paint();
                notify(t('app.photo.updated'));
            }),
        }),
        h('button', {
            class: 'btn small ghost', type: 'button', text: t('app.photo.remove'),
            onclick: busy(async () => {
                await onRemove();
                pending = null;
                clearPreview();
                shownSrc = null;
                paint();
                notify(t('app.photo.removed'));
            }),
        }),
    ]);

    return { holder, actions, dispose: clearPreview };
}

/* ---------------- profile ---------------- */

function profileModal() {
    openModal((modal, close) => {
        modal.append(h('h3', { text: t('app.profile.title') }));

        const note = h('p', { class: 'form-note', hidden: 'hidden' });
        const say = (text, bad = false) => {
            note.textContent = text;
            note.className = 'form-note' + (bad ? ' bad' : ' ok');
            note.hidden = false;
        };
        // Keeps a click from firing twice while the request is in flight.
        const guard = (fn) => async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try { await fn(); } catch (err) { say(err.message, true); }
            btn.disabled = false;
        };

        // Both S.me and the S.users copy are refreshed: they are separate objects,
        // and lookups elsewhere go through S.users.
        const applyMe = (user) => {
            S.me = user;
            S.users.set(user.id, user);
            renderMe();
            renderConvList();
            renderHeader();
            return userAvatar(user);
        };
        const picker = photoPicker({
            src: userAvatar(S.me),
            name: S.me.displayName,
            notify: say,
            onSave: async (blob) => applyMe((await postBytes('api/me/avatar', blob)).user),
            onRemove: async () => { applyMe((await api('api/me/avatar', { method: 'DELETE' })).user); },
        });

        modal.append(h('div', { class: 'profile-head' }, [
            picker.holder,
            h('div', {}, [
                h('div', { class: 'u-name', text: S.me.displayName }),
                h('div', { class: 'u-sub', text: '@' + S.me.username }),
            ]),
        ]));
        modal.append(picker.actions);

        /* display name */
        modal.append(h('label', { class: 'field-label', text: t('app.profile.displayName') }));
        const nameInput = h('input', { type: 'text', value: S.me.displayName, maxlength: '50' });
        modal.append(nameInput, h('button', {
            class: 'btn small', type: 'button', text: t('app.profile.saveName'),
            onclick: guard(async () => {
                const { user } = await api('api/me', { method: 'PATCH', body: { displayName: nameInput.value } });
                S.me = user;
                renderMe();
                renderConvList();
                renderHeader();
                say(t('app.profile.nameUpdated'));
            }),
        }));

        /* theme */
        modal.append(h('label', { class: 'field-label', text: t('app.profile.theme') }));
        const seg = h('div', { class: 'seg' });
        const paintSeg = () => {
            const cur = window.cwTheme ? window.cwTheme.preference() : 'system';
            seg.textContent = '';
            // Keys, resolved here rather than in the literal, so the labels follow
            // the language instead of whatever was active at first paint.
            for (const [value, key] of [
                ['system', 'app.profile.themeDevice'],
                ['light', 'app.profile.themeLight'],
                ['dark', 'app.profile.themeDark'],
            ]) {
                seg.append(h('button', {
                    class: 'seg-opt' + (cur === value ? ' active' : ''), type: 'button', text: t(key),
                    onclick: () => { window.cwTheme?.set(value); paintThemeBtn(); paintSeg(); },
                }));
            }
        };
        paintSeg();
        modal.append(seg);

        /* conversation backdrop */
        modal.append(h('label', { class: 'field-label', text: t('app.profile.background') }));
        const bgGrid = h('div', { class: 'bg-grid' });
        const paintBg = () => {
            bgGrid.textContent = '';
            for (const name of BACKGROUNDS) {
                // Each swatch paints itself with the very rule it selects, so the
                // preview cannot drift from the result.
                bgGrid.append(h('button', {
                    class: 'swatch' + (chatBg() === name ? ' active' : ''),
                    type: 'button', dataset: { bg: name },
                    title: t(BG_LABEL_KEY[name]), 'aria-label': t(BG_LABEL_KEY[name]),
                    onclick: () => { setChatBg(name); paintBg(); },
                }));
            }
        };
        paintBg();
        modal.append(bgGrid);

        /* language */
        modal.append(h('label', { class: 'field-label', text: t('app.profile.language') }));
        modal.append(languageSeg(say));

        /* notifications */
        modal.append(h('label', { class: 'field-label', text: t('app.eco.label') }));
        modal.append(ecoSection());

        modal.append(h('label', { class: 'field-label', text: t('app.notif.label') }));
        modal.append(notifSection());

        /* password */
        modal.append(h('label', { class: 'field-label', text: t('app.profile.changePassword') }));
        const curPw = h('input', { type: 'password', placeholder: t('app.profile.currentPassword'), autocomplete: 'current-password' });
        const newPw = h('input', { type: 'password', placeholder: t('app.profile.newPassword'), autocomplete: 'new-password' });
        modal.append(curPw, newPw, h('button', {
            class: 'btn small', type: 'button', text: t('app.profile.updatePassword'),
            onclick: guard(async () => {
                await api('api/me/password', {
                    method: 'POST',
                    body: { currentPassword: curPw.value, newPassword: newPw.value },
                });
                curPw.value = '';
                newPw.value = '';
                say(t('app.profile.passwordUpdated'));
            }),
        }));

        /* storage — permanent copy, since the composer strip is dismissible */
        modal.append(h('label', { class: 'field-label', text: t('app.profile.storage') }));
        modal.append(h('p', { class: 'field-hint', text: t('app.profile.storageHint') }));

        modal.append(note);
        modal.append(h('div', { class: 'modal-row' }, [
            h('div', { class: 'rec-spacer' }),
            h('button', {
                class: 'btn small ghost', type: 'button', text: t('app.profile.close'),
                onclick: () => { picker.dispose(); close(); },
            }),
        ]));
    });
}

/* ---------------- admin ---------------- */

// The tab captions used to be derived from the status identifier by capitalising
// it. Keys only here — resolved inside render(), never at module scope.
const ADMIN_TAB_KEY = {
    pending: 'app.admin.tab.pending',
    active: 'app.admin.tab.active',
    blocked: 'app.admin.tab.blocked',
};

// Setting somebody else's password. It is shown once, here, because the server
// stores only a hash and nobody can look it up afterwards — so the admin has to
// be able to read it off the screen to pass it on.
function setPasswordModal(user) {
    openModal((modal, close) => {
        modal.append(h('h3', { text: t('app.admin.setPasswordTitle', { name: user.displayName }) }));
        modal.append(h('p', { class: 'field-hint', text: t('app.admin.setPasswordHint') }));
        const input = h('input', {
            type: 'text', autocomplete: 'off', spellcheck: 'false',
            placeholder: t('app.admin.newPassword'),
        });
        modal.append(input);
        const row = h('div', { class: 'modal-row' });
        row.append(h('div', { class: 'rec-spacer' }));
        row.append(h('button', {
            class: 'btn small ghost', type: 'button', text: t('app.admin.suggest'),
            // Readable rather than maximally random: it is going to be typed in
            // by hand, or read down a phone line, before it is changed again.
            onclick: () => {
                const words = 'amber-brisk-cedar-delta-ember-flint-grove-larch-maple-onyx-quartz-slate'.split('-');
                const pick = () => words[Math.floor(Math.random() * words.length)];
                input.value = `${pick()}-${pick()}-${Math.floor(Math.random() * 900 + 100)}`;
                input.focus();
                input.select();
            },
        }));
        row.append(h('button', {
            class: 'btn small', type: 'button', text: t('app.admin.setPasswordSave'),
            onclick: async () => {
                const password = input.value;
                if (!password || password.length < 8) return toast(t('app.admin.passwordTooShort'));
                try {
                    await api(`api/admin/users/${user.id}/password`, {
                        method: 'POST', body: { password },
                    });
                    // Named in the toast because the admin still has to relay it,
                    // and the modal is about to close.
                    toast(t('app.admin.passwordSet', { name: user.displayName }), 8000);
                    close();
                } catch (e) { toast(e.message); }
            },
        }));
        modal.append(row);
        input.focus();
    });
}

// The instance at a glance: what it is using, what is left, and how much is
// going on inside it. Read-only — the one control is the retention sweep, which
// already refuses to delete anything unless PURGE_ENABLED is set.
function renderServer(list, stats) {
    if (!stats) {
        list.append(h('p', { class: 'muted', text: t('app.admin.loading') }));
        return;
    }
    const { server, storage, people, activity, retention } = stats;

    const section = (title, rows) => {
        list.append(h('div', { class: 'stat-head', text: title }));
        const box = h('div', { class: 'stat-grid' });
        for (const [label, value, tone] of rows) {
            if (value === null || value === undefined) continue;
            box.append(h('div', { class: 'stat-k', text: label }));
            box.append(h('div', { class: 'stat-v' + (tone ? ' ' + tone : ''), text: String(value) }));
        }
        list.append(box);
    };

    // Disk is the headline: it is the thing that actually runs out.
    const disk = storage.disk;
    section(t('app.admin.statStorage'), [
        [t('app.admin.statTotal'), fmtSize(storage.totalBytes)],
        [t('app.admin.statUploads'), `${fmtSize(storage.uploads.bytes)} · ${storage.uploads.files}`],
        [t('app.admin.statAvatars'), `${fmtSize(storage.avatars.bytes)} · ${storage.avatars.files}`],
        [t('app.admin.statDatabase'), fmtSize(storage.database.bytes)],
        disk ? [t('app.admin.statDiskFree'), `${fmtSize(disk.free)} / ${fmtSize(disk.total)}`,
            disk.free < disk.total * 0.1 ? 'warn' : ''] : null,
    ].filter(Boolean));

    section(t('app.admin.statPeople'), [
        [t('app.admin.statActive'), people.active],
        [t('app.admin.statAdmins'), people.admins],
        [t('app.admin.statPending'), people.pending, people.pending ? 'warn' : ''],
        [t('app.admin.statBlocked'), people.blocked],
        [t('app.admin.statOnline'), people.onlineNow],
    ]);

    section(t('app.admin.statActivity'), [
        [t('app.admin.statConversations'), `${activity.direct} + ${activity.groups}`],
        [t('app.admin.statMessages'), activity.messages],
        [t('app.admin.statToday'), activity.messagesDay],
        [t('app.admin.statWeek'), activity.messagesWeek],
        [t('app.admin.statFiles'), activity.files],
        [t('app.admin.statCalls'), `${activity.calls} · ${activity.missedCalls}`],
    ]);

    section(t('app.admin.statServer'), [
        [t('app.admin.statVersion'), server.version],
        [t('app.admin.statUptime'), fmtUptime(server.uptimeSec)],
        [t('app.admin.statMemory'), fmtSize(server.memoryBytes)],
        [t('app.admin.statNode'), server.node],
    ]);

    // Whether anything is actually being deleted is the line that matters most,
    // so it is stated rather than left to be inferred from the numbers above.
    section(t('app.admin.statRetention'), [
        [t('app.admin.statPurge'),
            t(retention.purgeEnabled ? 'app.admin.purgeOn' : 'app.admin.purgeOff'),
            retention.purgeEnabled ? 'warn' : ''],
        [t('app.admin.statAge'), retention.retentionDays
            ? t('app.admin.days', { n: retention.retentionDays }) : t('app.admin.purgeOff')],
        [t('app.admin.statThresholds'), `${fmtSize(retention.lowBytes)} / ${fmtSize(retention.highBytes)}`],
    ]);

    const row = h('div', { class: 'modal-row' });
    row.append(h('div', { class: 'rec-spacer' }));
    row.append(h('button', {
        class: 'btn small ghost', type: 'button', text: t('app.admin.sweep'),
        onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
                const r = await api('api/admin/storage/sweep', { method: 'POST' });
                // A dry run reports what it WOULD remove; a real one what it did.
                // Saying "removed 12" after a dry run would be a lie about data.
                toast(r.mode === 'purge'
                    ? t('app.admin.sweepDone', { n: r.purged, size: fmtSize(r.freed) })
                    : t('app.admin.sweepDry', { n: r.selected }), 8000);
            } catch (err) { toast(err.message); }
            btn.disabled = false;
        },
    }));
    list.append(row);
}

// Whole units only: an admin glancing at uptime wants "3 days", not a duration
// to the second.
function fmtUptime(sec) {
    if (sec < 60) return t('app.admin.seconds', { n: sec });
    if (sec < 3600) return t('app.admin.minutes', { n: Math.floor(sec / 60) });
    if (sec < 86400) return t('app.admin.hours', { n: Math.floor(sec / 3600) });
    return t('app.admin.days', { n: Math.floor(sec / 86400) });
}

async function adminModal() {
    S.pendingCount = 0;
    renderAdminBadge();
    let users;
    try { users = (await api('api/admin/users')).users; }
    catch (e) { toast(e.message); return; }

    openModal((modal, close) => {
        modal.append(h('h3', { text: t('app.admin.title') }));
        const tabs = h('div', { class: 'admin-tabs' });
        const list = h('div', { class: 'list' });
        modal.append(tabs, list);
        let tab = 'pending';
        let stats = null;

        const refresh = async () => {
            try { users = (await api('api/admin/users')).users; render(); }
            catch (e) { toast(e.message); }
        };

        const act = (path) => async () => {
            try { await api(path.url, { method: path.method || 'POST' }); await refresh(); }
            catch (e) { toast(e.message); }
        };

        const render = () => {
            tabs.textContent = '';
            const counts = { pending: 0, active: 0, blocked: 0 };
            for (const u of users) if (counts[u.status] !== undefined) counts[u.status]++;
            // `status`, not `t`: the loop variable this used to have shadowed the
            // imported translator for the whole body. The status values themselves
            // stay untranslated — they are the server's identifiers.
            for (const status of ['pending', 'active', 'blocked', 'server']) {
                if (status === 'server') {
                    tabs.append(h('button', {
                        class: 'admin-tab' + (tab === 'server' ? ' active' : ''), type: 'button',
                        text: t('app.admin.tab.server'),
                        onclick: async () => {
                            tab = 'server';
                            render();
                            try { stats = await api('api/admin/stats'); }
                            catch (e) { toast(e.message); }
                            if (tab === 'server') render();
                        },
                    }));
                    continue;
                }
                const label = t(ADMIN_TAB_KEY[status]);
                tabs.append(h('button', {
                    class: 'admin-tab' + (tab === status ? ' active' : ''), type: 'button',
                    text: counts[status] ? t('app.admin.tabCount', { label, n: counts[status] }) : label,
                    onclick: () => { tab = status; render(); },
                }));
            }
            list.textContent = '';
            if (tab === 'server') { renderServer(list, stats); return; }
            const rows = users.filter((u) => u.status === tab);
            if (rows.length === 0) list.append(h('p', { class: 'muted', text: t('app.admin.empty') }));
            for (const u of rows) {
                const row = h('div', { class: 'user-row' });
                // The admin list is fetched separately, so this row object -- not
                // S.users -- is the only source for pending/blocked accounts.
                row.append(avatarEl(u.displayName, { src: userAvatar(u) }));
                row.append(h('div', { class: 'u-mid' }, [
                    // One key wrapping the name rather than a glued ' · admin'.
                    h('div', {
                        class: 'u-name',
                        text: u.role === 'admin' ? t('app.admin.roleAdmin', { name: u.displayName }) : u.displayName,
                    }),
                    h('div', { class: 'u-sub', text: '@' + u.username }),
                ]));
                const actions = h('div', { class: 'u-actions' });
                // Role and password act on a person rather than on their approval
                // state, so they sit outside the status branches below. Never on
                // your own row: the server refuses both, and offering a control
                // that always fails is worse than not offering it.
                if (u.status === 'active' && u.id !== S.me.id) {
                    actions.append(h('button', {
                        class: 'btn small ghost', type: 'button',
                        text: t(u.role === 'admin' ? 'app.admin.demote' : 'app.admin.promote'),
                        onclick: async () => {
                            const nextRole = u.role === 'admin' ? 'member' : 'admin';
                            if (!confirm(t(nextRole === 'admin'
                                ? 'app.admin.promoteConfirm' : 'app.admin.demoteConfirm',
                            { name: u.displayName }))) return;
                            try {
                                await api(`api/admin/users/${u.id}/role`, {
                                    method: 'POST', body: { role: nextRole },
                                });
                                await refresh();
                            } catch (e) { toast(e.message); }
                        },
                    }));
                }
                // Only for members: the server refuses to rewrite another admin's
                // credential, so demoting them first is the honest route.
                if (u.role !== 'admin' && u.status !== 'deleted' && u.id !== S.me.id) {
                    actions.append(h('button', {
                        class: 'btn small ghost', type: 'button', text: t('app.admin.setPassword'),
                        onclick: () => setPasswordModal(u),
                    }));
                }
                if (u.role !== 'admin') {
                    if (u.status === 'pending') {
                        actions.append(h('button', { class: 'btn small', type: 'button', text: t('app.admin.approve'), onclick: act({ url: `api/admin/users/${u.id}/approve` }) }));
                        actions.append(h('button', { class: 'btn small ghost', type: 'button', text: t('app.admin.block'), onclick: act({ url: `api/admin/users/${u.id}/block` }) }));
                    } else if (u.status === 'active') {
                        actions.append(h('button', { class: 'btn small ghost', type: 'button', text: t('app.admin.block'), onclick: act({ url: `api/admin/users/${u.id}/block` }) }));
                        actions.append(h('button', {
                            class: 'btn small danger', type: 'button', text: t('app.admin.delete'),
                            // Removing somebody who is using the account is not the
                            // same as tidying away one already blocked, so it says
                            // what it will actually do before doing it.
                            onclick: async () => {
                                if (!confirm(t('app.admin.deleteConfirm', { name: u.displayName }))) return;
                                try {
                                    await api(`api/admin/users/${u.id}`, { method: 'DELETE' });
                                    await refresh();
                                } catch (e) { toast(e.message); }
                            },
                        }));
                    } else if (u.status === 'blocked') {
                        actions.append(h('button', { class: 'btn small', type: 'button', text: t('app.admin.unblock'), onclick: act({ url: `api/admin/users/${u.id}/unblock` }) }));
                        actions.append(h('button', { class: 'btn small danger', type: 'button', text: t('app.admin.delete'), onclick: act({ url: `api/admin/users/${u.id}`, method: 'DELETE' }) }));
                    }
                }
                row.append(actions);
                list.append(row);
            }
        };
        render();
    });
}

/* ---------------- sidebar init ---------------- */

function initSidebar() {
    $('btn-new-chat').addEventListener('click', newChatModal);
    $('btn-new-group').addEventListener('click', newGroupModal);
    $('chat-title-wrap').addEventListener('click', convInfoModal);
    $('btn-activity').addEventListener('click', activityModal);
    $('btn-admin').addEventListener('click', adminModal);
    $('btn-logout').addEventListener('click', async () => {
        // Drafts are this account's unsent words, held on the device. They go
        // before the session does, so the next person to sign in here never
        // sees them. The same goes for this account's notifications.
        clearDrafts();
        await forgetDevice();
        try { await api('api/logout', { method: 'POST' }); } catch { }
        location.reload();
    });
}

/* ---------------- auth forms ---------------- */

function authError(msg) {
    const el = $('auth-error');
    el.textContent = msg || '';
    el.hidden = !msg;
}

$('tab-login').addEventListener('click', () => {
    $('tab-login').classList.add('active');
    $('tab-register').classList.remove('active');
    $('form-login').hidden = false;
    $('form-register').hidden = true;
    authError();
});
$('tab-register').addEventListener('click', () => {
    $('tab-register').classList.add('active');
    $('tab-login').classList.remove('active');
    $('form-register').hidden = false;
    $('form-login').hidden = true;
    authError();
});

$('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    authError();
    try {
        const { user } = await api('api/login', {
            method: 'POST',
            body: { username: $('login-username').value.trim(), password: $('login-password').value },
        });
        if (user.status === 'pending') showPending();
        else await enterApp();
    } catch (err) { authError(err.message); }
});

$('form-register').addEventListener('submit', async (e) => {
    e.preventDefault();
    authError();
    try {
        const { user } = await api('api/register', {
            method: 'POST',
            body: {
                username: $('reg-username').value.trim(),
                displayName: $('reg-display').value.trim(),
                password: $('reg-password').value,
            },
        });
        if (user.status === 'pending') showPending();
        else await enterApp(); // first user = admin, goes straight in
    } catch (err) { authError(err.message); }
});

$('btn-pending-logout').addEventListener('click', async () => {
    clearInterval(pendingPoll);
    try { await api('api/logout', { method: 'POST' }); } catch { }
    location.reload();
});

applyStatic();
initTheme();
initAuthLanguage();
initInstall();
// Before boot, so a notification tap that opened the app survives the sign-in.
initNotify();
initFooter();
boot();
