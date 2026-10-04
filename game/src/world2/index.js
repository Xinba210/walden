import * as THREE from 'three';
import { heightAt, SPAWN, BOUNDS, WATER_Y, PATH } from './layout.js';
import { Sky2 } from './sky.js';
import { Terrain2 } from './terrain.js';
import { Vegetation2 } from './vegetation.js';
import { Water2 } from './water.js';
import { Props2 } from './props.js';
import { FOLIAGE_TIME } from './foliage.js';

/**
 * The ruined valley open world (after the reference painting): flower meadow with stone gates and a flagstone path,
 * a river from waterfalls at layered cliffs, an aqueduct, a castle on a cliff, a colonnade hill and snowy peaks.
 * Interface used by the game: ground, colliders, spawn, monsterHome, bounds, update, plus camera / grade settings.
 */
export class World2 {
  static async create(scene, renderer, gltfLoader, onStatus = () => {}) {
    const w = new World2();
    await w.build(scene, renderer, gltfLoader, onStatus);
    return w;
  }

  async build(scene, renderer, gltfLoader, onStatus) {
    const t0 = performance.now();
    onStatus('Painting the sky…');
    this.sky = new Sky2(scene, renderer);
    this.env = this.sky.env;
    onStatus('Raising the valley…');
    this.terrain = new Terrain2(scene, this.env);
    await this.terrain.ready;
    onStatus('Filling the river…');
    this.water = new Water2(scene, this.env);
    onStatus('Placing the ruins…');
    this.props = await Props2.create(scene, gltfLoader, this.env, this.water);
    onStatus('Growing the flower fields…');
    this.vegetation = new Vegetation2(scene, this.env, this.terrain);
    await this.vegetation.ready;
    await this.sky.ready;
    // the player wades through the river rather than sinking to its bed
    const h = this.terrain.heightAt ? (x, z) => this.terrain.heightAt(x, z) : heightAt;
    this.ground = (x, z) => Math.max(h(x, z), WATER_Y - 0.35);
    this.colliders = this.props.colliders;
    this.bounds = BOUNDS;
    this.spawn = SPAWN.clone();
    this.spawn.y = this.ground(this.spawn.x, this.spawn.z);
    this.spawnYaw = Math.PI;            // facing -Z, down the valley
    // training dummies: meadow behind the spawn, out of the view down the valley
    this.clearing = { x: 18, z: 92, r: 7 };
    // the forest monster roams a stretch of meadow next to the path, ahead of the spawn (in view down the valley)
    const mp = PATH.getPointAt(0.3);
    this.monsterHome = new THREE.Vector3(mp.x + 7, 0, mp.z);
    this.monsterHome.y = this.ground(this.monsterHome.x, this.monsterHome.z);
    this.camera = { near: 0.1, far: 9000 };
    // golden-hour cinematic grade (main.js grade pass): split toning, light grain, edge dispersion, sun shaft strength
    this.grade = {
      sat: 1.0, curve: 0.32, warm: 0.1, lift: [0.008, 0.012, 0.03], vignette: 0.8,
      shadowTint: [0.93, 0.97, 1.07], highTint: [1.05, 1.0, 0.93], grain: 0.016, rays: 0.55,
    };
    this.exposure = 1.0;
    console.log(`world2 built in ${(performance.now() - t0).toFixed(0)} ms`);
  }

  update(dt, t, focus, camPos) {
    this.sky.setFocus?.(focus);
    this.sky.update(t, camPos);
    FOLIAGE_TIME.value = t;
    this.terrain.update(camPos);
    this.water.update(t, camPos);
    this.vegetation.update(t, camPos);
    this.props.update?.(t, camPos);
  }
}
