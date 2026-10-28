import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import assetIndex from 'virtual:asset-index';
import { MODELS, TEXTURES, type ModelAsset, type ModelKey, type TextureAsset, type TextureKey } from './manifest';

const available = new Set(assetIndex);
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
}

/** A loaded, normalized model. Instantiate copies with `AssetLoader.instantiateModel`. */
export interface ModelTemplate {
  root: THREE.Group;
  animations: THREE.AnimationClip[];
  skinned: boolean;
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

  async loadAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    const jobs: Promise<void>[] = [];
    let done = 0;
    const tick = () => onProgress?.(++done, jobs.length);
    for (const key of Object.keys(MODELS) as ModelKey[]) {
      jobs.push(this.loadModelAsset(MODELS[key] as ModelAsset, key).then((t) => void this.models.set(key, t)).then(tick));
    }
    for (const key of Object.keys(TEXTURES) as TextureKey[]) {
      jobs.push(this.loadTextureAsset(TEXTURES[key] as TextureAsset).then((t) => void this.textures.set(key, t)).then(tick));
    }
    await Promise.all(jobs);
  }

  /** A fresh copy of a loaded model, or null if the file isn't there (use a placeholder). */
  instantiate(key: ModelKey): ModelInstance | null {
    const t = this.models.get(key);
    return t ? this.instantiateModel(t) : null;
  }

  /** A fresh copy of a template (geometry and materials are shared with the template). */
  instantiateModel(t: ModelTemplate): ModelInstance {
    const root = t.skinned ? cloneSkinned(t.root) : t.root.clone(true);
    return { root, animations: t.animations };
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
    const t = normalizeModel(name, scene, [], spec);
    this.modelsByPath.set(spec.path, Promise.resolve(t));
    this.readyModels.set(spec.path, t);
    return t;
  }

  /** Drop a cached lazy model so the next request checks the disk again (tools and QA). */
  forgetModel(path: string): void {
    this.modelsByPath.delete(path);
    this.readyModels.delete(path);
  }

  private async fetchModel(spec: ModelAsset, name: string): Promise<ModelTemplate | null> {
    const url = resolveAsset(spec.path);
    if (!url) return null;
    try {
      const gltf = await this.gltf.loadAsync(url);
      return normalizeModel(name, gltf.scene, gltf.animations, spec);
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

/** Fit to height, stand on y=0, center on XZ, enable shadows, and check the triangle budget. */
function normalizeModel(key: string, scene: THREE.Object3D, animations: THREE.AnimationClip[], spec: ModelAsset): ModelTemplate {
  const wrapper = new THREE.Group();
  wrapper.name = `model:${key}`;
  const inner = new THREE.Group();
  inner.add(scene);
  wrapper.add(inner);
  inner.rotation.y = THREE.MathUtils.degToRad(spec.rotationY ?? 0);
  inner.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  if (spec.fitHeight && size.y > 1e-4) inner.scale.setScalar(spec.fitHeight / size.y);
  inner.updateMatrixWorld(true);
  box.setFromObject(inner);
  const center = box.getCenter(new THREE.Vector3());
  inner.position.set(-center.x, -box.min.y + (spec.yOffset ?? 0), -center.z);

  let triangles = 0;
  let skinned = false;
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
    const g = mesh.geometry;
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  const budget = spec.maxTriangles ?? 10000;
  if (triangles > budget) {
    console.warn(`[assets] ${spec.path} has ${Math.round(triangles)} triangles (budget ${budget}). Consider decimating it.`);
  }
  console.info(`[assets] Loaded ${spec.path} (${Math.round(triangles)} tris, ${animations.length} clips)`);
  return { root: wrapper, animations, skinned };
}
