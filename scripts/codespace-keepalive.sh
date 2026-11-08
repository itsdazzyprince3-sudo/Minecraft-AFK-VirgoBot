#!/usr/bin/env bash
# Best-effort keep-alive for GitHub Codespaces.
#
# Codespaces reset their idle timer on terminal input/output. A detached tmux
# session that prints a tick every INTERVAL seconds simulates terminal output,
# which can stop the VM from idling out. This is not an official GitHub feature
# and does not bypass the 12-hour maximum Codespace lifetime.
#
# Usage:
#   scripts/codespace-keepalive.sh start
#   scripts/codespace-keepalive.sh status
#   scripts/codespace-keepalive.sh stop
#
# Environment overrides:
#   KEEPALIVE_SESSION   tmux session name (default virgo-keepalive)
#   KEEPALIVE_INTERVAL  seconds between ticks (default 45)

set -euo pipefail

SESSION="${KEEPALIVE_SESSION:-virgo-keepalive}"
INTERVAL="${KEEPALIVE_INTERVAL:-45}"

ensure_tmux() {
  if command -v tmux >/dev/null 2>&1; then
    return 0
  fi
  echo "[keepalive] Installing tmux..."
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux >/dev/null
}

is_running() {
  command -v tmux >/dev/null 2>&1 && tmux has-session -t "${SESSION}" 2>/dev/null
}

start() {
  ensure_tmux
  if is_running; then
    echo "[keepalive] Already running in tmux session ${SESSION}."
    return 0
  fi
  tmux new-session -d -s "${SESSION}" \
    "while true; do printf '[keepalive] %s\\n' \"\$(date -u +%H:%M:%S)\"; sleep ${INTERVAL}; done"
  echo "[keepalive] Started tmux session ${SESSION} (tick every ${INTERVAL}s)."
}

stop() {
  if is_running; then
    tmux kill-session -t "${SESSION}"
    echo "[keepalive] Stopped tmux session ${SESSION}."
  else
    echo "[keepalive] Not running."
  fi
}

status() {
  if is_running; then
    echo "[keepalive] Running in tmux session ${SESSION}."
  else
    echo "[keepalive] Not running."
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  restart) stop; start ;;
  *)
    echo "usage: $0 [start|status|stop|restart]" >&2
    exit 2
    ;;
esac
