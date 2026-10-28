import * as THREE from 'three';
import { CONFIG } from '../config';
import { Debris } from '../arena/Debris';
import { resolveImage } from '../assets/AssetLoader';
import { bossStagePortrait, MODELS } from '../assets/manifest';
import { events } from '../core/events';
import { feel } from '../core/feel';
import { clamp, damp, lerp, wrapAngle } from '../core/math';
import type { Game } from '../core/Game';
import { GROUP } from '../physics/Physics';
import { rivalAccent } from '../ui/HUD';
import type { Wizard } from '../wizard/Wizard';
import type { BossStages } from './BossStages';
import type { BossFighter } from './levels';

const K = CONFIG.campaign.cinematic;
const C = CONFIG.campaign;

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpBase = new THREE.Vector3();
const tmpColor = new THREE.Color();
const tmpColor2 = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);
const RAGE = new THREE.Color(0xff1e10);

const sat = (x: number) => clamp(x, 0, 1);
const smooth = (a: number, b: number, x: number) => {
  const t = sat((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const smoother = (t: number) => {
  t = sat(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
const easeOut3 = (t: number) => 1 - Math.pow(1 - sat(t), 3);

// ------------------------------------------------------------------ shaders

/**
 * Additive shell over the boss's meshes: a fresnel glow and Voronoi cracks of light, in his own
 * frame. Skinning-aware, so it follows a rigged model's pose too.
 */
const SHELL_VERT = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>
  uniform float uInflate;
  uniform mat4 uInvRoot;
  varying vec3 vLocal;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    #include <beginnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    vec4 wp = modelMatrix * vec4(transformed, 1.0);
    vec3 wn = normalize(mat3(modelMatrix) * objectNormal);
    wp.xyz += wn * uInflate;
    vLocal = (uInvRoot * wp).xyz;
    vN = wn;
    vV = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const SHELL_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform float uGlow;
  uniform float uCrack;
  uniform float uTime;
  varying vec3 vLocal;
  varying vec3 vN;
  varying vec3 vV;
  vec3 hash3(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453);
  }
  float edges(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    float d1 = 8.0, d2 = 8.0;
    for (int x = -1; x <= 1; x++)
    for (int y = -1; y <= 1; y++)
    for (int z = -1; z <= 1; z++) {
      vec3 g = vec3(float(x), float(y), float(z));
      vec3 r = g + hash3(i + g) - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
    return sqrt(d2) - sqrt(d1);
  }
  void main() {
    float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
    // Cracks open from the chest outward as uCrack grows.
    float reach = uCrack * 2.2;
    float mask = 1.0 - smoothstep(reach * 0.7, reach, abs(vLocal.y - 1.1) + length(vLocal.xz) * 0.6);
    float e = edges(vLocal * 3.4);
    float line = (1.0 - smoothstep(0.0, 0.018 + 0.045 * uCrack, e)) * mask * step(0.001, uCrack);
    float flick = 0.8 + 0.2 * sin(uTime * 31.0 + vLocal.y * 11.0);
    // A rim glow that leaves the form's own colours readable, and hot cracks over it.
    vec3 col = uColor * uGlow * (0.12 + 1.3 * rim) + uHot * line * (0.9 + 1.4 * uCrack) * flick;
    float a = clamp(uGlow * (0.08 + 0.75 * rim) + line, 0.0, 1.0);
    gl_FragColor = vec4(col * a, a);
  }
`;

/** A funnel of swirling light pulling into the boss. */
const VORTEX_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const VORTEX_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    float s = vUv.x * 7.0 + vUv.y * 3.5 - uTime * 2.6;
    float band = pow(0.5 + 0.5 * sin(s * 6.2831), 3.0);
    float s2 = vUv.x * 11.0 - vUv.y * 2.0 - uTime * 4.1;
    band += 0.5 * pow(0.5 + 0.5 * sin(s2 * 6.2831), 6.0);
    float edge = smoothstep(0.0, 0.18, vUv.y) * (1.0 - smoothstep(0.7, 1.0, vUv.y));
    float a = band * edge * uOpacity;
    gl_FragColor = vec4(uColor * (1.2 + band) * a, a);
  }
`;

/** Glowing cracks spreading across the floor under the boss. */
const CRACK_VERT = VORTEX_VERT;
const CRACK_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uGlow;
  uniform float uSpread;
  uniform float uTime;
  uniform float uSeed;
  varying vec2 vUv;
  float h(float n) { return fract(sin(n) * 43758.5453); }
  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    float ang = atan(p.y, p.x);
    float k = ang / 6.28318 * 13.0 + uSeed;
    float id = floor(k);
    float f = fract(k) - 0.5;
    float wob = (h(id) - 0.5) * 0.45 + sin(r * 13.0 + id * 2.7) * 0.09 + sin(r * 31.0 + id) * 0.03;
    float len = uSpread * (0.55 + 0.45 * h(id + 7.3));
    float ray = (1.0 - smoothstep(0.0, 0.025 + 0.05 * (1.0 - r), abs(f - wob))) * (1.0 - smoothstep(len * 0.85, len, r));
    float ring = exp(-pow((r - uSpread * 0.8) * 10.0, 2.0)) * 0.35 * uSpread;
    float core = exp(-r * 7.0) * 0.5;
    float edge = 1.0 - smoothstep(0.85, 1.0, r);
    // Saturates at the colour (the rays and core never go far past it: bloom would wash the shot out).
    float a = min(1.0, (ray + ring + core) * edge * uGlow);
    float pulse = 1.2 + 0.35 * sin(uTime * 8.0 - r * 18.0);
    gl_FragColor = vec4(uColor * pulse * a, a);
  }
`;

/** A palette tint over the sky, behind everything in the arena (it tints, it doesn't brighten). */
const DOME_VERT = /* glsl */ `
  varying float vY;
  void main() {
    vY = normalize(position).y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const DOME_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vY;
  void main() {
    float horizon = 1.0 - smoothstep(-0.05, 0.75, vY);
    float a = (0.55 + 0.45 * horizon) * uOpacity;
    gl_FragColor = vec4(uColor, a);
  }
`;

/** An expanding shockwave: a band of fixed width in metres (it never floods the floor near its centre). */
const WAVE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uRadius;
  uniform float uWidth;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float d = (1.0 - r) * uRadius;
    float band = (1.0 - smoothstep(0.0, uWidth, abs(d))) * step(r, 1.0);
    float trail = d > 0.0 ? exp(-d / (uWidth * 3.0)) * 0.35 : 0.0;
    float a = min(1.0, (band + trail) * uOpacity * step(r, 1.0));
    gl_FragColor = vec4(uColor * (1.0 + band) * a, a);
  }
`;

/** The orbit camera at one moment (BossCinematic.orbitPose). */
interface OrbitPose {
  theta: number;
  dist: number;
  y: number;
  centerY: number;
}
const orbitPose: OrbitPose = { theta: 0, dist: 0, y: 0, centerY: 0 };

interface Wave {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  t: number;
  duration: number;
  radius: number;
}

// ------------------------------------------------------------------ the shot

interface Shot {
  stages: BossStages;
  boss: BossFighter;
  w: Wizard;
  /** Stage being entered (1 or 2). */
  stage: number;
  enraged: boolean;
  /** Params index: 1 for stage 2, 2 for stage 3 and the enrage. */
  tier: 1 | 2;
  duration: number;
  /** Cinematic seconds (pausable, sped up by a skip). */
  t: number;
  /** Real seconds in the play phase (the slow-mo into the freeze). */
  real: number;
  speed: number;
  /** How high he floats right now (m), for the camera. */
  rise: number;
  phase: 'play' | 'count' | 'out';
  phaseT: number;
  burst: boolean;
  slam: boolean;
  prePulse: boolean;
  lastCount: number;
  /** Camera at the cut, in boss-centred polar coordinates. */
  fromTheta: number;
  fromDist: number;
  fromY: number;
  fromQuat: THREE.Quaternion;
  fromFov: number;
  /** The orbit (planOrbit): start angle, direction (+1/-1) and extra camera height (m) that keep it clear of cover. */
  orbitStart: number;
  orbitDir: number;
  lift: number;
  /** The arena's light factor (K.themeLight): bloom, flashes, lights and sparks at the burst and slam. */
  light: number;
  /** Camera distance from the boss's centre this frame: as planned, and after keeping out of walls (QA). */
  camPlanned: number;
  camActual: number;
  /** The look height (top of the current form), smoothed across the swap. */
  height: number;
  color: number;
  colorHi: number;
}

/**
 * Boss transformation cinematics. In a live Boss Gauntlet fight, every `bossEvolve` (a stage's bar
 * emptied, or a double fight's survivor enraged) plays a short cinematic instead of the headless
 * sim-time transformation:
 *
 * 1. The cut: the world eases into a freeze (Game.cinematicScale: no wizard, spell, fire or lava
 *    moves or hurts, and player input is ignored), letterbox bars slide in, and the camera swoops
 *    from the player's shoulder to orbit the boss (Game.director).
 * 2. The charge: he rises off the ground, spins and shudders; his form glows brighter and brighter
 *    and cracks with light (an additive shell over his meshes); an energy vortex spirals into him,
 *    the floor cracks and glows under him, and sky and fog tint toward his palette.
 * 3. The burst: the old form bursts into light and sparks (flash, bloom pulse, shake, a roar), the
 *    title card shows the stage (name, concept art, the refilling bar), and the new form grows out
 *    of the light with an overshoot squash and stretch while the health bar sweeps up.
 * 4. The slam: he drops and lands; an arena-wide shockwave ring, debris, dust and a big shake.
 * 5. The return: the camera orbits back to the player's view, the bars and the tint go, a quick
 *    "3 2 1" plays with the world still frozen, then time ramps back and the boss stays frozen and
 *    immune for a short grace (BossStages.release).
 *
 * The timeline drives BossStages (`drive`), so the look swap and the bar refill line up with it.
 * Stage 3 and the enrage are bigger and longer (CONFIG.campaign.cinematic, per stage). Real time,
 * but pausable: nothing advances while the game is paused. A skip key plays the rest faster. Every
 * effect is built once and reused. Headless (QA, soaks, menus) nothing plays: `live` is false.
 */
export class BossCinematic {
  /** Armed by App while a gauntlet fight is being played. */
  armed = false;
  /** QA: play even while the harness runs (qaMode). */
  allowInQa = false;
  private shot: Shot | null = null;
  private readonly queue: { stages: BossStages; stage: number; enraged: boolean }[] = [];
  private readonly overlay: HTMLElement;
  private readonly barTop: HTMLElement;
  private readonly barBottom: HTMLElement;
  private readonly card: HTMLElement;
  private readonly cardArt: HTMLImageElement;
  private readonly cardEyebrow: HTMLElement;
  private readonly cardTitle: HTMLElement;
  private readonly cardFill: HTMLElement;
  private readonly count: HTMLElement;
  private readonly skipHint: HTMLElement;
  // Pooled effects.
  private readonly shellOld: THREE.ShaderMaterial;
  private readonly shellNew: THREE.ShaderMaterial;
  private readonly shells: THREE.Mesh[] = [];
  private readonly vortex: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>;
  private readonly crack: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly dome: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  /** Shockwave rings (pooled), animated on real time. */
  private readonly waves: Wave[] = [];
  private readonly debris: Debris;
  private readonly eye = new THREE.PerspectiveCamera();
  private readonly invRoot = new THREE.Matrix4();
  /** Fog colour before the tint, restored afterwards. */
  private readonly fogBase = new THREE.Color();
  private fogSaved = false;
  /** After-glow of the floor cracks once the shot is over (s left). */
  private crackFade = 0;
  private time = 0;

  constructor(private readonly game: Game, hudRoot: HTMLElement) {
    // Letterbox, title card and resume count: under the HUD (its plates stay readable on the bars).
    this.overlay = document.createElement('div');
    this.overlay.className = 'cine';
    this.overlay.innerHTML = `
      <div class="cine-bar top"></div><div class="cine-bar bottom"></div>
      <div class="cine-card"><img class="cine-art" alt="" draggable="false">
        <div class="cine-text"><p class="cine-eyebrow"></p><h2 class="cine-title"></h2><div class="cine-hp"><i></i></div></div>
      </div>
      <div class="cine-count"></div>
      <div class="cine-skip">Space · A · faster</div>`;
    hudRoot.parentElement!.insertBefore(this.overlay, hudRoot);
    const q = <T extends HTMLElement>(sel: string) => this.overlay.querySelector(sel) as T;
    this.barTop = q('.cine-bar.top');
    this.barBottom = q('.cine-bar.bottom');
    this.card = q('.cine-card');
    this.cardArt = q('.cine-art');
    this.cardEyebrow = q('.cine-eyebrow');
    this.cardTitle = q('.cine-title');
    this.cardFill = q('.cine-hp i');
    this.count = q('.cine-count');
    this.skipHint = q('.cine-skip');

    const scene = game.renderer.scene;
    const shell = () => new THREE.ShaderMaterial({
      vertexShader: SHELL_VERT,
      fragmentShader: SHELL_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color() }, uHot: { value: new THREE.Color() }, uGlow: { value: 0 }, uCrack: { value: 0 },
        uTime: { value: 0 }, uInflate: { value: 0.012 }, uInvRoot: { value: this.invRoot },
      },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.shellOld = shell();
    this.shellNew = shell();

    this.vortex = new THREE.Mesh(
      new THREE.CylinderGeometry(2.1, 0.3, 4.6, 48, 1, true),
      new THREE.ShaderMaterial({
        vertexShader: VORTEX_VERT, fragmentShader: VORTEX_FRAG,
        uniforms: { uColor: { value: new THREE.Color() }, uOpacity: { value: 0 }, uTime: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      }),
    );
    this.vortex.renderOrder = 12;
    this.vortex.visible = false;
    this.vortex.frustumCulled = false;
    scene.add(this.vortex);

    this.crack = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        vertexShader: CRACK_VERT, fragmentShader: CRACK_FRAG,
        uniforms: { uColor: { value: new THREE.Color() }, uGlow: { value: 0 }, uSpread: { value: 0 }, uTime: { value: 0 }, uSeed: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }),
    );
    this.crack.position.y = 0.045;
    this.crack.renderOrder = 7;
    this.crack.visible = false;
    scene.add(this.crack);

    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(250, 32, 16),
      new THREE.ShaderMaterial({
        vertexShader: DOME_VERT, fragmentShader: DOME_FRAG,
        uniforms: { uColor: { value: new THREE.Color() }, uOpacity: { value: 0 } },
        transparent: true, depthWrite: false, side: THREE.BackSide, fog: false, toneMapped: false,
      }),
    );
    this.dome.visible = false;
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1;
    scene.add(this.dome);

    // Real-time debris (the arena's own chunks freeze with the world), in the arena's look.
    this.debris = new Debris(scene, 48, game.arena.debris.material, game.arena.debris.geometry);
    const waveGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(waveGeo, new THREE.ShaderMaterial({
        vertexShader: VORTEX_VERT, fragmentShader: WAVE_FRAG,
        uniforms: { uColor: { value: new THREE.Color() }, uRadius: { value: 1 }, uWidth: { value: 0.6 }, uOpacity: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      }));
      mesh.position.y = 0.06;
      mesh.renderOrder = 8;
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.waves.push({ mesh, t: 0, duration: 0, radius: 1 });
    }

    // Warm-ups (Game.warmUp, behind the boss card) draw the glow shells on every stage look too,
    // and the landing's debris in the arena's look, so the first transformation compiles nothing.
    game.warmHooks.push((looks) => {
      const added: THREE.Mesh[] = [];
      for (const r of looks) this.shellsOn(r, this.shellOld, added);
      this.debris.setMaterial(game.arena.debris.material);
      this.debris.setGeometry(game.arena.debris.geometry);
      return () => {
        for (const sh of added) sh.removeFromParent();
      };
    });

    events.on('bossEvolve', (e) => {
      if (!this.live) return;
      const stages = game.stagesOf(e.wizard);
      if (stages) this.enqueue(stages, e.stage, e.enraged);
    });
    game.onFrame((dt) => this.frame(dt));
  }

  /** Transformations play as cinematics now: armed (a gauntlet fight), enabled, and not under QA. */
  get live(): boolean {
    return K.enabled && this.armed && (!(this.game.qaMode || this.game.inSandbox) || this.allowInQa);
  }

  /** A cinematic is on screen (or queued). */
  get active(): boolean {
    return this.shot !== null;
  }

  /** The current shot's phase and progress, and its camera this frame (QA). */
  get state(): {
    phase: string; t: number; duration: number; stage: number; enraged: boolean; wizard: Wizard;
    camera: { planned: number; actual: number; lift: number; start: number; dir: number };
  } | null {
    const s = this.shot;
    return s ? {
      phase: s.phase, t: s.t, duration: s.duration, stage: s.stage, enraged: s.enraged, wizard: s.w,
      camera: { planned: s.camPlanned, actual: s.camActual, lift: s.lift, start: s.orbitStart, dir: s.orbitDir },
    } : null;
  }

  /** Stop at once and put everything back (leaving the fight, Retry). The transformation completes. */
  abort(): void {
    const s = this.shot;
    this.queue.length = 0;
    if (s) {
      s.stages.release(0);
      this.finish(s);
    }
    this.restoreWorld();
    this.crackFade = 0;
    this.crack.visible = false;
    for (const w of this.waves) w.mesh.visible = false;
  }

  // ------------------------------------------------------------------ timeline

  private enqueue(stages: BossStages, stage: number, enraged: boolean): void {
    // Take the transformation over now, so the sim never advances it on its own.
    stages.drive(0);
    if (this.shot) this.queue.push({ stages, stage, enraged });
    else this.begin(stages, stage, enraged);
  }

  private begin(stages: BossStages, stage: number, enraged: boolean): void {
    const g = this.game;
    const boss = stages.boss;
    if (!boss) return;
    const w = stages.owner;
    const tier: 1 | 2 = enraged || stage >= 2 ? 2 : 1;
    const cam = g.renderer.camera;
    const pos = w.visual.root.position;
    tmpA.set(cam.position.x - pos.x, 0, cam.position.z - pos.z);
    const pal = boss.palette;
    const color = enraged ? tmpColor.setHex(pal.ultimate).lerp(RAGE, 0.45).getHex() : pal.ultimate;
    const shot: Shot = {
      stages, boss, w, stage, enraged, tier,
      duration: enraged ? K.enrageDuration : K.duration[tier],
      t: 0, real: 0, speed: 1, rise: 0, phase: 'play', phaseT: 0,
      burst: false, slam: false, prePulse: false, lastCount: -1,
      fromTheta: Math.atan2(tmpA.x, tmpA.z),
      fromDist: Math.max(1, tmpA.length()),
      fromY: cam.position.y,
      fromQuat: cam.quaternion.clone(),
      fromFov: cam.fov,
      orbitStart: Math.atan2(tmpA.x, tmpA.z) + 0.4,
      orbitDir: 1,
      lift: 0,
      light: K.themeLight[g.arena.theme] ?? 1,
      camPlanned: 0,
      camActual: 0,
      height: w.visual.topHeight * stages.lookScale,
      color,
      colorHi: tmpColor2.setHex(pal.spell).lerp(WHITE, 0.55).getHex(),
    };
    this.planOrbit(shot);
    this.shot = shot;
    stages.drive(0);
    g.director = this.direct;
    g.player.intent.clear();
    this.setChrome(true);
    // The card: the stage, its name and concept art, in the boss's colours.
    for (const [k, v] of rivalAccent(boss.palette)) this.overlay.style.setProperty(k, v);
    const st = boss.stages[stage];
    this.cardEyebrow.textContent = enraged ? `Enraged · Stage ${stage + 1}` : stage === 2 ? 'Final Form · Stage 3' : `Stage ${stage + 1} of 3`;
    this.cardTitle.textContent = enraged ? `${w.name} is enraged!` : st.name;
    const art = resolveImage(bossStagePortrait(boss.id, stage));
    this.cardArt.style.display = art ? '' : 'none';
    if (art) this.cardArt.src = art;
    this.overlay.className = `cine on tier${tier}${enraged ? ' enrage' : ''}`;
    // Effects in the boss's colours.
    this.shellOld.uniforms.uColor.value.setHex(pal.spell).multiplyScalar(1.4);
    this.shellOld.uniforms.uHot.value.setHex(color).lerp(WHITE, 0.55);
    this.shellNew.uniforms.uColor.value.setHex(pal.spell).lerp(WHITE, 0.15).multiplyScalar(1.15);
    this.shellNew.uniforms.uHot.value.setHex(color);
    this.vortex.material.uniforms.uColor.value.setHex(pal.spell).lerp(WHITE, 0.2);
    this.crack.material.uniforms.uColor.value.setHex(color).multiplyScalar(K.crackGlow * shot.light);
    this.crack.material.uniforms.uSeed.value = Math.random() * 10;
    // A deep shade of the palette: it darkens and tints bright skies instead of washing them out.
    this.dome.material.uniforms.uColor.value.setHex(enraged ? color : pal.spell).multiplyScalar(0.35);
    this.attachShells(this.shellOld);
    const fog = g.renderer.scene.fog as THREE.Fog | null;
    if (fog && !this.fogSaved) {
      this.fogBase.copy(fog.color);
      this.fogSaved = true;
    }
    events.emit('bossCinematic', { wizard: w, boss, stage, beat: 'start', enraged });
  }

  /** Per render frame (after BossStages has set the look): advance the shot and pose everything. */
  private frame(realDt: number): void {
    const g = this.game;
    this.time += realDt;
    const run = g.simulating ? realDt : 0;
    // The floor cracks glow on a little after the shot.
    if (!this.shot && this.crackFade > 0) {
      this.crackFade = Math.max(0, this.crackFade - run);
      const u = this.crack.material.uniforms;
      u.uGlow.value = this.crackFade / 1.5;
      u.uTime.value = this.time;
      this.crack.visible = this.crackFade > 0;
    }
    this.updateWaves(run);
    if (!this.shot) {
      this.debris.update(run);
      return;
    }
    const s = this.shot;
    if (s.phase === 'play') {
      if (run > 0 && s.t > K.skipAfter && s.speed === 1 && this.skipPressed()) s.speed = K.skipSpeed;
      s.t = Math.min(s.duration, s.t + run * s.speed);
      s.real += run;
      g.cinematicScale = Math.max(0, 1 - s.real / K.easeIn);
      this.play(s, run);
      if (s.t >= s.duration) {
        s.phase = 'count';
        s.phaseT = 0;
        g.director = null;
        this.endPose(s);
      }
    } else if (s.phase === 'count') {
      g.cinematicScale = 0;
      s.phaseT += run * (s.speed > 1 ? 2 : 1);
      const n = 3 - Math.floor((s.phaseT / K.resume) * 3);
      if (n !== s.lastCount && n >= 1) {
        s.lastCount = n;
        this.count.textContent = String(n);
        this.count.classList.remove('pop');
        void this.count.offsetWidth;
        this.count.classList.add('pop');
        events.emit('bossCinematic', { wizard: s.w, boss: s.boss, stage: s.stage, beat: 'count', enraged: s.enraged });
      }
      this.fadeWorld(s, 0);
      if (s.phaseT >= K.resume) {
        s.phase = 'out';
        s.phaseT = 0;
        this.count.textContent = 'Fight!';
        s.stages.release(K.grace);
        events.emit('bossCinematic', { wizard: s.w, boss: s.boss, stage: s.stage, beat: 'resume', enraged: s.enraged });
      }
    } else {
      s.phaseT += run;
      g.cinematicScale = Math.min(1, s.phaseT / K.easeOut);
      this.count.style.opacity = (1 - s.phaseT / K.easeOut).toFixed(3);
      if (s.phaseT >= K.easeOut) this.finish(s);
    }
    this.debris.update(run);
  }

  /** Everything in the 'play' phase at the shot's current time. */
  private play(s: Shot, run: number): void {
    const g = this.game;
    const D = s.duration;
    const t = s.t;
    const tier = s.tier;
    const I = K.intensity[tier];
    const tBurst = K.burstAt * D, tSlam = K.slamAt * D, tReturn = K.returnAt * D;
    const st = s.stages;
    // The transformation follows the timeline: the swap lands exactly on the burst.
    const p = t < tBurst ? (t / tBurst) * C.evolveSwapAt : C.evolveSwapAt + ((t - tBurst) / (D - tBurst)) * (1 - C.evolveSwapAt);
    st.drive(p);

    const root = s.w.visual.root;
    // Where WizardVisual put him this frame (on the ground); the pose below lifts and turns him.
    const base = tmpBase.copy(root.position);
    const charge = sat(t / tBurst);
    const burstNow = !s.burst && t >= tBurst;
    if (burstNow) s.burst = true;

    // ---- the boss: rise, spin, shudder, swell; then grow out of the light; then the landing
    const rise = K.rise[tier];
    const fall = 0.17 + 0.05 * tier;
    let y = 0;
    if (t < tSlam - fall) y = rise * easeOut3(t / (tBurst * 0.8)) + (s.burst ? 0.06 * Math.sin((t - tBurst) * 5) : 0);
    else if (t < tSlam) {
      const k = (t - (tSlam - fall)) / fall;
      y = rise * (1 - k * k);
    }
    const shudder = s.burst ? 0 : 0.06 * I * charge * charge;
    root.position.set(
      base.x + (Math.random() - 0.5) * shudder,
      base.y + y,
      base.z + (Math.random() - 0.5) * shudder,
    );
    root.rotation.y += Math.PI * 2 * K.spins[tier] * smoother(t / tSlam);
    root.rotation.x = s.burst ? 0 : -0.16 * easeOut3(charge);
    root.rotation.z = 0;
    const look = st.lookScale;
    let sx = look, sy = look;
    if (!s.burst) {
      // The old form pulses and swells toward the burst.
      const pulse = 1 + (0.025 + 0.05 * charge) * Math.sin(t * (10 + 26 * charge)) * charge + 0.07 * charge * charge;
      sx = sy = look * pulse;
    } else if (t < tSlam) {
      // Overshoot growth with squash and stretch (seconds since the burst, at the shot's speed).
      const e = (t - tBurst) / s.speed;
      const grow = Math.max(0.03, 1 - Math.exp(-7 * e) * Math.cos(13 * e));
      const wob = Math.exp(-5 * e) * Math.sin(13 * e);
      sy = look * grow * (1 + 0.2 * wob);
      sx = look * grow * (1 - 0.11 * wob);
    } else {
      // The landing squash, springing back.
      const e = (t - tSlam) / s.speed;
      const sq = Math.exp(-9 * e) * Math.cos(19 * e);
      sy = look * (1 - 0.24 * sq);
      sx = look * (1 + 0.13 * sq);
    }
    root.scale.set(sx, sy, sx);
    root.updateMatrixWorld(true);
    this.invRoot.copy(root.matrixWorld).invert();
    s.height = damp(s.height, s.w.visual.topHeight * look, 8, run || 1e-3);
    s.rise = y;

    // ---- beats
    if (tier === 2 && !s.prePulse && t >= tBurst * 0.62) {
      // The final form fights its way out: a false burst first.
      s.prePulse = true;
      g.fx.flash(tmpA.set(base.x, base.y + y + s.height * 0.6, base.z), s.color, 5, 0.2);
      this.wave(base, s.color, 7, 0.45, 0.5);
      feel.shake(0.25 * I);
    }
    if (burstNow) this.onBurst(s, base);
    if (!s.slam && t >= tSlam) {
      s.slam = true;
      this.onSlam(s, base);
    }

    // ---- the glow shells: old form glows, pulses and cracks; new form fades out of the light
    const time = this.time;
    for (const m of [this.shellOld, this.shellNew]) m.uniforms.uTime.value = time;
    const ramp = charge * charge;
    this.shellOld.uniforms.uGlow.value = s.burst ? 0 : ramp * (0.75 + 0.25 * Math.sin(t * (8 + 22 * charge))) * (0.6 + 0.15 * I);
    this.shellOld.uniforms.uCrack.value = s.burst ? 0 : smooth(tBurst * 0.28, tBurst, t);
    // The new form fades out of its light quickly (sooner in a bright arena), so it reads.
    this.shellNew.uniforms.uGlow.value = s.burst ? (0.35 + 0.3 * s.light) * Math.max(0, 1 - (t - tBurst) / ((0.22 + 0.1 * s.light) * s.speed)) : 0;
    this.shellNew.uniforms.uCrack.value = 0;

    // ---- the vortex and its sparks
    const vortexOn = s.burst ? Math.max(0, 1 - (t - tBurst) / 0.18) : smooth(0, tBurst * 0.4, t);
    this.vortex.visible = vortexOn > 0.01;
    if (this.vortex.visible) {
      const vu = this.vortex.material.uniforms;
      vu.uOpacity.value = vortexOn * (0.22 + 0.1 * I) * (0.7 + 0.3 * charge);
      vu.uTime.value = time * (1 + 2.5 * charge);
      const k = (s.burst ? vortexOn : 1) * (0.9 + 0.1 * I) * (s.height / 2.2);
      this.vortex.position.set(base.x, base.y + y + s.height * 0.5, base.z);
      this.vortex.scale.set(k * (1.05 - 0.3 * charge), k, k * (1.05 - 0.3 * charge));
      this.vortex.rotation.y = -time * (2 + 6 * charge);
    }
    if (!s.burst && run > 0) this.spiralSparks(s, base, y, charge, run);

    // ---- floor cracks
    const cu = this.crack.material.uniforms;
    this.crack.visible = true;
    this.crack.position.set(base.x, 0.045, base.z);
    const R = (4 + 2.5 * I) * (s.height / 2.2);
    this.crack.scale.set(R * 2, 1, R * 2);
    cu.uSpread.value = s.slam ? Math.min(1, 0.7 + (t - tSlam) * 2) : 0.15 + 0.55 * smooth(0, tBurst, t);
    cu.uGlow.value = (s.slam ? 1.6 * Math.exp(-(t - tSlam) * 1.5) + 0.6 : 0.3 + 0.6 * charge) * (0.7 + 0.3 * I);
    cu.uTime.value = time;

    // ---- sky, fog and bloom
    const peak = s.slam ? Math.exp(-(t - tSlam) * 3) * 0.6 : 0;
    const flash = s.burst ? Math.exp(-(t - tBurst) * 4) : 0;
    const tint = K.tint[tier] * (smooth(0, tBurst, t) * (1 - smooth(tReturn, D, t))) + 0.5 * flash + 0.4 * peak;
    this.tintWorld(s, tint);
    // The bar's presence: the shot's own look fades in with the letterbox and out with it.
    const bar = smooth(0, 0.3, t) * (1 - smooth(tReturn, D, t));
    // A bright arena's own glow (sun on sand, lava) is turned down for the shot, so the bloom
    // never fogs the new form; the beats add a little of their own on top.
    const duck = CONFIG.render.bloomStrength * K.bloomDuck * (1 - s.light) * bar;
    g.renderer.bloomBoost = K.bloom[tier] * s.light * (flash + 0.5 * peak + 0.15 * ramp * (s.burst ? 0 : 1)) - duck;

    // ---- letterbox and title card (driven here so pausing freezes them)
    this.barTop.style.transform = `scaleY(${bar.toFixed(3)})`;
    this.barBottom.style.transform = `scaleY(${bar.toFixed(3)})`;
    const cardIn = s.burst ? smooth(tBurst, tBurst + 0.25 * s.speed, t) * (1 - smooth(tReturn + (D - tReturn) * 0.3, D, t)) : 0;
    this.card.style.opacity = cardIn.toFixed(3);
    this.card.style.transform = `translate(-50%, ${((1 - cardIn) * 24).toFixed(1)}px) scale(${(0.92 + 0.08 * cardIn).toFixed(3)})`;
    const hp = s.w.maxHealth > 0 ? s.w.health / s.w.maxHealth : 0;
    this.cardFill.style.transform = `scaleX(${sat(hp).toFixed(4)})`;
    this.skipHint.style.opacity = s.speed === 1 && t > K.skipAfter ? (bar * 0.7).toFixed(3) : '0';
  }

  /** The old form bursts into light; the new one is about to grow out of it. */
  private onBurst(s: Shot, base: THREE.Vector3): void {
    const g = this.game;
    // Light scales with the boss (a short one is framed closer): never a white-out. In his colours
    // rather than white, and dimmer in a bright arena (s.light): the new form must read.
    const size = Math.min(1, s.height / 2.2);
    const I = K.intensity[s.tier] * size;
    const L = s.light;
    const at = tmpA.set(base.x, base.y + s.rise + s.height * 0.55, base.z);
    tmpColor.setHex(s.color);
    tmpColor2.setHex(s.colorHi);
    // Fewer sparks for a short boss (framed closer) and in a bright arena.
    const n = K.intensity[s.tier] * (0.35 + 0.65 * size) * (0.4 + 0.6 * L);
    const mote = 0.6 + 0.4 * size;
    g.fx.sparks.burst(at, Math.round(110 * n), tmpColor, 3.2, 6, 18 * Math.sqrt(n), 0.24 * mote, 0.9, { gravity: 2, drag: 1.6 });
    g.fx.sparks.burst(at, Math.round(45 * n), tmpColor2, 3.6, 2, 7, 0.32 * mote, 0.55, { drag: 3 });
    g.fx.sparks.burst(at, Math.round(20 * n), tmpColor2, 3, 10, 24, 0.1 * mote, 0.3, { drag: 2 });
    g.fx.flash(at, s.color, 3.2 * I * L, 0.32);
    g.fx.flash(at, s.colorHi, 1.2 * I * L, 0.14);
    this.wave(base, s.color, 10 * K.intensity[s.tier], 0.6, 0.7);
    this.keyLight(s, base, 0.7, 10 * I * L, 0.6);
    feel.shake(0.55 * I);
    feel.screenFlash(s.color, C.evolveFlash);
    // The new form wears a fading shell of light.
    this.detachShells();
    this.attachShells(this.shellNew);
    events.emit('bossCinematic', { wizard: s.w, boss: s.boss, stage: s.stage, beat: 'burst', enraged: s.enraged });
  }

  /** He lands: an arena-wide shockwave, debris, dust and a big shake. */
  private onSlam(s: Shot, base: THREE.Vector3): void {
    const g = this.game;
    const I = K.intensity[s.tier];
    const size = Math.min(1, s.height / 2.2);
    const L = s.light;
    tmpB.set(base.x, 0, base.z);
    // The arena-wide shockwave, a fast one inside it and a ring at his feet, in his colours (sized
    // to him: a short boss is framed close); a low flash and light at his feet (never over the new
    // form), fewer sparks when bright.
    this.wave(tmpB, s.color, CONFIG.arena.fireRadius + 4, 0.9 + 0.2 * s.tier, 1.4);
    this.wave(tmpB, s.color, 12 * I * size, 0.45, 0.6);
    this.wave(tmpB, s.color, 4 * I * size, 0.3, 0.4);
    g.fx.flash(tmpA.set(base.x, 0.25, base.z), s.color, 1.8 * I * L * size, 0.24);
    this.keyLight(s, base, 0.45, 10 * I * L * size, 0.45);
    tmpColor.setHex(s.color);
    for (let i = 0; i < 26 * I * L * size; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 6 + Math.random() * 10;
      g.fx.sparks.emit(base.x + Math.sin(a) * 0.6, 0.15, base.z + Math.cos(a) * 0.6,
        Math.sin(a) * sp, 0.6 + Math.random() * 2, Math.cos(a) * sp, tmpColor, 2.8, 0.18, 0.5 + Math.random() * 0.4, { drag: 2.4 });
    }
    g.fx.dust(tmpA.set(base.x, 0.2, base.z), Math.round(4 * I), 1.6);
    this.debris.setMaterial(g.arena.debris.material);
    this.debris.setGeometry(g.arena.debris.geometry);
    const n = K.debris[s.tier];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      this.debris.spawn(tmpA.set(base.x + Math.sin(a) * 1.2, 0.3, base.z + Math.cos(a) * 1.2), Math.ceil(n / 6), 0.8 + 0.2 * s.tier);
    }
    feel.shake(0.7 * I);
    events.emit('bossCinematic', { wizard: s.w, boss: s.boss, stage: s.stage, beat: 'slam', enraged: s.enraged });
  }

  /**
   * A light in his colour on the camera's side of him (`up` x his height above his feet), so the
   * new form is lit in his palette from the front instead of glowing from inside.
   */
  private keyLight(s: Shot, base: THREE.Vector3, up: number, intensity: number, duration: number): void {
    const cam = this.game.renderer.camera.position;
    tmpC.set(cam.x - base.x, 0, cam.z - base.z);
    if (tmpC.lengthSq() < 1e-6) tmpC.set(0, 0, 1);
    tmpC.normalize().multiplyScalar(1 + 0.4 * s.height);
    this.game.fx.light(tmpB.set(base.x + tmpC.x, base.y + s.rise + s.height * up, base.z + tmpC.z), s.color, intensity, duration);
  }

  /** Motes on a spiral, pulled into the boss. */
  private spiralSparks(s: Shot, base: THREE.Vector3, y: number, charge: number, dt: number): void {
    const fx = this.game.fx;
    const n = Math.round((40 + 120 * charge) * K.intensity[s.tier] * (0.55 + 0.45 * Math.min(1, s.height / 2.2)) * (0.5 + 0.5 * s.light) * dt);
    tmpColor.setHex(s.boss.palette.spell);
    tmpColor2.setHex(s.colorHi);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 3 + Math.random() * 2.5;
      const h = base.y + y + Math.random() * s.height * 1.3;
      const sx = Math.sin(a), cz = Math.cos(a);
      const inward = 6 + 5 * charge, swirl = 7;
      fx.sparks.emit(base.x + sx * r, h, base.z + cz * r,
        -sx * inward + cz * swirl, (base.y + y + s.height * 0.55 - h) * 1.6, -cz * inward - sx * swirl,
        i % 3 ? tmpColor : tmpColor2, 2.6, 0.1 + Math.random() * 0.08, 0.45, { drag: 0.6 });
    }
  }

  // ------------------------------------------------------------------ camera

  /** Game.director: the cinematic camera, after the rig has placed its over-the-shoulder view. */
  private readonly direct = (): void => {
    const s = this.shot;
    if (!s || s.phase !== 'play') return;
    const g = this.game;
    const cam = g.renderer.camera;
    const D = s.duration, t = s.t;
    const tBurst = K.burstAt * D, tReturn = K.returnAt * D;
    const base = s.w.visual.root.position;
    // Where the rig wants the camera now (the return blends into it).
    const rigTheta = Math.atan2(cam.position.x - base.x, cam.position.z - base.z);
    const rigDist = Math.hypot(cam.position.x - base.x, cam.position.z - base.z);
    const rigY = cam.position.y;
    tmpQ.copy(cam.quaternion);
    const rigFov = cam.fov;

    // The orbit around the boss (on the side planOrbit found clear of cover).
    const o = this.orbitPose(s, t, s.height, s.rise, orbitPose);
    const center = tmpA.set(base.x, base.y + o.centerY, base.z);
    const theta = o.theta;
    let dist = o.dist;
    let y = base.y + o.y + s.lift;
    s.camPlanned = Math.hypot(o.dist, o.y - o.centerY);

    // The cut in, then the return: polar blends around the boss, so the camera never passes through him.
    const swoop = smooth(0, 0.13 * D, t);
    const back = smooth(tReturn, D, t);
    let th = theta;
    if (swoop < 1) {
      th = s.fromTheta + wrapAngle(theta - s.fromTheta) * swoop;
      dist = lerp(s.fromDist, dist, swoop);
      y = lerp(s.fromY, y, swoop);
    }
    if (back > 0) {
      th = th + wrapAngle(rigTheta - th) * back;
      dist = lerp(dist, rigDist, back);
      y = lerp(y, rigY, back);
    }
    const pos = tmpB.set(base.x + Math.sin(th) * dist, y, base.z + Math.cos(th) * dist);
    // Last resort (the plan keeps the shot clear): never inside a wall or cover, pull in along the line to the boss.
    tmpC.subVectors(pos, center);
    const len = tmpC.length();
    if (len > 0.5 && back < 1) {
      const hit = g.physics.sphereCast(center, tmpC, K.clearRadius, GROUP.WORLD);
      if (hit && hit.distance < len) pos.copy(center).addScaledVector(tmpC, Math.max(0.6, hit.distance - 0.3) / len);
    }
    if (pos.y < 0.35) pos.y = 0.35;
    s.camActual = pos.distanceTo(center);
    // Shake (the rig's own shake is replaced here).
    const sh = feel.trauma * feel.trauma * 0.35;
    pos.x += (Math.sin(this.time * 41) + 0.5 * Math.sin(this.time * 87)) * sh;
    pos.y += (Math.sin(this.time * 53 + 1) + 0.5 * Math.sin(this.time * 71)) * sh;

    this.eye.position.copy(pos);
    this.eye.lookAt(center);
    const look = this.eye.quaternion;
    // Orientation: from the player's view into the shot, then back to the rig's.
    const q = cam.quaternion;
    if (swoop < 1) q.copy(s.fromQuat).slerp(look, swoop);
    else q.copy(look);
    if (back > 0) q.slerp(tmpQ, back);
    cam.position.copy(pos);
    const shotFov = K.fov + (s.burst ? 12 * Math.exp(-(t - tBurst) * 3) : 0);
    let fov = lerp(s.fromFov, shotFov, swoop);
    fov = lerp(fov, rigFov, back);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  };

  /**
   * The shot's camera at cinematic time `t`, before the cut-in and return blends, for a boss `H` m
   * tall floating `rise` m up: orbit angle, distance from his centre, and heights (above his feet)
   * of the camera (without the plan's lift) and of the centre it looks at.
   */
  private orbitPose(s: Shot, t: number, H: number, rise: number, out: OrbitPose): OrbitPose {
    const D = s.duration, tier = s.tier;
    const tBurst = K.burstAt * D;
    const orbit = THREE.MathUtils.degToRad(K.orbit[tier]);
    out.theta = s.orbitStart + s.orbitDir * orbit * smoother(t / (K.returnAt * D));
    const punch = t >= tBurst ? 0.32 * Math.exp(-(t - tBurst) * 3.5) : 0;
    out.dist = Math.max(3.4, H * K.cameraDistance) * (lerp(1.18, 0.88, smooth(0, tBurst, t)) + punch + (tier === 2 ? 0.25 : 0));
    out.y = H * 0.38 + rise * 0.55;
    out.centerY = H * 0.55 + rise;
    return out;
  }

  /**
   * Before the shot: pick the orbit with the most clearance, so the camera never has to pull in
   * close to the boss in a cluttered arena (stalls, cubicles, cars, rocks). Start angles all round
   * him and both directions are tried: at each beat (the charge, the burst, the fall, the slam) a
   * sphere is swept from his centre to where the camera will be, and the candidate whose worst beat
   * is clearest wins; ties go to no lift and the start nearest the usual one (just past the
   * player's view). Only if every side is blocked is the camera lifted over the cover.
   */
  private planOrbit(s: Shot): void {
    const physics = this.game.physics;
    const base = s.w.visual.root.position;
    const D = s.duration;
    // The beats as [time, his height, how high he floats]: the old form until the burst, both
    // around it (the new one grows out of it), the new one after, landed at the slam.
    const h0 = s.height, h1 = this.nextHeight(s);
    const rise = K.rise[s.tier];
    const tB = K.burstAt * D, tS = K.slamAt * D;
    const beats: [number, number, number][] = [
      [0.3 * D, h0, rise], [tB, h0, rise], [tB, h1, rise], [tB + 0.15, h0, rise], [tB + 0.15, h1, rise],
      [(tB + tS) / 2, h1, rise], [tS, h1, 0], [Math.min(tS + 0.12, K.returnAt * D), h1, 0],
    ];
    const defStart = s.orbitStart;
    const n = Math.max(1, K.clearAngles);
    let best = { score: -1, cost: Infinity, start: defStart, dir: 1, lift: 0 };
    for (const lift of K.clearLifts) {
      for (let k = 0; k < n; k++) {
        // 0, +1, -1, +2, -2... steps away from the usual start.
        const step = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2);
        const start = defStart + (step * Math.PI * 2) / n;
        for (const dir of [1, -1]) {
          s.orbitStart = start;
          s.orbitDir = dir;
          let score = 1;
          for (const [t, H, r] of beats) {
            const o = this.orbitPose(s, t, H, r, orbitPose);
            tmpA.set(base.x, base.y + o.centerY, base.z);
            tmpC.set(Math.sin(o.theta) * o.dist, o.y + lift - o.centerY, Math.cos(o.theta) * o.dist);
            const len = tmpC.length();
            const hit = physics.sphereCast(tmpA, tmpC, K.clearRadius, GROUP.WORLD);
            if (hit && hit.distance < len) score = Math.min(score, clamp((hit.distance - K.clearRadius) / len, 0, 1));
            if (score <= best.score - 0.02) break;
          }
          // Clear is clear (within 2%): then the lowest, least-turned, forward orbit.
          const cost = lift * 4 + Math.abs(step) * (Math.PI * 2 / n) + (dir < 0 ? 0.15 : 0);
          const better = score > best.score + 0.02 || (score >= best.score - 0.02 && cost < best.cost);
          if (better) best = { score, cost, start, dir, lift };
        }
      }
      if (best.score >= 0.98) break;
    }
    s.orbitStart = best.start;
    s.orbitDir = best.dir;
    s.lift = best.lift;
  }

  /** Height (m) of the form the boss is turning into (BossStages.applyLook: its model, or the grown placeholder). */
  private nextHeight(s: Shot): number {
    const key = s.boss.stages[s.stage]?.model;
    if (key && this.game.assets.modelVariant(key) !== 'missing') return MODELS[key].fitHeight ?? CONFIG.wizard.height;
    const prev = Math.max(0, s.stage - 1);
    return s.height * (C.placeholderScale[s.stage] / C.placeholderScale[prev]);
  }

  // ------------------------------------------------------------------ helpers

  /** Start a shockwave ring at `at` (floor) growing to `radius` m over `duration` s, `width` m thick. */
  private wave(at: THREE.Vector3, color: number, radius: number, duration: number, width: number): void {
    const w = this.waves.find((x) => !x.mesh.visible) ?? this.waves[0];
    w.t = 0;
    w.duration = duration;
    w.radius = radius;
    w.mesh.position.set(at.x, 0.06, at.z);
    // Floor-level light right under the camera's gaze: kept low (bloom spreads it over the boss), lower still in a bright arena.
    w.mesh.material.uniforms.uColor.value.setHex(color).multiplyScalar(K.waveGlow * (this.shot?.light ?? 1));
    w.mesh.material.uniforms.uWidth.value = width;
    w.mesh.visible = true;
  }

  private updateWaves(dt: number): void {
    for (const w of this.waves) {
      if (!w.mesh.visible) continue;
      w.t += dt;
      const p = w.t / w.duration;
      if (p >= 1) {
        w.mesh.visible = false;
        continue;
      }
      const r = Math.max(0.2, w.radius * (1 - (1 - p) * (1 - p)));
      w.mesh.scale.set(r, 1, r);
      w.mesh.material.uniforms.uRadius.value = r;
      w.mesh.material.uniforms.uOpacity.value = 1 - p * p;
    }
  }

  private skipPressed(): boolean {
    const inp = this.game.input;
    return inp.wasPressed(K.skipKeys.filter((k) => !CONFIG.controls.pause.includes(k))) || inp.wasMousePressed(0) || inp.pad.wasPressed(['a']);
  }

  /** Glow shells over every opaque mesh of the boss's current look (not the shield, ring or aura). */
  private attachShells(mat: THREE.ShaderMaterial): void {
    const s = this.shot;
    if (s) this.shellsOn(s.w.visual.root, mat, this.shells);
  }

  /** Glow shells in `mat` over the opaque meshes under `root`, added to `out`. */
  private shellsOn(root: THREE.Object3D, mat: THREE.ShaderMaterial, out: THREE.Mesh[]): void {
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.userData.cineShell) return;
      const mm = m.material as THREE.Material;
      if (!mm || Array.isArray(mm) || mm.transparent || (mm as THREE.ShaderMaterial).isShaderMaterial || !m.visible) return;
      if (!m.geometry.attributes.normal) return;
      meshes.push(m);
    });
    for (const m of meshes) {
      // A rigged mesh gets a skinned shell bound to the same skeleton (it follows the pose).
      const sk = m as THREE.SkinnedMesh;
      let shell: THREE.Mesh;
      if (sk.isSkinnedMesh) {
        const sh = new THREE.SkinnedMesh(sk.geometry, mat);
        sh.bind(sk.skeleton, sk.bindMatrix);
        sh.bindMode = sk.bindMode;
        shell = sh;
      } else {
        shell = new THREE.Mesh(m.geometry, mat);
      }
      shell.userData.cineShell = true;
      shell.renderOrder = 13;
      shell.frustumCulled = false;
      m.add(shell);
      out.push(shell);
    }
  }

  private detachShells(): void {
    for (const sh of this.shells) sh.removeFromParent();
    this.shells.length = 0;
  }

  /** Sky wash and fog tint toward the boss palette (0 = none). */
  private tintWorld(s: Shot, k: number): void {
    const fog = this.game.renderer.scene.fog as THREE.Fog | null;
    if (fog && this.fogSaved) fog.color.copy(this.fogBase).lerp(tmpColor.setHex(s.boss.palette.spell).multiplyScalar(0.55), sat(k) * 0.8);
    this.dome.visible = k > 0.005;
    this.dome.material.uniforms.uOpacity.value = Math.min(0.6, 0.7 * k);
    this.dome.position.copy(this.game.renderer.camera.position);
  }

  /** Fade what's left of the light show during the resume count. */
  private fadeWorld(s: Shot, k: number): void {
    this.tintWorld(s, k);
    this.game.renderer.bloomBoost = 0;
  }

  /** The play phase is over: the boss on the ground, at rest, the chrome off. */
  private endPose(s: Shot): void {
    const root = s.w.visual.root;
    root.rotation.x = root.rotation.z = 0;
    this.detachShells();
    this.vortex.visible = false;
    this.barTop.style.transform = this.barBottom.style.transform = 'scaleY(0)';
    this.card.style.opacity = '0';
    this.skipHint.style.opacity = '0';
    this.crackFade = 1.5;
    this.count.style.opacity = '1';
  }

  /** The shot is over: hand the fight back (or play the next one). */
  private finish(s: Shot): void {
    const g = this.game;
    this.endPose(s);
    this.restoreWorld();
    this.count.textContent = '';
    this.shot = null;
    g.director = null;
    events.emit('bossCinematic', { wizard: s.w, boss: s.boss, stage: s.stage, beat: 'end', enraged: s.enraged });
    const next = this.queue.shift();
    if (next && next.stages.transforming) {
      this.begin(next.stages, next.stage, next.enraged);
      return;
    }
    g.cinematicScale = 1;
    g.player.intent.clear();
    this.setChrome(false);
    this.overlay.className = 'cine';
  }

  private restoreWorld(): void {
    const g = this.game;
    const fog = g.renderer.scene.fog as THREE.Fog | null;
    if (fog && this.fogSaved) fog.color.copy(this.fogBase);
    this.fogSaved = false;
    this.dome.visible = false;
    this.vortex.visible = false;
    g.renderer.bloomBoost = 0;
    if (!this.shot) {
      g.cinematicScale = 1;
      g.director = null;
      this.setChrome(false);
      this.overlay.className = 'cine';
    }
  }

  /** Hide the combat HUD (crosshair, spell bar, tags, popups) while the cinematic runs. */
  private setChrome(cinematic: boolean): void {
    this.game.ui.classList.toggle('cinematic', cinematic);
  }
}
