import * as THREE from 'three';
import { CONFIG } from '../config';
import type { AssetLoader } from '../assets/AssetLoader';
import { skinScale, type SkinDef } from '../campaign/skins';
import { glowTexture } from '../fx/textures';
import { staffModelPath, staffSlug, type StaffId } from '../staff/catalog';
import type { TitleStaff } from './titleStaffs';

/** Seconds each staff is held up before the swap. */
const HOLD = 2.8;
/** The old staff shrinks into the hand for this long, then the new one pops out. */
const SWAP_OUT = 0.22;
const SWAP_IN = 0.5;
/** Peak scale of the pop (easeOutBack overshoot). */
const POP = 1.18;
/** Frames are drawn at most this often (the arena behind the menu renders at full rate). */
const MIN_FRAME = 1 / 30;
/** Largest drawing buffer side, in device pixels. */
const MAX_BUFFER = 900;
/** Flat material of a locked staff: a dark silhouette against the glow. */
const LOCKED_COLOR = 0x07050f;

interface StaffProp {
  root: THREE.Object3D;
  meshes: THREE.Mesh[];
  materials: (THREE.Material | THREE.Material[])[];
  mixer: THREE.AnimationMixer | null;
  locked: boolean;
}

const easeIn = (t: number) => t * t * t;
/** easeOutBack scaled so it peaks at about POP. */
const easeOutBack = (t: number) => {
  const c = (POP - 1) * 9.5;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};

/**
 * The title screen's big live Wizard Sproto: the in-game player rig (its idle clip) holding each
 * staff of a cycle in turn, swapped with a shrink, a flash and a scale pop. Its own small canvas and
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
  private readonly lockedMat = new THREE.MeshBasicMaterial({ color: LOCKED_COLOR });
  private readonly props = new Map<StaffId, StaffProp | null>();
  private readonly skeletons: THREE.Skeleton[] = [];
  private readonly resize: ResizeObserver;
  private readonly onVisibility = () => this.wake();
  private cycle: TitleStaff[] = [];
  private index = 0;
  /** Time in the current staff's hold (then SWAP_OUT, then SWAP_IN of the next). */
  private t = 0;
  private phase: 'hold' | 'out' | 'in' = 'in';
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
    this.label.innerHTML = '<b></b><small></small><span class="title-lock">Locked</span>';
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
   * stands at Sproto's height and shows its name instead of the staff cycle.
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

  /** Put the stage into `host` (the main menu's slot) and run the cycle. */
  mount(host: HTMLElement, cycle: TitleStaff[]): void {
    if (this.disposed) return;
    if (this.character) {
      // A boss skin: its name, no staff cycle.
      if (!this.characterShown) this.showCharacter(this.character);
      host.appendChild(this.el);
      this.fit();
      this.wake();
      return;
    }
    const same = cycle.length === this.cycle.length && cycle.every((s, i) => s.id === this.cycle[i]?.id && s.locked === this.cycle[i]?.locked);
    if (!same) {
      this.cycle = cycle;
      this.index = 0;
      this.show(this.cycle[0] ?? null);
    }
    host.appendChild(this.el);
    this.fit();
    this.wake();
  }

  /** Jump to `id` (the rack equipped it) with the usual pop. */
  focus(id: StaffId): void {
    if (this.character) return;
    const i = this.cycle.findIndex((s) => s.id === id);
    if (i < 0 || i === this.index) return;
    this.index = i;
    this.show(this.cycle[i]);
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
    this.lockedMat.dispose();
    this.flash.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.props.clear();
  }

  private show(staff: TitleStaff | null): void {
    for (const [id, p] of this.props) if (p) p.root.visible = id === staff?.id;
    if (!staff) return;
    const prop = this.prop(staff.id);
    if (prop) {
      this.setLocked(prop, staff.locked);
      prop.root.visible = true;
    }
    this.phase = 'in';
    this.t = 0;
    this.flashAt(staff);
    this.el.style.setProperty('--staff-accent', staff.locked ? '#5d5578' : staff.accent);
    this.el.classList.toggle('locked', staff.locked);
    this.label.querySelector('b')!.textContent = staff.name;
    this.label.querySelector('small')!.textContent = staff.locked ? 'Enter from the hub to unlock' : staff.line;
    // Restart the label's pop.
    this.label.classList.remove('swap');
    void this.label.offsetWidth;
    this.label.classList.add('swap');
  }

  private showCharacter(skin: SkinDef): void {
    this.characterShown = true;
    this.phase = 'hold';
    this.t = 0;
    this.el.style.setProperty('--staff-accent', skin.accent);
    this.el.classList.remove('locked');
    this.label.querySelector('b')!.textContent = skin.name;
    this.label.querySelector('small')!.textContent = 'Character skin · look only';
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
      const meshes: THREE.Mesh[] = [];
      inst.root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
      });
      const clip = inst.animations.find((c) => c.name === `staff_${staffSlug(id)}_idle`);
      let mixer: THREE.AnimationMixer | null = null;
      if (clip) {
        mixer = new THREE.AnimationMixer(inst.root);
        mixer.clipAction(clip).play();
      }
      inst.root.visible = false;
      this.socket.add(inst.root);
      prop = { root: inst.root, meshes, materials: meshes.map((m) => m.material), mixer, locked: false };
    } else {
      console.warn(`[title] missing ${staffModelPath(id)}`);
    }
    this.props.set(id, prop);
    return prop;
  }

  private setLocked(p: StaffProp, locked: boolean): void {
    if (p.locked === locked) return;
    p.locked = locked;
    p.meshes.forEach((m, i) => (m.material = locked ? this.lockedMat : p.materials[i]));
  }

  private flashAt(staff: TitleStaff): void {
    const m = this.flash.material;
    m.color.set(staff.locked ? 0x8a80b0 : staff.accent);
    m.opacity = 1;
    this.flash.visible = true;
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
    this.t += dt;
    const staff = this.cycle[this.index];
    const prop = staff ? this.props.get(staff.id) : null;
    let scale = 1;
    if (this.phase === 'in') {
      const k = Math.min(1, this.t / SWAP_IN);
      scale = Math.max(0.001, easeOutBack(k));
      if (k >= 1) this.toPhase('hold');
    } else if (this.phase === 'hold') {
      if (this.t >= HOLD && this.cycle.length > 1) this.toPhase('out');
    } else {
      const k = Math.min(1, this.t / SWAP_OUT);
      scale = Math.max(0.001, 1 - easeIn(k));
      if (k >= 1) {
        this.index = (this.index + 1) % this.cycle.length;
        this.show(this.cycle[this.index]);
        scale = 0.001;
      }
    }
    if (prop) prop.root.scale.setScalar(scale);

    this.mixer.update(dt);
    if (prop?.mixer) prop.mixer.update(dt);
    // A slow sway so the rig reads as 3D, turned a little toward the staff hand.
    this.turntable.rotation.y = -0.32 + Math.sin(this.time * 0.45) * 0.28;

    // The flash sits on the hand and fades over the pop.
    const m = this.flash.material;
    if (this.flash.visible && this.socket) {
      this.socket.getWorldPosition(this.flash.position);
      const fade = this.phase === 'in' ? 1 - Math.min(1, this.t / (SWAP_IN * 0.9)) : 0;
      m.opacity = fade;
      this.flash.scale.setScalar(0.5 + 1.6 * (1 - fade));
      if (fade <= 0) this.flash.visible = false;
    }
  }

  private toPhase(p: 'hold' | 'out' | 'in'): void {
    this.phase = p;
    this.t = 0;
  }
}
