# Security

## What this software does and does not protect

**ConnectWell is not end-to-end encrypted.** Messages, captions, file names and
uploaded files are stored unencrypted on the server that runs it. Anyone with
access to that machine — you, your hosting provider, anyone who compromises it,
or anyone holding a backup — can read everything. This is a deliberate trade for
history, search, multi-device access and small, auditable code.

Calls are different: audio and video are peer-to-peer WebRTC and are encrypted
in transit (DTLS-SRTP, mandatory in WebRTC). The server relays only signaling.
If you run a TURN relay, media passes through it still encrypted end to end —
the relay forwards packets it cannot read.

If you need a messenger where the operator cannot read message content, use
something built for that, such as Signal. If you are the operator and your users
trust you, this is a reasonable design.

## What it does protect

- **Transport** — intended to run behind a reverse proxy terminating TLS.
  Serve it over HTTPS; without it, session cookies and everything else travel in
  the clear.
- **Passwords** — stored as scrypt hashes with a per-user salt, never plaintext
  and never recoverable.
- **Sessions** — random tokens, stored hashed, in `HttpOnly` `SameSite` cookies;
  `Secure` when `PROD=1`. Signing out revokes the token and closes its sockets.
- **Registration** — open to anyone who reaches the URL, but new accounts are
  inert until an admin approves them. The first account created becomes admin.
- **XSS** — a strict Content-Security-Policy with no inline script or style and
  no external origins. The client builds DOM nodes and sets `textContent`; it
  never assigns `innerHTML` from user data.
- **CSRF** — state-changing requests require an `X-Requested-With` header, which
  cross-origin form posts cannot set.
- **Uploads** — size-capped per file and per user; images are validated by magic
  bytes and dimensions server-side, not by their claimed type; files are served
  with `Content-Disposition: attachment` and a nosniff header, so an uploaded
  file cannot execute as a page on your origin.
- **Access control** — every message, file and conversation route re-checks
  membership on the server. A non-member gets a 404 rather than a 403, so
  probing cannot confirm that something exists.
- **TURN** — credentials are short-lived HMACs derived from a shared secret; the
  relay refuses to forward toward loopback, link-local and private ranges, so it
  cannot be turned into a probe of your internal network.
- **Rate limiting** — on registration, login, reactions and deletion requests.

## Running it safely

- Put it behind HTTPS and set `PUBLIC_ORIGIN` to the real origin.
- Set `PROD=1` so cookies are marked `Secure`.
- Register the admin account yourself, immediately, before sharing the address.
- Keep `HOST` on `127.0.0.1` and let the proxy be the only public listener.
- Back up `data/` with `VACUUM INTO`, not `cp` — and remember the backup contains
  every message and file in plaintext. Store it accordingly.
- Keep Node updated; the app has only two dependencies (`express`, `ws`), so
  most of your patching surface is Node itself.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue:
use GitHub's **Report a vulnerability** button on the Security tab of the
repository, or contact the maintainer at <https://sepehrmohammady.com>.

Include what you did, what happened, and what you expected. A proof of concept
helps. You will get an acknowledgement as soon as the report is read; this is a
small project maintained in spare time, so please allow reasonable time for a
fix before disclosing publicly.
