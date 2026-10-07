'use strict';
// The few words the Windows shell says itself — tray menu, toasts, the setup and
// offline pages. Everything inside the window is the web app, in its own
// language setting; this follows the language of Windows.

const STRINGS = {
    en: {
        open: 'Open {name}',
        startup: 'Start with Windows',
        changeServer: 'Change server…',
        quit: 'Quit',
        trayHint: '{name} keeps running in the tray, so calls and messages still reach you. Quit it from the tray icon.',
        unread_one: '{n} unread message',
        unread_other: '{n} unread messages',
        cut: 'Cut',
        copy: 'Copy',
        paste: 'Paste',
        selectAll: 'Select all',
        copyLink: 'Copy link',
        offlineTitle: 'Can’t reach the server',
        offlineBody: 'Check your connection. Trying again automatically…',
        retry: 'Try again',
        setupTitle: 'Connect to your server',
        setupHint: 'Enter the address of your ConnectWell server, exactly as you would open it in a browser.',
        setupPlaceholder: 'https://chat.example.com/connectwell/',
        setupConnect: 'Connect',
        setupChecking: 'Checking…',
        setupBad: 'That is not a valid https:// address.',
        setupUnreachable: 'No ConnectWell server answered at that address.',
    },
    fa: {
        open: 'باز کردن {name}',
        startup: 'اجرا همراه با ویندوز',
        changeServer: 'تغییر سرور…',
        quit: 'خروج',
        trayHint: '{name} در ناحیهٔ اعلان ویندوز باز می‌ماند تا تماس‌ها و پیام‌ها به شما برسند. برای خروج از آیکون آن استفاده کنید.',
        unread_one: '{n} پیام خوانده‌نشده',
        unread_other: '{n} پیام خوانده‌نشده',
        cut: 'برش',
        copy: 'کپی',
        paste: 'چسباندن',
        selectAll: 'انتخاب همه',
        copyLink: 'کپی پیوند',
        offlineTitle: 'اتصال به سرور ممکن نیست',
        offlineBody: 'اتصال اینترنت را بررسی کنید. دوباره به‌طور خودکار تلاش می‌شود…',
        retry: 'تلاش دوباره',
        setupTitle: 'اتصال به سرور',
        setupHint: 'نشانی سرور ConnectWell خود را دقیقاً همان‌طور که در مرورگر باز می‌کنید وارد کنید.',
        setupPlaceholder: 'https://chat.example.com/connectwell/',
        setupConnect: 'اتصال',
        setupChecking: 'در حال بررسی…',
        setupBad: 'این یک نشانی معتبر https:// نیست.',
        setupUnreachable: 'هیچ سرور ConnectWell در این نشانی پاسخ نداد.',
    },
};

function pick(locale) {
    return /^(fa|prs)\b/i.test(String(locale || '')) ? 'fa' : 'en';
}

// tr(lang, key, vars), with the web app's conventions: {slots}, and a numeric
// `n` choosing between _one and _other.
function tr(lang, key, vars = {}) {
    const dict = STRINGS[lang] || STRINGS.en;
    let k = key;
    if (typeof vars.n === 'number') {
        const plural = k + (vars.n === 1 ? '_one' : '_other');
        if (dict[plural] || STRINGS.en[plural]) k = plural;
    }
    const raw = dict[k] || STRINGS.en[k] || key;
    return raw.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

module.exports = { STRINGS, pick, tr };
