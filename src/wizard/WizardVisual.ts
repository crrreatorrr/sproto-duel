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
  private readonly tintMaterials: THREE.MeshStandardMaterial[] = [];
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
  celebrate = false;
  readonly usesModel: boolean;

  constructor(readonly team: TeamPalette, model: ModelInstance | null, modelSpec: ModelAsset) {
    this.root.add(this.pivot);
    this.pivot.position.y = 0.9;

    if (model) {
      this.usesModel = true;
      model.root.position.y = -0.9;
      this.pivot.add(model.root);
      model.root.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && 'emissive' in m) {
          const clone = m.clone();
          (o as THREE.Mesh).material = clone;
          this.tintMaterials.push(clone);
        }
      });
      if (model.animations.length) this.setupClips(model, modelSpec);
    } else {
      this.usesModel = false;
      this.buildPlaceholder();
    }

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

  private buildPlaceholder(): void {
    const t = this.team;
    const robe = new THREE.MeshStandardMaterial({ color: t.robe, roughness: 0.85 });
    const trim = new THREE.MeshStandardMaterial({ color: t.trim, roughness: 0.6 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xe8c4a8, roughness: 0.7 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x3b2716, roughness: 0.6 });
    this.tintMaterials.push(robe, trim, skin);
    const eye = new THREE.MeshBasicMaterial({ color: new THREE.Color(t.spell).multiplyScalar(3), toneMapped: false });
    const tip = new THREE.MeshBasicMaterial({ color: new THREE.Color(t.spell).multiplyScalar(4), toneMapped: false });

    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.pivot) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y - 0.9, z);
      m.castShadow = true;
      parent.add(m);
      return m;
    };

    add(new THREE.ConeGeometry(0.52, 1.25, 16), robe, 0, 0.62, 0); // robe skirt
    add(new THREE.CapsuleGeometry(0.25, 0.42, 4, 12), robe, 0, 1.22, 0); // torso
    add(new THREE.TorusGeometry(0.27, 0.05, 6, 16), trim, 0, 1.42, 0).rotation.x = Math.PI / 2; // collar
    add(new THREE.SphereGeometry(0.2, 16, 12), skin, 0, 1.6, 0.02); // head
    add(new THREE.SphereGeometry(0.035, 6, 6), eye, 0.075, 1.63, 0.19);
    add(new THREE.SphereGeometry(0.035, 6, 6), eye, -0.075, 1.63, 0.19);
    add(new THREE.CylinderGeometry(0.44, 0.44, 0.04, 24), robe, 0, 1.72, 0); // hat brim
    const hat = add(new THREE.ConeGeometry(0.27, 0.62, 16), robe, 0, 2.02, -0.04);
    hat.rotation.x = -0.18;
    add(new THREE.TorusGeometry(0.25, 0.03, 6, 16), trim, 0, 1.77, 0).rotation.x = Math.PI / 2; // hat band

    // Right arm + wand. Pivot at the shoulder so casting can thrust it forward.
    this.armPivot.position.set(-0.3, 1.36 - 0.9, 0);
    this.pivot.add(this.armPivot);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.36, 3, 8), robe);
    arm.rotation.x = Math.PI / 2;
    arm.position.set(-0.02, -0.02, 0.2);
    arm.castShadow = true;
    this.armPivot.add(arm);
    const wand = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.028, 0.42, 6), wood);
    wand.rotation.x = Math.PI / 2;
    wand.position.set(-0.04, 0, 0.56);
    this.armPivot.add(wand);
    const tipMesh = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), tip);
    tipMesh.position.set(-0.04, 0, 0.77);
    this.armPivot.add(tipMesh);
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
    const z = lerp(w.prevPos.z, w.pos.z, alpha);
    this.root.position.set(x, 0, z);
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
      this.leanX = damp(this.leanX, (localZ / CONFIG.wizard.sprintSpeed) * 0.28, 10, dt);
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

    // Bob / breathe / celebrate.
    const moving = speed > 0.5 && !w.dodging && w.alive;
    let bob = 0;
    if (frozen) bob = 0;
    else if (this.celebrate) bob = Math.abs(Math.sin(this.time * 7)) * 0.25;
    else if (moving) bob = Math.abs(Math.sin(this.time * (w.sprinting ? 15 : 12))) * 0.06;
    else bob = Math.sin(this.time * 2.2) * 0.012;
    this.pivot.position.y = 0.9 * squash + bob - (w.alive ? 0 : this.deathT * 0.55);
    this.pivot.scale.set(1, squash, 1);

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
      this.chargeGlow.position.set(-0.34, 1.36 + winding * 0.1, 0.72 + this.armPivot.position.z);
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
    }

    // Ice shell.
    this.iceScale = damp(this.iceScale, frozen ? 1 : 0, frozen ? 25 : 12, dt);
    this.ice.visible = this.iceScale > 0.02;
    if (this.ice.visible) {
      this.ice.scale.set(this.iceScale, this.iceScale * 1.45, this.iceScale);
      this.ice.rotation.y = this.time * 0.3;
    }

    this.ring.visible = w.alive;
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.35 + (w.invulnerable ? 0.4 : 0);

    // Animation clips for real models.
    if (this.mixer) {
      if (!w.alive) this.play('defeat', 0.2);
      else if (this.celebrate) this.play('victory', 0.2);
      else if (frozen) this.play('stunned', 0.08);
      else if (w.dodging) this.play('dodge', 0.06);
      else if (w.cast) this.play(w.cast.spell === 'ultimate' ? 'castBig' : 'cast', 0.06);
      else if (w.castPulse > 0.75) this.play('cast', 0.05, w.castPulse > 0.97);
      else if (w.hitFlash > 0.08) this.play('hit', 0.05);
      else if (moving) {
        this.play('run', 0.15);
        const run = this.actions.get('run');
        if (run) run.timeScale = speed / CONFIG.wizard.moveSpeed;
      } else this.play('idle', 0.2);
      this.mixer.update(frozen ? 0 : dt);
    }
  }
}
