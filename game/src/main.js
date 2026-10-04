import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Input } from './input.js';
import { ThirdPersonCamera } from './camera.js';
import { Animator } from './animator.js';
import { SpringCloth } from './spring.js';
import { ClothPush } from './clothPush.js';
import { Katana } from './sword.js';
import { Particles, SwordTrail, Effects } from './vfx.js';
import { Sfx } from './sfx.js';
import { Monster } from './monster.js';
import { Music } from './music.js';
import { CharacterMaskPass, markCharacter } from './charMask.js';
import { SunShaftsPass } from './sunShafts.js';
import { SAOPass } from './ssao.js';
import monsterMeta from './monsterMeta.json';
import { Player } from './player.js';
import { World2 } from './world2/index.js';

import metaNinja from './clipMeta.json';
const meta = metaNinja;

const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;      // (PCFSoft is gone in r18x: PCF = 5 hardware-PCF Vogel taps x shadow.radius)
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.15;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.05, 2000);
// soft fill from the camera so the character reads against the low sun. Kept weak: it lights the whole world from the
// viewer's side and flattens the sun / shade contrast (the characters get their own key light, LOOK.uKeyColor)
const fill = new THREE.DirectionalLight('#ffe8dc', 0.32);
fill.position.set(0.3, 0.6, 1);
camera.add(fill, fill.target);
fill.target.position.set(0, 0, -1);
scene.add(camera);
const composer = new EffectComposer(renderer);
// scene depth for the sun shafts (sky = far plane); both buffers, so it does not matter which one the scene lands in
composer.renderTarget1.depthTexture = new THREE.DepthTexture(1, 1);
composer.renderTarget2.depthTexture = new THREE.DepthTexture(1, 1);
composer.addPass(new RenderPass(scene, camera));
const charMask = new CharacterMaskPass(scene, camera);           // where the characters are (for the grade)
composer.addPass(charMask);
const shafts = new SunShaftsPass(camera, null);                   // quarter-res god rays, composited in the grade
composer.addPass(shafts);
// half-res depth-only ambient occlusion on the HDR scene colour (sky untouched, weak on the characters); after the
// shafts pass, which needs the scene target as read buffer (this pass swaps)
const sao = new SAOPass(camera, charMask.texture);
composer.addPass(sao);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.3, 0.4, 0.92);
composer.addPass(bloom);
composer.addPass(new OutputPass());
// SMAA on the tone-mapped, sRGB-encoded image (what its luma edge detection is tuned for), BEFORE the grade, so the
// per-pixel film grain is not smoothed away and the grade's character mask lookups stay aligned with crisp edges
const smaa = new SMAAPass();
composer.addPass(smaa);
// cinematic grade (display space, after tone mapping): sun shafts (screen blend), split toning (cool shadows, warm
// highlights), gentle contrast curve, vignette, very light film grain (after SMAA). The character mask
// keeps the player / monster crisp, saturated and lifted, with no shafts, tint or grain over them.
const GRADE = {
  sat: { value: 1.22 }, curve: { value: 0.45 }, warm: { value: 1.0 }, lift: { value: new THREE.Vector3(0.03, 0.01, 0.035) }, vig: { value: 0.8 },
  rays: { value: 0 }, rayColor: { value: new THREE.Color(1.0, 0.8, 0.55) }, shadowTint: { value: new THREE.Vector3(0.93, 0.97, 1.06) },
  highTint: { value: new THREE.Vector3(1.05, 1.0, 0.92) }, grain: { value: 0.018 }, time: { value: 0 },
};
shafts.uStrength = GRADE.rays;
const gradePass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null }, tChar: { value: charMask.texture }, tRays: { value: shafts.texture },
    uSat: GRADE.sat, uCurve: GRADE.curve, uWarm: GRADE.warm, uLift: GRADE.lift, uVig: GRADE.vig, uRays: GRADE.rays, uRayColor: GRADE.rayColor,
    uShadowTint: GRADE.shadowTint, uHighTint: GRADE.highTint, uGrain: GRADE.grain, uTime: GRADE.time,
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `varying vec2 vUv; uniform sampler2D tDiffuse; uniform sampler2D tChar; uniform sampler2D tRays;
    uniform float uSat, uCurve, uWarm, uVig, uRays, uGrain, uTime; uniform vec3 uLift, uRayColor, uShadowTint, uHighTint;
    void main(){
      vec2 dc = vUv - 0.5;
      vec4 c = texture2D(tDiffuse, vUv);
      float ch = clamp(texture2D(tChar, vUv).r * 1.6, 0.0, 1.0);    // 1 on the characters (soft edge)
      // sun shafts: screen blend of the quarter-res radial blur, warm, kept off the characters
      if (uRays > 0.001) {
        vec3 r = texture2D(tRays, vUv).rgb * uRayColor * uRays * (1.0 - 0.85 * ch);
        c.rgb = 1.0 - (1.0 - c.rgb) * (1.0 - clamp(r, 0.0, 1.0));
      }
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      vec3 g = c.rgb + uLift * (1.0 - smoothstep(0.0, 0.3, l)) * (1.0 - ch);
      // world: a little less saturated and softer, so the dark characters separate from the red / green meadow;
      // characters: full saturation, stronger contrast and a lift of their dark values (no glow, no rim)
      g = mix(vec3(l), g, uSat * mix(0.9, 1.08, ch));
      float curve = uCurve * mix(1.0, 1.5, ch);
      g = mix(g, g * g * (3.0 - 2.0 * g), curve);
      g = mix(g, pow(max(g, 0.0), vec3(0.74)) * 1.05, ch);          // lift the characters' dark values
      // split toning on the world: cool blue-lavender shadows, warm golden highlights
      vec3 split = mix(uShadowTint, vec3(1.0), smoothstep(0.05, 0.5, l));
      split = mix(split, uHighTint, smoothstep(0.5, 0.95, l));
      g = mix(g, g * split, 1.0 - ch);
      g = mix(g, g * mix(vec3(1.0), vec3(1.08, 0.98, 0.9), uWarm), smoothstep(0.45, 1.0, l));
      float v = smoothstep(1.2, 0.4, length(dc) * 1.35);
      g *= mix(uVig, 1.0, v);
      // film grain: hashed per pixel and frame, strongest in the mid-tones, none on the characters
      vec2 q = fract(gl_FragCoord.xy * vec2(0.1031, 0.1030) + uTime);
      q += dot(q, q.yx + 33.33);
      float n = fract((q.x + q.y) * q.x) - 0.5;
      g += n * uGrain * (1.0 - ch) * (1.0 - abs(l - 0.45) * 1.2);
      gl_FragColor = vec4(g, c.a); }`,
});
composer.addPass(gradePass);

/**
 * Character look: the strong lavender sky ambient washed the dark-navy outfit out. For the character's materials:
 * saturation lift on the albedo, the sky ambient is partly neutralised and reduced, a warm key light from camera-left/above
 * gives the face, leather and cloth folds real light/shadow, matte cloth response (no rim light, no specular: the normal-mapped cloth lit up in blue glints).
 */
const LOOK = {
  uKeyView: { value: new THREE.Vector3(-0.55, 0.6, 0.6).normalize() }, uKeyColor: { value: new THREE.Color('#ffe8d8').multiplyScalar(2.1) },
  uSat: { value: 1.05 }, uAmbient: { value: 0.8 }, uGamma: { value: 1.0 },
};
function characterLook(model) {
  model.traverse((o) => {
    if (!o.isMesh || /Katana/.test(o.name)) return;
    for (const m of [o.material].flat()) {
      if (/Katana/.test(m.name)) continue;
      const lining = /Coat/.test(m.name);      // rebuilt coat panels: one sheet, its inside reads as shadowed lining
      m.roughness = 1.0;
      m.metalness = 0;
      m.side = THREE.DoubleSide;          // Tripo's parts mesh has some inward-facing panels (pant legs): render both sides
      m.shadowSide = THREE.DoubleSide;
      if (m.normalMap) m.normalScale.multiplyScalar(0.35);   // keep the fold detail, lose the crinkly glints
      m.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, LOOK);
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 uKeyView; uniform vec3 uKeyColor; uniform float uSat; uniform float uAmbient; uniform float uGamma;')
          .replace('#include <map_fragment>', `#include <map_fragment>
            ${lining ? 'if (!gl_FrontFacing) diffuseColor.rgb *= 0.5;' : ''}
            diffuseColor.rgb = pow(diffuseColor.rgb, vec3(uGamma)) * (1.0 + (uGamma - 1.0) * 0.6);   // deepen mid-tones
            float lumA = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
            diffuseColor.rgb = max(mix(vec3(lumA), diffuseColor.rgb, uSat), 0.0);`)
          .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
            float lumI = dot(reflectedLight.indirectDiffuse, vec3(0.299, 0.587, 0.114));
            reflectedLight.indirectDiffuse = mix(vec3(lumI), reflectedLight.indirectDiffuse, 0.35) * uAmbient;
            reflectedLight.directSpecular *= 0.0;           // fully matte: no sheen on cloth or leather
            reflectedLight.indirectSpecular *= 0.0;
            float key = max(dot(normal, uKeyView), 0.0);
            key = smoothstep(0.0, 1.0, key);
            reflectedLight.directDiffuse += BRDF_Lambert(diffuseColor.rgb) * uKeyColor * key;`);
      };
      m.customProgramCacheKey = () => (lining ? 'ninja-look-lining' : 'ninja-look');
      m.needsUpdate = true;
    }
  });
}

const input = new Input(renderer.domElement);
const tpc = new ThirdPersonCamera(camera);
const particles = new Particles(scene);
const dustParticles = new Particles(scene, 1500, { normal: true });
const fx = new Effects(scene);
const trail = new SwordTrail(scene);
const sfx = new Sfx();

const overlay = document.getElementById('overlay');
const loadingText = document.getElementById('loading');
const bar = document.querySelector('#progress div');
const stateEl = document.getElementById('state');
let showDebug = false;
let clothPush = null;
let player = null, cloth = null, katana = null, animator = null, world = null, monster = null;

const manager = new THREE.LoadingManager();
manager.onProgress = (_u, loaded, total) => { bar.style.width = `${(loaded / total) * 100}%`; };
const loader = new GLTFLoader(manager);
const status = (t) => { loadingText.textContent = t; };
const monsterGltf = loader.loadAsync('models/monster.glb');
loader.loadAsync('models/ninja.glb').then((ninja) => {
  status('Growing the meadow…');
  return new Promise((r) => setTimeout(() => r(ninja), 30));
}).then(async (gltf) => {
  world = await World2.create(scene, renderer, loader, status);
  if (world.camera) { camera.near = world.camera.near; camera.far = world.camera.far; camera.updateProjectionMatrix(); }
  if (world.exposure) renderer.toneMappingExposure = world.exposure;
  if (world.grade) {
    const G = world.grade;
    GRADE.sat.value = G.sat; GRADE.curve.value = G.curve; GRADE.warm.value = G.warm; GRADE.lift.value.set(...G.lift); GRADE.vig.value = G.vignette;
    if (G.shadowTint) GRADE.shadowTint.value.set(...G.shadowTint);
    if (G.highTint) GRADE.highTint.value.set(...G.highTint);
    if (G.grain != null) GRADE.grain.value = G.grain;
    if (G.rays != null) shafts.maxStrength = G.rays;
  }
  shafts.sunDir = world.env?.sunDir ?? null;
  // the forest monster (replaces the training dummies): roams ahead, hunts the player when she comes close
  const home = world.monsterHome.clone();
  home.y = world.ground(home.x, home.z);
  monster = new Monster(scene, await monsterGltf, monsterMeta, { home, roamRadius: 12, ground: world.ground });
  markCharacter(monster.object);
  monster.sfx = sfx;
  const model = gltf.scene;
  const root = new THREE.Group();
  root.add(model);
  scene.add(root);
  let katanaNode = null;
  model.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; if (o.material?.map) o.material.map.anisotropy = 8; }
    if (o.name === 'Katana') katanaNode = o;
  });
  characterLook(model);
  markCharacter(model);                                        // player + katana (the katana is in the model)
  animator = new Animator(model, gltf.animations);
  katana = new Katana(katanaNode, 'mixamorigRightHand');
  clothPush = new ClothPush(model, meta.cloth.colliders);   // per-vertex coat-vs-leg collision (+ trouser distance fields)
  if (meta.cloth.panels) clothPush.enabled = false;           // panel rigs: whole pieces bend, no per-vertex pulling
  cloth = new SpringCloth(model, meta.cloth, 1);              // coat / scarf / hanging pieces: spring-bone chains
  player = new Player({
    object: root, animator, katana, meta, cloth, fx, particles, dustParticles, trail, sfx, cam: tpc, dummies: monster,
    colliders: () => world.colliders.concat(monster.colliders), ground: world.ground, bounds: world.bounds,
  });
  player.pos.copy(world.spawn);
  player.yaw = Math.PI - 0.08;
  tpc.yaw = player.yaw + Math.PI;
  animator.update(0);
  root.position.copy(player.pos); root.rotation.y = player.yaw;
  root.updateMatrixWorld(true);
  cloth.reset();
  player.respawn = respawn;
  // shader warm-up: compile every program the fight will need now (one of each effect at the player, monster hit
  // pose), using the driver's parallel compile, so the first attack doesn't stall on a synchronous compile
  status('Preparing effects…');
  {
    const at = player.pos.clone().setY(player.pos.y + 1.2), fwd = player.forward();
    fx.slashWave(at, fwd); fx.flash(at, camera); fx.ring(at);
    particles.burst(at, 4); dustParticles.burst(at, 4);
    trail.push(at, at.clone().add(fwd), 0, 1);
    for (const m of katana.meshes) m.visible = true;                     // hidden until summoned: compile it too
    // compile for the composer's render target (linear, no tone mapping) - that's what the game actually renders
    // into; compiling for the canvas would produce different programs and everything would compile again later
    renderer.setRenderTarget(composer.readBuffer);
    try { await renderer.compileAsync(scene, camera); } catch { renderer.compile(scene, camera); }
    renderer.setRenderTarget(null);
    shafts.force = true;                                              // compile the sun-shaft passes now, not when the sun first shows
    composer.render();
    shafts.force = false;
    for (const m of katana.meshes) m.visible = false;
    fx.update(10); particles.update(10); dustParticles.update(10); trail.clear();
  }
  loadingText.textContent = 'Click to play';
  bar.parentElement.style.display = 'none';
  window.__game = { post: { sao, smaa, shafts, bloom }, LOOK, clothPush, player, animator, katana, cloth, tpc, scene, camera, input, renderer, world, monster, dummies: monster };
}).catch((err) => { loadingText.textContent = `Failed to load: ${err.message ?? err}`; console.error(err); });

overlay.addEventListener('click', () => {
  if (!player) return;
  overlay.classList.add('hidden');
  ui.hint.classList.add('on');
  setTimeout(() => ui.hint.classList.remove('on'), 7000);
  sfx.start();
  sfx.startMusic(Music);
  input.requestLock();
});
renderer.domElement.addEventListener('click', () => input.requestLock());
addEventListener('keydown', (e) => { if (e.code === 'KeyM') sfx.music?.toggle(); if (e.code === 'KeyH') { showDebug = !showDebug; stateEl.textContent = ''; } });
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight);
});

const timer = new THREE.Timer();
timer.connect(document);
let time = 0;
const focus = new THREE.Vector3();

function simulate(raw) {
  let dt = raw;
  if (player) {
    if (player.hitstop > 0) { player.hitstop -= raw; dt = raw * 0.05; }
    time += dt;
    player.update(dt, input);
    animator.update(dt);
    player.object.updateMatrixWorld(true);
    player.procedural(dt);
    player.object.updateMatrixWorld(true);
    cloth.update(dt);
    clothPush.update();
    const { completed } = katana.update(dt, time);
    if (completed) player.onSwordComplete();
    player.updateDismissFx();
    player.postAnimate(dt);
    monster.update(dt, player);
    healthBars(dt);
    focus.copy(player.pos).add(new THREE.Vector3(0, 1.35, 0));
    const fovKick = player.state === 'attack' && player.atk.def.dash ? 7 : player.speed > player.gaits.run.speed * 1.08 ? 5 : player.state === 'roll' ? 4 : 0;
    tpc.update(raw, input, focus, { fovKick, playerYaw: player.yaw, ground: world.ground });
    world.update(dt, time, player.pos, camera.position);
    if (showDebug) stateEl.textContent = player.debug();
  }
  particles.update(dt);
  dustParticles.update(dt);
  fx.update(dt);
  input.endFrame();
}

/**
 * In-game UI: player health top-left; the monster's bar bottom-centre (boss style) only while it is engaged / near,
 * fading out after it dies or loses interest; both with a pale delayed "damage taken" trail. Death screen; F1 help.
 */
const ui = {
  pFill: document.querySelector('#hud-player i'), pTrail: document.querySelector('#hud-player s'),
  boss: document.getElementById('boss'), mFill: document.querySelector('#boss i'), mTrail: document.querySelector('#boss s'),
  defeat: document.getElementById('defeat'), help: document.getElementById('help'), hint: document.getElementById('hint'),
};
const uiTrail = { p: 1, m: 1, pHold: 0, mHold: 0, bossT: 0 };
function healthBars(dt = 1 / 60) {
  const p = player.hp / player.maxHp, m = monster.hp / monster.maxHp;
  // trail: holds briefly after a hit, then drains towards the fill
  for (const [k, v] of [['p', p], ['m', m]]) {
    if (v < (uiTrail[`${k}Last`] ?? v) - 1e-4) uiTrail[`${k}Hold`] = 0.6;     // fresh damage: hold the trail a moment
    uiTrail[`${k}Last`] = v;
    if (uiTrail[`${k}Hold`] > 0) uiTrail[`${k}Hold`] -= dt;
    else uiTrail[k] += (v - uiTrail[k]) * Math.min(1, dt * 2.5);
    if (v > uiTrail[k]) uiTrail[k] = v;
  }
  ui.pFill.style.transform = `scaleX(${p})`;
  ui.pTrail.style.transform = `scaleX(${uiTrail.p})`;
  ui.mFill.style.transform = `scaleX(${m})`;
  ui.mTrail.style.transform = `scaleX(${uiTrail.m})`;
  // boss bar: shown while engaged or close; lingers 3 s after death / disengage
  const d = Math.hypot(player.pos.x - monster.object.position.x, player.pos.z - monster.object.position.z);
  const engaged = monster.alive && (monster.state !== 'roam' || d < 18);
  uiTrail.bossT = engaged ? 3 : uiTrail.bossT - dt;
  ui.boss.classList.toggle('on', uiTrail.bossT > 0 && !monster.gone);
  ui.defeat.classList.toggle('on', !player.alive);
}
// F1: controls; a quiet hint for the first seconds of play
addEventListener('keydown', (e) => {
  if (e.code === 'F1') { e.preventDefault(); ui.help.classList.toggle('on'); ui.hint.classList.remove('on'); }
});
const respawn = () => {
  player.hp = player.maxHp; player.alive = true; player.state = 'move'; player.knock = null; player.invuln = 1.5;
  player.pos.copy(world.spawn); player.yaw = Math.PI - 0.08;
  animator.play('Idle', { fade: 0.2, restart: true });
  if (!monster.alive || monster.state === 'chase') monster.revive();
  cloth.reset();
  tpc.viewYaw = null;   // snap the eased camera back behind the player
};

let paused = false;
window.__step = {
  pause(v) { paused = v; },
  /** render one frame from an arbitrary camera (tools / critics): world updates for that camera, no simulation */
  view({ pos, look, fov }) {
    paused = true;
    if (fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    camera.position.set(...pos);
    camera.lookAt(...look);
    camera.updateMatrixWorld();
    world.update(0, performance.now() / 1000, new THREE.Vector3(pos[0], world.ground(pos[0], pos[2]), pos[2]), camera.position);
    composer.render();
  },
  step(seconds, fps = 60, render = true) { const n = Math.round(seconds * fps); for (let i = 0; i < n; i++) simulate(1 / fps); if (render) composer.render(); },
};
/** a frame that throws must not stop the loop (that reads as a frozen game): show the error once, keep running */
let lastErr = '';
function reportError(err) {
  const msg = `${err?.message ?? err}`;
  if (msg === lastErr) return;
  lastErr = msg;
  console.error(err);
  let el = document.getElementById('errbox');
  if (!el) {
    el = document.createElement('div');
    el.id = 'errbox';
    el.style.cssText = 'position:fixed;left:12px;bottom:12px;max-width:60vw;padding:8px 12px;background:#300a;color:#fcc;font:12px monospace;border:1px solid #f668;border-radius:6px;z-index:20;white-space:pre-wrap';
    document.body.appendChild(el);
  }
  el.textContent = `error (game kept running): ${msg}\n${(err?.stack ?? '').split('\n').slice(1, 3).join('\n')}`;
}
function frame() {
  requestAnimationFrame(frame);
  timer.update();
  const raw = Math.min(timer.getDelta(), 1 / 20);
  if (paused) return;
  GRADE.time.value = (GRADE.time.value + 0.6180339) % 1;
  try { simulate(raw); composer.render(); } catch (err) { reportError(err); }
}
frame();
