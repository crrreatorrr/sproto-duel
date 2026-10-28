import * as THREE from 'three';
import { CONFIG } from '../config';
import type { AssetLoader, ModelTemplate } from '../assets/AssetLoader';
import { THEME_ASSETS } from '../assets/manifest';
import { ParticleSystem } from '../fx/ParticleSystem';
import { RegenTexture, drawArenaFloor, drawGround, drawStone, glowTexture } from '../fx/textures';
import type { Physics } from '../physics/Physics';
import { Debris } from './Debris';
import type { FireRing } from './FireRing';
import { layoutSpots, type ArenaLayout } from './layouts';
import { Pillar } from './Pillar';
import { ThemeKit, boxFitScale, pillarFitScale } from './themeKit';
import { THEMES, isThemeId, type ArenaTheme, type ArenaThemeId, type SkyDef } from './themes';

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
  /** Pillar visual key last shown for this theme. */
  pillarKey: string | null;
}

export class Arena {
  readonly debris: Debris;
  /** Cover layout of the current theme ('rings' of pillars, or the office 'cubicles'). */
  layout: ArenaLayout = 'rings';
  /** Obstacles per layout, built on first use; only the current layout's are visible and collide. */
  private readonly layouts = new Map<ArenaLayout, Pillar[]>();
  /** The original chunk shape (themes may swap in flat partition panels). */
  private readonly chunkGeometry: THREE.BufferGeometry;
  private panelGeometry: THREE.BufferGeometry | null = null;
  /** Current inner radius of the fire ring (shrinks during sudden death). */
  fireRadius: number = A.fireRadius;
  /** Active environment theme. */
  theme: ArenaThemeId = 'moonlit';
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
      list = layoutSpots(layout).map((s) => new Pillar(this.scene, this.physics, s.x, s.z, this.debris, s.shape));
      for (const p of list) p.setActive(layout === this.layout);
      this.layouts.set(layout, list);
    }
    return list;
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
      files: { floor: null, sky: null, stone: null, wallStone: null, pillar: null, prop: null },
      loading: null,
      propCopies: null,
      pillarKey: null,
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
    const job = Promise.all([
      tex(spec.floor),
      tex(spec.sky),
      tex(spec.stone, [2, 2]),
      this.assets.loadModelAsset(spec.pillar),
      this.assets.loadModelAsset(spec.prop),
    ]).then(([floor, sky, stone, pillar, prop]) => {
      if (res.loading !== job) return; // invalidated meanwhile
      const before = { ...res.files };
      this.setFiles(res, floor, sky, stone, pillar, prop);
      const changed = (Object.keys(before) as (keyof ThemeFiles)[]).some((k) => before[k] !== res.files[k]);
      if (changed && this.theme === res.theme.id) this.show(res);
    }).catch((err) => console.warn(`[arena] theme ${res.theme.id}: asset load failed`, err));
    res.loading = job;
    return job;
  }

  // ------------------------------------------------------------------ applying a theme

  private show(res: ThemeResources): void {
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

    // Cover layout: switching hides the old obstacles (no collision) and resets the new ones.
    const layout = t.layout ?? 'rings';
    if (layout !== this.layout) {
      for (const p of this.pillars) p.setActive(false);
      this.layout = layout;
      for (const p of this.pillars) {
        p.setActive(true);
        p.reset();
      }
    }

    // Pillars (a pillar GLB replaces the placeholder column or cubicle; the replaced visual is freed).
    const glb = files.pillar;
    const key = glb ? `${id}:glb:${glb.root.uuid}` : id;
    const prevKey = res.pillarKey;
    res.pillarKey = key;
    this.pillars.forEach((p, i) => {
      const kind = p.shape.kind;
      const useGlb = glb && (kind === 'pillar' || kind === 'cubicle');
      p.setVisual(key, () => (useGlb ? this.glbPillar(res, glb, p, i) : { whole: res.kit.makePillar(kind), stump: this.stump(res, p, i) }));
      if (prevKey && prevKey !== key) p.dropVisual(prevKey);
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
      const fit = (template.root.userData[key] ??= boxFitScale(template.root, s.halfX, s.halfZ, s.height)) as [number, number, number];
      model.root.scale.set(fit[0], fit[1], fit[2]);
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
    this.fireRadius = A.fireRadius;
    for (const p of this.pillars) p.reset();
    this.debris.clear();
  }

  /** Simulation tick. */
  update(dt: number): void {
    this.time += dt;
    for (let i = 0; i < this.brazierFlames.length; i++) {
      const f = this.brazierFlames[i];
      const flicker = 1 + Math.sin(this.time * 17 + i * 3.1) * 0.08 + Math.sin(this.time * 31 + i) * 0.05;
      f.scale.set(1.0 * flicker, 1.4 * flicker, 1);
    }
    for (const p of this.pillars) p.update(dt, this.time);
    this.debris.update(dt);
  }

  /** Render-time visuals: sky animation, drifting props and ambient particles around `focus` (the camera). */
  updateVisual(dt: number, focus: THREE.Vector3): void {
    this.visualTime += dt;
    this.sky.material.uniforms.uTime.value = this.visualTime;
    const res = this.resources.get(this.theme);
    res?.kit.update(dt);
    if (res && dt > 0) this.emitAmbient(res.theme, dt, focus);
    this.ambientSoft.update(dt);
    this.ambientGlow.update(dt);
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
