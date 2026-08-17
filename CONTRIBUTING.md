# Contributing

Thanks for taking an interest. This is a small project with a deliberate shape,
so a few notes will save you time.

## Getting set up

```bash
npm install
npm start            # http://127.0.0.1:3010/connectwell/
npm test
```

Node 22.5 or newer, because the app uses the built-in `node:sqlite`. The first
account you register becomes the admin.

To test anything involving two people, run a second browser profile (or a private
window) and register a second account, then approve it from the admin panel.

## The constraints worth knowing

These are not stylistic preferences; breaking them breaks the app.

- **No build step.** The client is plain ES modules loaded directly by the
  browser. No bundler, no transpiler, no TypeScript, no JSX.
- **No new runtime dependencies** without a strong reason. There are two
  (`express`, `ws`), both with no native code. Node's standard library covers
  crypto, SQLite and HTTP.
- **Strict CSP.** No inline `<script>` or `style` attributes, no `eval`, no
  external origins. Attach handlers with `addEventListener`, set styles through
  CSSOM. Never build DOM from `innerHTML` with user data.
- **User-facing strings live in the dictionaries.** Add the key to
  `public/js/i18n/en.js` *and* `public/js/i18n/fa.js`, then call `t('your.key')`.
  `npm test` fails if a key is missing from either, if slots do not match, or if
  a key is unused. Never call `t()` at module scope — the language is not
  resolved yet.
- **Right-to-left is real.** Use CSS logical properties (`inset-inline-start`,
  `margin-inline`) rather than `left`/`right`, and check both languages.
- **Database migrations** go through the guarded `addColumn()` helper in
  `lib/db.js`, placed after the `db.exec()` schema block and before any
  `db.prepare()` — prepared statements resolve column names eagerly. New tables
  can simply use `CREATE TABLE IF NOT EXISTS`. Assume every deployment has a
  live database with real data in it; a migration that loses data is the worst
  bug this project can ship.
- **Server-generated messages** must pass `markRead: false` to `addMessage`, or
  they silently clear somebody's unread badge.

## Style

Match the surrounding code: 4-space indent, single quotes, semicolons, and
comments that explain *why* rather than *what*. The codebase leans on comments to
record the reasoning behind non-obvious decisions — if you found something
surprising while fixing a bug, that is exactly what the comment should say.

## Pull requests

- One concern per PR, with a description of what changes for the user.
- Run `npm test` first.
- Bump the version in `package.json` as part of the change (see the versioning
  table in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#versioning)), since the UI
  shows it and it must match what shipped.
- Say how you verified it. "Tested a call between two browsers on the same LAN"
  is worth more than a green checkmark.

## Reporting bugs

Include what you did, what happened, what you expected, plus the browser and
platform. For anything involving calls, mention the network on both ends
(same Wi-Fi, mobile data, VPN) — that is usually the deciding factor.

For security issues, please follow [SECURITY.md](SECURITY.md) instead of opening
a public issue.
