# Architecture

One Node process serves the API, the WebSocket and the static client. There is
no build step, no framework on the client, and two runtime dependencies.

## The pieces

- **Server** — Express 5 for HTTP, `ws` for the realtime socket, and Node's
  built-in `node:sqlite` for storage. No native modules, so `npm install` never
  compiles anything.
- **Client** — vanilla ES modules loaded directly by the browser. System fonts,
  no CDNs, and a strict Content-Security-Policy with no inline script or style.
- **Storage** — SQLite in WAL mode, plus uploaded files on disk under `data/`.
- **Sessions** — scrypt password hashes, random tokens stored hashed, in
  `HttpOnly` cookies.

```
server.js          entry point: static files, API and WebSocket wiring
lib/config.js      .env parsing and defaults
lib/db.js          schema, migrations, queries, JSON shapes
lib/api.js         REST API
lib/files.js       upload and download streaming (HTTP Range)
lib/storage.js     shared-file retention sweep
lib/deletions.js   delete-with-consent state machine
lib/ws.js          realtime hub and call signaling
lib/util.js        hashing, validation, small helpers
public/            the web app — index.html, app.css, js/*
public/js/i18n/    en.js and fa.js dictionaries
deploy/            run + watchdog scripts, nginx snippet, sudo setup
test/              i18n checks and module smoke tests
docs/              this documentation
```

## Client modules

| Module | Responsibility |
| --- | --- |
| `core.js` | Shared state, DOM helpers, formatting, event bus, sounds. Imports nothing from the app. |
| `api.js` | `fetch` wrapper and the XHR upload with progress. |
| `chat.js` | The conversation: rendering, composing, replies, reactions, files, filters. |
| `calls.js` | WebRTC mesh, perfect negotiation, bitrate caps, call overlay. |
| `app.js` | Boot, auth, WebSocket, sidebar, modals, admin, activity. |
| `eco.js` | Efficiency mode: the switch, and image downscaling. |
| `i18n.js` | `t()` lookup, plurals, slot interpolation. |
| `theme.js`, `lang.js` | Resolve theme and language *before first paint*; both are blocking scripts in `<head>` for that reason. |

## HTTP API

Everything lives under `api/`:

`register`, `login`, `logout`, `me`, `bootstrap`, `users`,
`conversations` (+ `/:id/messages`, `/read`, `/members`, `/upload`),
`files/:id`, `messages/:id` (DELETE, PATCH, `/react`, `/forward`,
`/delete-request`), `activity` (+ `/seen`), `ice`,
`admin/users` (+ approve/block/unblock/delete), `admin/storage`, `health`.

State-changing requests must carry `X-Requested-With: ConnectWell`, a header a
cross-origin form post cannot set — CSRF defence in depth on top of `SameSite`
cookies.

`bootstrap` is one round trip that returns everything a fresh page load needs:
the user, the roster, conversations, who is online, live calls, pending deletion
requests and the activity count.

## WebSocket

Connect at `ws`. The server pushes:

`hello`, `msg:new`, `msg:deleted`, `msg:edited`, `msg:reaction`, `msg:delreq`,
`read`, `conv:new`, `conv:updated`, `conv:removed`, `presence`, `typing`,
`user:pending`, `user:updated`, `activity:new`, `activity:sync`,
`call:state`, `call:ring`, `call:declined`, `call:ended`, `rtc`.

Clients send `typing`, `call:start`, `call:join`, `call:leave`, `call:decline`,
`call:eco`, `rtc`.

Calls are per-conversation rooms keyed by **connection** id rather than user id,
so one person joining from two devices works correctly. `call:state` carries the
call's shared efficiency verdict along with who asked for it.

## Design decisions worth knowing

**Read receipts use a sticky column on the message**, not the participant's read
watermark. Leaving and rejoining a group resets that watermark to zero, which
would otherwise hand a sender back the right to edit something the returning
member had already read.

**Editing and free deletion close the moment a message is read.** After that,
removing it needs the reader's consent, tracked in `del_requests` / `del_votes`
with the approver set frozen at request time — read positions keep moving, and a
set that grew as more people read could never be completed.

**Messages soft-delete.** The row stays so replies to it survive and so a
consented deletion can leave a visible marker. This means foreign-key cascades
never fire for them, and anything keyed to a message must be cleaned up
explicitly.

**Schema changes go through a guarded `addColumn()`** in `lib/db.js`, placed
after the `CREATE TABLE` block and before any `db.prepare()` — prepared
statements resolve column names eagerly. Assume every deployment has a live
database with real conversations in it.

**Calls cap their own bitrate.** Left alone, WebRTC negotiates whatever the link
will bear, which on mobile data is brutal. Capture constraints and
`RTCRtpSender` parameters both apply a ceiling, re-applied whenever the peer set
changes or a track is replaced.

## Tests

```bash
npm test
```

Checks that every referenced translation key resolves, that no key is unused,
that the Farsi dictionary matches English key-for-key and slot-for-slot, that no
`t()` is called at module scope, and that every frontend module executes under a
DOM shim in both languages.

## Versioning

Semantic versioning. `package.json` is the single source of truth: the server
reports it from `GET api/health` and the footer renders it, so the badge can
never drift from the build that is actually deployed.

| Bump | When |
| --- | --- |
| patch | Bug fix, security fix, docs, dependency upgrade, refactor with no behaviour change |
| minor | New feature, or a backward-compatible behaviour change |
| major | Breaking change to the HTTP/WS API, the storage schema, or the deploy contract |

While the app is `0.x` the API is not frozen: a breaking change may land as a
minor bump rather than forcing `1.0.0`.
