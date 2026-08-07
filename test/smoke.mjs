// Executes the real frontend modules under a minimal DOM shim, in the language
// given as argv[2] (default 'en'). Catches what static checks cannot: missing
// exports, import cycles, and anything that throws while a module initialises.
//
// Each language runs in its OWN process. The module graph is evaluated once, and
// i18n.js resolves the language at evaluation time, so a second language cannot
// be tested by re-importing with a cache-busting query — core.js would still
// import the already-cached English i18n.js.
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const LANG = process.argv[2] === 'fa' ? 'fa' : 'en';

function makeEl(tag = 'div') {
    const attrs = new Map();
    return {
        tagName: tag, children: [], style: {}, dataset: {},
        classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
        hidden: false, textContent: '', className: '', value: '', files: [],
        addEventListener() { }, removeEventListener() { }, append() { }, remove() { },
        replaceWith() { }, insertBefore() { },
        setAttribute(k, v) { attrs.set(k, String(v)); },
        getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
        removeAttribute(k) { attrs.delete(k); },
        querySelector: () => null, querySelectorAll: () => [],
        click() { }, focus() { }, closest: () => null,
        getBoundingClientRect: () => ({}), scrollIntoView() { },
    };
}

const doc = {
    documentElement: makeEl('html'),
    body: makeEl('body'),
    hidden: false,
    getElementById: () => makeEl(),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    createElement: (t) => makeEl(t),
    createElementNS: (ns, t) => makeEl(t),
    createTextNode: (s) => ({ nodeType: 3, textContent: String(s) }),
    createDocumentFragment: () => makeEl('fragment'),
    addEventListener() { },
};

const store = new Map();
globalThis.document = doc;
// Node 21+ defines navigator as a getter-only global, so it must be redefined.
Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: {
        language: LANG === 'fa' ? 'fa-IR' : 'en-GB',
        languages: LANG === 'fa' ? ['fa-IR', 'en-GB'] : ['en-GB'],
        mediaDevices: {},
    },
});
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};
globalThis.location = { protocol: 'https:', host: 'x.test', pathname: '/connectwell/', reload() { } };
globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'no' }) });
globalThis.WebSocket = function () { return { readyState: 0, close() { } }; };
globalThis.URL.createObjectURL = () => 'blob:x';
globalThis.URL.revokeObjectURL = () => { };
globalThis.matchMedia = () => ({ matches: false, addEventListener() { }, addListener() { } });
// A real window has these; the app registers beforeinstallprompt/appinstalled here.
globalThis.addEventListener = () => { };
globalThis.removeEventListener = () => { };
globalThis.window = globalThis;
globalThis.AudioContext = function () {
    return {
        state: 'running', currentTime: 0, resume() { }, destination: {},
        createOscillator: () => ({ connect: () => ({ connect() { } }), start() { }, stop() { }, frequency: {}, type: '' }),
        createGain: () => ({ connect: () => ({ connect() { } }), gain: { setValueAtTime() { }, linearRampToValueAtTime() { } } }),
    };
};

const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

let fail = 0;
const step = async (label, fn) => {
    try { await fn(); console.log('  PASS ' + label); }
    catch (e) { fail++; console.log('  FAIL ' + label + '\n        ' + (e && e.message ? e.message : e)); }
};

console.log('language: ' + LANG);

// lang.js is a classic script: run it the way a <script> tag would.
await step('lang.js resolves the language before first paint', async () => {
    new Function(fs.readFileSync(path.join(ROOT, 'public/js/lang.js'), 'utf8'))();
    const L = globalThis.cwLang;
    if (!L) throw new Error('window.cwLang was not created');
    if (L.code !== LANG) throw new Error('expected ' + LANG + ', got ' + L.code);
    const wantDir = LANG === 'fa' ? 'rtl' : 'ltr';
    const gotDir = doc.documentElement.getAttribute('dir');
    if (gotDir !== wantDir) throw new Error('dir = ' + gotDir + ', expected ' + wantDir);
    const wantLang = LANG === 'fa' ? 'fa-IR' : 'en';
    if (doc.documentElement.getAttribute('lang') !== wantLang) {
        throw new Error('lang = ' + doc.documentElement.getAttribute('lang'));
    }
});

let i18n;
await step('i18n.js loads and exports its API', async () => {
    i18n = await load('public/js/i18n.js');
    for (const fn of ['t', 'has', 'applyStatic']) {
        if (typeof i18n[fn] !== 'function') throw new Error(fn + ' is not exported');
    }
});

await step('t() returns text in the active language', async () => {
    const v = i18n.t('ui.auth.login.submit');
    const want = LANG === 'fa' ? 'ورود' : 'Sign in';
    if (v !== want) throw new Error('got ' + JSON.stringify(v) + ', expected ' + JSON.stringify(want));
});

await step('t() interpolates named slots', async () => {
    const name = LANG === 'fa' ? 'سپهر' : 'Alice';
    const v = i18n.t('sys.group_created', { name });
    if (!v.includes(name)) throw new Error('slot not filled: ' + v);
    if (v.includes('{')) throw new Error('unfilled slot left in: ' + v);
});

await step('t() picks plural forms from n', async () => {
    const one = i18n.t('chat.typing', { n: 1, names: 'x' });
    const many = i18n.t('chat.typing', { n: 2, names: 'x' });
    if (one === many) throw new Error('singular and plural are identical: ' + one);
});

await step('a missing key never yields undefined or empty', async () => {
    const v = i18n.t('does.not.exist.at.all');
    if (v === undefined || v === '') throw new Error('got ' + JSON.stringify(v));
});

for (const m of ['core', 'api', 'avatar', 'eco', 'chat', 'calls', 'app']) {
    await step('module executes: ' + m + '.js', async () => { await load('public/js/' + m + '.js'); });
}

await step('dates and numbers follow the locale', async () => {
    const core = await load('public/js/core.js');
    // A date well in the past, so it formats a real date rather than "Today".
    const old = Date.now() - 60 * 86400000;
    const day = core.fmtDay(old);
    const size = core.fmtSize(2500000);
    const dur = core.fmtDur(65);
    const persian = /[۰-۹]/;
    if (LANG === 'fa') {
        if (!persian.test(day)) throw new Error('fmtDay has no Persian digits: ' + day);
        if (!persian.test(size)) throw new Error('fmtSize has no Persian digits: ' + size);
        if (!/^[۰-۹]+:[۰-۹]{2}$/.test(dur)) throw new Error('fmtDur not fully Persian: ' + dur);
    } else {
        if (persian.test(day + size + dur)) throw new Error('Persian digits leaked into English');
        if (dur !== '1:05') throw new Error('fmtDur = ' + dur);
    }
    console.log('        fmtDay ' + day + '   fmtSize ' + size + '   fmtDur ' + dur);
});

await step('a blank display name never renders "UNDEFINED"', async () => {
    const core = await load('public/js/core.js');
    if (core.initials('   ') !== '?') throw new Error('got ' + core.initials('   '));
});

console.log('\n' + (fail === 0 ? 'SMOKE TEST PASSED (' + LANG + ')' : fail + ' FAILURE(S) in ' + LANG));
process.exit(fail === 0 ? 0 : 1);
