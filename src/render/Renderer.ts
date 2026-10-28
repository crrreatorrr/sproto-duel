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
  private resizeListeners: (() => void)[] = [];

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
    this.composer.render();
  }
}
