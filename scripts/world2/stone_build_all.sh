#!/usr/bin/env bash
# Build every world2 stone-ruin GLB, render previews from the exported files, then re-import + verify them.
#   bash scripts/world2/stone_build_all.sh            (from the repo root; ~15 min on an RTX 3050 laptop)
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=game/public/models/world2
PRE=scripts/world2/previews
mkdir -p "$OUT" "$PRE"
B="blender -b --factory-startup --python-exit-code 1 --python"

$B scripts/world2/ruins_build.py     -- "$OUT/ruins_kit.glb"
$B scripts/world2/colonnade_build.py -- "$OUT/colonnade.glb"
$B scripts/world2/aqueduct_build.py  -- "$OUT/aqueduct.glb"
$B scripts/world2/castle_build.py    -- "$OUT/castle.glb"

$B scripts/world2/stone_previews.py -- "$OUT/ruins_kit.glb" "$PRE/ruins_kit" lineup 1600
$B scripts/world2/stone_previews.py -- "$OUT/colonnade.glb" "$PRE/colonnade" single 1600
$B scripts/world2/stone_previews.py -- "$OUT/aqueduct.glb"  "$PRE/aqueduct"  single 1600
$B scripts/world2/stone_previews.py -- "$OUT/castle.glb"    "$PRE/castle"    single 1600

$B scripts/world2/stone_verify.py -- "$OUT/ruins_kit.glb" "$OUT/colonnade.glb" "$OUT/aqueduct.glb" "$OUT/castle.glb"
