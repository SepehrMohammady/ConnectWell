#!/bin/bash
# Start ConnectWell in the background (no sudo needed).
# Usage: bash deploy/run.sh
cd "$(dirname "$0")/.."
NODE="${CONNECTWELL_NODE:-$HOME/opt/node/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node)"
if [ -z "$NODE" ]; then echo "node not found"; exit 1; fi
mkdir -p data
if pgrep -f "connectwell.*server\.js|server\.js.*connectwell" >/dev/null 2>&1 \
   || pgrep -f "$PWD/server.js" >/dev/null 2>&1; then
    echo "ConnectWell already running"
    exit 0
fi
nohup "$NODE" server.js >> data/server.log 2>&1 &
echo "ConnectWell started (pid $!)"
