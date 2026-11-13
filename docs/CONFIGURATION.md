# Configuration

Copy [`.env.example`](../.env.example) to `.env` and edit it. Real environment
variables override the file, so a systemd unit or a container can set anything
without editing files.

`.env` is gitignored: it is where everything about *your* deployment lives, so
nothing about it ever reaches the repository.

Every value has a working default. The only one a real deployment must set is
`PUBLIC_ORIGIN`.

## Core

| Setting | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3010` | Port to listen on. |
| `HOST` | `127.0.0.1` | Address to bind. Keep it on loopback and let a reverse proxy be the only public listener. |
| `BASE_PATH` | `/connectwell` | URL prefix the app is served under. Empty serves it at the domain root. |
| `PUBLIC_ORIGIN` | `http://127.0.0.1:<PORT>` | **The address your users actually type**, e.g. `https://chat.example.com`. Gates the allowed WebSocket origins and the CSP. If it is wrong, the page loads and realtime silently dies. |
| `PROD` | off | `1` turns on production behaviour, notably `Secure` cookies. Set it with a real HTTPS origin. |
| `BRAND` | `ConnectWell` | The name shown in the footer beside the copyright. Put your own here. |
| `DATA_DIR` | `data` | Where the database, uploads and avatars live. The only directory to back up. |

## Limits

| Setting | Default | Meaning |
| --- | --- | --- |
| `MAX_UPLOAD_MB` | `200` | Largest single upload. Your reverse proxy must allow at least this much too. |
| `PER_USER_FILE_MB` | `5120` | Ceiling on one user's live shared files. Forwarding duplicates bytes, so this bounds how far one person can amplify a single file. |
| `SESSION_DAYS` | `90` | How long a sign-in lasts. |
| `CALL_RING_SECONDS` | `45` | How long a call rings unanswered before the server gives up and records a missed call. |

## Calls

| Setting | Default | Meaning |
| --- | --- | --- |
| `STUN_URLS` | Google's public STUN | Comma-separated STUN servers, used to discover a direct path between devices. |
| `TURN_HOST` | none | Hostname of a TURN relay, for networks where no direct path exists. |
| `TURN_SECRET` | none | Shared secret the app signs short-lived TURN credentials with. Generate it on the server; never commit it. |
| `TURN_TTL` | `3600` | Lifetime in seconds of an issued TURN credential. |

Setting up the relay itself is covered in the
[deployment guide](DEPLOYMENT.md#calls-on-difficult-networks).

## Background notifications

Notifications that reach a device while ConnectWell is closed, in the Android
and Windows apps and in browsers that support them, are on by default and need
no setup. On first start the server generates its own key pair into
`data/push-vapid.json`; that is the whole configuration. See
[Apps](APPS.md#how-notifications-work) for what is notified, and to whom.

| Setting | Default | Meaning |
| --- | --- | --- |
| `PUSH_ENABLED` | on | `0` switches background notifications off. Notifications while the app is open are unaffected. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | generated | Supply the server's key pair yourself instead, e.g. from a secret store. **Never change it afterwards**: every device subscribed under the old key stops receiving anything until the app is next opened there. |
| `VAPID_SUBJECT` | `PUBLIC_ORIGIN` | How the push services can contact whoever runs the server: an `https:` or `mailto:` address. |
| `PUSH_HOSTS` | the four browser push services | Comma-separated hosts the server will deliver to (subdomains included; `host:port` for a non-standard port). |

`PUSH_HOSTS` exists because the server sends each notification to an address the
*browser* chose. Without a list, any signed-in user could register an internal
address and have the server make requests to it. The default covers Chrome and
Android (`fcm.googleapis.com`), Edge (`notify.windows.com`), Firefox
(`push.services.mozilla.com`) and Safari (`push.apple.com`); add a host only if
you know a browser your users run delivers through it.

The key file is part of `data/` and should be backed up with it. Losing it is
not a disaster, since devices register again the next time the app is opened,
but until then they receive nothing in the background.

## The apps

| Setting | Default | Meaning |
| --- | --- | --- |
| `ANDROID_APP_ID` | none | The Android app's package name, e.g. `com.example.chat`. Comma-separated to list more than one (both ids during a rename). |
| `ANDROID_CERT_SHA256` | none | SHA-256 fingerprint of the key that signs it, as `node apps/build.mjs` prints it. Comma-separated for more than one (your own key and Google Play's). |
| `APPS_DIR` | `data/apps` | Where your builds of the apps go to be offered to members. The install button hands Android phones the newest `.apk` here and Windows PCs the newest `.exe`; when there is none, they get the web app. |

With both Android settings set, the server publishes them as Digital Asset Links
at `<BASE_PATH>/.well-known/assetlinks.json`. That file lets Android run the
app full screen instead of as a browser tab. Android reads it from the root of
the domain, so a deployment under a path maps that one address in its reverse
proxy; [Apps](APPS.md#3-prove-the-android-app-belongs-to-your-domain) shows how.
Malformed values are reported at startup and left out. `ANDROID_APP_ID` also
goes into the web app's manifest, which is how a phone's browser knows the app
is already installed and stops offering it.

The files in `APPS_DIR` are read on each request, so putting a new build there
is the whole of an update. Only signed-in members can download them.

## Shared-file retention

Chat uploads in `data/uploads` can be reclaimed automatically by two independent
rules. Profile and group photos live in `data/avatars` and are **never**
eligible: the sweep does not know that path exists.

| Setting | Default | Meaning |
| --- | --- | --- |
| `FILE_RETENTION_DAYS` | `365` | Age rule: files older than this are removed. `0` disables it. |
| `STORAGE_HIGH_GB` / `STORAGE_HIGH_BYTES` | `60` GB | Backstop trigger: above this, start removing. |
| `STORAGE_LOW_GB` / `STORAGE_LOW_BYTES` | `50` GB | Backstop target: remove oldest-first until back under this. |
| `STORAGE_MIN_AGE_MS` | `3600000` | A file is not eligible until this old, so a sweep can never race an upload still being written. |
| `STORAGE_SWEEP_MS` | `900000` | How often the sweep runs. `0` disables it. |
| `PURGE_ENABLED` | *off* | **Nothing is ever deleted unless this is `1`.** |

**Deletion is off by default, deliberately.** With `PURGE_ENABLED` unset the
sweep still runs, measures, and records everything it *would* remove to
`data/purge-log.jsonl`, and changes nothing. Read that log, and
`GET api/admin/storage`, before switching it on.

Anything nonsensical (thresholds swapped, zero, or unparseable) disables
purging entirely rather than being clamped, because a misread threshold must
never be interpreted as "delete until the list is empty".

Administrators can inspect usage with `GET api/admin/storage` and run a single
sweep on demand with `POST api/admin/storage/sweep`.

A purged message keeps its place in the conversation and shows "Removed to free
space" along with the original name and size; the file itself returns 404.

## Telling users

If you enable purging, tell the people using your instance. The app shows a
one-time note about shared files not being permanent, but a heads-up from the
person running the server is worth more.
