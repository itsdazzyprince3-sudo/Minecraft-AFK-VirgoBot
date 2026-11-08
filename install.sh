#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="https://github.com/itsdazzyprince3-sudo/Minecraft-AFK-VirgoBot.git"
INSTALL_DIR="${MINECRAFT_AFK_BOT_DIR:-$HOME/Minecraft-AFK-VirgoBot}"

fail() {
  printf 'Installer error: %s\n' "$*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "Git is required. Install Git and run this command again."
command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required. Install Node.js and run this command again."
command -v npm >/dev/null 2>&1 || fail "npm is required. Install npm and run this command again."

node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 22) { console.error(`Node.js 22+ required; found ${process.versions.node}`); process.exit(1); }' \
  || fail "Upgrade to Node.js 22 or newer."

if [[ -e "$INSTALL_DIR" ]]; then
  fail "Install directory already exists: $INSTALL_DIR. Move it or set MINECRAFT_AFK_BOT_DIR to another path."
fi

printf 'Cloning Minecraft-AFK-VirgoBot into %s ...\n' "$INSTALL_DIR"
git clone "$REPOSITORY" "$INSTALL_DIR"
cd "$INSTALL_DIR"
npm ci

if [[ ! -f settings.json ]]; then
  cp settings.example.json settings.json
  chmod 600 settings.json 2>/dev/null || true
fi

cat <<EOF

Installation complete.
Private settings file: $INSTALL_DIR/settings.json

Next steps:
  cd "$INSTALL_DIR"
  nano settings.json
  npm start

In settings.json, enter your server address and port, bot username, and your
Minecraft username under ai.allowedUsers. Keep settings.json private; it is
ignored by Git. The bot has not been started by this installer.
EOF
