'use strict';
// ConnectWell — minimal private messenger. Author: Sepehr Mohammady.
// One Node process: static app + REST API + WebSocket hub, SQLite storage.

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const config = require('./lib/config');
const api = require('./lib/api');
const files = require('./lib/files');
const { initWs } = require('./lib/ws');

// Last-resort guards: this is a single always-on process serving every user, so
// a stray async error (bad stream, driver fault) should be logged, not fatal.
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

const B = config.BASE_PATH;
const wsOrigin = config.PUBLIC_ORIGIN.replace(/^http/, 'ws');

app.use(B, (req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' blob: data:",
        "media-src 'self' blob:",
        `connect-src 'self' ${wsOrigin} ws://localhost:${config.PORT} ws://127.0.0.1:${config.PORT}`,
        "object-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
    ].join('; '));
    next();
});

app.get(B, (req, res, next) => {
    // Express matches "/connectwell" AND "/connectwell/" here; only redirect
    // the slashless form, otherwise this would loop forever.
    const url = req.originalUrl;
    if (url === B || url.startsWith(B + '?')) return res.redirect(301, B + '/');
    next();
});
app.use(B + '/api', api);
app.use(B, express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
        // Filenames are not fingerprinted, so HTML, CSS and JS must revalidate on
        // every load. Caching them for a fixed window lets a fresh index.html pair
        // with a stale stylesheet, which renders a visibly broken UI. ETags keep
        // revalidation cheap (304, no body). Images change rarely, and when they
        // do they arrive under a new name, so they can sit in the cache.
        if (/\.(html|css|js|webmanifest)$/.test(filePath)) {
            res.set('Cache-Control', 'no-cache');
        } else {
            res.set('Cache-Control', 'public, max-age=86400');
        }
    },
}));
app.use(B, (req, res) => res.status(404).type('text').send('Not found'));

app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('server error:', err);
    res.status(status).json({ error: status < 500 && err.expose !== false ? err.message : 'Server error' });
});

const server = http.createServer(app);
initWs(server);
server.listen(config.PORT, config.HOST, () => {
    console.log(`ConnectWell v${require('./package.json').version} on http://${config.HOST}:${config.PORT}${B}/`);
});

// Shared-file retention. Runs on a timer, well after boot so a restart storm
// cannot stack sweeps. unref() so it never holds the process open, and every
// call is wrapped: housekeeping must not be able to take the server down.
if (config.STORAGE_SWEEP_MS > 0) {
    const storage = require('./lib/storage');
    const run = () => {
        Promise.resolve()
            .then(() => storage.sweep({ trigger: 'timer' }))
            .catch((err) => console.error('storage sweep failed:', err));
    };
    setTimeout(run, 30_000).unref();
    setInterval(run, config.STORAGE_SWEEP_MS).unref();
    console.log('storage: retention active — '
        + `${config.FILE_RETENTION_DAYS} day age limit, `
        + `backstop ${Math.round(config.STORAGE_HIGH_BYTES / 1024 ** 3)}→`
        + `${Math.round(config.STORAGE_LOW_BYTES / 1024 ** 3)} GB, `
        + (config.PURGE_ENABLED ? 'DELETION ENABLED' : 'dry run only'));
}
