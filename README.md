# Walden

A third-person action game in the browser, built with [three.js](https://threejs.org) and Vite.

A hooded swordswoman explores a ruined valley at sunset: a large open world with meadows of grass and red flowers, maple
trees, waterfalls, cliffs, an aqueduct and a castle on the ridge. A forest wraith roams the meadow ahead. Get close and it
hunts you down.

## Features

- **Combat**: summon or dismiss the katana, slash combos, dash slashes, dodge-roll with invulnerability
  frames, jump, sprint. Health bars for both sides, a heavy 4.6 m monster with claw and hook attacks, a death dissolve, and respawn.
- **Character**: a rigged Tripo model with spring-bone cloth. Each coat panel, the scarf and the hanging pieces swing
  with inertia, flare out from the legs and keep clear of them.
- **Open world**:
  - quadtree terrain streamed from a worker;
  - GPU grass and flower fields in LOD rings, with cheap far rings so the meadow reaches the horizon;
  - leaf-card maple canopies, water and waterfalls;
  - Blender-built stone kits with distance LODs.
- **Look**:
  - cascaded sun shadows, half-resolution SSAO, SMAA and subtle bloom;
  - sun shafts, height fog and a colour grade that keeps the characters distinct from the world.
- **Audio**: generative cinematic ambient music and procedural sound effects, all WebAudio with no audio files.

## Controls

| | |
|---|---|
| W A S D | move |
| Shift | run (hold to sprint) |
| Space | jump |
| C | dodge roll |
| E | draw / sheathe the katana |
| Left click | slash combo |
| Right click | dash slash |
| Mouse, wheel | look, zoom (click to capture the mouse) |
| M | music on / off |
| R | rise again after defeat |
| F1 | show the controls in game |

## Run it

```bash
cd game
npm install
npm run dev        # http://127.0.0.1:5299
npm run build      # static build in game/dist
```

Every push to `main` builds the game and deploys it to GitHub Pages (`.github/workflows/pages.yml`).

## Layout

```
game/                 the game (Vite project)
  src/                main.js (loop, post-processing, UI), player, monster, camera, spring cloth, sfx, music
  src/world2/         open world: layout, terrain, vegetation, foliage, props, water, sky, shadows
  public/models/      ninja.glb, monster.glb, world2/*.glb (asset kits + LODs)
  public/tex/w2/      terrain / bark / stone textures, grass and flower cards, sky
  scripts/            headless (puppeteer) screenshot and test tools for development
scripts/              Blender pipelines that produce the assets above
build_ha.sh           rigged base character (Tripo export) -> rig + skin weights
build_sg.sh           segmented character model on that rig + cloth chains -> game/public/models/ninja.glb
build_monster.sh      monster FBX -> game/public/models/monster.glb
```

The asset pipelines run in headless Blender 5.2, with numpy and scipy installed in a local `.venv`. The source models
(Tripo exports) and animation packs (Universal Animation Library, Ready Player Me) are not part of this repository. Only
the built game assets are committed.
