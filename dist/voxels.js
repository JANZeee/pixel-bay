import * as THREE from './vendor/three.module.js';

// All dimensions are in city tiles. Shared geometry and instanced colour batches
// keep the tiny architectural details inexpensive as the town grows.
const CUBE = new THREE.BoxGeometry(1, 1, 1);
const materials = new Map();
const P = {
  // Real architectural pigments, in sRGB. Low-chroma walls leave room for the
  // sky and sun to supply colour; the geometry remains deliberately voxel-like.
  cream: '#bbb3a1', ivory: '#d2cdbd', blush: '#af9586', yellow: '#b4a17b',
  mint: '#939d90', teal: '#506b63', blue: '#8b989d', glass: '#6d838a',
  darkGlass: '#435c65', roof: '#895843', roofLight: '#a26f54',
  charcoal: '#424849', slate: '#737b7d', white: '#d8d9cf',
  brick: '#946d57', tan: '#ad9d80', pavement: '#a7a496',
  grass: '#697d4e', leaf: '#4d6540', leafLight: '#6a7b49',
  leafDark: '#374e35', trunk: '#655340', soil: '#807259',
  water: '#537a81', solar: '#243d50', rubber: '#272b2a',
  coral: '#a95f46', lamp: '#e8c692',
};

// One shared, deterministic texture supplies fine pores and surface grain. A
// DataTexture also works in headless import checks and needs no canvas or assets.
function surfaceTexture() {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const noise = (x, y) => {
    let h = Math.imul((x & 63) + 257, 374761393) ^ Math.imul((y & 63) + 97, 668265263);
    h = Math.imul(h ^ h >>> 13, 1274126177);
    return ((h ^ h >>> 16) >>> 0) / 4294967295;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const coarse = (noise(x >> 2, y >> 2) + noise((x + 2) >> 2, (y + 2) >> 2)) * 0.5;
    const grain = noise(x, y) * 0.7 + coarse * 0.3;
    const v = Math.round(203 + grain * 52);
    const i = (y * size + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.name = 'shared-mineral-micrograin';
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 3);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

const micrograin = surfaceTexture();
let lightingState = { night: 0, wetness: 0 };
const surfaces = new Map([
  ...[P.glass, P.darkGlass, P.water].map(color => [color, 'glass']),
  ...[P.teal, P.slate, P.charcoal].map(color => [color, 'metal']),
  ...[P.leaf, P.leafLight, P.leafDark].map(color => [color, 'leaf']),
  ...[P.grass, P.soil].map(color => [color, 'ground']),
  ...[P.roof, P.roofLight].map(color => [color, 'clay']),
  [P.trunk, 'wood'], [P.solar, 'solar'], [P.rubber, 'rubber'],
  [P.coral, 'paint'], [P.lamp, 'lamp'],
]);
const masonry = new Set([P.cream, P.ivory, P.blush, P.yellow, P.mint, P.blue, P.white, P.brick, P.tan, P.pavement]);

function updateMaterialLighting(material) {
  const { surface, baseRoughness, baseEmissive, windowGroup } = material.userData;
  const { night, wetness } = lightingState;
  const absorbent = ['masonry', 'clay', 'wood', 'ground'].includes(surface);
  const wetResponse = absorbent ? 0.52 : surface === 'metal' ? 0.3 : 0.12;
  material.roughness = Math.max(surface === 'glass' ? 0.08 : 0.18, baseRoughness - wetness * wetResponse);
  if (material.isMeshPhysicalMaterial) {
    material.clearcoat = surface === 'glass' || surface === 'solar' ? 0.8 : 0.18 + wetness * 0.6;
    material.clearcoatRoughness = 0.14 - wetness * 0.07;
  }
  // Groups are stable across rebuilds and shared across instances. Some rooms
  // stay dark; others have warm interior light, without hundreds of point lights.
  const occupied = surface === 'glass' && windowGroup > 0;
  material.emissiveIntensity = baseEmissive + (occupied ? night * (windowGroup === 1 ? 0.65 : 0.32) : surface === 'lamp' ? night * 1.5 : 0);
}

export function setMaterialLighting({ night = lightingState.night, wetness = lightingState.wetness } = {}) {
  lightingState = {
    night: Math.min(1, Math.max(0, Number.isFinite(night) ? night : 0)),
    wetness: Math.min(1, Math.max(0, Number.isFinite(wetness) ? wetness : 0)),
  };
  for (const material of materials.values()) updateMaterialLighting(material);
}

function mat(color, windowGroup = 0) {
  const surface = surfaces.get(color) || (masonry.has(color) ? 'masonry' : 'paint');
  const key = `${color}:${surface === 'glass' ? windowGroup : 0}`;
  if (!materials.has(key)) {
    const physical = ['glass', 'solar', 'paint', 'metal'].includes(surface);
    const Material = physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
    const roughness = { glass: 0.14, solar: 0.19, metal: 0.47, paint: 0.35, leaf: 0.91, ground: 1, clay: 0.88, masonry: 0.89, wood: 0.84, rubber: 0.97, lamp: 0.38 }[surface];
    const material = new Material({
      color,
      roughness,
      // Glass, paint, ceramic and concrete are dielectrics. Only exposed metal
      // uses a conductor response; oxidised copper is deliberately less metallic.
      metalness: surface === 'metal' ? color === P.teal ? 0.38 : 0.72 : 0,
      flatShading: true,
      envMapIntensity: surface === 'glass' ? 1.65 : surface === 'solar' ? 1.4 : surface === 'metal' ? 1.2 : 0.85,
      emissive: surface === 'glass' && windowGroup > 0 ? '#f6b96f' : surface === 'lamp' ? '#ffe2a8' : '#000000',
      emissiveIntensity: 0,
    });
    if (physical) {
      material.ior = 1.5;
      material.clearcoat = surface === 'glass' || surface === 'solar' ? 0.8 : 0.18;
      material.clearcoatRoughness = 0.14;
      material.specularIntensity = 1;
    }
    if (!['glass', 'solar', 'lamp'].includes(surface)) {
      material.roughnessMap = micrograin;
      if (!['leaf', 'paint', 'rubber'].includes(surface)) {
        material.bumpMap = micrograin;
        material.bumpScale = surface === 'metal' ? 0.0005 : surface === 'ground' ? 0.0022 : 0.0012;
      }
    }
    material.name = `voxel-${surface}-${color}-${windowGroup}`;
    material.userData = {
      surface, baseRoughness: roughness, windowGroup,
      baseEmissive: surface === 'lamp' ? 0.1 : surface === 'glass' && windowGroup > 0 ? 0.012 : 0,
    };
    updateMaterialLighting(material);
    materials.set(key, material);
  }
  return materials.get(key);
}

function box(parent, color, x, y, z, width, height, depth) {
  let windowGroup = 0;
  if (surfaces.get(color) === 'glass' && parent.name !== 'car' && color !== P.water) {
    const seed = (Math.round(x * 1000) * 31 + Math.round(y * 1000) * 17 + Math.round(z * 1000) * 13 + (parent.userData.variant || 0) * 7) | 0;
    const index = Math.abs(Math.imul(seed ^ seed >>> 16, 1103515245)) % 7;
    windowGroup = index === 0 || index === 2 ? 1 : index === 5 ? 2 : 0;
  }
  const mesh = new THREE.Mesh(CUBE, mat(color, windowGroup));
  mesh.position.set(x, y, z);
  mesh.scale.set(width, height, depth);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function batch(group) {
  const batches = new Map();
  for (const child of [...group.children]) {
    if (!child.isMesh || child.geometry !== CUBE || child.name) continue;
    const list = batches.get(child.material) || [];
    list.push(child);
    batches.set(child.material, list);
  }
  for (const [material, meshes] of batches) {
    if (meshes.length < 2) continue;
    const instances = new THREE.InstancedMesh(CUBE, material, meshes.length);
    instances.castShadow = true;
    instances.receiveShadow = true;
    meshes.forEach((mesh, index) => {
      mesh.updateMatrix();
      instances.setMatrixAt(index, mesh.matrix);
      group.remove(mesh);
    });
    instances.instanceMatrix.needsUpdate = true;
    instances.computeBoundingSphere();
    group.add(instances);
  }
  return group;
}

function pick(array, variant) {
  return array[Math.abs(Math.floor(variant)) % array.length];
}

function foundation(group, color = P.pavement) {
  box(group, color, 0, 0.027, 0, 0.88, 0.054, 0.88);
}

function frontWindows(group, xs, floors, bottom, step, z, width = 0.11, height = 0.12, color = P.darkGlass) {
  for (let floor = 0; floor < floors; floor++) {
    for (const x of xs) box(group, color, x, bottom + floor * step, z, width, height, 0.012);
  }
}

function sideWindows(group, zs, floors, bottom, step, x, width = 0.11, height = 0.12, color = P.darkGlass) {
  for (let floor = 0; floor < floors; floor++) {
    for (const z of zs) box(group, color, x, bottom + floor * step, z, 0.012, height, width);
  }
}

function roofSteps(group, x, bottom, z, width, depth, color, height = 0.23) {
  const levels = 4;
  for (let i = 0; i < levels; i++) {
    box(group, color, x, bottom + (i + 0.5) * height / levels, z,
      width, height / levels + 0.006, depth * (1 - i * 0.22));
  }
}

function shrub(group, x, z, variant = 0, size = 0.12) {
  box(group, P.leafDark, x, 0.09, z, size, 0.1, size);
  box(group, variant % 2 ? P.leaf : P.leafLight, x - 0.013, 0.15, z, size * 0.8, 0.065, size * 0.85);
}

function house(group, variant) {
  foundation(group, P.grass);
  const wall = pick([P.cream, P.blush, P.yellow, P.ivory, P.mint], variant);
  const roof = pick([P.roof, P.teal, P.roofLight, P.slate], variant);
  const h = variant % 3 === 0 ? 0.43 : 0.35;
  box(group, P.pavement, 0, 0.057, 0.33, 0.19, 0.025, 0.23);
  box(group, wall, -0.045, 0.055 + h / 2, -0.065, 0.61, h, 0.53);
  box(group, P.ivory, -0.045, 0.08, -0.065, 0.65, 0.055, 0.57);
  roofSteps(group, -0.045, 0.055 + h, -0.065, 0.7, 0.66, roof);
  box(group, P.brick, 0.16, h + 0.23, -0.17, 0.075, 0.2, 0.075);
  box(group, P.charcoal, 0.16, h + 0.335, -0.17, 0.09, 0.025, 0.09);
  frontWindows(group, [-0.23, 0.16], 1, 0.26, 0, 0.207, 0.115, 0.13);
  sideWindows(group, [-0.19, 0.035], 1, 0.26, 0, 0.266, 0.11, 0.13);
  box(group, P.trunk, -0.04, 0.172, 0.208, 0.105, 0.235, 0.014);
  box(group, P.lamp, -0.017, 0.17, 0.219, 0.014, 0.015, 0.012);
  box(group, P.ivory, -0.04, 0.325, 0.259, 0.23, 0.038, 0.17);
  box(group, P.pavement, -0.04, 0.072, 0.268, 0.25, 0.045, 0.16);
  shrub(group, -0.31, 0.32, variant);
  shrub(group, 0.29, 0.32, variant + 1);
  if (variant % 2 === 0) {
    const tree = createTree(variant);
    tree.scale.setScalar(0.55);
    tree.position.set(0.325, 0.045, -0.29);
    group.add(tree);
  }
}

function apartment(group, level, variant) {
  foundation(group);
  const floors = level >= 3 ? 6 + variant % 2 : 3 + variant % 2;
  const floorH = 0.195;
  const height = floors * floorH;
  const wall = pick(level >= 3 ? [P.mint, P.ivory, P.blue] : [P.cream, P.blush, P.mint, P.yellow], variant);
  const w = level >= 3 ? 0.61 : 0.69;
  const d = level >= 3 ? 0.57 : 0.62;
  box(group, wall, 0, 0.055 + height / 2, -0.025, w, height, d);
  box(group, P.ivory, 0, 0.083, -0.025, w + 0.05, 0.06, d + 0.05);
  frontWindows(group, [-0.205, 0, 0.205], floors, 0.17, floorH, -0.025 + d / 2 + 0.008, 0.105, 0.108);
  sideWindows(group, [-0.2, 0.035, 0.19], floors, 0.17, floorH, w / 2 + 0.008, 0.1, 0.108);
  frontWindows(group, [-0.2, 0.2], floors, 0.17, floorH, -0.025 - d / 2 - 0.008, 0.1, 0.108, P.glass);
  for (let i = 1; i < floors; i++) {
    box(group, P.ivory, 0, 0.055 + i * floorH, -0.025, w + 0.025, 0.025, d + 0.025);
  }
  box(group, P.teal, 0, height + 0.07, -0.025, w + 0.07, 0.055, d + 0.07);
  box(group, P.slate, 0.11, height + 0.15, -0.09, 0.2, 0.13, 0.18);
  box(group, P.white, -0.16, height + 0.12, 0.09, 0.13, 0.075, 0.14);
  box(group, P.darkGlass, 0, 0.153, d / 2 - 0.012, 0.13, 0.2, 0.018);
  box(group, P.teal, 0, 0.28, d / 2 + 0.047, 0.25, 0.035, 0.13);
  shrub(group, -0.3, 0.365, variant, 0.14);
  shrub(group, 0.3, 0.365, variant + 1, 0.14);
}

function commercial(group, level, variant) {
  foundation(group);
  const height = level <= 1 ? 0.34 : level === 2 ? 0.7 : 1.22;
  const floors = level <= 1 ? 1 : level === 2 ? 3 : 5;
  const body = pick([P.ivory, P.blue, P.mint, P.cream], variant);
  box(group, body, 0, 0.06 + height / 2, -0.035, 0.72, height, 0.64);
  box(group, P.darkGlass, 0, 0.2, 0.293, 0.61, 0.24, 0.014);
  box(group, P.white, 0, 0.2, 0.307, 0.035, 0.25, 0.02);
  box(group, P.white, -0.21, 0.2, 0.307, 0.022, 0.25, 0.02);
  box(group, P.white, 0.21, 0.2, 0.307, 0.022, 0.25, 0.02);
  sideWindows(group, [-0.23, -0.02, 0.19], floors, 0.22, 0.215, 0.367, 0.155, 0.145, P.glass);
  if (floors > 1) {
    frontWindows(group, [-0.23, 0, 0.23], floors - 1, 0.465, 0.215, 0.293, 0.16, 0.14, P.glass);
    for (let i = 1; i < floors; i++) box(group, P.white, 0, 0.17 + i * 0.215, -0.035, 0.744, 0.028, 0.665);
  }
  const awning = pick([P.coral, P.teal, P.roofLight], variant);
  box(group, awning, 0, 0.346, 0.346, 0.78, 0.065, 0.18);
  for (let i = 0; i < 4; i++) box(group, P.ivory, -0.295 + i * 0.19, 0.35, 0.348, 0.075, 0.075, 0.185);
  box(group, P.teal, 0, height + 0.09, -0.035, 0.77, 0.06, 0.69);
  box(group, P.slate, 0.17, height + 0.17, -0.16, 0.2, 0.11, 0.19);
  // A tiny physical sign avoids illegible texture-based signage at city scale.
  box(group, awning, -0.16, height + 0.185, 0.14, 0.27, 0.15, 0.055);
  box(group, P.ivory, -0.16, height + 0.185, 0.171, 0.17, 0.035, 0.012);
  box(group, P.trunk, 0.29, 0.095, 0.385, 0.17, 0.035, 0.07);
}

function industrial(group, level, variant) {
  foundation(group, P.tan);
  const h = 0.29 + (level - 1) * 0.095;
  box(group, pick([P.brick, P.tan, P.cream], variant), -0.055, 0.055 + h / 2, -0.015, 0.65, h, 0.68);
  roofSteps(group, -0.055, h + 0.055, -0.015, 0.71, 0.73, P.charcoal, 0.1);
  for (const x of [-0.205, 0.09]) {
    box(group, P.slate, x, 0.165, 0.333, 0.2, 0.22, 0.018);
    for (const y of [0.12, 0.18, 0.24]) box(group, P.charcoal, x, y, 0.346, 0.18, 0.013, 0.012);
  }
  sideWindows(group, [-0.2, 0.05, 0.23], 1, h + 0.003, 0, 0.278, 0.125, 0.065, P.glass);
  box(group, P.brick, 0.29, 0.4 + level * 0.05, -0.24, 0.12, 0.7 + level * 0.1, 0.12);
  box(group, P.charcoal, 0.29, 0.76 + level * 0.1, -0.24, 0.15, 0.045, 0.15);
  box(group, P.ivory, 0.29, 0.63 + level * 0.07, -0.24, 0.123, 0.07, 0.123);
  box(group, P.tan, 0.3, 0.13, 0.22, 0.16, 0.15, 0.16);
  box(group, P.trunk, 0.3, 0.208, 0.22, 0.165, 0.014, 0.165);
  box(group, P.tan, 0.33, 0.105, 0.02, 0.13, 0.1, 0.14);
  box(group, P.slate, -0.17, h + 0.19, -0.09, 0.15, 0.1, 0.17);
}

function bench(group, x, z, rotate = false) {
  const benchGroup = new THREE.Group();
  box(benchGroup, P.trunk, 0, 0.125, 0, 0.23, 0.04, 0.095);
  box(benchGroup, P.trunk, 0, 0.19, -0.035, 0.23, 0.09, 0.025);
  box(benchGroup, P.charcoal, -0.075, 0.08, 0, 0.025, 0.09, 0.07);
  box(benchGroup, P.charcoal, 0.075, 0.08, 0, 0.025, 0.09, 0.07);
  benchGroup.position.set(x, 0, z);
  if (rotate) benchGroup.rotation.y = Math.PI / 2;
  group.add(batch(benchGroup));
}

function park(group, variant) {
  foundation(group, P.grass);
  box(group, P.pavement, 0, 0.059, 0, 0.15, 0.013, 0.88);
  box(group, P.pavement, 0, 0.059, 0.12, 0.88, 0.013, 0.14);
  for (const [x, z, scale, v] of [[-0.26, -0.22, 0.77, variant], [0.27, -0.24, 0.67, variant + 1]]) {
    const tree = createTree(v);
    tree.scale.setScalar(scale);
    tree.position.set(x, 0.05, z);
    group.add(tree);
  }
  bench(group, -0.26, 0.27);
  bench(group, 0.27, 0.27);
  box(group, P.soil, 0.26, 0.075, -0.01, 0.25, 0.035, 0.105);
  for (let i = 0; i < 3; i++) {
    box(group, P.leafDark, 0.175 + i * 0.08, 0.11, -0.01, 0.045, 0.07, 0.045);
    box(group, pick([P.coral, P.lamp, P.ivory], i + variant), 0.175 + i * 0.08, 0.15, -0.01, 0.055, 0.035, 0.055);
  }
}

function power(group, variant) {
  foundation(group, P.grass);
  box(group, P.pavement, -0.11, 0.065, -0.13, 0.29, 0.04, 0.29);
  box(group, P.white, -0.11, 0.56, -0.13, 0.055, 1.0, 0.055);
  box(group, P.ivory, -0.11, 1.06, -0.13, 0.13, 0.12, 0.19);
  // Rotor turns around its local Z axis, like the face of a clock.
  const rotor = new THREE.Group();
  rotor.name = 'rotor';
  rotor.userData.axis = 'z';
  rotor.position.set(-0.11, 1.06, -0.012);
  box(rotor, P.teal, 0, 0, 0, 0.085, 0.085, 0.06);
  for (let i = 0; i < 3; i++) {
    const blade = new THREE.Group();
    box(blade, P.ivory, 0, 0.145, 0, 0.055, 0.25, 0.026);
    box(blade, P.white, 0.008, 0.287, 0, 0.037, 0.07, 0.026);
    blade.rotation.z = i * Math.PI * 2 / 3 + (variant % 3) * 0.25;
    rotor.add(batch(blade));
  }
  group.add(rotor);
  for (const x of [0.17, 0.32]) {
    box(group, P.charcoal, x, 0.13, 0.19, 0.025, 0.15, 0.19);
    const panel = box(group, P.solar, x, 0.22, 0.19, 0.125, 0.025, 0.35);
    panel.rotation.x = 0.25;
    for (const z of [0.08, 0.19, 0.3]) box(group, P.blue, x, 0.243 - (z - 0.19) * 0.25, z, 0.128, 0.008, 0.009);
  }
  box(group, P.teal, -0.22, 0.145, 0.27, 0.21, 0.18, 0.2);
  box(group, P.ivory, -0.22, 0.246, 0.27, 0.235, 0.03, 0.225);
  box(group, P.lamp, -0.22, 0.16, 0.378, 0.045, 0.055, 0.012);
}

function water(group) {
  foundation(group, P.pavement);
  box(group, P.blue, -0.19, 0.17, 0.2, 0.34, 0.24, 0.29);
  box(group, P.ivory, -0.19, 0.305, 0.2, 0.38, 0.04, 0.33);
  box(group, P.darkGlass, -0.19, 0.17, 0.352, 0.1, 0.19, 0.014);
  for (const x of [-0.23, 0.23]) for (const z of [-0.29, 0.17]) {
    box(group, P.ivory, x, 0.39, z, 0.045, 0.67, 0.045);
    box(group, P.slate, x, 0.08, z, 0.1, 0.06, 0.1);
  }
  box(group, P.white, 0, 0.42, -0.06, 0.49, 0.03, 0.49);
  box(group, P.teal, 0, 0.73, -0.06, 0.59, 0.1, 0.59);
  box(group, P.blue, 0, 0.9, -0.06, 0.54, 0.27, 0.54);
  box(group, P.water, 0, 0.9, 0.215, 0.43, 0.2, 0.012);
  box(group, P.ivory, 0, 1.055, -0.06, 0.6, 0.065, 0.6);
  box(group, P.teal, 0, 1.1, -0.06, 0.49, 0.03, 0.49);
  box(group, P.blue, 0.32, 0.34, -0.22, 0.045, 0.56, 0.045);
  box(group, P.blue, 0.26, 0.63, -0.22, 0.17, 0.045, 0.045);
}

export function createBuilding(type, level = 1, variant = 0) {
  const group = new THREE.Group();
  group.name = `building-${type}`;
  group.userData.buildingType = type;
  const safeLevel = Math.min(3, Math.max(1, Math.floor(level)));
  const safeVariant = Math.abs(Math.floor(variant));
  group.userData.variant = safeVariant;
  switch (type) {
    case 'residential':
    case 'house':
    case 'residence':
      if (safeLevel === 1) house(group, safeVariant);
      else apartment(group, safeLevel, safeVariant);
      break;
    case 'commercial':
    case 'shop': commercial(group, safeLevel, safeVariant); break;
    case 'industrial':
    case 'industry':
    case 'factory': industrial(group, safeLevel, safeVariant); break;
    case 'park': park(group, safeVariant); break;
    case 'power':
    case 'wind': power(group, safeVariant); break;
    case 'water': water(group); break;
    default: house(group, safeVariant); break;
  }
  return batch(group);
}

export function createTree(variant = 0) {
  const group = new THREE.Group();
  group.name = 'tree';
  const n = Math.abs(Math.floor(variant));
  const h = 0.29 + (n % 3) * 0.025;
  box(group, P.trunk, 0, h / 2, 0, 0.055, h, 0.055);
  if (n % 4 === 3) {
    // Stepped cypress gives the town a second, distinct tree silhouette.
    box(group, P.leafDark, 0, h + 0.03, 0, 0.28, 0.15, 0.28);
    box(group, P.leaf, 0, h + 0.16, 0, 0.21, 0.15, 0.21);
    box(group, P.leafLight, 0, h + 0.275, 0, 0.13, 0.12, 0.13);
  } else {
    box(group, P.leafDark, 0, h + 0.01, 0, 0.33, 0.18, 0.31);
    box(group, P.leaf, -0.015, h + 0.13, -0.015, 0.3, 0.18, 0.29);
    box(group, P.leafLight, 0.025, h + 0.24, -0.015, 0.21, 0.09, 0.21);
    box(group, P.leaf, 0.15, h + 0.03, 0.035, 0.13, 0.14, 0.17);
  }
  return batch(group);
}

export function createCar(color = P.coral) {
  const group = new THREE.Group();
  group.name = 'car';
  const c = typeof color === 'number' ? color : color || P.coral;
  // Longitudinal axis is Z; the car's front faces +Z.
  box(group, c, 0, 0.065, 0, 0.135, 0.065, 0.28);
  box(group, P.darkGlass, 0, 0.117, -0.025, 0.112, 0.055, 0.14);
  box(group, c, 0, 0.151, -0.03, 0.12, 0.019, 0.105);
  box(group, c, 0, 0.12, -0.025, 0.012, 0.06, 0.145);
  for (const x of [-0.069, 0.069]) for (const z of [-0.085, 0.085]) {
    box(group, P.rubber, x, 0.04, z, 0.027, 0.055, 0.05);
  }
  for (const x of [-0.04, 0.04]) {
    box(group, P.ivory, x, 0.066, 0.144, 0.027, 0.022, 0.009);
    box(group, P.coral, x, 0.066, -0.144, 0.025, 0.02, 0.009);
  }
  return batch(group);
}
