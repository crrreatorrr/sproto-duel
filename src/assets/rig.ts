import * as THREE from 'three';

/**
 * Load-time preparation of skinned models (models/rigged/, Higgsfield/Meshy rigs): culling, root
 * motion, and the upper/lower body split the Animator layers clips with. Runs once per template;
 * nothing here is per frame.
 */

/** Clips whose root travel is kept (the body falls away from where it stood); every other clip is pinned in place. */
const TRAVELLING_CLIPS = new Set(['defeat']);

/** Bones that belong to the legs layer: the root (hips) and everything below it that isn't the spine. */
const LOWER_BODY = /hips|pelvis|root|upleg|thigh|leg|knee|calf|shin|foot|ankle|toe/i;

/** The skeleton's root bone (the hips): the first bone whose parent is not a bone. */
export function rootBone(root: THREE.Object3D): THREE.Bone | null {
  let found: THREE.Bone | null = null;
  root.traverse((o) => {
    if (!found && (o as THREE.Bone).isBone && !(o.parent as THREE.Bone | null)?.isBone) found = o as THREE.Bone;
  });
  return found;
}

/**
 * Get a freshly normalized skinned template ready: skinned meshes are never frustum culled (their
 * bounds are the bind pose's, and clips swing limbs and props well outside it), and root motion is
 * pinned (see pinRootMotion).
 */
export function prepareRig(template: THREE.Object3D, clips: THREE.AnimationClip[]): void {
  template.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false;
  });
  if (clips.length) pinRootMotion(template, clips);
}

/**
 * Keep the model over its collider: the root bone's horizontal track is replaced, per clip, with the
 * constant that puts the clip's average foot position on the model's origin (the centre of its
 * feet in the bind pose, where the loader's `anchor: 'feet'` put the collider). Height is kept
 * (crouches, hops). A travelling clip (defeat) keeps its path, shifted so it starts over the
 * collider. Cast lunges and the drift some clips carry go away; the animation stays in place, and
 * the game moves the character.
 */
export function pinRootMotion(template: THREE.Object3D, clips: THREE.AnimationClip[]): void {
  const hips = rootBone(template);
  const parent = hips?.parent;
  if (!hips || !parent) return;
  const feet: THREE.Object3D[] = [];
  template.traverse((o) => {
    if ((o as THREE.Bone).isBone && /foot|ankle/i.test(o.name) && !/toe|end/i.test(o.name)) feet.push(o);
  });
  const trackName = `${hips.name}.position`;
  template.updateMatrixWorld(true);
  // The model's origin (centre of its feet, on the floor) in the hips' parent frame.
  const origin = parent.worldToLocal(template.localToWorld(new THREE.Vector3()));
  const restPos = hips.position.clone();
  const restQuat = hips.quaternion.clone();
  const mixer = new THREE.AnimationMixer(template);
  const v = new THREE.Vector3();
  const samples = 12;
  for (const clip of clips) {
    const track = clip.tracks.find((t) => t.name === trackName);
    if (!track || track.getValueSize() !== 3) continue;
    const values = track.values;
    const travels = TRAVELLING_CLIPS.has(clip.name.toLowerCase());
    // Average foot position relative to the hips over the clip (the first frame for a travelling clip).
    let sx = 0, sz = 0, n = 0;
    if (feet.length) {
      const action = mixer.clipAction(clip);
      action.play();
      const count = travels ? 1 : samples;
      for (let i = 0; i < count; i++) {
        action.time = (clip.duration * i) / samples;
        mixer.update(0);
        template.updateMatrixWorld(true);
        for (const f of feet) {
          parent.worldToLocal(f.getWorldPosition(v));
          sx += v.x - hips.position.x;
          sz += v.z - hips.position.z;
          n++;
        }
      }
      action.stop();
      mixer.uncacheAction(clip);
    }
    const px = origin.x - (n ? sx / n : 0);
    const pz = origin.z - (n ? sz / n : 0);
    const x0 = values[0], z0 = values[2];
    for (let i = 0; i < values.length; i += 3) {
      values[i] = travels ? px + (values[i] - x0) : px;
      values[i + 2] = travels ? pz + (values[i + 2] - z0) : pz;
    }
  }
  mixer.uncacheRoot(template);
  hips.position.copy(restPos);
  hips.quaternion.copy(restQuat);
  template.updateMatrixWorld(true);
}

/** Does a track (`Bone.property`) drive the legs layer? */
export function isLowerBodyTrack(trackName: string): boolean {
  const dot = trackName.lastIndexOf('.');
  return LOWER_BODY.test(dot > 0 ? trackName.slice(0, dot) : trackName);
}

export interface ClipHalves {
  /** Spine, neck, head, shoulders, arms, hands (and any prop bones). */
  upper: THREE.AnimationClip;
  /** Hips and legs. */
  lower: THREE.AnimationClip;
}

const halvesCache = new WeakMap<THREE.AnimationClip, ClipHalves>();

/**
 * A clip split into its upper-body and leg tracks, so the legs can keep running while the arms
 * cast. Cached per clip: every instance of a model shares its template's halves (the mixer keeps
 * per-root state, so sharing clips between instances of one model is safe; clips are never shared
 * between different characters).
 */
export function clipHalves(clip: THREE.AnimationClip): ClipHalves {
  let h = halvesCache.get(clip);
  if (!h) {
    const lower = clip.tracks.filter((t) => isLowerBodyTrack(t.name));
    const upper = clip.tracks.filter((t) => !isLowerBodyTrack(t.name));
    h = {
      upper: new THREE.AnimationClip(`${clip.name}|upper`, clip.duration, upper),
      lower: new THREE.AnimationClip(`${clip.name}|lower`, clip.duration, lower),
    };
    halvesCache.set(clip, h);
  }
  return h;
}
