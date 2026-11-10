/** Deterministic city simulation: UI-independent, validated saves and reversible edits. */
import { BUILDINGS, sanitizeDesign, designCost, getBuilding } from './catalog.js?v=20261110-traffic2';
export const SIZE = 32;
const PUBLIC_IDS = ['school', 'hospital', 'fire', 'police', 'library', 'stadium'];
export const TYPES = Object.freeze({
  road: { name: '道路', cost: 20, description: '连接街区；跨越河流自动建桥（₵80）。', color: '#7c91a0', shortcut: '1' },
  residential: { name: '住宅', cost: 120, description: '通路、水电与工作带来人口增长。', color: '#7dc989', shortcut: '2' },
  commercial: { name: '商业', cost: 180, description: '沿街商业创造就业和税收。', color: '#6bbbe4', shortcut: '3' },
  industrial: { name: '工业', cost: 220, description: '创造就业；请远离住宅以减少污染。', color: '#edbb65', shortcut: '4' },
  park: { name: '公园', cost: 150, description: '绿地提升周边幸福感与地价。', color: '#55bca1', shortcut: '5' },
  power: { name: '发电站', cost: 900, description: '接入道路，每级提供 420 单位电力。', color: '#e9d478', shortcut: '6' },
  water: { name: '水务站', cost: 650, description: '接入道路，每级提供 320 单位供水。', color: '#6ccfd5', shortcut: '7' },
  bulldoze: { name: '拆除', cost: 20, description: '清除整栋建筑或道路，支持撤销。', color: '#e58c83', shortcut: '8' },
  inspect: { name: '查看', cost: 0, description: '查看建筑、容量和服务状态。', color: '#dce7e7', shortcut: '9' },
  ...Object.fromEntries(PUBLIC_IDS.map((id, i) => [id, { name: BUILDINGS[id].name, cost: BUILDINGS[id].cost, description: BUILDINGS[id].description, color: ['#d6b474', '#e4b0a2', '#d49177', '#8da8c7', '#bbadcd', '#92bcb0'][i] }])),
});
const SAVE_KEY = 'pixel-bay-city-v2', BACKUP_KEY = 'pixel-bay-city-backup-v2', LEGACY_KEY = 'pixel-bay-city-v1';
const BUILDABLE = new Set(['road', 'residential', 'commercial', 'industrial', 'park', 'power', 'water', ...PUBLIC_IDS]);
const SERVICES = ['education', 'health', 'safety', 'security', 'culture', 'recreation', 'leisure'];
const MILESTONES = [
  { title: '初具规模', description: '让 250 位居民在这里安家，奖励 ₵1,000。', target: 250, reward: 1000 },
  { title: '河湾新城', description: '人口达到 500，奖励 ₵2,500。', target: 500, reward: 2500 },
  { title: '繁荣都市', description: '迎接第 1,000 位居民，奖励 ₵5,000。', target: 1000, reward: 5000 },
  { title: '城市之光', description: '建成一座拥有 2,000 位居民的城市，奖励 ₵10,000。', target: 2000, reward: 10000 },
];
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const terrainAt = (x, z) => Math.abs(x - (22 + Math.floor(2 * Math.sin(z * 0.25)))) <= 1 ? 'water' : 'land';
const variantAt = (x, z) => (x * 13 + z * 7 + x * z) % 8;
const neighbors = (x, z) => [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]];
const fail = message => ({ ok: false, changed: false, message });
const copy = value => JSON.parse(JSON.stringify(value));
const cleanKeys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
function storage() { try { return globalThis.localStorage ?? null; } catch { return null; } }
function dimensions(design) {
  const w = design?.width || 1, d = design?.depth || 1;
  return design?.rotation % 2 ? [d, w] : [w, d];
}
function distance(a, b) {
  const [aw, ad] = dimensions(a.design), [bw, bd] = dimensions(b.design);
  return Math.max(0, a.x - b.x - bw + 1, b.x - a.x - aw + 1) + Math.max(0, a.z - b.z - bd + 1, b.z - a.z - ad + 1);
}
function rawCell(cell) {
  const value = { x: cell.x, z: cell.z, terrain: cell.terrain, type: cell.type, level: cell.level, variant: cell.variant, population: cell.population || 0 };
  if (cell.design) value.design = copy(cell.design);
  if (cell.anchor) value.anchor = { x: cell.anchor.x, z: cell.anchor.z };
  return value;
}
function utilityUse(cell, kind, population = cell.population || 0) {
  const meta = getBuilding(cell), area = (cell.design?.width || 1) * (cell.design?.depth || 1);
  let amount;
  if (kind === 'power') {
    amount = cell.type === 'residential' ? 3 * area + Math.ceil(population * 0.12)
      : cell.type === 'commercial' ? 7 * (cell.design ? area * (0.7 + cell.design.floors * 0.3) : cell.level)
      : cell.type === 'industrial' ? 16 * cell.level : cell.type === 'park' ? area
      : cell.type === 'water' ? 12 : cell.type === 'power' ? 0 : Math.max(3, Math.ceil((meta.serviceCapacity || 80) / 40));
    if (cell.design?.components.solar) amount *= 0.85;
  } else {
    amount = cell.type === 'residential' ? 2 * area + Math.ceil(population * 0.1)
      : cell.type === 'commercial' ? 4 * (cell.design ? area * (0.7 + cell.design.floors * 0.3) : cell.level)
      : cell.type === 'industrial' ? 8 * cell.level : cell.type === 'park' ? area
      : cell.type === 'power' ? 8 : cell.type === 'water' ? 0 : Math.max(2, Math.ceil((meta.serviceCapacity || 80) / 60));
    if (cell.design?.components.pool) amount += 3 * area;
  }
  return Math.ceil(amount);
}
function validDesign(value) {
  if (!cleanKeys(value, ['catalogId', 'style', 'color', 'roof', 'floors', 'width', 'depth', 'rotation', 'components']) || !Object.hasOwn(BUILDINGS, value.catalogId)) return false;
  const normalized = sanitizeDesign(value);
  if (!['catalogId', 'style', 'roof', 'floors', 'width', 'depth', 'rotation'].every(key => value[key] === normalized[key])) return false;
  if (typeof value.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.color)) return false;
  if (!cleanKeys(value.components, ['garden', 'wall', 'garage', 'pool', 'terrace', 'solar'])) return false;
  return Object.keys(normalized.components).every(key => typeof value.components[key] === 'boolean');
}
function validateState(input) {
  try {
    if (typeof input === 'string' && input.length > 2000000) return null;
    const data = typeof input === 'string' ? JSON.parse(input) : input;
    if (!cleanKeys(data, ['version', 'size', 'money', 'day', 'tax', 'speed', 'milestone', 'cells']) || ![1, 2].includes(data.version) || data.size !== SIZE) return null;
    if (!finite(data.money, -1000000000, 1000000000) || !integer(data.day, 1, 1000000) || !integer(data.tax, 1, 20) || ![1, 2, 3].includes(data.speed) || !integer(data.milestone, 0, MILESTONES.length)) return null;
    if (!Array.isArray(data.cells) || data.cells.length !== SIZE * SIZE) return null;
    const cells = [];
    for (let index = 0; index < data.cells.length; index++) {
      const c = data.cells[index], x = index % SIZE, z = Math.floor(index / SIZE);
      if (!cleanKeys(c, ['x', 'z', 'terrain', 'type', 'level', 'variant', 'population', 'design', 'anchor']) || c.x !== x || c.z !== z) return null;
      if (!['land', 'water'].includes(c.terrain) || (data.version === 1 && c.terrain !== terrainAt(x, z))) return null;
      if (c.type !== null && !BUILDABLE.has(c.type)) return null;
      if (!integer(c.level, 1, 3) || !integer(c.variant, 0, 7) || !integer(c.population, 0, 1000000)) return null;
      if (c.terrain === 'water' && c.type !== null && c.type !== 'road') return null;
      if (c.type !== 'residential' && c.population !== 0) return null;
      if (data.version === 1 && (c.design || c.anchor || PUBLIC_IDS.includes(c.type))) return null;
      const next = { x, z, terrain: c.terrain, type: c.type, level: c.level, variant: c.variant, population: c.population, connected: false };
      if (c.design !== undefined) {
        if (!validDesign(c.design) || BUILDINGS[c.design.catalogId].baseType !== c.type || c.anchor !== undefined) return null;
        next.design = sanitizeDesign(c.design);
      }
      if (c.anchor !== undefined) {
        if (!cleanKeys(c.anchor, ['x', 'z']) || !integer(c.anchor.x, 0, SIZE - 1) || !integer(c.anchor.z, 0, SIZE - 1) || (c.anchor.x === x && c.anchor.z === z) || !c.type || c.type === 'road' || c.population !== 0) return null;
        next.anchor = { x: c.anchor.x, z: c.anchor.z };
      }
      if (c.type === 'residential' && !c.anchor && c.population > getBuilding(next).capacity) return null;
      cells.push(next);
    }
    // Reject orphan children, overlapping footprints, holes and mismatched anchors.
    for (const c of cells) {
      if (c.anchor) {
        const parent = cells[c.anchor.z * SIZE + c.anchor.x];
        if (!parent?.design || parent.anchor || parent.type !== c.type || parent.level !== c.level) return null;
        const [w, d] = dimensions(parent.design);
        if (c.x < parent.x || c.x >= parent.x + w || c.z < parent.z || c.z >= parent.z + d) return null;
      } else if (c.design) {
        const [w, d] = dimensions(c.design);
        if (c.x + w > SIZE || c.z + d > SIZE) return null;
        for (let dz = 0; dz < d; dz++) for (let dx = 0; dx < w; dx++) {
          if (!dx && !dz) continue;
          const child = cells[(c.z + dz) * SIZE + c.x + dx];
          if (child?.anchor?.x !== c.x || child?.anchor?.z !== c.z || child.type !== c.type || child.terrain !== 'land') return null;
        }
      }
    }
    if (cells[17 * SIZE].terrain !== 'land') return null;
    return { cells, money: data.money, day: data.day, tax: data.tax, speed: data.speed, milestone: data.milestone };
  } catch { return null; }
}

export class CitySimulation {
  constructor() {
    this.revision = 0; this.lastMessage = ''; this._undo = []; this._redo = [];
    this.loadedSave = this._load();
    if (!this.loadedSave) this._seed();
    this.recompute();
  }
  _emptyCells() {
    return Array.from({ length: SIZE * SIZE }, (_, index) => {
      const x = index % SIZE;
      const z = Math.floor(index / SIZE);
      return { x, z, terrain: terrainAt(x, z), type: null, level: 1, variant: variantAt(x, z), population: 0, connected: false };
    });
  }

  _seed() {
    this.cells = this._emptyCells();
    this.money = 18000;
    this.day = 1;
    this.tax = 9;
    this.speed = 1;
    this.milestone = 0;
    this.lastMessage = '欢迎来到方寸湾！沿道路建设街区，让城市自然生长。';
    const put = (x, z, type, population = 0) => Object.assign(this.cell(x, z), { type, population });
    for (let x = 0; x < SIZE; x++) put(x, 17, 'road');
    for (const x of [7, 12, 17]) for (let z = 7; z <= 26; z++) put(x, z, 'road');
    for (const z of [10, 23]) for (let x = 4; x <= 18; x++) put(x, z, 'road');
    const homes = [
      [6, 8], [8, 8], [6, 9], [8, 9], [6, 11], [8, 11], [6, 12], [8, 12],
      [11, 8], [13, 8], [11, 9], [13, 9], [11, 11], [13, 11], [11, 12], [13, 12],
      [6, 18], [8, 18], [6, 19], [8, 19], [11, 18], [13, 18], [11, 19], [13, 19],
    ];
    homes.forEach(([x, z]) => put(x, z, 'residential', 7));
    [[6, 8], [8, 11], [11, 9], [13, 12], [11, 18], [13, 19]].forEach(([x, z]) => { this.cell(x, z).level = 2; });
    [[11, 8], [13, 11]].forEach(([x, z]) => { this.cell(x, z).level = 3; });
    [[11, 14], [13, 14], [11, 16], [13, 16], [16, 16], [18, 16], [16, 18]].forEach(([x, z]) => put(x, z, 'commercial'));
    [[13, 14], [11, 16], [16, 16]].forEach(([x, z]) => { this.cell(x, z).level = 2; });
    [[11, 14], [13, 16]].forEach(([x, z]) => { this.cell(x, z).level = 3; });
    [[16, 24], [18, 24], [16, 25], [18, 25]].forEach(([x, z]) => put(x, z, 'industrial'));
    [[9, 9], [14, 9], [9, 18], [14, 18]].forEach(([x, z]) => put(x, z, 'park'));
    put(18, 26, 'power');
    put(18, 13, 'water');
    this.revision++;
  }

  cell(x, z) { return integer(x, 0, SIZE - 1) && integer(z, 0, SIZE - 1) ? this.cells[z * SIZE + x] ?? null : null; }
  resolveCell(x, z) { const c = this.cell(x, z); return c?.anchor ? this.cell(c.anchor.x, c.anchor.z) : c; }
  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }
  _footprint(cell) {
    const [w, d] = dimensions(cell.design), result = [];
    for (let dz = 0; dz < d; dz++) for (let dx = 0; dx < w; dx++) result.push(this.cell(cell.x + dx, cell.z + dz));
    return result;
  }
  _adjacentRoad(cell, requireConnected = true) {
    return this._footprint(cell).some(c => c && neighbors(c.x, c.z).some(([x, z]) => {
      const next = this.cell(x, z); return next?.type === 'road' && (!requireConnected || next.connected);
    }));
  }
  _clear(cell) {
    const blank = { x: cell.x, z: cell.z, terrain: cell.terrain, type: null, level: 1, variant: cell.variant, population: 0, connected: false };
    this.cells[cell.z * SIZE + cell.x] = blank;
  }
  _transaction(label, action) {
    const before = this.cells.map(rawCell), money = this.money, message = this.lastMessage;
    const result = action();
    if (!result.ok) {
      this.cells = before.map(c => ({ ...c, connected: false })); this.money = money; this.lastMessage = message; this.recompute(); return result;
    }
    const patches = [];
    this.cells.forEach((c, index) => { const after = rawCell(c); if (JSON.stringify(before[index]) !== JSON.stringify(after)) patches.push({ index, before: before[index], after }); });
    if (!patches.length) return { ...result, changed: false };
    this._undo.push({ label, patches, moneyDelta: this.money - money });
    if (this._undo.length > 60) this._undo.shift();
    this._redo = []; this.revision++; this.lastMessage = result.message; this.recompute(); this.save();
    return { ...result, changed: true, cost: money - this.money };
  }
  place(x, z, type, design = null) {
    if (type === 'inspect') {
      const c = this.resolveCell(x, z); if (!c) return fail('这里超出了城市边界。');
      return { ok: true, changed: false, message: c.type ? `${getBuilding(c).name} · ${c.connected ? '道路已连通' : '未接入城市道路'}` : c.terrain === 'water' ? '河流' : '空地' };
    }
    return this._transaction(type === 'bulldoze' ? '拆除建筑' : '建造建筑', () => this._placeSingle(x, z, type, design));
  }
  _placeSingle(x, z, type, inputDesign = null) {
    let cell = this.cell(x, z);
    if (!cell) return fail('这里超出了城市边界。');
    // Catalog IDs are accepted as a convenience; existing base-type calls are unchanged.
    if (Object.hasOwn(BUILDINGS, type) && !Object.hasOwn(TYPES, type)) { inputDesign = { ...inputDesign, catalogId: type }; type = BUILDINGS[type].baseType; }
    if (!Object.prototype.hasOwnProperty.call(TYPES, type) || type === 'inspect') return fail('请选择一种有效的建造工具。');
    if (type === 'bulldoze') {
      cell = this.resolveCell(x, z); if (!cell.type) return fail('这里没有需要拆除的建筑。');
      const footprint = this._footprint(cell), cost = footprint.length * 20;
      if (this.money < cost) return fail(`资金不足，拆除需要 ₵${cost}。`);
      this.money -= cost; footprint.forEach(c => this._clear(c)); this.recompute();
      return { ok: true, changed: true, message: `地块已清理 · −₵${cost}` };
    }
    let design = inputDesign == null ? null : sanitizeDesign(inputDesign);
    if (design && BUILDINGS[design.catalogId].baseType !== type) return fail('建筑方案与当前建造类型不匹配。');
    if (cell.type) return fail('地块已被占用，请先拆除原建筑。');
    const candidate = { ...cell, design }, footprint = this._footprint(candidate);
    if (footprint.some(c => !c)) return fail('建筑占地超出了城市边界。');
    if (footprint.some(c => c.type)) return fail('建筑占地内已有建筑或道路，无法覆盖。');
    if (footprint.some(c => c.terrain === 'water') && type !== 'road') return fail('建筑占地必须全部为陆地，河面只可铺路。');
    if (type !== 'road' && !this._adjacentRoad(candidate)) return fail('建筑外缘必须紧邻通往城市入口的道路。');
    const cost = design ? designCost(design) : type === 'road' && cell.terrain === 'water' ? 80 : TYPES[type].cost;
    if (this.money < cost) return fail(`资金不足，建造需要 ₵${cost.toLocaleString('zh-CN')}。`);
    this.money -= cost;
    footprint.forEach(c => {
      Object.assign(c, { type, level: 1, population: 0, connected: false });
      if (c === cell) { if (design) c.design = design; }
      else c.anchor = { x, z };
    });
    this.recompute();
    return { ok: true, changed: true, message: `${design ? BUILDINGS[design.catalogId].name : cell.terrain === 'water' ? '桥梁' : TYPES[type].name}已建成 · −₵${cost}` };
  }
  placeMany(items, label = '批量建造') {
    if (!Array.isArray(items) || !items.length || items.length > 512) return fail('批量操作需要 1–512 个有效地块。');
    return this._transaction(String(label).slice(0, 40), () => {
      let count = 0;
      for (const item of items) {
        if (!item || typeof item !== 'object') return fail('批量操作中包含无效地块。');
        const existing = this.cell(item.x, item.z);
        // A road stroke may cross a road that was already there without charging twice.
        if (item.type === 'road' && existing?.type === 'road' && !item.design) continue;
        const result = this._placeSingle(item.x, item.z, item.type, item.design);
        if (!result.ok) return fail(`整组操作已取消：${result.message}`);
        count++;
      }
      return { ok: true, changed: count > 0, count, message: count ? `${label}完成 · ${count} 处变更` : '这些道路已经建成，无需重复铺设。' };
    });
  }
  editTerrain(x, z, terrain) {
    return this._transaction('编辑地形', () => {
      const c = this.cell(x, z);
      if (!c || !['land', 'water'].includes(terrain)) return fail('请选择有效的地块与地形。');
      if (x === 0 && z === 17) return fail('城市入口的地形不能改变。');
      if (c.type) return fail('请先拆除该地块上的建筑或道路。');
      if (c.terrain === terrain) return { ok: true, changed: false, message: '这里已经是所选地形。' };
      const cost = terrain === 'land' ? 80 : 50;
      if (this.money < cost) return fail(`资金不足，地形编辑需要 ₵${cost}。`);
      c.terrain = terrain; this.money -= cost;
      return { ok: true, changed: true, message: `${terrain === 'land' ? '填土造地' : '开挖水域'}完成 · −₵${cost}` };
    });
  }
  upgrade(x, z) {
    return this._transaction('升级建筑', () => {
      const c = this.resolveCell(x, z);
      if (!c?.type || c.type === 'road') return fail('请选择一栋可升级的建筑。');
      if (c.level >= 3) return fail('这栋建筑已经达到最高等级。');
      const meta = getBuilding(c), cost = Math.round(meta.cost * 0.6 * c.level);
      if (this.money < cost) return fail(`资金不足，升级需要 ₵${cost}。`);
      this.money -= cost; c.level++; this._footprint(c).forEach(tile => { tile.level = c.level; });
      return { ok: true, changed: true, message: `${meta.name}已升至 Lv.${c.level} · −₵${cost}` };
    });
  }
  _history(direction) {
    const source = direction === 'undo' ? this._undo : this._redo, target = direction === 'undo' ? this._redo : this._undo;
    if (!source.length) return fail(direction === 'undo' ? '还没有可以撤销的建造操作。' : '还没有可以重做的操作。');
    const entry = source[source.length - 1], delta = direction === 'undo' ? -entry.moneyDelta : entry.moneyDelta;
    if (delta < 0 && this.money + delta < 0) return fail('当前资金不足，无法重做这项操作。');
    for (const patch of entry.patches) {
      const snapshot = copy(direction === 'undo' ? patch.before : patch.after);
      const current = this.cells[patch.index];
      // Upgrades change capacity, not the lives that progressed after the edit.
      // A new/demolished building still restores its own complete footprint.
      if (patch.before.type && patch.before.type === patch.after.type && JSON.stringify(patch.before.design) === JSON.stringify(patch.after.design) && patch.before.terrain === patch.after.terrain) {
        const levelDelta = direction === 'undo' ? patch.before.level - patch.after.level : patch.after.level - patch.before.level;
        snapshot.level = clamp(current.level + levelDelta, 1, 3);
        snapshot.population = snapshot.type === 'residential' && !snapshot.anchor ? Math.min(current.population, getBuilding(snapshot).capacity) : 0;
      }
      this.cells[patch.index] = { ...snapshot, connected: false };
    }
    this.money += delta; source.pop(); target.push(entry); this.recompute(); this.revision++;
    this.lastMessage = `${direction === 'undo' ? '已撤销' : '已重做'}：${entry.label}`; this.save();
    return { ok: true, changed: true, message: this.lastMessage };
  }
  undo() { return this._history('undo'); }
  redo() { return this._history('redo'); }
  recompute() {
    this.cells.forEach(c => { c.connected = false; });
    const entrance = this.cell(0, 17), queue = [];
    if (entrance?.type === 'road') { entrance.connected = true; queue.push(entrance); }
    for (let i = 0; i < queue.length; i++) for (const [x, z] of neighbors(queue[i].x, queue[i].z)) {
      const next = this.cell(x, z); if (next?.type === 'road' && !next.connected) { next.connected = true; queue.push(next); }
    }
    const buildings = this.cells.filter(c => c.type && c.type !== 'road' && !c.anchor);
    buildings.forEach(c => { c.connected = this._adjacentRoad(c); delete c.customers; delete c.guests; delete c.serviceLoad; const service=getBuilding(c).service; if(service==='retail')c.customers=0; if(service==='tourism')c.guests=0; if(SERVICES.includes(service))c.serviceLoad=0; });
    const active = buildings.filter(c => c.connected), homes = buildings.filter(c => c.type === 'residential');
    const parks = active.filter(c => c.type === 'park'), industry = active.filter(c => c.type === 'industrial');
    this.population = homes.reduce((sum, c) => sum + c.population, 0);
    this.housingCapacity = homes.reduce((sum, c) => sum + getBuilding(c).capacity, 0);
    this.powerCapacity = active.reduce((sum, c) => sum + (c.type === 'power' ? getBuilding(c).capacity : 0), 0);
    this.waterCapacity = active.reduce((sum, c) => sum + (c.type === 'water' ? getBuilding(c).capacity : 0), 0);
    this.powerUsed = active.reduce((sum, c) => sum + utilityUse(c, 'power'), 0);
    this.waterUsed = active.reduce((sum, c) => sum + utilityUse(c, 'water'), 0);
    this.powerRatio = this.powerUsed ? Math.min(1, this.powerCapacity / this.powerUsed) : 1;
    this.waterRatio = this.waterUsed ? Math.min(1, this.waterCapacity / this.waterUsed) : 1;
    const serviceRatio = Math.min(this.powerRatio, this.waterRatio);
    buildings.forEach(c => { c.powered = c.connected && this.powerRatio >= 1; c.watered = c.connected && this.waterRatio >= 1; c.activity = c.connected ? serviceRatio : 0; c.coverage = Object.fromEntries(SERVICES.map(key => [key, 0])); });
    this.serviceCapacity = Object.fromEntries(SERVICES.map(key => [key, 0]));
    this.serviceUsage = Object.fromEntries(SERVICES.map(key => [key, 0]));
    for (const provider of active) {
      const meta = getBuilding(provider), service = meta.service;
      if (!SERVICES.includes(service)) continue;
      const capacity = Math.floor(meta.serviceCapacity * serviceRatio), fraction = service === 'education' ? 0.24 : ['culture', 'recreation', 'leisure'].includes(service) ? 0.5 : 1;
      const covered = homes.filter(home => home.connected && distance(home, provider) <= meta.radius);
      const demand = covered.reduce((sum, home) => sum + home.population * fraction, 0);
      const ratio = demand ? Math.min(1, capacity / demand) : 0;
      this.serviceCapacity[service] += capacity;
      this.serviceUsage[service] += Math.min(capacity, demand);
      provider.serviceLoad = Math.round(Math.min(capacity, demand));
      covered.forEach(home => { home.coverage[service] = Math.min(1, home.coverage[service] + ratio); });
    }
    this.serviceCoverage = Object.fromEntries(SERVICES.map(service => [service, this.population ? Math.round(homes.reduce((sum, home) => sum + home.population * home.coverage[service], 0) / this.population * 100) : 0]));
    this.serviceUsage = Object.fromEntries(SERVICES.map(service => {
      const fraction = service === 'education' ? 0.24 : ['culture', 'recreation', 'leisure'].includes(service) ? 0.5 : 1;
      return [service, Math.round(homes.reduce((sum, home) => sum + home.population * home.coverage[service] * fraction, 0))];
    }));
    const retailers = active.filter(c => c.design && getBuilding(c).service === 'retail');
    const retailMeta = new Map(retailers.map(retailer => [retailer, getBuilding(retailer)]));
    const retailCustomers = new Map(retailers.map(retailer => [retailer, 0]));
    for (const home of homes) {
      if (!home.connected || !home.population) continue;
      const options = retailers.filter(retailer => distance(home, retailer) <= retailMeta.get(retailer).radius);
      const share = options.length ? home.population / options.length : 0;
      options.forEach(retailer => retailCustomers.set(retailer, retailCustomers.get(retailer) + share));
    }
    for (const retailer of retailers) {
      const meta = retailMeta.get(retailer);
      const customers = retailCustomers.get(retailer) * Math.max(0.4, 1 - Math.max(0, this.tax - 9) * 0.03);
      retailer.customers = Math.round(Math.min(customers, meta.serviceCapacity));
      retailer.activity = Math.min(1, customers / Math.max(1, meta.serviceCapacity * 0.55)) * serviceRatio;
    }
    const hotels = active.filter(c => c.design && getBuilding(c).service === 'tourism');
    this.tourists = Math.round(parks.reduce((sum, c) => sum + (c.design?.width || 1) * (c.design?.depth || 1) * 10, 0) + active.filter(c => c.type === 'library' || c.type === 'stadium').length * 20 + this.population * 0.04);
    hotels.forEach(hotel => { const capacity = getBuilding(hotel).serviceCapacity; hotel.guests = Math.round(Math.min(capacity, this.tourists / hotels.length)); hotel.activity = Math.min(1, hotel.guests / Math.max(1, capacity * 0.6)) * serviceRatio; });
    this.jobs = Math.floor(active.reduce((sum, c) => sum + getBuilding(c).jobs * c.activity, 0));
    this.workers = Math.ceil(this.population * 0.5); this.employed = Math.min(this.jobs, this.workers);
    this.unemployment = this.workers ? Math.round((1 - this.employed / this.workers) * 100) : 0;
    let parkCoverage = 0, pollutionExposure = 0, landValue = 0;
    homes.forEach(c => {
      c.nearPark = parks.some(park => distance(c, park) <= getBuilding(park).radius) || c.design?.components.garden === true;
      c.pollution = industry.some(factory => distance(c, factory) <= 3);
      if (c.nearPark) parkCoverage++; if (c.pollution) pollutionExposure++;
      c.landValue = Math.round(clamp(48 + (c.nearPark ? 18 : 0) + c.coverage.education * 10 + c.coverage.health * 10 + c.coverage.safety * 5 + c.coverage.security * 5 + c.coverage.culture * 5 - (c.pollution ? 24 : 0) - (!c.connected ? 20 : 0), 0, 100));
      landValue += c.landValue;
    });
    this.landValue = Math.round(landValue / Math.max(1, homes.length));
    const count = Math.max(1, homes.length), disconnected = homes.filter(c => !c.connected).length / count;
    const coverage = ['education', 'health', 'safety', 'security'].reduce((sum, service) => sum + this.serviceCoverage[service] / 100, 0) / 4;
    const civicDemand = clamp((this.population - 250) / 750, 0, 1);
    this.happiness = Math.round(clamp(78 + parkCoverage / count * 13 - pollutionExposure / count * 24 - Math.max(0, this.tax - 9) * 3 - this.unemployment * 0.38 - (1 - serviceRatio) * 42 - disconnected * 30 - (this.money < 0 ? 12 : 0) + coverage * 12 - civicDemand * (1 - coverage) * 12, 0, 100));
    const commercialLevel = active.filter(c => c.type === 'commercial' && !c.design).reduce((sum, c) => sum + c.level, 0);
    const industrialLevel = industry.reduce((sum, c) => sum + c.level, 0);
    const customRevenue = active.filter(c => c.design && c.type === 'commercial').reduce((sum, c) => sum + getBuilding(c).jobs * c.activity * 0.38 + (c.customers || 0) * 0.08 + (c.guests || 0) * 0.4, 0);
    this.income = Math.round((this.population * this.tax * 0.17 + this.employed * this.tax * 0.11 + commercialLevel * 8 + industrialLevel * 10 + customRevenue) * (0.5 + serviceRatio * 0.5));
    this.roadCount = this.cells.filter(c => c.type === 'road').length; this.connectedRoads = queue.length;
    this.buildingCount = buildings.length; this.connectedBuildings = active.length;
    this.expenses = Math.round(this.roadCount * 0.2 + buildings.reduce((sum, c) => sum + getBuilding(c).maintenance, 0));
    this.netIncome = this.income - this.expenses;
    this.demand = {
      residential: Math.round(clamp((this.jobs - this.workers) * 0.5 + this.happiness * 0.5 - (1 - serviceRatio) * 100, 0, 100)),
      commercial: Math.round(clamp(40 + this.population * 0.1 - commercialLevel * 7 - retailers.length * 5, 0, 100)),
      industrial: Math.round(clamp(30 + this.population * 0.08 - industrialLevel * 9, 0, 100)),
    };
    this.cells.filter(c => c.anchor).forEach(c => {
      const anchor = this.resolveCell(c.x, c.z); c.connected = anchor.connected; c.level = anchor.level; c.population = 0; c.powered = anchor.powered; c.watered = anchor.watered;
    });
    return this.getStats();
  }
  tick() {
    this.day++; this.recompute(); this.money = clamp(this.money + this.netIncome, -1000000000, 1000000000);
    let projectedPopulation = this.population, powerHeadroom = this.powerCapacity - this.powerUsed, waterHeadroom = this.waterCapacity - this.waterUsed;
    const serviceReady = this.powerRatio >= 1 && this.waterRatio >= 1 && this.powerCapacity > 0 && this.waterCapacity > 0;
    const homes = this.cells.filter(c => c.type === 'residential' && !c.anchor), offset = homes.length ? this.day % homes.length : 0;
    for (let index = 0; index < homes.length; index++) {
      const c = homes[(index + offset) % homes.length];
      if ((!c.connected || this.happiness < 35 || !serviceReady) && c.population > 0) {
        if (!c.connected || this.day % 3 === 0) { const loss = Math.max(1, Math.floor(c.population * 0.02)); c.population = Math.max(0, c.population - loss); projectedPopulation -= loss; }
        continue;
      }
      if (!c.design && c.population >= getBuilding(c).capacity && c.level < 3 && this.population >= (c.level === 1 ? 250 : 650) && this.happiness >= 65 && serviceReady && c.connected) c.level++;
      const capacity = getBuilding(c).capacity, growth = c.design ? Math.min(6, Math.max(1, Math.ceil(capacity * 0.025))) : 1;
      for (let resident = 0; resident < growth; resident++) {
        const nextPower = utilityUse(c, 'power', c.population + 1) - utilityUse(c, 'power'), nextWater = utilityUse(c, 'water', c.population + 1) - utilityUse(c, 'water');
        if (!(c.connected && serviceReady && this.happiness >= 50 && this.tax <= 16 && this.money >= 0 && c.population < capacity && projectedPopulation < this.jobs * 2 + 20 && powerHeadroom >= nextPower && waterHeadroom >= nextWater)) break;
        c.population++; projectedPopulation++; powerHeadroom -= nextPower; waterHeadroom -= nextWater;
      }
    }
    if (this.day % 8 === 0 && serviceReady && this.workers > this.jobs * 0.86 && this.population >= 250) {
      const maxLevel = this.population >= 650 ? 3 : 2;
      const business = this.cells.find(c => ['commercial', 'industrial'].includes(c.type) && !c.anchor && !c.design && c.connected && c.level < maxLevel);
      if (business) business.level++;
    }
    this.recompute();
    while (this.milestone < MILESTONES.length && this.population >= MILESTONES[this.milestone].target) {
      const goal = MILESTONES[this.milestone]; this.money += goal.reward; this.milestone++;
      this.lastMessage = `里程碑达成：${goal.title}！城市获得 ₵${goal.reward.toLocaleString('zh-CN')} 奖励。`;
    }
    this.revision++; this.save(); return this.getStats();
  }
  setTax(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return this.tax;
    this.tax = clamp(Math.round(value), 1, 20); this.recompute(); this.revision++; this.save(); return this.tax;
  }
  goals() {
    return MILESTONES.map((goal, index) => ({ title: goal.title, description: goal.description, progress: Math.min(this.population, goal.target), target: goal.target, done: this.milestone > index || this.population >= goal.target }));
  }
  getStats() {
    return {
      money: this.money, day: this.day, population: this.population, happiness: this.happiness,
      income: this.income, expenses: this.expenses, netIncome: this.netIncome, housingCapacity: this.housingCapacity,
      powerUsed: this.powerUsed, powerCapacity: this.powerCapacity, waterUsed: this.waterUsed, waterCapacity: this.waterCapacity,
      powerRatio: this.powerRatio, waterRatio: this.waterRatio, jobs: this.jobs, workers: this.workers, employed: this.employed,
      unemployment: this.unemployment, tax: this.tax, speed: this.speed, milestone: this.milestone, roadCount: this.roadCount,
      connectedRoads: this.connectedRoads, buildingCount: this.buildingCount, connectedBuildings: this.connectedBuildings,
      demand: { ...this.demand }, revision: this.revision, canUndo: this.canUndo, canRedo: this.canRedo,
      serviceCoverage: { ...this.serviceCoverage }, serviceCapacity: { ...this.serviceCapacity }, serviceUsage: { ...this.serviceUsage },
      landValue: this.landValue, tourists: this.tourists,
    };
  }
  exportState() {
    return { version: 2, size: SIZE, money: this.money, day: this.day, tax: this.tax, speed: [1, 2, 3].includes(this.speed) ? this.speed : 1, milestone: this.milestone, cells: this.cells.map(rawCell) };
  }
  importState(input) {
    const valid = validateState(input);
    if (!valid) return fail('存档无效或已损坏：城市数据、建筑占地或版本校验未通过。当前城市未改变。');
    Object.assign(this, valid); this._undo = []; this._redo = []; this.loadedSave = true; this.revision++; this.recompute(); this.save();
    this.lastMessage = '城市存档已导入，可以继续建设。';
    return { ok: true, changed: true, message: this.lastMessage };
  }
  save() {
    try {
      const target = storage(); if (!target) return false;
      const value = JSON.stringify(this.exportState()), previous = target.getItem(SAVE_KEY);
      // A full backup quota must not prevent replacing the smaller primary save.
      try { if (previous && previous !== value && validateState(previous)) target.setItem(BACKUP_KEY, previous); } catch {}
      target.setItem(SAVE_KEY, value); return true;
    } catch { return false; }
  }
  _load() {
    try {
      const target = storage(); if (!target) return false;
      for (const key of [SAVE_KEY, BACKUP_KEY, LEGACY_KEY]) {
        const raw = target.getItem(key); if (!raw) continue;
        const valid = validateState(raw); if (!valid) continue;
        Object.assign(this, valid);
        this.lastMessage = key === BACKUP_KEY ? '主存档损坏，已恢复上一次有效备份。' : key === LEGACY_KEY ? '已升级旧版城市存档，欢迎回来。' : '已载入城市存档，欢迎回来。';
        return true;
      }
      return false;
    } catch { return false; }
  }
  reset() {
    this._seed(); this.loadedSave = false; this._undo = []; this._redo = []; this.recompute(); this.save(); return this.getStats();
  }
}
