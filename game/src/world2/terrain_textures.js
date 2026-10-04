import * as THREE from 'three';

/**
 * Decode a set of same-size images into one DataArrayTexture (one layer each) with mipmaps and anisotropy.
 * Rows are flipped on decode so v = 0 is the bottom of the image (three's flipY convention, OpenGL normal maps).
 * JPG only (no alpha), so the canvas premultiplication does not matter.
 */
export async function loadTextureArray(urls, srgb, size = 1024) {
  const layers = await Promise.all(urls.map(async (url) => {
    const blob = await (await fetch(url)).blob();
    return createImageBitmap(blob, { imageOrientation: 'flipY', resizeWidth: size, resizeHeight: size, resizeQuality: 'high' });
  }));
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = new Uint8Array(size * size * 4 * layers.length);
  layers.forEach((bmp, i) => {
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(bmp, 0, 0, size, size);
    data.set(ctx.getImageData(0, 0, size, size).data, i * size * size * 4);
    bmp.close?.();
  });
  const tex = new THREE.DataArrayTexture(data, size, size, layers.length);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
