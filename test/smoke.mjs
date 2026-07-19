// Executes the real frontend modules under a minimal DOM shim.
// Catches what static checks cannot: missing exports, import cycles/TDZ errors,
// and anything that throws while a module initialises.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = process.argv[2] || process.cwd();

function makeEl(tag = 'div') {
    const el = {
        tagName: tag, children: [], style: {}, dataset: {}, classList: {
            add() { }, remove() { }, toggle() { }, contains: () => false,
        },
        hidden: false, textContent: '', className: '', value: '', files: [],
        addEventListener() { }, removeEventListener() { }, append() { }, remove() { },
        replaceWith() { }, setAttribute() { }, getAttribute: () => null,
        removeAttribute() { }, querySelector: () => null, querySelectorAll: () => [],
        click() { }, focus() { }, closest: () => null, getBoundingClientRect: () => ({}),
        scrollIntoView() { },
    };
    return el;
}

const doc = {
    documentElement: makeEl('html'),
    body: makeEl('body'),
    hidden: false,
    getElementById: () => makeEl(),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    createElement: (t) => makeEl(t),
    createElementNS: (ns, t) => Object.assign(makeEl(t), { setAttribute() { }, append() { } }),
    createTextNode: (s) => ({ nodeType: 3, textContent: String(s) }),
    createDocumentFragment: () => makeEl('fragment'),
    addEventListener() { },
};

const store = new Map();
globalThis.document = doc;
// Node 21+ defines navigator as a getter-only global, so it must be redefined.
Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: { language: 'en-GB', languages: ['en-GB'], mediaDevices: {} },
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
globalThis.window = globalThis;
globalThis.AudioContext = function () { return { state: 'running', currentTime: 0, resume() { }, createOscillator: () => ({ connect: () => ({ connect() { } }), start() { }, stop() { }, frequency: {}, type: '' }), createGain: () => ({ connect: () => ({ connect() { } }), gain: { setValueAtTime() { }, linearRampToValueAtTime() { } } }), destination: {} }; };

const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

let fail = 0;
const step = async (label, fn) => {
    try { await fn(); console.log('  PASS ' + label); }
    catch (e) { fail++; console.log('  FAIL ' + label + '\n        ' + (e && e.message ? e.message : e)); }
};

// lang.js and theme.js are classic scripts: run them the way a <script> tag would.
await step('lang.js runs and stamps lang/dir', async () => {
    const fs = await import('node:fs');
    new Function(fs.readFileSync(path.join(ROOT, 'public/js/lang.js'), 'utf8'))();
    if (!globalThis.cwLang) throw new Error('window.cwLang was not created');
    if (globalThis.cwLang.code !== 'en') throw new Error('expected en, got ' + globalThis.cwLang.code);
});

let i18n;
await step('i18n.js loads with both dictionaries', async () => {
    i18n = await load('public/js/i18n.js');
    if (typeof i18n.t !== 'function') throw new Error('t is not exported');
    if (typeof i18n.has !== 'function') throw new Error('has is not exported');
    if (typeof i18n.applyStatic !== 'function') throw new Error('applyStatic is not exported');
});

await step('t() returns real English, never undefined', async () => {
    const v = i18n.t('ui.auth.tab.signIn');
    if (v !== 'Sign in') throw new Error('got ' + JSON.stringify(v));
});
await step('t() interpolates named slots', async () => {
    const v = i18n.t('sys.group_created', { name: 'Alice' });
    if (v !== 'Alice created the group') throw new Error('got ' + JSON.stringify(v));
});
await step('t() picks plural forms from n', async () => {
    const one = i18n.t('chat.typing', { n: 1, names: 'Bob' });
    const many = i18n.t('chat.typing', { n: 2, names: 'Bob, Ann' });
    if (one === many) throw new Error('singular and plural resolved identically: ' + one);
});
await step('a missing key never yields undefined or empty', async () => {
    const v = i18n.t('does.not.exist.at.all');
    if (v === undefined || v === '') throw new Error('got ' + JSON.stringify(v));
});

for (const m of ['core', 'api', 'avatar', 'chat', 'calls', 'app']) {
    await step('module executes: ' + m + '.js', async () => { await load('public/js/' + m + '.js'); });
}

console.log('\n' + (fail === 0 ? 'SMOKE TEST PASSED' : fail + ' FAILURE(S)'));
process.exit(fail === 0 ? 0 : 1);
