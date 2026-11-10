// Deterministic, renderer-independent sampled city trips, lane geometry and traffic control.
const SIDES = [[1,0],[-1,0],[0,1],[0,-1]];
const clamp = (n,a,b) => Math.max(a,Math.min(b,n));
export const LANE_OFFSET = .16;
export const VEHICLE_LENGTH = .30;
export const VEHICLE_WIDTH = .166;
export const STEP = 1/30;
const keyOf = (x,z,size) => z*size+x;
const surface = n => n.terrain==='water' ? .1045 : .0615;
const direction = (a,b) => ({x:b.x-a.x,z:b.z-a.z});
const point = (n,v,along) => ({x:n.x+v.x*along+v.z*LANE_OFFSET,z:n.z+v.z*along-v.x*LANE_OFFSET});
const mix = (a,b,t) => a+(b-a)*t;

export function overlaps(a,b,padding=0) {
  if (!a||!b||Math.abs(a.x-b.x)>1||Math.abs(a.z-b.z)>1) return false;
  const av={x:Math.sin(a.yaw),z:Math.cos(a.yaw)}, bv={x:Math.sin(b.yaw),z:Math.cos(b.yaw)};
  const ar={x:av.z,z:-av.x},br={x:bv.z,z:-bv.x},delta={x:b.x-a.x,z:b.z-a.z};
  const halfL=(VEHICLE_LENGTH+padding)/2,halfW=(VEHICLE_WIDTH+padding)/2;
  const dot=(u,v)=>u.x*v.x+u.z*v.z;
  for(const axis of [av,ar,bv,br]) {
    const reach=halfL*(Math.abs(dot(av,axis))+Math.abs(dot(bv,axis)))+halfW*(Math.abs(dot(ar,axis))+Math.abs(dot(br,axis)));
    if(Math.abs(dot(delta,axis))>=reach-1e-9) return false;
  }
  return true;
}

// Tile-local cubic with tangent-continuous lane boundaries and arc-length sampling.
export function laneCurve(previous,node,next) {
  const incoming=previous?direction(previous,node):direction(node,next);
  const outgoing=next?direction(node,next):incoming;
  const a=point(node,incoming,previous?-.5:0),d=point(node,outgoing,next ? .5 : 0);
  const straight=incoming.x===outgoing.x&&incoming.z===outgoing.z;
  const reach=straight?Math.hypot(d.x-a.x,d.z-a.z)/3:
    Math.abs((d.x-a.x)*incoming.x+(d.z-a.z)*incoming.z)*.55228475;
  const b={x:a.x+incoming.x*reach,z:a.z+incoming.z*reach},c={x:d.x-outgoing.x*reach,z:d.z-outgoing.z*reach};
  const samples=[];let length=0;
  for(let i=0;i<=32;i++){
    const t=i/32,u=1-t;
    const x=u*u*u*a.x+3*u*u*t*b.x+3*u*t*t*c.x+t*t*t*d.x;
    const z=u*u*u*a.z+3*u*u*t*b.z+3*u*t*t*c.z+t*t*t*d.z;
    const dx=3*u*u*(b.x-a.x)+6*u*t*(c.x-b.x)+3*t*t*(d.x-c.x);
    const dz=3*u*u*(b.z-a.z)+6*u*t*(c.z-b.z)+3*t*t*(d.z-c.z);
    const start=previous?(surface(previous)+surface(node))/2:surface(node),end=next?(surface(next)+surface(node))/2:surface(node);
    const y=(t<.5?mix(start,surface(node),t*2):mix(surface(node),end,t*2-1))-.0125;
    if(i)length+=Math.hypot(x-samples[i-1].x,z-samples[i-1].z);
    samples.push({x,z,y,yaw:Math.atan2(dx,dz),distance:length});
  }
  return {length,samples,at(distance){
    const s=clamp(distance,0,length);let i=1;while(i<samples.length-1&&samples[i].distance<s)i++;
    const p=samples[i-1],q=samples[i],t=(s-p.distance)/Math.max(1e-9,q.distance-p.distance);
    const angle=Math.atan2(Math.sin(q.yaw-p.yaw),Math.cos(q.yaw-p.yaw));
    return {x:mix(p.x,q.x,t),z:mix(p.z,q.z,t),y:mix(p.y,q.y,t),yaw:p.yaw+angle*t};
  }};
}

export class TrafficSimulation {
  constructor({maxVehicles=64,seed=2718}={}) {
    this.maxVehicles=maxVehicles;this.seed=seed>>>0;this.nodes=new Map();this.vehicles=[];this.routes=new Map();this.curves=new Map();
    this.time=0;this.accumulator=0;this.completed=0;this.cancelled=0;this.planned=0;this.elapsedTrips=0;
    this.flow=new Map();this.nextId=1;this.lastRevision=-1;this.topology='';this.homes=[];this.targets=[];this.targetCount=0;this.lastSpawn=0;
  }
  random(){this.seed=(Math.imul(this.seed,1664525)+1013904223)>>>0;return this.seed/4294967296;}
  reset(){const maxVehicles=this.maxVehicles,seed=this.seed;Object.assign(this,new TrafficSimulation({maxVehicles,seed}));}
  sync(city) {
    if(this.lastRevision===city.revision&&this.lastCells===city.cells)return false;
    this.lastRevision=city.revision;this.lastCells=city.cells;this.size=Math.round(Math.sqrt(city.cells.length));
    const roadCells=city.cells.filter(c=>c.type==='road'&&c.connected);
    const topology=roadCells.map(c=>`${c.x},${c.z},${c.terrain}`).join('|');
    if(topology!==this.topology){
      this.topology=topology;this.nodes=new Map(roadCells.map(c=>[keyOf(c.x,c.z,this.size),{...c,links:[],holder:null}]));
      for(const [id,node]of this.nodes)node.links=SIDES.map(([dx,dz])=>keyOf(node.x+dx,node.z+dz,this.size)).filter(k=>{const other=this.nodes.get(k);return other&&Math.abs(other.x-node.x)+Math.abs(other.z-node.z)===1;});
      this.routes.clear();this.curves.clear();this.flow.clear();
      // Topology edits invalidate trajectories and locks atomically. Rescheduled
      // trips reappear only after safe spawning, never through a replacement building.
      for(const car of this.vehicles)this.cancel(car);
    }
    this.homes=[];this.targets=[];
    for(const c of city.cells){
      if(!c.type||c.type==='road'||c.anchor||!c.connected)continue;
      const [w,d]=c.design?(c.design.rotation%2?[c.design.depth,c.design.width]:[c.design.width,c.design.depth]):[1,1];
      const roads=new Set();for(let dz=0;dz<d;dz++)for(let dx=0;dx<w;dx++)for(const [ox,oz]of SIDES){const k=keyOf(c.x+dx+ox,c.z+dz+oz,this.size),road=this.nodes.get(k);if(road&&Math.abs(road.x-(c.x+dx))+Math.abs(road.z-(c.z+dz))===1)roads.add(k);}
      if(!roads.size)continue;
      const endpoint={id:keyOf(c.x,c.z,this.size),type:c.type,roads:[...roads],weight:c.population||1};
      if(c.type==='residential'&&c.population>0)this.homes.push(endpoint);
      else if(!['residential','power','water'].includes(c.type))this.targets.push(endpoint);
    }
    const alive=new Set([...this.homes,...this.targets].map(e=>e.id));
    for(const car of this.vehicles)if(car.state!=='idle'&&(!alive.has(car.origin)||!alive.has(car.destination)))this.cancel(car);
    const population=this.homes.reduce((n,h)=>n+h.weight,0);
    this.targetCount=this.homes.length&&this.targets.length?Math.min(this.maxVehicles,Math.max(4,Math.ceil(population/24))):0;
    return true;
  }
  route(start,goal) {
    const key=`${start}:${goal}`;if(this.routes.has(key))return this.routes.get(key);
    if(!this.nodes.has(start)||!this.nodes.has(goal)||start===goal)return null;
    const queue=[start],previous=new Map([[start,null]]);
    for(let i=0;i<queue.length&&!previous.has(goal);i++)for(const id of this.nodes.get(queue[i]).links)if(!previous.has(id)){previous.set(id,queue[i]);queue.push(id);}
    if(!previous.has(goal))return null;
    const path=[];for(let id=goal;id!==null;id=previous.get(id))path.unshift(id);
    if(this.routes.size>=256)this.routes.delete(this.routes.keys().next().value);
    this.routes.set(key,path);return path;
  }
  curve(car,index=car.index){
    const p=car.path[index-1]??null,n=car.path[index],q=car.path[index+1]??null,key=`${p}/${n}/${q}`;
    if(!this.curves.has(key))this.curves.set(key,laneCurve(this.nodes.get(p),this.nodes.get(n),this.nodes.get(q)));
    return this.curves.get(key);
  }
  signal(id) {
    const node=this.nodes.get(id);if(!node||node.links.length<3)return 'none';
    const phase=(this.time+(id%5)*1.7)%14;
    return phase<6?'eastWest':phase<7?'clear':phase<13?'northSouth':'clear';
  }
  canEnter(car,id){
    const node=this.nodes.get(id);if(!node||node.links.length<3)return true;
    if(node.holder===car.id)return true;
    if(node.holder!==null)return false;
    const from=this.nodes.get(car.path[car.index]),axis=from.x!==node.x?'eastWest':'northSouth';
    if(this.signal(id)!==axis)return false;
    // Do not lock a junction unless its exit can accept this vehicle.
    if(car.index+2<car.path.length){const exit=this.curve(car,car.index+2).at(.25);if(!this.clear(exit,car.id,.08))return false;}
    node.holder=car.id;return true;
  }
  clear(pose,id,padding=.04){return !this.vehicles.some(other=>other.id!==id&&other.state==='moving'&&overlaps(pose,other.pose,padding));}
  release(car){for(const node of this.nodes.values())if(node.holder===car.id)node.holder=null;}
  cancel(car){if(car.state==='idle')return;this.cancelled++;this.release(car);car.state='idle';car.pose=null;car.path=[];car.speed=0;}
  plan(){
    let car=this.vehicles.find(c=>c.state==='idle');
    if(!car){if(this.vehicles.length>=this.maxVehicles)return;car={id:this.nextId++,state:'idle'};this.vehicles.push(car);}
    for(let attempt=0;attempt<20;attempt++){
      let weight=this.random()*this.homes.reduce((n,h)=>n+h.weight,0),home=this.homes.at(-1);
      for(const candidate of this.homes){weight-=candidate.weight;if(weight<=0){home=candidate;break;}}
      const target=this.targets[Math.floor(this.random()*this.targets.length)],returning=this.random()<.4;
      const origin=returning?target:home,destination=returning?home:target;
      const start=origin.roads[Math.floor(this.random()*origin.roads.length)],goal=destination.roads[Math.floor(this.random()*destination.roads.length)];
      const path=this.route(start,goal);if(!path||path.length<2)continue;
      Object.assign(car,{state:'waiting',path:[...path],origin:origin.id,destination:destination.id,purpose:target.type==='park'?'休闲':target.type==='commercial'?'消费 / 工作':'通勤',returning,index:0,distance:0,speed:0,cruise:.55+this.random()*.18,wait:0,started:this.time,pose:null});
      this.planned++;return;
    }
  }
  spawn(car){
    const pose=this.curve(car).at(0),node=this.nodes.get(car.path[0]);
    if(!this.clear(pose,car.id,.12)||node.links.length>=3&&node.holder!==null)return false;
    if(node.links.length>=3)node.holder=car.id;
    car.pose=pose;car.state='moving';return true;
  }
  update(dt){
    if(!Number.isFinite(dt)||dt<=0)return;
    this.accumulator+=Math.min(dt,.5);
    while(this.accumulator+1e-9>=STEP){this.accumulator-=STEP;this.step(STEP);}
  }
  step(dt){
    this.time+=dt;
    if(this.time-this.lastSpawn>.4){
      this.lastSpawn=this.time;
      if(this.vehicles.filter(c=>c.state!=='idle').length<this.targetCount)this.plan();
    }
    // Longest-waiting requests get first chance when their signal turns green.
    const cars=this.vehicles.filter(c=>c.state!=='idle').sort((a,b)=>b.wait-a.wait||a.id-b.id);
    for(const car of cars){
      if(car.state==='waiting'){if(!this.spawn(car))car.wait+=dt;continue;}
      const curve=this.curve(car),remaining=curve.length-car.distance,nextId=car.path[car.index+1];
      let gate=false;
      if(nextId!==undefined&&remaining<.55)gate=!this.canEnter(car,nextId);
      const ahead=curve.at(Math.min(curve.length,car.distance+.12+car.speed*.28));
      const braking=gate&&remaining<.44||!this.clear(ahead,car.id,.05);
      const wanted=braking?0:car.cruise;
      car.speed=clamp(car.speed+(wanted > car.speed ? .65 : -1.7)*dt,0,car.cruise);
      let distance=Math.min(curve.length,car.distance+car.speed*dt);
      if(gate)distance=Math.min(distance,Math.max(car.distance,curve.length-.23));
      const pose=curve.at(distance);
      if(!this.clear(pose,car.id,.035)){car.speed=0;distance=car.distance;}
      const moved=distance-car.distance;car.distance=distance;car.pose=curve.at(distance);
      car.wait=moved<.001?car.wait+dt:0;
      const current=car.path[car.index],flow=this.flow.get(current)||{moving:0,waiting:0,passed:0};
      flow[moved<.001?'waiting':'moving']+=dt;this.flow.set(current,flow);
      // A queue near the entry must not strand the preceding junction lock.
      if(car.distance>.2){const prev=this.nodes.get(car.path[car.index-1]);if(prev?.holder===car.id)prev.holder=null;}
      if(car.distance>=curve.length-1e-8){
        flow.passed++;
        if(car.index===car.path.length-1){this.completed++;this.elapsedTrips+=this.time-car.started;this.release(car);car.state='idle';car.pose=null;car.path=[];}
        else {car.index++;car.distance=0;car.pose=this.curve(car).at(0);}
      }
    }
    // Recent delays fade instead of permanently painting yesterday's congestion.
    for(const flow of this.flow.values()){flow.waiting*=1-dt/30;flow.moving*=1-dt/30;}
  }
  roadStats(id){
    const flow=this.flow.get(id),cars=this.vehicles.filter(c=>c.state==='moving'&&c.path[c.index]===id);
    return {vehicles:cars.length,waiting:cars.filter(c=>c.speed<.08).length,delay:flow?flow.waiting/(2+flow.waiting+flow.moving):0,passed:flow?.passed||0,signal:this.signal(id)};
  }
  stats(){
    const active=this.vehicles.filter(c=>c.state==='moving'),pending=this.vehicles.filter(c=>c.state==='waiting').length;
    const waiting=active.filter(c=>c.speed<.08).length;
    return {active:active.length,pending,waiting,moving:active.length-waiting,completed:this.completed,cancelled:this.cancelled,planned:this.planned,
      averageTrip:this.completed?this.elapsedTrips/this.completed:0,flow:active.length?Math.round(active.reduce((n,c)=>n+c.speed/c.cruise,0)/active.length*100):100,
      junctions:[...this.nodes.values()].filter(n=>n.links.length>=3).length,roads:this.nodes.size};
  }
}
