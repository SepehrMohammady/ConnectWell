// Chat pane: message rendering, composer, uploads, voice & video messages.

import { api, upload } from './api.js';
import { t, has } from './i18n.js';
import {
    S, $, h, bus, net, toast, avatarEl, userName, convTitle, convOther,
    fmtTime, fmtDay, sameDay, fmtSize, fmtDur, userById, userAvatar, convAvatarSrc,
} from './core.js';

const MIC_SVG = 'M12 14c1.7 0 3-1.3 3-3V5c0-1.7-1.3-3-3-3S9 3.3 9 5v6c0 1.7 1.3 3 3 3zm5.3-3c0 3-2.5 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.4 2.7 6.2 6 6.7V21h2v-3.3c3.3-.5 6-3.3 6-6.7h-1.7z';
const FILE_SVG = 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z';
const REACT_SVG = 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z';
const FWD_SVG = 'M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z';
const DL_SVG = 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z';

// Must match REACTIONS in lib/util.js exactly (the server rejects anything else).
const REACTIONS = ['👍', '👎', '❤️', '😂', '😮', '😢', '🙏', '🎉', '😡', '👏'];

function svgIcon(d, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    if (cls) svg.setAttribute('class', cls);
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.append(p);
    return svg;
}

function msgStore(convId) {
    if (!S.msgs.has(convId)) S.msgs.set(convId, { list: [], ids: new Set(), complete: false, loading: false });
    return S.msgs.get(convId);
}

/* ---------------- open / render conversation ---------------- */

export async function openConv(convId) {
    const conv = S.convs.get(convId);
    if (!conv) return;
    S.activeConvId = convId;
    clearTyping(); // typing state is per-open-conversation; drop stale indicators
    $('view-app').classList.add('mobile-chat-open');
    $('chat-empty').hidden = true;
    $('chat-ui').hidden = false;
    renderHeader();
    bus.emit('conv-opened', convId);

    const store = msgStore(convId);
    if (store.list.length === 0 && !store.complete) {
        store.loading = true;
        try {
            const { messages } = await api('api/conversations/' + convId + '/messages?limit=50');
            for (const m of messages) if (!store.ids.has(m.id)) { store.ids.add(m.id); store.list.push(m); }
            store.list.sort((a, b) => a.id - b.id);
            store.complete = messages.length < 50;
        } catch (e) { toast(e.message); }
        store.loading = false;
    }
    if (S.activeConvId !== convId) return; // switched away while loading
    renderAll(convId);
    scrollBottom();
    markRead(convId);
}

export function closeConv() {
    S.activeConvId = null;
    clearTyping();
    $('view-app').classList.remove('mobile-chat-open');
    $('chat-ui').hidden = true;
    $('chat-empty').hidden = false;
}

export function renderHeader() {
    const conv = S.convs.get(S.activeConvId);
    if (!conv) return;
    $('chat-title').textContent = convTitle(conv);
    const av = $('chat-avatar');
    av.replaceWith(Object.assign(
        avatarEl(convTitle(conv), { group: conv.type === 'group', src: convAvatarSrc(conv) }),
        { id: 'chat-avatar' }));
    if (conv.type === 'group') {
        $('chat-sub').textContent = t('chat.members', { n: conv.members.length });
    } else {
        const other = convOther(conv);
        $('chat-sub').textContent = S.online.has(other) ? t('chat.online') : t('chat.offline');
    }
}

function renderAll(convId) {
    const list = $('msg-list');
    list.textContent = '';
    const store = msgStore(convId);
    let prevTs = 0;
    for (const m of store.list) {
        if (!prevTs || !sameDay(prevTs, m.createdAt)) {
            list.append(h('div', { class: 'day-sep', text: fmtDay(m.createdAt) }));
        }
        prevTs = m.createdAt;
        list.append(msgEl(m));
    }
}

/* ---------------- message elements ---------------- */

function linkify(text) {
    const frag = document.createDocumentFragment();
    const re = /https?:\/\/[^\s<>"']+/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
        if (m.index > last) frag.append(text.slice(last, m.index));
        frag.append(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer', text: m[0] }));
        last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
}

// A message whose file was reclaimed keeps its place in the conversation and says
// so. The name and size survive the purge precisely so this can be specific.
// Told at the point it matters — when a file is actually being shared — and only
// once per device, so it informs rather than nags. The same wording lives
// permanently in the profile's Storage section for anyone who dismissed it.
const ATTACH_NOTE_KEY = 'cw_seen_storage_note';

function showAttachNote() {
    const el = $('attach-note');
    if (!el || !el.hidden) return;
    try {
        if (localStorage.getItem(ATTACH_NOTE_KEY)) return;
    } catch { /* private mode: show it, just do not remember */ }

    el.textContent = '';
    el.append(h('span', { text: t('chat.storage_note') }));
    el.append(h('button', {
        class: 'btn small ghost', type: 'button', text: t('chat.storage_note_ok'),
        onclick: () => {
            el.hidden = true;
            try { localStorage.setItem(ATTACH_NOTE_KEY, '1'); } catch { /* private mode */ }
        },
    }));
    el.hidden = false;
}

function purgedChip(m) {
    const label = m.fileName
        || (m.type === 'voice' ? t('chat.purged_voice')
            : m.type === 'videomsg' ? t('chat.purged_video') : t('chat.purged_file'));
    const chip = h('div', {
        class: 'file-chip file-gone', role: 'note',
        title: t('chat.purged_title'),
    });
    chip.append(svgIcon(FILE_SVG));
    chip.append(h('div', {}, [
        h('div', { class: 'fc-name', text: label }),
        h('div', {
            class: 'fc-size',
            text: m.fileSize
                ? t('chat.purged_removed_size', { size: fmtSize(m.fileSize) })
                : t('chat.purged_removed'),
        }),
    ]));
    return chip;
}

function bubbleContent(m) {
    // Driven by the flag, and returning before `src` exists. Falling back on a
    // failed request instead would be wrong twice over: responses are cached
    // immutably for a year, so viewers would disagree about the same message —
    // and the document branch below builds a download anchor, which saves the
    // 404 JSON body to disk under the original filename.
    if (m.purged && m.type !== 'text' && m.type !== 'system') return purgedChip(m);

    const src = 'api/files/' + m.id;
    // Self-heal a tab left open across a purge, and the one case the flag cannot
    // cover: bytes lost while the row still claims the file is there.
    const gone = (el) => () => { m.purged = true; el.replaceWith(purgedChip(m)); };
    switch (m.type) {
        case 'text':
            return linkify(m.content || '');
        case 'image': {
            const img = h('img', { class: 'msg-img', src, alt: m.fileName || t('chat.image_alt'), loading: 'lazy' });
            img.addEventListener('click', () => showLightbox(src, m.fileName));
            img.addEventListener('error', gone(img));
            return img;
        }
        case 'video':
        case 'videomsg': {
            const v = h('video', { class: 'msg-video', src, controls: '', playsinline: '', preload: 'metadata' });
            v.addEventListener('error', gone(v));
            return v;
        }
        case 'audio': {
            const a = h('audio', { src, controls: '', preload: 'metadata' });
            a.addEventListener('error', gone(a));
            return a;
        }
        case 'voice': {
            const row = h('div', { class: 'voice-row' });
            const a = h('audio', { src, controls: '', preload: 'metadata' });
            a.addEventListener('error', gone(row));
            row.append(svgIcon(MIC_SVG));
            row.append(a);
            if (m.duration) row.append(h('span', { class: 'muted', text: fmtDur(m.duration) }));
            return row;
        }
        default: { // document
            const a = h('a', { class: 'file-chip', href: src, download: m.fileName || 'file' });
            a.append(svgIcon(FILE_SVG));
            const mid = h('div', {}, [
                h('div', { class: 'fc-name', text: m.fileName || 'file' }),
                h('div', { class: 'fc-size', text: fmtSize(m.fileSize || 0) }),
            ]);
            a.append(mid);
            return a;
        }
    }
}

// A system event carries a key plus arguments, so each viewer reads it in their
// own language. Rows written before that existed — and any key introduced by a
// newer server than this build knows — fall back to the English sentence the
// server also stores in `content`.
export function sysText(m) {
    if (m.sysKey && has(m.sysKey)) return t(m.sysKey, m.sysArgs || {});
    return m.content || '';
}

function msgEl(m) {
    if (m.type === 'system') {
        return h('div', { class: 'msg-sys', text: sysText(m), dataset: { mid: m.id } });
    }
    const mine = m.senderId === S.me.id;
    const conv = S.convs.get(m.conversationId);
    const row = h('div', { class: 'msg-row' + (mine ? ' mine' : ''), dataset: { mid: m.id } });
    if (!mine && conv?.type === 'group') {
        row.append(avatarEl(userName(m.senderId), {
            size: 'small', src: userAvatar(userById(m.senderId)),
        }));
    }
    const bubble = h('div', { class: 'bubble' + (m.deleted ? ' deleted' : '') });
    if (!mine && conv?.type === 'group') {
        bubble.append(h('div', { class: 'sender', text: userName(m.senderId) }));
    }
    // Original owner of a forwarded message, by unique username. Absent when the
    // forwarder forwarded their own message.
    if (!m.deleted && m.fwdFrom) {
        // The username is isolated in a <bdi> so a Latin handle inside an RTL
        // (Farsi) bubble does not reorder the '@' to the wrong side.
        const tag = h('div', { class: 'fwd-tag', title: t('chat.fwd_from', { username: m.fwdFrom }) });
        tag.append(document.createTextNode('↪ '));
        tag.append(h('bdi', { text: '@' + m.fwdFrom }));
        bubble.append(tag);
    }
    if (m.deleted) {
        bubble.append(t('chat.msg_deleted'));
    } else {
        bubble.append(bubbleContent(m));
        bubble.append(h('span', { class: 'meta', text: fmtTime(m.createdAt) }));
        if (mine) {
            const del = h('button', { class: 'msg-del', title: t('chat.del_title'), type: 'button', text: '✕' });
            del.addEventListener('click', async () => {
                if (!confirm(t('chat.del_confirm'))) return;
                try { await api('api/messages/' + m.id, { method: 'DELETE' }); }
                catch (e) { toast(e.message); }
            });
            bubble.append(del);
        }
    }

    // bubble and its reaction chips share a column so the chips sit under it.
    const col = h('div', { class: 'msg-col' });
    col.append(bubble);
    const reacts = reactionsEl(m);
    if (reacts) col.append(reacts);

    const acts = m.deleted ? null : msgActions(m, mine);
    // Own messages sit at the inline end, so their actions go on the inner side.
    if (acts && mine) row.append(acts);
    row.append(col);
    if (acts && !mine) row.append(acts);
    return row;
}

/* ---------------- reactions ---------------- */

function reactionsEl(m) {
    if (m.deleted || !m.reactions || !m.reactions.length) return null;
    const conv = S.convs.get(m.conversationId);
    const direct = conv?.type === 'direct';
    const ownMsg = m.senderId === S.me.id;
    const wrap = h('div', { class: 'msg-reacts' });
    for (const r of m.reactions) {
        const mineR = r.userIds.includes(S.me.id);
        const chip = h('button', {
            class: 'react-chip' + (mineR ? ' mine' : '') + (ownMsg ? ' static' : ''), type: 'button',
            title: r.userIds.map((id) => userName(id)).slice(0, 12).join(', '),
        });
        chip.append(h('span', { class: 'rc-emoji', text: r.emoji }));
        // In a direct chat only the other side can react, so the count is always
        // one — showing it would be noise. Groups keep the number.
        if (!direct) chip.append(h('span', { class: 'rc-count', text: String(r.userIds.length) }));
        // The sender cannot react to their own message, so on own messages the
        // chips are display-only.
        if (!ownMsg) chip.addEventListener('click', () => toggleReaction(m, r.emoji));
        wrap.append(chip);
    }
    return wrap;
}

/* ---------------- per-message actions ---------------- */

function msgActions(m, mine) {
    const acts = h('div', { class: 'msg-acts' });
    // Reacting is for the audience, never the sender.
    if (!mine) {
        const rb = h('button', { class: 'msg-act', title: t('chat.react'), type: 'button' });
        rb.append(svgIcon(REACT_SVG));
        rb.addEventListener('click', (e) => { e.stopPropagation(); openReactionPicker(rb, m); });
        acts.append(rb);
    }
    // A purged message has nothing left to forward or save.
    if (!m.purged) {
        const fb = h('button', { class: 'msg-act', title: t('chat.forward'), type: 'button' });
        fb.append(svgIcon(FWD_SVG, 'ic-dir'));      // directional glyph: mirrors under RTL
        fb.addEventListener('click', (e) => { e.stopPropagation(); forwardModal(m); });
        acts.append(fb);
        if (m.fileSize != null) {
            const dl = h('a', {
                class: 'msg-act', title: t('chat.download'),
                href: 'api/files/' + m.id, download: m.fileName || 'file',
            });
            dl.append(svgIcon(DL_SVG));
            acts.append(dl);
        }
    }
    return acts.children.length ? acts : null;
}

function forwardModal(m) {
    // A small local modal on #modal-root; app.js's helper is not importable from
    // here without creating a module cycle.
    const root = $('modal-root');
    root.textContent = '';
    const modal = h('div', { class: 'modal' });
    root.append(modal);
    root.hidden = false;
    const close = () => { root.hidden = true; root.textContent = ''; root.onclick = null; };
    root.onclick = (e) => { if (e.target === root) close(); };

    modal.append(h('h3', { text: t('chat.fwd_title') }));
    const list = h('div', { class: 'list' });
    modal.append(list);
    const convs = [...S.convs.values()].sort((a, b) =>
        (b.lastMessage?.createdAt || b.createdAt) - (a.lastMessage?.createdAt || a.createdAt));
    for (const conv of convs) {
        const row = h('button', { class: 'user-row', type: 'button' });
        row.append(avatarEl(convTitle(conv), { group: conv.type === 'group', src: convAvatarSrc(conv) }));
        row.append(h('div', { class: 'u-mid' }, [h('div', { class: 'u-name', text: convTitle(conv) })]));
        row.addEventListener('click', async () => {
            close();
            try {
                await api('api/messages/' + m.id + '/forward', { method: 'POST', body: { convId: conv.id } });
                toast(t('chat.fwd_done'));
            } catch (e) { toast(e.message); }
        });
        list.append(row);
    }
}

// The server decides add vs remove from current state; the UI updates when the
// resulting msg:reaction broadcast comes back (to this device too).
async function toggleReaction(m, emoji) {
    try { await api('api/messages/' + m.id + '/react', { method: 'POST', body: { emoji } }); }
    catch (e) { toast(e.message); }
}

let pickerEl = null;
function closeReactionPicker() {
    if (!pickerEl) return;
    pickerEl.remove();
    pickerEl = null;
    document.removeEventListener('click', onPickerOutside, true);
    document.removeEventListener('keydown', onPickerKey, true);
    window.removeEventListener('resize', closeReactionPicker);
    $('msg-scroll')?.removeEventListener('scroll', closeReactionPicker);
}
function onPickerOutside(e) { if (pickerEl && !pickerEl.contains(e.target)) closeReactionPicker(); }
function onPickerKey(e) { if (e.key === 'Escape') closeReactionPicker(); }

function openReactionPicker(anchor, m) {
    closeReactionPicker();
    const p = h('div', { class: 'react-picker', role: 'menu' });
    for (const emoji of REACTIONS) {
        const b = h('button', { class: 'react-opt', type: 'button', text: emoji, title: emoji });
        b.addEventListener('click', () => { closeReactionPicker(); toggleReaction(m, emoji); });
        p.append(b);
    }
    document.body.append(p);
    pickerEl = p;

    // Position above the trigger, clamped to the viewport; flip below if cramped.
    // Programmatic .style is fine under the CSP (that governs style attributes in
    // markup, not the CSSOM).
    const a = anchor.getBoundingClientRect();
    let left = a.left + a.width / 2 - p.offsetWidth / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - p.offsetWidth - 8));
    let top = a.top - p.offsetHeight - 8;
    if (top < 8) top = a.bottom + 8;
    p.style.left = Math.round(left) + 'px';
    p.style.top = Math.round(top) + 'px';

    // Defer, so the click that opened the picker does not immediately close it.
    setTimeout(() => {
        document.addEventListener('click', onPickerOutside, true);
        document.addEventListener('keydown', onPickerKey, true);
        window.addEventListener('resize', closeReactionPicker);
        $('msg-scroll')?.addEventListener('scroll', closeReactionPicker, { passive: true });
    }, 0);
}

// Update only the reaction chips, never the whole message — re-rendering the
// bubble would restart a playing video or reload an image on every reaction.
export function onMsgReaction(convId, messageId, reactions) {
    const m = S.msgs.get(convId)?.list.find((x) => x.id === messageId);
    if (m) m.reactions = reactions;
    if (S.activeConvId !== convId || !m) return;
    const col = document.querySelector('#msg-list [data-mid="' + messageId + '"] .msg-col');
    if (!col) return;
    const existing = col.querySelector('.msg-reacts');
    const fresh = reactionsEl(m);
    if (existing && fresh) existing.replaceWith(fresh);
    else if (existing) existing.remove();
    else if (fresh) col.append(fresh);
}

/* ---------------- incoming events ---------------- */

export function onMsgNew(m) {
    const store = S.msgs.has(m.conversationId) ? msgStore(m.conversationId) : null;
    if (store && !store.ids.has(m.id)) {
        store.ids.add(m.id);
        store.list.push(m);
        if (S.activeConvId === m.conversationId) {
            const scroller = $('msg-scroll');
            const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
            const list = $('msg-list');
            const prev = store.list[store.list.length - 2];
            if (!prev || !sameDay(prev.createdAt, m.createdAt)) {
                list.append(h('div', { class: 'day-sep', text: fmtDay(m.createdAt) }));
            }
            list.append(msgEl(m));
            if (nearBottom || m.senderId === S.me.id) scrollBottom();
            if (!document.hidden) markRead(m.conversationId);
        }
    }
}

export function onMsgDeleted(convId, messageId) {
    const store = S.msgs.get(convId);
    if (store) {
        const m = store.list.find((x) => x.id === messageId);
        if (m) { m.deleted = true; m.content = null; }
    }
    if (S.activeConvId === convId) {
        const el = document.querySelector('#msg-list [data-mid="' + messageId + '"]');
        if (el) {
            const store2 = msgStore(convId);
            const m = store2.list.find((x) => x.id === messageId);
            if (m) el.replaceWith(msgEl(m));
        }
    }
}

export function markRead(convId) {
    const conv = S.convs.get(convId);
    const store = S.msgs.get(convId);
    if (!conv) return;
    conv.unread = 0;
    bus.emit('convs-changed');
    const lastId = store?.list[store.list.length - 1]?.id
        || conv.lastMessage?.id || 0;
    if (lastId) api('api/conversations/' + convId + '/read', { method: 'POST', body: { messageId: lastId } }).catch(() => { });
}

// After a WS reconnect, pull any messages that arrived in the open conversation
// while the socket was down — those were never delivered via 'msg:new'.
export async function reconcileActive() {
    const convId = S.activeConvId;
    if (!convId) return;
    const store = msgStore(convId);
    if (store.list.length === 0) return; // nothing loaded yet — openConv fetches
    let cursor = store.list[store.list.length - 1].id;
    let added = false;
    try {
        while (true) {
            const { messages } = await api('api/conversations/' + convId + '/messages?after=' + cursor + '&limit=100');
            if (!messages.length) break;
            for (const m of messages) {
                if (!store.ids.has(m.id)) { store.ids.add(m.id); store.list.push(m); added = true; }
            }
            cursor = messages[messages.length - 1].id;
            if (messages.length < 100) break;
        }
    } catch { return; }
    if (added && S.activeConvId === convId) {
        store.list.sort((a, b) => a.id - b.id);
        renderAll(convId);
        scrollBottom();
        markRead(convId);
    }
}

/* ---------------- typing indicator ---------------- */

const typingTimers = new Map(); // userId -> timeout
export function onTyping(convId, userId) {
    if (convId !== S.activeConvId || userId === S.me.id) return;
    clearTimeout(typingTimers.get(userId));
    typingTimers.set(userId, setTimeout(() => { typingTimers.delete(userId); renderTyping(); }, 3000));
    renderTyping();
}

function clearTyping() {
    for (const timer of typingTimers.values()) clearTimeout(timer);
    typingTimers.clear();
    renderTyping();
}

function renderTyping() {
    const names = [...typingTimers.keys()].map(userName);
    const el = $('typing-line');
    if (names.length === 0) { el.hidden = true; return; }
    el.textContent = t('chat.typing', { names: names.join(', '), n: names.length });
    el.hidden = false;
}

/* ---------------- scrolling / pagination ---------------- */

function scrollBottom() {
    const sc = $('msg-scroll');
    sc.scrollTop = sc.scrollHeight;
}

async function maybeLoadOlder() {
    const convId = S.activeConvId;
    if (!convId) return;
    const store = msgStore(convId);
    if (store.loading || store.complete || store.list.length === 0) return;
    const sc = $('msg-scroll');
    if (sc.scrollTop > 60) return;
    store.loading = true;
    const oldest = store.list[0].id;
    try {
        const { messages } = await api('api/conversations/' + convId + '/messages?limit=50&before=' + oldest);
        if (messages.length < 50) store.complete = true;
        const fresh = messages.filter((m) => !store.ids.has(m.id));
        for (const m of fresh) store.ids.add(m.id);
        store.list = fresh.concat(store.list).sort((a, b) => a.id - b.id);
        if (S.activeConvId === convId && fresh.length) {
            const prevHeight = sc.scrollHeight;
            renderAll(convId);
            sc.scrollTop = sc.scrollHeight - prevHeight + sc.scrollTop;
        }
    } catch { /* transient */ }
    store.loading = false;
}

/* ---------------- composer ---------------- */

let lastTypingSent = 0;

async function sendText() {
    const input = $('composer-input');
    const content = input.value.trim();
    if (!content || !S.activeConvId) return;
    input.value = '';
    autosize();
    try {
        const { message } = await api('api/conversations/' + S.activeConvId + '/messages', {
            method: 'POST', body: { content },
        });
        onMsgNew(message);           // ws echo is deduped by id
        bus.emit('msg-sent', message);
    } catch (e) { toast(e.message); }
}

function autosize() {
    const el = $('composer-input');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 130) + 'px';
}

/* ---------------- uploads ---------------- */

async function uploadBlob(blob, { fileName, mime, msgType, duration }) {
    const convId = S.activeConvId;
    if (!convId) return;
    const list = $('msg-list');
    const bar = h('i');
    const temp = h('div', { class: 'msg-row mine' }, [
        h('div', { class: 'bubble upload-bubble' }, [
            h('div', { class: 'up-name', text: t('chat.uploading', { name: fileName || 'file' }) }),
            h('div', { class: 'progress' }, [bar]),
        ]),
    ]);
    list.append(temp);
    scrollBottom();
    try {
        const { message } = await upload(convId, blob, {
            fileName, mime, msgType, duration,
            onProgress: (f) => { bar.style.width = Math.round(f * 100) + '%'; },
        });
        temp.remove();
        onMsgNew(message);
        bus.emit('msg-sent', message);
    } catch (e) {
        temp.querySelector('.up-name').textContent = t('chat.upload_failed', { error: e.message });
        setTimeout(() => temp.remove(), 2500);
    }
}

function onFilesPicked(files) {
    for (const f of files) {
        uploadBlob(f, { fileName: f.name, mime: f.type || 'application/octet-stream' });
    }
}

/* ---------------- voice recording ---------------- */

let rec = null; // { recorder, stream, chunks, timer, start, kind }

function pickMime(cands) {
    if (!window.MediaRecorder) return null;
    for (const c of cands) if (MediaRecorder.isTypeSupported(c)) return c;
    return '';
}

async function startVoice() {
    if (rec) return;
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch { toast(t('chat.mic_denied')); return; }
    const mime = pickMime(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']);
    if (mime === null) { toast(t('chat.rec_unsupported')); stream.getTracks().forEach((tr) => tr.stop()); return; }
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec = { recorder, stream, chunks: [], start: Date.now(), timer: null, kind: 'voice' };
    recorder.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
    recorder.start(500);
    $('composer').hidden = true;
    $('rec-bar').hidden = false;
    $('rec-label').textContent = t('chat.rec_voice');
    rec.timer = setInterval(() => { $('rec-time').textContent = fmtDur((Date.now() - rec.start) / 1000); }, 300);
}

function stopVoice(send) {
    if (!rec) return;
    const { recorder, stream, start } = rec;
    const duration = (Date.now() - start) / 1000;
    const finish = () => {
        const type = recorder.mimeType || 'audio/webm';
        const blob = new Blob(rec.chunks, { type });
        stream.getTracks().forEach((tr) => tr.stop());
        clearInterval(rec.timer);
        $('rec-bar').hidden = true;
        $('composer').hidden = false;
        $('rec-time').textContent = '0:00';
        const r = rec; rec = null;
        if (send && duration >= 0.7 && blob.size > 0) {
            const ext = type.includes('mp4') ? 'm4a' : 'webm';
            uploadBlob(blob, {
                fileName: 'voice-message.' + ext, mime: type.split(';')[0],
                msgType: 'voice', duration,
            });
        }
    };
    recorder.onstop = finish;
    try { recorder.stop(); } catch { finish(); }
}

/* ---------------- video message ---------------- */

let vrec = null; // { recorder, stream, chunks, timer, start, blob }

async function openVideoMsg() {
    if (!S.activeConvId) return;
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 720 } }, audio: true,
        });
    } catch { toast(t('chat.cam_denied')); return; }
    vrec = { stream, recorder: null, chunks: [], timer: null, start: 0, blob: null };
    const modal = $('videomsg-modal');
    const prev = $('videomsg-preview');
    prev.srcObject = stream;
    prev.muted = true;
    prev.controls = false;
    modal.hidden = false;
    $('videomsg-record').hidden = false;
    $('videomsg-record').textContent = t('chat.vm_record');
    $('videomsg-send').hidden = true;
    $('videomsg-time').textContent = '0:00';
}

function closeVideoMsg() {
    if (!vrec) return;
    clearInterval(vrec.timer);
    try { vrec.recorder?.state !== 'inactive' && vrec.recorder?.stop(); } catch { }
    vrec.stream.getTracks().forEach((tr) => tr.stop());
    const prev = $('videomsg-preview');
    prev.srcObject = null;
    prev.removeAttribute('src');
    if (vrec.previewUrl) URL.revokeObjectURL(vrec.previewUrl);
    $('videomsg-modal').hidden = true;
    vrec = null;
}

function videoMsgRecordToggle() {
    if (!vrec) return;
    const btn = $('videomsg-record');
    if (!vrec.recorder || vrec.recorder.state === 'inactive') {
        const mime = pickMime(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']);
        if (mime === null) { toast(t('chat.rec_unsupported')); return; }
        vrec.recorder = new MediaRecorder(vrec.stream, mime ? { mimeType: mime } : undefined);
        vrec.chunks = [];
        vrec.recorder.ondataavailable = (e) => { if (e.data.size) vrec.chunks.push(e.data); };
        vrec.recorder.onstop = () => {
            if (!vrec) return;
            const type = vrec.recorder.mimeType || 'video/webm';
            vrec.blob = new Blob(vrec.chunks, { type });
            vrec.duration = (Date.now() - vrec.start) / 1000;
            const prev = $('videomsg-preview');
            prev.srcObject = null;
            if (vrec.previewUrl) URL.revokeObjectURL(vrec.previewUrl);
            vrec.previewUrl = URL.createObjectURL(vrec.blob);
            prev.src = vrec.previewUrl;
            prev.muted = false;
            prev.controls = true;
            $('videomsg-send').hidden = false;
            btn.textContent = t('chat.vm_retake');
        };
        vrec.start = Date.now();
        vrec.recorder.start(500);
        vrec.timer = setInterval(() => {
            $('videomsg-time').textContent = fmtDur((Date.now() - vrec.start) / 1000);
            if (Date.now() - vrec.start > 3 * 60_000) videoMsgRecordToggle(); // 3 min cap
        }, 300);
        btn.textContent = t('chat.vm_stop');
        $('videomsg-send').hidden = true;
    } else if (vrec.recorder.state === 'recording') {
        clearInterval(vrec.timer);
        vrec.recorder.stop();
    } else if (vrec.blob) {
        // Retake: back to live preview
        const prev = $('videomsg-preview');
        prev.removeAttribute('src');
        if (vrec.previewUrl) { URL.revokeObjectURL(vrec.previewUrl); vrec.previewUrl = null; }
        prev.srcObject = vrec.stream;
        prev.muted = true;
        prev.controls = false;
        vrec.blob = null;
        vrec.recorder = null;
        $('videomsg-send').hidden = true;
        $('videomsg-record').textContent = t('chat.vm_record');
        $('videomsg-time').textContent = '0:00';
    }
}

function sendVideoMsg() {
    if (!vrec?.blob) return;
    const type = vrec.blob.type;
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    uploadBlob(vrec.blob, {
        fileName: 'video-message.' + ext, mime: type.split(';')[0],
        msgType: 'videomsg', duration: vrec.duration,
    });
    closeVideoMsg();
}

/* ---------------- lightbox ---------------- */

function showLightbox(src, name) {
    const lb = $('lightbox');
    lb.textContent = '';
    lb.append(h('img', { src, alt: '' }));
    // Save without leaving the viewer; stopPropagation so the click does not
    // fall through to the backdrop dismiss.
    const dl = h('a', { class: 'lightbox-dl', href: src, download: name || 'image', title: t('chat.download') });
    dl.append(svgIcon(DL_SVG));
    dl.addEventListener('click', (e) => e.stopPropagation());
    lb.append(dl);
    lb.hidden = false;
}

/* ---------------- init ---------------- */

export function initChat() {
    $('btn-send').addEventListener('click', sendText);
    const input = $('composer-input');
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
    });
    input.addEventListener('input', () => {
        autosize();
        const now = Date.now();
        if (S.activeConvId && now - lastTypingSent > 2500 && input.value) {
            lastTypingSent = now;
            net.send('typing', { convId: S.activeConvId });
        }
    });

    $('file-input').addEventListener('change', (e) => {
        showAttachNote();
        onFilesPicked([...e.target.files]);
        e.target.value = '';
    });

    $('btn-voice').addEventListener('click', startVoice);
    $('rec-cancel').addEventListener('click', () => stopVoice(false));
    $('rec-send').addEventListener('click', () => stopVoice(true));

    $('btn-videomsg').addEventListener('click', openVideoMsg);
    $('videomsg-cancel').addEventListener('click', closeVideoMsg);
    $('videomsg-record').addEventListener('click', videoMsgRecordToggle);
    $('videomsg-send').addEventListener('click', sendVideoMsg);

    $('btn-back').addEventListener('click', closeConv);
    $('msg-scroll').addEventListener('scroll', maybeLoadOlder);
    $('lightbox').addEventListener('click', () => { $('lightbox').hidden = true; });

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && S.activeConvId) markRead(S.activeConvId);
    });
}
