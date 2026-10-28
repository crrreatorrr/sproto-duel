import * as THREE from 'three';
import { CONFIG, type TeamPalette } from '../config';
import type { ModelInstance } from '../assets/AssetLoader';
import type { WizardClip, ModelAsset } from '../assets/manifest';
import { glowTexture } from '../fx/textures';
import { damp, lerp, saturate, wrapAngle } from '../core/math';
import type { Wizard } from './Wizard';

const SHIELD_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vP = position;
    vN = normalize(mat3(modelMatrix) * normal);
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const SHIELD_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uPerfect;
  uniform float uHit;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vP;
  void main() {
    float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
    float rim = pow(f, 2.2);
    vec3 p = normalize(vP);
    vec2 uv = vec2(atan(p.z, p.x) * 3.0, asin(clamp(p.y, -1.0, 1.0)) * 4.0);
    uv.x += 0.5 * floor(uv.y);
    vec2 g = abs(fract(uv) - 0.5);
    float line = smoothstep(0.4, 0.5, max(g.x, g.y));
    float scan = 0.5 + 0.5 * sin(vP.y * 9.0 - uTime * 9.0);
    float a = (rim * 0.85 + line * 0.3 + scan * 0.05 + uHit * 0.5) * uOpacity;
    vec3 c = uColor * (1.2 + rim * 2.0 + uPerfect * 2.5) + vec3(uPerfect * 0.8);
    gl_FragColor = vec4(c, a);
  }
`;

const J = CONFIG.wizard.jump;
/** Placeholder silhouettes: the default wizard hat, or a campaign boss's headgear. */
export type PlaceholderVariant = 'wizard' | 'obama' | 'midget' | 'tinubu' | 'agent' | 'sahil' | 'broccoli';

/** Placeholders built smaller than a standard wizard (The Midget's 1.25 m hitbox). */
const PLACEHOLDER_SCALE: Partial<Record<PlaceholderVariant, number>> = { midget: 1.25 / CONFIG.wizard.height };

/** Top of the default placeholder's hat, in meters. */
const WIZARD_TOP = 2.33;

/** Adds a placeholder part at (x, y, z) in feet-relative meters. */
type AddMesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent?: THREE.Object3D) => THREE.Mesh;

/** Placeholder skin (or, for Broccoli Head, stalk) colour per silhouette. */
const SKIN_TONES: Record<PlaceholderVariant, number> = {
  wizard: 0xe8c4a8,
  sahil: 0xc68d5e,
  obama: 0x7a4e34,
  midget: 0xd9a77e,
  broccoli: 0xa9c97a,
  agent: 0xe2bfa2,
  tinubu: 0x6b4630,
};

const tmpColor = new THREE.Color();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpAxis = new THREE.Vector3();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export class WizardVisual {
  /** World transform: interpolated position + facing. */
  readonly root = new THREE.Group();
  /** Procedural animation pivot at hip height (lean, roll, recoil). */
  private readonly pivot = new THREE.Group();
  private readonly armPivot = new THREE.Group();
  /** Holds the swappable look (GLB or placeholder); everything else on the root is shared. */
  private readonly body = new THREE.Group();
  private readonly tintMaterials: THREE.MeshStandardMaterial[] = [];
  /** GPU resources created for the current look, released on the next swap. */
  private readonly owned: { dispose(): void }[] = [];
  private readonly chargeGlow: THREE.Sprite;
  private readonly shield: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly ice: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<WizardClip, THREE.AnimationAction>();
  private currentClip: WizardClip | null = null;
  private time = Math.random() * 10;
  private deathT = 0;
  private iceScale = 0;
  private shieldScale = 0;
  private shieldHit = 0;
  private lastShieldAge = 0;
  private leanX = 0;
  private leanZ = 0;
  /** Jump squash/stretch spring: + stretches, - squashes (fraction of height). */
  private stretch = 0;
  private stretchVel = 0;
  /** Last takeoff/touchdown counts seen (-1 = not synced yet, so a fresh visual doesn't replay one). */
  private seenJumps = -1;
  private seenLandings = -1;
  celebrate = false;
  /** True when a GLB is shown, false for the primitive placeholder. */
  usesModel = false;
  /** Height of the top of the current look (hat, crown or model), in meters. The HUD tag sits above it. */
  topHeight = WIZARD_TOP;

  constructor(public team: TeamPalette, model: ModelInstance | null, modelSpec: ModelAsset) {
    this.root.add(this.pivot);
    this.pivot.position.y = 0.9;
    this.pivot.add(this.body);

    this.build(model, modelSpec, 'wizard');

    // Wand charge glow (shown during spell windups).
    this.chargeGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color: team.spell, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    this.chargeGlow.visible = false;
    this.root.add(this.chargeGlow);

    // Shield bubble.
    this.shield = new THREE.Mesh(
      new THREE.SphereGeometry(CONFIG.spells.shield.radius, 32, 20),
      new THREE.ShaderMaterial({
        vertexShader: SHIELD_VERT,
        fragmentShader: SHIELD_FRAG,
        uniforms: {
          uColor: { value: new THREE.Color(team.spell) },
          uTime: { value: 0 },
          uOpacity: { value: 1 },
          uPerfect: { value: 0 },
          uHit: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.shield.position.y = 1.0;
    this.shield.visible = false;
    this.shield.renderOrder = 11;
    this.root.add(this.shield);

    // Ice shell (stunned).
    this.ice = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.75, 1),
      new THREE.MeshStandardMaterial({
        color: 0xbfefff, emissive: 0x3aa8ff, emissiveIntensity: 0.6, roughness: 0.15, metalness: 0.1,
        transparent: true, opacity: 0.55, flatShading: true, depthWrite: false,
      }),
    );
    this.ice.scale.set(1, 1.45, 1);
    this.ice.position.y = 1.0;
    this.ice.visible = false;
    this.root.add(this.ice);

    // Team ring on the floor for readability.
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.7, 40),
      new THREE.MeshBasicMaterial({ color: team.spell, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.03;
    this.root.add(this.ring);
  }

  /**
   * Swap the whole look at runtime: palette, and either a GLB instance or the primitive
   * placeholder (in `variant`'s silhouette). Used to dress the rival as each campaign boss.
   */
  setAppearance(team: TeamPalette, model: ModelInstance | null, modelSpec: ModelAsset, variant: PlaceholderVariant = 'wizard'): void {
    this.team = team;
    this.clearLook();
    this.build(model, modelSpec, variant);
    this.chargeGlow.material.color.setHex(team.spell);
    (this.shield.material.uniforms.uColor.value as THREE.Color).setHex(team.spell);
    (this.ring.material as THREE.MeshBasicMaterial).color.setHex(team.spell);
  }

  private build(model: ModelInstance | null, modelSpec: ModelAsset, variant: PlaceholderVariant): void {
    if (model) {
      this.usesModel = true;
      this.topHeight = modelSpec.fitHeight ?? CONFIG.wizard.height;
      model.root.position.y = -0.9;
      this.body.add(model.root);
      model.root.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && 'emissive' in m) {
          const clone = m.clone();
          (o as THREE.Mesh).material = clone;
          this.tintMaterials.push(clone);
          this.owned.push(clone);
        }
      });
      if (model.animations.length) this.setupClips(model, modelSpec);
    } else {
      this.usesModel = false;
      this.buildPlaceholder(variant);
    }
  }

  /** Remove the current look and free what it created (GLB geometry stays shared with its template). */
  private clearLook(): void {
    this.body.scale.setScalar(1);
    this.body.position.y = 0;
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.actions.clear();
    this.currentClip = null;
    this.armPivot.clear();
    this.body.clear();
    for (const r of this.owned) r.dispose();
    this.owned.length = 0;
    this.tintMaterials.length = 0;
  }

  private buildPlaceholder(variant: PlaceholderVariant): void {
    const t = this.team;
    const own = <T extends { dispose(): void }>(r: T): T => {
      this.owned.push(r);
      return r;
    };
    const standard = (color: number, roughness: number) => own(new THREE.MeshStandardMaterial({ color, roughness }));
    const glowing = (color: number, intensity: number) =>
      own(new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), toneMapped: false }));
    const robe = standard(t.robe, 0.85);
    const trim = standard(t.trim, 0.6);
    const skin = standard(SKIN_TONES[variant], 0.7);
    const wood = standard(0x3b2716, 0.6);
    this.tintMaterials.push(robe, trim, skin);
    const eye = glowing(t.spell, variant === 'tinubu' ? 5 : 3);
    const tip = glowing(t.spell, 4);

    const add: AddMesh = (geo, mat, x, y, z, parent = this.body) => {
      const m = new THREE.Mesh(own(geo), mat);
      m.position.set(x, y - 0.9, z);
      m.castShadow = true;
      parent.add(m);
      return m;
    };

    // Robe skirt: a broad one for the rug merchant, narrow for the long coat and the suit.
    const skirt = variant === 'sahil' ? 0.6 : variant === 'obama' || variant === 'agent' ? 0.42 : 0.52;
    add(new THREE.ConeGeometry(skirt, 1.25, 16), robe, 0, 0.62, 0);
    add(new THREE.CapsuleGeometry(0.25, 0.42, 4, 12), robe, 0, 1.22, 0); // torso
    add(new THREE.TorusGeometry(0.27, 0.05, 6, 16), trim, 0, 1.42, 0).rotation.x = Math.PI / 2; // collar
    add(new THREE.SphereGeometry(0.2, 16, 12), skin, 0, 1.6, 0.02); // head
    add(new THREE.SphereGeometry(0.035, 6, 6), eye, 0.075, 1.63, 0.19);
    add(new THREE.SphereGeometry(0.035, 6, 6), eye, -0.075, 1.63, 0.19);
    this.topHeight = this.buildHeadgear(variant, add, robe, trim, standard, glowing);

    // Right arm + wand. Pivot at the shoulder so casting can thrust it forward.
    this.armPivot.position.set(-0.3, 1.36 - 0.9, 0);
    this.body.add(this.armPivot);
    // armPivot children are placed relative to the shoulder (add() subtracts 0.9 from y).
    const arm = add(new THREE.CapsuleGeometry(0.075, 0.36, 3, 8), robe, -0.02, 0.88, 0.2, this.armPivot);
    arm.rotation.x = Math.PI / 2;
    const wand = add(new THREE.CylinderGeometry(0.018, 0.028, 0.42, 6), wood, -0.04, 0.9, 0.56, this.armPivot);
    wand.rotation.x = Math.PI / 2;
    wand.castShadow = false;
    add(new THREE.SphereGeometry(0.04, 8, 6), tip, -0.04, 0.9, 0.77, this.armPivot).castShadow = false;

    // A short boss: the same build, scaled down about the feet.
    const k = PLACEHOLDER_SCALE[variant] ?? 1;
    if (k !== 1) {
      this.body.scale.setScalar(k);
      this.body.position.y = -0.9 * (1 - k);
      this.topHeight *= k;
    }
  }

  /** Headgear and body cues for the placeholder (who it is at a glance). Returns the height of its top. */
  private buildHeadgear(
    variant: PlaceholderVariant,
    add: AddMesh,
    robe: THREE.MeshStandardMaterial,
    trim: THREE.MeshStandardMaterial,
    standard: (color: number, roughness: number) => THREE.MeshStandardMaterial,
    glowing: (color: number, intensity: number) => THREE.MeshBasicMaterial,
  ): number {
    const t = this.team;
    /** A cluster of spheres (beard, broccoli florets): [x, y, z, radius]. */
    const blobs = (list: number[][], mat: THREE.Material) => {
      for (const [x, y, z, r] of list) add(new THREE.SphereGeometry(r, 8, 6), mat, x, y, z);
    };

    switch (variant) {
      case 'sahil': {
        // The RugMaster: a round belly under a sash, a bushy beard and brows, a small red fez.
        add(new THREE.SphereGeometry(0.34, 16, 12), robe, 0, 1.05, 0.1).scale.set(1, 0.95, 0.9);
        add(new THREE.TorusGeometry(0.31, 0.035, 6, 20), trim, 0, 1.12, 0.08).rotation.x = Math.PI / 2 - 0.15;
        const hair = standard(0x3b2416, 0.95);
        blobs([
          [0, 1.48, 0.15, 0.11], [0.1, 1.51, 0.14, 0.09], [-0.1, 1.51, 0.14, 0.09], [0.16, 1.57, 0.09, 0.075],
          [-0.16, 1.57, 0.09, 0.075], [0, 1.4, 0.15, 0.09], [0.06, 1.555, 0.19, 0.045], [-0.06, 1.555, 0.19, 0.045],
          [0, 1.36, 0.25, 0.06], [0.08, 1.37, 0.23, 0.055], [-0.08, 1.37, 0.23, 0.055],
        ], hair);
        for (const side of [1, -1]) add(new THREE.BoxGeometry(0.08, 0.022, 0.03), hair, side * 0.075, 1.685, 0.18).rotation.z = side * 0.18;
        const fez = standard(0xb3122a, 0.6);
        add(new THREE.CylinderGeometry(0.11, 0.135, 0.17, 16), fez, 0, 1.84, -0.01);
        add(new THREE.CylinderGeometry(0.008, 0.008, 0.12, 4), hair, 0.09, 1.86, -0.02).rotation.z = -0.35;
        add(new THREE.SphereGeometry(0.025, 6, 5), glowing(t.spell, 2), 0.12, 1.8, -0.02);
        return 2.0;
      }
      case 'obama': {
        // Mustard wide-brim hat and a long black coat with a gold chain and a glowing coin.
        const mustard = standard(0xc9a032, 0.65);
        add(new THREE.CylinderGeometry(0.43, 0.43, 0.03, 28), mustard, 0, 1.765, 0);
        add(new THREE.CylinderGeometry(0.19, 0.22, 0.22, 20), mustard, 0, 1.88, 0);
        add(new THREE.CylinderGeometry(0.222, 0.222, 0.045, 20), standard(0x2a2214, 0.7), 0, 1.8, 0);
        const shirt = standard(0xe8e4dc, 0.7);
        add(new THREE.BoxGeometry(0.12, 0.24, 0.02), shirt, 0, 1.3, 0.235).rotation.x = -0.12;
        for (const side of [1, -1]) {
          const lapel = add(new THREE.BoxGeometry(0.09, 0.3, 0.025), robe, side * 0.09, 1.3, 0.245);
          lapel.rotation.set(-0.12, 0, side * 0.3);
        }
        add(new THREE.TorusGeometry(0.17, 0.012, 5, 20, Math.PI), trim, 0, 1.36, 0.17).rotation.set(Math.PI + 0.35, 0, 0);
        add(new THREE.CylinderGeometry(0.055, 0.055, 0.015, 16), glowing(t.spell, 2.2), 0, 1.19, 0.26).rotation.x = Math.PI / 2 - 0.15;
        return 2.02;
      }
      case 'midget': {
        // The Midget: a short gold top hat, a gold chain and a glowing coin (scaled down after).
        const gold = standard(t.trim, 0.4);
        add(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 24), gold, 0, 1.77, 0);
        add(new THREE.CylinderGeometry(0.17, 0.18, 0.34, 20), gold, 0, 1.95, 0);
        add(new THREE.CylinderGeometry(0.185, 0.185, 0.05, 20), standard(t.robe, 0.7), 0, 1.81, 0);
        add(new THREE.TorusGeometry(0.17, 0.014, 5, 20, Math.PI), gold, 0, 1.36, 0.17).rotation.set(Math.PI + 0.35, 0, 0);
        add(new THREE.CylinderGeometry(0.06, 0.06, 0.015, 16), glowing(t.spell, 2.2), 0, 1.19, 0.26).rotation.x = Math.PI / 2 - 0.15;
        return 2.12;
      }
      case 'broccoli': {
        // A broccoli-floret head: florets crowd the top and back of a pale green stalk of a face.
        const floret = standard(t.robe, 0.9);
        floret.emissive.setHex(t.spell).multiplyScalar(0.12);
        const bright = standard(t.spell, 0.8);
        bright.emissive.setHex(t.spell).multiplyScalar(0.25);
        const cluster: number[][] = [[0, 1.86, -0.03, 0.17]];
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2;
          cluster.push([Math.sin(a) * 0.19, 1.76, Math.cos(a) * 0.17 - 0.04, 0.12]);
        }
        for (let i = 0; i < 6; i++) {
          const a = Math.PI * 0.55 + (i / 5) * Math.PI * 0.9;
          cluster.push([Math.sin(a) * 0.25, 1.62, Math.cos(a) * 0.22 - 0.03, 0.1]);
        }
        blobs(cluster, floret);
        blobs([[0.08, 1.95, 0.05, 0.06], [-0.1, 1.9, 0.08, 0.055], [0.15, 1.82, 0.1, 0.05], [-0.16, 1.8, 0.06, 0.05]], bright);
        return 2.05;
      }
      case 'agent': {
        // Black suit, white shirt and tie, slicked short hair, dark sunglasses (no hat).
        add(new THREE.SphereGeometry(0.207, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.42), standard(0x1a1410, 0.6), 0, 1.6, -0.005);
        // Sunglasses sit in front of the glowing eyes and hide them.
        const shades = standard(0x07080a, 0.15);
        add(new THREE.BoxGeometry(0.27, 0.05, 0.03), shades, 0, 1.64, 0.215);
        for (const side of [1, -1]) {
          add(new THREE.BoxGeometry(0.105, 0.08, 0.03), shades, side * 0.072, 1.627, 0.22);
          add(new THREE.BoxGeometry(0.012, 0.012, 0.2), shades, side * 0.165, 1.645, 0.11);
        }
        add(new THREE.SphereGeometry(0.012, 5, 4), glowing(t.spell, 3), 0.1, 1.65, 0.238); // lens glint
        const shirt = standard(0xf1f1f1, 0.6);
        add(new THREE.BoxGeometry(0.13, 0.26, 0.02), shirt, 0, 1.3, 0.235).rotation.x = -0.12;
        add(new THREE.BoxGeometry(0.035, 0.22, 0.012), standard(0x0b0b0e, 0.5), 0, 1.28, 0.25).rotation.x = -0.12;
        for (const side of [1, -1]) {
          const lapel = add(new THREE.BoxGeometry(0.08, 0.28, 0.025), robe, side * 0.095, 1.3, 0.245);
          lapel.rotation.set(-0.12, 0, side * 0.32);
        }
        add(new THREE.SphereGeometry(0.018, 6, 5), standard(0xd8d8d8, 0.3), -0.2, 1.6, 0.03); // earpiece
        return 1.84;
      }
      case 'tinubu': {
        // A tall fila cap folded to one side with a gold emblem, small red horns, wide agbada shoulders.
        add(new THREE.CylinderGeometry(0.17, 0.205, 0.34, 18), robe, 0.02, 1.9, -0.02).rotation.z = -0.18;
        add(new THREE.SphereGeometry(0.17, 14, 8), robe, 0.07, 2.06, -0.02).scale.set(1.05, 0.45, 1);
        add(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 16), glowing(t.trim, 2), 0.0, 1.9, 0.19).rotation.x = Math.PI / 2;
        const horn = standard(0xb3141a, 0.45);
        horn.emissive.setHex(t.spell).multiplyScalar(0.3);
        for (const side of [1, -1]) {
          add(new THREE.ConeGeometry(0.05, 0.22, 8), horn, side * 0.21, 1.8, 0.03).rotation.set(0.15, 0, -side * 0.8);
          add(new THREE.SphereGeometry(0.17, 12, 8), robe, side * 0.3, 1.42, 0).scale.set(1.25, 0.45, 1);
          add(new THREE.TorusGeometry(0.17, 0.014, 5, 16), trim, side * 0.3, 1.42, 0).rotation.x = Math.PI / 2;
        }
        return 2.18;
      }
      default: {
        add(new THREE.CylinderGeometry(0.44, 0.44, 0.04, 24), robe, 0, 1.72, 0); // hat brim
        const hat = add(new THREE.ConeGeometry(0.27, 0.62, 16), robe, 0, 2.02, -0.04);
        hat.rotation.x = -0.18;
        add(new THREE.TorusGeometry(0.25, 0.03, 6, 16), trim, 0, 1.77, 0).rotation.x = Math.PI / 2; // hat band
        return WIZARD_TOP;
      }
    }
  }

  private setupClips(model: ModelInstance, spec: ModelAsset): void {
    this.mixer = new THREE.AnimationMixer(model.root);
    for (const [clip, name] of Object.entries(spec.clips ?? {}) as [WizardClip, string][]) {
      const want = name.toLowerCase();
      const found =
        model.animations.find((a) => a.name.toLowerCase() === want) ??
        model.animations.find((a) => a.name.toLowerCase().includes(want));
      if (!found) continue;
      const action = this.mixer.clipAction(found);
      if (clip === 'defeat' || clip === 'victory' || clip === 'dodge' || clip === 'cast' || clip === 'castBig' || clip === 'hit') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(clip, action);
    }
  }

  private play(clip: WizardClip, fade = 0.12, restart = false): void {
    if (!this.mixer) return;
    const next = this.actions.get(clip) ?? (clip === 'castBig' ? this.actions.get('cast') : undefined);
    if (!next) return;
    if (this.currentClip === clip && !restart) return;
    const prev = this.currentClip ? this.actions.get(this.currentClip) : undefined;
    next.reset().fadeIn(fade).play();
    if (prev && prev !== next) prev.fadeOut(fade);
    this.currentClip = clip;
  }

  /** Brief flash on the shield when it blocks something. */
  shieldImpact(perfect: boolean): void {
    this.shieldHit = perfect ? 1.5 : 1;
  }

  /** Per render frame. `alpha` interpolates between the last two physics ticks. */
  update(w: Wizard, dt: number, alpha: number): void {
    this.time += dt;
    const x = lerp(w.prevPos.x, w.pos.x, alpha);
    const y = lerp(w.prevPos.y, w.pos.y, alpha);
    const z = lerp(w.prevPos.z, w.pos.z, alpha);
    this.root.position.set(x, y, z);
    const facing = w.prevFacing + wrapAngle(w.facing - w.prevFacing) * alpha;
    this.root.rotation.y = facing;

    // Velocity in local space for leaning.
    const s = Math.sin(facing), c = Math.cos(facing);
    const vx = w.vel.x + w.knock.x, vz = w.vel.z + w.knock.z;
    const localX = vx * c - vz * s;
    const localZ = vx * s + vz * c;
    const speed = Math.hypot(vx, vz);
    const frozen = w.stunned;

    if (!frozen) {
      // Rising leans back a touch, falling tips forward into the landing.
      const air = w.grounded ? 0 : -w.vy * 0.012;
      this.leanX = damp(this.leanX, (localZ / CONFIG.wizard.sprintSpeed) * 0.28 + air, 10, dt);
      this.leanZ = damp(this.leanZ, (-localX / CONFIG.wizard.sprintSpeed) * 0.3, 10, dt);
    }

    // Lean + recoil.
    tmpQ.setFromAxisAngle(X_AXIS, this.leanX - w.castPulse * 0.12);
    tmpQ2.setFromAxisAngle(Z_AXIS, this.leanZ);
    tmpQ.multiply(tmpQ2);

    // Dodge roll: full flip around the axis perpendicular to the roll direction.
    let squash = 1;
    if (w.dodging && !this.actions.has('dodge')) {
      const p = 1 - w.dodgeTime / CONFIG.wizard.dodge.duration;
      const e = p * p * (3 - 2 * p);
      const dx = w.dodgeDir.x, dz = w.dodgeDir.z;
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      tmpAxis.set(lz, 0, -lx).normalize();
      tmpQ2.setFromAxisAngle(tmpAxis, e * Math.PI * 2);
      tmpQ.premultiply(tmpQ2);
      squash = 1 - Math.sin(p * Math.PI) * 0.35;
    }

    // Death: topple backwards.
    if (!w.alive) {
      this.deathT = Math.min(1, this.deathT + dt * 2.2);
      const e = 1 - (1 - this.deathT) * (1 - this.deathT);
      tmpQ2.setFromAxisAngle(X_AXIS, -e * 1.45);
      tmpQ.premultiply(tmpQ2);
    } else {
      this.deathT = 0;
    }
    this.pivot.quaternion.copy(tmpQ);

    // Jump squash & stretch: takeoff and touchdown kick a springy scale; airborne speed stretches.
    if (this.seenJumps < 0) {
      this.seenJumps = w.jumps;
      this.seenLandings = w.landings;
    }
    if (w.jumps !== this.seenJumps) {
      this.seenJumps = w.jumps;
      this.stretch = Math.max(this.stretch, J.takeoffStretch);
      this.stretchVel = 0;
    }
    if (w.landings !== this.seenLandings) {
      this.seenLandings = w.landings;
      this.stretch = -Math.min(J.maxLandSquash, w.landSpeed * J.landSquash);
      this.stretchVel = 0;
    }
    // Elongate along the motion, rising or falling; neutral at the apex.
    const restStretch = w.grounded ? 0 : Math.min(0.08, Math.abs(w.vy) * 0.01);
    // Fixed sub-steps keep the spring stable through long frames.
    for (let left = dt; left > 1e-5; left -= 1 / 120) {
      const h = Math.min(left, 1 / 120);
      this.stretchVel += (-320 * (this.stretch - restStretch) - 16 * this.stretchVel) * h;
      this.stretch += this.stretchVel * h;
    }
    squash *= 1 + this.stretch;
    const thin = 1 - this.stretch * 0.5;

    // Bob / breathe / celebrate.
    const moving = speed > 0.5 && !w.dodging && w.alive && w.grounded;
    let bob = 0;
    if (frozen || !w.grounded) bob = 0;
    else if (this.celebrate) bob = Math.abs(Math.sin(this.time * 7)) * 0.25;
    else if (moving) bob = Math.abs(Math.sin(this.time * (w.sprinting ? 15 : 12))) * 0.06;
    else bob = Math.sin(this.time * 2.2) * 0.012;
    this.pivot.position.y = 0.9 * squash + bob - (w.alive ? 0 : this.deathT * 0.55);
    this.pivot.scale.set(thin, squash, thin);

    // Stun jitter.
    if (frozen) this.pivot.position.x = (Math.random() - 0.5) * 0.03;
    else this.pivot.position.x = 0;

    // Arm thrust on release, raised during windup.
    const winding = w.cast ? saturate(w.cast.elapsed / w.cast.duration) : 0;
    this.armPivot.position.z = w.castPulse * 0.16 + winding * 0.05;
    this.armPivot.rotation.x = -winding * 0.5 - w.castPulse * 0.15;

    // Charge glow at the wand tip during windups.
    if (w.cast) {
      this.chargeGlow.visible = true;
      // Root is already rotated by facing, so the wand tip offset is constant in local space.
      const k = w.sizeScale;
      this.chargeGlow.position.set(-0.34 * k, (1.36 + winding * 0.1) * k, (0.72 + this.armPivot.position.z) * k);
      const spellColor = w.cast.spell === 'stun' ? w.team.stun : w.cast.spell === 'ultimate' ? w.team.ultimate : w.team.blast;
      this.chargeGlow.material.color.setHex(spellColor).multiplyScalar(2.5);
      const size = (w.cast.spell === 'ultimate' ? 2.6 : 1.1) * (0.4 + winding) * (1 + Math.sin(this.time * 40) * 0.08);
      this.chargeGlow.scale.setScalar(size);
    } else {
      this.chargeGlow.visible = false;
    }

    // Hit flash / stun tint.
    const flash = saturate(w.hitFlash / CONFIG.wizard.hitFlashTime);
    // Flash strength fades with the timer so rapid hits flicker instead of pinning the model white.
    const f = flash * flash * 1.4;
    tmpColor.setRGB(f, f, f);
    if (frozen) {
      tmpColor.r += 0.05;
      tmpColor.g += 0.35;
      tmpColor.b += 0.6;
    }
    for (const m of this.tintMaterials) m.emissive.copy(tmpColor);

    // Shield bubble.
    const shieldOn = w.shielded;
    this.shieldScale = damp(this.shieldScale, shieldOn ? 1 : 0, shieldOn ? 30 : 18, dt);
    this.shield.visible = this.shieldScale > 0.02;
    if (this.shield.visible) {
      if (shieldOn && w.shieldAge < this.lastShieldAge) this.shieldHit = 0;
      this.lastShieldAge = w.shieldAge;
      const u = this.shield.material.uniforms;
      u.uTime.value = this.time;
      u.uPerfect.value = shieldOn && w.shieldAge <= CONFIG.spells.shield.perfectWindow ? 1 : 0;
      this.shieldHit = Math.max(0, this.shieldHit - dt * 4);
      u.uHit.value = this.shieldHit;
      u.uOpacity.value = this.shieldScale;
      const pop = 1 + Math.max(0, 0.15 - w.shieldAge) * 1.5;
      this.shield.scale.setScalar(this.shieldScale * pop);
      this.shield.position.y = w.shieldCenterY;
    }

    // Ice shell.
    this.iceScale = damp(this.iceScale, frozen ? 1 : 0, frozen ? 25 : 12, dt);
    this.ice.visible = this.iceScale > 0.02;
    if (this.ice.visible) {
      const k = this.iceScale * w.sizeScale;
      this.ice.scale.set(k, k * 1.45, k);
      this.ice.position.y = w.shieldCenterY;
      this.ice.rotation.y = this.time * 0.3;
    }

    // The team ring stays on the ground under an airborne wizard (a landing marker), shrinking with height.
    this.ring.visible = w.alive;
    const ground = Math.min(y, w.grounded ? y : w.groundY);
    const lift = y - ground;
    this.ring.position.y = 0.03 - lift;
    this.ring.scale.setScalar(1 - 0.3 * saturate(lift / 1.5));
    (this.ring.material as THREE.MeshBasicMaterial).opacity = (0.35 + (w.invulnerable ? 0.4 : 0)) * (1 - 0.4 * saturate(lift / 1.5));

    // Animation clips for real models.
    if (this.mixer) {
      if (!w.alive) this.play('defeat', 0.2);
      else if (this.celebrate) this.play('victory', 0.2);
      else if (frozen) this.play('stunned', 0.08);
      else if (w.dodging) this.play('dodge', 0.06);
      else if (w.cast) this.play(w.cast.spell === 'ultimate' ? 'castBig' : 'cast', 0.06);
      else if (w.castPulse > 0.75) this.play('cast', 0.05, w.castPulse > 0.97);
      else if (w.hitFlash > 0.08) this.play('hit', 0.05);
      else if (!w.grounded) {
        // No jump clip: hold a slowed run pose through the air.
        this.play('run', 0.15);
        const run = this.actions.get('run');
        if (run) run.timeScale = 0.3;
      } else if (moving) {
        this.play('run', 0.15);
        const run = this.actions.get('run');
        if (run) run.timeScale = speed / CONFIG.wizard.moveSpeed;
      } else this.play('idle', 0.2);
      this.mixer.update(frozen ? 0 : dt);
    }
  }
}
