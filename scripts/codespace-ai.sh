#!/usr/bin/env bash
# Host the bot's local AI (Ollama) inside a GitHub Codespace.
#
# Usage:
#   scripts/codespace-ai.sh install   # first-time setup (called by postCreateCommand)
#   scripts/codespace-ai.sh start     # start the server (called by postStartCommand)
#   scripts/codespace-ai.sh url       # print the public /api/chat URL
#
# Environment overrides:
#   OLLAMA_MODEL      default qwen2.5:1.5b
#   OLLAMA_PORT       default 11434
#   OLLAMA_KEEP_ALIVE default 30m

set -euo pipefail

MODEL="${OLLAMA_MODEL:-qwen2.5:1.5b}"
PORT="${OLLAMA_PORT:-11434}"
KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-30m}"
LOG="${HOME}/ollama-codespace.log"

have_ollama() {
  command -v ollama >/dev/null 2>&1
}

install_ollama() {
  if have_ollama; then
    echo "[codespace-ai] Ollama already installed."
    return 0
  fi
  echo "[codespace-ai] Installing Ollama..."
  curl -fsSL https://ollama.com/install.sh | sh
}

is_up() {
  curl -fsS "http://127.0.0.1:${PORT}/api/tags" >/dev/null 2>&1
}

start_ollama() {
  if is_up; then
    echo "[codespace-ai] Ollama is already listening on port ${PORT}."
    return 0
  fi

  echo "[codespace-ai] Starting Ollama on 0.0.0.0:${PORT}..."
  OLLAMA_HOST="0.0.0.0:${PORT}" \
  OLLAMA_KEEP_ALIVE="${KEEP_ALIVE}" \
    setsid nohup ollama serve >"${LOG}" 2>&1 < /dev/null &

  for _ in $(seq 1 30); do
    if is_up; then
      echo "[codespace-ai] Ollama is up."
      return 0
    fi
    sleep 1
  done

  echo "[codespace-ai] Ollama did not start. Last log lines:" >&2
  tail -n 20 "${LOG}" >&2 || true
  return 1
}

pull_model() {
  echo "[codespace-ai] Ensuring model ${MODEL} is available..."
  ollama pull "${MODEL}"
}

public_url() {
  if [ -n "${CODESPACE_NAME:-}" ]; then
    local domain="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
    echo "https://${CODESPACE_NAME}-${PORT}.${domain}/api/chat"
  else
    echo "http://127.0.0.1:${PORT}/api/chat"
  fi
}

case "${1:-start}" in
  install)
    install_ollama
    start_ollama
    pull_model
    ;;
  start)
    install_ollama
    start_ollama
    pull_model
    ;;
  url)
    public_url
    exit 0
    ;;
  *)
    echo "usage: $0 [install|start|url]" >&2
    exit 2
    ;;
esac

echo ""
echo "[codespace-ai] Ollama is ready."
echo "[codespace-ai] Local  : http://127.0.0.1:${PORT}/api/chat"
echo "[codespace-ai] Public : $(public_url)"
echo "[codespace-ai] Add this to .env on the device that runs the bot:"
echo ""
echo "OLLAMA_URL=$(public_url)"
echo "OLLAMA_MODEL=${MODEL}"
echo ""
echo "[codespace-ai] The public URL only works after the port is made public:"
echo "  gh codespace ports visibility ${PORT}:public -c \"\${CODESPACE_NAME}\""
