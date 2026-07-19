// Language resolution, loaded synchronously from <head> so `lang` and `dir` are
// on <html> before first paint. A separate file rather than an inline script
// because the CSP is script-src 'self' — the same reason js/theme.js exists.
//
// Mirrors theme.js deliberately, including its tri-state: an absent preference
// means "follow the device" and is never eagerly written, so a user who has
// never chosen still tracks their device if they change it later.

(function () {
    var KEY = 'cw_lang';

    // Languages with a real dictionary behind them. Farsi joins this list in the
    // release that ships public/js/i18n/fa.js — until then a fa device correctly
    // resolves to English rather than getting an RTL layout with English text.
    var SUPPORTED = { en: 'en' };

    var LOCALE = { en: 'en', fa: 'fa-IR' };

    function saved() {
        try { return localStorage.getItem(KEY); } catch (e) { return null; }   // private mode
    }

    function deviceLang() {
        var tags = (navigator.languages && navigator.languages.length)
            ? navigator.languages : [navigator.language];
        for (var i = 0; i < tags.length; i++) {
            var tag = String(tags[i] || '').toLowerCase();
            // fa-IR, fa-AF and Dari all mean Persian.
            if (tag === 'fa' || tag.indexOf('fa-') === 0 || tag === 'prs' || tag.indexOf('prs-') === 0) {
                if (SUPPORTED.fa) return 'fa';
            }
            if (tag === 'en' || tag.indexOf('en-') === 0) return 'en';
        }
        return 'en';
    }

    // 'device' | a supported code. An unrecognised stored value falls through to
    // the device default rather than being trusted.
    function preference() {
        var s = saved();
        return SUPPORTED[s] ? s : 'device';
    }

    function apply() {
        var pref = preference();
        var code = pref === 'device' ? deviceLang() : pref;
        var el = document.documentElement;
        // Real attributes, not dataset: :lang(), [dir=] and assistive technology
        // all key off these.
        el.setAttribute('lang', LOCALE[code] || 'en');
        el.setAttribute('dir', code === 'fa' ? 'rtl' : 'ltr');
        window.cwLang.code = code;
        window.cwLang.locale = LOCALE[code] || 'en';
        window.cwLang.pref = pref;
        return code;
    }

    // Reports whether the choice actually persisted. In private mode it does not,
    // and the caller must not then reload expecting it to have stuck.
    function set(pref) {
        try {
            if (pref === 'device') localStorage.removeItem(KEY);
            else localStorage.setItem(KEY, pref);
        } catch (e) { return false; }
        return true;
    }

    window.cwLang = {
        code: 'en', locale: 'en', pref: 'device',
        supported: SUPPORTED, preference: preference, apply: apply, set: set,
    };
    apply();
    // Deliberately no 'languagechange' listener: reacting to it would swap the
    // interface out from under someone mid-sentence.
})();
