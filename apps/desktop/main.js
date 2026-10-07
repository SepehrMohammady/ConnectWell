'use strict';
// ConnectWell for Windows.
//
// The interface is the web app itself, loaded from the server, so the app is
// always exactly the version that server runs and never needs reinstalling for
// a new feature. What this shell adds is what a browser tab cannot do:
//   - it keeps running in the tray when its window is closed, and starts with
//     Windows, so calls and messages still reach the computer;
//   - it turns the app's notifications into native Windows ones, including a
//     persistent, ringing toast with Accept and Decline for calls;
//   - the taskbar button and the tray icon show unread messages.
//
// Security: the page runs sandboxed, with context isolation and no Node access.
// The window only ever shows the configured server — any other address opens in
// the default browser — and camera, microphone and notifications are granted to
// that one origin alone. The bridge the page talks to (preload.js) checks the
// sender of every message again here.

const {
    app, BrowserWindow, Menu, Notification, Tray, clipboard, ipcMain, nativeImage, nativeTheme,
    net, powerMonitor, session, shell,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pick, tr } = require('./strings');

/* ---------------- configuration ----------------
   app-config.json is written by apps/build.mjs into a build made for one server
   and is never committed. Without it the app asks for an address on first start
   and remembers it. */

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const BAKED = readJson(path.join(__dirname, 'app-config.json')) || {};
const APP_NAME = BAKED.name || 'ConnectWell';
// Must equal the installer's appId: Windows files toasts under the shortcut's
// AppUserModelID, and a mismatch makes notifications silently disappear.
const APP_ID = BAKED.appId || 'app.connectwell.desktop';

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);

let lang = 'en';
const S = (key, vars) => tr(lang, key, { name: APP_NAME, ...vars });

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {};
function saveSettings() {
    try {
        fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
        fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
    } catch { /* not fatal: defaults apply next time */ }
}

// https only — except a server on this very machine, for development.
function normalizeUrl(raw) {
    let u;
    try { u = new URL(String(raw || '').trim()); } catch { return null; }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
    if (u.username || u.password) return null;
    u.hash = '';
    u.search = '';
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    return u.toString();
}

const serverUrl = () => normalizeUrl(BAKED.url) || normalizeUrl(settings.serverUrl);

// Inside the app: same origin and under its path. Everything else is "the web".
function inScope(target) {
    const base = serverUrl();
    if (!base) return false;
    try {
        const t = new URL(target);
        const b = new URL(base);
        return t.origin === b.origin && (t.pathname + '/').startsWith(b.pathname);
    } catch { return false; }
}

const sameOrigin = (target) => {
    try { return new URL(target).origin === new URL(serverUrl()).origin; } catch { return false; }
};

/* ---------------- single instance ---------------- */

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => showWindow());
    app.whenReady().then(start);
}

let win = null;
let tray = null;
let quitting = false;
let unread = 0;

const asset = (name) => path.join(__dirname, 'assets', name);
// Windows reads toast images from disk, which cannot see inside app.asar; the
// assets folder is unpacked beside it (see electron-builder.config.cjs).
const diskAsset = (name) => asset(name).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const appIcon = () => nativeImage.createFromPath(asset('app.png'));

function start() {
    settings = readJson(settingsFile()) || {};
    lang = pick(app.getPreferredSystemLanguages?.()[0] || app.getLocale());
    Menu.setApplicationMenu(null);
    guardPermissions();
    createTray();
    createWindow();
    Notification.handleActivation?.((details) => onActivation(details && details.arguments));

    // Starting with Windows is what makes "calls still reach you" true after a
    // restart, so a packaged install opts in once; the tray menu turns it off.
    if (app.isPackaged && settings.autostartSet !== true) {
        setOpenAtLogin(true);
        settings.autostartSet = true;
        saveSettings();
    }

    // After sleep the socket can look open while it is long dead; a fresh load
    // of a window nobody is looking at is the quickest honest reconnect.
    powerMonitor.on('resume', () => {
        if (win && !win.isVisible() && serverUrl()) win.webContents.reload();
    });
    nativeTheme.on('updated', refreshTray);
}

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* the tray keeps the app alive */ });
// Nothing in this app embeds other pages.
app.on('web-contents-created', (e, contents) => {
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
});

/* ---------------- the window ---------------- */

function createWindow() {
    const b = settings.bounds || {};
    win = new BrowserWindow({
        width: b.width || 1100, height: b.height || 760, x: b.x, y: b.y,
        minWidth: 360, minHeight: 480,
        show: false,
        title: APP_NAME,
        icon: appIcon(),
        backgroundColor: '#0e1013',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            spellcheck: true,
            // Left ON on purpose: switching throttling off also makes a hidden
            // window report itself as visible, and the app marks messages read
            // while it believes it is being looked at.
            backgroundThrottling: true,
        },
    });
    if (b.maximized) win.maximize();

    const hidden = process.argv.includes('--hidden');
    win.once('ready-to-show', () => { if (!hidden) win.show(); });

    win.on('close', (e) => {
        rememberBounds();
        if (quitting) return;
        // Closing the window is not quitting: calls must still be able to ring.
        e.preventDefault();
        win.hide();
        if (!settings.trayHintShown) {
            settings.trayHintShown = true;
            saveSettings();
            toast({ title: APP_NAME, body: S('trayHint') });
        }
    });
    win.on('focus', () => win.flashFrame(false));

    const wc = win.webContents;
    wc.on('will-navigate', (e, target) => {
        if (inScope(target)) return;
        e.preventDefault();
        openOutside(target);
    });
    wc.setWindowOpenHandler(({ url }) => {
        openOutside(url);
        return { action: 'deny' };
    });
    wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
        // -3 is an aborted load (a navigation replaced it), not a failure.
        if (isMainFrame && code !== -3 && inScope(url)) showLocalPage('offline.html');
    });
    wc.on('before-input-event', (e, input) => {
        if (input.type !== 'keyDown') return;
        const reload = input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r');
        if (reload) { e.preventDefault(); loadApp(); }
    });
    wc.on('context-menu', (e, params) => contextMenu(params));

    loadApp();
}

function loadApp() {
    const url = serverUrl();
    if (url) win.loadURL(url);
    else showLocalPage('setup.html');
}

function showLocalPage(file) {
    win.loadFile(path.join(__dirname, 'pages', file));
}

function showWindow() {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
}

function rememberBounds() {
    if (!win || win.isMinimized()) return;
    settings.bounds = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    saveSettings();
}

function openOutside(target) {
    if (/^https?:\/\//i.test(target) || /^mailto:/i.test(target)) shell.openExternal(target);
}

function contextMenu(params) {
    const items = [];
    for (const word of (params.dictionarySuggestions || []).slice(0, 4)) {
        items.push({ label: word, click: () => win.webContents.replaceMisspelling(word) });
    }
    if (items.length) items.push({ type: 'separator' });
    if (params.isEditable) {
        items.push(
            { label: S('cut'), role: 'cut', enabled: params.editFlags.canCut },
            { label: S('copy'), role: 'copy', enabled: params.editFlags.canCopy },
            { label: S('paste'), role: 'paste', enabled: params.editFlags.canPaste },
            { type: 'separator' },
            { label: S('selectAll'), role: 'selectAll' },
        );
    } else if (params.selectionText) {
        items.push({ label: S('copy'), role: 'copy' });
    }
    if (params.linkURL && /^https?:/i.test(params.linkURL)) {
        items.push({ label: S('copyLink'), click: () => clipboard.writeText(params.linkURL) });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
}

/* ---------------- permissions ----------------
   The server's own origin may use the camera and microphone (calls, voice and
   video messages), show notifications and go full screen. Nothing else, and no
   other origin, is ever granted anything. */

const ALLOWED = new Set(['media', 'notifications', 'fullscreen', 'clipboard-sanitized-write']);

function guardPermissions() {
    const s = session.defaultSession;
    s.setPermissionRequestHandler((wc, permission, callback, details) => {
        callback(ALLOWED.has(permission) && sameOrigin(details.requestingUrl || wc.getURL()));
    });
    s.setPermissionCheckHandler((wc, permission, origin) => ALLOWED.has(permission) && sameOrigin(origin));
}

/* ---------------- tray and unread ---------------- */

function trayImage() {
    // Windows paints the taskbar dark or light independently of apps.
    const darkBar = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ?? nativeTheme.shouldUseDarkColors;
    return nativeImage.createFromPath(asset(`tray-${darkBar ? 'light' : 'dark'}${unread > 0 ? '-unread' : ''}.png`));
}

function createTray() {
    tray = new Tray(trayImage());
    tray.on('click', showWindow);
    refreshTray();
}

function refreshTray() {
    if (!tray) return;
    tray.setImage(trayImage());
    tray.setToolTip(unread > 0 ? `${APP_NAME} — ${S('unread', { n: unread })}` : APP_NAME);
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: S('open'), click: showWindow },
        { type: 'separator' },
        {
            label: S('startup'), type: 'checkbox', checked: openAtLogin(), enabled: app.isPackaged,
            click: (item) => setOpenAtLogin(item.checked),
        },
        // Only a build that was not made for one particular server can move.
        ...(BAKED.url ? [] : [{ label: S('changeServer'), click: () => showLocalPage('setup.html') }]),
        { type: 'separator' },
        { label: S('quit'), click: () => { quitting = true; app.quit(); } },
    ]));
}

function openAtLogin() {
    return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
}

function setOpenAtLogin(on) {
    // Started by Windows it opens straight to the tray rather than in your face.
    app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
    refreshTray();
}

function setUnread(count, badgeDataUrl) {
    unread = Math.max(0, Math.min(Number(count) || 0, 99999));
    if (win) {
        let overlay = null;
        if (unread > 0 && typeof badgeDataUrl === 'string' && badgeDataUrl.startsWith('data:image/png;base64,')) {
            // Drawn at 32 px by the page side, shown as the 16 px overlay.
            overlay = nativeImage.createEmpty();
            overlay.addRepresentation({ scaleFactor: 2, dataURL: badgeDataUrl });
        }
        win.setOverlayIcon(overlay, unread > 0 ? S('unread', { n: unread }) : '');
    }
    refreshTray();
}

/* ---------------- notifications ----------------
   The page decides WHAT to say and in which language (it only asks while the
   person is not actively looking at it); this decides how Windows shows it.
   One live notification per tag, so a conversation's burst replaces itself and
   a call's toast can be withdrawn when the ringing stops. */

const live = new Map();    // tag -> Notification

function toast({ title, body }) {
    if (!Notification.isSupported()) return null;
    const n = new Notification({ title, body, icon: appIcon() });
    n.on('click', showWindow);
    n.show();
    return n;
}

function closeTag(tag) {
    const n = live.get(tag);
    if (!n) return;
    live.delete(tag);
    try { n.close(); } catch { /* already gone */ }
}

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// An incoming call: the toast stays up and loops the Windows call sound until
// it is answered, declined, or withdrawn when the call ends. The buttons carry
// their meaning in the activation arguments, handled in onActivation().
function ringToastXml(n) {
    const args = (verb) => esc(`cw:${verb}:${n.conv}:${n.call}`);
    // A URL, so a space in the install path (a user name, say) must be encoded.
    const logo = esc('file:///' + encodeURI(diskAsset('app.png').replace(/\\/g, '/')));
    return `<toast scenario="incomingCall" launch="${args('open')}" activationType="foreground">
  <visual>
    <binding template="ToastGeneric">
      <text>${esc(n.title)}</text>
      <text>${esc(n.body)}</text>
      <image placement="appLogoOverride" hint-crop="circle" src="${logo}"/>
    </binding>
  </visual>
  <audio src="ms-winsoundevent:Notification.Looping.Call" loop="true"/>
  <actions>
    <action content="${esc(n.answer)}" arguments="${args('answer')}" activationType="foreground"/>
    <action content="${esc(n.decline)}" arguments="${args('decline')}" activationType="foreground"/>
  </actions>
</toast>`;
}

function notify(n) {
    if (!Notification.isSupported()) return;
    closeTag(n.tag);
    const ring = n.kind === 'ring' && n.call && n.conv;
    const note = ring
        ? new Notification({ toastXml: ringToastXml(n) })
        : new Notification({
            title: n.title, body: n.body, icon: appIcon(),
            timeoutType: n.sticky ? 'never' : 'default',
        });
    // A ring's clicks arrive through onActivation, with their arguments.
    if (!ring) note.on('click', () => openIntent(n));
    note.on('close', () => { if (live.get(n.tag) === note) live.delete(n.tag); });
    live.set(n.tag, note);
    note.show();
    if (ring && win && !win.isFocused()) win.flashFrame(true);
}

function openIntent(n, extra = {}) {
    showWindow();
    if (!win) return;
    const intent = { conv: n.conv, msg: n.msg, call: n.call, admin: n.admin, ...extra };
    win.webContents.send('cw:open', intent);
}

function onActivation(args) {
    const m = /^cw:(open|answer|decline):(\d+):([0-9a-f-]{8,64})$/i.exec(String(args || ''));
    if (!m) { showWindow(); return; }
    const [, verb, conv, call] = m;
    closeTag('cw-ring-' + conv);
    if (verb === 'decline') {
        // Declining needs no window: the page, alive in the background, says no.
        if (win) win.webContents.send('cw:open', { conv: Number(conv), call, decline: true });
        return;
    }
    openIntent({ conv: Number(conv), call }, verb === 'answer' ? { answer: true } : {});
}

/* ---------------- the bridge ----------------
   Every message is checked to come from the app's own page in our own window,
   so nothing the window might ever show could drive these. */

const fromApp = (e) => !!win && e.sender === win.webContents && inScope(e.senderFrame?.url || '');
const fromLocalPage = (e) => !!win && e.sender === win.webContents && (e.senderFrame?.url || '').startsWith('file:');

const clipText = (v, max) => String(v ?? '').slice(0, max);
const posInt = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : undefined);

ipcMain.on('cw:notify', (e, raw) => {
    if (!fromApp(e) || !raw || typeof raw !== 'object') return;
    const tag = clipText(raw.tag, 64);
    if (!/^[\w-]+$/.test(tag)) return;
    notify({
        kind: clipText(raw.kind, 16), tag,
        title: clipText(raw.title, 200) || APP_NAME,
        body: clipText(raw.body, 1000),
        sticky: raw.sticky === true,
        conv: posInt(raw.conv), msg: posInt(raw.msg),
        call: /^[0-9a-f-]{8,64}$/i.test(String(raw.call || '')) ? String(raw.call) : undefined,
        admin: raw.admin === true,
        answer: clipText(raw.labels?.answer || 'Accept', 40),
        decline: clipText(raw.labels?.decline || 'Decline', 40),
    });
});

ipcMain.on('cw:close', (e, tag) => {
    if (fromApp(e)) closeTag(String(tag));
});

ipcMain.on('cw:unread', (e, count, badge) => {
    if (fromApp(e)) setUnread(count, badge);
});

// The setup and offline pages ship inside the app.
ipcMain.on('cw:shell-info', (e) => {
    e.returnValue = fromLocalPage(e)
        ? { lang, name: APP_NAME, url: serverUrl(), strings: Object.fromEntries(
            ['offlineTitle', 'offlineBody', 'retry', 'setupTitle', 'setupHint', 'setupPlaceholder',
                'setupConnect', 'setupChecking', 'setupBad', 'setupUnreachable'].map((k) => [k, S(k)])) }
        : null;
});

ipcMain.handle('cw:retry', (e) => {
    if (fromLocalPage(e)) loadApp();
});

// Saving an address checks first that a ConnectWell server answers there.
ipcMain.handle('cw:set-server', async (e, raw) => {
    if (!fromLocalPage(e) || BAKED.url) return { ok: false };
    const url = normalizeUrl(raw);
    if (!url) return { ok: false, error: 'setupBad' };
    try {
        const res = await net.fetch(url + 'api/health', { signal: AbortSignal.timeout(10_000) });
        const body = res.ok ? await res.json() : null;
        if (!body || body.ok !== true) return { ok: false, error: 'setupUnreachable' };
    } catch {
        return { ok: false, error: 'setupUnreachable' };
    }
    settings.serverUrl = url;
    saveSettings();
    loadApp();
    return { ok: true };
});
