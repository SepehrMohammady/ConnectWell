# Security policy

## Report a problem privately

Please don't open a public issue for a security problem. Instead:

- write to info@semo-lab.com with "Security: ConnectWell" in the subject, or
- use **Report a vulnerability** under this repository's Security tab.

Say what is affected, how to reproduce it, and what someone could do with it. A proof of
concept helps. You'll get a reply, and the fix arrives in a new version in this repository.
ConnectWell is maintained in spare time, so please allow reasonable time for a fix before you
disclose a problem in public. Say so if you'd like to be credited.

## Versions that get fixes

The latest version in this repository. A server gets a fix when the person running it updates
to that version.

## What this covers

- The ConnectWell server and web app in this repository.
- The Android and Windows apps built from `apps/`.

A ConnectWell server is run by whoever installed it, and how it is set up is theirs to look
after. Services run by others, such as browsers, the push services that carry notifications,
STUN and TURN servers and the hosting a server runs on, are not SeMo Lab's to fix. Please
report problems in them to their owners.

## How ConnectWell keeps your data safe

### What it does not protect

**ConnectWell is not end-to-end encrypted.** Messages, captions, file names and shared files
are stored unencrypted on the server that runs it. Anyone with access to that machine can read
all of it: the person who runs it, the hosting provider, anyone who breaks in, and anyone who
holds a backup. This is a deliberate trade, for history, search, several devices per person and
code small enough to check.

Calls are different. Audio and video travel peer to peer over WebRTC and are encrypted on the
way (DTLS-SRTP, which WebRTC requires). The server only passes the signaling along. With a TURN
relay, media passes through it still encrypted from end to end: the relay forwards packets it
cannot read.

If you need a messenger whose operator cannot read the messages, use one built for that, such
as Signal. If you run the server and the people using it trust you, this design is a reasonable
one.

### What it protects

- **Transport.** ConnectWell is meant to run behind a reverse proxy that handles TLS. Serve it
  over HTTPS: without it, session cookies and everything else travel in the clear.
- **Passwords** are stored as scrypt hashes with a salt per user, never in plain text and never
  recoverable.
- **Sessions** use random tokens, stored hashed, in `HttpOnly` `SameSite` cookies, which are also
  `Secure` when `PROD=1`. Signing out revokes the token and closes its connections.
- **Registration** is open to anyone who reaches the address, but a new account can do nothing
  until an admin approves it. The first account created becomes the admin.
- **Cross-site scripting.** A strict Content Security Policy allows no inline script or style
  and no other origins. The client builds DOM nodes and sets `textContent`; it never assigns
  `innerHTML` from user data.
- **Cross-site requests.** Every request that changes something needs an `X-Requested-With`
  header, which a form posted from another site cannot set.
- **Uploads** have a size limit per file and per person. The server checks images by their
  magic bytes and dimensions, not by the type they claim, and serves files with
  `Content-Disposition: attachment` and a nosniff header, so an uploaded file can't run as a
  page on your server's address.
- **Access control.** Every message, file and conversation route checks membership again on the
  server. Someone who isn't a member gets a 404 rather than a 403, so probing can't confirm that
  something exists.
- **TURN** credentials are short-lived HMACs made from a shared secret. The relay refuses to
  forward to loopback, link-local and private addresses, so it can't be used to probe your
  internal network.
- **Rate limits** apply to registration, sign-in, reactions and deletion requests.
- **Background notifications** are encrypted to the device that receives them (RFC 8291). The
  push service that carries them (Google's, Microsoft's, Mozilla's or Apple's, depending on the
  browser) learns that a notification was sent, when, and roughly how large, but not what it
  says. A device's registration belongs to the session that made it and is deleted with it:
  signing out, a revoked session, a block or a password reset all stop that device's
  notifications. The server only delivers to the push services listed in `PUSH_HOSTS`, so nobody
  can point it at an internal address.

A notification shows message text on the device it reaches, on a locked screen too, as far as
that device's settings allow.

### Running it safely

- Put it behind HTTPS and set `PUBLIC_ORIGIN` to the real address.
- Set `PROD=1` so cookies are marked `Secure`.
- Register the admin account yourself, straight away, before you share the address.
- Keep `HOST` on `127.0.0.1` and let the reverse proxy be the only public listener.
- Back up `data/` with `VACUUM INTO`, not `cp`, and remember that the backup holds every message
  and file in plain text. Store it with that in mind.
- Keep Node.js up to date. With only two dependencies (`express` and `ws`), Node itself is most
  of what needs patching.
