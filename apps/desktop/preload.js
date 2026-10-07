'use strict';
// The bridge between the page and the Windows shell. Runs sandboxed, before the
// page's own scripts, and hands the page a deliberately small surface:
//
//   window.cwDesktop  (on the ConnectWell server's pages)
//     notify({ kind, tag, title, body, sticky, conv, msg, call, admin, labels })
//     close(tag)           withdraw a notification, e.g. a call that stopped ringing
//     setUnread(n)         taskbar badge and tray icon
//     onOpen(fn)           a notification was clicked: where to go
//
//   window.cwShell    (on the setup and offline pages that ship with the app)
//
// public/js/notify.js is the only user of cwDesktop. The main process re-checks
// the sender of everything sent here, so this file is a convenience, not the
// security boundary.

const { contextBridge, ipcRenderer } = require('electron');

// The red count on the taskbar button. Drawn here because the main process has
// no canvas; 32 px so it stays sharp on high-density screens.
function badge(n) {
    if (!(n > 0)) return null;
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    g.fillStyle = '#e5484d';
    g.beginPath();
    g.arc(16, 16, 16, 0, Math.PI * 2);
    g.fill();
    const text = n > 9 ? '9+' : String(n);
    g.fillStyle = '#ffffff';
    g.font = `bold ${text.length > 1 ? 17 : 21}px "Segoe UI", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 16, 17);
    return c.toDataURL('image/png');
}

if (location.protocol === 'file:') {
    const info = ipcRenderer.sendSync('cw:shell-info') || {};
    contextBridge.exposeInMainWorld('cwShell', {
        info,
        retry: () => ipcRenderer.invoke('cw:retry'),
        setServer: (url) => ipcRenderer.invoke('cw:set-server', String(url || '')),
    });
} else {
    let lastBadge = -1;
    contextBridge.exposeInMainWorld('cwDesktop', {
        notify: (n) => ipcRenderer.send('cw:notify', n && typeof n === 'object' ? { ...n } : null),
        close: (tag) => ipcRenderer.send('cw:close', String(tag || '')),
        setUnread: (n) => {
            const count = Math.max(0, Number(n) || 0);
            // Called on every render of the conversation list; only a change is news.
            if (count === lastBadge) return;
            lastBadge = count;
            ipcRenderer.send('cw:unread', count, badge(count));
        },
        onOpen: (fn) => {
            if (typeof fn !== 'function') return;
            ipcRenderer.on('cw:open', (_e, intent) => fn(intent));
        },
    });
}
