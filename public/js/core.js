// Shared state, tiny DOM helpers, formatting, sounds. Imports only i18n.js,
// which is a leaf and imports nothing back from here.

import { t, locale } from './i18n.js';

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
    // `evt`, not `t`: a parameter named `t` would shadow the imported t().
    on(evt, f) { (handlers[evt] = handlers[evt] || []).push(f); },
    emit(evt, ...a) { for (const f of handlers[evt] || []) f(...a); },
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

/* The locale is resolved once before first paint and cannot change without a
   reload, so the formatters are built once here rather than inside the render
   loops — renderAll() formats every message in a conversation and
   renderConvList() every row, and constructing an Intl formatter per iteration is
   the one genuinely costly mistake available here.

   For Farsi this produces the Persian calendar and Persian digits (۱۲۳) with no
   special-casing: both follow from the locale tag. */
const fmt = {
    time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }),
    dayMonth: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }),
    dayMonthYear: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }),
    year: new Intl.DateTimeFormat(locale, { year: 'numeric' }),
    int: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
    dec1: new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    dec2: new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    // Pads using the locale's own zero, so a Persian duration reads ۰۵ rather
    // than an ASCII 0 glued to a Persian 5.
    pad2: new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false }),
};

export function fmtTime(ts) {
    return fmt.time.format(ts);
}

// Correct for Jalali as-is: a Persian day begins at the same local midnight as a
// Gregorian one, so comparing local year/month/date still identifies "same day".
export function sameDay(a, b) {
    const x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export function fmtDay(ts) {
    const now = new Date();
    if (sameDay(ts, now.getTime())) return t('core.day.today');
    const yest = new Date(now); yest.setDate(now.getDate() - 1);   // DST-safe
    if (sameDay(ts, yest.getTime())) return t('core.day.yesterday');
    // Compare FORMATTED years, not getFullYear(): the Gregorian year rolls over
    // in the middle of the Persian one, so the raw test would append the year for
    // the wrong eleven weeks annually — and omit it when it is actually needed.
    return fmt.year.format(ts) === fmt.year.format(now)
        ? fmt.dayMonth.format(ts)
        : fmt.dayMonthYear.format(ts);
}

export function fmtListTime(ts) {
    return sameDay(ts, Date.now()) ? fmtTime(ts) : fmt.dayMonth.format(ts);
}

// The rounding stays here; only the number-plus-unit glue moves into the
// dictionary, so a language that puts the unit first can reorder the slot.
// The slot is `size`, not `n`: a numeric `n` would send t() down the
// _one/_other branch, which these keys do not have.
export function fmtSize(bytes) {
    if (bytes < 1024) return t('core.size.b', { size: fmt.int.format(bytes) });
    if (bytes < 1024 * 1024) return t('core.size.kb', { size: fmt.int.format(bytes / 1024) });
    if (bytes < 1024 * 1024 * 1024) return t('core.size.mb', { size: fmt.dec1.format(bytes / 1048576) });
    return t('core.size.gb', { size: fmt.dec2.format(bytes / 1073741824) });
}

export function fmtDur(sec) {
    sec = Math.round(sec || 0);
    return fmt.int.format(Math.floor(sec / 60)) + ':' + fmt.pad2.format(sec % 60);
}

/* ---------------- avatars ---------------- */

export function initials(name) {
    // Strip bidi controls and zero-width characters first: a Persian name may
    // legitimately contain them, and taking one as an "initial" renders a blank.
    const clean = String(name || '')
        // zero-width + bidi embedding/override/isolate controls
        .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
        .trim();
    const parts = clean.split(/\s+/).filter(Boolean);
    // A whitespace-only display name used to reach parts[0][0] === undefined and
    // render the literal text "UNDEFINED" inside the avatar.
    if (!parts.length) return '?';
    // Array.from is code-point safe; [0] alone splits an astral character in half.
    const first = Array.from(parts[0])[0] || '';
    const second = parts[1] ? (Array.from(parts[1])[0] || '') : '';
    return (first + second).toLocaleUpperCase(locale);
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
    return userById(id)?.displayName || t('core.user.fallback');
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
    if (conv.type === 'group') return conv.name || t('core.conv.group_fallback');
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
