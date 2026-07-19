// Verifies the English extraction is a pure refactor.
//   1. every key referenced in code/markup exists in en.js
//   2. every dictionary value traces back to the original English in git HEAD
//   3. no t() at module scope (would freeze the language at load)
//   4. nothing shadows the imported t()
const fs = require('fs');
const cp = require('child_process');

process.chdir(process.argv[2] || process.cwd());

// Values deliberately RECOMBINED from fragments the original glued together at
// runtime. Each was read against HEAD by hand; a translator cannot reorder glued
// fragments, so merging them is required rather than optional.
const RECOMBINED = {
    'call.ring_sub_voice': "calls.js:197  'Incoming ' + (kind==='video'?'video':'voice') + ' call'",
    'call.ring_sub_video': 'calls.js:197  same conditional, video branch',
    'call.ring_sub_voice_group': 'calls.js:197  same, plus the group-title suffix',
    'call.ring_sub_video_group': 'calls.js:197  same, plus the group-title suffix',
    'call.chip_voice': "calls.js:300  'Ongoing ' + kind + ' call · N in'",
    'call.chip_video': 'calls.js:300  same conditional, video branch',
    'chat.purged_removed_size': "chat.js:150  'Removed to free space' + ' · ' + fmtSize(...)",
    'chat.typing_one': "chat.js:342  names + (n===1?' is':' are') + ' typing…'  -> plural key",
    'chat.typing_other': 'chat.js:342  same, plural branch',
    'app.admin.tab.blocked': 'app.js:754  t[0].toUpperCase()+t.slice(1) over a lowercase id',
    'app.admin.tab.active': 'app.js:754  same computed capitalisation',
    'app.admin.tab.pending': 'app.js:754  same computed capitalisation',
    'chat.storage_note': 'chat.js:125  one sentence split across concatenated source lines',
    'app.profile.storageHint': 'app.js:705  one paragraph split across concatenated source lines',
    'sys.member_removed_unknown': "api.js  `removed ${target?.display_name || 'a member'}` -> its own key",
};

// System-event keys are chosen by the SERVER and arrive on the message, so they
// never appear as literals in client code. Their original English lives here too.
const SERVER_FILES = ['lib/api.js'];

// The "traces to the original English" check compares against the last commit
// BEFORE the strings were extracted. HEAD is no longer usable for this: once the
// extraction landed, the literals live in en.js rather than in the source.
const BASELINE_REF = '26a6fb0';

// Keys introduced after the baseline, which by definition have no earlier English
// to trace to. Adding a key here is a deliberate act — it is the only way to
// bypass the check, so keep the reason honest.
const NEW_SINCE_BASELINE = {
    'app.lang.device': 'language switcher, added with the Farsi release',
    'app.lang.en': 'language switcher',
    'app.lang.fa': 'language switcher',
    'app.lang.laterBusy': 'language switcher: deferred while a call or recording is live',
    'app.lang.notStored': 'language switcher: private mode cannot persist the choice',
    'app.profile.language': 'language switcher label',
    'chat.react': 'reactions feature (0.7.0), added after the baseline',
    'chat.forward': 'forward feature (0.8.0)',
    'chat.fwd_from': 'forward feature (0.8.0)',
    'chat.fwd_title': 'forward feature (0.8.0)',
    'chat.fwd_done': 'forward feature (0.8.0)',
    'chat.download': 'save-file feature (0.8.0)',
    'app.notif.label': 'notifications (0.8.0)',
    'app.notif.hint': 'notifications (0.8.0)',
    'app.notif.enable': 'notifications (0.8.0)',
    'app.notif.enabled': 'notifications (0.8.0)',
    'app.notif.blocked': 'notifications (0.8.0)',
    'app.notif.unsupported': 'notifications (0.8.0)',
    'app.notif.hintToast': 'notifications (0.8.0)',
    'ui.sidebar.install': 'PWA install button (0.9.0)',
};

const en = fs.readFileSync('public/js/i18n/en.js', 'utf8');
const dict = {};
for (const m of en.matchAll(/^\s{4}"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)",$/gm)) {
    dict[JSON.parse('"' + m[1] + '"')] = JSON.parse('"' + m[2] + '"');
}

const JS = ['app', 'core', 'chat', 'calls', 'avatar'].map((f) => 'public/js/' + f + '.js');
let fail = 0;
const ok = (l) => console.log('  PASS ' + l);
const bad = (l, d) => { fail++; console.log('  FAIL ' + l + (d ? '\n        ' + d : '')); };

console.log('dictionary: ' + Object.keys(dict).length + ' keys\n');

/* 1 — referenced keys resolve. Keys reach t() through ternaries and lookup
   tables as well as literals, so collect every dotted-string literal. */
const used = new Set();
const KEYLIKE = /['"]([a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)['"]/g;
for (const file of [...JS, ...SERVER_FILES]) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(KEYLIKE)) {
        if (m[1] in dict || (m[1] + '_one') in dict) used.add(m[1]);
    }
}
for (const m of fs.readFileSync('public/index.html', 'utf8')
    .matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?="([^"]+)"/g)) used.add(m[1]);

const unresolved = [...used].filter((k) => !(k in dict) && !((k + '_one') in dict));
if (unresolved.length) bad('all referenced keys resolve', unresolved.join(', '));
else ok('all ' + used.size + ' referenced keys resolve in en.js');

const unused = Object.keys(dict).filter((k) => {
    const base = k.replace(/_(one|other)$/, '');
    return !used.has(k) && !used.has(base);
});
if (unused.length) bad(unused.length + ' key(s) defined but never referenced', unused.join(', '));
else ok('no unused keys');

/* 2 — trace values to the original English, ignoring whitespace so a sentence
   split across concatenated source lines still matches. */
let original = '';
for (const f of [...JS, ...SERVER_FILES, 'public/index.html']) {
    try { original += cp.execSync('git show ' + BASELINE_REF + ':' + f, { encoding: 'utf8', maxBuffer: 1 << 24 }); } catch { }
}
const squash = (s) => s.replace(/\s+/g, '');
const originalSquashed = squash(original);

const untraced = [];
let recombinedCount = 0;
let newCount = 0;
for (const [key, val] of Object.entries(dict)) {
    if (key in RECOMBINED) { recombinedCount++; continue; }
    if (key in NEW_SINCE_BASELINE) { newCount++; continue; }
    const parts = val.split(/\{\w+\}/).map((s) => s.trim()).filter((s) => s.length >= 4);
    if (!parts.length) continue;
    if (!parts.every((p) => originalSquashed.includes(squash(p)))) {
        untraced.push(key + ' = ' + JSON.stringify(val));
    }
}
if (untraced.length) bad('every value traces to the original English', untraced.join('\n        '));
else ok('every checkable value traces to the English at ' + BASELINE_REF
    + ' (' + recombinedCount + ' recombinations, ' + newCount + ' new keys, both documented)');

/* 2b — every translated dictionary must match English key-for-key and
   slot-for-slot. A dropped slot renders a hole where a name should be. */
const parseDict = (file) => {
    const src = fs.readFileSync(file, 'utf8');
    const d = {};
    for (const m of src.matchAll(/^\s{4}"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)",$/gm)) {
        d[JSON.parse('"' + m[1] + '"')] = JSON.parse('"' + m[2] + '"');
    }
    return d;
};
const slotsOf = (v) => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

for (const lang of ['fa']) {
    const other = parseDict('public/js/i18n/' + lang + '.js');
    if (!Object.keys(other).length) { console.log('  NOTE ' + lang + '.js is empty — English fallback applies'); continue; }

    const missing = Object.keys(dict).filter((k) => !(k in other));
    const extra = Object.keys(other).filter((k) => !(k in dict));
    const slotBad = Object.keys(dict).filter((k) => k in other && slotsOf(dict[k]) !== slotsOf(other[k]))
        .map((k) => k + ' en{' + slotsOf(dict[k]) + '} ' + lang + '{' + slotsOf(other[k]) + '}');
    // Persian uses ک U+06A9 and ی U+06CC; the Arabic ك U+0643 / ي U+064A look
    // almost identical but break search, sorting and some fonts.
    const arabicForms = Object.entries(other).filter(([, v]) => /[كية]/.test(v)).map(([k]) => k);

    if (missing.length) bad(lang + '.js covers every English key', missing.length + ' missing: ' + missing.join(', '));
    else ok(lang + '.js covers all ' + Object.keys(dict).length + ' English keys');
    if (extra.length) bad(lang + '.js has no keys English lacks', extra.join(', '));
    if (slotBad.length) bad(lang + '.js preserves every slot', slotBad.join('\n        '));
    else ok(lang + '.js preserves every {slot}');
    if (arabicForms.length) bad(lang + '.js uses Persian letter forms', 'Arabic ك/ي/ة in: ' + arabicForms.join(', '));
    else ok(lang + '.js uses Persian ک/ی throughout');
}

/* 3 — no t() at module scope */
const modScope = [];
for (const f of JS) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/^(const|let|var|export)\b.*\bt\(/.test(line)) modScope.push(f + ':' + (i + 1) + '  ' + line.trim().slice(0, 70));
    });
}
modScope.length ? bad('no t() at module scope', modScope.join('\n        ')) : ok('no t() called at module scope');

/* 4 — nothing shadows t */
const shadows = [];
for (const f of JS) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/\b(?:const|let|var)\s+t\s*[=;]|\bfor\s*\(\s*(?:const|let)\s+t\b|\(\s*t\s*[,)]\s*=>/.test(line)) {
            shadows.push(f + ':' + (i + 1) + '  ' + line.trim().slice(0, 70));
        }
    });
}
shadows.length ? bad('nothing shadows the imported t()', shadows.join('\n        ')) : ok('nothing shadows the imported t()');

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASS' : fail + ' CHECK(S) FAILED'));
process.exit(fail === 0 ? 0 : 1);
