import * as THREE from './vendor/three.module.js';
import { createCar } from './voxels.js?v=20261110-traffic2';

const COLORS=['#f2dfb0','#dc9073','#81b9b5','#ebe5d2','#779cab','#c5ad80'];
export class TrafficView {
  constructor(scene,traffic){
    this.scene=scene;this.traffic=traffic;this.carBindings=new Map();this.visibleCars=new Set();this.fleetBatches=[];this.lastTopology=null;this.overlayEnabled=false;this.clock=0;
    this.root=new THREE.Group();this.root.name='city-traffic';scene.add(this.root);this.buildFleet();
    this.infrastructure=new THREE.Group();this.root.add(this.infrastructure);
    this.tileGeometry=new THREE.PlaneGeometry(.75,.75);this.postGeometry=new THREE.BoxGeometry(.035,.32,.035);
    this.lampGeometry=new THREE.BoxGeometry(.09,.065,.07);
    this.postMaterial=new THREE.MeshStandardMaterial({color:'#596864',roughness:.8});
    this.lampMaterial=new THREE.MeshBasicMaterial({color:'#ffffff'});
    this.overlayMaterial=new THREE.MeshBasicMaterial({transparent:true,opacity:.38,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2});
    this.routeLine=new THREE.Line(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:'#ffdb8c',transparent:true,opacity:.95,depthWrite:false}));this.routeLine.renderOrder=4;this.routeLine.visible=false;this.root.add(this.routeLine);
    this.marker=new THREE.Mesh(new THREE.RingGeometry(.21,.24,24),new THREE.MeshBasicMaterial({color:'#ffdf9b',side:THREE.DoubleSide,depthWrite:false}));this.marker.rotation.x=-Math.PI/2;this.marker.visible=false;this.root.add(this.marker);
  }
  buildFleet(){
    const packs=new Map(),instance=new THREE.Matrix4(),world=new THREE.Matrix4();
    for(let slot=0;slot<this.traffic.maxVehicles;slot++){
      const model=createCar(COLORS[slot%COLORS.length]);model.updateMatrixWorld(true);
      model.traverse(o=>{if(!o.isMesh)return;const key=o.geometry.uuid+'_'+o.material.uuid;
        if(!packs.has(key))packs.set(key,{geometry:o.geometry,material:o.material,entries:[]});
        const pack=packs.get(key);for(let i=0;i<(o.isInstancedMesh?o.count:1);i++){
          if(o.isInstancedMesh)o.getMatrixAt(i,instance);else instance.identity();
          pack.entries.push({id:slot+1,local:world.multiplyMatrices(o.matrixWorld,instance).clone()});
        }
      });model.traverse(o=>{if(o.isInstancedMesh)o.dispose();});
    }
    const hidden=new THREE.Matrix4().makeScale(0,0,0);
    for(const pack of packs.values()){
      const mesh=new THREE.InstancedMesh(pack.geometry,pack.material,pack.entries.length);mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.frustumCulled=false;mesh.castShadow=mesh.receiveShadow=true;
      pack.entries.forEach((entry,index)=>{mesh.setMatrixAt(index,hidden);if(!this.carBindings.has(entry.id))this.carBindings.set(entry.id,[]);this.carBindings.get(entry.id).push({mesh,index,local:entry.local});});
      this.root.add(mesh);this.fleetBatches.push(mesh);
    }
    this.carTransform=new THREE.Object3D();this.carMatrix=new THREE.Matrix4();this.hiddenMatrix=hidden;
  }
  rebuild(){
    for(const child of [...this.infrastructure.children]){if(child.isInstancedMesh)child.dispose();this.infrastructure.remove(child);}
    this.roadIds=[...this.traffic.nodes.keys()];const dummy=new THREE.Object3D();
    this.overlay=new THREE.InstancedMesh(this.tileGeometry,this.overlayMaterial,this.roadIds.length);
    this.roadIds.forEach((id,i)=>{const n=this.traffic.nodes.get(id);dummy.position.set(n.x,n.terrain==='water'?.117:.074,n.z);dummy.rotation.set(-Math.PI/2,0,0);dummy.updateMatrix();this.overlay.setMatrixAt(i,dummy.matrix);this.overlay.setColorAt(i,new THREE.Color('#74b8a2'));});
    this.overlay.visible=this.overlayEnabled;this.infrastructure.add(this.overlay);
    this.signals=[];
    const junctions=[...this.traffic.nodes].filter(([,n])=>n.links.length>=3);
    this.posts=new THREE.InstancedMesh(this.postGeometry,this.postMaterial,junctions.length*2);
    this.lamps=new THREE.InstancedMesh(this.lampGeometry,this.lampMaterial,junctions.length*2);dummy.rotation.set(0,0,0);
    for(const [id,n]of junctions)for(const [axis,x,z]of [['eastWest',.43,-.43],['northSouth',-.43,.43]]){
      const y=n.terrain==='water'?.1045:.0615,index=this.signals.length;
      dummy.position.set(n.x+x,y+.16,n.z+z);dummy.updateMatrix();this.posts.setMatrixAt(index,dummy.matrix);
      dummy.position.y=y+.33;dummy.updateMatrix();this.lamps.setMatrixAt(index,dummy.matrix);this.lamps.setColorAt(index,new THREE.Color('#e78069'));
      this.signals.push({id,axis,index});
    }
    this.posts.castShadow=true;this.infrastructure.add(this.posts,this.lamps);
    this.lastTopology=this.traffic.topology;this.clock=1;
  }
  setOverlay(enabled){this.overlayEnabled=enabled;if(this.overlay)this.overlay.visible=enabled;}
  showRoute(car){
    this.routeLine.geometry.dispose();
    const points=car?car.path.map(id=>{const n=this.traffic.nodes.get(id);return new THREE.Vector3(n.x,n.terrain==='water'?.14:.10,n.z);}):[];
    this.routeLine.geometry=new THREE.BufferGeometry().setFromPoints(points);this.routeLine.visible=points.length>1;
  }
  update(dt,followed=null){
    if(this.lastTopology!==this.traffic.topology)this.rebuild();
    const visible=new Set();
    for(const car of this.traffic.vehicles){if(car.state!=='moving')continue;visible.add(car.id);
      this.carTransform.position.set(car.pose.x,car.pose.y,car.pose.z);this.carTransform.rotation.y=car.pose.yaw;this.carTransform.updateMatrix();
      for(const binding of this.carBindings.get(car.id)||[]){this.carMatrix.multiplyMatrices(this.carTransform.matrix,binding.local);binding.mesh.setMatrixAt(binding.index,this.carMatrix);}
    }
    for(const id of this.visibleCars)if(!visible.has(id))for(const binding of this.carBindings.get(id)||[])binding.mesh.setMatrixAt(binding.index,this.hiddenMatrix);
    for(const mesh of this.fleetBatches)mesh.instanceMatrix.needsUpdate=true;this.visibleCars=visible;
    this.marker.visible=!!followed;if(followed)this.marker.position.set(followed.pose.x,followed.pose.y+.06,followed.pose.z);
    this.clock+=dt;if(this.clock<.2)return;this.clock=0;
    for(const {id,axis,index}of this.signals)this.lamps.setColorAt(index,new THREE.Color(this.traffic.signal(id)===axis?'#8edb92':'#e78069'));if(this.lamps.instanceColor)this.lamps.instanceColor.needsUpdate=true;
    if(this.overlayEnabled){this.roadIds.forEach((id,i)=>{const s=this.traffic.roadStats(id),color=s.delay>.55?'#dc785f':s.delay>.2?'#d6b366':'#76b99a';this.overlay.setColorAt(i,new THREE.Color(color));});if(this.overlay.instanceColor)this.overlay.instanceColor.needsUpdate=true;}
  }
}
