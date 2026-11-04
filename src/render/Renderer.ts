import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CONFIG } from '../config';

/** One on-screen view: its camera and its share of the canvas (fractions, origin bottom-left). */
export interface View {
  camera: THREE.PerspectiveCamera;
  rect: { x: number; y: number; w: number; h: number };
}

const FULL = { x: 0, y: 0, w: 1, h: 1 };

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  /**
   * What is drawn: one full-screen view (`camera`), or two side-by-side halves in Local Versus
   * (setViews). The second camera and its composer are built on first use.
   */
  readonly views: View[];
  private camera2: THREE.PerspectiveCamera | null = null;
  private composer2: EffectComposer | null = null;
  private bloom2: UnrealBloomPass | null = null;
  /** The settings' shadow choice, and the map size it uses outside split-screen. */
  private shadowSize: number = CONFIG.render.shadowMapSize;
  private bloomOn = true;
  /** Pixel height factor used by point-sprite shaders for size attenuation. */
  pointScale = 1;
  /** Extra bloom on top of CONFIG.render.bloomStrength (a boss transformation; negative turns it down). */
  bloomBoost = 0;
  private resizeListeners: (() => void)[] = [];
  /** Offscreen target of `precompile`, and its shadow-pass depth materials (one per variant, kept). */
  private warmTarget: THREE.WebGLRenderTarget | null = null;
  private readonly depthWarm = new Map<string, THREE.MeshDepthMaterial>();

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.render.maxPixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = CONFIG.render.exposure;
    this.renderer.shadowMap.enabled = CONFIG.render.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Post-processing renders several times per frame; reset stats once per frame instead.
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 1, 0.06, 400);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(256, 256),
      CONFIG.render.bloomStrength,
      CONFIG.render.bloomRadius,
      CONFIG.render.bloomThreshold,
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.views = [{ camera: this.camera, rect: { ...FULL } }];

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  onResize(fn: () => void): void {
    this.resizeListeners.push(fn);
  }

  /** The second view's camera (built on first use). */
  get secondCamera(): THREE.PerspectiveCamera {
    return (this.camera2 ??= new THREE.PerspectiveCamera(CONFIG.versus.fov, 1, 0.06, 400));
  }

  /**
   * One full-screen view, or two vertical halves (P1 left, P2 right) for Local Versus. Split mode
   * builds a second composer (bloom at CONFIG.versus strength and resolution), widens both fields
   * of view and drops the shadow map to CONFIG.versus.shadowMapSize; one view puts it all back.
   */
  setViews(count: 1 | 2): void {
    if (count === this.views.length) return;
    const V = CONFIG.versus;
    if (count === 2) {
      const cam2 = this.secondCamera;
      if (!this.composer2) {
        const c = new EffectComposer(this.renderer);
        c.addPass(new RenderPass(this.scene, cam2));
        this.bloom2 = new UnrealBloomPass(new THREE.Vector2(128, 128), CONFIG.render.bloomStrength, CONFIG.render.bloomRadius, CONFIG.render.bloomThreshold);
        c.addPass(this.bloom2);
        c.addPass(new OutputPass());
        this.composer2 = c;
      }
      this.views.splice(0, this.views.length, { camera: this.camera, rect: { x: 0, y: 0, w: 0.5, h: 1 } }, { camera: cam2, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } });
      this.setShadowMapSize(V.shadowMapSize);
    } else {
      this.views.splice(0, this.views.length, { camera: this.camera, rect: { ...FULL } });
      this.setShadowMapSize(this.shadowSize);
    }
    this.resize();
  }

  /** Shadow map resolution of every shadow-casting light (the map is rebuilt on the next frame). */
  private setShadowMapSize(size: number): void {
    this.scene.traverse((o) => {
      const l = o as THREE.DirectionalLight;
      if (!l.isLight || !l.shadow || l.shadow.mapSize.x === size) return;
      l.shadow.mapSize.set(size, size);
      l.shadow.map?.dispose();
      l.shadow.map = null;
    });
  }

  get split(): boolean {
    return this.views.length > 1;
  }

  setQuality(opts: { bloom: boolean; shadows: boolean }): void {
    this.bloom.enabled = opts.bloom;
    this.bloomOn = opts.bloom;
    if (this.bloom2) this.bloom2.enabled = opts.bloom;
    if (this.renderer.shadowMap.enabled !== opts.shadows) {
      this.renderer.shadowMap.enabled = opts.shadows;
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m) m.needsUpdate = true;
      });
    }
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    if (this.split) {
      const V = CONFIG.versus;
      const vw = Math.round(w / 2);
      for (const [c, b] of [[this.composer, this.bloom], [this.composer2!, this.bloom2!]] as const) {
        c.setSize(vw, h);
        b.setSize(Math.max(1, Math.round((vw * pr) / V.bloomResDivisor)), Math.max(1, Math.round((h * pr) / V.bloomResDivisor)));
      }
      for (const v of this.views) {
        v.camera.aspect = vw / h;
        v.camera.updateProjectionMatrix();
      }
    } else {
      this.composer.setSize(w, h);
      // Bloom at half resolution: most of the glow, a fraction of the cost.
      this.bloom.setSize(Math.round((w * pr) / 2), Math.round((h * pr) / 2));
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.pointScale = (h * pr) / 2;
    for (const fn of this.resizeListeners) fn();
  }

  /** The vertical field of view a camera rig should aim for: wider in split-screen. */
  get baseFov(): number {
    return this.split ? CONFIG.versus.fov : CONFIG.camera.fov;
  }

  render(): void {
    this.renderer.info.reset();
    const strength = Math.max(0, CONFIG.render.bloomStrength + this.bloomBoost);
    if (!this.split) {
      this.bloom.strength = strength;
      this.composer.render();
      return;
    }
    // Split-screen: each half through its own composer into its own viewport. The sun's shadow
    // camera is fixed over the arena, so its map is drawn once (first view) and reused.
    const r = this.renderer;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const k = CONFIG.versus.bloomStrengthScale;
    this.bloom.strength = this.bloom2!.strength = strength * k;
    this.bloom2!.enabled = this.bloomOn;
    const autoShadow = r.shadowMap.autoUpdate;
    r.setScissorTest(true);
    try {
      this.views.forEach((v, i) => {
        const x = Math.round(v.rect.x * w), vw = Math.round(v.rect.w * w);
        r.setViewport(x, 0, vw, h);
        r.setScissor(x, 0, vw, h);
        if (i > 0) r.shadowMap.autoUpdate = false;
        (i === 0 ? this.composer : this.composer2!).render();
      });
    } finally {
      r.shadowMap.autoUpdate = autoShadow;
      r.setScissorTest(false);
      r.setViewport(0, 0, w, h);
    }
  }

  /** Shader programs compiled so far (cached by three.js and shared by matching materials). */
  get programCount(): number {
    return this.renderer.info.programs?.length ?? 0;
  }

  /**
   * Draw the whole scene once into a small offscreen target, hidden and off-screen objects
   * included: every shader program the scene can need (its shadow-pass variant too) is compiled and
   * every texture uploaded now, instead of on first use mid-fight (a ticket's first spawn, a volley,
   * a stage swap). Nothing reaches the screen; visibility is restored at once. Lights keep their
   * visibility: the light count is part of every lit program. Into a render target like the
   * composer's scene pass, so the programs match (no tone mapping, linear output). Returns the
   * number of programs it compiled.
   */
  precompile(): number {
    const r = this.renderer;
    const before = this.programCount;
    const lights = new Set<THREE.Object3D>();
    this.scene.traverseVisible((o) => {
      if ((o as THREE.Light).isLight) lights.add(o);
    });
    const objects: THREE.Object3D[] = [];
    const state: boolean[] = [];
    this.scene.traverse((o) => {
      objects.push(o);
      state.push(o.visible, o.frustumCulled);
      o.visible = (o as THREE.Light).isLight ? lights.has(o) : true;
      o.frustumCulled = false;
    });
    this.warmTarget ??= new THREE.WebGLRenderTarget(64, 64, { type: THREE.HalfFloatType });
    const prev = r.getRenderTarget();
    try {
      r.setRenderTarget(this.warmTarget);
      r.render(this.scene, this.camera);
      if (r.shadowMap.enabled) this.precompileShadowDepth();
    } finally {
      r.setRenderTarget(prev);
      for (let i = 0; i < objects.length; i++) {
        objects[i].visible = state[2 * i];
        objects[i].frustumCulled = state[2 * i + 1];
      }
    }
    return this.programCount - before;
  }

  /**
   * The shadow pass draws most casters with one shared depth material that re-picks its program
   * only when the kind of object changes (skinned, instanced...), from whichever caster comes next:
   * so which of its variants (map or not, flipped or double-sided) one draw builds depends on draw
   * order, and a caster first seen later (a life pack, the carpet) can still compile one mid-fight.
   * Build every variant the scene's casters can ask for, each held by a depth material of our own
   * (kept, so the program stays cached). Called by `precompile` with its render target and forced
   * visibility in place (the light setup must match the real shadow pass).
   */
  private precompileShadowDepth(): void {
    const reps = new Map<string, [THREE.Mesh, THREE.Material]>();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.castShadow || m.customDepthMaterial) return;
      const g = m.geometry;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        const sm = mat as THREE.MeshStandardMaterial;
        // Casters with alpha cut-outs or displacement get their own depth material (built by the draw).
        if (((sm.map || sm.alphaMap) && sm.alphaTest > 0) || (sm.displacementMap && sm.displacementScale !== 0) || sm.alphaToCoverage) continue;
        const side = sm.shadowSide ?? SHADOW_SIDE[sm.side];
        const im = m as unknown as THREE.InstancedMesh;
        const key = [
          (m as THREE.SkinnedMesh).isSkinnedMesh ? 's' : '', im.isInstancedMesh ? `i${im.instanceColor ? 'c' : ''}${im.morphTexture ? 'm' : ''}` : '',
          Object.keys(g.morphAttributes).join('+'), side, sm.map ? `map${sm.map.channel}` : '', sm.alphaMap ? `amap${sm.alphaMap.channel}` : '', sm.wireframe ? 'w' : '',
        ].join('|');
        if (!reps.has(key)) reps.set(key, [m, mat]);
      }
    });
    // The shadow pass draws with an empty scene (no fog: fog is part of the key) and the real lights.
    const fog = this.scene.fog;
    this.scene.fog = null;
    try {
      for (const [key, [mesh, mat]] of reps) this.compileDepth(key, mesh, mat);
    } finally {
      this.scene.fog = fog;
    }
  }

  /** Compile the shared depth material's variant for `mat` on `mesh`, held by a depth material of our own. */
  private compileDepth(key: string, mesh: THREE.Mesh, mat: THREE.Material): void {
    let dm = this.depthWarm.get(key);
    if (!dm) this.depthWarm.set(key, (dm = new THREE.MeshDepthMaterial()));
    const sm = mat as THREE.MeshStandardMaterial;
    dm.side = sm.shadowSide ?? SHADOW_SIDE[sm.side];
    dm.map = sm.map;
    dm.alphaMap = sm.alphaMap;
    dm.wireframe = sm.wireframe;
    const own = mesh.material;
    mesh.material = dm;
    try {
      this.renderer.compile(mesh, this.camera, this.scene);
    } finally {
      mesh.material = own;
    }
  }
}

/** The side three's shadow pass draws a material's caster with (WebGLShadowMap). */
const SHADOW_SIDE: Record<THREE.Side, THREE.Side> = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };
