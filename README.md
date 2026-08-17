# ConnectWell

A small, self-hosted private messenger — text, file sharing, voice & video
messages, and real-time audio/video calls, in any modern browser (Android, iOS,
Windows, Linux, macOS).

One Node.js process, one SQLite file, no build step, no frameworks, no CDNs, no
third-party services. It is meant to be readable end to end and to run on a
cheap VPS or a machine in your own home.

> **Not end-to-end encrypted.** Messages and files are stored on your server so
> that history, search and multi-device access work. Anyone with access to the
> server can read them. See [SECURITY.md](SECURITY.md) before deciding whether
> this suits your threat model.

## How access works

- Anyone who can reach the URL can **register**, but new accounts are **pending**
  until an admin approves them in the built-in admin panel.
- The **first account ever created becomes the admin** and is active immediately,
  so create yours before sharing the address.
- There is no public directory and no discovery: everything is person-to-person
  or in groups you are added to.

## Features

- **Chat** — 1:1 and group conversations, typing indicators, presence, unread
  counts, read receipts, day separators, link detection.
- **Files** — share images, video, audio and documents up to 200 MB; images open
  in a lightbox, media streams with seeking (HTTP Range), captions, drag-and-drop,
  and filtering by attachment type or date.
- **Voice & video messages** — recorded in the browser (MediaRecorder) and sent
  like any other message; video messages can use the front or rear camera.
- **Calls** — 1:1 and group audio/video calls over a WebRTC mesh with perfect
  negotiation. Media flows peer-to-peer; the server only relays signaling.
  STUN by default, optional TURN (coturn) for strict networks.
- **Reactions & forwarding** — ten emoji, and forwarding that keeps a tag naming
  the original author.
- **Activity center** — a bell collecting missed calls and reactions to your
  messages, with a live badge; each item jumps straight to the message it is
  about.
- **Efficiency mode** — a per-device switch that sends photos, voice messages and
  video messages at a much lower bitrate. In a call it is shared: if any one
  participant turns it on, everybody's send profile drops with them, and the call
  names who asked for it. Built for links where the connection, not the device,
  is the limit.
- **Careful deletion & editing** — a message can be edited or deleted freely
  until the other side has read it; after that, deleting needs their consent.
- **Two languages** — English and Farsi, with full right-to-left layout, the
  Jalali calendar and Persian digits.
- **Themes** — light, dark, or follow the system.
- **Installable** — a PWA install button where the browser supports it.
- **Admin panel** — approve / block / unblock / delete members.

## Stack

- **Server**: Express 5 + `ws` + Node's built-in `node:sqlite` (zero native deps).
- **Client**: vanilla ES modules, self-contained — system fonts, no CDNs, strict
  CSP with no inline script or style.
- **Storage**: SQLite (WAL) + uploads on disk under `data/` (gitignored).
- **Sessions**: scrypt password hashes, hashed 90-day tokens, HttpOnly cookies.

```
server.js          entry point (static + API + WS wiring)
lib/config.js      .env / defaults
lib/db.js          schema + queries
lib/api.js         REST API
lib/files.js       upload / download streaming
lib/storage.js     shared-file retention
lib/ws.js          realtime hub + call signaling
public/            the web app (index.html, app.css, js/*)
deploy/            run/watchdog scripts + nginx snippet + sudo setup
test/              i18n checks + module smoke tests
```

## Quick start (local)

```bash
git clone https://github.com/SepehrMohammady/ConnectWell.git
cd ConnectWell
npm install
npm start            # http://127.0.0.1:3010/connectwell/
```

Requires **Node >= 22.5** (it uses the built-in `node:sqlite`).

The first account you register becomes the admin. Runtime data lands in `data/`,
which is gitignored — back that directory up and nothing else.

## Configuration

Copy [`.env.example`](.env.example) to `.env` and edit. Every value has a
working default except in production, where `PUBLIC_ORIGIN` must match the
address people actually use — it gates the allowed WebSocket origins and the CSP,
so a wrong value leaves the page loading but realtime dead.

| Setting | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `3010` / `127.0.0.1` | Where the app listens. Keep it on loopback behind a reverse proxy. |
| `BASE_PATH` | `/connectwell` | URL prefix the app is mounted at. `` (empty) serves it at the root. |
| `PUBLIC_ORIGIN` | `http://127.0.0.1:<PORT>` | The origin users reach, e.g. `https://chat.example.com`. **Set this in production.** |
| `PROD` | off | `1` enables production behaviour (secure cookies). |
| `BRAND` | `ConnectWell` | Name shown in the footer next to the copyright — put your own here. |
| `DATA_DIR` | `data` | Where the database and uploads live. |
| `MAX_UPLOAD_MB` | `200` | Largest single upload. |
| `PER_USER_FILE_MB` | `5120` | Ceiling on one user's live shared files. |
| `SESSION_DAYS` | `90` | Session lifetime. |
| `STUN_URLS` | Google STUN | Comma-separated STUN servers. |
| `TURN_HOST` / `TURN_SECRET` / `TURN_TTL` | — | Optional TURN relay; see below. |

Retention settings are listed under [Shared-file retention](#shared-file-retention).

## Deployment

The shape below is one that works; nothing in the app depends on it. The app
runs as an unprivileged user on `127.0.0.1:3010`, and a reverse proxy terminates
TLS and forwards `/connectwell/` to it.

1. **Node** — install Node 22.5+ any way you like, including unpacking the
   official tarball into `~/opt/node` if you have no root.

2. **App** — clone into `~/apps/connectwell`, then:

   ```bash
   npm install --omit=dev
   cp .env.example .env
   ```

   and edit `.env`:

   ```ini
   PROD=1
   PORT=3010
   PUBLIC_ORIGIN=https://chat.example.com
   BRAND=Your Name
   ```

3. **Keep it running.** With systemd, a unit running `node server.js` is enough.
   Without root, cron plus the bundled watchdog works:

   ```cron
   @reboot   bash $HOME/apps/connectwell/deploy/watchdog.sh
   * * * * * bash $HOME/apps/connectwell/deploy/watchdog.sh
   ```

4. **Reverse proxy.** Paste [`deploy/nginx-connectwell.conf`](deploy/nginx-connectwell.conf)
   into your HTTPS server block, or let the helper do it on a standard nginx
   layout:

   ```bash
   sudo bash ~/apps/connectwell/deploy/setup-server.sudo.sh chat.example.com
   ```

   The proxy must pass WebSocket upgrades and allow a body at least as large as
   `MAX_UPLOAD_MB`.

5. **Updates** — `git pull && npm install --omit=dev`, then restart. If you use
   the cron watchdog, stopping the process is enough; it comes back within a
   minute:

   ```bash
   pkill -f "[a]pps/connectwell/server.js"
   ```

   The `[a]` is deliberate. Run over SSH, a plain
   `pkill -f apps/connectwell/server.js` also matches the shell running the
   command and kills your session along with the app.

**Backups:** never copy `connectwell.db` with `cp` — in WAL mode most of the
recent data is in the `-wal` file beside it, so a plain copy silently captures
almost nothing. Use SQLite's own consistent snapshot, which is safe on a running
database:

```bash
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/connectwell.db');d.exec(\"VACUUM INTO 'backup.db'\");d.close()"
```

### TURN for reliable calls on strict networks

Ring and accept ride the app's own WebSocket, but the audio and video flow
directly device-to-device over ICE. On CGNAT, mobile-carrier and strict-NAT
networks there is no direct path, so STUN alone cannot connect: the call is
accepted and then silent. A TURN relay fixes it.

The app is already wired for it — once `TURN_HOST` and `TURN_SECRET` are in
`.env`, `api/ice` hands out short-lived HMAC credentials and the client uses them
automatically. No code change.

```bash
# 1. put a hostname and a shared secret in .env:
printf 'TURN_HOST=chat.example.com\nTURN_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
# 2. install and configure coturn, open the firewall, start the service:
sudo bash deploy/setup-turn.sudo.sh
# 3. restart the app so it reads the new .env
```

`setup-turn.sudo.sh` reads those values from `.env` into `/etc/turnserver.conf`,
so the secret never enters git. It opens 3478 udp+tcp and the relay range
49160–49260/udp in ufw and starts coturn.

If your host puts a second firewall in front of the machine — many cloud
providers configure one in their control panel rather than on the box — open the
same ports there too. Otherwise coturn runs happily while remaining unreachable
from outside, which looks exactly like the bug you were trying to fix.

## Shared-file retention

Chat uploads in `data/uploads` are reclaimed by two independent rules. Profile
and group photos live in `data/avatars` and are never eligible — the sweep does
not know that path exists.

| Setting | Default | Meaning |
| --- | --- | --- |
| `FILE_RETENTION_DAYS` | `365` | Age rule: files older than this are removed. `0` disables it. |
| `STORAGE_HIGH_GB` / `STORAGE_HIGH_BYTES` | `60` GB | Backstop trigger: above this, start removing. |
| `STORAGE_LOW_GB` / `STORAGE_LOW_BYTES` | `50` GB | Backstop target: remove oldest-first until under this. |
| `STORAGE_MIN_AGE_MS` | `3600000` | A file is not eligible until this old, so a sweep cannot race an upload still being written. |
| `STORAGE_SWEEP_MS` | `900000` | How often the sweep runs. `0` disables it. |
| `PURGE_ENABLED` | *off* | **Deletion happens only when this is `1`.** Otherwise every sweep is a dry run. |

**Deletion is off by default.** With `PURGE_ENABLED` unset the sweep still
measures, selects and records what it *would* remove to `data/purge-log.jsonl`,
changing nothing. Inspect that log, and `GET api/admin/storage`, before switching
it on.

Anything nonsensical — thresholds swapped, zero, or unparseable — disables
purging entirely rather than being clamped, because a misread threshold must
never mean "delete everything". Admins can inspect usage with
`GET api/admin/storage` and run one sweep on demand with
`POST api/admin/storage/sweep`.

A purged message keeps its place in the conversation and shows "Removed to free
space" with the original name and size; the file itself 404s.

## API / protocol overview

REST under `api/`: `register`, `login`, `logout`, `me`, `bootstrap`, `users`,
`conversations` (+ `/:id/messages`, `/read`, `/members`, `/upload`), `files/:id`,
`messages/:id` (DELETE), `activity` (+ `/seen`), `ice`,
`admin/users` (+ approve/block/unblock/delete), `health`. State-changing
requests require the `X-Requested-With: ConnectWell` header (CSRF defence in
depth).

WebSocket at `ws`: server pushes `hello`, `msg:new`, `msg:deleted`, `conv:new`,
`conv:updated`, `conv:removed`, `presence`, `typing`, `user:pending`,
`user:updated`, `call:state`, `call:ring`, `call:declined`, `call:ended`, `rtc`,
`activity:new`, `activity:sync`. `call:state` carries the call's shared `eco`
verdict plus the `ecoUsers` who asked for it.
Clients send `typing`, `call:start`, `call:join`, `call:leave`, `call:decline`,
`rtc`, `call:eco`. Calls are per-conversation rooms keyed by connection id, so
multiple devices per user work.

## Tests

```bash
npm test
```

Checks that every referenced translation key resolves, that no key is unused,
that the Farsi dictionary matches English key-for-key and slot-for-slot, and that
all frontend modules execute under a DOM shim in both languages.

## Versioning

Semantic versioning. `package.json` is the single source of truth: the server
reports it from `GET api/health` and the UI renders it in the footer, so the
badge can never drift from the build that is actually deployed.

| Bump | When |
| --- | --- |
| **patch** | Bug fix, security fix, docs, dependency upgrade, refactor with no behaviour change |
| **minor** | New feature, or a backward-compatible behaviour change |
| **major** | Breaking change to the HTTP/WS API, the storage schema, or the deploy contract |

While the app is `0.x` the API is not frozen: a breaking change may land as a
minor bump rather than forcing `1.0.0`.

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Sepehr Mohammady.

The ConnectWell name and the logo and icon image files are not part of the MIT
grant. Fork the code freely; please use your own name and artwork for a public
deployment, so users can tell instances apart.
