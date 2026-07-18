#!/bin/bash
# ============================================================================
# ConnectWell — ROOT-ONLY step (run ONCE with sudo on the VPS).
# Everything else (Node, app, service, updates) needs no sudo.
#
#   sudo bash ~/apps/connectwell/deploy/setup-server.sudo.sh
#
# Inserts the /connectwell/ reverse-proxy block into the example.com nginx
# site (right after its `root` line, inside the HTTPS server block), then
# tests and reloads nginx. Idempotent; backs up the site file first.
# ============================================================================
set -e

SITE=/etc/nginx/sites-available/example.com
SNIPPET="$(cd "$(dirname "$0")" && pwd)/nginx-connectwell.conf"

[ -f "$SITE" ] || { echo "nginx site not found: $SITE"; exit 1; }
[ -f "$SNIPPET" ] || { echo "snippet not found: $SNIPPET"; exit 1; }

if grep -q 'location \^~ /connectwell/' "$SITE"; then
    echo "nginx already has the /connectwell/ block — nothing to change."
else
    cp "$SITE" "$SITE.bak.$(date +%s)"
    # Insert the snippet immediately after the `root /var/www/example.com;`
    # line, which is unique to the HTTPS server block.
    awk -v snip="$SNIPPET" '
        { print }
        /^[[:space:]]*root[[:space:]]+\/var\/www\/example\.com;/ && !done {
            print ""
            while ((getline line < snip) > 0) print "    " line
            close(snip)
            done = 1
        }
    ' "$SITE" > "$SITE.new"
    if ! grep -q 'location \^~ /connectwell/' "$SITE.new"; then
        echo "ERROR: could not find the anchor line in $SITE; no changes made."
        rm -f "$SITE.new"
        exit 1
    fi
    mv "$SITE.new" "$SITE"
    echo "Inserted /connectwell/ proxy block (backup saved next to the site file)."
fi

nginx -t
systemctl reload nginx
echo "Done — ConnectWell is live at https://example.com/connectwell/"
