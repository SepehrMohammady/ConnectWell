// Minimal service worker. Its only job is to make the app installable as a PWA —
// Chromium will not fire `beforeinstallprompt` (and so will not offer install)
// without a registered service worker that has a fetch handler.
//
// It deliberately does NOT cache anything. The app serves html/css/js as
// no-cache on purpose (so a deploy is picked up immediately), and it streams
// media with HTTP Range requests — caching or proxying those here would
// reintroduce staleness and break seeking. So only top-level navigations are
// passed through to the network; every other request (assets, media, the API,
// the WebSocket) is left entirely to the browser.

// skipWaiting + clients.claim take over open tabs immediately. That is safe ONLY
// because nothing is cached, so there is no old/new asset skew. If a cache is
// ever added here, revisit this — a freshly-activated worker could then serve a
// mix of stale and fresh responses to already-open pages.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
    if (event.request.mode === 'navigate') {
        event.respondWith(fetch(event.request));
    }
    // Anything else: no respondWith → the browser handles it normally, including
    // Range requests for audio/video.
});
