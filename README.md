<div align="center">

<img src="public/icon-192.png" alt="" width="96" height="96">

# ConnectWell

**Your own private messenger. On your own server.**

Chat, share files, and make video calls with the people you choose —
on a server you control, with nobody else in the middle.

[![License: MIT](https://img.shields.io/badge/license-MIT-29c8e8.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-3c873a.svg)](https://nodejs.org)
[![No build step](https://img.shields.io/badge/build%20step-none-8b94a3.svg)](#why-it-is-built-this-way)
[![Dependencies](https://img.shields.io/badge/dependencies-2-8b94a3.svg)](package.json)

</div>

---

## What is it?

ConnectWell is a small, private messenger you run yourself. Give the address to
your family, your team, or a handful of friends — and that is the whole
membership. There is no company account, no directory to be found in, no
algorithm, and no adverts.

It runs as **one program with one database file**. No Docker required, no build
step, no cloud services to sign up for. It is happy on a five-euro VPS or an old
laptop in a cupboard, and it works in any modern browser on Android, iOS,
Windows, Linux and macOS — including as an installable app.

Everyone who joins needs your approval first, so the door stays shut by default.

## What can it do?

💬 **Chat properly** — one-to-one and group conversations, with typing
indicators, read receipts, replies, reactions, forwarding, and search by
attachment type or date.

📎 **Share anything** — photos, video, music and documents up to 200 MB. Images
open full size, media streams with a seek bar, and you can drag files straight
into the conversation.

🎙️ **Speak, don't type** — record a voice message or a short video message right
in the browser, front camera or rear.

📞 **Call each other** — one-to-one and group audio and video calls. The audio
and video travel directly between devices, so the server only introduces you and
then gets out of the way.

🌍 **In your language** — full English and Farsi, including right-to-left
layout, the Jalali calendar and Persian numerals. Messages follow their own
direction, so Persian and English can sit side by side.

🐌 **Built for bad connections** — a one-tap efficiency mode sends photos, voice
messages and video at a fraction of the data. In a call it is shared: if one
person needs it, everyone's quality drops with them, and the call says who asked.

🔔 **Nothing missed** — an activity bell collects missed calls and reactions to
your messages, and each one takes you straight to the message it is about.

🙈 **Second thoughts allowed** — edit or delete a message freely until the other
person has read it. After that, deleting it needs their agreement.

🌗 **Yours to arrange** — light theme, dark theme, or whatever your system says.

## See it running

There is a live demo at **<https://semo-lab.com/connectwell/demo/>** — sign in as
`ada` with the password `demo12345` and there are messages, a group, replies,
reactions and call history waiting.

It is wiped and re-seeded every night, so treat it as a shop window rather than
somewhere to keep anything.

## Try it in two minutes

```bash
git clone https://github.com/SepehrMohammady/ConnectWell.git
cd ConnectWell
npm install
npm start
```

Open **http://127.0.0.1:3010/connectwell/** and register. The first account
created becomes the administrator — so make it yours before you share the
address with anyone.

That is genuinely all: no database to set up, no configuration file to write.
Everything it stores lands in a `data/` folder next to the code.

> Ready to put it online for real? The [deployment guide](docs/DEPLOYMENT.md)
> covers a domain, HTTPS, keeping it running, backups, and reliable calls on
> difficult networks.

## Before you trust it with something

**ConnectWell is not end-to-end encrypted.** Messages and files are stored on
your server, so that history, search and multiple devices all work. That means
whoever controls the server can read them — you, your hosting provider, or
anyone who breaks in.

For a family or a small team where you are the one running it, that is usually a
fair trade and an honest one. If you need a messenger where even the operator
cannot read the messages, use [Signal](https://signal.org) instead — that is
what it is for.

Calls are different: audio and video are encrypted between devices and the
server never sees them.

[SECURITY.md](SECURITY.md) has the full picture, including what *is* protected
and how to report a problem.

## Why it is built this way

Most self-hosted chat apps ask you to run several services, a separate database,
and a build pipeline before you can say hello to anyone. ConnectWell is a
deliberate reaction to that.

- **One process, one file.** Express and `ws` are the only two dependencies.
  Storage is SQLite through Node's own built-in driver — nothing to compile.
- **No build step.** The browser loads the JavaScript that is in the repository.
  What you read is what runs, which also means you can fix something without
  learning a toolchain first.
- **Nothing phones home.** No CDNs, no fonts from elsewhere, no analytics. A
  strict Content-Security-Policy forbids it even by accident.
- **Small enough to read.** If you are going to trust a server with your
  conversations, you should be able to read the thing running on it.

## Documentation

| | |
| --- | --- |
| [Deployment guide](docs/DEPLOYMENT.md) | Put it on a server: domain, HTTPS, staying alive, backups, TURN for calls |
| [Configuration](docs/CONFIGURATION.md) | Every setting, and the file-retention rules |
| [Architecture](docs/ARCHITECTURE.md) | How it fits together, the HTTP and WebSocket API |
| [SECURITY.md](SECURITY.md) | What is protected, what is not, reporting a vulnerability |
| [CONTRIBUTING.md](CONTRIBUTING.md) | The constraints to respect before sending a patch |

## Contributing

Bug reports and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md)
explains the handful of rules that are not stylistic — no build step, no new
dependencies without a good reason, and every user-facing string in both
languages.

## License

[MIT](LICENSE) © Sepehr Mohammady. Do what you like with the code.

The ConnectWell name and the logo files are not part of that grant — please use
your own name and artwork for a public deployment, so people can tell instances
apart.
