import * as THREE from './vendor/three.module.js';

export const ROAD_SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
export const roadSurface = cell => (cell?.terrain === 'water' ? .065 : .022) + .027 + .025 / 2;

// Keep the owning tile for every instance when combining buildings by material.
export function batchModels(source) {
  const batches = new Map(), local = new THREE.Matrix4(), world = new THREE.Matrix4();
  source.updateMatrixWorld(true);
  source.traverse(object => {
    if (!object.isMesh) return;
    let owner = object;
    while (owner && !Number.isInteger(owner.userData.cellIndex)) owner = owner.parent;
    const cellIndex = owner?.userData.cellIndex ?? null;
    const key = object.geometry.uuid + '_' + object.material.uuid;
    if (!batches.has(key)) batches.set(key, { geometry: object.geometry, material: object.material, matrices: [], cells: [] });
    const pack = batches.get(key);
    if (object.isInstancedMesh) {
      for (let i = 0; i < object.count; i++) {
        object.getMatrixAt(i, local);
        pack.matrices.push(world.multiplyMatrices(object.matrixWorld, local).clone());
        pack.cells.push(cellIndex);
      }
    } else { pack.matrices.push(object.matrixWorld.clone()); pack.cells.push(cellIndex); }
  });
  const group = new THREE.Group();
  for (const pack of batches.values()) {
    const mesh = new THREE.InstancedMesh(pack.geometry, pack.material, pack.matrices.length);
    pack.matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
    mesh.userData.cellIndices = pack.cells;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.computeBoundingSphere(); group.add(mesh);
  }
  return group;
}

export function pickCellIndex(raycaster, objects) {
  for (const hit of raycaster.intersectObjects(objects, true)) {
    const index = hit.instanceId === undefined ? hit.object.userData.cellIndex : hit.object.userData.cellIndices?.[hit.instanceId];
    if (Number.isInteger(index)) return index;
  }
  return null;
}

// Rails close only edges with no road exit, including bends and T-junctions.
export function bridgeRails(links) {
  return ROAD_SIDES.filter(([dx, dz]) => !links.some(([x, z]) => x === dx && z === dz))
    .map(([dx, dz]) => ({ x: dx * .44, z: dz * .44, width: dx ? .045 : 1, depth: dz ? .045 : 1 }));
}

// The simulation has four-neighbour connectivity, so diagonal strokes need
// an intermediate tile at each corner. Preview and placement share this path.
export function lineCells(a, b) {
  if (!a || !b) return [];
  const out = [{ x: a.x, z: a.z }];
  let x = a.x, z = a.z, dx = Math.abs(b.x - x), dz = Math.abs(b.z - z);
  const sx = Math.sign(b.x - x), sz = Math.sign(b.z - z);
  let err = dx - dz;
  while (x !== b.x || z !== b.z) {
    const e2 = err * 2;
    if (e2 > -dz) { err -= dz; x += sx; out.push({ x, z }); }
    if (e2 < dx) { err += dx; z += sz; out.push({ x, z }); }
  }
  return out;
}
