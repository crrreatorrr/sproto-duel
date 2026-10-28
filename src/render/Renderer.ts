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
  /** Offscreen target of `precompile`. */
  private warmTarget: THREE.WebGLRenderTarget | null = null;

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
    } finally {
      r.setRenderTarget(prev);
      for (let i = 0; i < objects.length; i++) {
        objects[i].visible = state[2 * i];
        objects[i].frustumCulled = state[2 * i + 1];
      }
    }
    return this.programCount - before;
  }
}
