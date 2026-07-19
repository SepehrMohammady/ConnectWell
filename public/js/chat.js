// Chat pane: message rendering, composer, uploads, voice & video messages.

import { api, upload } from './api.js';
import {
    S, $, h, bus, net, toast, avatarEl, userName, convTitle, convOther,
    fmtTime, fmtDay, sameDay, fmtSize, fmtDur, userById, userAvatar, convAvatarSrc,
} from './core.js';

const MIC_SVG = 'M12 14c1.7 0 3-1.3 3-3V5c0-1.7-1.3-3-3-3S9 3.3 9 5v6c0 1.7 1.3 3 3 3zm5.3-3c0 3-2.5 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.4 2.7 6.2 6 6.7V21h2v-3.3c3.3-.5 6-3.3 6-6.7h-1.7z';
const FILE_SVG = 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z';

function svgIcon(d) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
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
        $('chat-sub').textContent = conv.members.length + ' members';
    } else {
        const other = convOther(conv);
        $('chat-sub').textContent = S.online.has(other) ? 'online' : 'offline';
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
    el.append(h('span', {
        text: 'Shared files are removed automatically after a while to free space. '
            + 'Removal is permanent, so save anything you want to keep.',
    }));
    el.append(h('button', {
        class: 'btn small ghost', type: 'button', text: 'Got it',
        onclick: () => {
            el.hidden = true;
            try { localStorage.setItem(ATTACH_NOTE_KEY, '1'); } catch { /* private mode */ }
        },
    }));
    el.hidden = false;
}

function purgedChip(m) {
    const label = m.fileName
        || (m.type === 'voice' ? 'Voice message' : m.type === 'videomsg' ? 'Video message' : 'File');
    const chip = h('div', {
        class: 'file-chip file-gone', role: 'note',
        title: 'This file was removed to free storage space and cannot be recovered.',
    });
    chip.append(svgIcon(FILE_SVG));
    chip.append(h('div', {}, [
        h('div', { class: 'fc-name', text: label }),
        h('div', {
            class: 'fc-size',
            text: 'Removed to free space' + (m.fileSize ? ' · ' + fmtSize(m.fileSize) : ''),
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
            const img = h('img', { class: 'msg-img', src, alt: m.fileName || 'image', loading: 'lazy' });
            img.addEventListener('click', () => showLightbox(src));
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

function msgEl(m) {
    if (m.type === 'system') {
        return h('div', { class: 'msg-sys', text: m.content || '', dataset: { mid: m.id } });
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
    if (m.deleted) {
        bubble.append('Message deleted');
    } else {
        bubble.append(bubbleContent(m));
        bubble.append(h('span', { class: 'meta', text: fmtTime(m.createdAt) }));
        if (mine) {
            const del = h('button', { class: 'msg-del', title: 'Delete message', type: 'button', text: '✕' });
            del.addEventListener('click', async () => {
                if (!confirm('Delete this message?')) return;
                try { await api('api/messages/' + m.id, { method: 'DELETE' }); }
                catch (e) { toast(e.message); }
            });
            bubble.append(del);
        }
    }
    row.append(bubble);
    return row;
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
    for (const t of typingTimers.values()) clearTimeout(t);
    typingTimers.clear();
    renderTyping();
}

function renderTyping() {
    const names = [...typingTimers.keys()].map(userName);
    const el = $('typing-line');
    if (names.length === 0) { el.hidden = true; return; }
    el.textContent = names.join(', ') + (names.length === 1 ? ' is' : ' are') + ' typing…';
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
            h('div', { class: 'up-name', text: 'Uploading ' + (fileName || 'file') + '…' }),
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
        temp.querySelector('.up-name').textContent = 'Failed: ' + e.message;
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
    } catch { toast('Microphone access is needed for voice messages'); return; }
    const mime = pickMime(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']);
    if (mime === null) { toast('Recording is not supported in this browser'); stream.getTracks().forEach((t) => t.stop()); return; }
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec = { recorder, stream, chunks: [], start: Date.now(), timer: null, kind: 'voice' };
    recorder.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
    recorder.start(500);
    $('composer').hidden = true;
    $('rec-bar').hidden = false;
    $('rec-label').textContent = 'Recording voice message…';
    rec.timer = setInterval(() => { $('rec-time').textContent = fmtDur((Date.now() - rec.start) / 1000); }, 300);
}

function stopVoice(send) {
    if (!rec) return;
    const { recorder, stream, start } = rec;
    const duration = (Date.now() - start) / 1000;
    const finish = () => {
        const type = recorder.mimeType || 'audio/webm';
        const blob = new Blob(rec.chunks, { type });
        stream.getTracks().forEach((t) => t.stop());
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
    } catch { toast('Camera access is needed for video messages'); return; }
    vrec = { stream, recorder: null, chunks: [], timer: null, start: 0, blob: null };
    const modal = $('videomsg-modal');
    const prev = $('videomsg-preview');
    prev.srcObject = stream;
    prev.muted = true;
    prev.controls = false;
    modal.hidden = false;
    $('videomsg-record').hidden = false;
    $('videomsg-record').textContent = 'Record';
    $('videomsg-send').hidden = true;
    $('videomsg-time').textContent = '0:00';
}

function closeVideoMsg() {
    if (!vrec) return;
    clearInterval(vrec.timer);
    try { vrec.recorder?.state !== 'inactive' && vrec.recorder?.stop(); } catch { }
    vrec.stream.getTracks().forEach((t) => t.stop());
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
        if (mime === null) { toast('Recording is not supported in this browser'); return; }
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
            btn.textContent = 'Retake';
        };
        vrec.start = Date.now();
        vrec.recorder.start(500);
        vrec.timer = setInterval(() => {
            $('videomsg-time').textContent = fmtDur((Date.now() - vrec.start) / 1000);
            if (Date.now() - vrec.start > 3 * 60_000) videoMsgRecordToggle(); // 3 min cap
        }, 300);
        btn.textContent = 'Stop';
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
        $('videomsg-record').textContent = 'Record';
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

function showLightbox(src) {
    const lb = $('lightbox');
    lb.textContent = '';
    lb.append(h('img', { src, alt: '' }));
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
