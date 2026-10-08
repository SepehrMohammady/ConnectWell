#!/usr/bin/env node
// Builds the ConnectWell apps for ONE server. See docs/APPS.md.
//
//   node apps/build.mjs init <dir> --url https://chat.example.com/connectwell/ --id com.example.chat [--name ConnectWell]
//   node apps/build.mjs android <dir>      signed APK + App Bundle
//   node apps/build.mjs desktop <dir>      Windows installer (on Windows)
//   node apps/build.mjs all <dir>
//   node apps/build.mjs assetlinks <dir>   the file your domain must serve
//
// <dir> holds everything that belongs to that one deployment and must never be
// committed: instance.json (its address and the apps' identity), the Android
// signing key and its password, and the finished builds in <dir>/dist. It
// defaults to apps/instance, which is gitignored — but keep it somewhere
// private, and BACK UP THE SIGNING KEY: an installed Android app can only ever
// be updated by a build signed with the same key.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APPS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(APPS, '..');
const WIN = process.platform === 'win32';

function fail(msg) {
    console.error('\n✗ ' + msg + '\n');
    process.exit(1);
}

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const [k, v] = a.slice(2).split('=');
            out[k] = v !== undefined ? v : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
        } else out._.push(a);
    }
    return out;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value, mode) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', mode ? { mode } : {});

/* ---------------- the instance ---------------- */

const ANDROID_ID = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

function normalizeUrl(raw) {
    let u;
    try { u = new URL(String(raw || '')); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    u.hash = ''; u.search = '';
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    return u.toString();
}

function loadInstance(dir) {
    const file = path.join(dir, 'instance.json');
    if (!fs.existsSync(file)) fail(`No ${file}. Create one with:\n  node apps/build.mjs init ${dir} --url https://… --id com.example.chat`);
    const inst = readJson(file);
    inst.url = normalizeUrl(inst.url);
    if (!inst.url) fail('instance.json: "url" must be the https:// address the app is served at, e.g. https://chat.example.com/connectwell/');
    if (!ANDROID_ID.test(inst.id || '')) fail('instance.json: "id" must look like a reversed domain, e.g. com.example.chat');
    inst.name = String(inst.name || 'ConnectWell').slice(0, 30);
    inst.shortName = String(inst.shortName || inst.name).slice(0, 12);
    return inst;
}

// One version for every app, taken from the server it belongs to. Android also
// needs an always-increasing integer: 0.24.0 -> 2400, 1.2.3 -> 10203.
function versions() {
    const version = readJson(path.join(ROOT, 'package.json')).version;
    const [maj, min, pat] = version.split('.').map((n) => parseInt(n, 10) || 0);
    return { version, versionCode: maj * 10000 + min * 100 + pat };
}

/* ---------------- tools ---------------- */

function javaHome() {
    const candidates = [
        process.env.JAVA_HOME,
        WIN && 'C:\\Program Files\\Android\\Android Studio\\jbr',
        !WIN && '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
        !WIN && '/opt/android-studio/jbr',
    ].filter(Boolean);
    const exe = WIN ? 'java.exe' : 'java';
    for (const home of candidates) if (fs.existsSync(path.join(home, 'bin', exe))) return home;
    fail('A Java 17+ JDK is needed (set JAVA_HOME, or install Android Studio, which bundles one).');
}

const javaTool = (name) => path.join(javaHome(), 'bin', name + (WIN ? '.exe' : ''));

function androidSdk() {
    const candidates = [
        process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
        WIN && process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
        path.join(os.homedir(), 'Library', 'Android', 'sdk'),
        path.join(os.homedir(), 'Android', 'Sdk'),
    ].filter(Boolean);
    for (const dir of candidates) if (fs.existsSync(path.join(dir, 'platforms'))) return dir;
    fail('The Android SDK was not found (set ANDROID_HOME, or install Android Studio).');
}

function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
    if (r.error) fail(`${path.basename(cmd)} could not start: ${r.error.message}`);
    if (r.status !== 0) fail(`${path.basename(cmd)} ${args[0] || ''} failed (exit ${r.status}).`);
}

// npm and npx are scripts (npm.cmd on Windows), which only a shell can start.
// So the command line is a FIXED string; anything variable goes in `env`.
function runShell(command, opts = {}) {
    const r = spawnSync(command, { stdio: 'inherit', shell: true, ...opts });
    if (r.status !== 0) fail(`${command.split(' ')[0]} failed (exit ${r.status}).`);
}

// Passwords reach keytool through its environment (-storepass:env), never as
// arguments, which any process on the machine can read.
const keytool = (args, password, opts = {}) => spawnSync(javaTool('keytool'), args,
    { ...opts, env: { ...process.env, CW_STOREPASS: password } });

/* ---------------- signing ---------------- */

function signing(dir) {
    const file = path.join(dir, 'signing.json');
    if (!fs.existsSync(file)) fail(`No ${file}. "init" creates the signing key; to use your own, see docs/APPS.md.`);
    const s = readJson(file);
    s.keystore = path.resolve(dir, s.keystore || 'android-release.jks');
    s.alias = s.alias || 'connectwell';
    if (!fs.existsSync(s.keystore)) fail('Signing key not found: ' + s.keystore);
    if (!s.storePassword) fail('signing.json has no storePassword.');
    return s;
}

function fingerprint(s) {
    const r = keytool(['-list', '-v', '-keystore', s.keystore, '-alias', s.alias, '-storepass:env', 'CW_STOREPASS'],
        s.storePassword, { encoding: 'utf8' });
    const m = /SHA256:\s*([0-9A-F:]{95})/i.exec(r.stdout || '');
    if (!m) fail('Could not read the signing key\'s fingerprint:\n' + (r.stderr || r.stdout));
    return m[1].toUpperCase();
}

function assetLinks(inst, s) {
    return [{
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: inst.id, sha256_cert_fingerprints: [fingerprint(s)] },
    }];
}

/* ---------------- commands ---------------- */

function init(dir, opts) {
    fs.mkdirSync(dir, { recursive: true });
    const instFile = path.join(dir, 'instance.json');
    if (fs.existsSync(instFile) && !opts.force) {
        console.log(`• ${instFile} already exists — left as it is.`);
    } else {
        const url = normalizeUrl(opts.url);
        if (!url) fail('--url must be the https:// address the app is served at.');
        if (!ANDROID_ID.test(opts.id || '')) fail('--id must look like a reversed domain, e.g. com.example.chat');
        writeJson(instFile, { url, name: opts.name || 'ConnectWell', id: opts.id });
        console.log('• wrote ' + instFile);
    }

    const sigFile = path.join(dir, 'signing.json');
    if (fs.existsSync(sigFile)) {
        console.log(`• ${sigFile} already exists — the key is never replaced.`);
    } else {
        const inst = loadInstance(dir);
        const keystore = path.join(dir, 'android-release.jks');
        if (fs.existsSync(keystore)) fail(keystore + ' exists but signing.json does not; write signing.json by hand.');
        // A PKCS12 store has one password for the store and its key.
        const password = crypto.randomBytes(24).toString('base64url');
        const made = keytool([
            '-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12', '-alias', 'connectwell',
            '-keyalg', 'RSA', '-keysize', '4096', '-validity', '10000',
            '-storepass:env', 'CW_STOREPASS', '-keypass:env', 'CW_STOREPASS',
            '-dname', `CN=${inst.name.replace(/[,=+"\\<>;]/g, ' ')}`,
        ], password, { stdio: 'inherit' });
        if (made.status !== 0) fail('keytool could not create the signing key.');
        writeJson(sigFile, { keystore: 'android-release.jks', alias: 'connectwell', storePassword: password }, 0o600);
        console.log('• created the Android signing key: ' + keystore);
        console.log('  BACK UP this folder. Without this key the app can never be updated.');
    }
    assetlinks(dir);
}

function assetlinks(dir) {
    const inst = loadInstance(dir);
    const links = assetLinks(inst, signing(dir));
    const json = JSON.stringify(links, null, 2) + '\n';
    const out = path.join(dir, 'dist', 'assetlinks.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json);
    const u = new URL(inst.url);
    const fingerprint = links[0].target.sha256_cert_fingerprints[0];
    console.log(`
• Android only runs the app full screen — no browser bar, its own notifications —
  once ${u.origin}/.well-known/assetlinks.json vouches for it
  (status 200, application/json, no redirect). Either:

  a) let ConnectWell serve it: add to the server's .env and restart,
       ANDROID_APP_ID=${inst.id}
       ANDROID_CERT_SHA256=${fingerprint}
     then map the path in the reverse proxy (deploy/nginx-connectwell.conf):
       location = /.well-known/assetlinks.json {
           proxy_pass http://127.0.0.1:3010${u.pathname}.well-known/assetlinks.json;
       }
     (needed only when ConnectWell is not at the root of its domain)

  b) or publish this file there yourself:
       ${out}
`);
    console.log(json);
}

function android(dir) {
    const inst = loadInstance(dir);
    const s = signing(dir);
    const { version, versionCode } = versions();
    const project = path.join(APPS, 'android');
    console.log(`\n▶ Android ${version} (${versionCode}) for ${inst.url}`);
    // The wrapper's own entry point, run on the JDK directly: no shell between
    // these arguments and Gradle, so nothing in a name or address is parsed.
    run(javaTool('java'), [
        '-classpath', path.join(project, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
        'org.gradle.wrapper.GradleWrapperMain',
        '--no-daemon', '-p', project,
        'clean', 'assembleRelease', 'bundleRelease',
        `-Pcw.url=${inst.url}`, `-Pcw.id=${inst.id}`,
        `-Pcw.name=${inst.name}`, `-Pcw.shortName=${inst.shortName}`,
        `-Pcw.versionCode=${versionCode}`, `-Pcw.versionName=${version}`,
    ], {
        cwd: project,
        env: {
            ...process.env,
            JAVA_HOME: javaHome(),
            ANDROID_HOME: androidSdk(),
            CW_KEYSTORE: s.keystore,
            CW_KEYSTORE_PASSWORD: s.storePassword,
            CW_KEY_ALIAS: s.alias,
            CW_KEY_PASSWORD: s.keyPassword || s.storePassword,
        },
    });
    const dist = path.join(dir, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    const apk = path.join(dist, `ConnectWell-${version}.apk`);
    const aab = path.join(dist, `ConnectWell-${version}.aab`);
    fs.copyFileSync(path.join(project, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'), apk);
    fs.copyFileSync(path.join(project, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab'), aab);
    console.log(`\n✓ ${apk}\n✓ ${aab}`);
    assetlinks(dir);
}

function desktop(dir) {
    if (!WIN) fail('The Windows installer is built on Windows.');
    const inst = loadInstance(dir);
    const { version } = versions();
    const project = path.join(APPS, 'desktop');
    console.log(`\n▶ Windows ${version} for ${inst.url}`);
    // What makes this build belong to one server. Gitignored, rewritten on
    // every build so a previous instance can never leak into this one.
    writeJson(path.join(project, 'app-config.json'), { url: inst.url, name: inst.name, appId: inst.id });
    const out = path.join(path.resolve(dir), 'dist', 'windows-build');
    // Fixed words only on these command lines; everything about the instance
    // travels in the environment.
    const env = { ...process.env, CW_APP_ID: inst.id, CW_NAME: inst.name, CW_VERSION: version, CW_OUT_DIR: out };
    if (!fs.existsSync(path.join(project, 'node_modules', 'electron'))) {
        runShell('npm install --no-audit --no-fund', { cwd: project, env });
    }
    runShell('npx electron-builder --config electron-builder.config.cjs --win --publish never', { cwd: project, env });
    const setup = path.join(out, `ConnectWell-Setup-${version}.exe`);
    if (!fs.existsSync(setup)) fail('electron-builder finished but produced no installer at ' + setup);
    const target = path.join(dir, 'dist', `ConnectWell-Setup-${version}.exe`);
    fs.copyFileSync(setup, target);
    console.log(`\n✓ ${target}`);
}

/* ---------------- main ---------------- */

const args = parseArgs(process.argv.slice(2));
const [command, dirArg] = args._;
const dir = path.resolve(dirArg || path.join(APPS, 'instance'));

switch (command) {
    case 'init': init(dir, args); break;
    case 'android': android(dir); break;
    case 'desktop': desktop(dir); break;
    case 'all': android(dir); desktop(dir); break;
    case 'assetlinks': assetlinks(dir); break;
    default:
        console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).join('\n').replace(/^\/\/ ?/gm, ''));
        process.exit(command ? 1 : 0);
}
