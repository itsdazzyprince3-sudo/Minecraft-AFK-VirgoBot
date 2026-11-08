# First-person viewer (C++ software raycaster)

A protocol bot has no renderer, so this builds a first-person view from the
world data the bot already receives, and streams it live. It is also the bot's
eyes: every frame it reports a compact perception summary (FREE space, obstacle
distance, visible entities) back to Node, and the reflex layer plays from it.

No GPU, no OpenGL, no image libraries except the vendored single-header
`stb_image_write.h` (JPEG encoder) and `stb_image.h` (PNG atlas/sprites).

## Build

```sh
g++ -O2 -std=c++17 -pthread cpp/bot_view.cpp -o cpp/bot_view
```

Android/Termux works; ARM64 Cortex-A55 at 320x180 measures ~83 fps idle with 8
render threads (`--bench 3`). Under heavy device load expect 40-60 fps.

## Run

Normally you do not start it by hand: with `view.enabled: true` in
`settings.json` (or `BOT_VIEW=1`) the Node bot spawns it and restarts it if it
dies. To run it standalone:

```sh
./cpp/bot_view --frame-port 31337 --http-port 8080 --w 320 --h 180 --fps 60
./cpp/bot_view --mock --http-port 8080        # synthetic world, no bot needed
./cpp/bot_view --bench 5 --threads 8          # headless fps benchmark
./cpp/bot_view --selftest                     # protocol + render smoke test
./cpp/bot_view --assets data/mc               # explicit asset dir (default)
```

## Renderer assets (real Minecraft textures)

The viewer renders the real 26.x block textures and player/zombie skins,
extracted locally from the client jar. No Mojang assets are committed
(`data/mc/` is gitignored); run the packer once per version:

```sh
mkdir -p data/mc
curl -o data/mc/client-26.3.jar \
  https://piston-data.mojang.com/v1/objects/e877b6a07acd633fb3bb475002175cec036e7b87/client.jar
python3 scripts/build-mc-assets.py --jar data/mc/client-26.3.jar
```

Requires Python 3 + Pillow. Output:

- `atlas.png` — 8-column grid of 16px tiles, tile index `(kind-1)*3 + face`
  (0 top, 1 side, 2 bottom), 15 kinds
- `ent_player.png`, `ent_zombie.png`, `ent_other.png` — 16x32 front sprites
  composed from the default skins

Without the assets the renderer falls back to the flat palette automatically,
so `--selftest`/`--bench` still work on a bare checkout.

The HTTP server binds to `127.0.0.1` by default; pass `--http-host 0.0.0.0`
only if you understand that this view is unauthenticated. For remote access
use the dashboard's token-protected `/api/view/*` proxy instead. Endpoints:
- `/stream`     multipart MJPEG, live
- `/frame`      single JPEG
- `/frame.bmp`  24-bit BMP (the Node LLM layer reads this)
- `/state`      text stats: fps, eye pose, perception summary
- `/state.json` the same data as JSON, which the dashboard F3 overlay merges
  with bot coordinates, facing, health/food, block light, and biome

## Protocol (v2)

TCP, every message is `tag(4 ascii) + u32le length + payload`.

Node -> viewer:

- `VWLD` `i32 ox,oy,oz; u16 W,H,D; u8 grid[W*H*D]` — full world snapshot,
  index `x + W*(z + D*y)`. Sent on connect, on origin drift, on resync.
- `VBLK` `u16 count; {i16 rx,ry,rz; u8 kind}` — block deltas relative to origin.
- `VFRM` `f32 eyeX,eyeY,eyeZ; f32 yaw,pitch; u16 entCount;
  {f32 rx,ry,rz; u8 kind; u8 nameLen; name}` — pose + entities each tick.

Viewer -> Node:

- `PERC` 28-byte perception summary: sequence, render fps, flags, free-space
  percentages (center/left/right, lower-band ground coverage, upper-band sky),
  forward clearance, nearest obstacle, nearest visible entity (screen position,
  kind, distance). Sent at 10 Hz.

Block kinds: 0 air, 1 stone, 2 dirt, 3 grass (tinted top), 4 wood, 5 leaves
(tinted), 6 sand, 7 water, 8 ore, 9 lava, 10 snow/ice, 11 glass, 12 plant,
13 netherrack, 14 bedrock/obsidian, 15 generic. Textured faces get Minecraft
directional shading (top 1.0, Z sides 0.82, X sides 0.62, bottom 0.5) and
distance fog into the sky gradient. Entities: 1 mob (zombie sprite), 2 player
(Steve sprite), 3 other (tinted Steve); sprites are depth-sorted and clipped
against the block depth buffer.

## Notes

- Pose is smoothed between packets (20 Hz input, 60+ fps render), so the view
  stays fluid without sending full frames from Node.
- The render loop is capped by `--fps`; the MJPEG stream by `--stream-fps`.
- Render resolution is independent of the voxel grid: lower `--w/--h` for more
  fps on weak CPUs.
- The world snapshot retries every second while it contains only air, so a
  viewer that connects before the bot's chunks load fills in automatically.
