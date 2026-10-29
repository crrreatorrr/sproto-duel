import * as THREE from 'three';
import { CONFIG } from '../config';
import type { AssetLoader, ModelTemplate } from '../assets/AssetLoader';
import { OBSTACLE_MODELS, THEME_ASSETS } from '../assets/manifest';
import { ParticleSystem } from '../fx/ParticleSystem';
import { RegenTexture, drawArenaFloor, drawGround, drawStone, glowTexture } from '../fx/textures';
import type { Physics } from '../physics/Physics';
import { Debris } from './Debris';
import type { FireRing } from './FireRing';
import { layoutHazards, layoutSoftZones, layoutSpots, type ArenaLayout, type Hazard, type MoverDef, type SoftZone } from './layouts';
import { CANDLE_REF_HEIGHT } from './obstacleKit';
import { Pillar, type ObstacleKind } from './Pillar';
import { ThemeKit, boxFitScale, pillarFitScale } from './themeKit';
import { THEMES, isThemeId, type ArenaTheme, type ArenaThemeId, type SkyDef } from './themes';
import { events } from '../core/events';
import type { Wizard } from '../wizard/Wizard';

const A = CONFIG.arena;
const R = CONFIG.render;
/** Visible wall height; the collider matches it so spells never burst on invisible geometry. */
const WALL_HEIGHT = 1.4;
/** Key light sits this many times further out than the theme's `sun.position` (room for the shadow box). */
const SUN_DISTANCE = 1.5;
/** Stone tiles around the wall (about one every 5.6 m). */
const WALL_REPEAT = Math.round(A.wallRadius * 1.11);
/** Copies of a theme's prop GLB around the outside of the wall. */
const PROP_COPIES = 8;

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }
`;
const SKY_FRAG = /* glsl */ `
  uniform vec3 uTop, uMid, uHorizon, uBelow;
  uniform float uBelowMix, uStars, uStarBright, uStarsBelow;
  uniform vec3 uMoonDir, uMoonColor, uMoonGlow;
  uniform vec2 uMoonSize;
  uniform float uMoonGlowPow;
  uniform vec3 uAuroraA, uAuroraB, uCloudA, uCloudB, uSilColor;
  uniform float uAurora, uClouds, uTime;
  uniform vec4 uSil;
  uniform vec4 uSmog;
  uniform float uSmogHeight;
  uniform vec4 uCity;
  uniform vec3 uCityColor, uCityWindow;
  uniform float uDowntown;
  varying vec3 vDir;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  float noise3(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float fbm(vec3 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise3(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
    return v;
  }
  void main() {
    float h = vDir.y;
    vec3 c = mix(uHorizon, uMid, smoothstep(-0.05, 0.18, h));
    c = mix(c, uTop, smoothstep(0.18, 0.7, h));
    c = mix(c, uBelow, uBelowMix * (1.0 - smoothstep(-0.3, 0.0, h)));
    float az = atan(vDir.z, vDir.x);
    if (uClouds > 0.0) {
      // Drifting cloud / nebula layer: dark body plus glowing, lit edges.
      vec3 p = vDir * 2.6 + vec3(uTime * 0.012, 0.0, uTime * 0.005);
      float n = fbm(p);
      float d = fbm(p * 2.3 + n * 1.6);
      float cover = smoothstep(0.4, 0.72, n) * mix(smoothstep(-0.03, 0.1, h), 1.0, uBelowMix);
      c = mix(c, uCloudA * (0.55 + 0.9 * d), cover * uClouds);
      c += uCloudB * pow(d, 2.5) * 2.2 * cover * uClouds * (1.0 - 0.5 * smoothstep(0.1, 0.7, h));
    }
    if (uAurora > 0.0) {
      // Curtains: a wavy lower edge, rays rising from it, fading with height.
      float edge = 0.17 + 0.07 * sin(az * 2.0 + uTime * 0.05) + 0.04 * sin(az * 5.0 - uTime * 0.09);
      float above = h - edge;
      float curtain = smoothstep(-0.015, 0.01, above) * exp(-max(above, 0.0) * 5.0);
      float rays = 0.55 + 0.45 * sin(az * 70.0 + sin(az * 6.0 + uTime * 0.25) * 4.0);
      float side = smoothstep(-0.4, 0.5, sin(az + 0.8));
      c += mix(uAuroraA, uAuroraB, smoothstep(0.0, 0.22, above)) * curtain * rays * side * uAurora * 0.55;
    }
    // Stars.
    vec3 cell = floor(vDir * 220.0);
    float s = hash(cell);
    float star = step(uStars, s) * mix(smoothstep(0.05, 0.3, h), 1.0, uStarsBelow);
    c += vec3(star) * (0.25 + 0.35 * hash(cell + 1.0)) * uStarBright;
    // Moon (or sun).
    float m = dot(vDir, uMoonDir);
    c += uMoonColor * smoothstep(uMoonSize.x, uMoonSize.y, m);
    c += uMoonGlow * pow(max(m, 0.0), uMoonGlowPow);
    if (uSmog.w > 0.0) {
      // Hazy band hugging the horizon (it dims a low sun too).
      float band = (1.0 - smoothstep(0.0, uSmogHeight, h)) * smoothstep(-0.08, 0.0, h);
      c = mix(c, uSmog.rgb, band * uSmog.w);
    }
    if (uCity.y > 0.0) {
      // Skyline: a hazy far layer and a dark near layer of blocky buildings with lit windows,
      // taller around the downtown azimuth, then palm silhouettes in front.
      float t = az / 6.2831853 + 0.5;
      float dd = abs(fract(t - uDowntown + 0.5) - 0.5);
      float downtown = exp(-dd * dd * 700.0);
      for (int L = 0; L < 2; L++) {
        float fl = float(L);
        float n = t * uCity.z * (1.0 - 0.3 * fl) + fl * 17.3;
        float k = floor(n);
        float hk = hash(vec3(k, 1.7 + fl, 3.3));
        float top = uCity.x + uCity.y * (0.12 + 0.45 * hk * hk + 1.7 * downtown * hk) * (0.5 + 0.5 * fl);
        float fx = fract(n);
        top = mix(uCity.x, top, step(0.05, fx) * step(fx, 0.97));
        float inside = 1.0 - smoothstep(top - 0.0012, top + 0.0012, h);
        vec3 bc = mix(mix(uCityColor, uSmog.rgb, 0.45), uCityColor, fl);
        vec2 cell = vec2(fract(n * 5.0), fract(h * 150.0));
        float win = step(0.3, cell.x) * step(cell.x, 0.72) * step(0.35, cell.y) * step(cell.y, 0.8);
        float lit = step(0.72, hash(vec3(floor(n * 5.0), floor(h * 150.0), k + fl * 31.0)));
        bc += uCityWindow * win * lit * step(h, top - 0.003) * (0.35 + 0.65 * fl);
        c = mix(c, bc, inside);
      }
      for (int i = 0; i < 40; i++) {
        float fi = float(i);
        if (fi >= uCity.w) break;
        float pt = hash(vec3(fi, 9.1, 2.3));
        float crownY = uCity.x + 0.05 + 0.06 * hash(vec3(fi, 4.4, 8.8));
        float dx = (fract(t - pt + 0.5) - 0.5) * 6.2831853;
        float lean = (hash(vec3(fi, 1.3, 7.7)) - 0.5) * 0.12;
        float trunk = step(abs(dx - (h - uCity.x) * lean), 0.0011) * step(h, crownY);
        vec2 q = vec2(dx - (crownY - uCity.x) * lean, h - crownY);
        float fr = pow(abs(cos(atan(q.y, q.x) * 3.5)), 2.0);
        float crown = step(length(q), 0.02 * (0.2 + 0.8 * fr)) * step(-0.014, q.y);
        c = mix(c, uCityColor * 0.5, max(trunk, crown));
      }
    }
    if (uSil.y > 0.0) {
      // Horizon silhouette: integer harmonics of the azimuth, so it wraps without a seam.
      float t = az / 6.2831853 + 0.5;
      float f = floor(uSil.z);
      float hills = 0.5 + 0.25 * sin(t * 6.2831853 * f) + 0.15 * sin(t * 6.2831853 * f * 2.0 + 1.7) + 0.1 * sin(t * 6.2831853 * f * 3.0 + 4.1);
      float k = floor(t * f * 4.0);
      float spikes = (1.0 - abs(fract(t * f * 4.0) - 0.5) * 2.0) * (0.55 + 0.45 * hash(vec3(k, 3.0, 7.0)));
      float shape = mix(hills, hills * 0.45 + spikes * 0.75, uSil.w);
      float top = uSil.x + uSil.y * shape;
      c = mix(c, uSilColor, 1.0 - smoothstep(top - 0.003, top + 0.003, h));
    }
    gl_FragColor = vec4(c, 1.0);
  }
`;

/** Optional asset files for one theme (null = not on disk, use the procedural version). */
interface ThemeFiles {
  floor: THREE.Texture | null;
  sky: THREE.Texture | null;
  stone: THREE.Texture | null;
  wallStone: THREE.Texture | null;
  pillar: ModelTemplate | null;
  prop: ModelTemplate | null;
  /** Optional generated obstacle models (OBSTACLE_MODELS) for the kinds in the theme's layout. */
  obstacles: Partial<Record<ObstacleKind, ModelTemplate>>;
}

/** Everything one theme needs, built on first use and kept (GPU copies are freed while inactive). */
interface ThemeResources {
  theme: ArenaTheme;
  floor: RegenTexture;
  stone: RegenTexture;
  wall: RegenTexture;
  ground: RegenTexture | null;
  kit: ThemeKit;
  debris: THREE.Material;
  files: ThemeFiles;
  loading: Promise<void> | null;
  propCopies: THREE.Group | null;
}

/** A sliding obstacle and where it is on its rail. */
interface MoverState {
  pillar: Pillar;
  rail: MoverDef;
  /** Position along the rail, -1..1. */
  t: number;
  dir: 1 | -1;
}

/** A drifting vape cloud (soft cover) and its current centre. */
interface CloudState extends SoftZone {
  cx: number;
  cz: number;
}

/**
 * A smoke screen a wizard dropped (the Vape Cloud reward spell): soft cover like the layout's clouds
 * (Arena.obscured hides wizards in or behind it from the AI) for `life` seconds, standing still.
 */
export interface Smoke {
  owner: Wizard;
  x: number;
  z: number;
  radius: number;
  height: number;
  /** Seconds since it was dropped, and how long it lasts. */
  age: number;
  life: number;
}

/** Most dropped smoke screens at once (the oldest clears early). */
const MAX_SMOKES = 4;
/** Billowing puffs drawn per smoke screen. */
const SMOKE_PUFFS = 11;

const BILLBOARD_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vNear;
  void main() {
    vUv = uv;
    vColor = instanceColor;
    vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float s = length(instanceMatrix[0].xyz);
    center.xy += position.xy * s;
    // Thin out puffs right in front of the camera (inside a cloud it stays hazy, not opaque).
    vNear = mix(0.35, 1.0, smoothstep(0.3, 3.5, -center.z));
    gl_Position = projectionMatrix * center;
  }
`;
const BILLBOARD_FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vNear;
  void main() {
    vec2 p = vUv - 0.5;
    float d = length(p) * 2.0;
    float a = (1.0 - smoothstep(0.15, 1.0, d)) * uOpacity * vNear;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;
/** Puffs drawn per vape cloud. */
const PUFFS = 9;

const tmpMood = new THREE.Color();

/** Does segment a -> b pass through (or start or end inside) the upright cloud cylinder at (cx, cz)? */
function segmentInCloud(a: THREE.Vector3, b: THREE.Vector3, cx: number, cz: number, radius: number, height: number): boolean {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 1e-6 ? THREE.MathUtils.clamp(((cx - a.x) * dx + (cz - a.z) * dz) / len2, 0, 1) : 0;
  const px = a.x + dx * t, pz = a.z + dz * t;
  const y = a.y + (b.y - a.y) * t;
  return Math.hypot(px - cx, pz - cz) < radius && y < height;
}

export class Arena {
  readonly debris: Debris;
  /** Cover layout of the current theme ('rings' of pillars, the office 'cubicles', or a boss arena's). */
  layout: ArenaLayout = 'rings';
  /** Obstacles per layout, built on first use; only the current layout's are visible and collide. */
  private readonly layouts = new Map<ArenaLayout, Pillar[]>();
  /** Sliding obstacles per layout. */
  private readonly movers = new Map<ArenaLayout, MoverState[]>();
  /** Soft cover (vape clouds) and floor hazards (lava) of the current layout. */
  private clouds: CloudState[] = [];
  /** Dropped smoke screens (Vape Cloud), live ones only. */
  private readonly smokeList: Smoke[] = [];
  private hazardList: Hazard[] = [];
  /**
   * Floor an arena shift (src/arena/ArenaShifts.ts) made dangerous: its pools and vents. Kept out of
   * like lava (AI steering, pickups) but they hurt by their own rules, not the fire ring's.
   */
  readonly shiftHazards: Hazard[] = [];
  /** Most the fire ring may be (an arena shift pulls it in); Match keeps fireRadius within it. */
  ringCap: number = A.fireRadius;
  /** The theme's light and fog, kept so a mood tint (setMood) can be blended on and taken off. */
  private readonly moodBase = { fog: new THREE.Color(), hemi: new THREE.Color(), hemiGround: new THREE.Color(), sun: new THREE.Color(), bounce: new THREE.Color() };
  private cloudMesh: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
  private readonly cloudColor = new THREE.Color();
  /** Glass shards (made when a layout with glass is first used). */
  private glassDebris: Debris | null = null;
  /** Seconds since the round (or layout) started: drives clouds. */
  private layoutTime = 0;
  private lavaAcc = 0;
  private readonly puffDummy = new THREE.Object3D();
  /** The original chunk shape (themes may swap in flat partition panels). */
  private readonly chunkGeometry: THREE.BufferGeometry;
  private panelGeometry: THREE.BufferGeometry | null = null;
  /** Current inner radius of the fire ring (shrinks during sudden death). */
  fireRadius: number = A.fireRadius;
  /** Active environment theme. */
  theme: ArenaThemeId = 'moonlit';
  /** Bumped whenever the environment's look is (re)applied, its asset files included (Game.warmUp follows it). */
  version = 0;
  /**
   * Dev hook: `?theme=<id>` in the URL. While set, requests for the default 'moonlit' environment
   * (menu, Quick Duel) show this theme instead; boss themes are unaffected.
   */
  devTheme: ArenaThemeId | null = null;
  private time = 0;
  private visualTime = 0;
  private readonly brazierFlames: THREE.Sprite[] = [];
  private readonly bowlMat = new THREE.MeshStandardMaterial({ color: 0x3a3030, roughness: 0.6, metalness: 0.5 });
  private readonly background = new THREE.Color(0x07060f);
  private readonly moodBackground = new THREE.Color(0x07060f);
  private readonly fog = new THREE.Fog(0x140c22, R.fogNear, R.fogFar);
  private readonly sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly hemi = new THREE.HemisphereLight(0x6a78c8, 0x2a1a24, 1.1);
  private readonly sun = new THREE.DirectionalLight(0xc4d2ff, 2.2);
  private readonly bounce = new THREE.DirectionalLight(0xff7a3a, 0.35);
  private readonly floorMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.02 });
  private readonly groundMat = new THREE.MeshStandardMaterial({ color: 0x1a1420, roughness: 1 });
  private readonly ground: THREE.Mesh;
  private readonly wallMat = new THREE.MeshStandardMaterial({ roughness: 0.95, color: 0x8a8296, side: THREE.DoubleSide });
  private readonly resources = new Map<ArenaThemeId, ThemeResources>();
  private props: THREE.Object3D | null = null;
  private terrain: THREE.Object3D | null = null;
  private fire: FireRing | null = null;
  /** Ambient weather: soft (snow, sand, ash) and glowing (fireflies, embers, motes) particles. */
  private readonly ambientSoft = new ParticleSystem(800, false);
  private readonly ambientGlow = new ParticleSystem(500, true);
  private ambientAcc = 0;
  private readonly tmpColor = new THREE.Color();
  private readonly tmpColor2 = new THREE.Color();

  constructor(private readonly scene: THREE.Scene, private readonly physics: Physics, private readonly assets: AssetLoader) {
    scene.background = this.background;
    scene.fog = this.fog;

    this.sky = this.buildSky();
    this.buildLights();
    this.ground = this.buildFloor();
    this.buildWall();
    this.buildBraziers();
    this.ambientSoft.points.visible = this.ambientGlow.points.visible = false;
    scene.add(this.ambientSoft.points, this.ambientGlow.points);

    physics.addFloor(A.floorRadius + 10);
    physics.addRingWall(A.wallRadius, WALL_HEIGHT, 56);

    this.debris = this.makeDebris(scene, assets);
    this.chunkGeometry = this.debris.geometry;
    this.obstaclesFor('rings');

    const fromUrl = new URLSearchParams(location.search).get('theme');
    if (isThemeId(fromUrl)) this.devTheme = fromUrl;
    void this.applyTheme('moonlit');
  }

  /**
   * Switch the whole environment: sky, fog, lights, floor, wall, pillars, props, terrain, debris,
   * braziers, fire ring colours and ambient particles.
   *
   * Synchronous: when it returns, the theme is fully visible using whatever is already loaded, with
   * procedural stand-ins for missing files. The returned promise resolves once the theme's optional
   * asset files (floor/sky/stone textures, pillar/prop GLBs) have been fetched and swapped in; it
   * never rejects. Awaiting it is optional (e.g. behind a boss intro card to avoid pop-in).
   */
  applyTheme(id: ArenaThemeId): Promise<void> {
    if (id === 'moonlit' && this.devTheme) id = this.devTheme;
    const prev = this.resources.get(this.theme);
    const res = this.resourcesFor(id);
    this.theme = id;
    this.peekFiles(res);
    this.show(res);
    if (prev && prev !== res) this.release(prev);
    this.ambientSoft.clear();
    this.ambientGlow.clear();
    return this.loadFiles(res);
  }

  /** Destructible cover of the current layout (pillars, or cubicles and office furniture). */
  get pillars(): Pillar[] {
    return this.obstaclesFor(this.layout);
  }

  /** A layout's obstacles, created (inactive unless it is the current layout) on first use. */
  obstaclesFor(layout: ArenaLayout): Pillar[] {
    let list = this.layouts.get(layout);
    if (!list) {
      const movers: MoverState[] = [];
      list = layoutSpots(layout).map((s) => {
        const debris = s.shape.seeThrough ? this.shards() : this.debris;
        const p = new Pillar(this.scene, this.physics, s.x, s.z, debris, s.shape, !!s.mover);
        if (s.mover) movers.push({ pillar: p, rail: s.mover, t: s.mover.start, dir: s.mover.dir });
        return p;
      });
      for (const p of list) p.setActive(layout === this.layout);
      this.layouts.set(layout, list);
      this.movers.set(layout, movers);
    }
    return list;
  }

  /** Sliding obstacles of the current layout (QA and tools). */
  get movingCover(): readonly Pillar[] {
    this.obstaclesFor(this.layout);
    return (this.movers.get(this.layout) ?? []).map((m) => m.pillar);
  }

  /** Vape clouds of the current layout: centre and size right now. */
  get softZones(): readonly { x: number; z: number; radius: number; height: number }[] {
    return this.clouds.map((c) => ({ x: c.cx, z: c.cz, radius: c.radius, height: c.height }));
  }

  /** Smoke screens wizards have dropped (Vape Cloud), still standing. */
  get smokes(): readonly Smoke[] {
    return this.smokeList;
  }

  /**
   * Drop a smoke screen (the Vape Cloud spell) centred at (x, z): it hides like a layout cloud for
   * `life` s. Past MAX_SMOKES the oldest clears.
   */
  addSmoke(owner: Wizard, x: number, z: number, radius: number, height: number, life: number): Smoke {
    while (this.smokeList.length >= MAX_SMOKES) this.expireSmoke(0);
    const smoke: Smoke = { owner, x, z, radius, height, age: 0, life };
    this.smokeList.push(smoke);
    this.syncCloudMesh();
    return smoke;
  }

  /** The smoke screen dropped by `owner` that (x, z) stands in, if any. */
  smokeAt(x: number, z: number, owner?: Wizard): Smoke | null {
    for (const s of this.smokeList) if ((!owner || s.owner === owner) && Math.hypot(x - s.x, z - s.z) < s.radius) return s;
    return null;
  }

  private expireSmoke(i: number): void {
    const [s] = this.smokeList.splice(i, 1);
    this.syncCloudMesh();
    events.emit('rewardEnd', { wizard: s.owner, spell: 'vape' });
  }

  /** The puff mesh shows while the layout has clouds or someone's smoke is up. */
  private syncCloudMesh(): void {
    if (this.clouds.length || this.smokeList.length) this.cloudPuffs().visible = true;
    else if (this.cloudMesh) this.cloudMesh.visible = false;
  }

  /** Lava pools of the current layout. */
  get hazards(): readonly Hazard[] {
    return this.hazardList;
  }

  /** The hazard (lava pool) at (x, z), counting `margin` metres around it, or null. */
  hazardAt(x: number, z: number, margin = 0): Hazard | null {
    for (const h of this.hazardList) if (Math.hypot(x - h.x, z - h.z) < h.radius + margin) return h;
    for (const h of this.shiftHazards) if (Math.hypot(x - h.x, z - h.z) < h.radius + margin) return h;
    return null;
  }

  /**
   * Turn the theme's light and fog toward `color` by `k` (0 = the theme as authored). Arena shifts
   * deepen it each boss stage; a new theme or round starts clean.
   */
  setMood(color: THREE.ColorRepresentation, k: number): void {
    const b = this.moodBase;
    tmpMood.set(color);
    this.fog.color.copy(b.fog).lerp(tmpMood, k * 0.6);
    this.hemi.color.copy(b.hemi).lerp(tmpMood, k);
    this.hemi.groundColor.copy(b.hemiGround).lerp(tmpMood, k * 0.7);
    this.sun.color.copy(b.sun).lerp(tmpMood, k * 0.8);
    this.bounce.color.copy(b.bounce).lerp(tmpMood, k);
    this.background.copy(this.moodBackground).lerp(tmpMood.multiplyScalar(0.12), k * 0.5);
  }

  /**
   * True if the segment a -> b passes through soft cover (a vape cloud), or starts or ends inside
   * one. Clouds stop no spell; they only hide wizards from the AI.
   */
  obscured(a: THREE.Vector3, b: THREE.Vector3): boolean {
    for (const c of this.clouds) if (segmentInCloud(a, b, c.cx, c.cz, c.radius, c.height)) return true;
    // Dropped smoke screens (Vape Cloud) hide the same way.
    for (const s of this.smokeList) if (segmentInCloud(a, b, s.x, s.z, s.radius, s.height)) return true;
    return false;
  }

  /** Add a push away from nearby hazards to a wanted XZ move (the AI steers around lava). */
  avoidHazards(pos: THREE.Vector3, move: THREE.Vector3, margin: number = A.lavaMargin): void {
    for (const h of this.hazardList.length && this.shiftHazards.length ? [...this.hazardList, ...this.shiftHazards] : this.shiftHazards.length ? this.shiftHazards : this.hazardList) {
      const dx = pos.x - h.x, dz = pos.z - h.z;
      const d = Math.hypot(dx, dz) || 1e-3;
      const reach = h.radius + margin + CONFIG.wizard.radius;
      if (d > reach + 1.5) continue;
      const push = THREE.MathUtils.clamp((reach + 1.5 - d) / 1.5, 0, 2);
      move.x += (dx / d) * push * 1.6;
      move.z += (dz / d) * push * 1.6;
    }
  }

  /** Golden tickets stay out of lava, vape clouds and the rails of sliding cover. */
  excludesPickup(x: number, z: number): boolean {
    const m = A.pickupZoneMargin;
    if (this.hazardAt(x, z, m)) return true;
    for (const c of this.clouds) if (Math.hypot(x - c.cx, z - c.cz) < c.radius + m) return true;
    for (const mv of this.movers.get(this.layout) ?? []) {
      const r = mv.rail, s = mv.pillar.shape;
      const along = r.axis === 'x' ? Math.abs(x - r.cx) : Math.abs(z - r.cz);
      const across = r.axis === 'x' ? Math.abs(z - r.cz) : Math.abs(x - r.cx);
      if (along < r.half + s.halfX + m && across < Math.max(s.halfX, s.halfZ) + m) return true;
    }
    return false;
  }

  /** Glass shards: thin pale panes in their own pool (only drawn where glass exists). */
  private shards(): Debris {
    if (!this.glassDebris) {
      const mat = new THREE.MeshStandardMaterial({ color: 0xd8f6ee, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.7, emissive: 0x204a3a });
      this.glassDebris = new Debris(this.scene, 90, mat, new THREE.BoxGeometry(0.34, 0.24, 0.015));
      this.glassDebris.visible = false;
    }
    return this.glassDebris;
  }

  /** Connect the fire ring (created by Game after the effects) so applyTheme recolours it too. */
  attach(fire: FireRing): void {
    this.fire = fire;
    fire.setTheme(THEMES[this.theme].fire);
  }

  /** Re-check a theme's asset files on disk (QA and tools; files added at runtime). */
  invalidateThemeAssets(id: ArenaThemeId): Promise<void> {
    const res = this.resources.get(id);
    if (!res) return Promise.resolve();
    res.loading = null;
    res.propCopies = null;
    res.files.pillar = res.files.prop = null;
    res.files.obstacles = {};
    this.peekFiles(res);
    if (this.theme === id) this.show(res);
    return this.loadFiles(res);
  }

  /** Plain snapshot of everything a theme controls (QA and tools). */
  describe(): Record<string, unknown> {
    const u = this.sky.material.uniforms;
    const v3 = (k: string) => (u[k].value as THREE.Vector3).toArray().map((n) => +n.toFixed(4));
    const bg = this.scene.background;
    return {
      theme: this.theme,
      background: bg instanceof THREE.Color ? bg.getHexString() : (bg as THREE.Texture | null)?.uuid ?? null,
      skyVisible: this.sky.visible,
      skyTop: v3('uTop'),
      skyHorizon: v3('uHorizon'),
      fog: [this.fog.color.getHexString(), this.fog.near, this.fog.far],
      hemi: [this.hemi.color.getHexString(), this.hemi.groundColor.getHexString(), this.hemi.intensity],
      sun: [this.sun.color.getHexString(), this.sun.intensity, this.sun.position.toArray()],
      bounce: [this.bounce.color.getHexString(), this.bounce.intensity],
      floor: [this.floorMat.map?.uuid, this.floorMat.emissive.getHexString(), this.floorMat.roughness],
      wall: [this.wallMat.map?.uuid, this.wallMat.color.getHexString()],
      ground: this.ground.visible ? [this.groundMat.color.getHexString(), this.groundMat.map?.uuid ?? null] : null,
      props: this.props?.name ?? null,
      terrain: this.terrain?.name ?? null,
      layout: [this.layout, this.pillars.length],
      pillar: this.pillars[0].describe().key,
      debris: this.debris.material.uuid,
      brazier: [this.bowlMat.color.getHexString(), this.brazierFlames[0].material.color.getHexString()],
      fire: this.fire?.describe() ?? null,
      ambient: [this.ambientSoft.points.visible, this.ambientGlow.points.visible],
    };
  }

  setPointScale(scale: number): void {
    this.ambientSoft.setPointScale(scale);
    this.ambientGlow.setPointScale(scale);
  }

  // ------------------------------------------------------------------ theme resources

  private resourcesFor(id: ArenaThemeId): ThemeResources {
    const cached = this.resources.get(id);
    if (cached) {
      cached.floor.acquire();
      cached.stone.acquire();
      cached.wall.acquire();
      cached.ground?.acquire();
      cached.kit.acquire();
      return cached;
    }
    const t = THEMES[id];
    const stone = new RegenTexture(() => drawStone(t.stone), (tex) => (tex.wrapS = tex.wrapT = THREE.RepeatWrapping));
    const ground = t.ground?.texture;
    const res: ThemeResources = {
      theme: t,
      floor: new RegenTexture(() => drawArenaFloor(t.floor.style), (tex) => (tex.anisotropy = 4)),
      stone,
      wall: new RegenTexture(() => drawStone(t.stone), (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(WALL_REPEAT, 1);
      }),
      ground: ground
        ? new RegenTexture(() => drawGround(ground), (tex) => {
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          tex.repeat.setScalar(t.ground?.repeat ?? 30);
          tex.anisotropy = 4;
        })
        : null,
      kit: new ThemeKit(t, stone.texture),
      debris: id === 'moonlit'
        ? this.debris.defaultMaterial
        : new THREE.MeshStandardMaterial({ color: t.debris.color, emissive: new THREE.Color(t.debris.color).multiplyScalar(t.debris.emissive), roughness: 0.95, flatShading: true }),
      files: { floor: null, sky: null, stone: null, wallStone: null, pillar: null, prop: null, obstacles: {} },
      loading: null,
      propCopies: null,
    };
    this.resources.set(id, res);
    return res;
  }

  /** Free GPU memory of a theme that is no longer shown (everything re-uploads on next use). */
  private release(res: ThemeResources): void {
    res.floor.release();
    res.stone.release();
    res.wall.release();
    res.ground?.release();
    res.kit.release();
    const f = res.files;
    for (const tex of [f.floor, f.sky, f.stone, f.wallStone]) tex?.dispose();
  }

  /** Take whichever of the theme's files are already loaded (boot-time defaults, revisits). */
  private peekFiles(res: ThemeResources): void {
    const spec = THEME_ASSETS[res.theme.id];
    const a = this.assets;
    this.setFiles(res, a.peekTexture(spec.floor), a.peekTexture(spec.sky), a.peekTexture(spec.stone), a.peekModel(spec.pillar.path), a.peekModel(spec.prop.path));
    for (const kind of this.modelKinds(res)) {
      const t = a.peekModel(OBSTACLE_MODELS[kind]!.path);
      if (t) res.files.obstacles[kind] = t;
    }
  }

  /** Obstacle kinds in the theme's layout that have an optional generated model. */
  private modelKinds(res: ThemeResources): ObstacleKind[] {
    const layout = res.theme.layout ?? 'rings';
    const kinds = new Set(layoutSpots(layout).map((s) => s.shape.kind));
    return [...kinds].filter((k) => OBSTACLE_MODELS[k]);
  }

  private setFiles(
    res: ThemeResources,
    floor?: THREE.Texture | null, sky?: THREE.Texture | null, stone?: THREE.Texture | null,
    pillar?: ModelTemplate | null, prop?: ModelTemplate | null,
  ): void {
    const f = res.files;
    if (floor) f.floor = floor;
    if (sky) {
      sky.mapping = THREE.EquirectangularReflectionMapping;
      f.sky = sky;
    }
    if (stone && f.stone !== stone) {
      f.stone = stone;
      f.wallStone = stone.clone();
      f.wallStone.repeat.set(WALL_REPEAT, 1);
      f.wallStone.needsUpdate = true;
    }
    if (pillar) f.pillar = pillar;
    if (prop && f.prop !== prop) {
      f.prop = prop;
      res.propCopies = null;
    }
  }

  /** Fetch the theme's optional files once; swap them in if the theme is still showing. */
  private loadFiles(res: ThemeResources): Promise<void> {
    if (res.loading) return res.loading;
    const spec = THEME_ASSETS[res.theme.id];
    const tex = (path: string, repeat?: [number, number]) => this.assets.loadTextureAsset({ path, color: true, repeat });
    const kinds = this.modelKinds(res);
    const job = Promise.all([
      tex(spec.floor),
      tex(spec.sky),
      tex(spec.stone, [2, 2]),
      this.assets.loadModelAsset(spec.pillar),
      this.assets.loadModelAsset(spec.prop),
      Promise.all(kinds.map((k) => this.assets.loadModelAsset(OBSTACLE_MODELS[k]!))),
    ]).then(([floor, sky, stone, pillar, prop, models]) => {
      if (res.loading !== job) return; // invalidated meanwhile
      const before = { ...res.files, obstacles: { ...res.files.obstacles } };
      this.setFiles(res, floor, sky, stone, pillar, prop);
      kinds.forEach((k, i) => {
        const t = models[i];
        if (t) res.files.obstacles[k] = t;
      });
      const changed = (Object.keys(before) as (keyof ThemeFiles)[]).some((k) => k !== 'obstacles' && before[k] !== res.files[k])
        || kinds.some((k) => before.obstacles[k] !== res.files.obstacles[k]);
      if (changed && this.theme === res.theme.id) this.show(res);
    }).catch((err) => console.warn(`[arena] theme ${res.theme.id}: asset load failed`, err));
    res.loading = job;
    return job;
  }

  // ------------------------------------------------------------------ applying a theme

  private show(res: ThemeResources): void {
    this.version++;
    const t = res.theme;
    const id = t.id;
    const files = res.files;

    // Sky, fog, lights.
    this.setSky(t.sky);
    this.background.setHex(t.background);
    this.scene.background = files.sky ?? this.background;
    this.sky.visible = !files.sky;
    this.fog.color.setHex(t.fog.color);
    this.fog.near = R.fogNear / t.fog.density;
    this.fog.far = R.fogFar / t.fog.density;
    this.hemi.color.setHex(t.hemi.sky);
    this.hemi.groundColor.setHex(t.hemi.ground);
    this.hemi.intensity = t.hemi.intensity;
    this.sun.color.setHex(t.sun.color);
    this.sun.intensity = t.sun.intensity;
    this.sun.position.fromArray(t.sun.position).multiplyScalar(SUN_DISTANCE);
    this.bounce.color.setHex(t.bounce.color);
    this.bounce.intensity = t.bounce.intensity;
    const mb = this.moodBase;
    mb.fog.copy(this.fog.color);
    mb.hemi.copy(this.hemi.color);
    mb.hemiGround.copy(this.hemi.groundColor);
    mb.sun.copy(this.sun.color);
    mb.bounce.copy(this.bounce.color);
    this.moodBackground.copy(this.background);

    // Floor: bright texels glow (lava cracks, void runes) through the emissive map.
    const floorMap = files.floor ?? res.floor.texture;
    const normal = id === 'moonlit' ? this.assets.texture('floorNormal') : null;
    const fm = this.floorMat;
    if (fm.map !== floorMap || fm.normalMap !== normal) {
      fm.map = fm.emissiveMap = floorMap;
      fm.normalMap = normal;
      fm.needsUpdate = true;
    }
    fm.emissive.setScalar(t.floor.emissive * (files.floor ? 0.5 : 1));
    fm.roughness = t.floor.roughness;
    fm.metalness = t.floor.metalness;

    // Terrain outside the wall.
    const g = t.ground;
    this.ground.visible = !!g;
    if (g) {
      const map = res.ground?.texture ?? null;
      const emissiveMap = g.emissive ? map : null;
      if (this.groundMat.map !== map || this.groundMat.emissiveMap !== emissiveMap) {
        this.groundMat.map = map;
        this.groundMat.emissiveMap = emissiveMap;
        this.groundMat.needsUpdate = true;
      }
      this.groundMat.color.setHex(g.color);
      this.groundMat.emissive.setScalar(g.emissive ?? 0);
    }

    // Wall.
    const wallMap = files.wallStone ?? res.wall.texture;
    if (this.wallMat.map !== wallMap) {
      this.wallMat.map = this.wallMat.emissiveMap = wallMap;
      this.wallMat.needsUpdate = true;
    }
    this.wallMat.color.setHex(t.wall.color);
    this.wallMat.emissive.setScalar(t.wall.emissive);
    res.kit.setStone(files.stone ?? res.stone.texture);

    // Props and terrain dressing (a prop GLB replaces the placeholder props). Indoors, a room
    // panorama (sky file) replaces the procedural room walls; the ceiling stays.
    const props = files.prop ? this.propCopies(res, files.prop) : res.kit.props;
    this.swap('props', props);
    this.swap('terrain', res.kit.terrain);
    res.kit.setRoomWalls(!files.sky);

    // Cover layout: switching hides the old obstacles (no collision), resets the new ones and
    // brings in the layout's soft cover (vape clouds) and hazards (lava).
    const layout = t.layout ?? 'rings';
    if (layout !== this.layout) {
      for (const p of this.pillars) p.setActive(false);
      this.layout = layout;
      for (const p of this.pillars) p.setActive(true);
      this.clouds = layoutSoftZones(layout).map((z) => ({ ...z, cx: z.x, cz: z.z }));
      this.hazardList = layoutHazards(layout);
      this.fire?.setHazards(this.hazardList);
      this.reset();
    }
    this.syncCloudMesh();
    if (this.glassDebris) this.glassDebris.visible = this.pillars.some((p) => p.shape.seeThrough);

    // Cover looks: the theme's pillar GLB replaces placeholder columns and cubicles, an obstacle GLB
    // (OBSTACLE_MODELS) replaces its kind; a replaced placeholder visual is freed.
    this.pillars.forEach((p, i) => {
      const kind = p.shape.kind;
      const model = kind === 'pillar' || kind === 'cubicle' ? files.pillar : files.obstacles[kind] ?? null;
      const key = model ? `${id}:glb:${model.root.uuid}` : id;
      p.setThemeVisual(id, key, () => (model ? this.glbPillar(res, model, p, i) : this.placeholder(res, p, i)));
    });
    this.debris.setMaterial(res.debris);
    this.debris.setGeometry(t.debris.shape === 'panel' ? this.panels() : this.chunkGeometry);

    // Braziers and the fire ring.
    this.bowlMat.color.setHex(t.brazier.bowl);
    for (const f of this.brazierFlames) f.material.color.fromArray(t.brazier.flame).multiplyScalar(2.2);
    this.fire?.setTheme(t.fire);

    const amb = t.ambient.kind;
    this.ambientSoft.points.visible = amb === 'snow' || amb === 'sand' || amb === 'embers' || amb === 'dust';
    this.ambientGlow.points.visible = amb === 'fireflies' || amb === 'embers' || amb === 'motes' || amb === 'vape';
  }

  /** Flat partition panels for the debris (sized like the 0.22 m chunks the sim expects). */
  private panels(): THREE.BufferGeometry {
    return (this.panelGeometry ??= new THREE.BoxGeometry(0.42, 0.3, 0.04));
  }

  private swap(slot: 'props' | 'terrain', next: THREE.Object3D): void {
    const cur = this[slot];
    if (cur === next) return;
    if (cur) this.scene.remove(cur);
    this.scene.add(next);
    this[slot] = next;
  }

  private setSky(s: SkyDef): void {
    const u = this.sky.material.uniforms;
    (u.uTop.value as THREE.Vector3).fromArray(s.top);
    (u.uMid.value as THREE.Vector3).fromArray(s.mid);
    (u.uHorizon.value as THREE.Vector3).fromArray(s.horizon);
    (u.uBelow.value as THREE.Vector3).fromArray(s.below ?? s.horizon);
    u.uBelowMix.value = s.below ? 1 : 0;
    u.uStars.value = s.stars;
    u.uStarBright.value = s.starBrightness;
    u.uStarsBelow.value = s.starsBelowHorizon ? 1 : 0;
    (u.uMoonDir.value as THREE.Vector3).fromArray(s.moonDir).normalize();
    (u.uMoonColor.value as THREE.Vector3).fromArray(s.moonColor);
    (u.uMoonSize.value as THREE.Vector2).fromArray(s.moonSize);
    (u.uMoonGlow.value as THREE.Vector3).fromArray(s.moonGlow);
    u.uMoonGlowPow.value = s.moonGlowPower;
    u.uAurora.value = s.aurora?.strength ?? 0;
    if (s.aurora) {
      (u.uAuroraA.value as THREE.Vector3).fromArray(s.aurora.a);
      (u.uAuroraB.value as THREE.Vector3).fromArray(s.aurora.b);
    }
    u.uClouds.value = s.clouds?.strength ?? 0;
    if (s.clouds) {
      (u.uCloudA.value as THREE.Vector3).fromArray(s.clouds.a);
      (u.uCloudB.value as THREE.Vector3).fromArray(s.clouds.b);
    }
    const sil = s.silhouette;
    (u.uSil.value as THREE.Vector4).set(sil?.height ?? 0, sil?.amplitude ?? 0, sil?.frequency ?? 1, sil?.jagged ?? 0);
    if (sil) (u.uSilColor.value as THREE.Vector3).fromArray(sil.color);
    const smog = s.smog;
    (u.uSmog.value as THREE.Vector4).set(smog?.color[0] ?? 0, smog?.color[1] ?? 0, smog?.color[2] ?? 0, smog?.strength ?? 0);
    u.uSmogHeight.value = smog?.height ?? 0.1;
    const city = s.skyline;
    (u.uCity.value as THREE.Vector4).set(city?.height ?? 0, city?.amplitude ?? 0, city?.density ?? 1, city?.palms ?? 0);
    if (city) {
      (u.uCityColor.value as THREE.Vector3).fromArray(city.color);
      (u.uCityWindow.value as THREE.Vector3).fromArray(city.window);
      // Downtown rises beside the sun.
      u.uDowntown.value = Math.atan2(s.moonDir[2], s.moonDir[0]) / (Math.PI * 2) + 0.5 + 0.025;
    }
  }

  /** A code-built obstacle look (candlestick bars are stretched to their placement's height). */
  private placeholder(res: ThemeResources, p: Pillar, i: number): { whole: THREE.Object3D; stump: THREE.Object3D } {
    const whole = res.kit.makePillar(p.shape.kind, p.shape.variant);
    if (p.shape.kind === 'candle') whole.scale.y = p.shape.height / CANDLE_REF_HEIGHT;
    return { whole, stump: this.stump(res, p, i) };
  }

  private stump(res: ThemeResources, p: Pillar, i: number): THREE.Object3D {
    const model = res.theme.id === 'moonlit' && p.shape.kind === 'pillar' ? this.assets.instantiate('pillarBroken') : null;
    return model?.root ?? res.kit.makeStump(i, p.shape.kind);
  }

  /**
   * A pillar GLB instance with its own materials for damage tint. A column's shaft is scaled to
   * the cylinder collider; a cubicle is fitted per axis to its box collider (footprint and height).
   */
  private glbPillar(res: ThemeResources, template: ModelTemplate, p: Pillar, i: number): { whole: THREE.Object3D; stump: THREE.Object3D } {
    const model = this.assets.instantiateModel(template);
    const s = p.shape;
    if (p.isBox) {
      const key = `fitBox:${s.halfX}:${s.halfZ}:${s.height}`;
      const fit = (template.root.userData[key] ??= boxFitScale(template.root, s.halfX, s.halfZ, s.height)) as [number, number, number, number];
      // Things you stand on (cubicles, rug piles, cars) match the collider height exactly; the rest
      // keep near their own proportions (a dumpster's raised lid may rise above its collider).
      const standable = s.kind === 'cubicle' || s.kind === 'rugs' || s.kind === 'car';
      const mean = (fit[0] + fit[2]) / 2;
      const sy = standable ? fit[1] : THREE.MathUtils.clamp(fit[1], mean * 0.85, mean * 1.15);
      model.root.scale.set(fit[0], sy, fit[2]);
      model.root.rotation.y = fit[3];
      model.root.position.set(s.cx, 0, s.cz);
    } else {
      const fit = (template.root.userData.fitXZ ??= pillarFitScale(template.root)) as number;
      model.root.scale.set(fit, 1, fit);
    }
    model.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => m.clone()) : mesh.material.clone();
    });
    return { whole: model.root, stump: this.stump(res, p, i) };
  }

  private propCopies(res: ThemeResources, template: ModelTemplate): THREE.Group {
    if (res.propCopies) return res.propCopies;
    const group = new THREE.Group();
    group.name = `propCopies:${res.theme.id}`;
    for (let i = 0; i < PROP_COPIES; i++) {
      const copy = this.assets.instantiateModel(template).root;
      const a = (i / PROP_COPIES) * Math.PI * 2 + 0.3;
      copy.position.set(Math.sin(a) * (A.wallRadius + 8), 0, Math.cos(a) * (A.wallRadius + 8));
      copy.rotation.y = a + Math.PI;
      group.add(copy);
    }
    res.propCopies = group;
    return group;
  }

  // ------------------------------------------------------------------ construction

  private buildSky(): THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> {
    const v3 = () => ({ value: new THREE.Vector3() });
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(300, 32, 16),
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: {
          uTop: v3(), uMid: v3(), uHorizon: v3(), uBelow: v3(), uBelowMix: { value: 0 },
          uStars: { value: 0.997 }, uStarBright: { value: 1 }, uStarsBelow: { value: 0 },
          uMoonDir: v3(), uMoonColor: v3(), uMoonGlow: v3(), uMoonSize: { value: new THREE.Vector2() }, uMoonGlowPow: { value: 60 },
          uAuroraA: v3(), uAuroraB: v3(), uAurora: { value: 0 },
          uCloudA: v3(), uCloudB: v3(), uClouds: { value: 0 },
          uSilColor: v3(), uSil: { value: new THREE.Vector4() },
          uSmog: { value: new THREE.Vector4() }, uSmogHeight: { value: 0.1 },
          uCity: { value: new THREE.Vector4() }, uCityColor: v3(), uCityWindow: v3(), uDowntown: { value: 0 },
          uTime: { value: 0 },
        },
      }),
    );
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    this.scene.add(sky);
    return sky;
  }

  private buildLights(): void {
    this.scene.add(this.hemi);
    const sun = this.sun;
    sun.position.set(-14, 28, -18).multiplyScalar(SUN_DISTANCE);
    sun.castShadow = R.shadows;
    const s = sun.shadow;
    s.mapSize.set(R.shadowMapSize, R.shadowMapSize);
    const ext = A.wallRadius + 2;
    s.camera.left = -ext;
    s.camera.right = ext;
    s.camera.top = ext;
    s.camera.bottom = -ext;
    s.camera.near = 8;
    s.camera.far = 110;
    s.bias = -0.0008;
    s.normalBias = 0.03;
    this.scene.add(sun);
    // Warm bounce from the fire ring.
    this.bounce.position.set(10, 3, 14);
    this.scene.add(this.bounce);
  }

  private buildFloor(): THREE.Mesh {
    const floor = new THREE.Mesh(new THREE.CircleGeometry(A.wallRadius + 0.6, 128), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Ground outside the wall.
    const outer = new THREE.Mesh(new THREE.RingGeometry(A.wallRadius + 0.5, 180, 96, 1), this.groundMat);
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.02;
    outer.receiveShadow = true;
    this.scene.add(outer);
    return outer;
  }

  /** Uses the generated debris chunk if present, otherwise flat-shaded dodecahedrons. */
  private makeDebris(scene: THREE.Scene, assets: AssetLoader): Debris {
    const model = assets.instantiate('pillarDebris');
    let mesh: THREE.Mesh | null = null;
    model?.root.updateMatrixWorld(true);
    model?.root.traverse((o) => {
      if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
    });
    if (!mesh) return new Debris(scene);
    const m = mesh as THREE.Mesh;
    // Bake the fitted transform, then normalize to the 0.22 m chunk radius the debris sim expects.
    const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
    geo.center();
    geo.computeBoundingSphere();
    const k = 0.22 / (geo.boundingSphere!.radius || 1);
    geo.scale(k, k, k);
    return new Debris(scene, 160, m.material as THREE.Material, geo);
  }

  private buildBraziers(): void {
    const count = A.braziers;
    const bowlMat = this.bowlMat;
    for (let i = 0; i < count; i++) {
      const a = ((i + 0.5) / count) * Math.PI * 2 + Math.PI / count;
      const r = A.wallRadius + 0.45;
      const group = new THREE.Group();
      group.position.set(Math.sin(a) * r, 1.4, Math.cos(a) * r);
      const model = this.assets.instantiate('brazier');
      if (model) {
        group.add(model.root);
      } else {
        const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.22, 0.35, 12, 1, true), bowlMat);
        bowl.position.y = 0.32;
        bowl.castShadow = true;
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.12, 0.3, 8), bowlMat);
        stem.position.y = 0.08;
        group.add(bowl, stem);
      }
      const flame = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), color: new THREE.Color(1.0, 0.45, 0.12).multiplyScalar(2.2),
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
      }));
      flame.position.y = 0.75;
      flame.scale.set(1.0, 1.4, 1);
      group.add(flame);
      this.brazierFlames.push(flame);
      this.scene.add(group);
    }
  }

  private buildWall(): void {
    const mat = this.wallMat;
    const r = A.wallRadius;
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(r, r, WALL_HEIGHT, 128, 1, true), mat);
    wall.position.y = WALL_HEIGHT / 2;
    wall.receiveShadow = true;
    this.scene.add(wall);
    const cap = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.8, 128), mat);
    cap.rotation.x = -Math.PI / 2;
    cap.position.y = WALL_HEIGHT;
    this.scene.add(cap);
    const outerFace = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.8, r + 0.8, WALL_HEIGHT, 128, 1, true), mat);
    outerFace.position.y = WALL_HEIGHT / 2;
    this.scene.add(outerFace);
  }

  // ------------------------------------------------------------------ per frame

  reset(): void {
    this.fireRadius = this.ringCap = A.fireRadius;
    for (const p of this.pillars) p.reset();
    this.debris.clear();
    this.glassDebris?.clear();
    // Sliding cover back to its start, clouds back to their anchors.
    this.layoutTime = 0;
    for (const m of this.movers.get(this.layout) ?? []) {
      m.t = m.rail.start;
      m.dir = m.rail.dir;
      const [x, z] = this.railPoint(m.rail, m.t);
      m.pillar.moveTo(x, z, true);
    }
    this.driftClouds();
    // Dropped smoke clears with the round.
    if (this.smokeList.length) {
      this.smokeList.length = 0;
      this.syncCloudMesh();
    }
  }

  /** Simulation tick. */
  update(dt: number): void {
    this.time += dt;
    this.layoutTime += dt;
    for (let i = 0; i < this.brazierFlames.length; i++) {
      const f = this.brazierFlames[i];
      const flicker = 1 + Math.sin(this.time * 17 + i * 3.1) * 0.08 + Math.sin(this.time * 31 + i) * 0.05;
      f.scale.set(1.0 * flicker, 1.4 * flicker, 1);
    }
    for (const p of this.pillars) p.update(dt, this.time);
    this.debris.update(dt);
    this.glassDebris?.update(dt);
    this.slideMovers(dt);
    this.driftClouds();
    for (let i = this.smokeList.length - 1; i >= 0; i--) {
      const s = this.smokeList[i];
      s.age += dt;
      if (s.age >= s.life) this.expireSmoke(i);
    }
  }

  /** World position of a point along a rail (t in -1..1). */
  private railPoint(r: MoverDef, t: number): [number, number] {
    return r.axis === 'x' ? [r.cx + t * r.half, r.cz] : [r.cx, r.cz + t * r.half];
  }

  /**
   * Slide moving cover along its rails. A block never moves into a wizard: if its next position
   * would touch one, it turns back instead (no crushing, no shoving through walls).
   */
  private slideMovers(dt: number): void {
    for (const m of this.movers.get(this.layout) ?? []) {
      const s = m.pillar.shape;
      let t = m.t + (m.dir * m.rail.speed * dt) / m.rail.half;
      if (t > 1 || t < -1) {
        t = THREE.MathUtils.clamp(t, -1, 1);
        m.dir = -m.dir as 1 | -1;
      }
      const [x, z] = this.railPoint(m.rail, t);
      const pad = 0.08;
      if (this.physics.boxTouchesWizard(x, s.height / 2, z, s.halfX + pad, s.height / 2, s.halfZ + pad, s.yaw)) {
        m.dir = -m.dir as 1 | -1;
        continue;
      }
      m.t = t;
      m.pillar.moveTo(x, z);
    }
  }

  /** Clouds drift in slow circles around their anchors (on simulation time, so the AI sees the same clouds). */
  private driftClouds(): void {
    for (const c of this.clouds) {
      const a = c.phase + (this.layoutTime / c.period) * Math.PI * 2;
      c.cx = c.x + Math.cos(a) * c.drift;
      c.cz = c.z + Math.sin(a) * c.drift;
    }
  }

  /** The vape clouds' puffs: one instanced billboard mesh for every cloud (made on first use). */
  private cloudPuffs(): THREE.InstancedMesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
    if (!this.cloudMesh) {
      const max = this.cloudCapacity;
      const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
        vertexShader: BILLBOARD_VERT, fragmentShader: BILLBOARD_FRAG, uniforms: { uOpacity: { value: 0.42 } },
        transparent: true, depthWrite: false,
      }), max);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.renderOrder = 9;
      for (let i = 0; i < max; i++) mesh.setColorAt(i, this.cloudColor.setRGB(1, 1, 1));
      this.scene.add(mesh);
      this.cloudMesh = mesh;
    }
    return this.cloudMesh;
  }

  /** Instances in the puff mesh: the layout's clouds (up to 4) and the dropped smoke screens. */
  private readonly cloudCapacity = 4 * PUFFS + MAX_SMOKES * SMOKE_PUFFS;

  /** Lay out every cloud's puffs around its current centre, slowly churning. */
  private placePuffs(t: ArenaTheme): void {
    const mesh = this.cloudMesh;
    if (!mesh || !mesh.visible) return;
    const d = this.puffDummy;
    let n = 0;
    mesh.count = this.cloudCapacity;
    const c1 = this.tmpColor.fromArray(t.ambient.color), c2 = this.tmpColor2.fromArray(t.ambient.color2);
    this.clouds.forEach((c, ci) => {
      for (let k = 0; k < PUFFS && n < mesh.count; k++, n++) {
        const a = (k / PUFFS) * Math.PI * 2 + this.visualTime * (0.05 + 0.02 * ci) * (k % 2 ? 1 : -1);
        const rr = c.radius * (k === 0 ? 0 : 0.35 + 0.45 * ((k * 37) % 10) / 10);
        const y = c.height * (0.3 + 0.45 * ((k * 53) % 10) / 10) + Math.sin(this.visualTime * 0.4 + k) * 0.15;
        d.position.set(c.cx + Math.cos(a) * rr, y, c.cz + Math.sin(a) * rr);
        d.scale.setScalar(c.radius * (1.2 + 0.5 * ((k * 71) % 10) / 10));
        d.updateMatrix();
        mesh.setMatrixAt(n, d.matrix);
        mesh.setColorAt(n, this.cloudColor.copy(k % 2 ? c1 : c2).multiplyScalar(0.62));
      }
    });
    // Smoke screens: pale vapour that billows out, churns, and thins away at the end.
    const V = CONFIG.rewardSpells.vape;
    this.smokeList.forEach((s, si) => {
      const grow = THREE.MathUtils.smoothstep(s.age, 0, V.grow);
      const fade = THREE.MathUtils.clamp((s.life - s.age) / V.fade, 0, 1);
      const k0 = 0.35 + 0.65 * grow;
      for (let k = 0; k < SMOKE_PUFFS && n < mesh.count; k++, n++) {
        const a = (k / SMOKE_PUFFS) * Math.PI * 2 + this.visualTime * (0.12 + 0.03 * si) * (k % 2 ? 1 : -1);
        const rr = s.radius * k0 * (k === 0 ? 0 : 0.3 + 0.5 * ((k * 37) % 10) / 10);
        const y = s.height * (0.18 + 0.55 * ((k * 53) % 10) / 10) * (0.6 + 0.4 * grow) + Math.sin(this.visualTime * 0.7 + k) * 0.12;
        d.position.set(s.x + Math.cos(a) * rr, y, s.z + Math.sin(a) * rr);
        d.scale.setScalar(s.radius * k0 * (0.75 + 0.95 * fade) * (1.1 + 0.5 * ((k * 71) % 10) / 10));
        d.updateMatrix();
        mesh.setMatrixAt(n, d.matrix);
        mesh.setColorAt(n, this.cloudColor.setRGB(0.86, 0.84, 0.97).multiplyScalar((k % 2 ? 0.82 : 0.7) * (0.35 + 0.65 * fade)));
      }
    });
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** Render-time visuals: sky animation, drifting props and ambient particles around `focus` (the camera). */
  updateVisual(dt: number, focus: THREE.Vector3): void {
    this.visualTime += dt;
    this.sky.material.uniforms.uTime.value = this.visualTime;
    const res = this.resources.get(this.theme);
    res?.kit.update(dt);
    if (res && dt > 0) this.emitAmbient(res.theme, dt, focus);
    if (res) this.placePuffs(res.theme);
    if (dt > 0) this.bubbleLava(dt);
    this.ambientSoft.update(dt);
    this.ambientGlow.update(dt);
  }

  /** Lava pools spit glowing droplets and steam. */
  private bubbleLava(dt: number): void {
    if (!this.hazardList.length || !this.ambientGlow.points.visible) return;
    const rnd = Math.random;
    this.lavaAcc += dt * 9 * this.hazardList.length;
    const hot = this.tmpColor.setRGB(1, 0.45, 0.08);
    while (this.lavaAcc >= 1) {
      this.lavaAcc -= 1;
      const h = this.hazardList[Math.floor(rnd() * this.hazardList.length)];
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * h.radius * 0.9;
      this.ambientGlow.emit(h.x + Math.cos(a) * r, 0.08, h.z + Math.sin(a) * r, (rnd() - 0.5) * 0.8, 1.2 + rnd() * 2, (rnd() - 0.5) * 0.8,
        hot, 2.6, 0.09 + rnd() * 0.07, 0.6 + rnd() * 0.6, { gravity: 5, drag: 0.4 });
    }
  }

  private emitAmbient(t: ArenaTheme, dt: number, focus: THREE.Vector3): void {
    const amb = t.ambient;
    if (amb.kind === 'none') return;
    this.ambientAcc += dt * amb.rate;
    const c1 = this.tmpColor.fromArray(amb.color);
    const c2 = this.tmpColor2.fromArray(amb.color2);
    const rnd = Math.random;
    while (this.ambientAcc >= 1) {
      this.ambientAcc -= 1;
      // Spawn within ~24 m of the camera so the weather is dense where it is seen.
      const a = rnd() * Math.PI * 2;
      const d = Math.sqrt(rnd()) * 24;
      const x = focus.x + Math.cos(a) * d;
      const z = focus.z + Math.sin(a) * d;
      const alt = rnd() < 0.5 ? c1 : c2;
      switch (amb.kind) {
        case 'fireflies':
          this.ambientGlow.emit(x, 0.4 + rnd() * 3, z, (rnd() - 0.5) * 0.8, (rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.8,
            alt, 2.4, 0.13, 3 + rnd() * 2.5, { drag: 0.15, sizeEnd: 0.05 });
          break;
        case 'embers':
          if (rnd() < 0.6) {
            this.ambientGlow.emit(x, rnd() * 2, z, (rnd() - 0.5) * 1.2 + 0.4, 1.2 + rnd() * 2.2, (rnd() - 0.5) * 1.2,
              c1, 2.6, 0.08 + rnd() * 0.05, 3 + rnd() * 2.5, { drag: 0.2, gravity: -0.2 });
          } else {
            this.ambientSoft.emit(x, 9 + rnd() * 8, z, 0.6 + rnd() * 0.4, -0.7 - rnd() * 0.6, 0.2 + (rnd() - 0.5) * 0.4,
              c2, 1, 0.1 + rnd() * 0.06, 11 + rnd() * 4, { sizeEnd: 0.08 });
          }
          break;
        case 'snow':
          this.ambientSoft.emit(x, 10 + rnd() * 8, z, 0.35 + (rnd() - 0.5) * 0.6, -1.0 - rnd() * 0.7, (rnd() - 0.5) * 0.6,
            alt, 1, 0.11 + rnd() * 0.07, 10 + rnd() * 4, { sizeEnd: 0.09 });
          break;
        case 'sand': {
          // Low drifting sand blowing across the arena from the west.
          const sx = focus.x - 22 + rnd() * 10, sz = focus.z + (rnd() - 0.5) * 44;
          this.ambientSoft.emit(sx, 0.1 + rnd() * rnd() * 2.6, sz, 5 + rnd() * 3, (rnd() - 0.3) * 0.4, 1 + (rnd() - 0.5) * 1.2,
            alt, 1, 0.08 + rnd() * 0.08, 4 + rnd() * 2.5, { sizeEnd: 0.05 });
          break;
        }
        case 'motes':
          this.ambientGlow.emit(x, rnd() * 9, z, (rnd() - 0.5) * 0.4, 0.15 + rnd() * 0.4, (rnd() - 0.5) * 0.4,
            alt, 2.2, 0.1 + rnd() * 0.08, 4 + rnd() * 3, { drag: 0.1, sizeEnd: 0.03 });
          break;
        case 'vape':
          // Big, faint pastel clouds that swell as they drift and rise.
          this.ambientGlow.emit(x, 0.3 + rnd() * 3, z, 0.25 + (rnd() - 0.5) * 0.5, 0.1 + rnd() * 0.25, (rnd() - 0.5) * 0.5,
            alt, 0.05, 1.0 + rnd() * 1.4, 5 + rnd() * 4, { drag: 0.25, sizeEnd: 2.6 + rnd() * 1.8 });
          break;
        case 'dust':
          // Specks hanging in the fluorescent light.
          this.ambientSoft.emit(x, 0.3 + rnd() * 6, z, (rnd() - 0.5) * 0.25, (rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.25,
            alt, 0.9, 0.035 + rnd() * 0.03, 6 + rnd() * 4, { drag: 0.2, sizeEnd: 0.02 });
          break;
      }
    }
  }
}
