# Apps for Android and Windows

ConnectWell works in any modern browser, and installs as a web app from one.
The apps in [`apps/`](../apps) add the one thing a browser tab cannot promise:
**notifications that reach you when ConnectWell is closed**: a message, a
reaction, an incoming call that actually rings.

Both apps are thin. The interface is your server's own web app, loaded from your
server, so deploying a new server version updates the apps too. You only rebuild
an app when something in `apps/` changes.

Each build belongs to **one server**: it carries that server's address, and on
Android its own signing key. Nothing about your deployment goes into the
repository: it lives in an *instance folder* you keep private.

## How notifications work

| What happens | Who is told |
| --- | --- |
| A message, photo, voice or video message | Everyone else in the conversation |
| An incoming call | Everyone else in the conversation. It rings, with Accept and Decline |
| A call that stops ringing | Each device that rang: *missed*, *answered on another device* or *declined* |
| A reaction to your message | You |
| Someone asks to delete a message you have read | You |
| Someone puts you in a group | You |
| A new account waits for approval | The admins |

Nobody is notified while they are **actively using the app**: its window is in
front, focused, and has been touched in the last few minutes. The open window
already shows what happened; a phone buzzing in your pocket for the chat you are
typing into is noise.

Notification text is written by your server in each device's own language
(English or Farsi), and travels **end-to-end encrypted** to the device
([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)). The push services that
carry it (Google's for Chrome and Android, Microsoft's for Edge, Mozilla's for
Firefox, Apple's for Safari) see only that *something* was sent, when, and how
big, never what it says. Nothing has to be signed up for: your server generates
its own key pair on first start (`data/push-vapid.json`).

### Where they come from on each platform

- **Android app:** background push, delivered by Chrome on the phone and
  posted under the app's own name and icon. Calls ring with the phone's ringtone
  until they are answered, declined or over. Works with the app closed.
- **Windows app:** keeps running in the system tray when its window is closed,
  and starts with Windows. Messages appear as Windows notifications; a call
  shows an incoming-call notification that stays up and rings.
- **A browser, or the installed web app:** background push where the browser
  supports it (Chrome, Edge, Firefox, Safari 16.4+ on Mac, and iOS 16.4+ once
  added to the Home Screen). Elsewhere, notifications only while a tab is open.

Profile → Notifications says which of these applies on the device in front of
you, and its **Send a test notification** button proves the whole path.

## Requirements

- A ConnectWell server, version **0.24.0 or later**, on HTTPS.
- The server must be able to make outgoing HTTPS requests to the push services
  (most hosts allow this; a strict outbound firewall would need
  `fcm.googleapis.com`, `*.notify.windows.com`, `*.push.services.mozilla.com`
  and `*.push.apple.com` opened).
- To **build the Android app**: Node 22.5+, a Java 17+ JDK and the Android SDK.
  Installing [Android Studio](https://developer.android.com/studio) provides both;
  you do not need to open it.
- To **build the Windows app**: Node 22.5+, on Windows.

## Building the apps for your server

### 1. Create an instance folder

```bash
node apps/build.mjs init ../my-connectwell-apps \
    --url https://chat.example.com/connectwell/ \
    --id com.example.chat \
    --name "ConnectWell"
```

- `--url` is the address people open the app at, exactly.
- `--id` is the apps' permanent identity: a reversed domain you control. It can
  never change for an installed Android app, so choose it once.
- `--name` is what the app is called on the phone and in Windows.

This writes `instance.json`, creates an **Android signing key**
(`android-release.jks`, with its random password in `signing.json`), and prints
the `assetlinks.json` your domain must serve (step 3).

> **Back up the instance folder.** An installed Android app can only ever be
> updated by a build signed with the same key. Lose the key and everybody has to
> uninstall the app and install a new one. Keep the folder out of the repository:
> anywhere outside it, or `apps/instance/`, which is gitignored.

To use a key you already have, write `signing.json` yourself:

```json
{ "keystore": "my-key.jks", "alias": "my-alias", "storePassword": "…", "keyPassword": "…" }
```

### 2. Build

```bash
node apps/build.mjs android ../my-connectwell-apps    # signed APK and App Bundle
node apps/build.mjs desktop ../my-connectwell-apps    # Windows installer (run on Windows)
node apps/build.mjs all     ../my-connectwell-apps    # both
```

The results land in the instance folder's `dist/`:

- `ConnectWell-<version>.apk`: install it directly on phones.
- `ConnectWell-<version>.aab`: for Google Play, if you publish there.
- `ConnectWell-Setup-<version>.exe`: the Windows installer.

The first Android build downloads Gradle's dependencies and takes a few minutes;
later builds take under a minute. The first Windows build downloads Electron.

### 3. Prove the Android app belongs to your domain

Until this is done, the Android app opens like a browser tab: a bar across the
top shows the address, a close button and a menu, and notifications arrive as
Chrome's rather than the app's. Android removes all of that (the app runs full
screen, with its own notifications and its ringing call channel) once your
domain confirms the app is yours, with a small public file at the **root of the
domain**, even when ConnectWell lives under a path:

```
https://chat.example.com/.well-known/assetlinks.json
```

It holds only the app's id and the *public* fingerprint of its signing key, and
must be served with status 200, `Content-Type: application/json` and no
redirect. Steps 1 and 2 print everything needed for either way of serving it.

**Let ConnectWell serve it** (recommended). Add the two lines the build printed
to the server's `.env` and restart:

```ini
ANDROID_APP_ID=com.example.chat
ANDROID_CERT_SHA256=AB:CD:…
```

ConnectWell then answers at `/connectwell/.well-known/assetlinks.json`. If it is
installed at the root of its domain, that is already the right address; under a
path, hand the root path to it once in the reverse proxy, with the commented block at
the end of [`deploy/nginx-connectwell.conf`](../deploy/nginx-connectwell.conf):

```nginx
location = /.well-known/assetlinks.json {
    proxy_pass http://127.0.0.1:3010/connectwell/.well-known/assetlinks.json;
}
```

After that one line, the app's identity is ConnectWell's own configuration:
renaming the app or adding a key is an `.env` change, with no change to whatever
else your domain serves. If the site denies paths starting with a dot (a common
rule that protects `.git`), keep it: an exact-match location wins over it.

**Or publish the file yourself:** `dist/assetlinks.json` from the build, placed
so that the address above serves it.

Both are lists: during a rename, list the old and new ids; if you publish on
Google Play with Play App Signing, add the fingerprint Play shows you
(Setup → App signing) beside your own.

Check it with Google's tool:
`https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://chat.example.com&relation=delegate_permission/common.handle_all_urls`

### 4. Offer them from the web app

Copy the `.apk` and the `.exe` from `dist/` into the server's `data/apps/` (or
wherever [`APPS_DIR`](CONFIGURATION.md#the-apps) points):

```bash
scp dist/ConnectWell-0.26.0.apk dist/ConnectWell-Setup-0.26.0.exe you@server:connectwell/data/apps/
```

From then on, the install button at the top of the web app's sidebar offers
each device what suits it:

| Device | The install button |
| --- | --- |
| Windows | downloads the Windows installer, with what to expect from SmartScreen |
| Android | downloads the Android app; it disappears once the app is installed |
| iPhone, iPad | shows how to add the web app to the Home Screen |
| Anything else | installs the web app, where the browser can |

Only signed-in members can download them. The newest version in the folder is
the one offered and the folder is read on every request, so an update is a
matter of copying the new build in, with no restart. While the folder is empty,
Windows and Android are offered the web app instead. The Android app counts as
installed only when `ANDROID_APP_ID` is set (step 3); the Windows app cannot be
seen from a browser, so a Windows browser keeps offering it.

You can also hand the files out any other way you like.

### 5. Install

**Android.** Opening the `.apk` asks once to allow installs from that source
(usually the browser it was downloaded with), and Play Protect may ask you to
confirm an app it does not know. Then open the app, sign in, and tap **Enable
notifications** in the bar at the top, and Android asks for permission.

**Windows.** Run the installer. It installs for the current user, needs no
administrator rights, and opens the app. Because the installer is not code
signed, Windows SmartScreen may warn on first run: choose *More info → Run
anyway*. (A code-signing certificate removes the warning; electron-builder's
documentation covers using one.)

### Without building: a generic Windows app

`cd apps/desktop && npm install && npm run dist` produces an installer that is
not tied to any server: on first start it asks for the server address and checks
that a ConnectWell server answers there. During development, `npm start` runs it
without installing.

## On the phone

The Android app is a **Trusted Web Activity**: the web app running in the
phone's Chrome, presented as an installed app. That is what lets it use Chrome's
background push without either you or your users signing up for anything.

- **Chrome must be installed and enabled** (it almost always is). Phones without
  Google services cannot receive background push.
- The app has three notification channels, adjustable in its Android settings:
  **Calls** (rings with the ringtone, as loud as a phone call), **Missed calls**
  (quiet), and **General** (messages, which pop up).
- Some manufacturers' battery savers stop background delivery. If notifications
  only arrive when you open the app, allow it, and Chrome, to run in the
  background: *Settings → Apps → [the app] → Battery → Unrestricted*.
- Tapping a notification opens the conversation. On a call: **Accept** opens the
  app straight into the call, **Decline** answers without opening anything.

## On Windows

- Closing the window keeps the app in the tray, so calls can still ring. Quit
  from the tray icon's menu.
- It starts with Windows (minimised to the tray). Turn that off from the tray
  menu.
- The taskbar button shows how many messages are unread.
- *Focus assist* / *Do not disturb* hides notifications like any other app's.

## Updating

Deploying a newer server updates what the apps show. Rebuild and redistribute
the apps when `apps/` changes (the release notes say so) by putting the new
builds in `data/apps/` (step 4). Builds take their version from the server's
`package.json`, and the Android version code always increases with it, so a new
APK installs over the old one.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Profile → Notifications says *only while ConnectWell is open* | This browser offers no background push (or refused it, as Brave does with Google push disabled). Use the app, or Chrome / Edge / Firefox. |
| The test notification never arrives | The server cannot reach the push service (outbound firewall), or the server log shows `push:` errors. |
| Android: the app looks like a browser tab (address bar, close button, menu) | `assetlinks.json` is not being served exactly as described in step 3, or lists a different id or key than the installed app. Once it is right, force-stop the app and open it again; if the bar persists, reinstall it. |
| Android: notifications show Chrome's icon, not the app's | Same as above: without the verification, Chrome shows them itself. |
| Android: calls do not ring | The *Calls* channel was turned down in the app's notification settings, or the phone is on silent. |
| Windows: no notifications at all | Notifications for the app are off in *Settings → System → Notifications*, or Focus assist is on. |

## What is in `apps/`

```
apps/build.mjs          builds both apps for one instance folder
apps/icons.mjs          derives every icon from logo/adaptive-icon.png
apps/android/           Gradle project: the Trusted Web Activity
  app/src/main/java/…   DelegationService (ringing calls), Channels, Application
apps/desktop/           Electron: main.js (tray, notifications), preload.js (the bridge)
```

The web app tells which platform it is on by itself (`public/js/notify.js`); the
apps carry no copy of it.
