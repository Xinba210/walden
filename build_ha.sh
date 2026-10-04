#!/bin/bash
# Game character from the hooded-assassin Tripo Smart Mesh export (rigged FBX, separate complete trousers).
# Tripo's body skin is kept; coat / scarf get spring chains, sticks are pinned to the hips.
# Output: ha/out/rig.blend, game/public/models/ninja.glb, game/src/clipMeta.json
set -e
cd "$(dirname "$0")"
SRC=$(realpath "${1:-hooded+assassin+3d+model/tripo_convert_0b831025-a754-4ade-bc57-329211fe3c34.fbx}")
mkdir -p ha/out
B="blender -b --factory-startup --python"
$B scripts/ha_prep.py -- "$SRC" "$PWD/ha/out/prep.blend" 1.68 | grep -E "scale|rror" || true
$B scripts/ha_rig.py -- "$PWD/ha/out/prep.blend" "$PWD/ha/out/rig.blend" | grep -E "LAB|rror" || true
$B scripts/game_build.py -- "$PWD/ha/out/rig.blend" "$PWD/game/public/models/ninja.glb" "$PWD/game/src/clipMeta.json" \
  | grep -E "WROTE|rror" || true
echo done
