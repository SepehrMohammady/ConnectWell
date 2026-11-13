# Contributing to ConnectWell

Thank you for helping make ConnectWell better.

ConnectWell is free and open source under the [MIT License](LICENSE), and pull requests are
welcome. It is a small project with a deliberate shape, so a few notes here will save you time.

## Report a problem

Open an issue with the problem form, or write to info@semo-lab.com. Please include:

- what you did, what you expected, and what happened instead
- the ConnectWell version (at the bottom of the conversation list, or on the sign-in page)
- whether you use a browser, the installed web app, the Android app or the Windows app, and on
  which device
- for calls, the network at each end (the same Wi-Fi, mobile data, a VPN), which is usually what
  decides whether a call connects
- a screenshot or a short screen recording, if it shows the problem

Please leave other people's names and messages out of screenshots.

## Suggest an idea

Open an issue with the idea form, or write to the same address. Every idea is read, with no
promise of when, or whether, it arrives in ConnectWell.

## Help with a translation

ConnectWell is in English and Persian. If a word or sentence reads wrong, send the screen it's
on, the current text and what it should say, or change it in `public/js/i18n/` in a pull
request.

## Getting set up

```bash
npm install
npm start            # http://127.0.0.1:3010/connectwell/
npm test
```

You need Node.js 22.5 or newer, because the app uses the built-in `node:sqlite`. The first
account you register becomes the admin.

To try anything that needs two people, register a second account in another browser profile or
a private window, and approve it from the admin panel.

## The rules that keep it working

These aren't matters of taste. Breaking one breaks the app.

- **No build step.** The browser loads the client's plain ES modules directly. No bundler, no
  transpiler, no TypeScript, no JSX.
- **No new runtime dependencies** without a strong reason. There are two, `express` and `ws`,
  and neither has native code. Node's standard library covers crypto, SQLite and HTTP.
- **A strict Content Security Policy.** No inline `<script>` or `style` attributes, no `eval`,
  and nothing from other origins. Attach handlers with `addEventListener` and set styles through
  the CSSOM. Never build DOM from `innerHTML` with user data.
- **Every string a person sees lives in the dictionaries.** Add the key to
  `public/js/i18n/en.js` and to `public/js/i18n/fa.js`, then call `t('your.key')`. `npm test`
  fails if a key is missing from either file, if the slots don't match, or if a key is unused.
  Never call `t()` at module scope: the language isn't known yet at that point.
- **Right to left is real.** Use CSS logical properties (`inset-inline-start`,
  `margin-inline`) rather than `left` and `right`, and check both languages.
- **Database changes go through the guarded `addColumn()` helper** in `lib/db.js`, placed after
  the `db.exec()` schema block and before any `db.prepare()`, because prepared statements look up
  column names straight away. A new table can use `CREATE TABLE IF NOT EXISTS`. Assume every
  server has a live database full of real messages: a migration that loses data is the worst bug
  this project can ship.
- **Messages the server writes** must pass `markRead: false` to `addMessage`, or they quietly
  clear somebody's unread badge.
- **Notification tags are shared** between `public/sw.js`, the page and the Android app's
  `DelegationService` (`cw-conv-`, `cw-ring-`, `cw-call-`). Change them in all three together,
  and remember that every push must leave a notification on screen.

## The apps

`apps/` holds the Android and Windows apps ([docs/APPS.md](docs/APPS.md)). They are separate
from the server, so the server's two dependencies stay two. The Windows app has its own
`package.json` (Electron and electron-builder), and the Android app is a Gradle project. Both
are thin: the interface is always the web app, so most changes belong in `public/`. If you change
the logo, run `node apps/icons.mjs` to make every icon again from it.

## Style

Match the code around your change: 4-space indents, single quotes, semicolons, and comments
that explain why rather than what. The code relies on comments to record the reasons behind
decisions that aren't obvious. If something surprised you while fixing a bug, that is exactly
what the comment should say.

## Pull requests

- One change per pull request, with a description of what changes for the people using it.
- Run `npm test` first.
- Raise the version in `package.json` as part of the change (see the versioning table in
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#versioning)), since the app shows it and it must
  match what shipped.
- Say how you checked it. "Tested a call between two browsers on the same Wi-Fi" says more than
  a green tick.

## Security problems

Please don't report them in public. [SECURITY.md](SECURITY.md) explains how.

## Conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
