#!/bin/bash
# Start ConnectWell in the background (no sudo needed).
# Usage: bash deploy/run.sh
cd "$(dirname "$0")/.." || exit 1
APPDIR="$PWD"
NODE="${CONNECTWELL_NODE:-$HOME/opt/node/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node)"
if [ -z "$NODE" ]; then echo "node not found (set CONNECTWELL_NODE or install to ~/opt/node)"; exit 1; fi
mkdir -p data
# Absolute path in argv so pgrep can reliably detect a running instance.
if pgrep -f "$APPDIR/server.js" >/dev/null 2>&1; then
    echo "ConnectWell already running"
    exit 0
fi
nohup "$NODE" "$APPDIR/server.js" >> data/server.log 2>&1 &
echo "ConnectWell started (pid $!) using $NODE"
