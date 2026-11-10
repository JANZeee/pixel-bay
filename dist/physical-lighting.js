import * as THREE from './vendor/three.module.js';
import { Sky } from './vendor/Sky.js';
import { setMaterialLighting } from './voxels.js?v=20261110-traffic2';

export const LIGHT_PRESETS = {
  morning: {label:'晨光',time:'08:30',hour:8.5,elevation:39,azimuth:-48,color:'#fff0d9',power:3.6,ambient:.24,sky:'#b2c5cd',fog:'#b8c6c8',exposure:1.05,night:0,wetness:0,env:.48},
  golden: {label:'夕照',time:'17:30',hour:17.5,elevation:35,azimuth:-120,color:'#ffcf95',power:3.4,ambient:.25,sky:'#9caaa9',fog:'#bbc1b4',exposure:1.14,night:.06,wetness:.08,env:.36},
  blue: {label:'蓝调',time:'19:15',hour:19.25,elevation:-3,azimuth:-152,color:'#8eb8ff',power:.7,ambient:.2,sky:'#283e58',fog:'#34485e',exposure:1.45,night:1,wetness:.42,env:.23}
};

// Art-directed daylight anchors, not an astronomical ephemeris. Smooth, cyclic
// interpolation gives continuous illumination while retaining the three looks.
const DAY_KEYS = [
  {hour:0,elevation:-65,azimuth:-210,color:'#8eaedb',power:.16,ambient:.12,sky:'#172a41',fog:'#283b51',exposure:1.55,night:1,wetness:.42,env:.14},
  {hour:5,elevation:-12,azimuth:-16,color:'#9eb6dc',power:.21,ambient:.15,sky:'#3d5069',fog:'#4a5c72',exposure:1.5,night:1,wetness:.36,env:.20},
  {hour:6.25,elevation:0,azimuth:-28,color:'#ffd4b3',power:.65,ambient:.20,sky:'#9caaa9',fog:'#acb6af',exposure:1.32,night:.55,wetness:.18,env:.28},
  {hour:7,elevation:13,azimuth:-34,color:'#ffe1bd',power:2.6,ambient:.23,sky:'#b1bfc1',fog:'#bac3bd',exposure:1.15,night:.12,wetness:.06,env:.38},
  {...LIGHT_PRESETS.morning},
  {hour:12.5,elevation:70,azimuth:-90,color:'#fff8ed',power:4.0,ambient:.28,sky:'#a8c4d6',fog:'#b4cbd2',exposure:1.0,night:0,wetness:0,env:.50},
  {hour:15.5,elevation:55,azimuth:-118,color:'#ffead0',power:3.8,ambient:.26,sky:'#a6babf',fog:'#b7c2bf',exposure:1.06,night:0,wetness:.025,env:.43},
  {...LIGHT_PRESETS.golden},
  {hour:18.5,elevation:8,azimuth:-145,color:'#ffb67c',power:1.6,ambient:.22,sky:'#889596',fog:'#a0aaa6',exposure:1.26,night:.40,wetness:.20,env:.30},
  {...LIGHT_PRESETS.blue},
  {hour:20.5,elevation:-20,azimuth:-165,color:'#8eaedb',power:.22,ambient:.14,sky:'#1b304a',fog:'#2d4159',exposure:1.5,night:1,wetness:.42,env:.17},
  {hour:24,elevation:-65,azimuth:-210,color:'#8eaedb',power:.16,ambient:.12,sky:'#172a41',fog:'#283b51',exposure:1.55,night:1,wetness:.42,env:.14},
].map(key => ({...key,sunColor:new THREE.Color(key.color),skyColor:new THREE.Color(key.sky),fogColor:new THREE.Color(key.fog)}));
const SCALARS = ['elevation','azimuth','power','ambient','exposure','night','wetness','env'];
const DAY_HEMISPHERE = new THREE.Color('#c7d9ed');
const NIGHT_HEMISPHERE = new THREE.Color('#7899d1');
const clamp01 = value => THREE.MathUtils.clamp(value, 0, 1);
const smooth = (low,high,value) => {const t=clamp01((value-low)/(high-low));return t*t*(3-2*t);};

export class PhysicalLighting {
  constructor(renderer,scene,sun,hemi){
    this.renderer=renderer;this.scene=scene;this.sun=sun;this.hemi=hemi;
    this.skyScene=new THREE.Scene();this.sky=new Sky();this.sky.scale.setScalar(1000);this.skyScene.add(this.sky);
    this.pmrem=new THREE.PMREMGenerator(renderer);this.pmrem.compileCubemapShader();this.maps=new Map();
    this.sunDirection=new THREE.Vector3();this.sunColor=new THREE.Color();this.skyColor=new THREE.Color();
    this._sunTint=new THREE.Color();this._fogColor=new THREE.Color();
    this._center=new THREE.Vector3(15.5,0,15.5);this._skyDirection=new THREE.Vector3();
    this._background=new THREE.Color();this._fog=new THREE.FogExp2('#b8c6c8',.0045);
    this._originalDirection=sun.position.clone().sub(sun.target.position).normalize();
    this._environmentBucket=null;this._lastMinute=-1;this._lastMaterialNight=-1;this._lastMaterialWetness=-1;
    this._disposed=false;
    this.currentState={hour:17.5,time:'17:30',label:'夕照',preset:'golden',environment:'golden',night:0,wetness:0,exposure:1.14,elevation:35,azimuth:-135,power:3.4,ambient:.25,env:.36,realistic:true};
    this.preset='golden';this.realistic=true;
    this.sun.shadow.normalBias=.018;this.sun.shadow.bias=-.00008;this.sun.shadow.radius=3;
    Object.assign(this.sun.shadow.camera,{left:-24,right:24,top:24,bottom:-24,near:1,far:95});this.sun.shadow.camera.updateProjectionMatrix();
    this.hemi.groundColor.set('#73604a');
    // Only startup performs these renders. setTime never calls PMREM or creates
    // textures, even when an automatic day/night cycle crosses an environment bucket.
    this._prewarmEnvironments();
  }

  _prewarmEnvironments(){
    const r=this.renderer,target=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel();
    const tone=r.toneMapping,exposure=r.toneMappingExposure,space=r.outputColorSpace,auto=r.autoClear;
    const viewport=r.getViewport(new THREE.Vector4()),scissor=r.getScissor(new THREE.Vector4()),scissorTest=r.getScissorTest();
    try{
      r.toneMapping=THREE.NoToneMapping;
      for(const [name,p] of Object.entries(LIGHT_PRESETS)){
        if(this.maps.has(name))continue;
        const el=THREE.MathUtils.degToRad(p.elevation),az=THREE.MathUtils.degToRad(p.azimuth);
        this._skyDirection.set(Math.sin(az)*Math.cos(el),Math.sin(el),Math.cos(az)*Math.cos(el));
        const u=this.sky.material.uniforms;u.sunPosition.value.copy(this._skyDirection);
        u.turbidity.value=name==='blue'?4:3.2;u.rayleigh.value=2;u.mieCoefficient.value=.006;u.mieDirectionalG.value=.82;
        this.maps.set(name,this.pmrem.fromScene(this.skyScene,.035,.1,2500));
      }
    }finally{
      r.toneMapping=tone;r.toneMappingExposure=exposure;r.outputColorSpace=space;r.autoClear=auto;
      r.setRenderTarget(target,face,mip);r.setViewport(viewport);r.setScissor(scissor);r.setScissorTest(scissorTest);
    }
  }

  apply(name='golden',realistic=true){
    this.preset=LIGHT_PRESETS[name]?name:'golden';
    const preset=LIGHT_PRESETS[this.preset],state=this.setTime(preset.hour,realistic);
    // Discrete preset changes still update existing window/material appearance.
    // Continuous callers may do the same at a lower cadence using currentState.
    setMaterialLighting({night:state.night,wetness:state.wetness});
    return {...preset,...state};
  }

  setTime(hour,realistic=true){
    if(this._disposed)return this.currentState;
    const h=Number.isFinite(hour)?((hour%24)+24)%24:this.currentState.hour;
    this.realistic=Boolean(realistic);
    let index=0;while(index<DAY_KEYS.length-2&&h>DAY_KEYS[index+1].hour)index++;
    const a=DAY_KEYS[index],b=DAY_KEYS[index+1];
    const t=smooth(a.hour,b.hour,h),state=this.currentState;
    for(const key of SCALARS)state[key]=THREE.MathUtils.lerp(a[key],b[key],t);
    state.hour=h;state.realistic=this.realistic;state.preset=this.preset;
    const minute=Math.floor(h*60);
    if(minute!==this._lastMinute){state.time=`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;this._lastMinute=minute;}
    state.label=h>=5&&h<6.75?'曙光':h>=6.75&&h<10.5?'晨光':h>=10.5&&h<16?'昼光':h>=16&&h<18.8?'夕照':h>=18.8&&h<20.5?'蓝调':'月夜';
    this._sunTint.copy(a.sunColor).lerp(b.sunColor,t);
    this.skyColor.copy(a.skyColor).lerp(b.skyColor,t);
    this._fogColor.copy(a.fogColor).lerp(b.fogColor,t);

    if(this.realistic){
      const solarElevation=state.elevation;
      // A single shadow-casting directional source represents sun by day and a
      // much fainter moon after sunset. Direct energy fades to zero at the handoff.
      const daylight=solarElevation>=0;
      const elevation=daylight?solarElevation:Math.min(62,12-solarElevation*.65);
      const azimuth=state.azimuth+(daylight?0:105);
      const el=THREE.MathUtils.degToRad(elevation),az=THREE.MathUtils.degToRad(azimuth);
      this.sunDirection.set(Math.sin(az)*Math.cos(el),Math.sin(el),Math.cos(az)*Math.cos(el));
      state.power*=daylight?smooth(0,5,solarElevation):1-smooth(-5,0,solarElevation);
      this.sun.intensity=state.power;this.sun.color.copy(this._sunTint);
      this._background.copy(this.skyColor);this.scene.background=this._background;
      this._fog.color.copy(this._fogColor);this._fog.density=THREE.MathUtils.lerp(.0045,.009,state.night);this.scene.fog=this._fog;
      this.hemi.color.copy(DAY_HEMISPHERE).lerp(NIGHT_HEMISPHERE,state.night);this.hemi.intensity=state.ambient;
      // Nearest cached daylight appearance; constrain nighttime to its blue map.
      const bucket=state.night>.45?'blue':h<13?'morning':'golden';
      if(this._environmentBucket!==bucket){this.scene.environment=this.maps.get(bucket)?.texture||null;this._environmentBucket=bucket;}
      this.scene.environmentIntensity=state.env;state.environment=bucket;
    }else{
      state.night=0;state.wetness=0;state.exposure=1.12;state.power=2.4;state.ambient=1.6;state.env=0;state.label='基础光照';state.environment='none';
      this.sunDirection.copy(this._originalDirection);this.sun.color.set('#ffeccb');this.sun.intensity=2.4;
      this.skyColor.set('#bfd7dd');this._background.set('#c7dedd');this.scene.background=this._background;this.scene.fog=null;
      this.hemi.color.copy(DAY_HEMISPHERE);this.hemi.intensity=1.6;
      if(this._environmentBucket!=='none'){this.scene.environment=null;this._environmentBucket='none';}
      this.scene.environmentIntensity=0;
    }
    this.sun.position.copy(this.sunDirection).multiplyScalar(45).add(this._center);this.sun.target.position.copy(this._center);
    this.sunColor.copy(this.sun.color).multiplyScalar(this.sun.intensity);
    this.renderer.toneMappingExposure=state.exposure;
    return state;
  }

  getState(){return {...this.currentState};}

  dispose(){if(this._disposed)return;this._disposed=true;for(const t of this.maps.values())t.dispose();this.maps.clear();this.pmrem.dispose();this.sky.geometry.dispose();this.sky.material.dispose();}
}

// World-space microtexture keeps asphalt and terrain grain consistent across tiles.
export function surfaceMaterial(color,kind='stone'){
 const config={asphalt:{roughness:.88,metalness:0,clearcoat:.12},grass:{roughness:.98,metalness:0,clearcoat:0},stone:{roughness:.84,metalness:0,clearcoat:.03},metal:{roughness:.38,metalness:.72,clearcoat:.2}}[kind]||{};
 const m=new THREE.MeshPhysicalMaterial({color,...config,flatShading:true});m.userData.surface=kind;
 if(kind==='asphalt'||kind==='grass'||kind==='stone'){
  m.onBeforeCompile=shader=>{
   shader.vertexShader='varying vec3 vSurfaceWorld;\n'+shader.vertexShader;
   shader.vertexShader=shader.vertexShader.replace('#include <worldpos_vertex>',`#include <worldpos_vertex>
    vec4 swp=vec4(transformed,1.0);
    #ifdef USE_INSTANCING
      swp=instanceMatrix*swp;
    #endif
    vSurfaceWorld=(modelMatrix*swp).xyz;`);
   shader.fragmentShader='varying vec3 vSurfaceWorld;\nfloat surfaceHash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}\n'+shader.fragmentShader;
   shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#include <map_fragment>
    float grain=surfaceHash(floor(vSurfaceWorld*${kind==='asphalt'?'85.0':'45.0'}));
    diffuseColor.rgb *= mix(.92,1.04,grain);`);
  };m.customProgramCacheKey=()=>`surface-${kind}-1`;
 }
 return m;
}
