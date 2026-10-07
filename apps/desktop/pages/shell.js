'use strict';
// Behaviour for the shell's own pages (setup.html, offline.html). The words come
// from the main process (strings.js) through the preload bridge.

const shell = window.cwShell || { info: {} };
const info = shell.info || {};
const strings = info.strings || {};

document.documentElement.lang = info.lang === 'fa' ? 'fa' : 'en';
document.documentElement.dir = info.lang === 'fa' ? 'rtl' : 'ltr';
for (const el of document.querySelectorAll('[data-s]')) {
    el.textContent = strings[el.dataset.s] || '';
}

if (document.body.dataset.page === 'setup') {
    const form = document.getElementById('setup');
    const input = document.getElementById('url');
    const message = document.getElementById('message');
    input.placeholder = strings.setupPlaceholder || '';
    if (info.url) input.value = info.url;
    input.focus();
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const button = form.querySelector('button');
        button.disabled = true;
        message.textContent = strings.setupChecking || '';
        const result = await shell.setServer(input.value);
        if (!result || !result.ok) {
            message.textContent = strings[result && result.error] || strings.setupUnreachable || '';
            button.disabled = false;
        }
    });
}

if (document.body.dataset.page === 'offline') {
    document.getElementById('retry').addEventListener('click', () => shell.retry());
    setInterval(() => shell.retry(), 15_000);
}
