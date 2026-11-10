import assert from 'node:assert/strict';
import { TrafficSimulation, laneCurve, overlaps, STEP, VEHICLE_LENGTH, VEHICLE_WIDTH } from '../dist/traffic.js';
import * as THREE from '../dist/vendor/three.module.js';
import { TrafficView } from '../dist/traffic-view.js';
import { createCar } from '../dist/voxels.js?v=20261110-traffic2';
import { CitySimulation } from '../dist/simulation.js';
globalThis.localStorage={getItem:()=>null,setItem:()=>{}};
let groups=0;
function test(name,fn){fn();groups++;console.log('PASS '+name);}
function validate(t){
 const s=t.stats();assert.equal(s.planned,s.active+s.pending+s.completed+s.cancelled,'trip conservation');
 const cars=t.vehicles.filter(c=>c.state==='moving');
 for(let i=0;i<cars.length;i++){
  const c=cars[i];assert(Object.values(c.pose).every(Number.isFinite));assert(t.nodes.has(c.path[c.index]));
  for(let j=i+1;j<cars.length;j++)assert(!overlaps(c.pose,cars[j].pose),`vehicle overlap ${c.id}/${cars[j].id} at ${t.time}`);
 }
 for(const node of t.nodes.values())if(node.holder!==null)assert(cars.some(c=>c.id===node.holder),'orphan junction lock');
}
function run(city,seconds,maxVehicles=64){const t=new TrafficSimulation({maxVehicles});t.sync(city);let waiting=0;
 for(let i=0;i<seconds/STEP;i++){t.update(STEP);validate(t);waiting=Math.max(waiting,t.stats().waiting);}
 return {t,waiting};}

test('shortest road paths use cardinal neighbours; invalid and identical endpoints are rejected',()=>{
 const city=new CitySimulation(),t=new TrafficSimulation();t.sync(city);const path=t.route(17*32,17*32+31);assert.equal(path.length,32);
 for(let i=1;i<path.length;i++){const a=t.nodes.get(path[i-1]),b=t.nodes.get(path[i]);assert.equal(Math.abs(a.x-b.x)+Math.abs(a.z-b.z),1);}
 assert.equal(t.route(-1,10),null);assert.equal(t.route(path[0],path[0]),null);
});
test('straight and left/right turn lane curves meet continuously without instant heading changes',()=>{
 const center={x:0,z:0,terrain:'land'};const sides=[[1,0],[-1,0],[0,1],[0,-1]];
 for(const [px,pz]of sides)for(const [nx,nz]of sides){if(px===nx&&pz===nz)continue;
 const p={...center,x:px,z:pz},n={...center,x:nx,z:nz},curve=laneCurve(p,center,n);
 const next=laneCurve(center,n,{...n,x:nx*2,z:nz*2});const end=curve.at(curve.length),start=next.at(0);
 assert(Math.hypot(end.x-start.x,end.z-start.z)<1e-7);assert(Math.abs(Math.sin(end.yaw-start.yaw))<1e-7);
 let prev=curve.at(0);for(let i=1;i<=100;i++){const now=curve.at(curve.length*i/100);assert(Math.abs(Math.atan2(Math.sin(now.yaw-prev.yaw),Math.cos(now.yaw-prev.yaw)))<.1);prev=now;}
 }
 const a={x:0,z:0,yaw:0},b={x:.32,z:0,yaw:Math.PI};assert(!overlaps(a,b),'oncoming lanes can pass');assert(overlaps(a,{...a,z:.2}));
});
test('lane geometry remains on the road corridor including vehicle corners',()=>{
 const node={x:0,z:0,terrain:'land'},sides=[[1,0],[-1,0],[0,1],[0,-1]];
 for(const [px,pz]of sides)for(const [nx,nz]of sides){if(px===nx&&pz===nz)continue;const prev={...node,x:px,z:pz},next={...node,x:nx,z:nz},curve=laneCurve(prev,node,next);
 for(let i=0;i<=100;i++){const p=curve.at(curve.length*i/100),vx=Math.sin(p.yaw),vz=Math.cos(p.yaw);
 for(const a of [-1,1])for(const b of [-1,1]){const x=p.x+a*vx*VEHICLE_LENGTH/2+b*vz*VEHICLE_WIDTH/2,z=p.z+a*vz*VEHICLE_LENGTH/2-b*vx*VEHICLE_WIDTH/2;
 assert([prev,node,next].some(n=>Math.abs(x-n.x)<=.501&&Math.abs(z-n.z)<=.501),`corner outside road ${px},${pz}->${nx},${nz}`);}}
 }
});
test('seeded city runs for 180 simulated seconds with queued and completed trips and zero overlaps',()=>{
 const {t,waiting}=run(new CitySimulation(),180);assert(t.completed>10);assert(waiting>0);assert(t.stats().junctions>0);console.log('  baseline:',JSON.stringify(t.stats()));
});
test('dense city traffic progresses for 300 seconds while preserving vehicle separation',()=>{
 const city=new CitySimulation();city.cells.filter(c=>c.type==='residential').forEach(c=>c.population=80);city.revision++;city.recompute();
 const {t,waiting}=run(city,300,64);assert(t.completed>30);assert(waiting>3);console.log('  dense:',JSON.stringify(t.stats()));
});
test('road demolition, undo and imported replacement cancel stale routes without phantom vehicles',()=>{
 const city=new CitySimulation(),t=new TrafficSimulation();t.sync(city);for(let i=0;i<300;i++)t.update(STEP);const before=t.planned;
 assert(city.place(7,17,'bulldoze').ok);t.sync(city);validate(t);assert(t.cancelled>0);assert(t.planned===before);
 assert(city.undo().ok);t.sync(city);for(let i=0;i<300;i++)t.update(STEP);validate(t);
 const state=city.exportState();state.cells.forEach(c=>{if(c.type==='road')c.type=null;});assert(city.importState(state).ok);t.sync(city);t.update(1);validate(t);assert.equal(t.stats().active,0);assert.equal(t.stats().pending,0);
});
test('red signals and occupied junctions block entry; current owner can clear on red',()=>{
 const t=new TrafficSimulation();t.sync(new CitySimulation());const id=17*32+7;
 const north={id:1,index:0,path:[16*32+7,id]},west={id:2,index:0,path:[17*32+6,id]};
 assert.equal(t.signal(id),'eastWest');assert.equal(t.canEnter(north,id),false);assert.equal(t.canEnter(west,id),true);
 t.time=6;assert.equal(t.canEnter(north,id),false);assert.equal(t.canEnter(west,id),true);
 t.release(west);assert.equal(t.canEnter(north,id),true);
 t.release(north);t.time=4.5;assert.equal(t.signal(id),'clear');assert.equal(t.canEnter(west,id),false);assert.equal(t.canEnter(north,id),false);
});
test('pause and rendering frame rate do not change fixed-step simulation results',()=>{
 const city=new CitySimulation(),a=new TrafficSimulation(),b=new TrafficSimulation();a.sync(city);b.sync(city);
 for(let i=0;i<600;i++)a.update(1/60);for(let i=0;i<200;i++)b.update(1/20);
 assert.deepEqual(a.stats(),b.stats());assert.deepEqual(a.vehicles,b.vehicles);
 const paused=JSON.stringify(a.vehicles),time=a.time;a.update(0);a.update(NaN);assert.equal(a.time,time);assert.equal(JSON.stringify(a.vehicles),paused);
});
test('empty cities produce no trips and reset releases all road reservations',()=>{
 const city=new CitySimulation();city.cells.forEach(c=>{if(c.type==='residential')c.population=0;});city.revision++;
 const {t}=run(city,10);assert.equal(t.planned,0);t.reset();assert.equal(t.nodes.size,0);assert.equal(t.completed,0);
});
test('car tyres align to both road surfaces and bridge transitions are continuous',()=>{
 const mesh=createCar('#ffffff'),bottom=new THREE.Box3().setFromObject(mesh).min.y;
 for(const terrain of ['land','water']){const n={x:0,z:0,terrain},p={...n,z:-1},q={...n,z:1},curve=laneCurve(p,n,q);
 assert(Math.abs(curve.at(.5).y+bottom-(terrain==='water'?.1045:.0615))<1e-6);}
 const p={x:0,z:-1,terrain:'land'},n={x:0,z:0,terrain:'water'},q={x:0,z:1,terrain:'water'};
 const one=laneCurve(p,n,q),two=laneCurve(n,q,{...q,z:2});assert.equal(one.at(one.length).y,two.at(0).y);
});
test('64-car renderer batches vehicle parts and resets hidden instances without ghost cars',()=>{
 const city=new CitySimulation(),t=new TrafficSimulation();t.sync(city);const scene=new THREE.Scene(),view=new TrafficView(scene,t);
 assert(view.fleetBatches.length<20);assert.equal(view.carBindings.size,64);
 for(let i=0;i<150;i++)t.update(STEP);view.update(.2);assert(view.visibleCars.size>0);
 const car=t.vehicles.find(c=>c.state==='moving');view.showRoute(car);view.setOverlay(true);view.update(.2,car);assert.equal(view.marker.visible,true);assert(view.routeLine.geometry.attributes.position.count>1);
 const matrices=view.carBindings.get(car.id);const matrix=new THREE.Matrix4();matrices[0].mesh.getMatrixAt(matrices[0].index,matrix);assert(matrix.determinant()>0);
 t.reset();view.showRoute(null);view.update(.2);matrices[0].mesh.getMatrixAt(matrices[0].index,matrix);assert.equal(matrix.determinant(),0);assert.equal(view.visibleCars.size,0);assert.equal(view.marker.visible,false);
 console.log('  vehicle draw batches:',view.fleetBatches.length);
});
console.log(`${groups} traffic regression groups passed.`);
