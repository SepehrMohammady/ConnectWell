# Architecture

One Node process serves the API, the WebSocket and the static client. There is
no build step, no framework on the client, and two runtime dependencies.

## The pieces

- **Server:** Express 5 for HTTP, `ws` for the realtime socket, and Node's
  built-in `node:sqlite` for storage. No native modules, so `npm install` never
  compiles anything.
- **Client:** vanilla ES modules loaded directly by the browser. System fonts,
  no CDNs, and a strict Content-Security-Policy with no inline script or style.
- **Storage:** SQLite in WAL mode, plus uploaded files on disk under `data/`.
- **Sessions:** scrypt password hashes, random tokens stored hashed, in
  `HttpOnly` cookies.

```
server.js          entry point: static files, API and WebSocket wiring
lib/config.js      .env parsing and defaults
lib/db.js          schema, migrations, queries, JSON shapes
lib/api.js         REST API
lib/files.js       upload and download streaming (HTTP Range)
lib/storage.js     shared-file retention sweep
lib/stats.js       what the admin monitoring panel reports
lib/deletions.js   delete-with-consent state machine
lib/ws.js          realtime hub and call signaling
lib/push.js        background notifications: who is told what, in which language
lib/webpush.js     the Web Push protocol (VAPID, aes128gcm) on node:crypto
lib/apps.js        the app builds in APPS_DIR offered to members
lib/util.js        hashing, validation, small helpers
public/            the web app: index.html, app.css, js/*
public/sw.js       service worker: installability, and showing pushed notifications
public/js/i18n/    en.js and fa.js dictionaries
apps/              the Android (Trusted Web Activity) and Windows (Electron) apps
deploy/            run + watchdog scripts, nginx snippet, sudo setup
test/              i18n checks, push crypto against the RFC, module smoke tests
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
| `notify.js` | Notifications on this device: permission, push registration, who shows what, activity reporting, acting on a tapped notification, the Windows app's bridge. |
| `eco.js` | Efficiency mode: the switch, and image downscaling. |
| `install.js` | The install button: the Windows or Android app where the server offers one, the web app anywhere else. |
| `i18n.js` | `t()` lookup, plurals, slot interpolation. |
| `theme.js`, `lang.js` | Resolve theme and language *before first paint*; both are blocking scripts in `<head>` for that reason. |

## HTTP API

Everything lives under `api/`:

`register`, `login`, `logout`, `me`, `bootstrap`, `users`,
`conversations` (+ `/:id/messages`, `/read`, `/members`, `/upload`),
`files/:id`, `messages/:id` (DELETE, PATCH, `/react`, `/forward`,
`/delete-request`), `activity` (+ `/seen`), `ice`,
`push/key`, `push/subscribe`, `push/unsubscribe`, `push/test`,
`calls/:id/decline`, `apps/android`, `apps/windows`,
`users/search`, `admin/users` (+ approve/block/unblock/delete, `/password`, `/role`),
`admin/storage`, `admin/stats`, `health`.

Outside `api/`, `.well-known/assetlinks.json` is answered when the Android
app's identity is configured (`ANDROID_APP_ID`, `ANDROID_CERT_SHA256`), and
the manifest then names the app under `related_applications`.

State-changing requests must carry `X-Requested-With: ConnectWell`, a header a
cross-origin form post cannot set. That is CSRF defence in depth on top of
`SameSite` cookies.

`bootstrap` is one round trip that returns everything a fresh page load needs:
the user, the roster, conversations, who is online, live calls, pending deletion
requests, the activity count, the push key and which apps the server offers.

## WebSocket

Connect at `ws`. The server pushes:

`hello`, `msg:new`, `msg:deleted`, `msg:edited`, `msg:reaction`, `msg:delreq`,
`read`, `conv:new`, `conv:updated`, `conv:removed`, `presence`, `typing`,
`user:pending`, `user:updated`, `activity:new`, `activity:sync`,
`call:state`, `call:ring`, `call:declined`, `call:ended`, `rtc`.

Clients send `typing`, `call:start`, `call:join`, `call:leave`, `call:decline`,
`call:eco`, `call:media`, `rtc`, and `active`: whether a person is looking at
this window right now, with the device id that links the socket to that device's
push registration.

Calls are per-conversation rooms keyed by **connection** id rather than user id,
so one person joining from two devices works correctly. `call:state` carries the
call's shared efficiency verdict along with who asked for it, and whose camera
is on. A voice call becomes a video call when anyone turns their camera on
(`call:media`): the track is added to the existing connections and renegotiated,
so nobody has to hang up.

## Design decisions worth knowing

**An instance is not a directory.** A client is only ever handed the people it
already shares a conversation with, and presence and profile changes are sent to
that same audience rather than broadcast to everyone. Reaching a stranger means
searching `users/search` for at least three letters of their name: enough to
find somebody you know of, not enough to enumerate the membership. The search
escapes `%` and `_` before they reach LIKE, or the minimum length would buy
nothing. The admin panel keeps its own unscoped list, because approving and
blocking require it.

Because the roster follows from conversations, a client that meets somebody new
(found by search, or added to a group by another member) refetches
`api/users` when an unfamiliar member id appears, rather than being told about
people it has no business knowing.

**An admin can set a member's password but never another admin's.** There is no
email on the server and so no self-service reset, which makes an admin the only
way back in for somebody who has forgotten theirs. Rewriting a peer admin's
credential would be a silent account takeover, so that is refused. Demote them
first, which is deliberate and visible. A reset revokes every session the
account had, since the usual reason for one is that the old password is
compromised or unknown.

**The last active admin cannot be demoted, and nobody can change their own
role.** An instance with no admin cannot approve anyone or recover itself
without direct database access. Handing over means promoting someone and letting
them demote you.

**Read receipts use a sticky column on the message**, not the participant's read
watermark. Leaving and rejoining a group resets that watermark to zero, which
would otherwise hand a sender back the right to edit something the returning
member had already read.

**Editing and free deletion close the moment a message is read.** After that,
removing it needs the reader's consent, tracked in `del_requests` / `del_votes`
with the approver set frozen at request time: read positions keep moving, and a
set that grew as more people read could never be completed.

**Messages soft-delete.** The row stays so replies to it survive and so a
consented deletion can leave a visible marker. This means foreign-key cascades
never fire for them, and anything keyed to a message must be cleaned up
explicitly.

**Schema changes go through a guarded `addColumn()`** in `lib/db.js`, placed
after the `CREATE TABLE` block and before any `db.prepare()`, because prepared
statements resolve column names eagerly. Assume every deployment has a live
database with real conversations in it.

**Calls cap their own bitrate.** Left alone, WebRTC negotiates whatever the link
will bear, which on mobile data is brutal. Capture constraints and
`RTCRtpSender` parameters both apply a ceiling, re-applied whenever the peer set
changes or a track is replaced.

**Background notifications are Web Push, with no third-party account.** The
server signs with its own VAPID key and encrypts each payload to the device
(`lib/webpush.js`, pinned to RFC 8291's worked example by `test/push-crypto.js`),
and the browser's push service delivers it. The Android app is a Trusted Web
Activity precisely so that Chrome's push can do this there too: a WebView-based
app would need Firebase, and every self-hoster a Firebase project of their own.

**Whoever is active is not pushed to.** A window reports itself active while it
is visible, focused and recently touched; the claim expires on the server unless
renewed, because a phone that drops off the network cannot say it left. A call
that started while its callee was active, and is still ringing when they stop
being active, rings their devices then, for the time left.

**Every push leaves something on screen.** Browsers allow only a few pushes a
day that show nothing before replacing them with a generic notice of their own.
So the end of a ring is not a silent dismissal: each device that rang is told
how it ended (missed, answered elsewhere, declined), which both stops the ringing
and stays as a truthful note. The device that answered or declined is the one
device not told. The service worker shows nothing only when a window of the
app is in front on that same device.

**Notification tags are a contract.** `cw-conv-<id>` (messages, merged),
`cw-ring-<id>` (a ringing call) and `cw-call-<id>` (how it ended) are read by
`public/sw.js`, by the page, and by the Android app's `DelegationService`, which
gives `cw-ring-` its own ringtone channel and loops it until the notification is
withdrawn. Change them in all three places together.

**A push registration lives and dies with its session.** `push_subs` cascades
from `sessions`, so signing out, a password change that revokes other sessions,
an admin block or reset, and plain expiry all take the device's notifications
with them: a notification carries message text, and must not outlive the access
it came from. The endpoint a browser hands over is checked against `PUSH_HOSTS`
before the server will ever request it.

## Tests

```bash
npm test
```

Checks that every referenced translation key resolves, that no key is unused,
that the Persian dictionary matches English key-for-key and slot-for-slot, that no
`t()` is called at module scope, that Web Push encryption reproduces RFC 8291's
worked example byte for byte and its VAPID tokens verify, and that every
frontend module executes under a DOM shim in both languages.

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
