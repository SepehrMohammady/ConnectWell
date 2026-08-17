#!/bin/bash
# ============================================================================
# ConnectWell — ROOT-ONLY step (run ONCE with sudo on the server).
# Everything else (Node, app, service, updates) needs no sudo.
#
#   sudo bash ~/apps/connectwell/deploy/setup-server.sudo.sh chat.example.com
#
# Inserts the /connectwell/ reverse-proxy block into an existing nginx site
# (right after its `root` line, inside the HTTPS server block), then tests and
# reloads nginx. Idempotent; backs up the site file first.
#
# This assumes the common layout of one nginx site file per domain with a
# `root /var/www/<domain>;` line to anchor against. If your setup differs, skip
# this script and paste deploy/nginx-connectwell.conf into your server block by
# hand — that is all it does.
#
#   DOMAIN   the site to patch; first argument, or $DOMAIN
#   SITE     override the site file path outright
#   ANCHOR   override the regex the snippet is inserted after
# ============================================================================
set -e

DOMAIN="${1:-${DOMAIN:-}}"
if [ -z "$DOMAIN" ] && [ -z "${SITE:-}" ]; then
    echo "Usage: sudo bash $0 <domain>        e.g. sudo bash $0 chat.example.com" >&2
    exit 1
fi

SITE="${SITE:-/etc/nginx/sites-available/$DOMAIN}"
ANCHOR="${ANCHOR:-^[[:space:]]*root[[:space:]]+/var/www/${DOMAIN//./\\.};}"
SNIPPET="$(cd "$(dirname "$0")" && pwd)/nginx-connectwell.conf"

[ -f "$SITE" ] || { echo "nginx site not found: $SITE"; exit 1; }
[ -f "$SNIPPET" ] || { echo "snippet not found: $SNIPPET"; exit 1; }

if grep -q 'location \^~ /connectwell/' "$SITE"; then
    echo "nginx already has the /connectwell/ block — nothing to change."
else
    cp "$SITE" "$SITE.bak.$(date +%s)"
    # Insert the snippet immediately after the site's `root` line, which is
    # unique to the HTTPS server block.
    awk -v snip="$SNIPPET" -v anchor="$ANCHOR" '
        { print }
        $0 ~ anchor && !done {
            print ""
            while ((getline line < snip) > 0) print "    " line
            close(snip)
            done = 1
        }
    ' "$SITE" > "$SITE.new"
    if ! grep -q 'location \^~ /connectwell/' "$SITE.new"; then
        echo "ERROR: could not find the anchor line in $SITE; no changes made."
        echo "       Expected a line matching: $ANCHOR"
        echo "       Override it with ANCHOR=..., or paste $SNIPPET in by hand."
        rm -f "$SITE.new"
        exit 1
    fi
    mv "$SITE.new" "$SITE"
    echo "Inserted /connectwell/ proxy block (backup saved next to the site file)."
fi

nginx -t
systemctl reload nginx
echo "Done — ConnectWell is live at https://${DOMAIN:-your-domain}/connectwell/"
