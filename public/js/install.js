// The install button. It offers what suits the device it is on: on Windows and
// Android, this server's own app when its operator has published one (it rings
// for calls with no browser open); anywhere else, the web app, through the
// browser's install prompt where there is one, or as the steps to add it by
// hand where there is not (iPhone and iPad, Safari on a Mac).

import { $, h, fmtSize, svgIcon } from './core.js';
import { t } from './i18n.js';
import { registerWorker, isDesktopApp } from './notify.js';

// iOS's share mark (a box with an arrow out of it) and "add to home screen".
const SHARE_SVG = 'M16 5l-1.42 1.42-1.59-1.59V16h-1.98V4.83L9.42 6.42 8 5l4-4 4 4zm4 5v11c0 1.1-.9 2-2 2H6c-1.11 0-2-.9-2-2V10c0-1.11.89-2 2-2h3v2H6v11h12V10h-3V8h3c1.1 0 2 .89 2 2z';
const ADD_BOX_SVG = 'M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z';

let apps = {};              // what the server offers, from the bootstrap
let deferred = null;        // the browser's install prompt, while it offers one
let androidAppSeen = false; // the browser reports the Android app installed
let openModal = null;

// Chromium offers to install the web app with this event; it is kept to be
// used from the button, and stops coming once the web app is installed.
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    paint();
});
window.addEventListener('appinstalled', () => {
    deferred = null;
    paint();
});

// The device rather than the browser: what matters is which app runs on it.
function platform() {
    const ua = navigator.userAgent || '';
    const hint = navigator.userAgentData?.platform || '';
    if (/android/i.test(hint) || /Android/.test(ua)) return 'android';
    // iPadOS says it is a Mac; the touch screen gives it away.
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
    if (/windows/i.test(hint) || /Windows NT/.test(ua)) return 'windows';
    if (/mac/i.test(hint) || /Macintosh/.test(ua)) return 'mac';
    return 'other';
}

const standalone = () => window.matchMedia?.('(display-mode: standalone)')?.matches
    || navigator.standalone === true;

// Safari 17 and later can add a site to the Dock; no other Mac browser that
// lacks an install prompt can install it at all.
function safariWithDock() {
    const ua = navigator.userAgent || '';
    if (!/Safari\//.test(ua) || /Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\/|OPR\/|Firefox/.test(ua)) return false;
    const m = /Version\/(\d+)/.exec(ua);
    return !!m && Number(m[1]) >= 17;
}

// Running inside the Android app. Chrome gives the page an app opens with the
// app as its referrer, which a reload loses, so it is kept for the session.
function inAndroidApp() {
    const ids = apps.android?.ids || [];
    const fromApp = ids.some((id) => document.referrer.startsWith('android-app://' + id + '/'));
    try {
        if (fromApp) sessionStorage.setItem('cw_android_app', '1');
        return fromApp || sessionStorage.getItem('cw_android_app') === '1';
    } catch { return fromApp; }
}

// What the button does on this device right now, or null when it has nothing
// to offer. The device's own app comes first, even in an installed web app:
// only the app rings for a call with nothing open.
function offer() {
    if (isDesktopApp()) return null;
    const p = platform();
    if (p === 'windows' && apps.windows) return 'windows';
    if (p === 'android' && apps.android) return androidAppSeen || inAndroidApp() ? null : 'android';
    if (standalone()) return null;
    if (deferred) return 'prompt';
    if (p === 'ios') return 'ios';
    if (p === 'mac' && safariWithDock()) return 'mac';
    return null;
}

function paint() {
    const btn = $('btn-install');
    if (btn) btn.hidden = !offer();
}

// Whether the Android app is on this phone, as the browser knows it from the
// manifest's related_applications (server.js). Asked again on coming back to
// the page, which is where someone who just installed it lands.
async function checkAndroidApp() {
    if (!apps.android || platform() !== 'android' || !navigator.getInstalledRelatedApps) return;
    try {
        const found = await navigator.getInstalledRelatedApps();
        androidAppSeen = found.some((app) => app.platform === 'play');
    } catch { /* not answerable in this context */ }
    paint();
}

async function promptInstall() {
    const prompt = deferred;
    // Single use. The browser offers a fresh one on a later visit if the web
    // app is still not installed.
    deferred = null;
    paint();
    prompt.prompt();
    try { await prompt.userChoice; } catch { /* dismissed */ }
}

function appModal(modal, kind) {
    const app = apps[kind];
    const win = kind === 'windows';
    modal.append(h('h3', { text: t(win ? 'app.install.windowsTitle' : 'app.install.androidTitle') }));
    modal.append(h('p', { class: 'install-text', text: t(win ? 'app.install.windowsBody' : 'app.install.androidBody') }));
    modal.append(h('div', { class: 'install-row' }, [
        h('a', { class: 'btn', href: 'api/apps/' + kind, download: '', text: t('app.install.download') }),
        app.version
            ? h('span', { class: 'muted', text: t('app.install.meta', { version: app.version, size: fmtSize(app.size) }) })
            : null,
    ]));
    // What the system will say next, so a warning does not read as a fault.
    modal.append(h('p', { class: 'field-hint', text: t(win ? 'app.install.windowsNote' : 'app.install.androidNote') }));
}

function webModal(modal, p) {
    modal.append(h('h3', { text: t('app.install.title') }));
    if (p === 'ios') {
        modal.append(h('ol', { class: 'install-steps' }, [
            h('li', {}, [svgIcon(SHARE_SVG), h('span', { text: t('app.install.iosShare') })]),
            h('li', {}, [svgIcon(ADD_BOX_SVG), h('span', { text: t('app.install.iosAdd') })]),
        ]));
        modal.append(h('p', { class: 'field-hint', text: t('app.install.iosNote') }));
    } else {
        modal.append(h('p', { class: 'install-text', text: t('app.install.macSteps') }));
    }
}

// `open` is the app's modal opener.
export function initInstall(open) {
    openModal = open;
    // The service worker is what makes the web app installable at all.
    registerWorker();
    $('btn-install')?.addEventListener('click', () => {
        const what = offer();
        if (what === 'prompt') promptInstall();
        else if (what === 'windows' || what === 'android') openModal((modal) => appModal(modal, what));
        else if (what) openModal((modal) => webModal(modal, what));
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkAndroidApp(); });
    paint();
}

export function setApps(next) {
    apps = next || {};
    paint();
    checkAndroidApp();
}
