import * as THREE from 'three';
import { CONFIG } from '../config';
import type { AssetLoader } from '../assets/AssetLoader';
import { skinScale, type SkinDef } from '../campaign/skins';
import { glowTexture } from '../fx/textures';
import { staffCard, staffModelPath, staffSlug, type StaffId } from '../staff/catalog';

/** Seconds for a newly shown staff to pop into view. */
const POP_DURATION = 0.5;
/** Peak scale of the pop (easeOutBack overshoot). */
const POP = 1.18;
/** Frames are drawn at most this often (the arena behind the menu renders at full rate). */
const MIN_FRAME = 1 / 30;
/** Largest drawing buffer side, in device pixels. */
const MAX_BUFFER = 900;

interface StaffProp {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer | null;
}

/** easeOutBack scaled so it peaks at about POP. */
const easeOutBack = (t: number) => {
  const c = (POP - 1) * 9.5;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};

/**
 * The title screen's live Wizard Sproto plays its idle clip while holding the equipped staff.
 * Newly selected staffs appear with a flash and a scale pop. Its own small canvas and
 * renderer; geometry, textures and materials are the loaded templates' (shared with the game), so
 * nothing new is loaded and `dispose` frees only what this view created.
 *
 * Pure presentation: it never equips, grants or reports anything.
 */
export class TitleStaffPreview {
  /** Canvas plus the name label; App moves it into the main menu's slot on every showMain. */
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly label: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(26, 0.75, 0.1, 30);
  private readonly turntable = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  /** Wizard Sproto's staff hand; null on a boss character skin (it holds its own props, no staff). */
  private readonly socket: THREE.Object3D | null;
  /** The character on show when it holds no staff (a boss skin). */
  private readonly character: SkinDef | null;
  private readonly flash: THREE.Sprite;
  private readonly props = new Map<StaffId, StaffProp | null>();
  private readonly skeletons: THREE.Skeleton[] = [];
  private readonly resize: ResizeObserver;
  private readonly onVisibility = () => this.wake();
  private selected: StaffId | null = null;
  private popTime = POP_DURATION;
  private time = 0;
  private raf = 0;
  private last = 0;
  private pending = 0;
  private disposed = false;
  private characterShown = false;

  private constructor(
    private readonly assets: AssetLoader,
    model: { root: THREE.Object3D; animations: THREE.AnimationClip[] },
    socket: THREE.Object3D | null,
    character: SkinDef | null,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'title-stage';
    this.el.setAttribute('aria-hidden', 'true');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'title-stage-canvas';
    this.label = document.createElement('div');
    this.label.className = 'title-staff';
    this.label.innerHTML = '<b></b><small></small>';
    this.el.append(this.canvas, this.label);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, powerPreference: 'low-power', stencil: false });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = CONFIG.render.exposure;

    this.scene.add(new THREE.HemisphereLight(0xb9b2ff, 0x231a3a, 1.3));
    const key = new THREE.DirectionalLight(0xfff1dc, 2.4);
    key.position.set(2.5, 4, 4);
    const rim = new THREE.DirectionalLight(0x7f9cff, 2.2);
    rim.position.set(-3, 2.5, -3);
    this.scene.add(key, rim);

    this.socket = socket;
    this.character = socket ? null : character;
    this.scene.add(this.turntable);
    this.turntable.add(model.root);
    model.root.traverse((o) => {
      const skinned = o as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh) {
        skinned.frustumCulled = false;
        this.skeletons.push(skinned.skeleton);
      }
    });
    this.mixer = new THREE.AnimationMixer(model.root);
    const idle = model.animations.find((c) => /^idle$/i.test(c.name)) ?? model.animations.find((c) => /idle/i.test(c.name));
    if (idle) this.mixer.clipAction(idle).play();

    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
    this.flash.visible = false;
    this.scene.add(this.flash);

    this.camera.position.set(0.35, 1.2, 6.1);
    this.camera.lookAt(0, 1.02, 0);

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(this.el);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /**
   * The preview of `skin` (Wizard Sproto by default), or null when its model, or Sproto's staff
   * socket, is missing (the title then shows the menu alone) or WebGL is unavailable. A boss skin
   * stands at Sproto's height and shows its name.
   */
  static create(assets: AssetLoader, skin: SkinDef | null = null): TitleStaffPreview | null {
    const key = skin?.model ?? 'wizardPlayer';
    const model = assets.instantiate(key);
    if (!model) return null;
    const staffHand = key === 'wizardPlayer';
    const socket = model.root.getObjectByName('socket_staff') ?? null;
    if (staffHand && !socket) return null;
    if (!staffHand && skin) model.root.scale.multiplyScalar(skinScale(skin));
    try {
      return new TitleStaffPreview(assets, model, staffHand ? socket : null, staffHand ? null : skin);
    } catch (err) {
      console.warn('[title] no preview renderer', err);
      return null;
    }
  }

  /** Put the stage into the main menu's slot and show the equipped staff. */
  mount(host: HTMLElement, id: StaffId): void {
    if (this.disposed) return;
    if (this.character) {
      if (!this.characterShown) {
        this.characterShown = true;
        this.showLabel(this.character.name, 'Character skin · look only', this.character.accent);
      }
    } else {
      this.select(id);
    }
    host.appendChild(this.el);
    this.fit();
    this.wake();
  }

  /** Update the prop when the rack equips a different staff. */
  select(id: StaffId): void {
    if (this.disposed || this.character || id === this.selected) return;
    const previous = this.selected && this.props.get(this.selected);
    if (previous) previous.root.visible = false;
    this.selected = id;
    const prop = this.prop(id);
    if (prop) {
      prop.root.scale.setScalar(0.001);
      prop.root.visible = true;
    }
    const card = staffCard(id);
    this.popTime = 0;
    this.flash.material.color.set(card.accent);
    this.flash.material.opacity = 1;
    this.flash.visible = true;
    this.showLabel(card.name, card.line, card.accent);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resize.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.el.remove();
    this.mixer.stopAllAction();
    for (const p of this.props.values()) p?.mixer?.stopAllAction();
    // Geometry, textures and model materials belong to the loaded templates the game still uses.
    for (const s of this.skeletons) s.dispose();
    this.flash.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.props.clear();
  }

  private showLabel(name: string, line: string, accent: string): void {
    this.el.style.setProperty('--staff-accent', accent);
    this.label.querySelector('b')!.textContent = name;
    this.label.querySelector('small')!.textContent = line;
    // Restart the label's pop.
    this.label.classList.remove('swap');
    void this.label.offsetWidth;
    this.label.classList.add('swap');
  }

  private prop(id: StaffId): StaffProp | null {
    if (this.props.has(id)) return this.props.get(id)!;
    if (!this.socket) return null;
    const inst = this.assets.instantiateProp(staffModelPath(id));
    let prop: StaffProp | null = null;
    if (inst) {
      const clip = inst.animations.find((c) => c.name === `staff_${staffSlug(id)}_idle`);
      let mixer: THREE.AnimationMixer | null = null;
      if (clip) {
        mixer = new THREE.AnimationMixer(inst.root);
        mixer.clipAction(clip).play();
      }
      this.socket.add(inst.root);
      prop = { root: inst.root, mixer };
    } else {
      console.warn(`[title] missing ${staffModelPath(id)}`);
    }
    this.props.set(id, prop);
    return prop;
  }

  private fit(): void {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (!w || !h) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2, MAX_BUFFER / Math.max(w, h));
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Start the loop if the stage is on screen and the tab is visible. */
  private wake(): void {
    if (this.disposed || this.raf || document.hidden || !this.el.isConnected) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((now) => this.frame(now));
  }

  private frame(now: number): void {
    this.raf = 0;
    // Another menu screen replaced the slot, or the tab went away: stop until mount / visible again.
    if (this.disposed || document.hidden || !this.el.isConnected) return;
    this.raf = requestAnimationFrame((n) => this.frame(n));
    // A frame stamped before wake() (a long task in between, such as building a new preview) is
    // negative: count it as zero or the stage would stay blank until it was paid back.
    this.pending += Math.max(0, Math.min(0.25, (now - this.last) / 1000));
    this.last = now;
    if (this.pending < MIN_FRAME) return;
    const dt = this.pending;
    this.pending = 0;
    // Hidden by CSS (a narrow window): keep time, skip the draw.
    if (this.el.offsetParent === null) return;
    this.step(dt);
    this.renderer.render(this.scene, this.camera);
  }

  private step(dt: number): void {
    this.time += dt;
    const prop = this.selected && this.props.get(this.selected);
    if (this.popTime < POP_DURATION) {
      this.popTime = Math.min(POP_DURATION, this.popTime + dt);
      if (prop) prop.root.scale.setScalar(Math.max(0.001, easeOutBack(this.popTime / POP_DURATION)));
    }

    this.mixer.update(dt);
    prop?.mixer?.update(dt);
    // A slow sway so the rig reads as 3D, turned a little toward the staff hand.
    this.turntable.rotation.y = -0.32 + Math.sin(this.time * 0.45) * 0.28;

    // The flash sits on the hand and fades over the pop.
    const m = this.flash.material;
    if (this.flash.visible && this.socket) {
      this.socket.getWorldPosition(this.flash.position);
      const fade = 1 - Math.min(1, this.popTime / (POP_DURATION * 0.9));
      m.opacity = fade;
      this.flash.scale.setScalar(0.5 + 1.6 * (1 - fade));
      if (fade <= 0) this.flash.visible = false;
    }
  }
}
