// Chat pane: message rendering, composer, uploads, voice & video messages.

import { api, upload } from './api.js';
import { t, has } from './i18n.js';
import { ecoOn, shrinkImage } from './eco.js';
import {
    S, $, h, bus, net, toast, avatarEl, userName, convTitle, convOther,
    fmtTime, fmtDay, sameDay, fmtSize, fmtDur, userById, userAvatar, convAvatarSrc,
    closeControl,
} from './core.js';

const MIC_SVG = 'M12 14c1.7 0 3-1.3 3-3V5c0-1.7-1.3-3-3-3S9 3.3 9 5v6c0 1.7 1.3 3 3 3zm5.3-3c0 3-2.5 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.4 2.7 6.2 6 6.7V21h2v-3.3c3.3-.5 6-3.3 6-6.7h-1.7z';
const FILE_SVG = 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z';
const REACT_SVG = 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z';
const FWD_SVG = 'M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z';
// The forward arrow mirrored: an arrow curving back the way the text came from.
const REPLY_SVG = 'M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z';
const DL_SVG = 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z';
const CLOSE_SVG = 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';
const EDIT_SVG = 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z';
// Mirrors the server rule in lib/api.js; the server is still the authority.
const EDIT_WINDOW_MS = 7 * 86400_000;
// Mirrors MAX_CAPTION_LEN in lib/util.js — stops an over-long caption before a
// long upload rather than truncating it after the bytes have crossed.
const MAX_CAPTION_LEN = 500;

// Must match REACTIONS in lib/util.js exactly (the server rejects anything else).
const REACTIONS = ['👍', '👎', '❤️', '😂', '😢', '🙏', '👏', '🎉', '😮', '😡'];

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

/* ---------------- replying ----------------
   One pending reply at a time, belonging to the open conversation. Held as the
   message id plus a snapshot for the strip; the server re-resolves the quote
   from the id when the reply is sent, so an edit between choosing and sending
   is reflected rather than frozen. */

let replyTo = null;   // { id, convId, senderId, text }

export function setReplyTo(m) {
    replyTo = {
        id: m.id, convId: m.conversationId, senderId: m.senderId,
        text: quoteText(m),
    };
    renderReplyBar();
    const box = $('composer-input');
    if (box) box.focus();
}

export function clearReplyTo() {
    replyTo = null;
    renderReplyBar();
}

// One line describing a message well enough to recognise it in a quote.
function quoteText(m) {
    if (m.deleted) return t('chat.msg_deleted');
    if (m.type === 'text') return m.content || '';
    if (m.content) return m.content;                 // a file's caption names it best
    return previewLabelFor(m);
}

function previewLabelFor(m) {
    switch (m.type) {
        case 'image': return t('app.preview.image');
        case 'video': return t('app.preview.video');
        case 'videomsg': return t('app.preview.videomsg');
        case 'audio': return t('app.preview.audio');
        case 'voice': return t('app.preview.voice');
        default: return t('app.preview.file', { name: m.fileName || t('app.preview.fileFallback') });
    }
}

function renderReplyBar() {
    const bar = $('reply-bar');
    if (!bar) return;
    if (!replyTo) { bar.hidden = true; bar.textContent = ''; return; }
    bar.textContent = '';
    bar.append(h('div', { class: 'reply-strip' }, [
        h('div', { class: 'reply-who', text: t('chat.replying_to', { name: userName(replyTo.senderId) }) }),
        h('div', { class: 'reply-text', dir: 'auto', text: replyTo.text }),
    ]));
    const x = h('button', {
        class: 'icon-btn', type: 'button',
        title: t('chat.reply_cancel'), 'aria-label': t('chat.reply_cancel'),
        onclick: clearReplyTo,
    });
    x.append(svgIcon(CLOSE_SVG));
    bar.append(x);
    bar.hidden = false;
}

/* ---------------- open / render conversation ---------------- */

export async function openConv(convId) {
    const conv = S.convs.get(convId);
    if (!conv) return;
    closeFilter();   // a filter must never survive a conversation switch
    // A half-written reply belongs to the thread it was started in.
    if (replyTo && replyTo.convId !== convId) clearReplyTo();
    // The previous conversation's unread line is spent; only the one being
    // opened gets a fresh boundary computed below. Its reading position is
    // worth keeping, though.
    if (S.activeConvId && S.activeConvId !== convId) {
        rememberScroll(S.activeConvId);
        msgStore(S.activeConvId).unreadAt = 0;
    }
    S.activeConvId = convId;
    clearTyping(); // typing state is per-open-conversation; drop stale indicators
    $('view-app').classList.add('mobile-chat-open');
    $('chat-empty').hidden = true;
    $('chat-ui').hidden = false;
    renderHeader();
    // Whatever was half-typed here last time comes back.
    const box = $('composer-input');
    box.value = loadDraft(convId);
    autosize();
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
    // Read the boundary first: markRead() below moves the watermark, after which
    // there is no way to tell where the unread run began.
    const unreadAt = firstUnreadId(convId);
    // Held on the store so paging and reconnect re-renders keep the line.
    msgStore(convId).unreadAt = unreadAt;
    renderAll(convId);
    // Three answers to "where should this open?", in order of what the reader
    // most likely wants: the first thing they have not read, then wherever they
    // had got to, then the end.
    const sep = unreadAt ? $('unread-sep') : null;
    if (sep) {
        sep.scrollIntoView({ block: 'center' });
    } else if (store.scrollTop != null) {
        const sc = $('msg-scroll');
        const want = Math.min(store.scrollTop, Math.max(0, sc.scrollHeight - sc.clientHeight));
        sc.scrollTop = want;
        // Same reason scrollBottom re-pins: media that has not loaded yet would
        // otherwise shift everything under the restored offset.
        const again = () => {
            if (S.activeConvId === convId && sc.isConnected) {
                sc.scrollTop = Math.min(store.scrollTop, Math.max(0, sc.scrollHeight - sc.clientHeight));
            }
        };
        requestAnimationFrame(again);
        setTimeout(again, 120);
        setTimeout(again, 400);
    } else {
        scrollBottom();
    }
    markRead(convId);
}

// Land on one specific message: open the conversation, page back through
// history until the message is loaded, then centre and briefly highlight it.
// This is what an activity item resolves to — "guide them to the message".
export async function jumpToMessage(convId, messageId) {
    await openConv(convId);
    if (S.activeConvId !== convId) return;   // switched away while loading
    const store = msgStore(convId);
    let paged = false;
    // Bounded: 40 pages of 50 is further back than anyone scrolls by hand. A
    // target older than that (or deleted) degrades to the conversation as-is.
    for (let i = 0; i < 40 && !store.ids.has(messageId) && !store.complete; i++) {
        const oldest = store.list[0]?.id;
        if (!oldest || oldest <= messageId) break;
        try {
            const { messages } = await api('api/conversations/' + convId + '/messages?limit=50&before=' + oldest);
            if (messages.length < 50) store.complete = true;
            const fresh = messages.filter((m) => !store.ids.has(m.id));
            for (const m of fresh) store.ids.add(m.id);
            store.list = fresh.concat(store.list).sort((a, b) => a.id - b.id);
            paged = true;
        } catch { break; }   // transient: land wherever we got to
        if (S.activeConvId !== convId) return;
    }
    // Re-checked after the loop as well: a fetch failure breaks out past the
    // in-loop guard, and the user may have switched conversations during it —
    // repainting the active view with another conversation's messages is the
    // one thing this must never do.
    if (S.activeConvId !== convId) return;
    if (paged) renderAll(convId);
    const el = document.querySelector('#msg-list [data-mid="' + messageId + '"]');
    if (!el) return;   // deleted without a marker, or beyond the paging bound
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 2600);
}

export function closeConv() {
    closeFilter();
    clearReplyTo();
    if (S.activeConvId) {
        rememberScroll(S.activeConvId);
        msgStore(S.activeConvId).unreadAt = 0;
    }
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
        avatarEl(convTitle(conv), {
            group: conv.type === 'group', src: convAvatarSrc(conv), zoom: true,
        }),
        { id: 'chat-avatar' }));
    if (conv.type === 'group') {
        $('chat-sub').textContent = t('chat.members', { n: conv.members.length });
    } else {
        const other = convOther(conv);
        $('chat-sub').textContent = S.online.has(other) ? t('chat.online') : t('chat.offline');
    }
}

// A removed message is dropped from the thread entirely unless the server says
// it has to leave a marker. Deleting is only possible before the other side has
// read the message, so in the ordinary case there is nothing to announce.
function hiddenMsg(m) { return m.deleted && !m.tombstone; }

// Where the unread run begins, captured BEFORE the conversation is marked read —
// after that the watermark has moved and the boundary is gone.
//
// A floor of 0 is the normal case for a conversation never opened on this
// account, and it means every message counts as unread, so it must not be
// treated as "nothing to mark".
function firstUnreadId(convId) {
    const conv = S.convs.get(convId);
    const store = S.msgs.get(convId);
    if (!conv || !store) return 0;
    const mine = conv.reads?.find((r) => r.userId === S.me.id);
    // join_msg_id keeps somebody added to an old group from inheriting its
    // entire history as unread.
    const floor = Math.max(mine?.lastReadId || 0, mine?.joinMsgId || 0);
    const first = store.list.find((m) => m.id > floor && m.senderId !== S.me.id
        && !hiddenMsg(m) && m.type !== 'system');
    return first ? first.id : 0;
}

function renderAll(convId) {
    const markAt = msgStore(convId).unreadAt || 0;
    const list = $('msg-list');
    list.textContent = '';
    const store = msgStore(convId);
    let prevTs = 0;
    for (const m of store.list) {
        if (hiddenMsg(m)) continue;
        if (!prevTs || !sameDay(prevTs, m.createdAt)) {
            list.append(h('div', { class: 'day-sep', text: fmtDay(m.createdAt) }));
        }
        prevTs = m.createdAt;
        // A ruled line where reading left off. openConv scrolls to it by id, so
        // opening a conversation lands on the first unread message.
        if (markAt && m.id === markAt) {
            list.append(h('div', { class: 'unread-sep', id: 'unread-sep' },
                [h('span', { text: t('chat.unread_here') })]));
        }
        list.append(msgEl(m));
    }
}

/* ---------------- message elements ---------------- */

// Message text carries its OWN direction. The interface language decides the
// layout, but a Persian message in an English interface still has to read
// right-to-left — and an English message in a Persian one left-to-right. dir
//="auto" resolves that per message from its first strong character, which is
// exactly the rule a reader expects.
function msgTextEl(text) {
    const el = h('span', { class: 'msg-text', dir: 'auto' });
    el.append(linkify(text));
    return el;
}

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

// A downloadable chip: the normal presentation for a document, and the fallback
// when a media file exists but this browser cannot play it.
function fileChipEl(m, src, unplayable) {
    const a = h('a', { class: 'file-chip', href: src, download: m.fileName || 'file' });
    a.append(svgIcon(FILE_SVG));
    a.append(h('div', {}, [
        h('div', { class: 'fc-name', text: m.fileName || 'file' }),
        h('div', {
            class: 'fc-size',
            text: unplayable
                ? t('chat.cant_play', { size: fmtSize(m.fileSize || 0) })
                : fmtSize(m.fileSize || 0),
        }),
    ]));
    return a;
}

function bubbleContent(m) {
    // Driven by the flag, and returning before `src` exists. Falling back on a
    // failed request instead would be wrong twice over: responses are cached
    // immutably for a year, so viewers would disagree about the same message —
    // and the document branch below builds a download anchor, which saves the
    // 404 JSON body to disk under the original filename.
    if (m.purged && m.type !== 'text' && m.type !== 'system') return purgedChip(m);

    const src = 'api/files/' + m.id;
    // A media element raises `error` for TWO very different reasons: the file is
    // missing, or this browser simply cannot decode the format (.wma, .flac, some
    // .mov — no browser plays them all). Treating that as "removed to free space"
    // was wrong and alarming: the file is right there and still downloadable.
    // So a playback failure degrades to a download chip, and whether a file was
    // actually reclaimed is left to the server's flag, which is the only thing
    // that knows.
    const unplayable = (el) => () => el.replaceWith(fileChipEl(m, src, true));
    switch (m.type) {
        case 'text':
            return msgTextEl(m.content || '');
        case 'image': {
            const img = h('img', { class: 'msg-img', src, alt: m.fileName || t('chat.image_alt'), loading: 'lazy' });
            img.addEventListener('click', () => showLightbox(src, m.fileName));
            img.addEventListener('error', unplayable(img));
            return img;
        }
        case 'video':
        case 'videomsg': {
            const v = h('video', { class: 'msg-video', src, controls: '', playsinline: '', preload: 'metadata' });
            v.addEventListener('error', unplayable(v));
            return v;
        }
        case 'audio': {
            const a = h('audio', { src, controls: '', preload: 'metadata' });
            a.addEventListener('error', unplayable(a));
            return a;
        }
        case 'voice': {
            const row = h('div', { class: 'voice-row' });
            const a = h('audio', { src, controls: '', preload: 'metadata' });
            a.addEventListener('error', unplayable(row));
            row.append(svgIcon(MIC_SVG));
            row.append(a);
            if (m.duration) row.append(h('span', { class: 'muted', text: fmtDur(m.duration) }));
            return row;
        }
        default:
            return fileChipEl(m, src, false);
    }
}

// A system event carries a key plus arguments, so each viewer reads it in their
// own language. Rows written before that existed — and any key introduced by a
// newer server than this build knows — fall back to the English sentence the
// server also stores in `content`.
export function sysText(m) {
    if (m.sysKey && has(m.sysKey)) {
        const a = m.sysArgs || {};
        // Call records carry raw timestamps rather than formatted text, so each
        // viewer sees them in their own timezone, locale and digits.
        if ((m.sysKey === 'sys.call_video' || m.sysKey === 'sys.call_voice') && a.startedAt) {
            return t(m.sysKey, {
                start: fmtTime(a.startedAt),
                end: fmtTime(a.endedAt),
                duration: fmtDur(a.seconds),
            });
        }
        // One shared message, two truths: the caller did not miss anything —
        // for them the same line reads as "no answer".
        if (m.sysKey === 'sys.call_missed_video' || m.sysKey === 'sys.call_missed_voice') {
            if (a.by === S.me.id) {
                return t(m.sysKey === 'sys.call_missed_video'
                    ? 'sys.call_noanswer_video' : 'sys.call_noanswer_voice');
            }
            return t(m.sysKey);
        }
        return t(m.sysKey, a);
    }
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
        // What this message answers. Clicking it walks the history back to the
        // original — the same jump the activity bell uses.
        if (m.replyTo) bubble.append(replyQuoteEl(m));
        bubble.append(bubbleContent(m));
        // A caption is a SIBLING of the media, never inside bubbleContent: that
        // returns early for a purged file, and its media error handlers replace
        // their whole element, either of which would take the caption with it.
        if (m.type !== 'text' && m.type !== 'system' && m.content) {
            bubble.append(h('div', { class: 'msg-caption', dir: 'auto', text: m.content }));
        }
        const meta = h('span', { class: 'meta', text: fmtTime(m.createdAt) });
        bubble.append(meta);
        // Always present on own messages, even when nobody has read it yet, so a
        // read arriving later only ever mutates an existing node — re-rendering
        // the bubble would restart a playing voice note or video.
        if (mine && m.type !== 'system') meta.append(seenTickEl(m));
        if (mine) {
            const del = h('button', { class: 'msg-del', title: t('chat.del_title'), type: 'button', text: '✕' });
            del.addEventListener('click', async () => {
                // Once read, removing it takes the reader's agreement — so the
                // prompt says which of the two is about to happen.
                const asks = !!m.seen;
                if (!confirm(asks ? t('chat.del_confirm_ask') : t('chat.del_confirm'))) return;
                if (asks) return requestDelete(m);
                try { await api('api/messages/' + m.id, { method: 'DELETE' }); }
                catch (e) {
                    // Somebody read it between rendering and clicking.
                    if (e.status === 409) return requestDelete(m);
                    toast(e.message);
                }
            });
            bubble.append(del);
        }
    }

    // bubble and its reaction chips share a column so the chips sit under it.
    const col = h('div', { class: 'msg-col' });
    col.append(bubble);
    const reacts = reactionsEl(m);
    if (reacts) col.append(reacts);
    const dreq = m.deleted ? null : delReqEl(m);
    if (dreq) col.append(dreq);

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

/* ---------------- deletion requests ----------------
   Deleting a message somebody has read takes their agreement. The server owns
   the rules; this renders the pending state and collects the answer. */

// messageId -> request, kept in step by the msg:delreq broadcast.
const delReqs = new Map();

export function primeDelReqs(list) {
    delReqs.clear();
    for (const r of list || []) delReqs.set(r.messageId, r);
}

export function onDelReq(request) {
    if (request.state === 'pending') delReqs.set(request.messageId, request);
    else delReqs.delete(request.messageId);
    // Repaint just this message wherever it is rendered.
    const store = S.msgs.get(request.convId);
    const m = store?.list.find((x) => x.id === request.messageId);
    if (!m) return;
    for (const el of document.querySelectorAll('.msg-list [data-mid="' + request.messageId + '"]')) {
        el.replaceWith(msgEl(m));
    }
    if (request.state === 'denied' && m.senderId === S.me.id) toast(t('chat.del_denied'));
}

async function requestDelete(m) {
    try {
        const r = await api('api/messages/' + m.id + '/delete-request', { method: 'POST' });
        if (r.deleted) return;                 // nobody had actually seen it
        toast(t('chat.del_asked'));
    } catch (e) { toast(e.message); }
}

async function voteDelete(m, approve) {
    try { await api('api/messages/' + m.id + '/delete-request/vote', { method: 'POST', body: { approve } }); }
    catch (e) { toast(e.message); }
}

// The strip shown under a message with an open request. Its three audiences see
// three different things: the sender waits, an approver is asked, everyone else
// is told nothing at all.
function delReqEl(m) {
    const req = delReqs.get(m.id);
    if (!req) return null;
    const mine = m.senderId === S.me.id;
    const box = h('div', { class: 'del-req' });
    if (mine) {
        box.append(h('span', {
            text: t('chat.del_pending', { done: req.approved + req.waived, total: req.total }),
        }));
        return box;
    }
    // Only a frozen approver who has not answered is asked; the server rejects
    // anyone else regardless.
    if (!(req.pending || []).includes(S.me.id)) return null;
    box.append(h('span', { text: t('chat.del_asks') }));
    box.append(h('button', {
        class: 'btn small ghost', type: 'button', text: t('chat.del_keep'),
        onclick: () => voteDelete(m, false),
    }));
    box.append(h('button', {
        class: 'btn small danger', type: 'button', text: t('chat.del_allow'),
        onclick: () => voteDelete(m, true),
    }));
    return box;
}

/* ---------------- read receipts ---------------- */

// Who was in the room when this was sent, excluding its author. joinMsgId keeps
// somebody added later out of the audience — they were never expected to read it.
function audienceFor(m) {
    const conv = S.convs.get(m.conversationId);
    if (!conv || !Array.isArray(conv.reads)) return [];
    return conv.reads.filter((r) => r.userId !== m.senderId && (r.joinMsgId || 0) < m.id);
}

function seenState(m) {
    const audience = audienceFor(m);
    const by = audience.filter((r) => r.lastReadId >= m.id);
    // m.seen is the server's sticky flag: it survives a member leaving, which
    // would otherwise erase them from the vector and walk the tick backwards.
    const any = by.length > 0 || !!m.seen;
    return { total: audience.length, count: by.length, any, all: audience.length > 0 && by.length >= audience.length, by };
}

function seenTickEl(m) {
    const conv = S.convs.get(m.conversationId);
    const st = seenState(m);
    const group = conv?.type === 'group';
    const tick = h('span', {
        class: 'msg-tick' + (st.all || (!group && st.any) ? ' seen' : ''),
        // A single tick means delivered, a double means read — the convention
        // people already know from other messengers.
        text: (st.any ? '✓✓' : '✓') + (group && st.total > 1 ? ' ' + st.count + '/' + st.total : ''),
    });
    if (group && st.count) {
        const names = st.by.map((r) => userName(r.userId));
        tick.title = t('chat.seen_by', { names: names.join(', ') });
    } else {
        tick.title = st.any ? t('chat.seen') : t('chat.sent');
    }
    return tick;
}

// A read moved: refresh only the ticks, never the bubbles.
export function onRead(convId, userId, lastReadId) {
    const conv = S.convs.get(convId);
    if (conv && Array.isArray(conv.reads)) {
        const row = conv.reads.find((r) => r.userId === userId);
        // Monotonic: a stale conv:updated snapshot must not walk it backwards.
        if (row) row.lastReadId = Math.max(row.lastReadId, lastReadId);
        else conv.reads.push({ userId, lastReadId, joinMsgId: 0 });
    }
    const store = S.msgs.get(convId);
    if (store) for (const m of store.list) if (m.id <= lastReadId && m.senderId !== userId) m.seen = true;
    if (S.activeConvId !== convId || !store) return;
    for (const el of document.querySelectorAll('.msg-list [data-mid]')) {
        const id = Number(el.dataset.mid);
        if (!id || id > lastReadId) continue;
        const m = store.list.find((x) => x.id === id);
        if (!m || m.senderId !== S.me.id) continue;
        const old = el.querySelector('.msg-tick');
        if (old) old.replaceWith(seenTickEl(m));
    }
}

// The quoted strip shown above a reply's own text.
// Every message quoting `id` in the open conversation, re-rendered. The server
// resolves quotes live, so the client must not keep showing a copy that the
// original has since moved on from.
function refreshQuotesOf(convId, id, patch) {
    const store = S.msgs.get(convId);
    if (!store) return;
    for (const m of store.list) {
        if (m.replyTo !== id) continue;
        m.replySource = m.replySource ? { ...m.replySource, ...patch } : m.replySource;
        if (S.activeConvId !== convId) continue;
        for (const row of document.querySelectorAll('.msg-list [data-mid="' + m.id + '"]')) {
            const old = row.querySelector('.reply-quote');
            if (old) old.replaceWith(replyQuoteEl(m));
        }
    }
}

function replyQuoteEl(m) {
    const src = m.replySource;
    const q = h('button', { class: 'reply-quote', type: 'button' });
    if (!src) {
        // The original is gone entirely (its conversation history was trimmed):
        // say so rather than offer a jump that goes nowhere.
        q.append(h('div', { class: 'reply-text', text: t('chat.reply_gone') }));
        q.disabled = true;
        return q;
    }
    q.append(h('div', { class: 'reply-who', text: userName(src.senderId) }));
    q.append(h('div', {
        class: 'reply-text', dir: 'auto',
        text: src.deleted ? t('chat.msg_deleted') : (src.content || previewLabelFor(src)),
    }));
    q.addEventListener('click', (e) => {
        e.stopPropagation();
        jumpToMessage(m.conversationId, src.id);
    });
    return q;
}

/* ---------------- per-message actions ---------------- */

function msgActions(m, mine) {
    const acts = h('div', { class: 'msg-acts' });
    // Replying is for everyone, including your own messages, and works on files
    // as well as text. Only a purged or removed message has nothing to answer.
    if (!m.purged && !m.deleted && m.type !== 'system') {
        const qb = h('button', { class: 'msg-act', title: t('chat.reply'), type: 'button' });
        qb.append(svgIcon(REPLY_SVG, 'ic-dir'));   // directional glyph: mirrors under RTL
        qb.addEventListener('click', (e) => { e.stopPropagation(); setReplyTo(m); });
        acts.append(qb);
    }
    // Reacting is for the audience, never the sender.
    if (!mine) {
        const rb = h('button', { class: 'msg-act', title: t('chat.react'), type: 'button' });
        rb.append(svgIcon(REACT_SVG));
        rb.addEventListener('click', (e) => { e.stopPropagation(); openReactionPicker(rb, m); });
        acts.append(rb);
    }
    // Editing closes the moment anyone reads it, so the control simply stops
    // being offered — the server refuses regardless.
    if (mine && !m.purged && !m.seen && m.type !== 'system'
        && Date.now() - m.createdAt < EDIT_WINDOW_MS) {
        const eb = h('button', { class: 'msg-act', title: t('chat.edit'), type: 'button' });
        eb.append(svgIcon(EDIT_SVG));
        eb.addEventListener('click', (e) => { e.stopPropagation(); editModal(m); });
        acts.append(eb);
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

function editModal(m) {
    const root = $('modal-root');
    root.textContent = '';
    const modal = h('div', { class: 'modal' });
    root.append(modal);
    root.hidden = false;
    let detach = () => { };
    const close = () => { root.hidden = true; root.textContent = ''; root.onclick = null; detach(); };
    detach = closeControl(modal, close, t('app.close'));
    root.onclick = (e) => { if (e.target === root) close(); };

    modal.append(h('h3', { text: t('chat.edit') }));
    const box = h('textarea', { class: 'edit-box', rows: '4', maxlength: '4000' });
    box.value = m.content || '';
    modal.append(box);
    modal.append(h('div', { class: 'modal-row' }, [
        h('div', { class: 'rec-spacer' }),
        h('button', { class: 'btn small ghost', type: 'button', text: t('chat.edit_cancel'), onclick: close }),
        h('button', {
            class: 'btn small', type: 'button', text: t('chat.edit_save'),
            onclick: async (e) => {
                e.currentTarget.disabled = true;
                try {
                    await api('api/messages/' + m.id, { method: 'PATCH', body: { content: box.value } });
                    close();
                } catch (err) { toast(err.message); e.currentTarget.disabled = false; }
            },
        }),
    ]));
    box.focus();
}

// Replace only the text and the edited marker: re-rendering the bubble would
// restart a playing voice note or video attached to the same message.
export function onMsgEdited(message) {
    const convId = message.conversationId;
    const store = S.msgs.get(convId);
    const m = store?.list.find((x) => x.id === message.id);
    if (m) { m.content = message.content; m.editedAt = message.editedAt; }
    // Anything quoting this message is now showing the previous wording.
    refreshQuotesOf(convId, message.id, { content: message.content });
    if (S.activeConvId !== convId || !m) return;
    for (const el of document.querySelectorAll('.msg-list [data-mid="' + message.id + '"]')) {
        const bubble = el.querySelector('.bubble');
        if (!bubble) continue;
        if (m.type === 'text') {
            const meta = bubble.querySelector('.meta');
            // Rebuild just the linkified text ahead of the metadata line.
            for (const node of [...bubble.childNodes]) {
                if (node === meta || (node.classList && (node.classList.contains('meta')
                    || node.classList.contains('msg-del') || node.classList.contains('sender')
                    || node.classList.contains('fwd-tag')
                    // The quote is part of the message's identity, not its body:
                    // editing the text must not detach what it was answering.
                    || node.classList.contains('reply-quote')))) continue;
                node.remove();
            }
            bubble.insertBefore(msgTextEl(m.content || ''), meta || null);
        } else {
            const cap = bubble.querySelector('.msg-caption');
            if (cap) cap.textContent = m.content || '';
        }
    }
}

// No "edited" marker: editing is only possible before anybody has read the
// message, so no reader was ever shown an earlier version.

function forwardModal(m) {
    // A small local modal on #modal-root. app.js's opener is not importable here
    // without a module cycle, so the shared close control lives in core.js.
    const root = $('modal-root');
    root.textContent = '';
    const modal = h('div', { class: 'modal' });
    root.append(modal);
    root.hidden = false;
    let detach = () => { };
    const close = () => { root.hidden = true; root.textContent = ''; root.onclick = null; detach(); };
    detach = closeControl(modal, close, t('app.close'));
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
    // Scoped to the class, not the id: the same message can also be on screen in
    // the filter panel, and both copies must stay in step.
    for (const col of document.querySelectorAll('.msg-list [data-mid="' + messageId + '"] .msg-col')) {
        const existing = col.querySelector('.msg-reacts');
        const fresh = reactionsEl(m);
        if (existing && fresh) existing.replaceWith(fresh);
        else if (existing) existing.remove();
        else if (fresh) col.append(fresh);
    }
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
            // The heading only goes in if something is going to follow it.
            const prev = store.list[store.list.length - 2];
            if (!hiddenMsg(m)) {
                if (!prev || !sameDay(prev.createdAt, m.createdAt)) {
                    list.append(h('div', { class: 'day-sep', text: fmtDay(m.createdAt) }));
                }
                list.append(msgEl(m));
            }
            if (nearBottom || m.senderId === S.me.id) scrollBottom();
            if (!document.hidden) markRead(m.conversationId);
        }
    }
}

// A day heading or the unread line is only meaningful if a message follows it.
// Removing the message they introduced leaves them pointing at nothing.
function pruneSeparators() {
    const list = $('msg-list');
    if (!list) return;
    const isSep = (el) => el && (el.classList.contains('day-sep') || el.classList.contains('unread-sep'));
    for (const sep of [...list.querySelectorAll('.day-sep, .unread-sep')]) {
        if (!sep.nextElementSibling || isSep(sep.nextElementSibling)) sep.remove();
    }
}

export function onMsgDeleted(convId, messageId, tombstone) {
    refreshQuotesOf(convId, messageId, { deleted: true, content: null, fileName: null });
    const store = S.msgs.get(convId);
    if (store) {
        const m = store.list.find((x) => x.id === messageId);
        if (m) { m.deleted = true; m.content = null; m.tombstone = !!tombstone; }
    }
    if (S.activeConvId === convId) {
        const m = msgStore(convId).list.find((x) => x.id === messageId);
        // Both the thread and the filter panel may be showing this message.
        for (const el of document.querySelectorAll('.msg-list [data-mid="' + messageId + '"]')) {
            // The event's own flag decides, not the store: the filter panel can
            // show a message that was never loaded into the thread, and a missing
            // store entry is not evidence that it should vanish.
            if (!tombstone) el.remove();              // vanishes without a trace
            else if (m) el.replaceWith(msgEl(m));
        }
        pruneSeparators();
    }
}

// Remembers what was last reported per conversation. markRead fires on open, on
// focus and on every arriving message, so without this a busy group would post —
// and broadcast — a read event several times a second.
const sentRead = new Map();

export function markRead(convId) {
    const conv = S.convs.get(convId);
    const store = S.msgs.get(convId);
    if (!conv) return;
    // The thread is hidden behind the filter panel, so nothing is actually being
    // read. Reporting otherwise would tell the sender it was seen — and that is
    // what locks their ability to edit it.
    if (filterOpen) return;
    conv.unread = 0;
    bus.emit('convs-changed');
    const lastId = store?.list[store.list.length - 1]?.id
        || conv.lastMessage?.id || 0;
    if (!lastId || (sentRead.get(convId) || 0) >= lastId) return;
    sentRead.set(convId, lastId);
    api('api/conversations/' + convId + '/read', { method: 'POST', body: { messageId: lastId } })
        .catch(() => { sentRead.delete(convId); });   // let a failed report retry
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
        // Catching up must not move the reader. On a connection that drops
        // often this runs constantly, and jumping to the end each time would
        // yank someone out of the history they were reading.
        const sc = $('msg-scroll');
        const atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
        const keep = sc.scrollTop;
        store.list.sort((a, b) => a.id - b.id);
        renderAll(convId);
        if (atBottom) scrollBottom();
        else sc.scrollTop = Math.min(keep, Math.max(0, sc.scrollHeight - sc.clientHeight));
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

// Pinned again after a beat: images, video posters and voice waveforms have no
// height until they load, so a single assignment lands "at the bottom" of a
// thread that then grows underneath and leaves the reader stranded mid-history.
function scrollBottom() {
    const sc = $('msg-scroll');
    sc.scrollTop = sc.scrollHeight;
    const again = () => { if (sc.isConnected) sc.scrollTop = sc.scrollHeight; };
    requestAnimationFrame(again);
    setTimeout(again, 120);
    setTimeout(again, 400);
}

/* Where the reader had got to in a conversation, so leaving and coming back
   returns them there rather than to the end. Kept on the message store, so it
   dies with the cached thread and never outlives what it describes.
   null means "was at the bottom" — which must stay the bottom even when
   messages have arrived since. */
function rememberScroll(convId) {
    if (!convId) return;
    const sc = $('msg-scroll');
    const store = S.msgs.get(convId);
    if (!sc || !store || !sc.isConnected) return;
    const atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
    store.scrollTop = atBottom ? null : sc.scrollTop;
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

// Whatever is half-typed is kept per conversation, so switching away, a
// reload, or a send that fails on a dropped connection never loses it.
const DRAFT_KEY = 'cw_draft_';
// Keyed by account too: conversation ids are global, so on a shared browser the
// next person to sign in would otherwise open a group and find someone else's
// unsent message sitting in the composer, ready to send.
const draftKey = (convId) => DRAFT_KEY + (S.me?.id || 0) + '_' + convId;

let draftTimer = null;

// Debounced because it runs on every keystroke, next to autosize()'s forced
// reflow, on the low-end phones this app is mostly used from. Anything pending
// is flushed the moment the page might go away.
export function saveDraftSoon(convId, text) {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => saveDraft(convId, text), 400);
}

export function saveDraft(convId, text) {
    clearTimeout(draftTimer);
    if (!convId) return;
    try {
        if (text) localStorage.setItem(draftKey(convId), text);
        else localStorage.removeItem(draftKey(convId));
    } catch { /* private mode */ }
}

// Every draft on this device. Called on sign-out: the next person to use the
// browser must not find what the last one was in the middle of writing.
export function clearDrafts() {
    try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(DRAFT_KEY)) keys.push(k);
        }
        for (const k of keys) localStorage.removeItem(k);
    } catch { /* private mode */ }
}

export function loadDraft(convId) {
    try { return localStorage.getItem(draftKey(convId)) || ''; } catch { return ''; }
}

async function sendText() {
    const input = $('composer-input');
    const content = input.value.trim();
    const convId = S.activeConvId;
    if (!content || !convId) return;
    // Cleared optimistically so typing feels instant, but PUT BACK if the send
    // fails — losing what someone just wrote because the connection dropped is
    // the worst possible moment to lose it.
    // Captured before the field is cleared: a failed send restores both the text
    // and what it was answering, so the reply is not silently downgraded into a
    // loose message on retry.
    const pendingReply = replyTo && replyTo.convId === convId ? replyTo : null;
    input.value = '';
    autosize();
    saveDraft(convId, '');
    clearReplyTo();
    try {
        const { message } = await api('api/conversations/' + convId + '/messages', {
            method: 'POST', body: { content, replyTo: pendingReply ? pendingReply.id : undefined },
        });
        onMsgNew(message);           // ws echo is deduped by id
        bus.emit('msg-sent', message);
    } catch (e) {
        // Something may already have been typed while the request was in flight.
        // Both texts are the sender's, so both are kept, oldest first — dropping
        // either one is the loss this whole path exists to prevent.
        const typedSince = S.activeConvId === convId ? input.value : loadDraft(convId);
        const merged = typedSince ? content + '\n' + typedSince : content;
        if (S.activeConvId === convId) { input.value = merged; autosize(); }
        saveDraft(convId, merged);
        // Unconditionally, and never gated on there being extra text: the retry
        // has to answer the same message, or a reply quietly becomes a loose one.
        if (pendingReply && S.activeConvId === convId && !replyTo) {
            replyTo = pendingReply;
            renderReplyBar();
        }
        // A rejection the server explained (too long, rate limited, signed out)
        // is not a connection problem, and telling someone to check their
        // connection would leave them retrying something that cannot succeed.
        toast(e.status ? e.message : t('chat.send_failed'));
    }
}

function autosize() {
    const el = $('composer-input');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 130) + 'px';
}

/* ---------------- uploads ---------------- */

async function uploadBlob(blob, { fileName, mime, msgType, duration, caption }) {
    const convId = S.activeConvId;
    if (!convId) return;
    // Consumed here so a second file in the same batch is not threaded as well.
    const pendingReply = replyTo && replyTo.convId === convId ? replyTo : null;
    if (pendingReply) clearReplyTo();
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
            fileName, mime, msgType, duration, caption,
            replyTo: pendingReply ? pendingReply.id : undefined,
            onProgress: (f) => { bar.style.width = Math.round(f * 100) + '%'; },
        });
        temp.remove();
        onMsgNew(message);
        bus.emit('msg-sent', message);
    } catch (e) {
        // Same reasoning as the text path: a retry must still answer the same
        // message rather than land in the thread unattached.
        if (pendingReply && S.activeConvId === convId && !replyTo) {
            replyTo = pendingReply;
            renderReplyBar();
        }
        temp.querySelector('.up-name').textContent = t('chat.upload_failed', { error: e.message });
        setTimeout(() => temp.remove(), 2500);
    }
}

// Uploading N files at once races the per-user upload rate limit, so they go one
// at a time; the cap keeps a fat folder drop from spending the whole allowance.
const MAX_BATCH = 10;

async function onFilesPicked(files) {
    const picked = [...files].slice(0, MAX_BATCH);
    if (!picked.length) return;
    if (files.length > MAX_BATCH) toast(t('chat.too_many_files', { n: MAX_BATCH }));
    showAttachNote();
    const caption = await captionDialog(picked);
    if (caption === null) return;               // cancelled
    for (const f of picked) {
        // Efficiency mode downscales photos before they leave the device; other
        // kinds pass through untouched.
        const out = await shrinkImage(f);
        // The caption belongs to the batch's first file; repeating it on each
        // would read as spam in the thread.
        await uploadBlob(out, {
            fileName: out.name || f.name,
            mime: out.type || f.type || 'application/octet-stream',
            caption: f === picked[0] ? caption : '',
        });
    }
}

// Resolves to the caption text (possibly empty), or null if cancelled.
function captionDialog(files) {
    return new Promise((resolve) => {
        const root = $('modal-root');
        root.textContent = '';
        const modal = h('div', { class: 'modal' });
        root.append(modal);
        root.hidden = false;
        let done = false;
        let detach = () => { };
        const finish = (val) => {
            if (done) return;
            done = true;
            root.hidden = true; root.textContent = ''; root.onclick = null;
            detach();
            resolve(val);
        };
        // Closing without answering means "do not send", the same as the
        // backdrop — never an empty caption on files already chosen.
        detach = closeControl(modal, () => finish(null), t('app.close'));
        root.onclick = (e) => { if (e.target === root) finish(null); };

        modal.append(h('h3', { text: t('chat.caption_title', { n: files.length }) }));
        const list = h('div', { class: 'list' });
        for (const f of files) {
            list.append(h('div', { class: 'user-row' }, [
                h('div', { class: 'u-mid' }, [
                    h('div', { class: 'u-name', dir: 'auto', text: f.name }),
                    h('div', { class: 'u-sub', text: fmtSize(f.size) }),
                ]),
            ]));
        }
        modal.append(list);

        const box = h('input', {
            type: 'text', maxlength: String(MAX_CAPTION_LEN),
            placeholder: t('chat.caption_placeholder'),
        });
        modal.append(box);
        modal.append(h('div', { class: 'modal-row' }, [
            h('div', { class: 'rec-spacer' }),
            h('button', { class: 'btn small ghost', type: 'button', text: t('chat.edit_cancel'), onclick: () => finish(null) }),
            h('button', { class: 'btn small', type: 'button', text: t('chat.caption_send'), onclick: () => finish(box.value.trim()) }),
        ]));
        box.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); finish(box.value.trim()); }
        });
        box.focus();
    });
}

/* ---------------- attachment filter ----------------
   Results live in their own panel and their own store; the live thread is never
   touched, so an arriving message cannot be lost behind a filter. */

const FILTER_CATS = [
    ['image', 'chat.filter_image'],
    ['video', 'chat.filter_video'],
    ['audio', 'chat.filter_audio'],
    ['voice', 'chat.filter_voice'],
    ['videomsg', 'chat.filter_videomsg'],
    ['document', 'chat.filter_docs'],
];

let filterOpen = false;
const fstate = { types: new Set(), from: '', to: '', loading: false };

export function isFilterOpen() { return filterOpen; }

export function closeFilter() {
    if (!filterOpen) return;
    filterOpen = false;
    $('filter-panel').hidden = true;
    $('msg-scroll').hidden = false;
    $('btn-filter')?.classList.remove('active');
    // Catch up the read position that was deliberately frozen while filtering.
    if (S.activeConvId) markRead(S.activeConvId);
}

function openFilter() {
    if (filterOpen) return;
    filterOpen = true;
    $('filter-panel').hidden = false;
    $('msg-scroll').hidden = true;
    $('btn-filter')?.classList.add('active');
    renderFilterControls();
    runFilter();
}

// Local day boundaries, resolved by the browser. The constructor normalises a
// day overflow and re-resolves the offset, so this stays correct across DST —
// parsing 'YYYY-MM-DD' directly would be UTC and shift the range for everyone
// not on UTC.
function dayStart(v) {
    if (!v) return null;
    const [y, m, d] = v.split('-').map(Number);
    return y ? new Date(y, m - 1, d).getTime() : null;
}
function dayAfter(v) {
    if (!v) return null;
    const [y, m, d] = v.split('-').map(Number);
    return y ? new Date(y, m - 1, d + 1).getTime() : null;
}

function renderFilterControls() {
    const box = $('filter-controls');
    box.textContent = '';
    const chips = h('div', { class: 'filter-chips' });
    for (const [type, key] of FILTER_CATS) {
        chips.append(h('button', {
            class: 'admin-tab' + (fstate.types.has(type) ? ' active' : ''),
            type: 'button', text: t(key),
            onclick: () => {
                if (fstate.types.has(type)) fstate.types.delete(type);
                else fstate.types.add(type);
                renderFilterControls();
                runFilter();
            },
        }));
    }
    box.append(chips);

    const from = h('input', { type: 'date', value: fstate.from, 'aria-label': t('chat.filter_from') });
    const to = h('input', { type: 'date', value: fstate.to, 'aria-label': t('chat.filter_to') });
    from.addEventListener('change', () => { fstate.from = from.value; runFilter(); });
    to.addEventListener('change', () => { fstate.to = to.value; runFilter(); });
    box.append(h('div', { class: 'filter-dates' }, [
        h('span', { class: 'muted', text: t('chat.filter_from') }), from,
        h('span', { class: 'muted', text: t('chat.filter_to') }), to,
        h('button', {
            class: 'btn small ghost', type: 'button', text: t('chat.filter_clear'),
            onclick: () => { fstate.types.clear(); fstate.from = ''; fstate.to = ''; renderFilterControls(); runFilter(); },
        }),
        h('button', { class: 'btn small', type: 'button', text: t('chat.close'), onclick: closeFilter }),
    ]));
}

async function runFilter() {
    const convId = S.activeConvId;
    const list = $('filter-list');
    if (!convId) return;
    fstate.loading = true;
    const q = new URLSearchParams();
    if (fstate.types.size) q.set('types', [...fstate.types].join(','));
    const from = dayStart(fstate.from);
    const to = dayAfter(fstate.to);
    if (from) q.set('from', String(from));
    if (to) q.set('to', String(to));
    q.set('limit', '60');
    try {
        const { messages } = await api('api/conversations/' + convId + '/messages/filter?' + q.toString());
        if (S.activeConvId !== convId || !filterOpen) return;
        list.textContent = '';
        if (!messages.length) {
            list.append(h('p', { class: 'muted', text: t('chat.filter_empty') }));
        } else {
            let prev = 0;
            for (const m of messages) {
                if (!prev || !sameDay(prev, m.createdAt)) {
                    list.append(h('div', { class: 'day-sep', text: fmtDay(m.createdAt) }));
                }
                prev = m.createdAt;
                list.append(msgEl(m));
            }
        }
    } catch (e) { toast(e.message); }
    fstate.loading = false;
}

/* ---------------- drag and drop ---------------- */

let dragDepth = 0;

function initDragDrop() {
    // Unconditional, window-level, and NOT passive. Without this a file dropped
    // anywhere outside the drop target makes the browser navigate to it, which
    // discards the SPA — the WebSocket, any in-progress call, everything. `drop`
    // also never fires unless the preceding `dragover` was prevented.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    const pane = $('chatpane');
    const zone = $('drop-zone');
    if (!pane || !zone) return;

    const carriesFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const show = (on) => { zone.hidden = !on; };

    // dragenter/leave fire for every child element, so nesting is counted rather
    // than toggled — otherwise the overlay flickers off crossing a bubble.
    pane.addEventListener('dragenter', (e) => {
        if (!carriesFiles(e) || !S.activeConvId) return;
        dragDepth += 1;
        show(true);
    });
    pane.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) show(false);
    });
    pane.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDepth = 0;
        show(false);
        if (!S.activeConvId) return;

        // dataTransfer.items is neutered as soon as this handler returns, so the
        // folder check has to happen NOW, before any await.
        const items = [...(e.dataTransfer?.items || [])];
        const hasDir = items.some((it) => it.kind === 'file'
            && typeof it.webkitGetAsEntry === 'function' && it.webkitGetAsEntry()?.isDirectory);
        const files = [...(e.dataTransfer?.files || [])];
        if (hasDir) { toast(t('chat.no_folders')); return; }
        if (files.length) onFilesPicked(files);
    });
}

/* ---------------- voice recording ---------------- */

let rec = null; // { recorder, stream, chunks, timer, start, kind }

function pickMime(cands) {
    if (!window.MediaRecorder) return null;
    for (const c of cands) if (MediaRecorder.isTypeSupported(c)) return c;
    return '';
}

/* Recording was previously left entirely to the browser, which is why the same
   spoken minute arrived at wildly different sizes: nothing asked for mono, so a
   stereo-capable device recorded two channels and doubled the bytes, and no
   bitrate was set, so each engine picked its own default (Chrome's is far higher
   than speech needs).

   Both are pinned now. Opus at 24 kbps mono is comfortably transparent for
   voice — about 180 KB per minute — and every browser that records at all
   supports it. */
const VOICE_AUDIO = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
};
const VOICE_BPS = 24_000;
const VOICE_BPS_ECO = 12_000;    // still intelligible, half the data
const VIDEOMSG_BPS = 500_000;
const VIDEOMSG_BPS_ECO = 200_000;

async function startVoice() {
    if (rec) return;
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: VOICE_AUDIO });
    } catch { toast(t('chat.mic_denied')); return; }
    const mime = pickMime(['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']);
    if (mime === null) { toast(t('chat.rec_unsupported')); stream.getTracks().forEach((tr) => tr.stop()); return; }
    const recorder = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        audioBitsPerSecond: ecoOn() ? VOICE_BPS_ECO : VOICE_BPS,
    });
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

let vrec = null; // { recorder, stream, chunks, timer, start, blob, canFlip, switching }

function vmVideoConstraints(deviceId) {
    return {
        // A specific camera is asked for by id when cycling; facingMode is only
        // the starting hint, because many cameras report no facing at all.
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
        width: { ideal: ecoOn() ? 480 : 720 },
        frameRate: { ideal: ecoOn() ? 20 : 30, max: 30 },
    };
}

async function cameraInputs() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter((d) => d.kind === 'videoinput');
    } catch { return []; }
}

// Mirror only a live front-facing view. Anything that does not explicitly say it
// is the rear camera is treated as front, same as the call self-view.
function vmSetMirror() {
    const facing = vrec?.stream.getVideoTracks()[0]?.getSettings?.().facingMode;
    $('videomsg-preview').classList.toggle('mirror', facing !== 'environment');
}

// Offered only in the live view: MediaRecorder is wired to the stream's track
// set when recording starts, and changing that set mid-recording is an error
// that kills the take. So the button hides while recording and during playback,
// and comes back on retake.
function vmFlipVisible(live) {
    $('videomsg-flip').hidden = !(live && vrec?.canFlip);
}

async function openVideoMsg() {
    if (!S.activeConvId) return;
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: vmVideoConstraints(),
            audio: VOICE_AUDIO,
        });
    } catch { toast(t('chat.cam_denied')); return; }
    vrec = { stream, recorder: null, chunks: [], timer: null, start: 0, blob: null, canFlip: false, switching: false };
    const modal = $('videomsg-modal');
    const prev = $('videomsg-preview');
    prev.srcObject = stream;
    prev.muted = true;
    prev.controls = false;
    vmSetMirror();
    modal.hidden = false;
    $('videomsg-record').hidden = false;
    $('videomsg-record').textContent = t('chat.vm_record');
    $('videomsg-send').hidden = true;
    $('videomsg-flip').hidden = true;
    $('videomsg-time').textContent = '0:00';
    // Device count is only trustworthy once permission is granted, which the
    // getUserMedia above has just done. `mine` pins the answer to THIS session:
    // by the time enumeration settles the modal may have been cancelled and
    // reopened, or a recording may already be running.
    const mine = vrec;
    cameraInputs().then((cams) => {
        if (vrec !== mine) return;
        vrec.canFlip = cams.length > 1;
        if (!vrec.recorder) vmFlipVisible(true);
    });
}

// Swap the video track for the next camera, keeping the audio track untouched.
// Unlike the in-call switch, the old camera is released BEFORE the new one is
// opened: nothing is consuming the stream yet, and many phones refuse to have
// both cameras open at once — which is exactly the phone this button is for.
//
// `vrec.recorder` being set means recording, finalizing, or playback — the flip
// is only legal in the live view, where the recorder does not exist yet.
async function flipVideoMsgCamera() {
    if (!vrec || vrec.switching || vrec.blob || vrec.recorder) return;
    const mine = vrec;   // identity, not truthiness: cancel + reopen makes a NEW session
    vrec.switching = true;
    try {
        const cams = await cameraInputs();
        if (vrec !== mine) return;
        if (cams.length < 2) { toast(t('call.no_other_camera')); return; }

        const old = mine.stream.getVideoTracks()[0];
        const currentId = old?.getSettings?.().deviceId;
        const at = cams.findIndex((d) => d.deviceId === currentId);
        const next = cams[((at < 0 ? 0 : at) + 1) % cams.length];

        if (old) { mine.stream.removeTrack(old); old.stop(); }

        let track = null, gotId = null;
        for (const id of [next.deviceId, currentId]) {
            if (!id) continue;
            try {
                const got = await navigator.mediaDevices.getUserMedia({ audio: false, video: vmVideoConstraints(id) });
                track = got.getVideoTracks()[0];
                if (track) { gotId = id; break; }
            } catch { /* try the fallback id */ }
        }
        // This session can be gone (cancelled — possibly with a fresh modal open
        // in its place) by the time getUserMedia settles. The track is not in any
        // stream yet, so nothing else can stop it; it must be stopped here.
        if (vrec !== mine) { if (track) track.stop(); return; }
        if (!track) { toast(t('chat.cam_denied')); closeVideoMsg(); return; }
        // The other camera refused and the old one was re-acquired: say so,
        // otherwise the unchanged picture reads as a dead button.
        if (gotId === currentId && gotId !== next.deviceId) toast(t('call.no_other_camera'));

        mine.stream.addTrack(track);
        // Same stream object, but re-assigning nudges engines that do not follow
        // live track changes on an already-attached srcObject.
        $('videomsg-preview').srcObject = mine.stream;
        vmSetMirror();
    } finally {
        if (vrec === mine) vrec.switching = false;
    }
}

function closeVideoMsg() {
    if (!vrec) return;
    clearInterval(vrec.timer);
    try { vrec.recorder?.state !== 'inactive' && vrec.recorder?.stop(); } catch { }
    vrec.stream.getTracks().forEach((tr) => tr.stop());
    const prev = $('videomsg-preview');
    prev.srcObject = null;
    prev.removeAttribute('src');
    prev.classList.remove('mirror');
    if (vrec.previewUrl) URL.revokeObjectURL(vrec.previewUrl);
    $('videomsg-modal').hidden = true;
    vrec = null;
}

// One button, four states, and the recorder object is the state marker: absent
// in the live view, 'recording' while a take runs, then present-but-inactive
// from stop() until retake. The branches must stay mutually exclusive on that —
// an over-broad "inactive" test here once made the retake branch unreachable, so
// tapping "Retake" recorded a new take blind over the frozen playback.
function videoMsgRecordToggle() {
    if (!vrec) return;
    const btn = $('videomsg-record');
    if (!vrec.recorder) {
        // Mid-switch the stream briefly has no video track, and a recorder
        // started then would be audio-only for the whole take.
        if (vrec.switching) return;
        const mime = pickMime(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']);
        if (mime === null) { toast(t('chat.rec_unsupported')); return; }
        // Pinned like the voice recorder, and for the same reason: an unset
        // bitrate lets each browser pick its own, so identical clips arrive at
        // wildly different sizes.
        vrec.recorder = new MediaRecorder(vrec.stream, {
            ...(mime ? { mimeType: mime } : {}),
            videoBitsPerSecond: ecoOn() ? VIDEOMSG_BPS_ECO : VIDEOMSG_BPS,
            audioBitsPerSecond: ecoOn() ? VOICE_BPS_ECO : VOICE_BPS,
        });
        vrec.chunks = [];
        // Pinned to THIS session: cancelling and reopening the modal makes a new
        // vrec, and a straggling onstop from the old recorder must not deliver
        // the old take into it.
        const mine = vrec;
        vrec.recorder.ondataavailable = (e) => { if (e.data.size) mine.chunks.push(e.data); };
        vrec.recorder.onstop = () => {
            if (vrec !== mine) return;
            const type = mine.recorder.mimeType || 'video/webm';
            mine.blob = new Blob(mine.chunks, { type });
            mine.duration = (Date.now() - mine.start) / 1000;
            const prev = $('videomsg-preview');
            prev.srcObject = null;
            if (mine.previewUrl) URL.revokeObjectURL(mine.previewUrl);
            mine.previewUrl = URL.createObjectURL(mine.blob);
            prev.src = mine.previewUrl;
            prev.muted = false;
            prev.controls = true;
            // Playback shows the clip as recorded — never mirrored.
            prev.classList.remove('mirror');
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
        vmFlipVisible(false);
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
        vmSetMirror();
        vrec.blob = null;
        vrec.recorder = null;
        $('videomsg-send').hidden = true;
        $('videomsg-record').textContent = t('chat.vm_record');
        $('videomsg-time').textContent = '0:00';
        vmFlipVisible(true);
    }
    // Remaining case: stop() sent but onstop not yet fired. A click there must
    // do nothing — building a second recorder mid-finalization corrupts the take.
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

function closeLightbox() {
    $('lightbox').hidden = true;
    document.removeEventListener('keydown', onLightboxKey, true);
}
function onLightboxKey(e) { if (e.key === 'Escape') closeLightbox(); }

function showLightbox(src, name) {
    const lb = $('lightbox');
    lb.textContent = '';
    lb.append(h('img', { src, alt: '' }));

    // Save without leaving the viewer. stopPropagation on both controls so the
    // click does not fall through to the backdrop, which dismisses.
    const dl = h('a', {
        class: 'lightbox-btn lightbox-dl', href: src,
        download: name || 'image', title: t('chat.download'),
    });
    dl.append(svgIcon(DL_SVG));
    dl.addEventListener('click', (e) => e.stopPropagation());

    // Explicit close, for anyone who does not realise the backdrop is tappable —
    // on a wide image there is barely any backdrop left to tap.
    const close = h('button', {
        class: 'lightbox-btn lightbox-close', type: 'button',
        title: t('chat.close'), 'aria-label': t('chat.close'),
    });
    close.append(svgIcon(CLOSE_SVG));
    close.addEventListener('click', (e) => { e.stopPropagation(); closeLightbox(); });

    lb.append(h('div', { class: 'lightbox-tools' }, [dl, close]));
    lb.hidden = false;
    document.addEventListener('keydown', onLightboxKey, true);
}

/* ---------------- init ---------------- */

export function initChat() {
    // Any avatar anywhere can ask for its photo full size.
    bus.on('image-zoom', ({ src, name }) => showLightbox(src, name));
    $('btn-send').addEventListener('click', sendText);
    const input = $('composer-input');
    input.addEventListener('input', () => saveDraftSoon(S.activeConvId, input.value));
    // A backgrounded tab on mobile may never come back, so the pending write is
    // forced out at the last moment it is still allowed to run.
    const flush = () => saveDraft(S.activeConvId, input.value);
    input.addEventListener('blur', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
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

    initDragDrop();
    $('btn-filter').addEventListener('click', () => (filterOpen ? closeFilter() : openFilter()));
    $('file-input').addEventListener('change', (e) => {
        onFilesPicked([...e.target.files]);
        e.target.value = '';
    });

    $('btn-voice').addEventListener('click', startVoice);
    $('rec-cancel').addEventListener('click', () => stopVoice(false));
    $('rec-send').addEventListener('click', () => stopVoice(true));

    $('btn-videomsg').addEventListener('click', openVideoMsg);
    $('videomsg-cancel').addEventListener('click', closeVideoMsg);
    // Same teardown as Cancel — closing must release the camera, not just
    // hide the window.
    $('videomsg-close').addEventListener('click', closeVideoMsg);
    $('videomsg-flip').addEventListener('click', flipVideoMsgCamera);
    $('videomsg-record').addEventListener('click', videoMsgRecordToggle);
    $('videomsg-send').addEventListener('click', sendVideoMsg);

    $('btn-back').addEventListener('click', closeConv);
    $('msg-scroll').addEventListener('scroll', maybeLoadOlder);
    $('lightbox').addEventListener('click', closeLightbox);

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && S.activeConvId) markRead(S.activeConvId);
    });
}
