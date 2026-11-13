<div align="center">

<img src=".github/readme/icon.png" width="112" alt="ConnectWell icon">

# ConnectWell

A private messenger you run on your own server, for a family, a team or a group of friends.

[![License: MIT](https://img.shields.io/badge/license-MIT-29c8e8.svg)](LICENSE)

[Website](https://semo-lab.com/connectwell/) · [Live demo](https://semo-lab.com/connectwell/demo/) · [Contact](https://semo-lab.com/#contact)

</div>

## About

ConnectWell is a messenger with chats, groups, file sharing, voice and video messages, and
voice and video calls, on a server you control. It is one Node.js program with one SQLite
database, so it runs on a small VPS or a spare computer at home, with no other services to set
up. New accounts wait for the admin's approval, and there is no member list to browse: people
find each other by searching for a name they already know. It works in any modern browser, and
as an app on Android and Windows.

## Features

### Conversations

- Chats and groups: typing indicators, online status, unread counts and read receipts.
- Replies, reactions and forwarding: a forwarded message names the person who wrote it.
- Edit or delete a message freely until someone has read it. After that, deleting it needs their agreement.
- Drafts: text you haven't sent stays in its conversation on that device, and a conversation opens at the first unread message.
- Attachment search: find a conversation's photos, videos, voice messages or documents by type and date.

### Files, voice and video

- File sharing: photos, videos, music and documents, up to 200 MB each by default. Photos open full size, media plays with a seek bar, and files can be dragged into a conversation.
- Voice and video messages: recorded in the browser, with the front or rear camera.
- Efficiency mode: photos, voice messages and calls use far less data. In a call it lowers the quality for everyone, and the call says who turned it on.

### Calls

- Voice and video calls, one to one or in a group. A voice call can become a video call at any time.
- Direct and encrypted: audio and video go straight between devices. An optional TURN relay gets calls through strict networks.
- Missed calls show in the conversation and in the activity bell.

### Notifications and apps

- Notifications for messages, calls and reactions reach a phone or computer even when ConnectWell is closed, and incoming calls ring.
- The activity bell collects missed calls and reactions to your messages. Each one opens the message it is about.
- Apps for Android and Windows, built from this repository for your own server. The Android app rings for calls; the Windows app stays in the tray and starts with Windows.
- The install button offers each device what suits it: the Windows app on a PC, the Android app on an Android phone, and the web app on iPhone, iPad, Mac and Linux.

### Members and the server

- Approval: every new account waits until an admin lets it in.
- Admins approve, block and remove members, set a new password for someone who forgot theirs, and can make other members admins.
- The server panel shows members, activity, storage use and the server's health.
- File clean-up: old shared files can be removed after a set time, oldest first if the disk fills up. It runs as a dry run until the admin turns deletion on.

### Look and language

- English and Persian, with right-to-left layout, the Iranian calendar and Persian digits. Each message keeps its own text direction, so Persian and English sit side by side.
- Light and dark themes, or the device's setting, and a choice of conversation backgrounds.
- Profile photos and group photos.

## Privacy

Everything ConnectWell stores stays on the server that runs it: accounts, messages, files and
photos, in one data folder that holds a SQLite database and the shared files. Nothing goes to
SeMo Lab. There are no ads, analytics or trackers, and the web app loads nothing from other
sites.

ConnectWell is not end-to-end encrypted. Whoever controls the server can read messages and
files: the person who runs it, the hosting provider, or anyone who breaks in. That is what makes
history, search and several devices work, and for a family or a small team that trusts the
person running it, it is a fair trade. If even the server's operator must not be able to read
your messages, use [Signal](https://signal.org).

Two things involve other services:

- Calls go directly between devices, encrypted. To find a route, each device asks a STUN server
  (Google's by default) for its public address, so that server sees the device's IP address.
- Notifications travel through the push service of the browser's maker (Google, Microsoft,
  Mozilla or Apple), encrypted to the device. The service sees that a notification was sent, not
  what it says.

[SECURITY.md](SECURITY.md) explains what is protected and how.

## Download

ConnectWell isn't on Google Play or the Microsoft Store. Each server runs its own copy, and its
members sign in there.

**Try the demo.** The [live demo](https://semo-lab.com/connectwell/demo/) has people, groups
and messages ready: sign in as `ada` with the password `demo12345`. It is wiped and filled
again every night, so don't keep anything there.

**Run your own server.** You need Node.js 22.5 or newer.

```bash
git clone https://github.com/SepehrMohammady/ConnectWell.git
cd ConnectWell
npm install
npm start
```

Open http://127.0.0.1:3010/connectwell/ and create an account. The first account becomes the
admin, so create yours before you share the address. Everything ConnectWell stores goes into
a `data/` folder next to the code. To put it online with a domain, HTTPS, backups and calls
that connect on any network, follow the [deployment guide](docs/DEPLOYMENT.md).

**Get the apps.** The Android and Windows apps are built for one server, with its address
inside. [docs/APPS.md](docs/APPS.md) shows how to build them and offer them from the web app,
where members download them with the install button. On iPhone, iPad, Mac and Linux, the web
app installs from the browser.

## Built with

Node.js with Express, `ws` for WebSockets and Node's built-in SQLite driver. The web app is
plain JavaScript modules, loaded by the browser as they are, with no build step. Calls use
WebRTC, and notifications use Web Push. The Android app is a Trusted Web Activity built with
Google's Android Browser Helper, and the Windows app uses Electron and electron-builder.

## Development

1. Install Node.js 22.5 or newer (`engines` in package.json).
2. `npm install`
3. `npm start` runs the server at http://127.0.0.1:3010/connectwell/.
4. `npm test` checks the translations and the notification encryption, and loads every module
   in both languages. Run it before every commit.
5. Each server signs its Android app with its own key, kept in an instance folder outside this
   repository ([docs/APPS.md](docs/APPS.md)).

More detail:

- [Deployment](docs/DEPLOYMENT.md): a domain, HTTPS, keeping it running, backups, and TURN for calls.
- [Configuration](docs/CONFIGURATION.md): every setting, and the rules for removing old files.
- [Apps](docs/APPS.md): the Android and Windows apps, notifications, and building them for your server.
- [Architecture](docs/ARCHITECTURE.md): how the parts fit together, and the HTTP and WebSocket API.

## Contributing, conduct and security

Bug reports, ideas and pull requests are welcome: [CONTRIBUTING.md](CONTRIBUTING.md) says how,
and lists the few rules a change must keep. Everyone taking part follows the
[code of conduct](CODE_OF_CONDUCT.md). Please report security problems privately, as
[SECURITY.md](SECURITY.md) explains.

## License

Copyright (c) 2026 Sepehr Mohammady. ConnectWell is free and open source under the
[MIT License](LICENSE).

The ConnectWell name and logo are not part of that license. If you run a public server, please
give it your own name and artwork, so people can tell servers apart.

ConnectWell is one of the apps from [SeMo Lab](https://semo-lab.com/).
