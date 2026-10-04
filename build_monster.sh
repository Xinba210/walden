#!/bin/bash
# Forest monster: rigged Tripo FBX -> 4.6 m tall, zombie / melee clips retargeted, written for the game.
# Output: monster/out/prep.blend, game/public/models/monster.glb, game/src/monsterMeta.json
set -e
cd "$(dirname "$0")"
SRC=$(realpath "${1:-dark+forest+monster+3d+model/tripo_convert_eaa3d35f-5940-4144-89b4-69b9115b2280.fbx}")
mkdir -p monster/out
B="blender -b --factory-startup --python"
$B scripts/ha_prep.py -- "$SRC" "$PWD/monster/out/prep.blend" 4.6 | grep -E "scale|rror" || true
$B scripts/game_build.py -- "$PWD/monster/out/prep.blend" "$PWD/game/public/models/monster.glb" "$PWD/game/src/monsterMeta.json" --monster \
  | grep -E "WROTE|rror" || true
echo done
