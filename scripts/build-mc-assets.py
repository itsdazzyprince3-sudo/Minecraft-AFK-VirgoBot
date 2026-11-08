#!/usr/bin/env python3
"""Build the renderer asset pack from a local Minecraft client jar.

Extracts the block textures and default player/zombie skins the viewer needs,
tints grass/leaves the way the plains biome does, and packs everything into:

  data/mc/atlas.png       8xN grid of 16px block tiles (kind-1)*3+face
  data/mc/atlas.json      kind -> tile metadata for reference/debug
  data/mc/ent_player.png  16x32 Steve front sprite
  data/mc/ent_zombie.png  16x32 zombie front sprite
  data/mc/ent_other.png   16x32 Steve front sprite tinted yellow (kind 3)

No Mojang assets are committed: data/mc is gitignored and this script only
reads a jar the user already has locally.

usage: python3 scripts/build-mc-assets.py [--jar data/mc/client-26.3.jar]
"""
import argparse
import io
import json
import os
import zipfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "mc")
BLOCK = "assets/minecraft/textures/block/"
ENT = "assets/minecraft/textures/entity/"

GRASS_TINT = (0x91, 0xBD, 0x59)
FOLIAGE_TINT = (0x59, 0xAE, 0x30)

# kind -> (top, side, bottom) texture name
KIND_TEX = {
    1: ("stone", "stone", "stone"),
    2: ("dirt", "dirt", "dirt"),
    3: ("grass_block_top", "grass_block_side", "dirt"),
    4: ("oak_log_top", "oak_log", "oak_log_top"),
    5: ("oak_leaves", "oak_leaves", "oak_leaves"),
    6: ("sand", "sand", "sand"),
    7: ("water_still", "water_still", "water_still"),
    8: ("iron_ore", "iron_ore", "iron_ore"),
    9: ("lava_still", "lava_still", "lava_still"),
    10: ("snow", "snow", "snow"),
    11: ("glass", "glass", "glass"),
    12: ("short_grass", "short_grass", "short_grass"),
    13: ("netherrack", "netherrack", "netherrack"),
    14: ("bedrock", "bedrock", "bedrock"),
    15: ("stone_bricks", "stone_bricks", "stone_bricks"),
}
TINTED = {
    "grass_block_top": GRASS_TINT,
    "oak_leaves": FOLIAGE_TINT,
    "short_grass": GRASS_TINT,
    "fern": GRASS_TINT,
}
ATLAS_COLS = 8
TILE = 16


def load_tex(z, name):
    data = z.read(BLOCK + name + ".png")
    im = Image.open(io.BytesIO(data)).convert("RGBA")
    if im.height > im.width:  # animated strip: first frame only
        im = im.crop((0, 0, im.width, im.width))
    if im.size != (TILE, TILE):
        im = im.resize((TILE, TILE), Image.NEAREST)
    if name in TINTED:
        t = TINTED[name]
        px = im.load()
        for y in range(TILE):
            for x in range(TILE):
                r, g, b, a = px[x, y]
                px[x, y] = (r * t[0] // 255, g * t[1] // 255, b * t[2] // 255, a)
    return im


def load_skin(z, path):
    return Image.open(io.BytesIO(z.read(ENT + path))).convert("RGBA")


def front_sprite(skin):
    """Compose a 16x32 front-facing humanoid sprite from a 64x64 skin."""
    spr = Image.new("RGBA", (16, 32), (0, 0, 0, 0))
    parts = [
        ((4, 0), (8, 8, 8, 8)),    # head front
        ((4, 8), (20, 20, 8, 12)), # body front
        ((0, 8), (44, 20, 4, 12)), # right arm front
        ((12, 8), (36, 52, 4, 12)),# left arm front
        ((4, 20), (4, 20, 4, 12)), # right leg front
        ((8, 20), (20, 52, 4, 12)),# left leg front
    ]
    for (dx, dy), box in parts:
        x0, y0, w, h = box
        spr.paste(skin.crop((x0, y0, x0 + w, y0 + h)), (dx, dy))
    return spr


def tint(img, mul):
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if a:
                px[x, y] = (r * mul[0] // 255, g * mul[1] // 255, b * mul[2] // 255, a)
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jar", default=os.path.join(OUT, "client-26.3.jar"))
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    z = zipfile.ZipFile(args.jar)

    tiles = []
    index = {"cols": ATLAS_COLS, "tile": TILE, "kinds": {}}
    for kind in sorted(KIND_TEX):
        faces = []
        for face_name in KIND_TEX[kind]:
            im = load_tex(z, face_name)
            tiles.append(im)
            faces.append({"tex": face_name, "tile": len(tiles) - 1})
        index["kinds"][str(kind)] = {"faces": faces}

    rows = (len(tiles) + ATLAS_COLS - 1) // ATLAS_COLS
    atlas = Image.new("RGBA", (ATLAS_COLS * TILE, rows * TILE), (0, 0, 0, 0))
    for i, im in enumerate(tiles):
        atlas.paste(im, ((i % ATLAS_COLS) * TILE, (i // ATLAS_COLS) * TILE))
    atlas.save(os.path.join(OUT, "atlas.png"))
    with open(os.path.join(OUT, "atlas.json"), "w") as f:
        json.dump(index, f, indent=1)

    steve = load_skin(z, "player/wide/steve.png")
    zombie = load_skin(z, "zombie/zombie.png")
    front_sprite(steve).save(os.path.join(OUT, "ent_player.png"))
    front_sprite(zombie).save(os.path.join(OUT, "ent_zombie.png"))
    other = tint(front_sprite(steve).copy(), (255, 214, 120))
    other.save(os.path.join(OUT, "ent_other.png"))

    print(f"atlas {atlas.width}x{atlas.height} ({len(tiles)} tiles), "
          f"sprites 16x32 -> {OUT}")


if __name__ == "__main__":
    main()
