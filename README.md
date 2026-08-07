# ConnectWell

Minimal private messenger by [ConnectWell](https://example.com) — text, file sharing,
voice & video messages, and real-time audio/video calls, in any modern browser
(Android, iOS, Windows, Linux, macOS).

Live (unlisted): `https://example.com/connectwell/`

## How access works

- The app is **not linked from the website** — only people who receive the URL find it.
- Anyone with the link can **register**, but new accounts are **pending** until the
  admin approves them in the built-in admin panel.
- The **first account ever created becomes the admin** and is active immediately.
- Everything is person-to-person or group: chats, calls, and file sharing.

## Features

- **Chat** — 1:1 and group conversations, typing indicators, presence, unread
  counts, delete-own-message, day separators, link detection.
- **Files** — share images, video, audio, and documents up to 200 MB; images open
  in a lightbox, media streams with seeking (HTTP Range).
- **Voice & video messages** — recorded in the browser (MediaRecorder) and sent
  like any other message.
- **Calls** — 1:1 and group audio/video calls via WebRTC mesh with perfect
  negotiation. Media flows peer-to-peer; the server only relays signaling.
  STUN by default, optional TURN (coturn) via `.env`.
- **Efficiency mode** — a per-device switch that sends photos, voice messages
  and video messages at a much lower bitrate. In a call it is shared: if any one
  participant turns it on, everybody's send profile drops with them, and the call
  names who asked for it. Built for links where the connection, not the device,
  is the limit.
- **Admin panel** — approve / block / unblock / delete members.

## Stack

One Node.js process, no build step, no frameworks on the client:

- **Server**: Express 5 + `ws` + Node's built-in `node:sqlite` (zero native deps).
- **Client**: vanilla ES modules, self-contained (no CDNs, system fonts, strict CSP).
- **Storage**: SQLite (WAL) + uploads on disk under `data/` (gitignored).
- Sessions: scrypt password hashes, hashed 90-day tokens, HttpOnly cookies.

```
server.js          entry point (static + API + WS wiring)
lib/config.js      .env / defaults
lib/db.js          schema + queries
lib/api.js         REST API
lib/files.js       upload / download streaming
lib/ws.js          realtime hub + call signaling
public/            the web app (index.html, app.css, js/*)
deploy/            run/watchdog scripts + nginx snippet + sudo setup
```

## API / protocol overview

REST under `api/`: `register`, `login`, `logout`, `me`, `bootstrap`, `users`,
`conversations` (+ `/:id/messages`, `/read`, `/members`, `/upload`), `files/:id`,
`messages/:id` (DELETE), `ice`, `admin/users` (+ approve/block/unblock/delete),
`health`. State-changing requests require the `X-Requested-With: ConnectWell`
header (CSRF defence in depth).

WebSocket at `ws`: server pushes `hello`, `msg:new`, `msg:deleted`, `conv:new`,
`conv:updated`, `conv:removed`, `presence`, `typing`, `user:pending`,
`user:updated`, `call:state`, `call:ring`, `call:declined`, `call:ended`, `rtc`.
`call:state` carries the call's shared `eco` verdict plus the `ecoUsers` who asked
for it.
Clients send `typing`, `call:start`, `call:join`, `call:leave`, `call:decline`,
`rtc`, `call:eco`. Calls are per-conversation rooms keyed by connection id, so
multiple devices per user work.

## Development

```bash
npm install
npm start            # http://127.0.0.1:3010/connectwell/
```

Requires Node >= 22.5 (uses `node:sqlite`).

## Versioning

Semantic versioning, starting at `0.0.1`. `package.json` is the single source of
truth: the server reports it from `GET api/health` and the UI renders it in the
footer, so the badge can never drift from the build that is actually deployed.

Bump the version in `package.json` as part of the change itself:

| Bump | When | Example |
| --- | --- | --- |
| **patch** `0.0.X` | Bug fix, security fix, docs, dependency upgrade, refactor with no behaviour change | `0.0.1` → `0.0.2` |
| **minor** `0.X.0` | New feature, or a backward-compatible behaviour change | `0.0.9` → `0.1.0` |
| **major** `X.0.0` | Breaking change to the HTTP/WS API, the storage schema, or the deploy contract | `0.9.3` → `1.0.0` |

While the app is `0.x` it is pre-1.0, so the API is not frozen: a breaking change
may land as a minor bump rather than forcing `1.0.0`.

## Shared-file retention

Chat uploads in `data/uploads` are reclaimed by two independent rules. Profile and
group photos live in `data/avatars` and are never eligible — the sweep does not
know that path exists.

| Setting | Default | Meaning |
| --- | --- | --- |
| `FILE_RETENTION_DAYS` | `365` | Age rule: files older than this are removed. `0` disables it. |
| `STORAGE_HIGH_GB` / `STORAGE_HIGH_BYTES` | `60` GB | Backstop trigger: above this, start removing. |
| `STORAGE_LOW_GB` / `STORAGE_LOW_BYTES` | `50` GB | Backstop target: remove oldest-first until under this. |
| `STORAGE_MIN_AGE_MS` | `3600000` | A file is not eligible until this old, so a sweep cannot race an upload still being written. |
| `STORAGE_SWEEP_MS` | `900000` | How often the sweep runs. `0` disables it. |
| `PURGE_ENABLED` | *off* | **Deletion happens only when this is `1`.** Otherwise every sweep is a dry run. |

**Deletion is off by default.** With `PURGE_ENABLED` unset the sweep still measures,
selects and records what it *would* remove to `data/purge-log.jsonl`, changing
nothing. Inspect that log, and `GET api/admin/storage`, before switching it on.

Anything nonsensical — thresholds swapped, zero, or unparseable — disables purging
entirely rather than being clamped, because a misread threshold must never mean
"delete everything". Admins can inspect usage with `GET api/admin/storage` and run
one sweep on demand with `POST api/admin/storage/sweep`.

A purged message keeps its place in the conversation and shows "Removed to free
space" with the original name and size; the file itself 404s.

## Deployment (IONOS VPS, no sudo needed for the app)

The app lives at `~/apps/connectwell`, runs as the login user on
`127.0.0.1:3010`, and nginx proxies `/connectwell/` to it.

1. **User-space Node** (once): download the Node 24 linux-x64 tarball into
   `~/opt/node`.
2. **App**: `git clone` into `~/apps/connectwell`, `npm install --omit=dev`,
   create `.env`:

   ```ini
   PROD=1
   PORT=3010
   PUBLIC_ORIGIN=https://example.com
   # optional TURN (coturn):
   # TURN_HOST=example.com
   # TURN_SECRET=<same static-auth-secret as /etc/turnserver.conf>
   ```

3. **Keep it running** (crontab, no systemd needed):

   ```cron
   @reboot bash $HOME/apps/connectwell/deploy/watchdog.sh
   * * * * * bash $HOME/apps/connectwell/deploy/watchdog.sh
   ```

4. **nginx** (the only sudo step, once):

   ```bash
   sudo bash ~/apps/connectwell/deploy/setup-server.sudo.sh
   ```

5. **Updates**: push to GitHub, then on the server
   `cd ~/apps/connectwell && git pull && npm install --omit=dev` and
   `pkill -f "[a]pps/connectwell/server.js"` (the watchdog restarts it within a
   minute). The `[a]` is deliberate: run over SSH, a plain
   `pkill -f apps/connectwell/server.js` also matches the shell running the
   command and kills the session along with the app.

### TURN for reliable calls on strict networks

Ring and accept ride the app's own WebSocket, but the audio/video itself flows
directly device-to-device over ICE. On CGNAT / mobile-carrier / strict-NAT
networks there is no direct path, so STUN alone cannot connect and the call is
silent — accepted but with no media. A TURN relay fixes it.

The app is already wired for it: once `TURN_HOST`/`TURN_SECRET` are in `.env`,
`api/ice` hands out short-lived HMAC credentials and the client uses them
automatically — no code change.

To set it up:

```bash
# 1. put a shared secret in the app's .env (generated on the server):
#    printf 'TURN_HOST=example.com\nTURN_SECRET=%s\n' "$(openssl rand -hex 32)" >> ~/apps/connectwell/.env
# 2. install + configure coturn, open the firewall, start the service:
sudo bash ~/apps/connectwell/deploy/setup-turn.sudo.sh
# 3. restart the app so it reads the new .env:
pkill -f "[a]pps/connectwell/server.js"
```

`setup-turn.sudo.sh` reads `TURN_SECRET` from `.env` into
`/etc/turnserver.conf` (so the secret is never in git), opens 3478 udp+tcp and
the relay range 49160–49260/udp in ufw, and starts coturn. If the VPS also has
a provider/cloud firewall (e.g. the IONOS panel), open those same ports there
too, or external clients still cannot reach the relay.

## Author

Sepehr Mohammady — <https://sepehrmohammady.com>

MIT License.
