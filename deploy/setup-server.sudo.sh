#!/bin/bash
# ============================================================================
# ConnectWell — ROOT-ONLY setup step (run ONCE with sudo on the VPS).
# Everything else (app install, service, updates) runs without sudo.
#
#   sudo bash ~/apps/connectwell/deploy/setup-server.sudo.sh
#
# What it does:
#   1. Inserts the /connectwell/ reverse-proxy block into the example.com
#      nginx site (before the regex asset locations) — idempotent.
#   2. Tests and reloads nginx.
# ============================================================================
set -e

SITE=/etc/nginx/sites-available/example.com
SNIPPET="$(dirname "$0")/nginx-connectwell.conf"

if grep -q 'location \^~ /connectwell/' "$SITE"; then
    echo "nginx already configured for /connectwell/ — nothing to do"
else
    cp "$SITE" "$SITE.bak.$(date +%s)"
    # Insert the snippet just before the first regex asset location.
    awk -v snip="$SNIPPET" '
        /location ~\* \\\.\(jpg\|jpeg\|png\|gif\|ico\|svg\|webp\)\$/ && !done {
            while ((getline line < snip) > 0) print "    " line
            print ""
            done = 1
        }
        { print }
    ' "$SITE" > "$SITE.tmp"
    mv "$SITE.tmp" "$SITE"
    echo "inserted /connectwell/ proxy block into $SITE (backup saved)"
fi

nginx -t
systemctl reload nginx
echo "nginx reloaded — ConnectWell is live at https://example.com/connectwell/"
