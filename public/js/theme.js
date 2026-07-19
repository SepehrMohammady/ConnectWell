// Theme resolution, loaded synchronously from <head> so the right palette is on
// <html> before first paint (no flash). It is a separate file rather than an
// inline script because the CSP is script-src 'self'. Kept tiny and dependency
// free; the app module reuses it through window.cwTheme so the toggle and the
// first paint can never disagree.

(function () {
    var KEY = 'cw_theme';                                   // absent => follow the OS
    var BG = { dark: '#0e1013', light: '#eef1f5' };          // keep in sync with --bg in app.css

    function saved() {
        try { return localStorage.getItem(KEY); } catch (e) { return null; }  // private mode
    }

    function systemTheme() {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
            ? 'light' : 'dark';
    }

    // What the user chose: 'system' | 'light' | 'dark'.
    function preference() {
        var s = saved();
        return (s === 'light' || s === 'dark') ? s : 'system';
    }

    // Stamp the resolved palette onto <html> and match the browser chrome to it.
    function apply() {
        var pref = preference();
        var resolved = pref === 'system' ? systemTheme() : pref;
        document.documentElement.dataset.theme = resolved;
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', BG[resolved]);
        return { preference: pref, resolved: resolved };
    }

    function set(pref) {
        try {
            if (pref === 'system') localStorage.removeItem(KEY);
            else localStorage.setItem(KEY, pref);
        } catch (e) { /* private mode: the choice applies to this page only */ }
        return apply();
    }

    window.cwTheme = { apply: apply, set: set, preference: preference };
    apply();

    // Track the OS setting live, but only while the user is on 'system'.
    if (window.matchMedia) {
        var mq = window.matchMedia('(prefers-color-scheme: light)');
        var onChange = function () { if (preference() === 'system') apply(); };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);   // older Safari
    }
})();
