// Translation lookup.
//
// INVARIANT: this module imports nothing from core.js. core.js is the leaf that
// every other module depends on, and it imports t() from here — a reverse edge
// would put core.js's `S` and `bus` in the temporal dead zone during this
// module's evaluation, producing a ReferenceError that only reproduces on a cold
// load. applyStatic() therefore uses plain DOM APIs, not the h()/$() helpers.
//
// Dictionaries are imported statically rather than via import(): dynamic import
// is allowed by the CSP but costs a serial round trip and would force t() to be
// async, which every render path calls synchronously.
//
// Not translated by design: the PWA manifest. A per-device preference cannot
// reach a static file, and an installed app's name is fixed at install time.

import en from './i18n/en.js';
import fa from './i18n/fa.js';

const DICTS = { en, fa };

// window.cwLang resolved this before first paint; never re-derive it from
// navigator here, or the two could disagree.
const LANG = (window.cwLang && window.cwLang.code) || 'en';
export const locale = (window.cwLang && window.cwLang.locale) || 'en';

const DICT = DICTS[LANG] || en;

function lookup(key) {
    // Chain: chosen language -> English -> a visible marker. Never undefined and
    // never '' — h() silently drops an undefined prop, which would strip the
    // accessible name from every icon-only button and leave a screen reader
    // announcing nothing but "button".
    const hit = DICT[key];
    if (typeof hit === 'string') return hit;
    const fallback = en[key];
    if (typeof fallback === 'string') return fallback;
    console.warn('i18n: missing key ' + key);
    return '⟪' + key + '⟫';
}

// Whether a key is known to this build at all. Callers rendering server-supplied
// keys use it to fall back to the server's own text rather than showing a marker
// for something a newer server introduced.
export function has(key) {
    return typeof DICT[key] === 'string' || typeof en[key] === 'string';
}

// t('a.key') or t('a.key', { name: 'Sam' }); with a numeric `n`, a key may
// branch via the _one / _other suffixes.
export function t(key, vars) {
    let k = key;
    if (vars && typeof vars.n === 'number') {
        const suffixed = k + (vars.n === 1 ? '_one' : '_other');
        if (typeof DICT[suffixed] === 'string' || typeof en[suffixed] === 'string') k = suffixed;
    }
    const raw = lookup(k);
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (m, name) => (
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m
    ));
}

// Translate the markup that ships in index.html. Values are always written via
// textContent or setAttribute, never innerHTML, so a dictionary can never inject
// markup.
export function applyStatic(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) {
        el.textContent = t(el.getAttribute('data-i18n'));
    }
    for (const [attr, prop] of [
        ['data-i18n-title', 'title'],
        ['data-i18n-placeholder', 'placeholder'],
        ['data-i18n-aria-label', 'aria-label'],
    ]) {
        for (const el of root.querySelectorAll('[' + attr + ']')) {
            el.setAttribute(prop, t(el.getAttribute(attr)));
        }
    }
}
