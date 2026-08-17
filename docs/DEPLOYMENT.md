# Deployment

Putting ConnectWell on a server people can actually reach: a domain, HTTPS,
something to keep it running, backups, and calls that connect on awkward
networks.

The shape below is one that works and is what the bundled scripts assume.
Nothing in the app depends on it — if you prefer systemd, Docker, Caddy or
anything else, only step 4 changes.

The app listens on `127.0.0.1:3010` as an unprivileged user, and a reverse proxy
terminates TLS and forwards `/connectwell/` to it.

## 1. Node

Node 22.5 or newer, because the app uses Node's built-in SQLite driver. Install
it however you like. With no root at all, unpacking the official linux-x64
tarball into `~/opt/node` is enough.

## 2. The app

```bash
git clone https://github.com/SepehrMohammady/ConnectWell.git ~/apps/connectwell
cd ~/apps/connectwell
npm install --omit=dev
cp .env.example .env
```

Then edit `.env`:

```ini
PROD=1
PORT=3010
PUBLIC_ORIGIN=https://chat.example.com
BRAND=Your Name
```

`PUBLIC_ORIGIN` is the one setting a real deployment must get right. It gates
the allowed WebSocket origins and the Content-Security-Policy, so if it does not
match the address people actually type, the page will load and then quietly fail
to receive anything. Every other setting has a working default —
see [Configuration](CONFIGURATION.md).

**Register your own account immediately**, before sharing the address: the first
account created becomes the administrator.

## 3. Keeping it running

With systemd, a unit that runs `node server.js` in the app directory is all you
need.

Without root, cron plus the bundled watchdog does the job — it starts the app if
it is not running, and every minute is often enough:

```cron
@reboot   bash $HOME/apps/connectwell/deploy/watchdog.sh
* * * * * bash $HOME/apps/connectwell/deploy/watchdog.sh
```

## 4. The reverse proxy

Paste [`deploy/nginx-connectwell.conf`](../deploy/nginx-connectwell.conf) inside
your site's HTTPS `server` block, or let the helper do it on a standard nginx
layout:

```bash
sudo bash ~/apps/connectwell/deploy/setup-server.sudo.sh chat.example.com
```

Whatever proxy you use, it must:

- pass WebSocket upgrades (`Upgrade` / `Connection` headers), or nothing
  realtime works;
- allow a request body at least as large as `MAX_UPLOAD_MB`;
- allow long-lived connections — a short `proxy_read_timeout` will cut the
  WebSocket repeatedly.

**One origin only.** The app pins a single origin. If your site also answers on
`www.`, redirect `www` to the apex for the app's path, or visitors arriving on
the other hostname get a page that loads and a realtime connection that is
refused.

## 5. Updates

```bash
cd ~/apps/connectwell && git pull && npm install --omit=dev
pkill -f "[a]pps/connectwell/server.js"
```

The watchdog restarts it within a minute; with systemd, restart the unit.

The `[a]` in that pattern is deliberate and not a typo. Run over SSH, a plain
`pkill -f apps/connectwell/server.js` also matches the shell running the command
and kills your own session along with the app.

## Backups

Everything that matters is in `data/` — the database, the uploads, the avatars.
Back up that directory and nothing else.

**Never copy `connectwell.db` with `cp`.** The database runs in WAL mode, so
most recent data lives in the `-wal` file beside it and a plain file copy
silently captures almost nothing. Use SQLite's own snapshot, which is consistent
and safe to run while the app is live:

```bash
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/connectwell.db');d.exec(\"VACUUM INTO 'backup.db'\");d.close()"
```

Remember what that file contains: every message and every shared file, in
plaintext. Store it as carefully as you would the server.

## Calls on difficult networks

Ringing and answering travel over the app's own WebSocket, but the audio and
video go directly between devices. On mobile carriers, CGNAT and strict company
networks there is no direct path, so the call is accepted and then silent. A
TURN relay fixes it by forwarding the media — still encrypted end to end; the
relay cannot read it.

The app is already wired for TURN. Once the settings exist, `api/ice` hands out
short-lived credentials and the browser uses them automatically — no code
change.

```bash
# 1. a hostname and a shared secret, generated on the server:
printf 'TURN_HOST=chat.example.com\nTURN_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
# 2. install and configure coturn, open the firewall, start it:
sudo bash deploy/setup-turn.sudo.sh
# 3. restart the app so it reads the new settings
```

`setup-turn.sudo.sh` reads those values out of `.env` into
`/etc/turnserver.conf`, so the secret never enters git. It opens 3478 udp+tcp
and the relay range 49160–49260/udp in ufw and starts coturn.

**If calls still fail from outside**, check for a second firewall. Many hosting
providers put one in front of the machine, configured in their control panel
rather than on the box, and it will happily let coturn run while remaining
unreachable — which looks exactly like the bug you were trying to fix.
