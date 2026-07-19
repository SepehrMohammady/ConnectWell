// App orchestrator: boot, auth, WebSocket, sidebar, modals, admin panel.

import { api, postBytes } from './api.js';
import { makeAvatar } from './avatar.js';
import {
    S, $, h, bus, net, toast, popSound, avatarEl, userName, convTitle, convOther,
    fmtListTime, userAvatar, convAvatarSrc,
} from './core.js';
import {
    initChat, openConv, closeConv, renderHeader, onMsgNew, onMsgDeleted, onTyping, markRead, reconcileActive,
    sysText, onMsgReaction,
} from './chat.js';
import {
    initCalls, onCallState, onCallRing, onCallDeclined, onCallEnded, onRtc, updateChip,
} from './calls.js';
import { t, applyStatic } from './i18n.js';

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
    try { version = (await api('api/health')).version || ''; }
    catch { /* unreachable server: still show the copyright */ }
    // One key per shape rather than glued fragments: a translator must be able to
    // move the year and the version around each other. 'ConnectWell' is passed in as
    // a slot so the brand itself never enters a dictionary.
    const vars = { version, year: new Date().getFullYear(), brand: 'ConnectWell' };
    const label = version ? t('app.footer.copyrightVersion', vars) : t('app.footer.copyright', vars);
    for (const el of document.querySelectorAll('.app-foot')) el.textContent = label;
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
}

function applyBootstrap(data) {
    S.me = data.me;
    S.users = new Map(data.users.map((u) => [u.id, u]));
    S.convs = new Map(data.conversations.map((c) => [c.id, c]));
    S.online = new Set(data.online);
    S.calls = new Map(data.calls.map((c) => [c.convId, c]));
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
        }
        onMsgNew(m);
        renderConvList();
    },
    'msg:deleted'(d) {
        const conv = S.convs.get(d.convId);
        if (conv?.lastMessage?.id === d.messageId) conv.lastMessage.deleted = true;
        onMsgDeleted(d.convId, d.messageId);
        renderConvList();
    },
    'msg:reaction'(d) { onMsgReaction(d.convId, d.messageId, d.reactions); },
    'conv:new'(d) {
        S.convs.set(d.conversation.id, d.conversation);
        renderConvList();
    },
    'conv:updated'(d) {
        const conv = S.convs.get(d.conversation.id);
        const unread = conv?.unread || 0;
        S.convs.set(d.conversation.id, { ...d.conversation, unread });
        renderConvList();
        if (S.activeConvId === d.conversation.id) renderHeader();
    },
    'conv:removed'(d) {
        S.convs.delete(d.convId);
        S.msgs.delete(d.convId);
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
    'call:state'(d) { onCallState(d); },
    'call:ring'(d) { onCallRing(d); },
    'call:declined'(d) { onCallDeclined(d); },
    'call:ended'(d) { onCallEnded(d); },
    rtc(d) { onRtc(d); },
};

/* ---------------- sidebar ---------------- */

function renderMe() {
    const el = $('sb-me');
    el.textContent = '';
    el.onclick = profileModal;          // the row itself opens the profile
    el.title = t('app.sidebar.meTitle');
    el.append(avatarEl(S.me.displayName, { online: true, src: userAvatar(S.me) }));
    el.append(h('div', {}, [
        h('div', { text: S.me.displayName }),
        h('div', { class: 'uname', text: '@' + S.me.username }),
    ]));
    $('btn-admin').hidden = S.me.role !== 'admin';
}

function previewText(conv) {
    const m = conv.lastMessage;
    if (!m) return conv.type === 'group' ? t('app.preview.groupCreated') : t('app.preview.sayHello');
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

function updateTitle() {
    let total = 0;
    for (const c of S.convs.values()) total += c.unread || 0;
    document.title = (total > 0 ? `(${total}) ` : '') + 'ConnectWell';
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
    const close = () => { root.hidden = true; root.textContent = ''; };
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

function newChatModal() {
    openModal((modal, close) => {
        modal.append(h('h3', { text: t('app.newChat.title') }));
        const search = h('input', { type: 'search', placeholder: t('app.newChat.searchPlaceholder') });
        const list = h('div', { class: 'list' });
        modal.append(search, list);
        const render = () => {
            list.textContent = '';
            const q = search.value.trim().toLowerCase();
            const users = [...S.users.values()].filter((u) => u.id !== S.me.id
                && (!q || u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q)));
            if (users.length === 0) list.append(h('p', { class: 'muted', text: t('app.newChat.empty') }));
            for (const u of users) {
                list.append(userRowBtn(u, async () => {
                    try {
                        const { conversation } = await api('api/conversations', {
                            method: 'POST', body: { type: 'direct', userId: u.id },
                        });
                        S.convs.set(conversation.id, conversation);
                        close();
                        openConv(conversation.id);
                        renderConvList();
                    } catch (e) { toast(e.message); }
                }));
            }
        };
        search.addEventListener('input', render);
        render();
    });
}

function newGroupModal() {
    openModal((modal, close) => {
        modal.append(h('h3', { text: t('app.newGroup.title') }));
        const name = h('input', { type: 'text', placeholder: t('app.newGroup.namePlaceholder'), maxlength: '50' });
        const list = h('div', { class: 'list' });
        const picked = new Set();
        modal.append(name, list);
        for (const u of [...S.users.values()].filter((x) => x.id !== S.me.id)) {
            const cb = h('input', { type: 'checkbox' });
            cb.addEventListener('change', () => { cb.checked ? picked.add(u.id) : picked.delete(u.id); });
            const row = h('label', { class: 'user-row' });
            row.append(cb, avatarEl(u.displayName, { src: userAvatar(u) }), h('div', { class: 'u-mid' }, [
                h('div', { class: 'u-name', text: u.displayName }),
                h('div', { class: 'u-sub', text: '@' + u.username }),
            ]));
            list.append(row);
        }
        const row = h('div', { class: 'modal-row' });
        row.append(h('div', { class: 'rec-spacer' }));
        row.append(h('button', { class: 'btn small ghost', type: 'button', text: t('app.newGroup.cancel'), onclick: close }));
        row.append(h('button', {
            class: 'btn small', type: 'button', text: t('app.newGroup.create'),
            onclick: async () => {
                try {
                    const { conversation } = await api('api/conversations', {
                        method: 'POST', body: { type: 'group', name: name.value, memberIds: [...picked] },
                    });
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

        const addable = [...S.users.values()].filter((u) => !conv.members.includes(u.id));
        if (addable.length) {
            const sel = h('select');
            sel.append(h('option', { value: '', text: t('app.convInfo.addMember') }));
            for (const u of addable) sel.append(h('option', { value: String(u.id), text: u.displayName }));
            sel.addEventListener('change', async () => {
                if (!sel.value) return;
                try { await api('api/conversations/' + conv.id + '/members', { method: 'POST', body: { userId: Number(sel.value) } }); close(); }
                catch (e) { toast(e.message); }
            });
            const r = h('div', { class: 'modal-row' });
            r.append(sel);
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
        holder.append(avatarEl(name, { size: 'big', group, src: previewUrl || shownSrc }));
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

        /* language */
        modal.append(h('label', { class: 'field-label', text: t('app.profile.language') }));
        modal.append(languageSeg(say));

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
            for (const status of ['pending', 'active', 'blocked']) {
                const label = t(ADMIN_TAB_KEY[status]);
                tabs.append(h('button', {
                    class: 'admin-tab' + (tab === status ? ' active' : ''), type: 'button',
                    text: counts[status] ? t('app.admin.tabCount', { label, n: counts[status] }) : label,
                    onclick: () => { tab = status; render(); },
                }));
            }
            list.textContent = '';
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
                if (u.role !== 'admin') {
                    if (u.status === 'pending') {
                        actions.append(h('button', { class: 'btn small', type: 'button', text: t('app.admin.approve'), onclick: act({ url: `api/admin/users/${u.id}/approve` }) }));
                        actions.append(h('button', { class: 'btn small ghost', type: 'button', text: t('app.admin.block'), onclick: act({ url: `api/admin/users/${u.id}/block` }) }));
                    } else if (u.status === 'active') {
                        actions.append(h('button', { class: 'btn small ghost', type: 'button', text: t('app.admin.block'), onclick: act({ url: `api/admin/users/${u.id}/block` }) }));
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
    $('btn-admin').addEventListener('click', adminModal);
    $('btn-logout').addEventListener('click', async () => {
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
initFooter();
boot();
