#!/bin/bash
# Restart ConnectWell if it is not running. Intended for cron:
#   @reboot      bash $HOME/apps/connectwell/deploy/watchdog.sh
#   * * * * *    bash $HOME/apps/connectwell/deploy/watchdog.sh
DIR="$(cd "$(dirname "$0")/.." && pwd)"
if ! pgrep -f "$DIR/server.js" >/dev/null 2>&1; then
    bash "$DIR/deploy/run.sh"
fi
