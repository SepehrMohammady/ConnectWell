#!/bin/bash
# Wipe a demo instance back to its seeded state.
#
#   bash scripts/reset-demo.sh
#
# Intended for a PUBLIC demo, where strangers can post whatever they like: a
# nightly reset keeps it presentable and bounds how long anything they upload
# survives. Wire it to cron:
#
#   0 4 * * *  bash $HOME/apps/connectwell-demo/scripts/reset-demo.sh
#
# It DESTROYS the database and every uploaded file, so it refuses to run unless
# the instance's own .env says DEMO=1. A real deployment never has that line,
# which is what makes it impossible to point this at real conversations.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

if ! grep -qE '^DEMO=1[[:space:]]*$' .env 2>/dev/null; then
    echo "Refusing to wipe $DIR: its .env does not say DEMO=1." >&2
    echo "Only an instance explicitly marked as a demo may be reset." >&2
    exit 1
fi

DATA="$(grep -E '^DATA_DIR=' .env | cut -d= -f2- | tr -d '"' || true)"
DATA="${DATA:-data}"
case "$DATA" in /*) ABS="$DATA" ;; *) ABS="$DIR/$DATA" ;; esac

NODE="${CONNECTWELL_NODE:-$HOME/opt/node/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node)"

echo "==> stopping the demo"
pkill -f "$DIR/server.js" 2>/dev/null || true
sleep 2

echo "==> clearing $ABS"
rm -rf "$ABS"
mkdir -p "$ABS"

echo "==> seeding"
"$NODE" scripts/seed-demo.js

echo "==> starting"
bash deploy/run.sh
