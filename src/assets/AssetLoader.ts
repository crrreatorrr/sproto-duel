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

interface ModelTemplate {
  root: THREE.Group;
  animations: THREE.AnimationClip[];
  skinned: boolean;
}

/**
 * Loads every manifest model/texture that exists on disk. Anything missing resolves to null and
 * callers build a placeholder instead, so the game is always playable.
 */
export class AssetLoader {
  private models = new Map<ModelKey, ModelTemplate | null>();
  private textures = new Map<TextureKey, THREE.Texture | null>();
  private gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private texLoader = new THREE.TextureLoader();

  async loadAll(onProgress?: (done: number, total: number) => void): Promise<void> {
    const jobs: Promise<void>[] = [];
    let done = 0;
    const tick = () => onProgress?.(++done, jobs.length);
    for (const key of Object.keys(MODELS) as ModelKey[]) jobs.push(this.loadModel(key).then(tick));
    for (const key of Object.keys(TEXTURES) as TextureKey[]) jobs.push(this.loadTexture(key).then(tick));
    await Promise.all(jobs);
  }

  /** A fresh copy of a loaded model, or null if the file isn't there (use a placeholder). */
  instantiate(key: ModelKey): ModelInstance | null {
    const t = this.models.get(key);
    if (!t) return null;
    const root = t.skinned ? cloneSkinned(t.root) : t.root.clone(true);
    return { root, animations: t.animations };
  }

  texture(key: TextureKey): THREE.Texture | null {
    return this.textures.get(key) ?? null;
  }

  private async loadModel(key: ModelKey): Promise<void> {
    const spec = MODELS[key] as ModelAsset;
    const url = resolveAsset(spec.path);
    if (!url) {
      this.models.set(key, null);
      return;
    }
    try {
      const gltf = await this.gltf.loadAsync(url);
      this.models.set(key, normalizeModel(key, gltf.scene, gltf.animations, spec));
    } catch (err) {
      console.warn(`[assets] Failed to load ${spec.path}, using placeholder.`, err);
      this.models.set(key, null);
    }
  }

  private async loadTexture(key: TextureKey): Promise<void> {
    const spec = TEXTURES[key] as TextureAsset;
    const url = resolveImage(spec.path);
    if (!url) {
      this.textures.set(key, null);
      return;
    }
    try {
      const tex = await this.texLoader.loadAsync(url);
      tex.colorSpace = spec.color === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      if (spec.repeat) {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(spec.repeat[0], spec.repeat[1]);
      }
      this.textures.set(key, tex);
    } catch (err) {
      console.warn(`[assets] Failed to load ${spec.path}, using procedural texture.`, err);
      this.textures.set(key, null);
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
  console.info(`[assets] Loaded ${spec.path} (${Math.round(triangles)} tris, ${animations.length} clips)`);
  return { root: wrapper, animations, skinned };
}
