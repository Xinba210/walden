import * as THREE from 'three';

/**
 * Surface materials for the Blender assets of the ruined valley. The assets carry a baked RGBA vertex colour `Col`:
 *   R = ambient occlusion, G = overlay mask (moss on stone, grass on cliff tops, snow on mountains), B = edge wear.
 * Base and overlay are the generated, tileable textures (public/tex/w2), mapped by the assets' world-scale UVs.
 */
const loader = new THREE.TextureLoader();
const texCache = {};
export function tex(name, srgb = true, repeat = 1) {
  const key = `${name}|${repeat}`;
  if (texCache[key]) return texCache[key];
  const t = loader.load(`tex/w2/${name}.jpg`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return (texCache[key] = t);
}

const KINDS = {
  //            base texture        overlay        overlay tint  base tint   repeat  overlay rep  wear  normal
  stone:     { base: 'stone_weathered', over: 'moss', overTint: '#c8d8a0', tint: '#e8e2da', rep: 1, overRep: 2, wear: 0.25, nScale: 1.0 },
  masonry:   { base: 'masonry', over: 'moss', overTint: '#c8d8a0', tint: '#e6e0d6', rep: 1, overRep: 2, wear: 0.2, nScale: 1.0 },
  // cliffs: world-space triplanar strata (~8 m per texture repeat), cool grey, grass on the tops from the G mask
  rock:      { base: 'cliff_rock', over: 'meadow', overTint: '#ffffff', tint: '#b8b8c0', rep: 1, overRep: 3, wear: 0.0, nScale: 1.2, triplanar: 8 },
  // mountains: dark blue-grey rock at a large scale, snow on up-facing slopes + the baked snow mask, extra haze
  mountain:  { base: 'cliff_rock', over: null, overTint: '#f4f6ff', tint: '#8890a8', rep: 3, overRep: 1, wear: 0.0, nScale: 0.5, snow: true, haze: 0.45 },
  bark:      { base: 'bark', over: null, overTint: '#6b7350', tint: '#c8bcb4', rep: 1, overRep: 1, wear: 0.0, nScale: 1.2 },
};

const matCache = {};
/** a MeshStandardMaterial for one of the asset surface kinds (stone, masonry, rock, mountain, bark) */
export function surfaceMaterial(kind) {
  if (matCache[kind]) return matCache[kind];
  const K = KINDS[kind];
  const m = new THREE.MeshStandardMaterial({
    map: tex(K.base, true, K.rep), normalMap: tex(`${K.base}_n`, false, K.rep), roughness: 0.92, metalness: 0,
    color: new THREE.Color(K.tint), vertexColors: true,
  });
  m.normalScale.set(K.nScale, K.nScale);
  const over = K.over ? tex(K.over, true, K.overRep) : null;
  const tri = K.triplanar ?? 0;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTri = { value: tri ? 1 / tri : 0 };
    sh.uniforms.uBase = { value: m.map };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSurfW; varying vec3 vSurfN;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec4 sw = vec4(transformed, 1.0);
          vec3 sn = objectNormal;
          #ifdef USE_INSTANCING
            sw = instanceMatrix * sw; sn = mat3(instanceMatrix) * sn;
          #endif
          vSurfW = (modelMatrix * sw).xyz;
          vSurfN = normalize(mat3(modelMatrix) * sn);
        }`);
    sh.uniforms.uOver = { value: over };
    sh.uniforms.uOverTint = { value: new THREE.Color(K.overTint) };
    sh.uniforms.uWear = { value: K.wear };
    sh.uniforms.uOverRep = { value: K.overRep / K.rep };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uOver; uniform vec3 uOverTint; uniform float uWear; uniform float uOverRep;
        uniform float uTri; uniform sampler2D uBase; varying vec3 vSurfW; varying vec3 vSurfN;`)
      // the vertex colour is a mask set, not a tint: do the blending ourselves
      .replace('#include <color_fragment>', '')
      .replace('#include <map_fragment>', `#include <map_fragment>
        ${tri ? `
        // world-space triplanar base (strata stay metres high whatever the asset UVs do)
        {
          vec3 bw = pow(abs(vSurfN), vec3(4.0)); bw /= dot(bw, vec3(1.0));
          vec3 tp = vSurfW * uTri;
          vec4 tx = texture2D(uBase, tp.zy) * bw.x + texture2D(uBase, tp.xz) * bw.y + texture2D(uBase, tp.xy) * bw.z;
          diffuseColor = vec4(diffuse, opacity) * tx;
        }` : ''}
        #ifdef USE_COLOR_ALPHA
          vec4 cm = vColor;
        #else
          vec4 cm = vec4(vColor, 1.0);
        #endif
        // baked AO, pushed harder into the crevices, plus cavity darkening from the texture's own dark cracks
        float ao = mix(0.26, 1.0, pow(clamp(cm.r, 0.0, 1.0), 1.4));
        ao *= mix(0.72, 1.0, smoothstep(0.04, 0.28, dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15))));
        float ov = smoothstep(0.25, 0.75, cm.g);
        ${K.snow ? `
        // snow: bright, slightly blue, a touch of the rock showing through on the edges of the mask
        // snow where the baked mask says so OR on up-facing slopes (noisy edge), over dark rock
        float upF = smoothstep(0.5, 0.72, vSurfN.y + (texture2D(uBase, vSurfW.xz * 0.004).r - 0.5) * 0.35);
        float sn = clamp(max(ov, upF * smoothstep(250.0, 650.0, vSurfW.y)), 0.0, 1.0);
        vec3 snow = vec3(0.93, 0.95, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb * 0.8, snow, sn);` : K.over ? `
        vec3 ovc = texture2D(uOver, vMapUv * uOverRep).rgb * uOverTint;
        diffuseColor.rgb = mix(diffuseColor.rgb, ovc, ov);` : ''}
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.35 + 0.04, uWear * clamp(cm.b, 0.0, 1.0));
        diffuseColor.rgb *= ao;`);
  };
  if (K.haze) {
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      prev(sh, r);
      sh.fragmentShader = sh.fragmentShader.replace('#include <fog_fragment>', `
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.70, 0.69, 0.85), ${K.haze.toFixed(2)});   // lavender aerial perspective
        #include <fog_fragment>`);
    };
  }
  m.customProgramCacheKey = () => `w2surf-${kind}`;
  return (matCache[kind] = m);
}
