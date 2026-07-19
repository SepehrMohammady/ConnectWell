// App orchestrator: boot, auth, WebSocket, sidebar, modals, admin panel.

import { api, postBytes } from './api.js';
import { makeAvatar } from './avatar.js';
import {
    S, $, h, bus, net, toast, popSound, avatarEl, userName, convTitle, convOther,
    fmtListTime, userAvatar, convAvatarSrc,
} from './core.js';
import {
    initChat, openConv, closeConv, renderHeader, onMsgNew, onMsgDeleted, onTyping, markRead, reconcileActive,
} from './chat.js';
import {
    initCalls, onCallState, onCallRing, onCallDeclined, onCallEnded, onRtc, updateChip,
} from './calls.js';

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
    const label = (version ? `v${version} · ` : '') + `© ${new Date().getFullYear()} ConnectWell`;
    for (const el of document.querySelectorAll('.app-foot')) el.textContent = label;
}

/* ---------------- theme ---------------- */

// Cycles system -> light -> dark. The actual resolution lives in js/theme.js so
// the toggle and the pre-paint pass share one implementation.
const THEME_CYCLE = ['system', 'light', 'dark'];
const THEME_TITLE = {
    system: 'Theme: follow device',
    light: 'Theme: light',
    dark: 'Theme: dark',
};

// Shared so the header toggle and the profile selector never disagree.
function paintThemeBtn() {
    const btn = $('btn-theme');
    if (!btn || !window.cwTheme) return;
    const pref = window.cwTheme.preference();
    btn.dataset.pref = pref;
    btn.title = THEME_TITLE[pref];
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

net.send = (t, d) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t, d }));
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
            toast(d.user.displayName + ' registered and awaits approval');
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
    el.title = 'Profile';
    el.append(avatarEl(S.me.displayName, { online: true, src: userAvatar(S.me) }));
    el.append(h('div', {}, [
        h('div', { text: S.me.displayName }),
        h('div', { class: 'uname', text: '@' + S.me.username }),
    ]));
    $('btn-admin').hidden = S.me.role !== 'admin';
}

function previewText(conv) {
    const m = conv.lastMessage;
    if (!m) return conv.type === 'group' ? 'Group created' : 'Say hello';
    if (m.deleted) return 'Message deleted';
    const who = m.senderId === S.me.id ? 'You: ' : (conv.type === 'group' ? userName(m.senderId).split(' ')[0] + ': ' : '');
    switch (m.type) {
        case 'text': return who + (m.content || '');
        case 'image': return who + '📷 Photo';
        case 'video': return who + '🎥 Video';
        case 'videomsg': return who + '🎥 Video message';
        case 'audio': return who + '🎵 Audio';
        case 'voice': return who + '🎤 Voice message';
        case 'system': return m.content || '';
        default: return who + '📄 ' + (m.fileName || 'File');
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
        modal.append(h('h3', { text: 'New chat' }));
        const search = h('input', { type: 'search', placeholder: 'Search people…' });
        const list = h('div', { class: 'list' });
        modal.append(search, list);
        const render = () => {
            list.textContent = '';
            const q = search.value.trim().toLowerCase();
            const users = [...S.users.values()].filter((u) => u.id !== S.me.id
                && (!q || u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q)));
            if (users.length === 0) list.append(h('p', { class: 'muted', text: 'Nobody else has joined yet.' }));
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
        modal.append(h('h3', { text: 'New group' }));
        const name = h('input', { type: 'text', placeholder: 'Group name', maxlength: '50' });
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
        row.append(h('button', { class: 'btn small ghost', type: 'button', text: 'Cancel', onclick: close }));
        row.append(h('button', {
            class: 'btn small', type: 'button', text: 'Create',
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
            modal.append(h('h3', { text: 'Chat details' }));
            const row = h('div', { class: 'user-row' });
            row.append(avatarEl(other?.displayName || 'User', {
                online: other ? S.online.has(other.id) : false, src: userAvatar(other),
            }));
            row.append(h('div', { class: 'u-mid' }, [
                h('div', { class: 'u-name', text: other?.displayName || 'Former member' }),
                h('div', { class: 'u-sub', text: other ? '@' + other.username + (S.online.has(other.id) ? ' · online' : ' · offline') : '' }),
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
                class: 'btn small ghost', type: 'button', text: 'Rename',
                onclick: async () => {
                    try { await api('api/conversations/' + conv.id, { method: 'PATCH', body: { name: name.value } }); close(); }
                    catch (e) { toast(e.message); }
                },
            });
            const r = h('div', { class: 'modal-row' });
            r.append(name, save);
            modal.append(r);
        }

        modal.append(h('p', { class: 'muted', text: conv.members.length + ' members' }));
        const list = h('div', { class: 'list' });
        modal.append(list);
        for (const uid of conv.members) {
            const u = uid === S.me.id ? S.me : S.users.get(uid);
            const row = h('div', { class: 'user-row' });
            row.append(avatarEl(u?.displayName || 'User', { online: S.online.has(uid), src: userAvatar(u) }));
            row.append(h('div', { class: 'u-mid' }, [
                h('div', { class: 'u-name', text: (u?.displayName || 'Former member') + (uid === conv.createdBy ? ' · creator' : '') }),
                h('div', { class: 'u-sub', text: u ? '@' + u.username : '' }),
            ]));
            if (mayManage && uid !== S.me.id) {
                row.append(h('button', {
                    class: 'btn small ghost', type: 'button', text: 'Remove',
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
            sel.append(h('option', { value: '', text: 'Add member…' }));
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
            class: 'btn small danger', type: 'button', text: 'Leave group',
            onclick: async () => {
                if (!confirm('Leave this group?')) return;
                try { await api('api/conversations/' + conv.id + '/members/' + S.me.id, { method: 'DELETE' }); close(); }
                catch (e) { toast(e.message); }
            },
        }));
        modal.append(r2);
    });
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
            notify('Preview ready — press Save photo to apply.');
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
        h('button', { class: 'btn small ghost', type: 'button', text: 'Choose photo', onclick: () => input.click() }),
        h('button', {
            class: 'btn small', type: 'button', text: 'Save photo',
            onclick: busy(async () => {
                if (!pending) return notify('Choose a photo first.', true);
                const next = await onSave(pending);
                pending = null;
                clearPreview();
                shownSrc = next || null;
                paint();
                notify('Photo updated.');
            }),
        }),
        h('button', {
            class: 'btn small ghost', type: 'button', text: 'Remove',
            onclick: busy(async () => {
                await onRemove();
                pending = null;
                clearPreview();
                shownSrc = null;
                paint();
                notify('Photo removed.');
            }),
        }),
    ]);

    return { holder, actions, dispose: clearPreview };
}

/* ---------------- profile ---------------- */

function profileModal() {
    openModal((modal, close) => {
        modal.append(h('h3', { text: 'Profile' }));

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
        modal.append(h('label', { class: 'field-label', text: 'Display name' }));
        const nameInput = h('input', { type: 'text', value: S.me.displayName, maxlength: '50' });
        modal.append(nameInput, h('button', {
            class: 'btn small', type: 'button', text: 'Save name',
            onclick: guard(async () => {
                const { user } = await api('api/me', { method: 'PATCH', body: { displayName: nameInput.value } });
                S.me = user;
                renderMe();
                renderConvList();
                renderHeader();
                say('Name updated.');
            }),
        }));

        /* theme */
        modal.append(h('label', { class: 'field-label', text: 'Theme' }));
        const seg = h('div', { class: 'seg' });
        const paintSeg = () => {
            const cur = window.cwTheme ? window.cwTheme.preference() : 'system';
            seg.textContent = '';
            for (const [value, label] of [['system', 'Device'], ['light', 'Light'], ['dark', 'Dark']]) {
                seg.append(h('button', {
                    class: 'seg-opt' + (cur === value ? ' active' : ''), type: 'button', text: label,
                    onclick: () => { window.cwTheme?.set(value); paintThemeBtn(); paintSeg(); },
                }));
            }
        };
        paintSeg();
        modal.append(seg);

        /* password */
        modal.append(h('label', { class: 'field-label', text: 'Change password' }));
        const curPw = h('input', { type: 'password', placeholder: 'Current password', autocomplete: 'current-password' });
        const newPw = h('input', { type: 'password', placeholder: 'New password (min 8 characters)', autocomplete: 'new-password' });
        modal.append(curPw, newPw, h('button', {
            class: 'btn small', type: 'button', text: 'Update password',
            onclick: guard(async () => {
                await api('api/me/password', {
                    method: 'POST',
                    body: { currentPassword: curPw.value, newPassword: newPw.value },
                });
                curPw.value = '';
                newPw.value = '';
                say('Password updated. Your other devices were signed out.');
            }),
        }));

        modal.append(note);
        modal.append(h('div', { class: 'modal-row' }, [
            h('div', { class: 'rec-spacer' }),
            h('button', {
                class: 'btn small ghost', type: 'button', text: 'Close',
                onclick: () => { picker.dispose(); close(); },
            }),
        ]));
    });
}

/* ---------------- admin ---------------- */

async function adminModal() {
    S.pendingCount = 0;
    renderAdminBadge();
    let users;
    try { users = (await api('api/admin/users')).users; }
    catch (e) { toast(e.message); return; }

    openModal((modal, close) => {
        modal.append(h('h3', { text: 'Admin — members' }));
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
            for (const t of ['pending', 'active', 'blocked']) {
                tabs.append(h('button', {
                    class: 'admin-tab' + (tab === t ? ' active' : ''), type: 'button',
                    text: t[0].toUpperCase() + t.slice(1) + (counts[t] ? ` (${counts[t]})` : ''),
                    onclick: () => { tab = t; render(); },
                }));
            }
            list.textContent = '';
            const rows = users.filter((u) => u.status === tab);
            if (rows.length === 0) list.append(h('p', { class: 'muted', text: 'Nobody here.' }));
            for (const u of rows) {
                const row = h('div', { class: 'user-row' });
                // The admin list is fetched separately, so this row object -- not
                // S.users -- is the only source for pending/blocked accounts.
                row.append(avatarEl(u.displayName, { src: userAvatar(u) }));
                row.append(h('div', { class: 'u-mid' }, [
                    h('div', { class: 'u-name', text: u.displayName + (u.role === 'admin' ? ' · admin' : '') }),
                    h('div', { class: 'u-sub', text: '@' + u.username }),
                ]));
                const actions = h('div', { class: 'u-actions' });
                if (u.role !== 'admin') {
                    if (u.status === 'pending') {
                        actions.append(h('button', { class: 'btn small', type: 'button', text: 'Approve', onclick: act({ url: `api/admin/users/${u.id}/approve` }) }));
                        actions.append(h('button', { class: 'btn small ghost', type: 'button', text: 'Block', onclick: act({ url: `api/admin/users/${u.id}/block` }) }));
                    } else if (u.status === 'active') {
                        actions.append(h('button', { class: 'btn small ghost', type: 'button', text: 'Block', onclick: act({ url: `api/admin/users/${u.id}/block` }) }));
                    } else if (u.status === 'blocked') {
                        actions.append(h('button', { class: 'btn small', type: 'button', text: 'Unblock', onclick: act({ url: `api/admin/users/${u.id}/unblock` }) }));
                        actions.append(h('button', { class: 'btn small danger', type: 'button', text: 'Delete', onclick: act({ url: `api/admin/users/${u.id}`, method: 'DELETE' }) }));
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

initTheme();
initFooter();
boot();
