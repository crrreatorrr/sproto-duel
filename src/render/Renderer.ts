import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CONFIG } from '../config';

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
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

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  onResize(fn: () => void): void {
    this.resizeListeners.push(fn);
  }

  setQuality(opts: { bloom: boolean; shadows: boolean }): void {
    this.bloom.enabled = opts.bloom;
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
    this.composer.setSize(w, h);
    // Bloom at half resolution: most of the glow, a fraction of the cost.
    const pr = this.renderer.getPixelRatio();
    this.bloom.setSize(Math.round((w * pr) / 2), Math.round((h * pr) / 2));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pointScale = (h * pr) / 2;
    for (const fn of this.resizeListeners) fn();
  }

  render(): void {
    this.renderer.info.reset();
    this.bloom.strength = Math.max(0, CONFIG.render.bloomStrength + this.bloomBoost);
    this.composer.render();
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
