/** Functional building catalog shared by the studio, renderer and simulation. */
const entry = (id, name, category, baseType, cost, maintenance, jobs, capacity, floors, description, extra = {}) =>
  Object.freeze({ id, name, category, baseType, description, cost, maintenance, jobs, capacity, floors, width: 1, depth: 1, ...extra });

export const BUILDINGS = Object.freeze({
  villa: entry('villa', '花园别墅', 'residential', 'residential', 240, 3, 0, 8, 2, '低密度住宅，适合安静的花园街区。'),
  townhouse: entry('townhouse', '联排住宅', 'residential', 'residential', 330, 4, 0, 14, 3, '紧凑的沿街住宅，在空间与生活品质间取得平衡。'),
  apartment: entry('apartment', '城市公寓', 'residential', 'residential', 550, 7, 0, 22, 5, '提供较多住宅容量，需要稳定水电与就业。'),
  tower: entry('tower', '高层住宅', 'residential', 'residential', 950, 12, 0, 28, 10, '容纳更多居民，也会带来更高的公共服务需求。'),
  manor: entry('manor', '庭院庄园', 'residential', 'residential', 720, 8, 0, 10, 3, '宽裕舒适的独立住宅，适合搭配庭院与泳池。'),
  shop: entry('shop', '街角商店', 'commercial', 'commercial', 210, 4, 8, 0, 1, '依靠附近居民消费运营，提供日常购物与就业。', { service: 'retail', radius: 5, serviceCapacity: 45 }),
  supermarket: entry('supermarket', '社区超市', 'commercial', 'commercial', 480, 9, 18, 0, 2, '服务周边社区，客源越充分，岗位和税收越稳定。', { service: 'retail', radius: 7, serviceCapacity: 110 }),
  mall: entry('mall', '购物中心', 'commercial', 'commercial', 1250, 22, 40, 0, 4, '覆盖更大的消费商圈，适合人口密集区域。', { service: 'retail', radius: 9, serviceCapacity: 260 }),
  office: entry('office', '商务写字楼', 'commercial', 'commercial', 1400, 24, 55, 0, 8, '提供大量办公岗位，无工业污染。', { service: 'office' }),
  hotel: entry('hotel', '河湾酒店', 'commercial', 'commercial', 1100, 20, 26, 0, 7, '公园、文化设施与城市人口带来游客和入住收入。', { service: 'tourism', radius: 10, serviceCapacity: 85 }),
  market: entry('market', '露天市集', 'commercial', 'commercial', 340, 6, 12, 0, 1, '轻量的社区商业，依靠步行范围内居民经营。', { service: 'retail', radius: 6, serviceCapacity: 80 }),
  communityPark: entry('communityPark', '社区公园', 'park', 'park', 190, 6, 0, 0, 1, '让附近街区更宜居，提升幸福感与地价。', { service: 'leisure', radius: 5, serviceCapacity: 160 }),
  centralPark: entry('centralPark', '中央公园', 'park', 'park', 750, 16, 5, 0, 1, '面向更大街区的公共绿地，也吸引游客。', { service: 'leisure', radius: 8, serviceCapacity: 420 }),
  botanical: entry('botanical', '植物园', 'park', 'park', 980, 19, 8, 0, 1, '绿色游园为居民和游客提供休闲去处。', { service: 'leisure', radius: 7, serviceCapacity: 320 }),
  school: entry('school', '社区学校', 'public', 'school', 1100, 24, 16, 0, 3, '为覆盖范围内的学生提供学位，改善教育与地价。', { service: 'education', radius: 7, serviceCapacity: 180 }),
  hospital: entry('hospital', '市立医院', 'public', 'hospital', 1700, 38, 26, 0, 5, '为附近居民提供医疗服务，受服务容量限制。', { service: 'health', radius: 8, serviceCapacity: 260 }),
  fire: entry('fire', '消防站', 'public', 'fire', 850, 20, 12, 0, 2, '提高辖区消防安全，覆盖范围与出勤容量有限。', { service: 'safety', radius: 8, serviceCapacity: 320 }),
  police: entry('police', '警察局', 'public', 'police', 950, 22, 14, 0, 3, '为辖区提供治安服务，提高居民安全感。', { service: 'security', radius: 8, serviceCapacity: 320 }),
  library: entry('library', '公共图书馆', 'public', 'library', 800, 18, 10, 0, 3, '提供文化空间，提升周边街区吸引力。', { service: 'culture', radius: 7, serviceCapacity: 220 }),
  stadium: entry('stadium', '城市体育场', 'public', 'stadium', 2200, 42, 28, 0, 2, '提供大型运动休闲空间，并吸引外来游客。', { service: 'recreation', radius: 10, serviceCapacity: 500 }),
});

export const STYLES = Object.freeze([
  { id: 'modern', label: '现代简约' }, { id: 'european', label: '欧式街区' },
  { id: 'chinese', label: '中式庭院' }, { id: 'japanese', label: '日式街町' },
  { id: 'nordic', label: '北欧木屋' }, { id: 'industrial', label: '工业复古' },
  { id: 'future', label: '未来都市' },
]);
const STYLE_IDS = new Set(STYLES.map(style => style.id));
const COMPONENTS = ['garden', 'wall', 'garage', 'pool', 'terrace', 'solar'];
const boundedInt = (value, min, max, fallback) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;

export function sanitizeDesign(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const catalogId = Object.prototype.hasOwnProperty.call(BUILDINGS, source.catalogId) ? source.catalogId : 'villa';
  const meta = BUILDINGS[catalogId];
  const components = {};
  COMPONENTS.forEach(key => { components[key] = source.components?.[key] === true; });
  return {
    catalogId, style: STYLE_IDS.has(source.style) ? source.style : 'modern',
    color: typeof source.color === 'string' && /^#[0-9a-f]{6}$/i.test(source.color) ? source.color.toLowerCase() : '#d9cfad',
    roof: ['flat', 'pitched', 'garden'].includes(source.roof) ? source.roof : 'flat',
    floors: boundedInt(source.floors, 1, 12, meta.floors),
    width: boundedInt(source.width, 1, 3, meta.width), depth: boundedInt(source.depth, 1, 3, meta.depth),
    rotation: boundedInt(source.rotation, 0, 3, 0), components,
  };
}

export function designCost(input) {
  const design = sanitizeDesign(input);
  const area = design.width * design.depth;
  const additions = { garden: 25, wall: 20, garage: 45, pool: 80, terrace: 40, solar: 75 };
  const components = Object.entries(additions).reduce((sum, [key, value]) => sum + (design.components[key] ? value : 0), 0);
  return Math.round((BUILDINGS[design.catalogId].cost * (1 + (design.floors - 1) * 0.16) + components + (design.roof === 'garden' ? 50 : design.roof === 'pitched' ? 15 : 0)) * area);
}

const LEGACY = {
  residential: { id: 'residential', name: '住宅', category: 'residential', baseType: 'residential', cost: 120, maintenance: 1.5, jobs: 0, capacity: 12 },
  commercial: { id: 'commercial', name: '商业', category: 'commercial', baseType: 'commercial', cost: 180, maintenance: 4, jobs: 16, capacity: 0 },
  industrial: { id: 'industrial', name: '工业', category: 'industrial', baseType: 'industrial', cost: 220, maintenance: 7, jobs: 28, capacity: 0 },
  park: { id: 'park', name: '公园', category: 'park', baseType: 'park', cost: 150, maintenance: 6, jobs: 0, capacity: 0, service: 'leisure', radius: 4, serviceCapacity: 140 },
  power: { id: 'power', name: '发电站', category: 'public', baseType: 'power', cost: 900, maintenance: 55, jobs: 0, capacity: 420 },
  water: { id: 'water', name: '水务站', category: 'public', baseType: 'water', cost: 650, maintenance: 40, jobs: 0, capacity: 320 },
  road: { id: 'road', name: '道路', category: 'public', baseType: 'road', cost: 20, maintenance: 0.2, jobs: 0, capacity: 0 },
};

export function getBuilding(cell) {
  if (!cell?.type) return null;
  const level = boundedInt(cell.level, 1, 3, 1);
  if (cell.design) {
    const design = sanitizeDesign(cell.design), source = BUILDINGS[design.catalogId], area = design.width * design.depth;
    return {
      ...source, design, cost: designCost(design), floors: design.floors, width: design.width, depth: design.depth,
      capacity: Math.round(source.capacity * area * (0.55 + design.floors * 0.45) * (1 + (level - 1) * 0.3)),
      jobs: Math.round(source.jobs * area * (0.7 + design.floors * 0.3) * (1 + (level - 1) * 0.25)),
      maintenance: Math.round(source.maintenance * area * (0.65 + design.floors * 0.35) * (1 + (level - 1) * 0.3) * 10) / 10,
      radius: source.radius ? Math.min(14, source.radius + Math.floor(Math.sqrt(area) - 1) + level - 1) : undefined,
      serviceCapacity: source.serviceCapacity ? Math.round(source.serviceCapacity * area * (0.8 + design.floors * 0.2) * (1 + (level - 1) * 0.35)) : undefined,
    };
  }
  const source = LEGACY[cell.type] || BUILDINGS[cell.type];
  if (!source) return null;
  return {
    ...source, width: 1, depth: 1, floors: level, description: source.description || '',
    capacity: cell.type === 'residential' ? [0, 12, 24, 40][level] : source.capacity * level,
    maintenance: source.maintenance * level, jobs: source.jobs * level,
    radius: source.radius ? source.radius + level - 1 : undefined,
    serviceCapacity: source.serviceCapacity ? source.serviceCapacity * level : undefined,
  };
}
