import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import assetIndex from 'virtual:asset-index';
import { MODELS, TEXTURES, WIZARD_CLIPS, type ModelAsset, type ModelKey, type RiggedModel, type TextureAsset, type TextureKey } from './manifest';
import { STAFF_IDS, staffModelPath } from '../staff/catalog';
import { prepareRig } from './rig';

const available = new Set(assetIndex);
/**
 * Every fetched asset is `import.meta.env.BASE_URL` plus a path under `public/assets/`.
 * Vite's `base` (VITE_BASE, default `./`) is that prefix, so a leading `/assets/...` is never used.
 */
const BASE = `${import.meta.env.BASE_URL}assets/`;

const AUDIO_EXTS = ['.mp3', '.ogg', '.wav', '.m4a', '.webm'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

/**
 * URL for an asset if the file exists under public/assets, else null.
 * Also accepts the same file name with a different extension from `altExts`.
 */
export function resolveAsset(path: string, altExts: readonly string[] = []): string | null {
  if (available.has(path)) return BASE + path;
  const stem = path.replace(/\.[^./]+$/, '');
  for (const ext of altExts) if (available.has(stem + ext)) return BASE + stem + ext;
  return null;
}

export const resolveAudio = (path: string) => resolveAsset(path, AUDIO_EXTS);
export const resolveImage = (path: string) => resolveAsset(path, IMAGE_EXTS);

export interface ModelInstance {
  root: THREE.Object3D;
  animations: THREE.AnimationClip[];
  /** The rigged variant this copy is (sockets, clip timing), or null/absent for a static model. */
  rig?: RiggedModel | null;
}

/** A prop loaded as authored (staff GLBs). `instantiateProp` clones it. */
export interface PropTemplate {
  root: THREE.Group;
  animations: THREE.AnimationClip[];
}

export interface PropInstance {
  root: THREE.Object3D;
  animations: THREE.AnimationClip[];
}

/** A loaded, normalized model. Instantiate copies with `AssetLoader.instantiateModel`. */
export interface ModelTemplate {
  root: THREE.Group;
  animations: THREE.AnimationClip[];
  skinned: boolean;
  /** Loaded from a manifest entry's `rigged` file (null: its static mesh, or a model without one). */
  rig: RiggedModel | null;
}

/** Which file of a manifest model is used: its rigged variant, its static mesh, or neither (placeholder). */
export type ModelVariant = 'rigged' | 'static' | 'missing';

const riggedSpecs = new WeakMap<ModelAsset, ModelAsset>();
const rigOfSpec = new WeakMap<ModelAsset, RiggedModel>();
const rigOf = (spec: ModelAsset): RiggedModel | null => rigOfSpec.get(spec) ?? null;

/**
 * The load spec for `spec`'s rigged file (null without one): same fit height, feet anchor, sides and
 * clips; its own path and yaw (the rigs face +Z). Memoized, so loads cache by the rigged path.
 */
export function riggedSpec(spec: ModelAsset): ModelAsset | null {
  const r = spec.rigged;
  if (!r) return null;
  let out = riggedSpecs.get(spec);
  if (!out) {
    out = {
      path: r.path, fitHeight: spec.fitHeight, uniformScale: r.uniformScale, rotationY: r.rotationY ?? 0, yOffset: spec.yOffset, anchor: spec.anchor,
      doubleSided: spec.doubleSided, clips: spec.clips ?? WIZARD_CLIPS, maxTriangles: spec.maxTriangles, muzzle: spec.muzzle, motion: spec.motion,
    };
    riggedSpecs.set(spec, out);
    rigOfSpec.set(out, r);
  }
  return out;
}

/**
 * The spec to load for a manifest model: its rigged variant when that file is on disk (`has`), else
 * the static mesh. Pure, so QA can try it against any file list.
 */
export function selectModelSpec(spec: ModelAsset, has: (path: string) => boolean = (p) => available.has(p)): ModelAsset {
  const rigged = riggedSpec(spec);
  return rigged && has(rigged.path) ? rigged : spec;
}

/**
 * Loads every manifest model/texture that exists on disk. Anything missing resolves to null and
 * callers build a placeholder instead, so the game is always playable.
 *
 * Files are cached by path, so the eager manifest entries and lazy requests (environment themes,
 * `loadModelAsset` / `loadTextureAsset`) share one copy. Only files that exist are fetched.
 */
export class AssetLoader {
  private models = new Map<ModelKey, ModelTemplate | null>();
  private textures = new Map<TextureKey, THREE.Texture | null>();
  private modelsByPath = new Map<string, Promise<ModelTemplate | null>>();
  private texturesByPath = new Map<string, Promise<THREE.Texture | null>>();
  /** Settled lazy loads, for synchronous lookups. */
  private readyModels = new Map<string, ModelTemplate | null>();
  private readyTextures = new Map<string, THREE.Texture | null>();
  private gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private texLoader = new THREE.TextureLoader();
  /** Staff props, cached by path. Not fitted: the grip is the origin. */
  private props = new Map<string, Promise<PropTemplate | null>>();
  private readyProps = new Map<string, PropTemplate | null>();

  async loadAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    const jobs: Promise<void>[] = [];
    let done = 0;
    const tick = () => onProgress?.(++done, jobs.length);
    for (const key of Object.keys(MODELS) as ModelKey[]) {
      jobs.push(this.loadModelVariant(MODELS[key] as ModelAsset, key).then((t) => void this.models.set(key, t)).then(tick));
    }
    for (const key of Object.keys(TEXTURES) as TextureKey[]) {
      jobs.push(this.loadTextureAsset(TEXTURES[key] as TextureAsset).then((t) => void this.textures.set(key, t)).then(tick));
    }
    for (const id of STAFF_IDS) jobs.push(this.loadProp(staffModelPath(id)).then(tick));
    await Promise.all(jobs);
  }

  /** A fresh copy of a loaded model, or null if the file isn't there (use a placeholder). */
  instantiate(key: ModelKey): ModelInstance | null {
    const t = this.models.get(key);
    return t ? this.instantiateModel(t) : null;
  }

  /**
   * A fresh copy of a staff (or other prop) loaded by `loadProp`. Geometry is shared with the
   * template. Null when the file is missing: the caller builds a procedural staff.
   */
  instantiateProp(path: string): PropInstance | null {
    const t = this.readyProps.get(path);
    if (!t) return null;
    const root = t.root.clone(true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
    return { root, animations: t.animations };
  }

  /** A fresh copy of a template (geometry and materials are shared with the template). */
  instantiateModel(t: ModelTemplate): ModelInstance {
    const root = t.skinned ? cloneSkinned(t.root) : t.root.clone(true);
    return { root, animations: t.animations, rig: t.rig };
  }

  /** Which file manifest model `key` loaded: its rigged variant, its static mesh, or none. */
  modelVariant(key: ModelKey): ModelVariant {
    const t = this.models.get(key);
    return !t ? 'missing' : t.rig ? 'rigged' : 'static';
  }

  /**
   * Load a manifest model, preferring its rigged variant (`spec.rigged`) when that file is on disk;
   * the static mesh if there is none or it fails to load. Cached by path like `loadModelAsset`.
   */
  async loadModelVariant(spec: ModelAsset, name: string = spec.path): Promise<ModelTemplate | null> {
    const want = selectModelSpec(spec);
    if (want !== spec) {
      const t = await this.loadModelAsset(want, `${name} (rigged)`);
      if (t) return t;
    }
    return this.loadModelAsset(spec, name);
  }

  texture(key: TextureKey): THREE.Texture | null {
    return this.textures.get(key) ?? null;
  }

  /**
   * Load a model on first use (cached by path). Resolves null, without a request, when the file
   * isn't on disk, and null with a console warning if it fails to parse.
   */
  loadModelAsset(spec: ModelAsset, name: string = spec.path): Promise<ModelTemplate | null> {
    let job = this.modelsByPath.get(spec.path);
    if (!job) {
      job = this.fetchModel(spec, name).then((t) => {
        if (this.modelsByPath.get(spec.path) === job) this.readyModels.set(spec.path, t);
        return t;
      });
      this.modelsByPath.set(spec.path, job);
    }
    return job;
  }

  /**
   * Load a texture on first use (cached by path; the first request's options win). Resolves null,
   * without a request, when the file isn't on disk.
   */
  loadTextureAsset(spec: TextureAsset): Promise<THREE.Texture | null> {
    let job = this.texturesByPath.get(spec.path);
    if (!job) {
      job = this.fetchTexture(spec).then((t) => {
        this.readyTextures.set(spec.path, t);
        return t;
      });
      this.texturesByPath.set(spec.path, job);
    }
    return job;
  }

  /** A model by path if its load has finished (null = missing), undefined if not loaded (yet). */
  peekModel(path: string): ModelTemplate | null | undefined {
    return this.readyModels.get(path);
  }

  /** A texture by path if its load has finished (null = missing), undefined if not loaded (yet). */
  peekTexture(path: string): THREE.Texture | null | undefined {
    return this.readyTextures.get(path);
  }

  /** Register an in-memory scene as if it had been loaded from `spec.path` (tools and QA). */
  provideModel(spec: ModelAsset, scene: THREE.Object3D, name: string = spec.path): ModelTemplate {
    const t = normalizeModel(name, scene, [], spec, null);
    this.modelsByPath.set(spec.path, Promise.resolve(t));
    this.readyModels.set(spec.path, t);
    return t;
  }

  /** Drop a cached lazy model so the next request checks the disk again (tools and QA). */
  forgetModel(path: string): void {
    this.modelsByPath.delete(path);
    this.readyModels.delete(path);
  }

  /** Load a prop GLB as authored (no height fit, no recentre). Grip-origin staffs depend on that. */
  loadProp(path: string): Promise<PropTemplate | null> {
    let job = this.props.get(path);
    if (!job) {
      job = this.fetchProp(path).then((t) => {
        if (this.props.get(path) === job) this.readyProps.set(path, t);
        return t;
      });
      this.props.set(path, job);
    }
    return job;
  }

  private async fetchProp(path: string): Promise<PropTemplate | null> {
    const url = resolveAsset(path);
    if (!url) return null;
    try {
      const gltf = await this.gltf.loadAsync(url);
      const root = gltf.scene;
      root.name = root.name || `prop:${path}`;
      return { root, animations: gltf.animations };
    } catch (err) {
      console.warn(`[assets] Failed to load ${path}.`, err);
      return null;
    }
  }

  private async fetchModel(spec: ModelAsset, name: string): Promise<ModelTemplate | null> {
    const url = resolveAsset(spec.path);
    if (!url) return null;
    try {
      const gltf = await this.gltf.loadAsync(url);
      return normalizeModel(name, gltf.scene, gltf.animations, spec, rigOf(spec));
    } catch (err) {
      console.warn(`[assets] Failed to load ${spec.path}, using placeholder.`, err);
      return null;
    }
  }

  private async fetchTexture(spec: TextureAsset): Promise<THREE.Texture | null> {
    const url = resolveImage(spec.path);
    if (!url) return null;
    try {
      const tex = await this.texLoader.loadAsync(url);
      tex.colorSpace = spec.color === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      if (spec.repeat) {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(spec.repeat[0], spec.repeat[1]);
      }
      return tex;
    } catch (err) {
      console.warn(`[assets] Failed to load ${spec.path}, using procedural texture.`, err);
      return null;
    }
  }
}

/** Remove a preview staff parented to `socket_staff` after the height fit has been measured. */
function dropSocketPreview(root: THREE.Object3D): void {
  const socket = root.getObjectByName('socket_staff');
  if (!socket) return;
  for (const child of [...socket.children]) socket.remove(child);
}

/** Fraction of the model's height, from the ground up, whose vertices count as its feet. */
const FEET_BAND = 0.12;

/**
 * XZ centre of the vertices in the lowest FEET_BAND of `box` (in `inner`'s parent space), or the
 * box centre if there are none. Keeps a model standing on its collider when something sticks out.
 */
function feetCenter(inner: THREE.Object3D, box: THREE.Box3): THREE.Vector3 {
  const out = box.getCenter(new THREE.Vector3());
  const top = box.min.y + (box.max.y - box.min.y) * FEET_BAND;
  const v = new THREE.Vector3();
  const sum = new THREE.Vector3();
  let n = 0;
  inner.updateMatrixWorld(true);
  inner.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      if (v.y > top) continue;
      sum.add(v);
      n++;
    }
  });
  if (n) out.set(sum.x / n, out.y, sum.z / n);
  return out;
}

/**
 * Fit to height, stand on y=0, center on XZ, enable shadows, and check the triangle budget. Skinned
 * models (bounds from the posed skeleton) are also never culled and get their root motion pinned
 * (src/assets/rig.ts).
 */
function normalizeModel(key: string, scene: THREE.Object3D, animations: THREE.AnimationClip[], spec: ModelAsset, rig: RiggedModel | null): ModelTemplate {
  const wrapper = new THREE.Group();
  wrapper.name = `model:${key}`;
  const inner = new THREE.Group();
  inner.add(scene);
  wrapper.add(inner);
  inner.rotation.y = THREE.MathUtils.degToRad(spec.rotationY ?? 0);
  inner.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  // uniformScale wins over fitHeight. The empty player rig is already 1.9 m with a staff on the
  // socket; fitting the staff-less box would scale him up about 4.5%.
  if (spec.uniformScale != null) inner.scale.setScalar(spec.uniformScale);
  else if (spec.fitHeight && size.y > 1e-4) inner.scale.setScalar(spec.fitHeight / size.y);
  inner.updateMatrixWorld(true);
  box.setFromObject(inner);
  const center = spec.anchor === 'feet' ? feetCenter(inner, box) : box.getCenter(new THREE.Vector3());
  inner.position.set(-center.x, -box.min.y + (spec.yOffset ?? 0), -center.z);
  // The static wizard is fitted with its preview staff still in the box (that is the scale the
  // socket was built for). Drop that preview so the equipped staff is the only one attached.
  dropSocketPreview(inner);

  let triangles = 0;
  let skinned = false;
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (spec.doubleSided) {
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.side = THREE.DoubleSide;
    }
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
    const g = mesh.geometry;
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  const budget = spec.maxTriangles ?? 10000;
  if (triangles > budget) {
    console.warn(`[assets] ${spec.path} has ${Math.round(triangles)} triangles (budget ${budget}). Consider decimating it.`);
  }
  if (skinned) prepareRig(wrapper, animations);
  console.info(`[assets] Loaded ${spec.path} (${Math.round(triangles)} tris, ${animations.length} clips${skinned ? ', skinned' : ''})`);
  return { root: wrapper, animations, skinned, rig: skinned ? rig : null };
}
