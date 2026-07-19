// Shared state, tiny DOM helpers, formatting, sounds. No imports.

export const S = {
    me: null,
    users: new Map(),          // userId -> user
    convs: new Map(),          // convId -> conversation
    online: new Set(),         // userIds online
    activeConvId: null,
    msgs: new Map(),           // convId -> { list: [], ids: Set, complete, loading }
    calls: new Map(),          // convId -> call state (from server)
    connId: null,
    pendingCount: 0,
};

/* ---------------- event bus ---------------- */

const handlers = {};
export const bus = {
    on(t, f) { (handlers[t] = handlers[t] || []).push(f); },
    emit(t, ...a) { for (const f of handlers[t] || []) f(...a); },
};

// app.js assigns the live WebSocket sender here.
export const net = { send: () => { } };

/* ---------------- DOM ---------------- */

export const $ = (id) => document.getElementById(id);

export function h(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null) continue;
        if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else el.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
        if (c === null || c === undefined) continue;
        el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
}

/* ---------------- formatting ---------------- */

export function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function sameDay(a, b) {
    const x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export function fmtDay(ts) {
    const d = new Date(ts), now = new Date();
    if (sameDay(ts, now.getTime())) return 'Today';
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (sameDay(ts, yest.getTime())) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

export function fmtListTime(ts) {
    return sameDay(ts, Date.now()) ? fmtTime(ts)
        : new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function fmtDur(sec) {
    sec = Math.round(sec || 0);
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

/* ---------------- avatars ---------------- */

export function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

function hueFor(str) {
    let x = 0;
    for (const c of String(str)) x = (x * 31 + c.codePointAt(0)) % 360;
    return x;
}

// `name` stays positional and a photo is opt-in through `src`, so no call site
// reorders arguments and the initials/hue path is untouched when there is none.
export function avatarEl(name, { online = null, size = '', group = false, src = null } = {}) {
    const el = h('div', { class: 'avatar ' + size });
    const dot = () => {
        if (online !== null) el.append(h('span', { class: 'dot' + (online ? ' on' : '') }));
    };
    // Assigning textContent wipes any child, so the photo and the initials must
    // be mutually exclusive rather than sequential.
    const fallback = () => {
        el.textContent = group ? '👥' : initials(name);
        if (!group) el.style.background = `hsl(${hueFor(name)} 45% 38%)`;
        dot();
    };
    if (src) {
        // onerror degrades to initials if the file is missing or the token is stale.
        el.append(h('img', { src, alt: '', loading: 'lazy', onerror: fallback }));
        dot();
    } else {
        fallback();
    }
    return el;
}

/* ---------------- names ---------------- */

// S.me and S.users.get(S.me.id) are separate objects, so self must be resolved
// explicitly or a lookup returns a stale copy of your own record.
export function userById(id) {
    if (S.me && id === S.me.id) return S.me;
    return S.users.get(id) || null;
}

export function userName(id) {
    return userById(id)?.displayName || 'User';
}

export function userAvatar(u) {
    return u && u.avatar ? `api/avatars/u${u.id}/${u.avatar}` : null;
}

// One place decides where a conversation's picture comes from. A direct chat has
// no picture of its own — it borrows the other participant's, so it keeps up when
// they change their photo (user:updated never touches S.convs).
export function convAvatarSrc(conv) {
    if (!conv) return null;
    if (conv.type === 'group') {
        return conv.id && conv.avatar ? `api/avatars/c${conv.id}/${conv.avatar}` : null;
    }
    return userAvatar(userById(convOther(conv)));
}

export function convTitle(conv) {
    if (conv.type === 'group') return conv.name || 'Group';
    const otherId = conv.members.find((m) => m !== S.me.id);
    return userName(otherId ?? S.me.id);
}

export function convOther(conv) {
    return conv.type === 'direct' ? conv.members.find((m) => m !== S.me.id) : null;
}

/* ---------------- toast ---------------- */

let toastTimer = null;
export function toast(msg, ms = 3000) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ---------------- sounds (WebAudio, no assets) ---------------- */

let actx = null;
function ctx() {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume().catch(() => { });
    return actx;
}

function tone(freq, start, dur, gain = 0.08, type = 'sine') {
    const c = ctx();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, c.currentTime + start);
    g.gain.linearRampToValueAtTime(gain, c.currentTime + start + 0.02);
    g.gain.linearRampToValueAtTime(0, c.currentTime + start + dur);
    o.connect(g).connect(c.destination);
    o.start(c.currentTime + start);
    o.stop(c.currentTime + start + dur + 0.05);
}

export function popSound() {
    try { tone(880, 0, 0.09, 0.05); tone(1320, 0.07, 0.09, 0.04); } catch { }
}

let ringTimer = null;
export function ringStart() {
    if (ringTimer) return;
    const play = () => { try { tone(700, 0, 0.35, 0.09); tone(880, 0.45, 0.35, 0.09); } catch { } };
    play();
    ringTimer = setInterval(play, 2200);
}

export function ringStop() {
    clearInterval(ringTimer);
    ringTimer = null;
}
