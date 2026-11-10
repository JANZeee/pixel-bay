import assert from 'node:assert/strict';
import * as THREE from '../dist/vendor/three.module.js';
import { CitySimulation, SIZE } from '../dist/simulation.js';
import { BUILDINGS, STYLES, sanitizeDesign } from '../dist/catalog.js';
import { createBuilding } from '../dist/voxels.js';
import { createDesignedBuilding, disposeUnusedDesignerMaterials } from '../dist/building-designer.js';
import { batchModels, pickCellIndex, bridgeRails, ROAD_SIDES, lineCells } from '../dist/scene-geometry.js';
const saved=new Map();
const normalStorage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)};
globalThis.localStorage=normalStorage;
let groups=0;
function test(name,fn){saved.clear();fn();groups++;console.log('PASS '+name);}
function dispose(model){model.traverse(o=>{if(o.isInstancedMesh)o.dispose();});}

test('roof ray picking preserves owners across shared materials and nested instances',()=>{
 const source=new THREE.Group(), shared=new THREE.MeshBasicMaterial(), geo=new THREE.BoxGeometry(1,1,1);
 for(const [index,x,y]of [[0,0,1.5],[1,2,.5]]){const root=new THREE.Group();root.userData.cellIndex=index;root.position.x=x;
 const instances=new THREE.InstancedMesh(geo,shared,1);instances.setMatrixAt(0,new THREE.Matrix4().compose(new THREE.Vector3(0,y,0),new THREE.Quaternion(),new THREE.Vector3(1,y*2,1)));root.add(instances);source.add(root);}
 const batched=batchModels(source);assert.equal(batched.children.length,1);batched.updateMatrixWorld(true);
 const ray=new THREE.Raycaster(new THREE.Vector3(0,7,5),new THREE.Vector3(0,-4,-5).normalize());
 assert.equal(pickCellIndex(ray,[batched]),0);
 const ground=ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0),new THREE.Vector3());assert(Math.abs(ground.z)>1,'old plane picking misses this roof');
 ray.set(new THREE.Vector3(2,5,0),new THREE.Vector3(0,-1,0));assert.equal(pickCellIndex(ray,[batched]),1);dispose(batched);
});
test('bridge rails leave every connected exit open for all 16 junction patterns',()=>{
 for(let mask=0;mask<16;mask++){const links=ROAD_SIDES.filter((_,i)=>mask&(1<<i)),rails=bridgeRails(links);assert.equal(rails.length,4-links.length);
 for(const [dx,dz]of links)for(const r of rails){assert(!(Math.abs(dx*.5-r.x)<r.width/2&&Math.abs(dz*.5-r.z)<r.depth/2),'rail crosses connected lane');}}
});
test('all 1024 road stroke directions produce four-connected paths',()=>{
 for(let x=0;x<SIZE;x++)for(let z=0;z<SIZE;z++){const path=lineCells({x:15,z:15},{x,z});assert.equal(path.length,Math.abs(x-15)+Math.abs(z-15)+1);assert.deepEqual(path.at(-1),{x,z});for(let i=1;i<path.length;i++)assert.equal(Math.abs(path[i].x-path[i-1].x)+Math.abs(path[i].z-path[i-1].z),1);}
 const sim=new CitySimulation();assert(sim.placeMany(lineCells({x:1,z:17},{x:4,z:14}).map(p=>({...p,type:'road'}))).ok);assert(sim.cell(4,14).connected);
});
test('backup quota failure still permits saving the primary city',()=>{
 const sim=new CitySimulation();assert(sim.save());sim.day++;
 globalThis.localStorage={...normalStorage,setItem:(key,value)=>{if(key.includes('backup'))throw Error('QuotaExceededError');saved.set(key,value);}};
 try{assert.equal(sim.save(),true);assert.equal(JSON.parse(saved.get('pixel-bay-city-v2')).day,2);}finally{globalThis.localStorage=normalStorage;}
});
test('disconnected retail, hotel and school usage resets immediately',()=>{
 for(const id of ['shop','hotel','school']){saved.clear();const sim=new CitySimulation();assert(sim.place(8,13,BUILDINGS[id].baseType,{catalogId:id}).ok);const key={shop:'customers',hotel:'guests',school:'serviceLoad'}[id];assert(sim.cell(8,13)[key]>0);
 assert(sim.place(7,13,'bulldoze').ok);assert.equal(sim.cell(8,13).connected,false);assert.equal(sim.cell(8,13)[key],0);}
});
test('invalid catalogue keys and unsupported imported speed reject without changing city',()=>{
 const sim=new CitySimulation();for(const id of ['constructor','toString','__proto__']){assert.equal(sanitizeDesign({catalogId:id}).catalogId,'villa');assert.equal(sim.place(8,13,id).ok,false);}
 for(const speed of [0,.5,4,8]){const before=sim.exportState(),bad=structuredClone(before);bad.speed=speed;assert.equal(sim.importState(bad).ok,false);assert.deepEqual(sim.exportState(),before);}
});
test('600 mixed edits, undo/redo, day ticks and save round trips preserve city invariants',()=>{
 let seed=51091;const rng=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
 const city=new CitySimulation();city.money=1000000;const ids=Object.keys(BUILDINGS);
 for(let i=0;i<600;i++){const x=Math.floor(rng()*32),z=Math.floor(rng()*32),op=Math.floor(rng()*8);
 if(op===0)city.place(x,z,'bulldoze');if(op===1)city.place(x,z,'road');if(op===2)city.place(x,z,ids[Math.floor(rng()*ids.length)]);
 if(op===3)city.editTerrain(x,z,rng()<.5?'land':'water');if(op===4)city.upgrade(x,z);if(op===5)city.undo();if(op===6)city.redo();if(op===7)city.tick();
 assert(Number.isFinite(city.money));assert(city.population>=0&&city.population<=city.housingCapacity);
 const exported=city.exportState(),other=new CitySimulation();assert(other.importState(exported).ok);assert.deepEqual(other.exportState(),exported);}
});
test('unused preview colours are disposed without releasing live city materials',()=>{
 const city=createDesignedBuilding(sanitizeDesign({color:'#123456'}));let cityDisposed=0;
 const cityMaterials=new Set();city.traverse(o=>{if(o.material)cityMaterials.add(o.material);});
 cityMaterials.forEach(m=>m.addEventListener('dispose',()=>cityDisposed++));
 let previous=null,oldDisposed=0;
 for(let i=1;i<=80;i++){
  const model=createDesignedBuilding(sanitizeDesign({color:'#'+(0x220000+i*17).toString(16)}));
  if(previous){const oldMaterials=new Set();previous.traverse(o=>{if(o.material&&!cityMaterials.has(o.material))oldMaterials.add(o.material);});oldMaterials.forEach(m=>m.addEventListener('dispose',()=>oldDisposed++));}
  disposeUnusedDesignerMaterials([city,model]);if(previous)dispose(previous);previous=model;
 }
 assert.equal(cityDisposed,0);assert(oldDisposed>=79);dispose(city);dispose(previous);disposeUnusedDesignerMaterials([]);
});
let legacyCases=0,designCases=0;
function checkBounds(model,w,d,label){const b=new THREE.Box3().setFromObject(model);assert(b.min.y>=-.005&&b.min.x>=-w/2-.001&&b.max.x<=w/2+.001&&b.min.z>=-d/2-.001&&b.max.z<=d/2+.001,`${label} bounds ${JSON.stringify({min:b.min,max:b.max})}`);}
test('legacy geometry stays inside plot, including wind rotor sweep',()=>{
 for(const type of ['residential','commercial','industrial','park','power','water'])for(let level=1;level<=3;level++)for(let variant=0;variant<8;variant++){const m=createBuilding(type,level,variant);if(type!=='power')m.rotation.y=variant%4*Math.PI/2;const rotor=m.getObjectByName('rotor');for(let r=0;r<(rotor?24:1);r++){if(rotor)rotor.rotation.z=r*Math.PI/12;checkBounds(m,1,1,`${type}/${level}/${variant}/${r}`);legacyCases++;}dispose(m);}
});
test('DIY extreme dimensions, roofs, styles and rotations stay within reserved plots',()=>{
 const components=Object.fromEntries(['garden','wall','garage','pool','terrace','solar'].map(k=>[k,true]));
 for(const catalogId of Object.keys(BUILDINGS))for(const style of STYLES.map(s=>s.id))for(const roof of ['flat','pitched','garden'])for(const [width,depth]of [[1,1],[1,3],[3,1],[3,3]])for(const floors of [1,12])for(let rotation=0;rotation<4;rotation++){
 const design=sanitizeDesign({catalogId,style,roof,width,depth,floors,rotation,components}),model=createDesignedBuilding(design,1,rotation);checkBounds(model,rotation%2?depth:width,rotation%2?width:depth,JSON.stringify(design));const architecture=new THREE.Box3().setFromObject(model.getObjectByName('architecture'));
 for(const name of ['garage','pool','terrace']){const accessory=new THREE.Box3().setFromObject(model.getObjectByName('component-'+name));assert(!architecture.intersectsBox(accessory),`${catalogId}/${style}/${roof}/${width}x${depth}/${rotation}: architecture overlaps ${name}`);}
 for(const name of ['garden','wall'])model.getObjectByName('component-'+name).traverse(o=>{if(!o.isMesh)return;const count=o.isInstancedMesh?o.count:1;for(let i=0;i<count;i++){const local=new THREE.Matrix4();if(o.isInstancedMesh)o.getMatrixAt(i,local);const matrix=new THREE.Matrix4().multiplyMatrices(o.matrixWorld,local);o.geometry.computeBoundingBox();const bounds=o.geometry.boundingBox.clone().applyMatrix4(matrix);assert(!architecture.intersectsBox(bounds),`${catalogId}/${style}/${roof}/${width}x${depth}/${rotation}: ${name} intersects architecture`);}});
 designCases++;dispose(model);}
});
console.log(`${groups} audit groups passed; ${legacyCases} legacy + ${designCases} DIY geometry cases.`);
