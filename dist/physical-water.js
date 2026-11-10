import * as THREE from './vendor/three.module.js';

const WATER_Y = -0.055;
const QUALITY = Object.freeze({
  high: { size: 768, stride: 2 },
  balanced: { size: 512, stride: 3 },
  performance: { size: 256, stride: 5 }
});

const vertexShader = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  #include <shadowmap_pars_vertex>
  #include <clipping_planes_pars_vertex>
  attribute float waterDepth;
  uniform mat4 reflectionMatrix;
  varying vec3 vWaterWorld;
  varying vec4 vReflectionCoord;
  varying float vWaterDepth;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vec4 mvPosition = viewMatrix * worldPosition;
    vec3 transformedNormal = normalMatrix * vec3(0.0, 1.0, 0.0);
    vWaterWorld = worldPosition.xyz;
    vWaterDepth = waterDepth;
    vReflectionCoord = reflectionMatrix * worldPosition;
    gl_Position = projectionMatrix * mvPosition;
    #include <shadowmap_vertex>
    #include <fog_vertex>
    #include <clipping_planes_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <packing>
  #include <lights_pars_begin>
  #include <shadowmap_pars_fragment>
  #include <shadowmask_pars_fragment>
  #include <fog_pars_fragment>
  #include <clipping_planes_pars_fragment>
  uniform sampler2D reflectionTexture;
  uniform float time;
  uniform float reflectionReady;
  uniform float effectsEnabled;
  uniform float orthographicView;
  uniform vec3 orthoViewDirection;
  uniform vec3 sunDirection;
  uniform vec3 sunColor;
  uniform vec3 skyColor;
  uniform vec3 baseColor;
  uniform vec2 reflectionTexel;
  varying vec3 vWaterWorld;
  varying vec4 vReflectionCoord;
  varying float vWaterDepth;

  // Analytic derivatives of five small gravity/capillary waves. Their shared
  // world coordinates keep normals continuous across the voxel tile edges.
  vec3 waveNormal(vec2 p) {
    float a = dot(p, vec2(1.7, 0.72)) - time * 1.05;
    float b = dot(p, vec2(-0.93, 2.4)) - time * 1.38;
    float c = dot(p, vec2(5.2, 3.7)) - time * 2.1;
    float d = dot(p, vec2(9.1, -7.4)) - time * 2.7;
    float e = dot(p, vec2(-13.5, -5.2)) - time * 3.35;
    // Crossing slopes distribute a mirror-aligned sun over small glints instead
    // of making the entire near-flat river fall inside one broad specular lobe.
    vec2 slope = cos(a) * vec2(1.7, 0.72) * 0.0416
               + cos(b) * vec2(-0.93, 2.4) * 0.0286
               + cos(c) * vec2(5.2, 3.7) * 0.0104
               + cos(d) * vec2(9.1, -7.4) * 0.00312
               + cos(e) * vec2(-13.5, -5.2) * 0.00208;
    return normalize(vec3(-slope.x, 1.0, -slope.y));
  }

  float fresnelWater(float cosine) {
    // Air -> freshwater IOR 1.333: normal-incidence reflectance is 2.04%.
    const float F0 = 0.0203732;
    return F0 + (1.0 - F0) * pow(1.0 - clamp(cosine, 0.0, 1.0), 5.0);
  }

  float ggxDistribution(float NoH, float alpha) {
    float a2 = alpha * alpha;
    float denominator = NoH * NoH * (a2 - 1.0) + 1.0;
    return a2 / max(PI * denominator * denominator, 0.00000001);
  }

  float smithMask(float NoX, float alpha) {
    float a2 = alpha * alpha;
    return 2.0 * NoX / max(NoX + sqrt(a2 + (1.0 - a2) * NoX * NoX), 0.0001);
  }

  void main() {
    vec4 diffuseColor = vec4(1.0);
    #include <clipping_planes_fragment>
    vec3 N = waveNormal(vWaterWorld.xz);
    vec3 V = orthographicView > 0.5 ? orthoViewDirection : normalize(cameraPosition - vWaterWorld);
    float NoV = max(dot(N, V), 0.001);
    vec3 L = normalize(sunDirection);
    float NoL = max(dot(N, L), 0.0);
    float shadow = getShadowMask();

    // A shallow river bed, not a full scene refraction buffer. Beer–Lambert
    // attenuation removes red wavelengths faster along the water path.
    float rayLength = vWaterDepth / max(NoV, 0.25);
    vec3 transmission = exp(-vec3(2.30, 0.55, 0.24) * rayLength);
    float bedVariation = 0.93 + 0.035 * sin(vWaterWorld.x * 4.9 + vWaterWorld.z * 2.7)
                              + 0.025 * sin(vWaterWorld.z * 8.3 - vWaterWorld.x * 3.1);
    // Submerged dark stone/silt: a bright tan bed previously overwhelmed the
    // scattering colour in every shallow tile and made the river look beige.
    vec3 bedAlbedo = vec3(0.065, 0.090, 0.082) * bedVariation;
    vec3 riverBody = mix(baseColor, bedAlbedo, transmission);
    vec3 illumination = skyColor * 0.42 + sunColor * (NoL * shadow * 0.13);
    riverBody *= illumination + vec3(0.12);

    vec2 reflectedUv = vReflectionCoord.xy / max(vReflectionCoord.w, 0.0001);
    vec2 ripple = N.xz * 0.018;
    vec2 uv = clamp(reflectedUv + ripple, reflectionTexel * 1.5, vec2(1.0) - reflectionTexel * 1.5);
    vec3 reflection = texture2D(reflectionTexture, uv).rgb;
    float inView = step(0.0, reflectedUv.x) * step(reflectedUv.x, 1.0)
                 * step(0.0, reflectedUv.y) * step(reflectedUv.y, 1.0);
    reflection = mix(skyColor, reflection, reflectionReady * effectsEnabled * inView);
    float fresnel = fresnelWater(NoV);
    vec3 color = riverBody * (1.0 - fresnel) + reflection * fresnel;

    // Cook–Torrance direct reflection of the sun. Narrow microscopic roughness
    // keeps the body colour visible between glints; screen derivatives filter
    // unresolved normals, reducing sparkle aliasing while the camera moves.
    vec3 H = normalize(L + V);
    float NoH = max(dot(N, H), 0.0);
    float VoH = max(dot(V, H), 0.0);
    vec3 normalDx = dFdx(N), normalDy = dFdy(N);
    float normalVariance = dot(normalDx, normalDx) + dot(normalDy, normalDy);
    float alpha = sqrt(0.014 * 0.014 + min(normalVariance * 0.18, 0.0002));
    float specular = ggxDistribution(NoH, alpha) * smithMask(NoV, alpha)
                   * smithMask(NoL, alpha) * fresnelWater(VoH)
                   / max(4.0 * NoV * NoL, 0.0001);
    vec3 sunGlitter = sunColor * specular * NoL * shadow * effectsEnabled;
    // Bound unresolved solar fireflies in HDR without changing Fresnel, planar
    // reflections or the river-body radiance. Display exposure/ACES still happens
    // exactly once in the main pipeline; this is a local sparkle filter only.
    float peakGlitter = max(sunGlitter.r, max(sunGlitter.g, sunGlitter.b));
    sunGlitter /= 1.0 + peakGlitter / 2.2;
    color += sunGlitter;
    gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

function riverGeometry(cells) {
  const occupied = new Set(cells.map(c => `${c.x},${c.z}`));
  const cellDepth = new Map();
  for (const c of cells) {
    let distance = 1;
    search: for (; distance < 5; distance++) {
      for (let dx = -distance; dx <= distance; dx++) {
        const dz = distance - Math.abs(dx);
        if (!occupied.has(`${c.x + dx},${c.z + dz}`) || !occupied.has(`${c.x + dx},${c.z - dz}`)) break search;
      }
    }
    cellDepth.set(`${c.x},${c.z}`, 0.38 + Math.min(distance, 4) * 0.22);
  }
  const positions = new Float32Array(cells.length * 12);
  const depths = new Float32Array(cells.length * 4);
  const IndexArray = cells.length * 4 > 65535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(cells.length * 6);
  const corners = [[-0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0.5, -0.5]];
  cells.forEach((cell, i) => {
    for (let corner = 0; corner < 4; corner++) {
      const x = cell.x + corners[corner][0], z = cell.z + corners[corner][1];
      const vertex = i * 4 + corner;
      positions.set([x, WATER_Y, z], vertex * 3);
      // The four cells touching each vertex share the same averaged depth.
      let depth = 0;
      for (const dx of [-0.5, 0.5]) for (const dz of [-0.5, 0.5]) {
        depth += cellDepth.get(`${x + dx},${z + dz}`) || 0.12;
      }
      depths[vertex] = depth * 0.25;
    }
    const v = i * 4;
    indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('waterDepth', new THREE.BufferAttribute(depths, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** A real planar scene reflection plus a small physically based water BRDF.
 * The surface remains visible when reflection effects are disabled.
 * Call renderReflection() before the primary scene/post-processing render.
 */
export class PhysicalWater {
  constructor(renderer, scene, camera, cells) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;
    this._disposed = false;
    this._rendering = false;
    this._frame = 0;
    this._forceReflection = true;
    this._reflectionCamera = camera.clone();
    this._reflectionCamera.name = 'River planar reflection camera';
    this._position = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._sourceWorld = new THREE.Matrix4();
    this._sourceProjection = new THREE.Matrix4();
    this._savedViewport = new THREE.Vector4();
    this._savedScissor = new THREE.Vector4();
    this._savedClear = new THREE.Color();
    this._clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -WATER_Y - 0.002);
    this._clipPlanes = [this._clipPlane];
    this._bias = new THREE.Matrix4().set(
      0.5, 0, 0, 0.5,
      0, 0.5, 0, 0.5,
      0, 0, 0.5, 0.5,
      0, 0, 0, 1
    );
    const hdr = renderer.extensions.has('EXT_color_buffer_float');
    this.reflectionTarget = new THREE.WebGLRenderTarget(512, 512, {
      type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false
    });
    this.reflectionTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.reflectionTarget.texture.name = 'River reflection · scene-linear';
    this.uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.lights,
      THREE.UniformsLib.fog,
      {
        reflectionTexture: { value: null },
        reflectionMatrix: { value: new THREE.Matrix4() },
        reflectionTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
        reflectionReady: { value: 0 },
        effectsEnabled: { value: 1 },
        time: { value: 0 },
        orthographicView: { value: camera.isOrthographicCamera ? 1 : 0 },
        orthoViewDirection: { value: new THREE.Vector3(0, 1, 0) },
        sunDirection: { value: new THREE.Vector3(-0.55, 0.78, -0.3).normalize() },
        sunColor: { value: new THREE.Color('#fff0d8').multiplyScalar(2.4) },
        skyColor: { value: new THREE.Color('#adc4cc') },
        baseColor: { value: new THREE.Color('#155768') }
      }
    ]);
    // Bind the live attachment after cloning only the scalar/light uniforms.
    this.uniforms.reflectionTexture.value = this.reflectionTarget.texture;
    this.material = new THREE.ShaderMaterial({
      name: 'Freshwater · Fresnel / GGX / Beer–Lambert',
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      lights: true,
      fog: true,
      clipping: true,
      toneMapped: true,
      depthWrite: true,
      side: THREE.FrontSide
    });
    this.mesh = new THREE.Mesh(riverGeometry(cells), this.material);
    this.mesh.name = 'Physical river surface';
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);
    this.setQuality('balanced');
  }

  setQuality(quality) {
    const selected = QUALITY[quality] ? quality : 'balanced';
    const { size, stride } = QUALITY[selected];
    this.quality = selected;
    this._stride = stride;
    if (this.reflectionTarget.width !== size) this.reflectionTarget.setSize(size, size);
    this.uniforms.reflectionTexel.value.set(1 / size, 1 / size);
    this._forceReflection = true;
  }

  setEnabled(enabled) {
    const next = !!enabled;
    if (next && !this.enabled) this._forceReflection = true;
    this.enabled = next;
    this.uniforms.effectsEnabled.value = next ? 1 : 0;
  }

  update(dt, { sunDirection, sunColor, skyColor, baseColor, paused = false, enabled } = {}) {
    if (this._disposed) return;
    if (!paused && Number.isFinite(dt)) this.uniforms.time.value += Math.max(0, Math.min(dt, 0.1));
    if (sunDirection) this.uniforms.sunDirection.value.copy(sunDirection).normalize();
    if (sunColor) this.uniforms.sunColor.value.copy(sunColor);
    if (skyColor) this.uniforms.skyColor.value.copy(skyColor);
    if (baseColor) this.uniforms.baseColor.value.copy(baseColor);
    if (enabled !== undefined) this.setEnabled(enabled);
    this.camera.getWorldDirection(this.uniforms.orthoViewDirection.value).negate();
    this.uniforms.orthographicView.value = this.camera.isOrthographicCamera ? 1 : 0;
  }

  renderReflection() {
    if (this._disposed || this._rendering || !this.enabled || !this.mesh.visible) return false;
    const source = this.camera;
    source.updateMatrixWorld();
    const cameraChanged = !this._sourceWorld.equals(source.matrixWorld)
                       || !this._sourceProjection.equals(source.projectionMatrix);
    this._frame++;
    if (!this._forceReflection && !cameraChanged && this._frame % this._stride !== 0) return false;

    const reflected = this._reflectionCamera;
    source.getWorldPosition(this._position);
    if (this._position.y <= WATER_Y) return false;
    source.getWorldDirection(this._forward);
    reflected.position.copy(this._position);
    reflected.position.y = 2 * WATER_Y - this._position.y;
    this._forward.y *= -1;
    this._target.copy(reflected.position).add(this._forward);
    reflected.up.setFromMatrixColumn(source.matrixWorld, 1);
    reflected.up.y *= -1;
    reflected.lookAt(this._target);
    reflected.near = source.near;
    reflected.far = source.far;
    reflected.layers.mask = source.layers.mask;
    reflected.projectionMatrix.copy(source.projectionMatrix);
    reflected.projectionMatrixInverse.copy(source.projectionMatrixInverse);
    reflected.updateMatrixWorld();
    this.uniforms.reflectionMatrix.value.copy(this._bias)
      .multiply(reflected.projectionMatrix).multiply(reflected.matrixWorldInverse);
    source.getWorldDirection(this.uniforms.orthoViewDirection.value).negate();

    const renderer = this.renderer;
    const target = renderer.getRenderTarget();
    const cubeFace = renderer.getActiveCubeFace();
    const mipLevel = renderer.getActiveMipmapLevel();
    const autoClear = renderer.autoClear;
    const toneMapping = renderer.toneMapping;
    const exposure = renderer.toneMappingExposure;
    const colorSpace = renderer.outputColorSpace;
    const clippingPlanes = renderer.clippingPlanes;
    const localClipping = renderer.localClippingEnabled;
    const xrEnabled = renderer.xr.enabled;
    const shadowAutoUpdate = renderer.shadowMap.autoUpdate;
    const shadowNeedsUpdate = renderer.shadowMap.needsUpdate;
    const clearAlpha = renderer.getClearAlpha();
    const scissorTest = renderer.getScissorTest();
    const meshVisible = this.mesh.visible;
    renderer.getViewport(this._savedViewport);
    renderer.getScissor(this._savedScissor);
    renderer.getClearColor(this._savedClear);
    this._clipPlanes.length = 1;
    for (let i = 0; i < clippingPlanes.length; i++) this._clipPlanes.push(clippingPlanes[i]);
    this._rendering = true;
    try {
      this.mesh.visible = false;
      renderer.xr.enabled = false;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;
      renderer.autoClear = true;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      renderer.clippingPlanes = this._clipPlanes;
      renderer.localClippingEnabled = true;
      renderer.setRenderTarget(this.reflectionTarget);
      renderer.setScissorTest(false);
      renderer.setClearColor(this.uniforms.skyColor.value, 1);
      renderer.clear();
      renderer.render(this.scene, reflected);
      this.uniforms.reflectionReady.value = 1;
      this._sourceWorld.copy(source.matrixWorld);
      this._sourceProjection.copy(source.projectionMatrix);
      this._forceReflection = false;
    } finally {
      this.mesh.visible = meshVisible;
      renderer.xr.enabled = xrEnabled;
      renderer.shadowMap.autoUpdate = shadowAutoUpdate;
      renderer.shadowMap.needsUpdate = shadowNeedsUpdate;
      renderer.autoClear = autoClear;
      renderer.toneMapping = toneMapping;
      renderer.toneMappingExposure = exposure;
      renderer.outputColorSpace = colorSpace;
      renderer.clippingPlanes = clippingPlanes;
      renderer.localClippingEnabled = localClipping;
      renderer.setRenderTarget(target, cubeFace, mipLevel);
      renderer.setViewport(this._savedViewport);
      renderer.setScissor(this._savedScissor);
      renderer.setScissorTest(scissorTest);
      renderer.setClearColor(this._savedClear, clearAlpha);
      this._rendering = false;
    }
    return true;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.reflectionTarget.dispose();
  }
}
