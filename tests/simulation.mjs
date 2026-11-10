import assert from 'node:assert/strict';
import { BUILDINGS, STYLES, sanitizeDesign, designCost, getBuilding } from '../dist/catalog.js?v=20261110-traffic2';
import { CitySimulation, SIZE } from '../dist/simulation.js?v=20261110-traffic2';
const saved = new Map();
globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
let tests = 0;
function test(name, run) { saved.clear(); run(); tests++; console.log(`PASS ${name}`); }
function fresh() { saved.clear(); return new CitySimulation(); }

test('catalog defaults, sanitization, costs and shape', () => {
  assert.equal(Object.keys(BUILDINGS).length, 20); assert.equal(STYLES.length, 7);
  const d = sanitizeDesign({ catalogId: 'tower' }); assert.equal(d.floors, 10);
  assert.equal(sanitizeDesign({ color: 'url(javascript:x)', floors: 999, width: -1 }).color, '#d9cfad');
  assert.equal(sanitizeDesign({ floors: 999 }).floors, 12);
  assert(Math.abs(designCost({ catalogId: 'villa', width: 2 }) - 2 * designCost({ catalogId: 'villa' })) <= 1);
});
test('legacy seed and day advancement are unchanged', () => {
  const c = fresh(); assert.equal(c.population, 168); assert.equal(c.buildingCount, 41); assert.equal(c.netIncome, 215);
  assert.equal(c.connectedRoads, 113); assert.equal(c.happiness, 89); assert.equal(c.canUndo, false);
  for (let i = 0; i < 30; i++) c.tick(); assert.equal(c.day, 31); assert(c.population > 400); assert(c.money > 18000);
});
test('V1 local save migrates and exports V2', () => {
  const old = fresh().exportState(); old.version = 1;
  saved.set('pixel-bay-city-v1', JSON.stringify(old));
  const migrated = new CitySimulation(); assert.equal(migrated.loadedSave, true); assert.equal(migrated.population, 168);
  assert.equal(migrated.exportState().version, 2); migrated.tick(); assert(saved.has('pixel-bay-city-v2'));
});
test('multi-tile footprint, child resolution, capacity count and whole demolition', () => {
  const c = fresh(), initialCapacity = c.housingCapacity;
  const design = sanitizeDesign({ catalogId: 'villa', width: 2, depth: 2 });
  const result = c.place(8, 13, 'residential', design); assert(result.ok);
  assert.deepEqual(c.cell(9, 14).anchor, { x: 8, z: 13 }); assert.equal(c.resolveCell(9, 14), c.cell(8, 13));
  assert.equal(c.buildingCount, 42); assert.equal(c.housingCapacity, initialCapacity + getBuilding(c.cell(8, 13)).capacity);
  const money = c.money; assert.equal(c.place(9, 14, 'commercial').ok, false); assert.equal(c.money, money);
  assert(c.place(9, 14, 'bulldoze').ok); assert.equal(c.cell(8, 13).type, null); assert.equal(c.cell(9, 14).type, null);
  assert.equal(c.buildingCount, 41); assert(c.undo().ok); assert.equal(c.resolveCell(9, 14).design.catalogId, 'villa');
});
test('rotation swaps footprint and road adjacency can be on far outer edge', () => {
  const c = fresh(); assert(c.place(8, 13, 'residential', { catalogId: 'villa', width: 3, depth: 1, rotation: 1 }).ok);
  assert(c.cell(8, 15).anchor); assert.equal(c.cell(9, 13).type, null);
  const d = fresh(); assert(d.place(9, 13, 'residential', { catalogId: 'villa', width: 3, depth: 1 }).ok);
  assert.equal(d.cell(9, 13).connected, true); // Only far edge at x=11 touches road x=12.
});
test('road batches are atomic and shared road tiles are free', () => {
  const c = fresh(), before = c.exportState();
  assert.equal(c.placeMany([{ x: 4, z: 16, type: 'road' }, { x: 6, z: 8, type: 'road' }]).ok, false);
  assert.deepEqual(c.exportState(), before); assert.equal(c.canUndo, false);
  const result = c.placeMany([{ x: 4, z: 17, type: 'road' }, { x: 4, z: 16, type: 'road' }, { x: 4, z: 15, type: 'road' }], '道路笔画');
  assert(result.ok); assert.equal(result.cost, 40); assert.equal(result.count, 2);
  assert(c.undo().ok); assert.equal(c.cell(4, 16).type, null); assert.equal(c.cell(4, 17).type, 'road');
});
test('undo after a day refunds exact expense and preserves unrelated growth and elapsed time', () => {
  const c = fresh(), action = c.place(8, 13, 'residential', { catalogId: 'villa', width: 2, depth: 2 });
  c.tick(); const money = c.money, day = c.day, neighbors = c.cell(6, 9).population;
  assert(c.undo().ok); assert.equal(c.day, day); assert.equal(c.money, money + action.cost); assert.equal(c.cell(6, 9).population, neighbors);
  assert(c.redo().ok); assert.equal(c.money, money); assert.equal(c.day, day); assert(c.cell(9, 14).anchor);
});
test('upgrades are reversible without erasing later resident growth', () => {
  const c = fresh(), before = c.money; assert.equal(c.cell(6, 9).level, 1);
  const action = c.upgrade(6, 9); assert(action.ok); assert.equal(c.cell(6, 9).level, 2);
  c.tick(); const population = c.cell(6, 9).population, money = c.money;
  assert(c.undo().ok); assert.equal(c.cell(6, 9).level, 1); assert.equal(c.cell(6, 9).population, population); assert.equal(c.money, money + action.cost);
  assert(c.redo().ok); assert.equal(c.cell(6, 9).population, population); assert.equal(c.cell(6, 9).level, 2);
  assert.equal(c.upgrade(0, 17).ok, false); assert(c.money < before + 1000);
});
test('terrain edits are empty-only, reversible, and survive import', () => {
  const c = fresh(); assert(c.editTerrain(25, 20, 'water').ok); assert.equal(c.cell(25, 20).terrain, 'water');
  assert.equal(c.editTerrain(0, 17, 'water').ok, false); assert.equal(c.editTerrain(6, 9, 'water').ok, false);
  const exported = c.exportState(); assert(c.importState(JSON.stringify(exported)).ok); assert.equal(c.cell(25, 20).terrain, 'water');
  assert(c.editTerrain(25, 20, 'land').ok); const money = c.money; assert(c.undo().ok); assert.equal(c.money, money + 80); assert.equal(c.cell(25, 20).terrain, 'water');
});
test('schools have capacity-limited coverage; upgrade improves coverage and land value', () => {
  const c = fresh(), rich = c.exportState(); rich.money = 100000; assert(c.importState(rich).ok);
  assert(c.place(8, 13, 'residential', { catalogId: 'tower', width: 3, depth: 3, floors: 12 }).ok);
  assert(c.place(6, 13, 'school', { catalogId: 'school' }).ok);
  const state = c.exportState(); state.cells.forEach(cell => { if (cell.type === 'residential' && !cell.anchor) cell.population = 0; if (cell.type === 'power' || cell.type === 'water') cell.level = 3; });
  state.cells[13 * SIZE + 8].population = getBuilding(c.cell(8, 13)).capacity;
  assert(c.importState(state).ok); assert.equal(c.powerRatio, 1); assert.equal(c.waterRatio, 1);
  const coverage = c.serviceCoverage.education, value = c.cell(8, 13).landValue, capacity = c.serviceCapacity.education;
  assert(coverage > 0 && coverage < 100); assert(c.serviceUsage.education <= capacity);
  assert(c.upgrade(6, 13).ok); assert(c.serviceCapacity.education > capacity); assert(c.serviceCoverage.education > coverage); assert(c.cell(8, 13).landValue > value);
});
test('custom retail requires nearby residential customers', () => {
  const c = fresh(); assert(c.place(27, 18, 'commercial', { catalogId: 'shop' }).ok); assert.equal(c.cell(27, 18).customers, 0); assert.equal(c.cell(27, 18).activity, 0);
  assert(c.place(8, 13, 'commercial', { catalogId: 'shop' }).ok); assert(c.cell(8, 13).customers > 0); assert(c.cell(8, 13).activity > 0);
});
test('corrupt anchors and unknown fields reject atomically; valid exports round-trip', () => {
  const c = fresh(); assert(c.place(8, 13, 'residential', { catalogId: 'villa', width: 2, depth: 2 }).ok);
  const valid = c.exportState(), corrupt = structuredClone(valid); corrupt.cells[14 * SIZE + 9].anchor = { x: 1, z: 1 };
  assert.equal(c.importState(corrupt).ok, false); assert.deepEqual(c.exportState(), valid);
  const unknown = structuredClone(valid); unknown.cells[0].evil = true; assert.equal(c.importState(unknown).ok, false);
  const unsafe = structuredClone(valid); unsafe.cells[13 * SIZE + 8].design.color = 'javascript:bad'; assert.equal(c.importState(unsafe).ok, false);
  assert(c.importState(JSON.stringify(valid)).ok); assert.deepEqual(c.exportState(), valid); assert.equal(c.canUndo, false);
});
test('checkpoints restore last valid city if current save is corrupt', () => {
  const c = fresh(); c.save(); c.tick(); assert(saved.has('pixel-bay-city-backup-v2'));
  saved.set('pixel-bay-city-v2', '{broken'); const restored = new CitySimulation(); assert.equal(restored.loadedSave, true); assert.equal(restored.day, 1); assert(restored.lastMessage.includes('备份'));
});
test('undo history is bounded and new edits clear redo', () => {
  const c = fresh(); for (let i = 0; i < 70; i++) assert(c.editTerrain(25, 20, i % 2 ? 'land' : 'water').ok);
  let count = 0; while (c.canUndo) { c.undo(); count++; } assert.equal(count, 60); assert(c.canRedo);
  assert(c.place(8, 13, 'residential').ok); assert.equal(c.canRedo, false);
});
console.log(`\n${tests} simulation and catalog regression groups passed.`);
