// The conversation backdrop — a per-device choice, like the theme.
//
// Every option is drawn by CSS rather than shipped as an image: a repeating
// gradient costs nothing to download, stays sharp at any zoom, and tiles
// seamlessly by construction. It also keeps the promise the app makes elsewhere
// that nothing is fetched from anywhere.
//
// Each one is defined as a translucent layer over var(--bg), so a single
// definition works in both the light and the dark palette instead of needing a
// pair that can drift apart.

const KEY = 'cw_chat_bg';

// The order here is the order of the swatches. `plain` first, because it is the
// default and the way back.
export const BACKGROUNDS = [
    'plain',
    'slate', 'ocean', 'forest', 'sand',
    'dots', 'grid', 'weave', 'stripe',
];

let current = 'plain';
try {
    const saved = localStorage.getItem(KEY);
    if (saved && BACKGROUNDS.includes(saved)) current = saved;
} catch { /* private mode */ }

export function chatBg() { return current; }

export function setChatBg(name) {
    current = BACKGROUNDS.includes(name) ? name : 'plain';
    try {
        if (current === 'plain') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, current);
    } catch { /* private mode: applies to this page only */ }
    applyChatBg();
}

// Stamped on <html> so one attribute drives both the conversation area and the
// swatches in the picker, and nothing has to be re-rendered to change it.
export function applyChatBg() {
    document.documentElement.dataset.chatBg = current;
}

applyChatBg();
