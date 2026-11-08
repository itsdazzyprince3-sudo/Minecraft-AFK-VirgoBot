# Minecraft AFK Bot (VirgoBot)

A Minecraft bot that joins your server and keeps it alive around the clock.
It reconnects automatically if kicked or if the server restarts, and can be
hosted for free on several platforms.

---

## How It Works

The bot uses Mineflayer to join your Minecraft server as a fake player.
It moves around, swings its arm, and does small random actions so the server
does not detect it as idle. If it gets kicked or disconnected for any reason,
it reconnects on its own using an exponential backoff so it does not spam the server.
Mineflayer is configured to automatically request a respawn when the bot dies.

A small web server runs alongside the bot. You can visit the URL your host gives
you to see a live dashboard showing whether the bot is connected, its uptime,
and its coordinates.
The dashboard also provides token-protected keyboard and touch movement
controls for the connected bot. It controls the Mineflayer bot; it is not a
Minecraft game client and does not render a playable 3D world.

For local use, start with `npm start`, open `http://127.0.0.1:5000`, and enter
the same `DASHBOARD_TOKEN` you set before starting the process. Use W/A/S/D or
the on-screen buttons to move; Space jumps, Shift sneaks, and Ctrl sprints.
Manual input pauses the patrol until all controls are released. Held inputs
automatically release if the dashboard stops sending its control heartbeat.

AI and dashboard secrets belong in the ignored `.env` file. A language model is
required for genuine open-ended conversation and flexible reasoning; without
one, the bot can still run its deterministic Minecraft skills but its fallback
conversation is limited. For a local setup, install Ollama on the same machine
as the bot, run `ollama pull qwen2.5:1.5b`, and keep `ai.provider` set to `auto`
or `local`. With `auto`, the bot uses Ollama when no cloud API key is present and
uses the configured cloud provider when a key is present. Set `OLLAMA_URL` or
`OLLAMA_MODEL` to override the local settings. If the bot is hosted remotely,
`127.0.0.1` means the bot host—not your PC—so run a model endpoint where the bot
can reach it or configure a supported cloud provider. Deterministic Minecraft
skills handle actions and verify game state, so gameplay does not depend on the
language model inventing or directly executing game commands.

> **Want the exact game screen and a real player?** See [`real-client/`](real-client/README.md): the real Minecraft client with Baritone, watched in your browser.

### Live 3D view (see what the bot sees)

Start the bot with `BOT_VIEWER=1` (or set `view.browser.enabled` to `true` in
`settings.json`) and a `DASHBOARD_TOKEN`. The dashboard then shows a **3D view**
card: enter the token, press **Open 3D view**, and a first-person view of the bot's
world appears next to the movement controls, with a Minecraft-style HUD drawn on top
(hearts, hunger, XP, hotbar with item icons, crosshair, coordinates and recent chat).
The HUD uses the game's own sprites and font; the standalone page is at
`http://127.0.0.1:3007/watch?token=...` (the dashboard's **Full screen** button opens it).

**Play from the browser.** On that page, click the view to take control: `WASD` move, mouse
looks (pointer lock), `Space` jump, `Shift` sneak, `Ctrl` sprint, `1`-`9` hotbar, left click
attacks, right click uses, `Q` drops, `F` swaps hands, `T` opens a chat box, `Esc` releases the
mouse. It uses the bot's existing manual-control system, so patrol and anti-AFK pause while you
drive, and keys are released if the page closes or stops sending heartbeats. It refuses while an
AI task is running.

**Speed.** The 3D view is drawn by your own browser's GPU, not streamed as video, so its frame
rate follows your device (up to your screen's refresh rate); only small position updates cross
the network. The top-right readout shows the real render fps and the round-trip ping. Mouse
look has one network round trip of latency. Lower `VIEWER_DISTANCE` (default 6) on weak phones. It uses `prismarine-viewer` and the
native `canvas` package, both optional; install them with
`npm install prismarine-viewer canvas` if `npm install` skipped them.

The view runs on port `3007` (`VIEWER_PORT`), binds to `127.0.0.1` unless `HOST` or
`VIEWER_HOST` is set, and requires the dashboard token. It shows a render of the
chunks the bot has loaded plus that HUD, not the official game client (no inventory screens or
entity models; for the exact game screen see `real-client/`). To use it on a phone or
another computer, run the bot on that device or open the port through your own
tunnel, and keep `DASHBOARD_TOKEN` secret.

### AI chat and survival behavior

Copy `settings.example.json` to the ignored `settings.json`, enter your server
details, and replace `YOUR_MINECRAFT_USERNAME` under `ai.allowedUsers` with your
Minecraft account name. The example enables AI and replies to ordinary chat
from allowlisted players; strangers remain unauthorized. The bot combines
`ai.allowedUsers` and `chat.tpWhitelist`. Usernames are case-insensitive. Make
sure an Ollama or cloud model is reachable as described above for natural
conversation. Restart the bot after editing settings.

You can talk naturally (for example, `Virgo, what should I do before night?`) or
ask it to act (`Virgo, gather wood and make a stone pickaxe`). The AI can answer
questions, inspect the live game state, build a multi-step plan, call its
Minecraft skills, and verify the result. Use `!ai help` for the full command
list. Examples: `!ai come`, `!ai follow me`, `!ai mine 8 stone`, `!ai craft
wooden_pickaxe`, `!ai grind wood`, `!ai status`, `!ai teach keep three logs`,
and `!ai stop`. Autonomous grinding remains off until explicitly enabled.

### Real Minecraft window capture and desktop play (Linux/X11)

In the sample configuration both `screenCapture.enabled` and
`screenCapture.controlWindow` are `false` on purpose: capture depends on the
machine's desktop, and automatic keyboard/mouse control should never start
without the user opting in. The optional `screenCapture` mode captures the
actual pixels of a visible Minecraft Java window with FFmpeg/X11 and shows
refreshed frames in the token-protected dashboard POV panel. It is separate from the reconstructed
Mineflayer viewer. On the same logged-in Linux desktop session, install
`ffmpeg` and `xdotool`, start Minecraft, then set `screenCapture.enabled` to
`true` and `screenCapture.windowTitle` to the visible window title (usually
`Minecraft`). Start the bot from a terminal in that desktop session so
`DISPLAY` and X11 permissions are available. The capture backend currently
requires X11; native Wayland capture is not supported.

To have the visual AI also play that real window, set
`screenCapture.controlWindow` to `true`, install/run Ollama on the same machine
and pull a vision model (for example, `ollama pull llava`). Desktop-control mode
automatically enables the vision action loop and **does not log a second
Mineflayer player into the server**. The existing Minecraft client must already
be logged in and in the world. AI actions briefly send keyboard/mouse input to
that window and bring it to the foreground, so do not use the PC at the same
time; test first in a disposable world. Keep `controlWindow: false` to stream
the real window without allowing the AI to control it. Configure a strong
`DASHBOARD_TOKEN`; remote POV access is protected by it.

The bot also builds a skill catalog from the installed Minecraft data: mining,
crafting, smelting, equipping, hunting, breeding, and delivery entries for every
block, item, mob, and recipe the version knows. Use `!ai skills <search>` to
find an id, `!ai skill <id> [count]` to run one directly (for example
`!ai skill mine:diamond_ore 4`), `!ai think <goal>` to inspect a plan, and
`!ai solve <goal>` to plan and execute it. Natural instructions such as
`!ai make me a full iron armor set`, `!ai survive the night`, or
`!ai get me some diamonds` are decomposed into skill steps, including any
pickaxe tier needed before mining. `!ai tunnel 16` digs a lit, hazard-aware
tunnel, `!ai fish` works a nearby water block, `!ai withdraw <item> [count]`
pulls stock from a chest, and `!ai farm` harvests and replants multiple crops.

The local brain adds a deliberation layer on top of the catalog. Before acting it
reads health, food, hostiles, time, tools, armor, and recent skill outcomes, then
weighs the urgent need against the request. It narrates its reasoning with
`!ai think`, reports its world model and learned reliability with `!ai brain`,
and explains the last choice with `!ai why`. Failed plans are diagnosed (blocked
route, missing prerequisite, absent target, low health) and retried with a
different tactic instead of repeating the same attempt. During autonomous
grinding it also spends calm windows on upgrades such as a better pickaxe,
torches, iron reserves, armor, or farm upkeep.

Recognition is built into the same loop. `!ai recognize` (also
`!ai what do you see`) classifies nearby blocks, ores, hazards, animals, hostile
mobs, players, tools, armor, and food, then gives a field assessment such as
"diamond ore needs a tier-3 pickaxe" or "lava is close, do not dig down". Crashing
creeper recognition changes the plan; valuable ore recognition becomes an
autonomous mining candidate when the area is calm.

The bot can train itself from the web without an API key. `!ai research creeper`
fetches the Minecraft Wiki, extracts verifiable sentences, and stores them in
`data/ai-knowledge.json`. `!ai train` starts an unlimited background curriculum
(every 90 seconds by default) covering mining, mobs, farming, combat, enchanting,
the Nether, and the End; `!ai train 5` runs a fixed number of topics, `!ai train
status` reports progress, and `!ai stop training` stops it. Training persists
across restarts, queues knowledge gaps from failed tasks, records its own task
outcomes as distinct, bounded experiences (up to 300 recent episodes), and feeds
learned notes back into `!ai knowledge`, recognition, and future model prompts.
Relevant successful and failed task examples help it adapt its next approach.
This is retrieval-based learning: it does not change or fine-tune the underlying
model's weights. Set
`ai.training.enabled` to `false` to disable experience collection and web
training. `ai.training.autoStart` defaults to `false`, so web research only
runs after `!ai train` unless you opt in to starting it on launch. Training
never blocks normal commands.


With `ai.respondToTrustedChat` enabled, plain messages from names in
`ai.allowedUsers` are sent to the configured AI provider. Colloquial variants
such as “step over to me” and “break eight stone blocks” are accepted; recognized
actions use deterministic skills, while open-ended requests use the reasoning
model. This may use API quota, so the example keeps the feature disabled by
default and it should only be enabled for trusted players.

Virgo can inspect nearby blocks, entities, players, position, health, food, and
inventory; navigate to visible players; gather resources; craft and smelt items;
eat, farm, build a basic shelter, sleep, explore, and store or deliver items.
It reasons primarily from structured game state. With `view.enabled` it also
receives a software-rendered first-person reconstruction (real 26.x block
textures when the local asset pack has been built, flat colors otherwise), and
its reflex layer plays from that renderer's perception feed. The dashboard can
show this reconstructed POV through token-protected `/api/view/*` proxy routes
with F3-style telemetry: coordinates, facing, yaw/pitch, dimension, time,
health/food, block/sky light, biome, renderer FPS, and perception clearance.
This is not a capture of a real Minecraft client screen, and renderer FPS is
not a Minecraft client FPS. It fights nearby hostile mobs when instructed or
while surviving, retreats from creepers and low health, and does not attack
players.
Sleep is attempted only at night with a nearby or carried bed and no detected
nearby hostile. Colored bed items are recognized. Death location and dimension
are saved for recovery; recovery is refused across dimensions. Ordinary
Mineflayer state does not expose a complete world seed or ungenerated structures,
so structure-finding claims must be limited to loaded nearby blocks. General
anvil repair, arbitrary-coordinate block placement, and chest withdrawal are not
currently exposed as safe actions; chest deposits and preset shelter/farm
placement are supported.

`ai.autonomous.enabled` opts into local grinding. With
`ai.autonomous.mode: "local"`, Virgo chooses short goals from health, hunger,
inventory, nearby threats, and stored skill history without spending cloud API
quota; `!ai grind wood` selects a resource goal. Use `!ai pause`, `!ai resume`,
and `!ai stop` to control it. The local interval is configurable through
`ai.autonomous.intervalMs`. Autonomous logging/mining is capped to short batches
and pauses near hostiles, critical health, nearby hazards, or targets with large
vertical gaps. At night, the planner prefers a safe bed; if none is available it
can choose shelter work. Progress messages can be disabled with
`ai.autonomous.chatProgress`.

Local web lookup for Ollama is opt-in: set `ai.search.enabled` to `true` and
provide `TAVILY_API_KEY` in `.env`. Queries go to Tavily only for explicit web
searches or time-sensitive questions; results are treated as untrusted evidence
and their URLs are included. Gemini Search uses `ai.webSearch`.

Use `!ai memory` to inspect a short memory summary and recent notes, `!ai forget
<text>` to remove matching notes, or `!ai forget all` to erase all saved local
memory. These commands require an authorized username.

Local memory is stored in ignored `data/ai-memory.json`. Version 2 records
notes, facts, waypoints, player notes, skill outcomes, and counters; existing
notes-only files remain readable. `ai.learnFromAllowlistedChat` stores chat
context from allowlisted players, so enable it only when those players know
messages are retained. This is local memory, not model-weight training. When a
cloud provider is configured, relevant saved experience examples and memory
summaries may be included in its prompt; do not store secrets or private
information in learned chat.

---

## Compatibility status

Dependencies use the official npm releases Mineflayer 4.39.0 and
mineflayer-pathfinder 2.4.5, pinned in `package.json` and `package-lock.json`.
This avoids Git-hosted package dependencies and makes clean installs
reproducible from the lockfile.

The published Mineflayer release does not include complete native 26.3
support. This project carries targeted local patches for 26.3 teleport
confirmation and movement tick-end packets, based on upstream PrismarineJS
work. **These patches address known disconnect causes but do not make the
overall 26.3 protocol implementation complete or verified.** Other 26.3 packet
schemas may still fail. Use a server version supported by the published
release, or a separately tested ViaVersion/ViaProxy setup that accepts a
supported client version.

### Fabric server support

The bot speaks Minecraft's network protocol; it is not the Minecraft Java
launcher and does not start a Java game client or load Fabric client mods.
Fabric itself does not imply a different protocol for every server: a Fabric
server can accept protocol-compatible clients when its installed mods are
server-side only. Mods that require a matching client mod or custom network
payloads need their specific protocol implemented; there is no general switch
that makes Mineflayer load arbitrary mods.

The official [Fabric networking guide](https://docs.fabricmc.net/develop/networking)
describes custom payloads registered and handled by mod code. If a Fabric
server rejects the bot during login or play, identify the Minecraft version
and exact modpack first. Remove or configure any server mod that mandates a
client mod only if you administer that server. Do not select a 26.1 fallback
for a 26.3 server unless a compatible protocol-translating proxy is actually
in front of it.

The local 26.3 teleport/tick fixes are based on the upstream
[teleport-confirm change](https://github.com/PrismarineJS/mineflayer/pull/4130)
and the merged
[client tick-end change](https://github.com/PrismarineJS/mineflayer/pull/4137).
Broader 26.3 protocol/data updates remain experimental upstream work, so keep
the server log when testing and do not treat a successful spawn as proof that
every mod packet or gameplay feature is supported.

See [`dependency-repair-report.md`](dependency-repair-report.md) for the
dependency audit and test results, and
[`protocol-compatibility-report.md`](protocol-compatibility-report.md) for
historical protocol findings.

---

## Requirements

- A GitHub account
- Node.js 22 or newer for the published dependency set
- A Minecraft server (see compatibility section below)
- A hosting account for the bot (see deployment options below)

---

## Minecraft Server Compatibility

Not all servers are the same. Here is an honest breakdown of how well the bot
will survive long-term on each type.

### Aternos (Free)

Survival rating: Low

Aternos shuts the whole server down after a period with no real player activity.
This happens at the platform level and your bot cannot stop it no matter how
good the code is. The bot handles the vanilla idle-kick fine, but Aternos's own
shutdown system will eventually end the session.

What you can do: set player-idle-timeout=0 in server.properties to stop the
vanilla kick. Beyond that, someone needs to actually log in periodically to
reset Aternos's timer. This bot is better used to keep the server alive while
real players are online and have just stepped away briefly.

### Minehut (Free)

Survival rating: Medium

Minehut is less aggressive than Aternos about shutting servers down. The bot
will last longer here, but Minehut still has its own activity detection and
will eventually hibernate your server. Same advice applies: set
player-idle-timeout=0 and expect occasional shutdowns.

### Ploudos (Free)

Survival rating: Medium

Similar to Minehut. Less restrictive than Aternos. The bot performs better here
but you are still subject to the host's inactivity rules.

### Your own VPS or Oracle Cloud Free Tier (Recommended)

Survival rating: Very High

If you run your own Paper/Spigot server on a VPS, there is no third party
shutting you down. Set player-idle-timeout=0 and the bot stays in the server
permanently as long as the bot host is running. Oracle Cloud gives you a free
ARM VM with 4 cores and 24GB RAM forever with no credit card tricks. This is
the setup that actually achieves near-permanent uptime.

### Bisect Hosting / Apex / Shockbyte (Paid shared hosting)

Survival rating: High

These hosts do not have aggressive inactivity shutdowns. The bot will stay
connected as long as the Minecraft server is running. Combined with a reliable
bot host and UptimeRobot, uptime is consistently high. Costs around $3-8/month
depending on the host.

### Hypixel, public servers, large networks

Survival rating: Very Low

Large servers have anti-bot systems. They will detect movement patterns that
are too regular, flag accounts with no purchase history, and ban the bot
quickly. This bot is designed for private SMPs and small servers, not public
networks.

---

## Setup

### Step 1 - Configure your Minecraft server

1. Install Paper or Bukkit on your server.
2. Enable offline/cracked mode so the bot can join without a paid account.
3. Use a server version supported by the published Mineflayer release. Native
   26.3 support is not verified with this registry-based dependency set.
4. In server.properties, set player-idle-timeout=0.
   This stops Minecraft from kicking the bot for being idle.

---

### Step 2 - Configure the bot

The repository contains `settings.example.json`, not your personal
`settings.json`. Create your private runtime file, then edit it in Nano:

```sh
cp settings.example.json settings.json
nano settings.json
```

`settings.json` is intentionally ignored by Git, so it is not uploaded to
GitHub. In Nano, use **Ctrl+W** to find a setting, edit only the value, then
save with **Ctrl+O**, press **Enter**, and exit with **Ctrl+X**. Restart the bot
after changing settings. JSON does not allow comments: keep the double quotes
and commas, write booleans exactly as `true` or `false` (not quoted), and do not
leave a trailing comma.

Required edits are the server address/port and bot username. In
`ai.allowedUsers`, replace `YOUR_MINECRAFT_USERNAME` with your own Minecraft
username to allow your account to use AI chat. The sample already enables AI
chat for that allowlist and keeps untrusted players unauthorized.

```json
"bot-account": {
  "username": "YourBotUsername"
}

"server": {
  "ip": "your.server.ip",
  "port": 25565,
  "loader": "fabric",
  "version": "26.1"
}

"utils": {
  "auto-auth": {
    "enabled": true,
    "password": "YourAuthPassword"
  }
},
"ai": {
  "enabled": true,
  "model": "gemini-3.5-flash-lite",
  "apiUrl": "https://generativelanguage.googleapis.com/v1beta/interactions"
}
```

For a Minecraft 26.3 server, do not assume direct native support. Use a proxy
that translates between the server and a protocol version supported by the
published Mineflayer release, and configure a fallback only after verifying
that proxy.

For AI mode, set these as environment variables on the bot host. Do not put
provider or dashboard secrets in `settings.json` or commit them:

| Variable | What it does |
|----------|--------------|
| `AI_API_KEY` | Gemini or compatible provider key |
| `LUNAX_API_KEY` | Optional Lunax API key; with `AI_PROVIDER=auto`, this selects `lunax-chat` |
| `LUNAX_MODEL` | Optional Lunax model override; defaults to `lunax-chat` |
| `LUNAX_API_URL` | Optional Lunax chat-completions endpoint override |
| `MODEL_API_KEY` | Optional Meta Model API key; with `AI_PROVIDER=auto`, selects Muse Wonder if no Lunax key is set |
| `META_MODEL` | Optional Meta model override; defaults to `muse-wonder-1.0` |
| `META_REASONING_EFFORT` | Meta reasoning level: `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` (defaults to `low`) |
| `META_API_URL` | Optional Meta Responses endpoint override |
| `OPENAI_API_KEY` | Optional OpenAI key; with `AI_PROVIDER=auto`, selected when no Meta key is set |
| `AI_MODEL` | Optional override; defaults to `gemini-3.5-flash-lite` |
| `AI_API_URL` | Optional endpoint override; defaults to the selected provider endpoint |
| `AI_PROVIDER` | `auto`, `local`, `gemini`, `openai`, `meta`, or `lunax`; `auto` uses local Ollama without a cloud key |
| `OPENAI_API_URL` | Optional OpenAI-compatible chat endpoint override |
| `OPENAI_MODEL` | Optional OpenAI model override; defaults to `gpt-5.5` |
| `OPENAI_REASONING_EFFORT` | OpenAI reasoning level: `low`, `medium`, `high`, or `xhigh` (defaults to `low`) |
| `DASHBOARD_TOKEN` | Required private token for submitting and stopping tasks from the dashboard |
| `DISCORD_RELAY_TOKEN` | Secret for `POST /api/discord/chat`. If unset, the relay only accepts a valid `DASHBOARD_TOKEN` |
| `HOST` | Interface the web server binds to. Defaults to `127.0.0.1`, or `0.0.0.0` when the host platform sets `PORT` |

To use Lunax, add `LUNAX_API_KEY` to `.env`; `AI_PROVIDER=auto` selects it
when present and uses `lunax-chat` at `https://lunax.co/api/v1/chat/completions`.
The adapter sends a messages-only request and asks for one JSON action or answer per
turn. The bot validates each action locally before execution. Verify the account
quota and model availability with Lunax before relying on the provider.

To use Meta reasoning, add `MODEL_API_KEY` to `.env`; `AI_PROVIDER=auto` selects
Muse Wonder when that key is present and no Lunax key is set. The default model is `muse-wonder-1.0`; set
`META_REASONING_EFFORT=medium` or `high` for deeper planning. Meta Responses uses
server-managed response context for tool results and keeps all in-game actions inside
the same bounded local tool layer. API usage may be billed.

To use OpenAI, add `OPENAI_API_KEY` to `.env`; if both Meta and OpenAI keys are set,
auto mode selects Meta. You can explicitly set `AI_PROVIDER=openai` and
`AI_MODEL=gpt-5.5` as well. OpenAI reasoning effort defaults to `low`; set
`OPENAI_REASONING_EFFORT=medium` or `high` for more planning at the cost of slower
responses and API usage. `AI_API_URL` can point to another OpenAI-compatible
chat-completions service. Cloud calls may incur provider charges. Providers using
native tools rely on function calling; Lunax uses the bounded JSON action protocol.
All model-selected actions pass through local validation;
all game actions still pass through the bot's local skills, allowlist, and limits.
The bot uses the model to inspect inventory, gather blocks, craft items, and
navigate nearby. AI mode does not
run random movement, combat, or unsolicited chat modules. It is opt-in; with
`ai.enabled` set to `false`, the existing AFK behavior remains in use.
When AFK movement is enabled, each patrol lap uses randomized waypoints and
pauses within the configured radius, then returns to the starting block before
repeating. It does not dig blocks to clear a route. Server-side AFK policies
or shutdowns can still disconnect the bot.

Add your Minecraft username to the tp whitelist so only you can move the bot:

```json
"chat": {
  "tpWhitelist": ["YourMinecraftUsername"]
}
```

Upload all the files to a new GitHub repository when done.

---

## Run on Termux, Windows, macOS, or proot

The bot runs on Node.js and uses the same `npm start` command on each platform.
Node.js 22 or newer is required; use a current Node.js LTS release when possible.
Run the commands from the repository folder. Keep `settings.json` private.

### Quick install (Linux/macOS Bash)

The installer clones this repository into `~/Minecraft-AFK-VirgoBot`, installs
the locked npm dependencies, and creates a private `settings.json` from the
example. It does not start the bot. Review the installer in the repository
before running it, then use:

```sh
curl -fsSL https://raw.githubusercontent.com/itsdazzyprince3-sudo/Minecraft-AFK-VirgoBot/main/install.sh | bash
cd ~/Minecraft-AFK-VirgoBot
nano settings.json
npm start
```

To choose another install folder, set `MINECRAFT_AFK_BOT_DIR` before the curl
command. The directory must not already exist. This script requires Git, npm,
and Node.js 22 or newer; Termux users should follow the Termux instructions
below instead.

### Install from source with npm

There is currently **no package published to the npm registry**, so
`npm install @Minecraft-AFK-VirgoBot` is not a valid installation command
(scoped npm packages also require the form `@scope/package`). To install with
npm, clone the source repository and install its dependencies:

```sh
git clone https://github.com/itsdazzyprince3-sudo/Minecraft-AFK-VirgoBot.git
cd Minecraft-AFK-VirgoBot
npm install
cp settings.example.json settings.json
nano settings.json
npm start
```

Use `npm ci` instead of `npm install` when you want the exact dependency
versions from the committed lockfile, as the platform-specific instructions
below do.

### Termux (Android)

In the Termux app (install Termux from F-Droid or its official GitHub releases):

```sh
pkg update
pkg install nodejs-lts git
git clone https://github.com/itsdazzyprince3-sudo/Minecraft-AFK-VirgoBot.git
cd Minecraft-AFK-VirgoBot
cp settings.example.json settings.json
nano settings.json
npm ci
npm start
```

Keep Termux open while the bot runs. Android may stop background apps to save
battery; allow Termux to run unrestricted in Android battery settings. A bot
running on your phone also needs an active internet connection.

### Linux inside Termux proot-distro

You can run it directly in Termux as above; proot is optional. If you prefer a
Linux distribution, install and enter one from Termux:

```sh
pkg update
pkg install proot-distro
proot-distro install ubuntu
proot-distro login ubuntu
```

Then, inside the Linux shell, install Git and Node.js 22 or newer using that
distribution's current package instructions. Confirm `node --version` is at
least 22 before installing the bot:

```sh
apt update
apt install -y git nodejs npm
git clone https://github.com/itsdazzyprince3-sudo/Minecraft-AFK-VirgoBot.git
cd Minecraft-AFK-VirgoBot
cp settings.example.json settings.json
nano settings.json
npm ci
npm start
```

If the distribution's `nodejs` package is older than version 22, install a
supported Node.js LTS version before running `npm ci`. Proot does not keep
processes running after the Termux/proot session or Android itself is stopped.

### Windows PowerShell

Install Node.js LTS, open PowerShell in the repository folder, and run:

```powershell
Copy-Item settings.example.json settings.json
notepad settings.json
npm.cmd ci
npm.cmd start
```

PowerShell may block the `npm.ps1` wrapper due to the system execution policy.
Using `npm.cmd` avoids changing that policy. Start the dashboard and supervised
bot with `npm.cmd start`.

To start the bot in a separate PowerShell window and open its dashboard
automatically, run this from the repository folder:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-bot-new-window.ps1
```

For diagnosing protocol disconnects, add `-ProtocolDebug`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-bot-new-window.ps1 -ProtocolDebug
```

The new bot window then includes `frameHex` for failed packets up to 512 bytes.
The browser opens the dashboard, where the AI instruction box is available
when `ai.enabled` is `true`. Set `AI_API_KEY` and `DASHBOARD_TOKEN` in the
PowerShell session before running the launcher if AI task control is needed.

### Windows Command Prompt

Install Node.js LTS, open Command Prompt in the repository folder, and run:

```bat
copy settings.example.json settings.json
notepad settings.json
npm ci
npm start
```

### macOS Terminal

Install Node.js LTS (for example, with Homebrew), then run:

```sh
brew install node
cp settings.example.json settings.json
open -e settings.json
npm ci
npm start
```

On any of these systems, stop the bot with `Ctrl+C`. To run the automated tests,
use `npm test` (or `npm.cmd test` in PowerShell).

---

## Deployment Options

Pick one platform to host the bot. All of them run Node.js and work with this bot.
Use `npm ci` as the build command for a clean, lockfile-based install. The start
command is `npm start`.

---

### Railway (Recommended - Free tier, no sleep)

Best for: people who want the easiest setup and reliable free hosting.

Railway gives you $5 of credit per month on the free tier, which is enough to
run this bot 24/7. It does not sleep the way Render does.

1. Go to railway.app and sign in with GitHub.
2. Click New Project, then Deploy from GitHub Repo.
3. Select your repository.
4. Railway detects Node.js and deploys automatically.
5. Go to Variables and add your environment variables (see below).
6. The bot starts within a minute.

Environment variable to add:
- RAILWAY_STATIC_URL is set automatically by Railway, which activates the self-ping system.

---

### Render (Free tier, but sleeps after 15 minutes)

Best for: people already using Render, or who pair it with UptimeRobot.

Render's free tier sleeps services that have no inbound traffic for 15 minutes.
The self-ping system in this bot helps, but Render changed their free tier in
2024 and self-pinging is no longer fully reliable. You must use UptimeRobot
alongside Render to keep it awake.

1. Go to render.com and create an account.
2. Click New, then Web Service.
3. Connect your GitHub repository.
4. Set Build Command to: npm ci
5. Set Start Command to: npm start
6. Deploy.
7. Copy the URL Render gives you.
8. Go to uptimerobot.com, create a free monitor pointing to your Render URL + /ping.
9. Set interval to 5 minutes.

Environment variable to add in Render's dashboard:
- RENDER_EXTERNAL_URL: your full Render URL, example https://your-bot.onrender.com

Without that variable the self-ping will not activate.

---

### Oracle Cloud Free Tier (Best long-term option - Truly free forever)

Best for: people who want maximum uptime and full control at zero cost.

Oracle gives you a free ARM VM (4 cores, 24GB RAM) that never expires and
has no inactivity shutdowns. You run both the Minecraft server and the bot
on the same machine if you want. This is the most powerful free option available.

Setup takes about 30 minutes but you never have to touch it again.

1. Go to cloud.oracle.com and create a free account. You need a credit card
   to verify identity but you will not be charged.
2. Go to Compute, then Instances, then Create Instance.
3. Change the shape to Ampere (ARM), which is part of the always-free tier.
4. Download the SSH key it gives you.
5. Once the VM is running, SSH into it:
   ssh -i your-key.key ubuntu@YOUR_VM_IP
6. Install Node.js:
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
7. Clone your GitHub repo:
   git clone https://github.com/YourUsername/YourRepo.git
   cd YourRepo
   npm ci
8. Install pm2 to keep the bot running after you close SSH:
   sudo npm install -g pm2
   pm2 start npm --name afkbot -- start
   pm2 save
   pm2 startup
9. The bot now runs permanently and restarts automatically if it crashes.

To check status: pm2 status
To see logs: pm2 logs afkbot
To restart: pm2 restart afkbot

---

### AWS EC2 Free Tier (12 months free, then costs money)

Best for: people already familiar with AWS or who need AWS specifically.

AWS gives you a t2.micro or t3.micro instance free for 12 months.
After 12 months it costs around $8-10/month. If you want free forever,
use Oracle Cloud instead.

1. Go to aws.amazon.com and create an account.
2. Go to EC2 and click Launch Instance.
3. Choose Ubuntu 22.04 as the OS.
4. Choose t2.micro (free tier eligible).
5. Create or select a key pair and download it.
6. In Security Groups, allow inbound traffic on port 5000 (or whatever PORT you set).
7. Launch the instance.
8. SSH into it:
   ssh -i your-key.pem ubuntu@YOUR_EC2_IP
9. Install Node.js and follow the same steps as Oracle Cloud above (steps 6-9).

Note: set a billing alert in AWS so you know if you accidentally go over the free tier.

---

### Fly.io (Free tier available)

Best for: people comfortable with a CLI-based workflow.

Fly.io has a generous free tier and does not sleep like Render.

1. Install the Fly CLI: https://fly.io/docs/getting-started/installing-flyctl/
2. Run: fly auth signup
3. In your project folder run: fly launch
4. Follow the prompts. Choose the free plan.
5. Deploy with: fly deploy
6. Set environment variables with: fly secrets set BOT_USERNAME=YourName

---

## Keep It Alive with UptimeRobot (Recommended for Render and Railway)

UptimeRobot pings your bot's /ping endpoint every 5 minutes for free.
This guarantees your bot host never sleeps.

1. Go to uptimerobot.com and create a free account.
2. Click Add New Monitor.
3. Set type to HTTP(s).
4. Set the URL to your deployment URL + /ping.
   Example: https://your-bot.railway.app/ping
5. Set interval to 5 minutes.
6. Save.

---

## Environment Variables

Set these in your hosting platform's dashboard instead of putting credentials in settings.json.
This keeps your passwords off GitHub.

| Variable          | What it does                              |
|-------------------|-------------------------------------------|
| BOT_USERNAME      | The bot's Minecraft username              |
| BOT_PASSWORD      | The bot's Minecraft password (if needed)  |
| BOT_AUTH_PASSWORD | The password for /login on the server     |
| AI_API_KEY        | Model provider API key (AI mode)           |
| AI_MODEL          | Optional override; defaults to Gemini 3.5 Flash Lite |
| AI_API_URL        | Optional endpoint override; defaults to Gemini Interactions |
| DASHBOARD_TOKEN   | Required to control bot tasks from dashboard |
| PORT              | The port for the web dashboard (optional) |

---

## Dashboard

Once the bot is running, visit your deployment URL to see the status dashboard.
It shows whether the bot is connected, its uptime, coordinates, and server IP.

Visit /tutorial on the same URL for a quick setup reminder.
Visit /health for a raw JSON status response.
Visit /ping to confirm the service is running.
When AI mode is enabled, use the instruction box on the dashboard to give the
bot a goal. The dashboard control token is required for AI and movement controls
because the dashboard may be internet-accessible. Tasks are limited to 30 model
actions, and a task can be stopped from the same page.

If the bot is disconnected, /health and the dashboard show the most recent
server kick or disconnect reason. Reconnect backoff now persists across short
connections. With the example 120-second maximum, later retries can be about
two minutes apart; the terminal prints each scheduled delay. The bot cannot
prevent server-host shutdowns, authentication failures, unsupported protocol
versions, bans, or server anti-bot policies.

### Troubleshooting protocol parse errors

If the log contains `Parse error for play.toClient` with a packet ID, the client
could not decode a server packet. Check that `server.version` matches the
version advertised by your server first. Packet IDs and packet names depend on the negotiated protocol version; do not
assume an ID has the same meaning across versions. The current published
dependency set does not guarantee native 26.3 packet decoding.

To temporarily include the full hex for small failed packets while testing in
PowerShell:

```powershell
$env:MINECRAFT_PROTOCOL_DEBUG_FRAMES = "1"
npm.cmd start
```

The setting only applies to that PowerShell window; remove it afterward with:

```powershell
$env:MINECRAFT_PROTOCOL_DEBUG_FRAMES = $null
```

To check whether the 26.3 teleport-confirm compatibility wrapper is active,
enable its field-name-only diagnostic:

```powershell
$env:MINECRAFT_PROTOCOL_DEBUG_WRITES = "1"
npm.cmd start
```

It reports the active schema and outgoing field names, without logging
coordinates or packet contents. Turn it off with:

```powershell
$env:MINECRAFT_PROTOCOL_DEBUG_WRITES = $null
```

The full frame is printed only for failed packets no larger than 512 bytes.
Length-delimited packets that fail only with a partial-read/schema error are
logged and skipped so one malformed packet does not immediately close the
connection. Other malformed protocol errors still close it. Skipping a packet
can affect that feature (for example, packet 75 may contain recipe-book data).
Do not post logs publicly; send the complete parse error and `frameHex`
privately when asking for help, since packet contents can include server data.

---

## Testing

Run the automated checks without a server configuration:

```bash
npm ci
npm test
npm ls --depth=0
```

The tests cover bot controls, patrols, process supervision, local packet
compatibility, and version selection. Native 26.3 end-to-end compatibility is
not verified. To start the bot and connect to a server, separately copy
`settings.example.json` to a private `settings.json` and configure an authorized
test server. Do not use a public server or bypass authentication and hosting
restrictions.

---

## settings.json Reference

Use **Ctrl+W** in Nano to search for one of these keys. The defaults below are
from `settings.example.json`:

| Key | Default | What changing it does |
|-----|---------|-----------------------|
| `ai.enabled` | `true` | Enables instruction-driven AI behavior. Leave on for natural AI chat and task commands. |
| `ai.allowedUsers` | placeholder username | Replace `YOUR_MINECRAFT_USERNAME` with your own name; only trusted users can use AI chat. |
| `ai.respondToTrustedChat` | `true` | Lets the AI answer ordinary messages from the allowlist; outsiders remain unauthorized. |
| `ai.autonomous.enabled` | `false` | Turns on periodic autonomous gathering. Keep off unless you want the bot to choose tasks by itself. |
| `utils.auto-reconnect` | `true` | Reconnects after the server or network drops. Usually leave on. |
| `utils.auto-auth.enabled` | `false` | Use only if your server has an AuthMe-like login plugin; its password is private. |
| `movement.circle-walk.enabled` | `true` | Patrols around the bot's spawn position when the AFK movement module is active. |
| `modules.combat` | `true` | Allows the AFK module to attack nearby mobs. |
| `modules.avoidMobs` | `true` | Runs only when `modules.combat` is `false`; with the sample's combat setting, this avoidance module is skipped. |
| `view.enabled` | `false` | Starts the optional reconstructed world viewer; it is not a real desktop capture. |
| `screenCapture.enabled` | `false` | Captures the actual Minecraft window on Linux/X11 and displays it in the protected dashboard. Requires FFmpeg, xdotool, and a visible client window. |
| `screenCapture.controlWindow` | `false` | With capture enabled, lets vision AI send keyboard/mouse input to that window. It focuses the game window and skips the Mineflayer login; only enable deliberately. |
| `vision.llm` | `false` | Runs the slower vision-model action loop for the reconstructed viewer. Desktop-control mode turns it on automatically. |
| `discord.enabled` | `false` | Sends configured events to Discord; keep the webhook URL private. |

For **real-screen streaming only**, set `screenCapture.enabled` to `true` and
leave `screenCapture.controlWindow` as `false`. For **AI play on that client**,
set both to `true`; see the Linux/X11 requirements and focus warning above.

Set the required server IP/port and bot username, and replace the AI allowlist
placeholder with your Minecraft username. After those required edits, do not
change `bot-account.type`, `server.loader`, `server.version`,
`server.proxy-version-fallback`, model names, or API URLs just to “try” values:
they control authentication/protocol/provider compatibility and arbitrary
changes can stop the bot connecting or the model responding. In particular,
do not guess a Minecraft version; use one supported by the installed
Mineflayer protocol, or ask for help first. Never commit or share
`settings.json`, passwords, API keys, dashboard tokens, or Discord webhooks.

---

## Discord Notifications (Optional)

1. In Discord, go to your server settings, then Integrations, then Webhooks.
2. Create a webhook and copy the URL.
3. In settings.json set discord.enabled to true and paste the URL.
4. Choose which events to send under discord.events.

---

## Notes

- The bot username must not be the same as any real player on the server.
- On Aternos and similar free hosts, the server itself may shut down regardless
  of what the bot does. player-idle-timeout=0 only prevents the vanilla idle kick.
- This project is not affiliated with Aternos, Mojang, or Microsoft.
  Use it responsibly and make sure it complies with your server's rules.

---

## Credits

- Slobos (Discord: sloboscc) - Original idea and creator
- MrJuice (Discord: MrJuice3046) - Rewrites, fixes, and maintenance

License: MIT
