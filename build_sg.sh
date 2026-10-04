#!/bin/bash
# Game character from the segmented model (model-tri-segment.glb, 81 parts, unrigged) using the hooded-assassin rig:
# same sculpt, so the Tripo skin weights transfer surface-to-surface; coat / scarf get a real cloth simulation
# free spring-bone chains like the 3d-anim/samurai game (--spring), with clearance made by slimming the trouser
# thighs under the coat (--slim).
# Output: sg/out/rig.blend, game/public/models/ninja.glb, game/src/clipMeta.json
set -e
cd "$(dirname "$0")"
SEG=$(realpath "${1:-model-tri-segment.glb}")
[ -f ha/out/prep.blend ] || ./build_ha.sh
mkdir -p sg/out
B="blender -b --factory-startup --python"
$B scripts/sg_prep.py -- "$SEG" "$PWD/ha/out/prep.blend" "$PWD/sg/out/prep.blend" | grep -E "ALIGN|SG verts|rror" || true
$B scripts/ha_rig.py -- "$PWD/sg/out/prep.blend" "$PWD/sg/out/rig.blend" --spring --slim --panels --flare --follow | grep -E "LAB (coat|trousers)|pieces|rror" || true
$B scripts/game_build.py -- "$PWD/sg/out/rig.blend" "$PWD/game/public/models/ninja.glb" "$PWD/game/src/clipMeta.json" \
  | grep -E "WROTE|rror" || true
echo done
