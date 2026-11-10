import * as THREE from './vendor/three.module.js';

// A small, local WebGL2 renderer: physically lit scene -> screen-space contact
// occlusion / diffuse bounce -> temporal reconstruction -> HDR display resolve.
// SSAO/SSGI only see visible surfaces; this is not hardware ray tracing or DLSS.
const QUALITIES = {
  performance: { scale: 0.6, samples: 6, contactSteps: 6 },
  balanced: { scale: 0.8, samples: 10, contactSteps: 8 },
  high: { scale: 1, samples: 16, contactSteps: 10 },
};
// History is the largest persistent allocation. Bound the reconstruction to an
// aspect-preserving Full HD pixel budget; the canvas itself keeps its native size.
const MAX_RECONSTRUCTION_PIXELS = 1920 * 1080;

const VERTEX = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const LIGHTING = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform mat4 uInverseProjection;
uniform mat4 uProjection;
uniform vec2 uResolution;
uniform vec3 uSunDirection;
uniform float uSunActive;
uniform float uViewHeight;
uniform float uFrame;
uniform float uAO;
uniform float uGI;
uniform int uSamples;
uniform int uContactSteps;

vec3 positionAt(vec2 uv, float depth) {
  vec4 p = uInverseProjection * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}
vec3 positionAt(vec2 uv) {
  return positionAt(uv, texture2D(uDepth, uv).r);
}
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float sunContactOcclusion(vec3 p, vec3 n, float phase) {
  float facingSun = dot(n, uSunDirection);
  if (uAO <= 0.0 || uSunActive <= 0.0 || facingSun <= 0.04) return 0.0;
  float pixelWorld = uViewHeight / uResolution.y;
  float bias = 0.03 + pixelWorld * 0.25;
  vec3 origin = p + n * bias;
  // A genuine short ray march through visible scene depth. Shadow maps provide
  // the long-range shadow; this only fills its small contact gaps. Offscreen and
  // hidden occluders cannot be recovered from this screen-space representation.
  for (int stepIndex = 0; stepIndex < 10; stepIndex++) {
    if (stepIndex >= uContactSteps) break;
    float fraction = (float(stepIndex) + 0.35 + phase * 0.5) / float(uContactSteps);
    float rayDistance = 0.045 + fraction * 0.655;
    vec3 rayPosition = origin + uSunDirection * rayDistance;
    vec4 clip = uProjection * vec4(rayPosition, 1.0);
    if (clip.w <= 0.0) break;
    vec3 ndc = clip.xyz / clip.w;
    vec2 uv = ndc.xy * 0.5 + 0.5;
    vec2 edge = 1.0 / uResolution;
    if (any(lessThan(uv, edge)) || any(greaterThan(uv, 1.0 - edge)) || abs(ndc.z) >= 1.0) break;
    float depth = texture2D(uDepth, uv).r;
    if (depth >= 0.999999) continue;
    float surfaceZ = positionAt(uv, depth).z;
    // View-space z points toward the viewer. A small positive separation means
    // the ray crossed the visible surface; reject large gaps as depth discontinuities.
    float separation = surfaceZ - rayPosition.z;
    float thickness = 0.10 + rayDistance * 0.08 + pixelWorld * 0.65;
    if (separation > 0.012 && separation < thickness) {
      float distanceFade = 1.0 - smoothstep(0.35, 0.70, rayDistance);
      float thicknessFade = 1.0 - smoothstep(thickness * 0.65, thickness, separation);
      return distanceFade * thicknessFade * smoothstep(0.04, 0.18, facingSun);
    }
  }
  return 0.0;
}
void main() {
  vec3 color = texture2D(uColor, vUv).rgb;
  float depth = texture2D(uDepth, vUv).r;
  if (depth >= 0.999999 || (uAO <= 0.0 && uGI <= 0.0)) {
    gl_FragColor = vec4(color, 1.0);
    return;
  }
  vec2 pixel = 1.0 / uResolution;
  vec3 p = positionAt(vUv, depth);
  vec3 left = positionAt(vUv - vec2(pixel.x, 0.0));
  vec3 right = positionAt(vUv + vec2(pixel.x, 0.0));
  vec3 down = positionAt(vUv - vec2(0.0, pixel.y));
  vec3 up = positionAt(vUv + vec2(0.0, pixel.y));
  // Select the nearer derivative at silhouettes, so roofs do not acquire halos.
  vec3 dx = abs(right.z - p.z) < abs(p.z - left.z) ? right - p : p - left;
  vec3 dy = abs(up.z - p.z) < abs(p.z - down.z) ? up - p : p - down;
  vec3 n = normalize(cross(dx, dy) + vec3(0.0, 0.0, 1e-8));
  if (n.z < 0.0) n = -n;
  const float radius = 1.25;
  float radiusPixels = clamp(radius * uResolution.y / max(uViewHeight, 0.01), 2.0, 72.0);
  float rotation = hash(floor(vUv * uResolution)) * 6.283185 + uFrame * 2.399963;
  float occlusion = 0.0;
  vec3 bounce = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    if (i >= uSamples) break;
    float f = (float(i) + 0.5) / float(uSamples);
    float angle = rotation + float(i) * 2.399963;
    vec2 offset = vec2(cos(angle), sin(angle)) * radiusPixels * sqrt(f) * pixel;
    vec2 uv = vUv + offset;
    if (any(lessThan(uv, pixel)) || any(greaterThan(uv, 1.0 - pixel))) continue;
    float sampleDepth = texture2D(uDepth, uv).r;
    if (sampleDepth >= 0.999999) continue;
    vec3 delta = positionAt(uv, sampleDepth) - p;
    float distanceToSample = length(delta);
    if (distanceToSample < 0.025 || distanceToSample > radius) continue;
    float cosine = max(dot(n, delta / distanceToSample) - 0.075, 0.0);
    float falloff = 1.0 - smoothstep(0.08, radius, distanceToSample);
    float weight = cosine * falloff;
    occlusion += weight;
    // Limited one-bounce irradiance estimate, not an albedo/visibility solution.
    vec3 nearbyRadiance = min(texture2D(uColor, uv).rgb, vec3(3.0));
    bounce += nearbyRadiance * weight / (1.0 + distanceToSample * distanceToSample);
  }
  float invSamples = 1.0 / float(uSamples);
  float ao = clamp(occlusion * invSamples * 3.6, 0.0, 0.82);
  vec3 indirect = min(bounce * invSamples * 0.72, vec3(0.20));
  float contact = sunContactOcclusion(p, n, hash(floor(vUv * uResolution) + vec2(uFrame * 13.0)));
  // Only partially attenuate the already sunlit image: preserve direct sunlight.
  // Contact rays contribute at most 23% extra darkness, and leave bounced light intact.
  color = color * (1.0 - ao * uAO * 0.58) * (1.0 - contact * min(uAO, 1.0) * 0.23) + indirect * uGI;
  gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
}`;

const TEMPORAL = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D uCurrent;
uniform sampler2D uDepth;
uniform sampler2D uHistory;
uniform mat4 uInverseViewProjection;
uniform mat4 uCurrentView;
uniform mat4 uPreviousViewProjection;
uniform mat4 uPreviousView;
uniform vec2 uInputResolution;
uniform vec2 uOutputResolution;
uniform vec2 uJitter;
uniform vec2 uPreviousJitter;
uniform float uHistoryWeight;
uniform float uDepthScale;
uniform float uDepthTolerance;

vec3 toYCoCg(vec3 c) {
  return vec3(dot(c, vec3(0.25, 0.5, 0.25)), c.r * 0.5 - c.b * 0.5,
              -c.r * 0.25 + c.g * 0.5 - c.b * 0.25);
}
vec3 fromYCoCg(vec3 c) {
  return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}
void main() {
  vec2 pixel = 1.0 / uInputResolution;
  // Resolve to an unjittered, full-output-resolution history. The eight jitter
  // phases sample different subpixel locations even below native resolution.
  vec2 uv = clamp(vUv + uJitter, pixel * 0.5, 1.0 - pixel * 0.5);
  vec3 current = texture2D(uCurrent, uv).rgb;
  float depth = texture2D(uDepth, uv).r;
  if (depth >= 0.999999) {
    gl_FragColor = vec4(current, 0.0);
    return;
  }
  vec4 world = uInverseViewProjection * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  world /= world.w;
  float currentDistance = -(uCurrentView * world).z;
  vec4 previousClip = uPreviousViewProjection * world;
  vec2 previousUv = previousClip.xy / previousClip.w * 0.5 + 0.5 - uPreviousJitter;
  float expectedDistance = -(uPreviousView * world).z;
  vec2 edge = 0.5 / uOutputResolution;
  bool inside = all(greaterThan(previousUv, edge)) && all(lessThan(previousUv, 1.0 - edge));
  float weight = uHistoryWeight;
  vec4 history = texture2D(uHistory, clamp(previousUv, edge, 1.0 - edge));
  float storedDistance = history.a / uDepthScale;
  if (!inside || previousClip.w <= 0.0 || history.a <= 0.0 ||
      abs(storedDistance - expectedDistance) > uDepthTolerance) weight = 0.0;

  // Variance plus 3x3 min/max clipping controls trails on cars, rotors, building
  // edits and disocclusions without requiring per-object motion-vector buffers.
  vec3 cmin = vec3(1e8), cmax = vec3(-1e8), mean = vec3(0.0), mean2 = vec3(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 c = toYCoCg(texture2D(uCurrent, uv + vec2(float(x), float(y)) * pixel).rgb);
      cmin = min(cmin, c); cmax = max(cmax, c);
      mean += c; mean2 += c * c;
    }
  }
  mean /= 9.0; mean2 /= 9.0;
  vec3 deviation = sqrt(max(mean2 - mean * mean, vec3(0.0)));
  vec3 low = max(cmin, mean - deviation * 1.3);
  vec3 high = min(cmax, mean + deviation * 1.3);
  vec3 clippedHistory = fromYCoCg(clamp(toYCoCg(history.rgb), low, high));
  float motion = length((previousUv - vUv) * uOutputResolution);
  float difference = abs(toYCoCg(current).x - toYCoCg(clippedHistory).x);
  weight *= 1.0 - clamp(motion * 0.007, 0.0, 0.35);
  weight *= 1.0 - clamp(difference / (0.12 + toYCoCg(current).x), 0.0, 0.70);
  gl_FragColor = vec4(max(mix(current, clippedHistory, weight), vec3(0.0)),
                      currentDistance * uDepthScale);
}`;

const OUTPUT = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D uImage;
uniform vec2 uResolution;
uniform float uSharpen;
uniform float uBloom;
uniform float uExposure;

float luminance(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 bright(vec2 uv) {
  vec3 c = texture2D(uImage, uv).rgb;
  float l = luminance(c);
  return c * max(l - 0.92, 0.0) / max(l, 0.001);
}
vec3 aces(vec3 x) {
  // The standard fitted ACES filmic display curve. Scene/history remain linear.
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 linearToSRGB(vec3 c) {
  vec3 low = 12.92 * c;
  vec3 high = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(high, low, step(c, vec3(0.0031308)));
}
void main() {
  vec2 p = 1.0 / uResolution;
  vec3 c = texture2D(uImage, vUv).rgb;
  vec3 n = texture2D(uImage, vUv + vec2(0.0, p.y)).rgb;
  vec3 s = texture2D(uImage, vUv - vec2(0.0, p.y)).rgb;
  vec3 e = texture2D(uImage, vUv + vec2(p.x, 0.0)).rgb;
  vec3 w = texture2D(uImage, vUv - vec2(p.x, 0.0)).rgb;
  vec3 minimum = min(c, min(min(n, s), min(e, w)));
  vec3 maximum = max(c, max(max(n, s), max(e, w)));
  float contrast = luminance(maximum - minimum) / (0.12 + luminance(maximum));
  float adaptive = (1.0 - smoothstep(0.2, 0.95, contrast)) * uSharpen;
  c = clamp(c + (c - (n + s + e + w) * 0.25) * adaptive,
            max(minimum - 0.015, vec3(0.0)), maximum + 0.015);
  // Sparse symmetric HDR highlight gather: intentionally subtle, inexpensive bloom.
  vec3 bloom = vec3(0.0);
  if (uBloom > 0.0) {
    bloom += bright(vUv + p * vec2(3.0, 0.0));
    bloom += bright(vUv + p * vec2(-3.0, 0.0));
    bloom += bright(vUv + p * vec2(0.0, 3.0));
    bloom += bright(vUv + p * vec2(0.0, -3.0));
    bloom += bright(vUv + p * vec2(7.0, 7.0)) * 0.5;
    bloom += bright(vUv + p * vec2(-7.0, 7.0)) * 0.5;
    bloom += bright(vUv + p * vec2(7.0, -7.0)) * 0.5;
    bloom += bright(vUv + p * vec2(-7.0, -7.0)) * 0.5;
    bloom /= 6.0;
  }
  c += min(bloom, vec3(3.0)) * uBloom * 0.13;
  // Apply exposure, filmic compression and the display transfer function once.
  gl_FragColor = vec4(linearToSRGB(aces(c * uExposure)), 1.0);
}`;

function halton(index, base) {
  let result = 0, fraction = 1 / base;
  while (index > 0) {
    result += fraction * (index % base);
    index = Math.floor(index / base);
    fraction /= base;
  }
  return result;
}

function strength(value, fallback, maximum = 2) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return Number.isFinite(value) ? THREE.MathUtils.clamp(value, 0, maximum) : fallback;
}

export class CinematicRenderer {
  constructor(renderer, scene, camera, { quality = 'balanced' } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.quality = QUALITIES[quality] ? quality : 'balanced';
    this.options = { ao: 1, gi: 0.8, bloom: 0.65, sharpen: 0.48, exposure: 1.0, temporal: true, enabled: true };
    this.hdr = renderer.extensions.has('EXT_color_buffer_float');
    this.frame = 0;
    this.historySamples = 0;
    this.historyReadIndex = 0;
    this.width = 1; this.height = 1;
    this.outputWidth = 1; this.outputHeight = 1;
    this.displayWidth = 1; this.displayHeight = 1;
    this.pixelBudgetLimited = false;
    this.cssWidth = 1; this.cssHeight = 1;
    this.disposed = false;
    this.originalProjection = new THREE.Matrix4();
    this.originalProjectionInverse = new THREE.Matrix4();
    this.viewProjection = new THREE.Matrix4();
    this.inverseViewProjection = new THREE.Matrix4();
    this.previousViewProjection = new THREE.Matrix4();
    this.previousView = new THREE.Matrix4();
    this.jitter = new THREE.Vector2();
    this.previousJitter = new THREE.Vector2();
    this.savedViewport = new THREE.Vector4();
    this.savedScissor = new THREE.Vector4();
    this.drawSize = new THREE.Vector2();
    this.sun = null;
    scene.traverse(object => {
      if (object.isDirectionalLight && (!this.sun || object.intensity > this.sun.intensity)) this.sun = object;
    });
    this.sunPosition = new THREE.Vector3();
    this.sunTarget = new THREE.Vector3();

    const makeTarget = depth => {
      const target = new THREE.WebGLRenderTarget(1, 1, {
        type: this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: depth,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      target.texture.colorSpace = THREE.LinearSRGBColorSpace;
      if (depth) {
        target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
        target.depthTexture.format = THREE.DepthFormat;
        target.depthTexture.minFilter = THREE.NearestFilter;
        target.depthTexture.magFilter = THREE.NearestFilter;
      }
      return target;
    };
    this.sceneTarget = makeTarget(true);
    this.lightingTarget = makeTarget(false);
    this.historyTargets = [makeTarget(false), makeTarget(false)];

    const makeMaterial = (fragmentShader, uniforms) => new THREE.ShaderMaterial({
      vertexShader: VERTEX, fragmentShader, uniforms,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.lightingMaterial = makeMaterial(LIGHTING, {
      uColor: { value: this.sceneTarget.texture }, uDepth: { value: this.sceneTarget.depthTexture },
      uInverseProjection: { value: camera.projectionMatrixInverse },
      uProjection: { value: camera.projectionMatrix },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) }, uSunActive: { value: 0 },
      uViewHeight: { value: 30 }, uFrame: { value: 0 },
      uAO: { value: 1 }, uGI: { value: 0.8 }, uSamples: { value: QUALITIES[this.quality].samples },
      uContactSteps: { value: QUALITIES[this.quality].contactSteps },
    });
    this.temporalMaterial = makeMaterial(TEMPORAL, {
      uCurrent: { value: this.lightingTarget.texture }, uDepth: { value: this.sceneTarget.depthTexture },
      uHistory: { value: this.historyTargets[0].texture },
      uInverseViewProjection: { value: this.inverseViewProjection },
      uCurrentView: { value: camera.matrixWorldInverse },
      uPreviousViewProjection: { value: this.previousViewProjection },
      uPreviousView: { value: this.previousView },
      uInputResolution: { value: new THREE.Vector2(1, 1) },
      uOutputResolution: { value: new THREE.Vector2(1, 1) },
      uJitter: { value: this.jitter }, uPreviousJitter: { value: this.previousJitter },
      uHistoryWeight: { value: 0 }, uDepthScale: { value: 1 }, uDepthTolerance: { value: 0.15 },
    });
    this.outputMaterial = makeMaterial(OUTPUT, {
      uImage: { value: this.historyTargets[1].texture },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uSharpen: { value: 0.48 }, uBloom: { value: 0.65 }, uExposure: { value: 1 },
    });
    // One oversized triangle avoids the quad's diagonal seam and extra raster work.
    this.fullscreenGeometry = new THREE.BufferGeometry();
    this.fullscreenGeometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.fullscreenGeometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.fullscreenMesh = new THREE.Mesh(this.fullscreenGeometry, this.lightingMaterial);
    this.fullscreenMesh.frustumCulled = false;
    this.fullscreenScene = new THREE.Scene();
    this.fullscreenScene.add(this.fullscreenMesh);
    this.fullscreenCamera = new THREE.Camera();
    this.onContextRestored = () => this.resetHistory();
    renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored);
    renderer.getSize(this.drawSize);
    this.setSize(this.drawSize.x, this.drawSize.y);
  }

  setSize(width, height) {
    this.cssWidth = Math.max(1, Math.round(width));
    this.cssHeight = Math.max(1, Math.round(height));
    const rendererDpr = this.renderer.getPixelRatio();
    const dpr = Math.min(rendererDpr, 1.5);
    const scale = QUALITIES[this.quality].scale;
    this.displayWidth = Math.max(1, Math.floor(this.cssWidth * rendererDpr));
    this.displayHeight = Math.max(1, Math.floor(this.cssHeight * rendererDpr));
    const desiredWidth = this.cssWidth * dpr;
    const desiredHeight = this.cssHeight * dpr;
    const textureLimit = this.renderer.capabilities?.maxTextureSize || 8192;
    const budgetScale = Math.min(1,
      Math.sqrt(MAX_RECONSTRUCTION_PIXELS / (desiredWidth * desiredHeight)),
      textureLimit / desiredWidth, textureLimit / desiredHeight);
    this.pixelBudgetLimited = budgetScale < 1;
    this.outputWidth = Math.max(1, Math.floor(desiredWidth * budgetScale));
    this.outputHeight = Math.max(1, Math.floor(desiredHeight * budgetScale));
    this.width = Math.max(1, Math.round(this.outputWidth * scale));
    this.height = Math.max(1, Math.round(this.outputHeight * scale));
    this.sceneTarget.setSize(this.width, this.height);
    this.lightingTarget.setSize(this.width, this.height);
    for (const target of this.historyTargets) target.setSize(this.outputWidth, this.outputHeight);
    this.lightingMaterial.uniforms.uResolution.value.set(this.width, this.height);
    this.temporalMaterial.uniforms.uInputResolution.value.set(this.width, this.height);
    this.temporalMaterial.uniforms.uOutputResolution.value.set(this.outputWidth, this.outputHeight);
    this.outputMaterial.uniforms.uResolution.value.set(this.outputWidth, this.outputHeight);
    // All reprojection/jitter offsets use these render-texture sizes. The camera
    // frustum and renderer viewport remain in the caller's original aspect/size;
    // the last fullscreen pass resolves to that viewport, including on resize.
    this.resetHistory();
  }

  setQuality(name) {
    if (!QUALITIES[name] || name === this.quality) return;
    this.quality = name;
    this.lightingMaterial.uniforms.uSamples.value = QUALITIES[name].samples;
    this.lightingMaterial.uniforms.uContactSteps.value = QUALITIES[name].contactSteps;
    this.setSize(this.cssWidth, this.cssHeight);
  }

  setOptions(options = {}) {
    const oldAO = this.options.ao, oldGI = this.options.gi, oldEnabled = this.options.enabled, oldTemporal = this.options.temporal;
    for (const key of ['ao', 'gi', 'bloom', 'sharpen']) {
      this.options[key] = strength(options[key], this.options[key]);
    }
    if (Number.isFinite(options.exposure)) this.options.exposure = THREE.MathUtils.clamp(options.exposure, 0.05, 5);
    if (options.temporal !== undefined) this.options.temporal = Boolean(options.temporal);
    if (options.enabled !== undefined) this.options.enabled = Boolean(options.enabled);
    if (oldAO !== this.options.ao || oldGI !== this.options.gi || oldEnabled !== this.options.enabled || oldTemporal !== this.options.temporal) this.resetHistory();
  }

  resetHistory() {
    this.historySamples = 0;
    this.frame = 0;
  }

  render(dt = 1 / 60) {
    if (this.disposed) return;
    const renderer = this.renderer, camera = this.camera;
    if (!this.options.enabled) {
      renderer.render(this.scene, camera);
      return;
    }
    // Do not accumulate across background-tab suspension or a paused debugger.
    if (dt > 0.25) this.resetHistory();
    const savedTarget = renderer.getRenderTarget();
    const savedCubeFace = renderer.getActiveCubeFace();
    const savedMipLevel = renderer.getActiveMipmapLevel();
    const savedToneMapping = renderer.toneMapping;
    const savedExposure = renderer.toneMappingExposure;
    const savedColorSpace = renderer.outputColorSpace;
    const savedAutoClear = renderer.autoClear;
    const savedScissorTest = renderer.getScissorTest();
    renderer.getViewport(this.savedViewport);
    renderer.getScissor(this.savedScissor);
    this.originalProjection.copy(camera.projectionMatrix);
    this.originalProjectionInverse.copy(camera.projectionMatrixInverse);

    try {
      renderer.autoClear = true;
      renderer.setScissorTest(false);
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      camera.updateMatrixWorld();
      const phase = (this.frame % 8) + 1;
      if (this.options.temporal) this.jitter.set((halton(phase, 2) - 0.5) / this.width, (halton(phase, 3) - 0.5) / this.height);
      else this.jitter.set(0, 0);
      // Projection row 0/1 offset in clip coordinates; correct for both camera types.
      const elements = camera.projectionMatrix.elements;
      if (camera.isOrthographicCamera) {
        elements[12] += this.jitter.x * 2;
        elements[13] += this.jitter.y * 2;
      } else {
        elements[8] -= this.jitter.x * 2;
        elements[9] -= this.jitter.y * 2;
      }
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.inverseViewProjection.copy(this.viewProjection).invert();
      if (this.historySamples === 0) {
        this.previousViewProjection.copy(this.viewProjection);
        this.previousView.copy(camera.matrixWorldInverse);
        this.previousJitter.copy(this.jitter);
      }
      const viewHeight = camera.isOrthographicCamera
        ? Math.abs(camera.top - camera.bottom) / camera.zoom
        : 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * 40;
      const lighting = this.lightingMaterial.uniforms;
      lighting.uViewHeight.value = viewHeight;
      lighting.uFrame.value = this.options.temporal ? this.frame % 8 : 0;
      lighting.uAO.value = this.options.ao;
      lighting.uGI.value = this.options.gi;
      lighting.uSunActive.value = this.sun?.visible && this.sun.intensity > 0 ? 1 : 0;
      if (lighting.uSunActive.value) {
        this.sun.getWorldPosition(this.sunPosition);
        this.sun.target.getWorldPosition(this.sunTarget);
        lighting.uSunDirection.value.subVectors(this.sunPosition, this.sunTarget).normalize()
          .transformDirection(camera.matrixWorldInverse);
      }
      renderer.setRenderTarget(this.sceneTarget);
      renderer.render(this.scene, camera);

      this.fullscreenMesh.material = this.lightingMaterial;
      renderer.setRenderTarget(this.lightingTarget);
      renderer.render(this.fullscreenScene, this.fullscreenCamera);

      const read = this.historyTargets[this.historyReadIndex];
      const write = this.historyTargets[1 - this.historyReadIndex];
      const temporal = this.temporalMaterial.uniforms;
      temporal.uHistory.value = read.texture;
      temporal.uHistoryWeight.value = !this.options.temporal || this.historySamples === 0 ? 0 : Math.min(0.90, this.historySamples / (this.historySamples + 1));
      temporal.uDepthScale.value = this.hdr ? 1 : 1 / camera.far;
      temporal.uDepthTolerance.value = Math.max(this.hdr ? 0.10 : camera.far / 255 * 1.25, viewHeight / this.height * 0.65);
      this.fullscreenMesh.material = this.temporalMaterial;
      renderer.setRenderTarget(write);
      renderer.render(this.fullscreenScene, this.fullscreenCamera);

      const output = this.outputMaterial.uniforms;
      output.uImage.value = write.texture;
      output.uSharpen.value = this.options.sharpen;
      output.uBloom.value = this.options.bloom;
      output.uExposure.value = this.options.exposure;
      this.fullscreenMesh.material = this.outputMaterial;
      renderer.setRenderTarget(savedTarget, savedCubeFace, savedMipLevel);
      renderer.setViewport(this.savedViewport);
      renderer.render(this.fullscreenScene, this.fullscreenCamera);

      this.historyReadIndex = 1 - this.historyReadIndex;
      this.previousViewProjection.copy(this.viewProjection);
      this.previousView.copy(camera.matrixWorldInverse);
      this.previousJitter.copy(this.jitter);
      this.historySamples = this.options.temporal ? Math.min(32, this.historySamples + 1) : 0;
      this.frame++;
    } finally {
      // Picking and the next reflection render must see the unjittered camera.
      camera.projectionMatrix.copy(this.originalProjection);
      camera.projectionMatrixInverse.copy(this.originalProjectionInverse);
      renderer.toneMapping = savedToneMapping;
      renderer.toneMappingExposure = savedExposure;
      renderer.outputColorSpace = savedColorSpace;
      renderer.autoClear = savedAutoClear;
      renderer.setRenderTarget(savedTarget, savedCubeFace, savedMipLevel);
      renderer.setViewport(this.savedViewport);
      renderer.setScissor(this.savedScissor);
      renderer.setScissorTest(savedScissorTest);
    }
  }

  getInfo() {
    const colorBytes = this.hdr ? 8 : 4;
    const targetBytes = this.width * this.height * (2 * colorBytes + 4)
      + this.outputWidth * this.outputHeight * 2 * colorBytes;
    return {
      quality: this.quality,
      width: this.width, height: this.height,
      outputWidth: this.outputWidth, outputHeight: this.outputHeight,
      displayWidth: this.displayWidth, displayHeight: this.displayHeight,
      outputScale: this.outputWidth / this.displayWidth,
      pixelBudget: MAX_RECONSTRUCTION_PIXELS,
      pixelBudgetLimited: this.pixelBudgetLimited,
      // Color/depth attachments only; excludes shadows, reflection, PMREM and canvas.
      estimatedTargetMemoryMB: Math.round(targetBytes / 100000) / 10,
      scale: QUALITIES[this.quality].scale,
      historySamples: this.historySamples,
      jitterPhases: 8,
      hdr: this.hdr,
      colorFormat: this.hdr ? 'RGBA16F' : 'RGBA8 fallback',
      fullscreenPasses: this.options.enabled ? 3 : 0,
      enabled: this.options.enabled,
      temporal: this.options.temporal,
      aoSamples: QUALITIES[this.quality].samples,
      contactRaySteps: QUALITIES[this.quality].contactSteps,
      contactRayDistance: 0.7,
      reconstruction: 'depth-reprojected temporal upscale',
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.sceneTarget.dispose();
    this.lightingTarget.dispose();
    for (const target of this.historyTargets) target.dispose();
    this.lightingMaterial.dispose();
    this.temporalMaterial.dispose();
    this.outputMaterial.dispose();
    this.fullscreenGeometry.dispose();
  }
}
