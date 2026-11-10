import * as THREE from './vendor/three.module.js';
import { createBuilding, createTree } from './voxels.js?v=20261110-traffic2';

// The editor and city use this same factory. All dimensions are city tiles;
// floors change real geometry, and every accessory stays inside the plot.
const CUBE = new THREE.BoxGeometry(1, 1, 1);
const MATERIALS = new Map();
const STYLES = {
  modern: { trim: '#d5d7ce', accent: '#46565a', roof: '#5a6160', glass: '#69828a' },
  european: { trim: '#d4cbb7', accent: '#8d7765', roof: '#8c5843', glass: '#60777d' },
  chinese: { trim: '#d2bd8c', accent: '#7c3630', roof: '#5b6261', glass: '#567575' },
  japanese: { trim: '#cfbf9d', accent: '#5d4938', roof: '#505756', glass: '#768583' },
  nordic: { trim: '#dedbd0', accent: '#7c614b', roof: '#465052', glass: '#71888a' },
  industrial: { trim: '#8e8c7d', accent: '#464e4f', roof: '#686d6a', glass: '#6e8687' },
  future: { trim: '#d3dcda', accent: '#507a80', roof: '#6d8386', glass: '#71a4ad' },
};
const KNOWN = new Set([
  'villa', 'townhouse', 'apartment', 'tower', 'manor',
  'shop', 'supermarket', 'mall', 'office', 'hotel', 'market',
  'communityPark', 'centralPark', 'botanical',
  'school', 'hospital', 'fire', 'police', 'library', 'stadium',
]);
let lighting = { night: 0, wetness: 0 };

const micrograin = (() => {
  const bytes = new Uint8Array(32 * 32 * 4);
  let seed = 5171;
  for (let i = 0; i < bytes.length; i += 4) {
    seed = Math.imul(seed ^ seed >>> 16, 1103515245) + 12345 | 0;
    bytes[i] = bytes[i + 1] = bytes[i + 2] = 208 + ((seed >>> 24) % 48);
    bytes[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(bytes, 32, 32, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 3);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
})();

function lightMaterial(material) {
  const data = material.userData;
  const wetResponse = ['masonry', 'wood', 'roof'].includes(data.surface) ? 0.48 : 0.16;
  material.roughness = Math.max(0.08, data.baseRoughness - lighting.wetness * wetResponse);
  material.emissiveIntensity = data.baseEmissive + lighting.night * data.nightEmissive;
  if (material.isMeshPhysicalMaterial) {
    material.clearcoat = data.surface === 'glass' || data.surface === 'water' ? 0.8 : 0.2 + lighting.wetness * 0.5;
    material.clearcoatRoughness = 0.13 - lighting.wetness * 0.06;
  }
}

export function setDesignerLighting({ night = lighting.night, wetness = lighting.wetness } = {}) {
  lighting = {
    night: THREE.MathUtils.clamp(Number.isFinite(night) ? night : 0, 0, 1),
    wetness: THREE.MathUtils.clamp(Number.isFinite(wetness) ? wetness : 0, 0, 1),
  };
  for (const material of MATERIALS.values()) lightMaterial(material);
}

// City batches and the studio share these materials. Release only entries no
// longer referenced by either scene; the shared grain texture stays alive.
export function disposeUnusedDesignerMaterials(roots) {
  const used = new Set();
  for (const root of roots) root?.traverse(object => {
    if (Array.isArray(object.material)) object.material.forEach(m => used.add(m));
    else if (object.material) used.add(object.material);
  });
  let removed = 0;
  for (const [key, material] of MATERIALS) if (!used.has(material)) {
    material.dispose(); MATERIALS.delete(key); removed++;
  }
  return removed;
}

function material(color, surface = 'masonry', glow = 0) {
  const key = `${color}/${surface}/${glow}`;
  if (!MATERIALS.has(key)) {
    const physical = ['glass', 'water', 'metal', 'paint'].includes(surface);
    const Material = physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
    const roughness = { masonry: 0.9, wood: 0.85, roof: 0.86, ground: 0.96, glass: 0.15, water: 0.1, metal: 0.4, paint: 0.4, lamp: 0.3 }[surface] ?? 0.9;
    const m = new Material({
      color, roughness, metalness: surface === 'metal' ? 0.65 : 0,
      flatShading: true, envMapIntensity: surface === 'glass' ? 1.6 : surface === 'water' ? 1.45 : 0.95,
      emissive: surface === 'glass' && glow ? '#ffc27d' : surface === 'lamp' ? color : '#000000',
      emissiveIntensity: 0,
    });
    if (physical) { m.ior = 1.5; m.clearcoat = 0.8; m.clearcoatRoughness = 0.13; }
    if (['masonry', 'wood', 'roof', 'ground'].includes(surface)) {
      m.roughnessMap = micrograin;
      m.bumpMap = micrograin;
      m.bumpScale = surface === 'ground' ? 0.0018 : 0.001;
    }
    m.name = `designer-${surface}-${color}-${glow}`;
    m.userData = {
      surface, baseRoughness: roughness,
      baseEmissive: surface === 'lamp' ? 0.05 : 0,
      nightEmissive: surface === 'glass' ? glow * 0.58 : surface === 'lamp' ? 1.5 : 0,
    };
    lightMaterial(m);
    MATERIALS.set(key, m);
  }
  return MATERIALS.get(key);
}

function box(group, color, x, y, z, w, h, d, surface = 'masonry', glow = 0) {
  if (w <= 0 || h <= 0 || d <= 0) return null;
  const mesh = new THREE.Mesh(CUBE, material(color, surface, glow));
  mesh.position.set(x, y, z);
  mesh.scale.set(w, h, d);
  mesh.castShadow = surface !== 'water';
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function batch(group) {
  for (const child of group.children) if (child.isGroup) batch(child);
  const batches = new Map();
  for (const child of group.children) {
    if (!child.isMesh || child.geometry !== CUBE || child.isInstancedMesh) continue;
    const meshes = batches.get(child.material) || [];
    meshes.push(child);
    batches.set(child.material, meshes);
  }
  for (const [mat, meshes] of batches) {
    if (meshes.length < 2) continue;
    const instances = new THREE.InstancedMesh(CUBE, mat, meshes.length);
    instances.castShadow = meshes[0].castShadow;
    instances.receiveShadow = true;
    for (let i = 0; i < meshes.length; i++) {
      meshes[i].updateMatrix();
      instances.setMatrixAt(i, meshes[i].matrix);
      group.remove(meshes[i]);
    }
    instances.instanceMatrix.needsUpdate = true;
    instances.computeBoundingSphere();
    group.add(instances);
  }
  return group;
}

function cleanDesign(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  const components = {};
  for (const name of ['garden', 'wall', 'garage', 'pool', 'terrace', 'solar']) components[name] = Boolean(input.components?.[name]);
  const integer = (value, fallback, max) => Math.min(max, Math.max(1, Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback));
  return {
    catalogId: typeof input.catalogId === 'string' ? ({ resvilla: 'villa', commshop: 'shop' }[input.catalogId] || input.catalogId) : 'villa',
    style: Object.hasOwn(STYLES,input.style) ? input.style : 'modern',
    color: typeof input.color === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(input.color) ? input.color : '#b8b4a6',
    roof: ['flat', 'pitched', 'garden'].includes(input.roof) ? input.roof : 'flat',
    floors: integer(input.floors, 1, 12), width: integer(input.width, 1, 3), depth: integer(input.depth, 1, 3),
    rotation: ((Number.isFinite(Number(input.rotation)) ? Math.round(Number(input.rotation)) : 0) % 4 + 4) % 4,
    components,
  };
}

function tree(group, x, z, size, variant, base = 0.06) {
  const object = createTree(variant);
  object.position.set(x, base, z);
  object.scale.setScalar(size);
  group.add(object);
}

function windowGlow(floor, column, variant) {
  const value = Math.abs((floor * 7 + column * 13 + variant * 19) % 9);
  return value === 1 || value === 4 ? 1 : value === 7 ? 0.55 : 0;
}

// All four facades are built from the same dimensions as the wall volume.
function facade(group, design, s, x, z, w, d, base, floors, floorH, variant, options = {}) {
  const cols = Math.max(2, Math.floor(w / (options.glazed ? 0.16 : 0.22)));
  const sideCols = Math.max(2, Math.floor(d / 0.22));
  const wy = floorH * (options.glazed ? 0.71 : 0.5);
  for (let floor = 0; floor < floors; floor++) {
    const cy = base + floorH * (floor + 0.54);
    for (let column = 0; column < cols; column++) {
      const cx = x - w / 2 + w * (column + 0.5) / cols;
      const ww = w / cols * (options.glazed ? 0.88 : 0.55);
      for (const direction of [-1, 1]) {
        const wz = z + direction * (d / 2 + 0.005);
        box(group, s.glass, cx, cy, wz, ww, wy, 0.012, 'glass', windowGlow(floor, column + direction, variant));
        if (['european', 'nordic'].includes(design.style)) {
          box(group, s.trim, cx, cy - wy / 2 - 0.008, wz + direction * 0.008, ww + 0.024, 0.018, 0.028);
          box(group, s.trim, cx, cy, wz + direction * 0.008, 0.012, wy + 0.008, 0.015);
        } else if (['chinese', 'japanese'].includes(design.style)) {
          box(group, s.accent, cx, cy, wz + direction * 0.009, 0.013, wy, 0.014, 'wood');
          box(group, s.accent, cx, cy + wy * 0.13, wz + direction * 0.009, ww, 0.012, 0.014, 'wood');
        }
      }
    }
    for (let column = 0; column < sideCols; column++) {
      const wz = z - d / 2 + d * (column + 0.5) / sideCols;
      for (const direction of [-1, 1]) {
        box(group, s.glass, x + direction * (w / 2 + 0.005), cy, wz, 0.012, wy, d / sideCols * 0.57, 'glass', windowGlow(floor + 1, column, variant));
      }
    }
    if (floor > 0 && ['modern', 'european', 'future'].includes(design.style)) {
      box(group, s.trim, x, base + floor * floorH, z, w + 0.024, 0.023, d + 0.024);
    }
    if (floor > 0 && (options.balconies || design.catalogId === 'hotel')) {
      const balconyW = w * 0.84;
      box(group, s.trim, x, base + floor * floorH + 0.01, z + d / 2 + 0.035, balconyW, 0.022, 0.09);
      box(group, s.accent, x, base + floor * floorH + 0.065, z + d / 2 + 0.073, balconyW, 0.018, 0.012, 'metal');
      for (const bx of [-0.42, -0.14, 0.14, 0.42]) box(group, s.accent, x + balconyW * bx, base + floor * floorH + 0.042, z + d / 2 + 0.073, 0.012, 0.06, 0.012, 'metal');
    }
  }
  if (['japanese', 'nordic', 'industrial'].includes(design.style)) {
    const ribCount = design.style === 'nordic' ? Math.max(5, Math.floor(w / 0.11)) : 4;
    for (let i = 0; i < ribCount; i++) {
      const rx = x - w * 0.48 + w * 0.96 * i / (ribCount - 1);
      box(group, s.accent, rx, base + floors * floorH / 2, z + d / 2 + 0.013, design.style === 'nordic' ? 0.014 : 0.024, floors * floorH, 0.025, design.style === 'industrial' ? 'metal' : 'wood');
    }
  }
  if (design.style === 'chinese') {
    for (const dx of [-0.46, 0.46]) for (const dz of [-0.46, 0.46]) box(group, s.accent, x + w * dx, base + floors * floorH / 2, z + d * dz, 0.032, floors * floorH, 0.032, 'wood');
  }
  if (design.style === 'future') {
    for (const dx of [-0.48, 0.48]) {
      box(group, s.trim, x + w * dx, base + floors * floorH / 2, z + d / 2 + 0.018, 0.045, floors * floorH + 0.04, 0.048);
      box(group, '#72c6cc', x + w * dx, base + floors * floorH / 2, z + d / 2 + 0.045, 0.01, floors * floorH * 0.9, 0.01, 'lamp');
    }
  }
}

function roof(group, design, s, x, z, w, d, y, variant) {
  const overhang = Math.min(0.07, Math.min(w, d) * 0.12);
  if (design.roof === 'pitched') {
    const steep = design.style === 'nordic' ? 0.39 : design.style === 'european' ? 0.3 : 0.23;
    const rh = Math.min(0.42, Math.max(0.14, Math.min(w, d) * steep));
    if (design.style === 'industrial') {
      const toothWidth = w / 3;
      for (let tooth = 0; tooth < 3; tooth++) {
        for (let step = 0; step < 4; step++) box(group, s.roof, x - w / 2 + toothWidth * (tooth + 0.5), y + rh * (step + 0.5) / 4, z + d * step / 16, toothWidth + 0.012, rh / 4 + 0.004, d * (1 - step * 0.22), 'roof');
        box(group, s.glass, x - w / 2 + toothWidth * (tooth + 0.5), y + rh * 0.55, z - d * 0.22, toothWidth * 0.8, rh * 0.65, 0.015, 'glass');
      }
    } else {
      for (let step = 0; step < 6; step++) {
        box(group, s.roof, x, y + rh * (step + 0.5) / 6, z, w + overhang * 2, rh / 6 + 0.005, (d + overhang * 2) * (1 - step * 0.145), 'roof');
      }
      if (['chinese', 'japanese'].includes(design.style)) {
        const edgeH = design.style === 'chinese' ? 0.058 : 0.025;
        for (const direction of [-1, 1]) {
          box(group, s.roof, x, y + 0.024, z + direction * (d / 2 + overhang), w + overhang * 2, 0.03, 0.06, 'roof');
          for (const side of [-1, 1]) box(group, s.roof, x + side * (w / 2 + overhang * 0.55), y + edgeH, z + direction * (d / 2 + overhang * 0.85), 0.075, 0.048, 0.075, 'roof');
        }
        box(group, s.accent, x, y + rh + 0.012, z, w + overhang * 1.3, 0.027, 0.04, 'wood');
      }
      if (design.style === 'european') {
        box(group, design.color, x - w * 0.27, y + rh * 0.48, z + d * 0.26, w * 0.18, rh * 0.62, d * 0.18);
        box(group, s.glass, x - w * 0.27, y + rh * 0.49, z + d * 0.35 + 0.006, w * 0.11, rh * 0.35, 0.014, 'glass', 0.55);
      }
    }
    return y + rh;
  }
  box(group, s.roof, x, y + 0.025, z, w + overhang, 0.05, d + overhang, 'roof');
  for (const direction of [-1, 1]) {
    box(group, s.trim, x, y + 0.072, z + direction * d / 2, w + overhang, 0.08, 0.035);
    box(group, s.trim, x + direction * w / 2, y + 0.072, z, 0.035, 0.08, d);
  }
  if (design.roof === 'garden') {
    box(group, '#687d4c', x, y + 0.057, z, w * 0.87, 0.025, d * 0.82, 'ground');
    box(group, '#aaa490', x, y + 0.075, z, w * 0.12, 0.016, d * 0.83);
    if (!design.components.solar) for (const dx of [-0.3, 0.3]) for (const dz of [-0.25, 0.25]) box(group, '#526e40', x + w * dx, y + 0.11, z + d * dz, Math.min(0.15, w * 0.2), 0.08, Math.min(0.15, d * 0.2), 'ground');
  } else {
    if (!design.components.solar) box(group, '#8b9390', x + w * 0.25, y + 0.11, z - d * 0.22, w * 0.19, 0.13, d * 0.18, 'metal');
    if (design.style === 'chinese' || design.style === 'japanese') {
      box(group, s.accent, x, y + 0.055, z, w + overhang * 1.7, 0.035, d + overhang * 1.7, 'wood');
      for (const direction of [-1, 1]) box(group, s.roof, x, y + 0.1, z + direction * d / 2, w + overhang * 1.8, 0.035, 0.09, 'roof');
    }
  }
  if (design.style === 'future') {
    box(group, '#80cad0', x, y + 0.085, z + d / 2 + 0.021, w * 0.9, 0.016, 0.018, 'lamp');
    if (!design.components.solar) box(group, s.trim, x - w * 0.27, y + 0.19, z - d * 0.2, 0.025, 0.3, 0.025, 'metal');
  }
  // Return the roof's actual mounting plane, not the highest antenna or HVAC
  // unit, so optional solar panels meet the roof instead of hovering over it.
  return y + 0.055;
}

function solarPanels(group, s, x, z, w, d, y) {
  const count = Math.max(1, Math.min(5, Math.floor(w / 0.24)));
  for (let i = 0; i < count; i++) {
    const px = x - w * 0.35 + (count === 1 ? w * 0.35 : w * 0.7 * i / (count - 1));
    box(group, '#5a6262', px, y + 0.035, z, Math.min(0.035, w * 0.05), 0.07, Math.min(0.18, d * 0.6), 'metal');
    const panel = box(group, '#294554', px, y + 0.085, z, Math.min(0.18, w * 0.75), 0.018, Math.min(0.24, d * 0.73), 'glass');
    panel.rotation.x = 0.22;
    box(group, '#8eabb0', px, y + 0.099, z, Math.min(0.18, w * 0.75), 0.006, 0.008, 'metal');
  }
}

function accessories(parent, design, s, w, d, top, variant) {
  const c = design.components;
  if (c.wall) {
    const group = new THREE.Group(); group.name = 'component-wall'; parent.add(group);
    const yy = design.style === 'chinese' ? 0.15 : 0.115;
    for (const direction of [-1, 1]) {
      box(group, design.color, direction * (w / 2 - 0.045), yy, 0, 0.045, yy * 1.5, d - 0.06);
      box(group, s.roof, direction * (w / 2 - 0.045), yy * 1.75 + 0.01, 0, 0.065, 0.03, d - 0.045, 'roof');
    }
    box(group, design.color, 0, yy, -d / 2 + 0.045, w - 0.06, yy * 1.5, 0.045);
    for (const direction of [-1, 1]) box(group, design.color, direction * w * 0.33, yy, d / 2 - 0.045, w * 0.27, yy * 1.5, 0.045);
  }
  if (c.garden) {
    const group = new THREE.Group(); group.name = 'component-garden'; parent.add(group);
    const size = Math.min(w, d) * 0.32;
    for (const sign of [-1, 1]) {
      tree(group, sign * w * 0.425, -d * 0.13, size, variant + (sign > 0 ? 3 : 0));
      box(group, '#526a40', sign * w * 0.415, 0.1, -d * 0.33, w * 0.095, 0.085, d * 0.15, 'ground');
    }
    if (!c.pool) for (let i = 0; i < 4; i++) box(group, i % 2 ? '#ac795f' : '#c7b78b', -w * 0.4 + i * w * 0.07, 0.105, d * (c.wall ? 0.405 : 0.43), w * 0.04, 0.035, d * 0.035, 'ground');
  }
  if (c.garage) {
    const group = new THREE.Group(); group.name = 'component-garage'; parent.add(group);
    const gw = w * 0.245, gd = d * 0.20, x = w * 0.29, z = d * 0.32;
    box(group, design.color, x, 0.16, z, gw, 0.22, gd);
    box(group, s.roof, x, 0.286, z, gw + 0.025, 0.032, gd + 0.025, 'roof');
    box(group, s.accent, x, 0.146, z + gd / 2 + 0.008, gw * 0.76, 0.17, 0.016, 'metal');
    for (let i = 0; i < 4; i++) box(group, '#8e9693', x, 0.085 + i * 0.037, z + gd / 2 + 0.018, gw * 0.74, 0.007, 0.01, 'metal');
  }
  if (c.pool) {
    const group = new THREE.Group(); group.name = 'component-pool'; parent.add(group);
    const x = -w * 0.265, z = d * 0.315, pw = w * 0.27, pd = d * 0.18;
    box(group, '#d0c6ad', x, 0.075, z, pw + 0.035, 0.04, pd + 0.035);
    box(group, '#3b8996', x, 0.1, z, pw, 0.018, pd, 'water');
    for (let i = 0; i < 3; i++) box(group, '#7ab6b8', x + pw * (i - 1) * 0.23, 0.111, z, pw * 0.08, 0.004, pd * 0.7, 'water');
    box(group, '#b8c5c0', x + pw * 0.22, 0.135, z + pd * 0.34, 0.013, 0.065, 0.013, 'metal');
  }
  if (c.terrace) {
    const group = new THREE.Group(); group.name = 'component-terrace'; parent.add(group);
    const x = w * 0.015, z = d * 0.33, tw = w * 0.23, td = d * 0.18;
    box(group, '#90775c', x, 0.074, z, tw, 0.04, td, 'wood');
    for (let i = 0; i < 5; i++) box(group, '#b09878', x - tw * 0.4 + i * tw * 0.2, 0.097, z, 0.01, 0.006, td, 'wood');
    box(group, '#c0b39a', x, 0.16, z, tw * 0.4, 0.025, td * 0.4, 'wood');
    box(group, '#5e655e', x, 0.124, z, 0.022, 0.07, 0.022, 'metal');
    for (const sign of [-1, 1]) box(group, s.trim, x + sign * tw * 0.35, 0.13, z, tw * 0.19, 0.07, td * 0.45);
  }
  if (c.solar) {
    const group = new THREE.Group(); group.name = 'component-solar'; parent.add(group);
    if (design.catalogId === 'centralPark') {
      // A small solar pergola is appropriate where there is no building roof.
      for (const sign of [-1, 1]) for (const side of [-1, 1]) box(group, s.accent, sign * w * 0.23, 0.31, -d * 0.075 + side * d * 0.13, 0.025, 0.52, 0.025, 'metal');
      box(group, s.trim, 0, 0.58, -d * 0.075, w * 0.55, 0.025, d * 0.32);
      solarPanels(group, s, 0, -d * 0.075, w * 0.5, d * 0.28, 0.595);
    } else if (design.catalogId === 'stadium') {
      const tiers = Math.min(6, Math.max(2, design.floors));
      const tierH = 0.065 + design.floors * 0.008;
      const sy = 0.17 + tiers * tierH;
      for (const sign of [-1, 1]) solarPanels(group, s, sign * w * 0.304, -d * 0.07, w * 0.1, d * 0.4, sy + (design.roof === 'pitched' ? 0.1 : 0));
    } else if (design.catalogId === 'school') {
      solarPanels(group, s, 0, -d * 0.2722, w * 0.54, d * 0.12, top);
    } else if (design.catalogId === 'botanical') {
      solarPanels(group, s, 0, -d * 0.15, w * 0.4, d * 0.2, top);
    } else if (design.catalogId === 'communityPark') {
      solarPanels(group, s, 0, -d * 0.1, w * 0.2, d * 0.18, top);
    } else solarPanels(group, s, 0, -d * 0.075, w * 0.54, d * 0.34, top);
  }
}

function awning(group, s, x, z, w, y, color, variant) {
  box(group, s.trim, x, y, z, w, 0.045, 0.15);
  const stripes = Math.max(4, Math.floor(w / 0.09));
  for (let i = 0; i < stripes; i++) {
    if ((i + variant) % 2 === 0) box(group, color, x - w / 2 + w * (i + 0.5) / stripes, y + 0.007, z + 0.002, w / stripes * 0.72, 0.05, 0.153, 'paint');
  }
}

function marker(group, symbol, x, y, z, scale, color) {
  if (symbol === 'cross') {
    box(group, color, x, y, z, scale * 0.9, scale * 0.28, 0.018, 'paint');
    box(group, color, x, y, z, scale * 0.28, scale * 0.9, 0.02, 'paint');
  } else if (symbol === 'shield') {
    box(group, color, x, y + scale * 0.08, z, scale * 0.72, scale * 0.63, 0.02, 'paint');
    box(group, color, x, y - scale * 0.29, z, scale * 0.4, scale * 0.23, 0.02, 'paint');
    box(group, '#c7bd86', x, y, z + 0.015, scale * 0.2, scale * 0.3, 0.012, 'metal');
  } else {
    box(group, color, x - scale * 0.22, y, z, scale * 0.37, scale * 0.64, 0.02, 'paint');
    box(group, color, x + scale * 0.22, y, z, scale * 0.37, scale * 0.64, 0.02, 'paint');
    box(group, '#cabf9c', x, y, z + 0.012, scale * 0.055, scale * 0.72, 0.012, 'paint');
  }
}

function makePark(group, design, s, w, d, variant) {
  const id = design.catalogId;
  let mountingHeight = 0.1;
  box(group, '#6c8050', 0, 0.052, 0, w * 0.9, 0.035, d * 0.9, 'ground');
  box(group, '#aaa38d', 0, 0.076, 0, w * 0.1, 0.016, d * 0.87);
  box(group, '#aaa38d', 0, 0.076, -d * 0.04, w * 0.84, 0.016, d * 0.09);
  if (id === 'centralPark') {
    box(group, '#a9a28d', -w * 0.22, 0.076, -d * 0.22, w * 0.34, 0.03, d * 0.32);
    box(group, '#4d7c80', -w * 0.22, 0.097, -d * 0.22, w * 0.29, 0.015, d * 0.27, 'water');
    box(group, s.trim, -w * 0.22, 0.135, -d * 0.22, w * 0.08, 0.07, d * 0.08);
    box(group, '#8fc1c1', -w * 0.22, 0.23, -d * 0.22, 0.025, 0.16, 0.025, 'water');
    for (const sign of [-1, 1]) tree(group, w * 0.28, sign * d * 0.25, Math.min(w, d) * 0.55, variant + (sign > 0 ? 1 : 3));
  } else if (id === 'botanical') {
    const gh = Math.min(1.1, 0.35 + design.floors * 0.045);
    box(group, s.glass, 0, gh / 2 + 0.07, -d * 0.15, w * 0.58, gh, d * 0.43, 'glass');
    for (let i = 0; i < 6; i++) {
      const xx = -w * 0.29 + w * 0.58 * i / 5;
      for (const sign of [-1, 1]) box(group, s.trim, xx, gh / 2 + 0.07, -d * 0.15 + sign * d * 0.219, 0.02, gh, 0.025, 'metal');
      box(group, s.trim, xx, gh + 0.079, -d * 0.15, 0.022, 0.022, d * 0.45, 'metal');
    }
    mountingHeight = roof(group, design, s, 0, -d * 0.15, w * 0.58, d * 0.43, gh + 0.07, variant);
    for (const sign of [-1, 1]) tree(group, sign * w * 0.37, d * 0.18, Math.min(w, d) * 0.4, variant + (sign > 0 ? 2 : 0));
  } else {
    for (const x of [-0.28, 0.28]) for (const z of [-0.26, 0.22]) tree(group, w * x, d * z, Math.min(w, d) * 0.43, variant + Math.round((x + z + 1) * 4));
    box(group, '#b1a58b', 0, 0.12, -d * 0.1, w * 0.24, 0.08, d * 0.23);
    for (const x of [-0.1, 0.1]) for (const z of [-0.1, 0.1]) box(group, s.accent, w * x, 0.25, -d * 0.1 + d * z, 0.025, 0.29, 0.025, 'wood');
    mountingHeight = roof(group, design, s, 0, -d * 0.1, w * 0.27, d * 0.25, 0.4, variant);
  }
  for (const sign of [-1, 1]) {
    box(group, '#7c654c', sign * w * 0.23, 0.11, d * 0.12, w * 0.18, 0.035, d * 0.07, 'wood');
    box(group, '#7c654c', sign * w * 0.23, 0.15, d * 0.085, w * 0.18, 0.075, 0.018, 'wood');
  }
  return mountingHeight;
}

function makeStadium(group, design, s, w, d) {
  const sw = w * 0.76, sd = d * 0.68;
  const tiers = Math.min(6, Math.max(2, design.floors));
  const tierH = 0.065 + design.floors * 0.008;
  box(group, '#537d4c', 0, 0.077, -d * 0.07, sw * 0.68, 0.035, sd * 0.7, 'ground');
  for (const sign of [-1, 1]) {
    box(group, '#d1d1b9', sign * sw * 0.32, 0.098, -d * 0.07, 0.012, 0.008, sd * 0.65);
    box(group, '#d1d1b9', 0, 0.098, -d * 0.07 + sign * sd * 0.32, sw * 0.65, 0.008, 0.012);
    for (let tier = 0; tier < tiers; tier++) {
      const yy = 0.08 + tierH * (tier + 0.5);
      box(group, tier % 2 ? design.color : s.trim, sign * (sw * 0.35 + tier * sw * 0.022), yy, -d * 0.07, sw * 0.06, tierH, sd * 0.89);
      box(group, tier % 2 ? design.color : s.trim, 0, yy, -d * 0.07 + sign * (sd * 0.35 + tier * sd * 0.022), sw * 0.78, tierH, sd * 0.06);
    }
    box(group, '#cdd3c8', 0, 0.15, -d * 0.07 + sign * sd * 0.26, sw * 0.21, 0.018, 0.018, 'metal');
    for (const side of [-1, 1]) box(group, '#cdd3c8', side * sw * 0.1, 0.123, -d * 0.07 + sign * sd * 0.26, 0.016, 0.07, 0.018, 'metal');
  }
  box(group, '#d1d1b9', 0, 0.099, -d * 0.07, sw * 0.64, 0.008, 0.012);
  for (const sign of [-1, 1]) {
    box(group, s.accent, sign * w * 0.37, 0.43, -d * 0.34, 0.022, 0.76, 0.022, 'metal');
    box(group, '#f0dfb5', sign * w * 0.37, 0.81, -d * 0.34, w * 0.1, 0.06, 0.04, 'lamp');
    box(group, s.roof, sign * sw * 0.4, 0.13 + tiers * tierH, -d * 0.07, sw * 0.18, 0.035, sd, 'roof');
    if (design.roof === 'pitched') for (let step = 0; step < 3; step++) box(group, s.roof, sign * sw * 0.4, 0.16 + tiers * tierH + step * 0.03, -d * 0.07, sw * 0.18 * (1 - step * 0.28), 0.035, sd, 'roof');
  }
  if (design.roof === 'garden') for (const sign of [-1, 1]) box(group, '#687c4d', sign * sw * 0.4, 0.16 + tiers * tierH, -d * 0.07, sw * 0.14, 0.025, sd * 0.88, 'ground');
  return Math.max(0.86, 0.18 + tiers * tierH);
}

function makeArchitecture(group, design, s, w, d, variant) {
  const id = design.catalogId;
  const floorH = design.style === 'industrial' ? 0.27 : 0.245;
  const base = 0.06, height = floorH * design.floors;
  const cw = w * 0.74, cd = d * 0.58, cz = -d * 0.075;
  const top = base + height;
  const glazed = ['office', 'tower', 'mall'].includes(id);
  if (id === 'school') {
    // A true U-shaped volume leaves an open playground in its centre.
    const backD = cd * 0.32;
    const backZ = cz - cd / 2 + backD / 2;
    box(group, design.color, 0, base + height / 2, backZ, cw, height, backD);
    facade(group, design, s, 0, backZ, cw, backD, base, design.floors, floorH, variant);
    for (const sign of [-1, 1]) {
      const wingW = cw * 0.23, wingX = sign * (cw / 2 - wingW / 2);
      box(group, design.color, wingX, base + height / 2, cz, wingW, height, cd);
      facade(group, design, s, wingX, cz, wingW, cd, base, design.floors, floorH, variant + 1);
      roof(group, design, s, wingX, cz, wingW, cd, top, variant);
    }
    box(group, '#9a755c', 0, 0.077, cz + cd * 0.12, cw * 0.49, 0.025, cd * 0.65, 'ground');
    box(group, '#d0c6a5', 0, 0.095, cz + cd * 0.12, cw * 0.38, 0.006, 0.012);
    box(group, '#aab0a2', 0, height * 0.5 + 0.1, cz + cd * 0.35, 0.016, height * 0.8 + 0.1, 0.016, 'metal');
    box(group, '#a75a48', cw * 0.06, height * 0.9 + 0.12, cz + cd * 0.35, cw * 0.12, 0.075, 0.012, 'paint');
    return roof(group, design, s, 0, backZ, cw, backD, top, variant);
  }
  const bodyW = id === 'tower' ? cw * 0.75 : id === 'manor' ? cw * 0.72 : cw;
  const bodyD = id === 'market' ? cd * 0.64 : cd;
  box(group, design.color, 0, base + height / 2, cz, bodyW, height, bodyD);
  box(group, s.trim, 0, base + 0.019, cz, bodyW + 0.035, 0.038, bodyD + 0.035);
  facade(group, design, s, 0, cz, bodyW, bodyD, base, design.floors, floorH, variant, { glazed, balconies: ['apartment', 'villa'].includes(id) });
  let roofTop = roof(group, design, s, 0, cz, bodyW, bodyD, top, variant);
  const front = cz + bodyD / 2;
  const doorW = Math.min(0.15, bodyW * 0.23);
  box(group, s.accent, 0, 0.16, front + 0.019, doorW + 0.03, 0.21, 0.018, 'metal');
  box(group, s.glass, 0, 0.162, front + 0.031, doorW, 0.18, 0.015, 'glass', 0.55);
  box(group, '#b5b09c', 0, 0.07, front + 0.07, bodyW * 0.3, 0.035, 0.12);
  if (id === 'villa') {
    box(group, s.trim, bodyW * 0.28, 0.27, front + 0.06, bodyW * 0.35, 0.035, 0.12);
    box(group, s.accent, bodyW * 0.42, 0.17, front + 0.1, 0.025, 0.2, 0.025, 'wood');
  } else if (id === 'townhouse') {
    box(group, s.trim, 0, base + height / 2, front + 0.022, 0.035, height, 0.035);
    for (const sign of [-1, 1]) {
      box(group, s.accent, sign * bodyW * 0.26, 0.16, front + 0.023, doorW * 0.72, 0.19, 0.025, 'wood');
      box(group, s.roof, sign * bodyW * 0.29, roofTop + 0.015, cz - bodyD * 0.22, 0.055, 0.1, 0.065, 'roof');
    }
  } else if (id === 'manor') {
    for (const sign of [-1, 1]) {
      const wx = sign * cw * 0.365, ww = cw * 0.24, wh = height * 0.8;
      box(group, design.color, wx, base + wh / 2, cz + cd * 0.04, ww, wh, cd * 0.85);
      facade(group, design, s, wx, cz + cd * 0.04, ww, cd * 0.85, base, Math.max(1, Math.floor(design.floors * 0.8)), wh / Math.max(1, Math.floor(design.floors * 0.8)), variant + 2);
      roof(group, design, s, wx, cz + cd * 0.04, ww, cd * 0.85, base + wh, variant);
    }
    for (const sign of [-1, 1]) box(group, s.trim, sign * bodyW * 0.19, base + height * 0.38, front + 0.06, 0.035, height * 0.76, 0.035);
    box(group, s.trim, 0, base + height * 0.78, front + 0.05, bodyW * 0.52, 0.055, 0.14);
  } else if (id === 'tower') {
    for (const sign of [-1, 1]) box(group, s.accent, sign * bodyW * 0.48, base + height / 2, front + 0.02, 0.027, height + 0.04, 0.04, 'metal');
    box(group, s.trim, 0, roofTop + 0.12, cz, 0.025, 0.25, 0.025, 'metal');
  } else if (['shop', 'supermarket', 'mall', 'market'].includes(id)) {
    const awningColor = design.style === 'chinese' ? '#9c4a3c' : design.style === 'future' ? '#578b91' : '#a16e4d';
    awning(group, s, 0, front + 0.058, bodyW * 0.97, 0.31, awningColor, variant);
    box(group, s.accent, 0, Math.min(top * 0.8, 0.48), front + 0.03, bodyW * 0.7, 0.08, 0.035, 'paint');
    for (let i = 0; i < 4; i++) box(group, s.trim, bodyW * (-0.25 + i * 0.16), Math.min(top * 0.8, 0.48), front + 0.052, bodyW * 0.09, 0.022, 0.013);
    if (id === 'supermarket' || id === 'mall') {
      for (const sign of [-1, 1]) box(group, s.glass, sign * bodyW * 0.27, 0.18, front + 0.018, bodyW * 0.3, 0.21, 0.018, 'glass', 0.55);
      for (let i = 0; i < 4; i++) box(group, '#aaa28e', -w * 0.24 + i * w * 0.16, 0.06, d * 0.36, 0.014, 0.008, d * 0.14);
    }
    if (id === 'market') {
      for (const sign of [-1, 1]) {
        const sx = sign * w * 0.24, sz = d * 0.23;
        box(group, '#8d7253', sx, 0.14, sz, w * 0.21, 0.17, d * 0.17, 'wood');
        awning(group, s, sx, sz, w * 0.25, 0.36, sign > 0 ? '#69805c' : '#a86e4b', variant);
        for (let i = 0; i < 3; i++) box(group, i % 2 ? '#97a35f' : '#b47845', sx - w * 0.06 + i * w * 0.06, 0.24, sz, w * 0.04, 0.055, d * 0.07, 'ground');
      }
    }
  } else if (id === 'office') {
    for (const sign of [-1, 1]) box(group, s.trim, sign * bodyW * 0.48, base + height / 2, front + 0.025, 0.04, height + 0.045, 0.045, 'metal');
    box(group, s.glass, 0, 0.27, front + 0.07, bodyW * 0.54, 0.035, 0.19, 'glass');
  } else if (id === 'hotel') {
    box(group, s.accent, bodyW * 0.39, base + height * 0.57, front + 0.022, bodyW * 0.12, height * 0.7, 0.04, 'paint');
    for (let i = 0; i < Math.min(5, design.floors + 1); i++) box(group, '#dbc68b', bodyW * 0.39, base + height * 0.3 + i * height * 0.12, front + 0.047, bodyW * 0.075, 0.025, 0.015, 'lamp');
    box(group, s.trim, 0, 0.28, front + 0.08, bodyW * 0.54, 0.04, 0.2);
  } else if (id === 'hospital') {
    box(group, '#d4d5c9', 0, top - floorH * 0.38, front + 0.029, bodyW * 0.3, floorH * 0.75, 0.03);
    marker(group, 'cross', 0, top - floorH * 0.38, front + 0.052, Math.min(0.18, bodyW * 0.25), '#a9443f');
    box(group, '#a9443f', 0, 0.27, front + 0.07, bodyW * 0.65, 0.035, 0.18, 'paint');
    for (const sign of [-1, 1]) box(group, s.trim, sign * bodyW * 0.3, 0.16, front + 0.13, 0.027, 0.2, 0.027);
  } else if (id === 'fire') {
    for (let i = 0; i < 3; i++) {
      const xx = bodyW * (-0.31 + i * 0.31);
      box(group, '#934a3c', xx, 0.17, front + 0.023, bodyW * 0.25, 0.22, 0.024, 'paint');
      for (let row = 0; row < 4; row++) box(group, '#baa58c', xx, 0.09 + row * 0.045, front + 0.04, bodyW * 0.24, 0.007, 0.012, 'metal');
    }
    box(group, '#b74835', -bodyW * 0.27, 0.13, d * 0.32, w * 0.17, 0.12, d * 0.17, 'paint');
    box(group, '#d0b889', -bodyW * 0.27, 0.202, d * 0.32, w * 0.1, 0.025, d * 0.12, 'metal');
  } else if (id === 'police') {
    marker(group, 'shield', 0, top - floorH * 0.4, front + 0.035, Math.min(0.2, bodyW * 0.26), '#365f7b');
    box(group, '#365b77', 0, 0.27, front + 0.065, bodyW * 0.63, 0.035, 0.16, 'paint');
    box(group, '#76a6cc', -0.035, roofTop + 0.035, cz + bodyD * 0.26, 0.055, 0.045, 0.04, 'lamp');
    box(group, '#bd5e52', 0.035, roofTop + 0.035, cz + bodyD * 0.26, 0.055, 0.045, 0.04, 'lamp');
  } else if (id === 'library') {
    for (let i = 0; i < 4; i++) {
      const xx = bodyW * (-0.37 + i * 0.245);
      box(group, s.trim, xx, base + height * 0.4, front + 0.055, 0.04, height * 0.8, 0.045);
      box(group, s.trim, xx, base + 0.025, front + 0.055, 0.065, 0.05, 0.07);
    }
    box(group, s.trim, 0, base + height * 0.82, front + 0.055, bodyW + 0.04, 0.055, 0.17);
    marker(group, 'book', 0, top - 0.055, front + 0.03, Math.min(0.19, bodyW * 0.27), '#7c7559');
  }
  return roofTop;
}

export function createDesignedBuilding(input, level = 1, variant = 0) {
  const design = cleanDesign(input);
  const group = new THREE.Group();
  group.name = `designed-${design.catalogId}`;
  group.userData.design = design;
  group.userData.buildingType = design.catalogId;
  const odd = design.rotation % 2 === 1;
  const occupiedWidth = odd ? design.depth : design.width;
  const occupiedDepth = odd ? design.width : design.depth;
  group.userData.footprint = { width: occupiedWidth, depth: occupiedDepth };
  group.userData.level = Math.min(3, Math.max(1, Math.round(level) || 1));
  const s = STYLES[design.style];
  const safeVariant = Math.abs(Math.floor(Number(variant) || 0));
  const park = ['communityPark', 'centralPark', 'botanical'].includes(design.catalogId);
  box(group, park || design.components.garden ? '#78855d' : '#aaa594', 0, 0.023, 0, occupiedWidth - 0.04, 0.046, occupiedDepth - 0.04, 'ground');
  const oriented = new THREE.Group();
  oriented.name = 'oriented-architecture';
  oriented.rotation.y = design.rotation * Math.PI / 2;
  // Build once in the design's native dimensions, then rotate the architecture.
  // Odd quarter-turns therefore occupy depth × width, matching simulation cells
  // and the centre position supplied by the city renderer.
  const w = design.width;
  const d = design.depth;
  const architecture = new THREE.Group(); architecture.name = 'architecture'; oriented.add(architecture);
  let top;
  if (!KNOWN.has(design.catalogId)) {
    const fallback = createBuilding('residential', level, safeVariant);
    const bounds = new THREE.Box3().setFromObject(fallback);
    const size = bounds.getSize(new THREE.Vector3());
    const scale = Math.min(w * 0.75 / size.x, d * 0.62 / size.z, 3.3 / size.y);
    fallback.scale.setScalar(scale);
    fallback.position.y = 0.05;
    architecture.add(fallback);
    top = size.y * scale + 0.05;
  } else if (park) top = makePark(architecture, design, s, w, d, safeVariant);
  else if (design.catalogId === 'stadium') top = makeStadium(architecture, design, s, w, d);
  else top = makeArchitecture(architecture, design, s, w, d, safeVariant);
  if (design.components.solar) accessories(architecture, { ...design, components: { solar: true } }, s, w, d, top, safeVariant);
  const c = design.components;
  if (c.garden || c.wall || c.garage || c.pool || c.terrace) {
    // Reserve front and side yards before placing attachments. Market stalls,
    // park trees and stadium stands otherwise occupy the same accessory slots.
    const bounds = new THREE.Box3().setFromObject(architecture);
    const side = w * (c.garden ? 0.34 : c.wall ? 0.415 : 0.48);
    const back = -d * (c.wall ? 0.415 : 0.48);
    const front = d * (c.garage || c.pool || c.terrace ? 0.13 : c.wall ? 0.415 : 0.48);
    const sx = Math.min(1, side * 2 / (bounds.max.x - bounds.min.x));
    const sz = Math.min(1, (front - back) / (bounds.max.z - bounds.min.z));
    architecture.scale.set(sx, 1, sz);
    architecture.position.x = -(bounds.min.x + bounds.max.x) / 2 * sx;
    architecture.position.z = Math.min(0, front - bounds.max.z * sz);
    if (bounds.min.z * sz + architecture.position.z < back) architecture.position.z = back - bounds.min.z * sz;
  }
  accessories(oriented, { ...design, components: { ...design.components, solar: false } }, s, w, d, top, safeVariant);
  group.add(oriented);
  group.updateMatrixWorld(true);
  return batch(group);
}
