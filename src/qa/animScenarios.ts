import * as THREE from 'three';
import { CONFIG } from '../config';
import { MODELS, type ModelAsset, type ModelKey } from '../assets/manifest';
import { resolveAsset, selectModelSpec } from '../assets/AssetLoader';
import { rootBone } from '../assets/rig';
import { BOSSES, bossFighters, type BossDef } from '../campaign/levels';
import { events } from '../core/events';
import type { Game } from '../core/Game';
import { Animator, HIT_HOLD } from '../wizard/Animator';
import type { Wizard } from '../wizard/Wizard';
import type { QAHarness } from './QAHarness';

type Ctx = Parameters<Parameters<QAHarness['add']>[1]>[0];

const DT = CONFIG.sim.fixedDt;
const S = CONFIG.spells;
const W = CONFIG.wizard;
const C = CONFIG.campaign;

const byId = (id: string): BossDef => BOSSES.find((b) => b.id === id)!;
const v3 = () => new THREE.Vector3();

/** Step the simulation and render-update every wizard's visual at the same rate (the real loop at 60 fps). */
function play(game: Game, seconds: number, each?: () => void): void {
  const n = Math.max(1, Math.round(seconds / DT));
  for (let i = 0; i < n; i++) {
    each?.();
    game.tick(DT);
    for (const w of game.wizards) w.visual.update(w, DT, 1);
  }
}

/** Manifest keys whose rigged variant is the one loaded. */
function riggedKeys(game: Game): ModelKey[] {
  return (Object.keys(MODELS) as ModelKey[]).filter((k) => game.assets.modelVariant(k) === 'rigged');
}

/** Dress the rival as `boss` (with its partner), evolve every fighter to `stage`, run `fn`, restore. */
function withStage(c: Ctx, game: Game, boss: BossDef, stage: number, fn: () => void): void {
  const prev = game.boss;
  game.setupEnemy(boss);
  try {
    c.setup();
    for (let s = 1; s <= stage; s++) {
      game.stages.evolveTo(s);
      if (game.partnerActive) game.partnerStages.evolveTo(s);
      c.step(C.evolveTime + 0.05);
    }
    fn();
  } finally {
    game.setupEnemy(prev);
  }
}

/** Put the player's normal look back (rigged when its file is there). */
function restorePlayer(game: Game): void {
  const p = game.player;
  p.visual.setAppearance(p.team, game.assets.instantiate('wizardPlayer'), MODELS.wizardPlayer, 'wizard');
}

/** Roll and pitch of the hip pivot (rad), from its quaternion. */
function tilt(o: THREE.Object3D): { x: number; z: number } {
  const e = new THREE.Euler().setFromQuaternion(o.quaternion, 'XZY');
  return { x: e.x, z: e.z };
}

/**
 * Character animation (src/wizard/Animator.ts, WizardVisual's procedural motion, src/assets/rig.ts):
 * rigged files preferred over the static meshes, the clip state machine, root motion pinned over
 * the collider, mixers and skeletons freed on every look swap, muzzle glows riding their bone
 * sockets, the static fallback's procedural life, and the per-frame cost.
 */
export function registerAnimScenarios(qa: QAHarness, game: Game): void {
  qa.add('anim.rigged_preferred_when_present', (c) => {
    const notes: string[] = [];
    let withRig = 0;
    for (const key of Object.keys(MODELS) as ModelKey[]) {
      const spec = MODELS[key] as ModelAsset;
      const r = spec.rigged;
      if (!r) continue;
      withRig++;
      const want = resolveAsset(r.path) ? 'rigged' : resolveAsset(spec.path) ? 'static' : 'missing';
      const got = game.assets.modelVariant(key);
      c.expect(got === want, `${key}: loaded ${got}, expected ${want} (${r.path} ${resolveAsset(r.path) ? 'on disk' : 'missing'})`);
      // The choice itself, against any file list.
      c.expect(selectModelSpec(spec, () => false) === spec, `${key}: a missing rigged file is not skipped`);
      const rs = selectModelSpec(spec, () => true);
      c.expect(rs.path === r.path && rs.rotationY === (r.rotationY ?? 0) && rs.fitHeight === spec.fitHeight && rs.anchor === spec.anchor,
        `${key}: rigged spec ${rs.path} yaw ${rs.rotationY} fit ${rs.fitHeight} anchor ${rs.anchor}`);
    }
    c.expect(withRig >= 19, `only ${withRig} manifest models have a rigged variant (player + 18 boss stages)`);
    // Every rigged look on a real visual (the parked partner's): skinned, never culled, clips found, fitted.
    const q = game.partner;
    try {
      for (const key of riggedKeys(game)) {
        const inst = game.assets.instantiate(key)!;
        c.expect(!!inst.rig, `${key}: instance has no rig`);
        let skinned = 0, culled = 0;
        inst.root.traverse((o) => {
          if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
            skinned++;
            if (o.frustumCulled) culled++;
          }
        });
        c.expect(skinned > 0 && culled === 0, `${key}: ${skinned} skinned meshes, ${culled} frustum culled`);
        q.visual.setAppearance(q.team, inst, MODELS[key], 'wizard');
        const a = q.visual.animator;
        c.expect(q.visual.rigged && !!a && a.has('idle'), `${key}: no animator or no idle clip`);
        c.expect(Math.abs(q.visual.topHeight - (MODELS[key].fitHeight ?? 0)) < 1e-6, `${key}: top ${q.visual.topHeight}`);
        notes.push(`${key}[${a!.clips.join(',')}]`);
      }
    } finally {
      // Parked: next time the partner is dressed it gets its fight's look again.
      q.visual.setAppearance(q.team, null, MODELS.bossMidget1, 'midget');
    }
    c.note(`${withRig} with a rigged variant; rigged now: ${notes.join(' ') || 'none'}`);
  });

  qa.add('anim.static_fallback_without_rigged_file', async (c) => {
    // The loader: a rigged file not on disk loads the static mesh (same template as a plain load).
    const spec = MODELS.wizardPlayer as ModelAsset;
    const missing: ModelAsset = { ...spec, rigged: { path: 'models/rigged/qa_not_there.glb' } };
    const viaVariant = await game.assets.loadModelVariant(missing, 'qa');
    const plain = await game.assets.loadModelAsset(spec);
    c.expect(!!plain && viaVariant === plain && !plain.skinned && plain.rig === null, 'a missing rigged file did not fall back to the static mesh');
    // The static mesh on the player: no clips, procedural motion only, muzzle on its measured point.
    c.setup();
    const p = game.player, v = p.visual;
    try {
      v.setAppearance(p.team, game.assets.instantiateModel(plain!), spec, 'wizard');
      c.expect(v.usesModel && !v.rigged && v.animator === null && !v.muzzleSocketed(0), 'static look has a rig, animator or socket');
      const pivot = v.hipPivot;
      // Idle: it breathes and sways (never a statue).
      let lo = Infinity, hi = -Infinity, ylo = Infinity, yhi = -Infinity;
      play(game, 4, () => {
        const t = tilt(pivot);
        lo = Math.min(lo, t.z);
        hi = Math.max(hi, t.z);
        ylo = Math.min(ylo, pivot.scale.y);
        yhi = Math.max(yhi, pivot.scale.y);
      });
      c.expect(hi - lo > 0.008 && yhi - ylo > 0.005, `idle: sway ${(hi - lo).toFixed(3)} rad, breath ${(yhi - ylo).toFixed(4)}`);
      // Running forward leans into it and bobs with the steps.
      let bobLo = Infinity, bobHi = -Infinity;
      play(game, 0.8, () => {
        p.intent.move.set(0, 0, 1);
        bobLo = Math.min(bobLo, pivot.position.y);
        bobHi = Math.max(bobHi, pivot.position.y);
      });
      const run = tilt(pivot);
      c.expect(run.x > 0.08, `running: forward lean ${run.x.toFixed(3)}`);
      c.expect(bobHi - bobLo > 0.03, `running: step bob ${(bobHi - bobLo).toFixed(3)} m`);
      p.intent.move.set(0, 0, 0);
      play(game, 0.8);
      // A cast lunges forward.
      p.mana = W.maxMana;
      p.intent.press('bolt');
      let lunge = 0;
      play(game, 0.3, () => (lunge = Math.max(lunge, pivot.position.z)));
      c.expect(lunge > 0.04, `cast: lunge ${lunge.toFixed(3)} m`);
      play(game, 0.8);
      // A hit flinches along the knockback (pushed back: tips back).
      const before = tilt(pivot).x;
      p.takeDamage(1);
      p.addKnockback(0, -1, 6);
      let flinch = 0;
      play(game, 0.25, () => (flinch = Math.min(flinch, tilt(pivot).x - before)));
      c.expect(flinch < -0.08, `hit: flinch ${flinch.toFixed(3)} rad`);
      play(game, 1);
      // A KO topples it over (no defeat clip).
      p.takeDamage(1e4);
      play(game, 1);
      c.expect(v.topple > 0.95, `KO: topple ${v.topple.toFixed(2)}`);
      c.note(`sway ${(hi - lo).toFixed(3)} rad, lean ${run.x.toFixed(2)}, bob ${(bobHi - bobLo).toFixed(3)} m, lunge ${lunge.toFixed(3)} m, flinch ${flinch.toFixed(2)} rad`);
    } finally {
      restorePlayer(game);
    }
  });

  qa.add('anim.state_machine', (c) => {
    c.setup();
    const p = game.player, v = p.visual, a = v.animator;
    if (!a) {
      c.note(`no rigged player (${game.assets.modelVariant('wizardPlayer')}): state machine not exercised`);
      return;
    }
    const st = () => `${a.legsState}/${a.upperState}`;
    play(game, 0.6);
    c.expect(a.legsState === 'idle' && a.upperState === 'idle' && a.weight('idle') > 0.95, `still: ${st()} idle ${a.weight('idle').toFixed(2)}`);
    // Facing: the idle's turned mocap stance is turned back, chest and eyes on the target.
    const deg = (r: number) => `${Math.round((r * 180) / Math.PI)}°`;
    c.expect(Math.abs(a.chestYaw()) < 0.25 && Math.abs(a.headYaw()) < 0.15, `idle facing: chest ${deg(a.chestYaw())}, head ${deg(a.headYaw())}`);
    // Moving forward: run. Sideways: strafe clip, or run with the hips turned toward the travel.
    play(game, 0.6, () => p.intent.move.set(0, 0, 1));
    c.expect(a.legsState === 'loco' && a.weight('run') > 0.9, `running: ${st()} run ${a.weight('run').toFixed(2)}`);
    play(game, 0.6, () => p.intent.move.set(1, 0, 0)); // facing +z: +x is the player's left
    if (a.has('strafeL')) c.expect(a.weight('strafeL') > 0.5, `strafing left: strafe_l ${a.weight('strafeL').toFixed(2)}`);
    else c.expect(a.hipTurn > 0.6, `strafing left without strafe_l: hips turned ${a.hipTurn.toFixed(2)} rad`);
    play(game, 0.6, () => p.intent.move.set(0, 0, -1));
    if (a.has('runBack')) c.expect(a.weight('runBack') > 0.6, `backing up: run_back ${a.weight('runBack').toFixed(2)}`);
    else c.expect(a.weight('run') > 0.9 && Math.abs(a.hipTurn) < 0.2, `backing up without run_back: run ${a.weight('run').toFixed(2)} hips ${a.hipTurn.toFixed(2)}`);
    play(game, 0.7, () => p.intent.move.set(0, 0, 0));
    c.expect(a.legsState === 'idle', `stopped: ${st()}`);

    // A bolt standing still: the whole body casts, snapping in just before the peak.
    p.mana = W.maxMana;
    p.intent.press('bolt');
    play(game, DT * 2);
    c.expect(a.legsState === 'cast' && a.upperState === 'cast', `bolt: ${st()}`);
    c.expect(Math.abs(a.time('cast') - a.peak('cast')) < 0.1, `bolt: cast at ${a.time('cast').toFixed(2)} s, peak ${a.peak('cast')}`);
    play(game, 0.12);
    // The cast turns the body side-on (its staff thrust aims at the target), but the eyes stay on it.
    const castHead = a.headYaw();
    c.expect(Math.abs(castHead) < 0.35, `casting: head turned ${deg(castHead)} off the target`);
    play(game, 0.7);
    c.expect(a.legsState === 'idle' && a.upperState === 'idle', `after the bolt: ${st()}`);

    // A blast while running: legs run, arms cast, the hand at its peak on release.
    play(game, 0.3, () => p.intent.move.set(0, 0, 1));
    p.mana = W.maxMana;
    p.cd.blast = 0;
    p.intent.press('blast');
    let atRelease = -1, stateAtRelease = '', lastPulse = p.castPulse;
    play(game, S.blast.castTime + 0.2, () => {
      p.intent.move.set(0, 0, 1);
      if (atRelease < 0 && p.castPulse > lastPulse + 0.5) {
        atRelease = a.time('castBig');
        stateAtRelease = st();
      }
      lastPulse = p.castPulse;
    });
    c.expect(stateAtRelease === 'loco/castBig', `blast while running: ${stateAtRelease || 'never released'}`);
    c.expect(Math.abs(atRelease - a.peak('castBig')) < 0.06, `blast: cast_big at ${atRelease.toFixed(2)} s on release, peak ${a.peak('castBig')}`);
    play(game, 0.8, () => p.intent.move.set(0, 0, 0));

    // The Ultimate stays on cast_big through its follow-through.
    p.ult = S.ultimate.chargeMax;
    p.intent.press('ultimate');
    play(game, S.ultimate.castTime + 0.15);
    c.expect(a.upperState === 'castBig' && a.time('castBig') > a.peak('castBig'), `Ultimate after release: ${st()} at ${a.time('castBig').toFixed(2)}`);
    play(game, 1);

    // A hit holds its reaction ~HIT_HOLD (hitFlash is only 0.09 s), then lets go.
    if (a.has('hit')) {
      p.takeDamage(1);
      play(game, 0.1);
      c.expect(a.legsState === 'hit' && a.upperState === 'hit', `hit: ${st()}`);
      play(game, HIT_HOLD - 0.15);
      c.expect(a.legsState === 'hit', `hit after ${HIT_HOLD - 0.05} s: ${st()}`);
      c.expect(Math.abs(a.chestYaw()) < 0.6, `hit: chest turned ${deg(a.chestYaw())} (the mocap's ~60° is fixed)`);
      play(game, 0.4);
      c.expect(a.legsState === 'idle', `hit released: ${st()}`);
      // Hit while running: only the upper body reacts.
      play(game, 0.4, () => p.intent.move.set(0, 0, 1));
      p.takeDamage(1);
      play(game, 0.1, () => p.intent.move.set(0, 0, 1));
      c.expect(a.legsState === 'loco' && a.upperState === 'hit', `hit while running: ${st()}`);
      play(game, 0.6, () => p.intent.move.set(0, 0, 0));
    }

    // Jump: the jump clip while airborne, back on the ground after.
    if (a.has('jump')) {
      p.intent.press('jump');
      play(game, 0.15);
      c.expect(!p.grounded && a.legsState === 'jump', `airborne: ${st()}`);
      play(game, 1);
      c.expect(p.grounded && a.legsState === 'idle', `landed: ${st()}`);
    }
    // Roll: the roll clip, and no procedural flip on top of it.
    if (a.has('dodge')) {
      p.intent.move.set(1, 0, 0);
      p.intent.press('dodge');
      let flip = 0;
      play(game, W.dodge.duration * 0.6, () => (flip = Math.max(flip, Math.abs(tilt(v.hipPivot).x), Math.abs(tilt(v.hipPivot).z))));
      c.expect(p.dodging && a.legsState === 'dodge' && a.upperState === 'dodge', `rolling: ${st()}`);
      c.expect(flip < 0.5, `rolling: the pivot flipped ${flip.toFixed(2)} rad on top of the roll clip`);
      p.intent.move.set(0, 0, 0);
      play(game, 1);
    }
    // Stun: the stun clip plays while the ice forms, then the pose freezes inside it; it thaws after.
    p.applyStun(1);
    play(game, 0.3);
    if (a.has('stunned')) c.expect(a.legsState === 'stunned', `stunned: ${st()}`);
    const iceT = a.time(a.has('stunned') ? 'stunned' : 'idle');
    play(game, 0.3);
    c.expect(a.time(a.has('stunned') ? 'stunned' : 'idle') === iceT, 'the pose kept moving inside the ice');
    play(game, 0.8);
    c.expect(!p.stunned && a.legsState === 'idle', `thawed: ${st()}`);
    // Victory.
    v.celebrate = true;
    play(game, 0.4);
    if (a.has('victory')) c.expect(a.legsState === 'victory' && a.upperState === 'victory', `celebrating: ${st()}`);
    v.celebrate = false;
    play(game, 0.5);
    c.expect(a.legsState === 'idle', `done celebrating: ${st()}`);

    // KO: the defeat clip falls, and the procedural topple stays out of it (no double fall).
    p.takeDamage(1e4);
    play(game, 1.2);
    if (a.has('defeat')) {
      c.expect(a.legsState === 'defeat' && a.weight('defeat') > 0.95, `KO: ${st()}`);
      c.expect(v.topple === 0 && Math.abs(tilt(v.hipPivot).x) < 0.2, `KO: procedural topple ${v.topple.toFixed(2)}, pivot pitch ${tilt(v.hipPivot).x.toFixed(2)}`);
    } else c.expect(v.topple > 0.9, 'KO without a defeat clip: no topple');
    p.resetForRound(false);
    play(game, 0.5);
    c.expect(a.legsState === 'idle' && a.upperState === 'idle', `back up: ${st()}`);
    c.note(`clips ${a.clips.join(',')}; blast release at ${atRelease.toFixed(2)} s (peak ${a.peak('castBig')}); head ${deg(castHead)} off the target mid-cast`);
  });

  qa.add('anim.root_motion_pinned', (c) => {
    // Every rigged file: each clip's root track stands still horizontally (defeat may travel).
    const notes: string[] = [];
    for (const key of riggedKeys(game)) {
      const t = game.assets.peekModel((MODELS[key] as ModelAsset).rigged!.path);
      c.expect(!!t, `${key}: rigged template not loaded`);
      const hips = rootBone(t!.root);
      c.expect(!!hips, `${key}: no root bone`);
      for (const clip of t!.animations) {
        if (clip.name.toLowerCase() === 'defeat') continue;
        const track = clip.tracks.find((tr) => tr.name === `${hips!.name}.position`);
        if (!track) continue;
        let dx = 0, dz = 0;
        for (let i = 3; i < track.values.length; i += 3) {
          dx = Math.max(dx, Math.abs(track.values[i] - track.values[0]));
          dz = Math.max(dz, Math.abs(track.values[i + 2] - track.values[2]));
        }
        c.expect(dx < 1e-3 && dz < 1e-3, `${key} ${clip.name}: root drifts ${dx.toFixed(2)}, ${dz.toFixed(2)}`);
      }
      notes.push(key);
    }
    // In game: through idle, run, casts and hits the body stays over the collider.
    const p = game.player;
    if (!p.visual.animator) {
      c.note(`no rigged player; clip tracks checked for ${notes.join(', ') || 'none'}`);
      return;
    }
    c.setup();
    const hips = rootBone(p.visual.root)!;
    const feet: THREE.Object3D[] = [];
    p.visual.root.traverse((o) => {
      if ((o as THREE.Bone).isBone && /foot/i.test(o.name) && !/toe/i.test(o.name)) feet.push(o);
    });
    const h = v3(), f = v3(), tmp = v3();
    let worstHips = 0, worstFeet = 0;
    const check = () => {
      p.visual.root.updateMatrixWorld(true);
      hips.getWorldPosition(h);
      worstHips = Math.max(worstHips, Math.hypot(h.x - p.visual.root.position.x, h.z - p.visual.root.position.z));
      f.set(0, 0, 0);
      for (const b of feet) f.add(b.getWorldPosition(tmp));
      f.divideScalar(Math.max(1, feet.length));
      worstFeet = Math.max(worstFeet, Math.hypot(f.x - p.visual.root.position.x, f.z - p.visual.root.position.z));
    };
    play(game, 1, check);
    play(game, 1, () => {
      p.intent.move.set(0.7, 0, 0.7);
      check();
    });
    p.intent.move.set(0, 0, 0);
    for (const spell of ['bolt', 'blast'] as const) {
      p.mana = W.maxMana;
      p.cd.blast = 0;
      p.intent.press(spell);
      play(game, 0.9, check);
    }
    p.takeDamage(1);
    play(game, 0.6, check);
    c.expect(worstHips < 0.3, `hips wandered ${worstHips.toFixed(2)} m off the collider`);
    c.expect(worstFeet < 0.35, `feet centre wandered ${worstFeet.toFixed(2)} m off the collider`);
    c.note(`pinned: ${notes.join(', ')}; in game hips within ${worstHips.toFixed(2)} m, feet within ${worstFeet.toFixed(2)} m`);
  });

  qa.add('anim.mixers_disposed_on_stage_swap', (c) => {
    const gl = game.renderer.renderer;
    const scene = game.renderer.scene;
    const render = () => game.renderer.render();
    const sahil = byId('sahil');
    const cycle = () => {
      withStage(c, game, sahil, 0, () => {
        render();
        for (let s = 1; s < 3; s++) {
          game.stages.evolveTo(s);
          c.step(C.evolveTime + 0.05);
          play(game, 0.1);
          render();
        }
        game.stages.reset();
        play(game, 0.1);
        render();
      });
      // The player too: rigged, static placeholder, rigged again.
      const p = game.player;
      p.visual.setAppearance(p.team, null, MODELS.wizardPlayer, 'wizard');
      play(game, 0.05);
      render();
      restorePlayer(game);
      play(game, 0.05);
      render();
    };
    cycle(); // warm up: every look built and drawn once
    const live = Animator.live;
    const mem = { ...gl.info.memory };
    const children = scene.children.length;
    const enemyKids = game.enemy.visual.root.children.length;
    let peakLive = live;
    for (let i = 0; i < 10; i++) {
      cycle();
      peakLive = Math.max(peakLive, Animator.live);
    }
    c.expect(Animator.live === live, `live animators ${live} -> ${Animator.live}`);
    c.expect(peakLive <= live + 1, `animators piled up to ${peakLive} (from ${live})`);
    c.expect(gl.info.memory.textures === mem.textures, `textures ${mem.textures} -> ${gl.info.memory.textures} (bone textures not freed?)`);
    c.expect(gl.info.memory.geometries === mem.geometries, `geometries ${mem.geometries} -> ${gl.info.memory.geometries}`);
    c.expect(scene.children.length === children, `scene children ${children} -> ${scene.children.length}`);
    c.expect(game.enemy.visual.root.children.length === enemyKids, `enemy visual children ${enemyKids} -> ${game.enemy.visual.root.children.length}`);
    c.note(`10 swap cycles (Sahil stages 1-3 and back, the player rigged/placeholder): ${live} animators, ${mem.textures} textures, ${mem.geometries} geometries`);
  });

  qa.add('anim.sockets_follow_bones', (c) => {
    c.setup();
    const p = game.player, v = p.visual;
    const sockets = MODELS.wizardPlayer.rigged?.sockets;
    if (!v.rigged || !sockets?.staff) {
      c.note('no rigged player with a staff socket: skipped');
      return;
    }
    c.expect(v.muzzleSocketed(0), 'player staff muzzle is not on its socket');
    const socket = v.root.getObjectByName('socket:staff')!;
    c.expect(!!socket && socket.parent?.name === sockets.staff.bone, `socket hangs on ${socket?.parent?.name}, not ${sockets.staff.bone}`);
    const a = v3(), b = v3(), glow = v3(), home = v3(), spawn = v3(), fx = v3();
    play(game, 0.5);
    // The anchor is exactly where the bone carries the socket offset.
    v.root.updateMatrixWorld(true);
    socket.parent!.localToWorld(b.set(...((sockets.staff.glowOffset ?? sockets.staff.offset) as [number, number, number])));
    v.muzzleWorld(0, a);
    c.expect(a.distanceTo(b) < 1e-3, `staff anchor ${a.distanceTo(b).toFixed(4)} m from bone + offset`);
    const toLocal = (q: THREE.Vector3) => q.sub(p.pos).applyAxisAngle(new THREE.Vector3(0, 1, 0), -p.facing);
    const idle = toLocal(a.clone());
    // A blast windup: the charge glow and the muzzle light sit on the animated staff, which moves.
    p.mana = W.maxMana;
    p.cd.blast = 0;
    p.intent.press('blast');
    play(game, S.blast.castTime * 0.8);
    c.expect(!!p.cast, 'no blast windup');
    v.muzzleWorld(0, a);
    v.chargeGlowWorld(glow);
    c.expect(glow.distanceTo(a) < 0.3, `charge glow ${glow.distanceTo(a).toFixed(2)} m from the staff socket`);
    c.expect(v.lightLevel > 0.2 && v.lightPos.distanceTo(a) < 0.02, `muzzle light ${v.lightPos.distanceTo(a).toFixed(3)} m from the socket`);
    // Muzzle effects play at the socket; the projectile still spawns from castPoint.
    p.castPoint('blast', spawn, 0);
    v.muzzleFxOrigin(0, spawn, fx);
    c.expect(fx.distanceTo(a) < 1e-4, 'muzzle effects are not at the socket');
    v.muzzleHomeWorld(0, home);
    let from: THREE.Vector3 | null = null;
    const off = events.on('cast', (e) => {
      if (e.wizard === p && !from) from = e.pos.clone();
    });
    let atRelease = v3();
    try {
      let last = p.castPulse;
      play(game, 0.3, () => {
        if (p.castPulse > last + 0.5) v.muzzleWorld(0, atRelease);
        last = p.castPulse;
      });
    } finally {
      off();
    }
    p.castPoint('blast', spawn, 0);
    c.expect(!!from, 'no blast');
    const peak = toLocal(atRelease.clone());
    c.expect(peak.distanceTo(idle) > 0.15, `the staff socket barely moved between idle and the cast (${peak.distanceTo(idle).toFixed(2)} m)`);
    c.note(`staff socket idle (${idle.toArray().map((n) => n.toFixed(2))}) -> release (${peak.toArray().map((n) => n.toFixed(2))}); ` +
      `spawn (castPoint) ${(from as THREE.Vector3 | null)?.distanceTo(atRelease).toFixed(2)} m from the staff at release`);
  });

  qa.add('anim.tinubu_wings_and_skipped_clips', (c) => {
    const tinubu = byId('tinubu');
    const notes: string[] = [];
    for (let stage = 0; stage < 3; stage++) {
      const key = tinubu.stages[stage].model;
      if (game.assets.modelVariant(key) !== 'rigged') {
        notes.push(`stage ${stage + 1} static`);
        continue;
      }
      withStage(c, game, tinubu, stage, () => {
        const e = game.enemy, v = e.visual, a = v.animator!;
        c.expect(!!a && !a.has('dodge') && !a.has('jump'), `stage ${stage + 1}: plays ${a?.clips.join(',')} (no roll or jump wanted)`);
        // A roll is the procedural flip instead.
        play(game, 0.3);
        e.intent.move.set(1, 0, 0);
        e.intent.press('dodge');
        let flip = 0;
        play(game, W.dodge.duration * 0.6, () => (flip = Math.max(flip, Math.abs(tilt(v.hipPivot).x), Math.abs(tilt(v.hipPivot).z))));
        c.expect(flip > 1, `stage ${stage + 1}: no procedural roll (pivot ${flip.toFixed(2)} rad)`);
        e.intent.move.set(0, 0, 0);
        play(game, 0.8);
        if (stage === 0) {
          notes.push(`stage 1: ${v.wingCount} wings`);
          return;
        }
        // Wings: split onto their own bones, flapping within the rig's range, faster when casting.
        c.expect(v.wingCount === 2, `stage ${stage + 1}: ${v.wingCount} wing bones`);
        const wing = v.root.getObjectByName('LeftWing')!;
        const rest = (wing.userData.wingRest as THREE.Quaternion).clone();
        const angle = () => 2 * Math.asin(Math.min(1, rest.clone().invert().multiply(wing.quaternion).normalize().z));
        let lo = Infinity, hi = -Infinity, travel = 0, prev = angle();
        play(game, 2, () => {
          const x = angle();
          lo = Math.min(lo, x);
          hi = Math.max(hi, x);
          travel += Math.abs(x - prev);
          prev = x;
        });
        c.expect(hi - lo > 0.25 && lo > -0.45 && hi < 0.54, `stage ${stage + 1}: flap ${lo.toFixed(2)}..${hi.toFixed(2)} rad`);
        // Casting rouses them.
        let roused = 0;
        e.mana = W.maxMana;
        play(game, 1, () => {
          e.cd.bolt = 0;
          e.intent.holdBolt = true;
          const x = angle();
          roused += Math.abs(x - prev);
          prev = x;
        });
        e.intent.holdBolt = false;
        c.expect(roused > travel * 0.5 * 1.3, `stage ${stage + 1}: wings beat ${(roused).toFixed(2)} rad/s casting vs ${(travel / 2).toFixed(2)} idle`);
        notes.push(`stage ${stage + 1}: flap ${lo.toFixed(2)}..${hi.toFixed(2)} rad, ${(travel / 2).toFixed(2)} -> ${roused.toFixed(2)} rad/s casting`);
      });
    }
    c.note(notes.join('; '));
  });

  qa.add('anim.boss_presence', (c) => {
    // Every stage moves heavier than the last, and the last one looms.
    for (const boss of BOSSES) {
      for (const f of bossFighters(boss)) {
        const m = f.stages.map((s) => (MODELS[s.model] as ModelAsset).motion ?? {});
        c.expect((m[0].weight ?? 0) < (m[1].weight ?? 0) && (m[1].weight ?? 0) < (m[2].weight ?? 0), `${f.id}: stage weights ${m.map((x) => x.weight)}`);
        c.expect((m[2].menace ?? 0) > 0.5 && (m[0].menace ?? 0) === 0, `${f.id}: menace ${m.map((x) => x.menace)}`);
      }
    }
    // In game: stage 3 sways more than stage 1 while idle (rolling, or shifting its weight sideways
    // when its hem is too wide to roll; pivot yaw, roll in rad and shift in m, summed).
    const sway: number[] = [];
    for (const stage of [0, 2]) {
      withStage(c, game, byId('broccoli'), stage, () => {
        const e = game.enemy, pivot = e.visual.hipPivot;
        play(game, 2.5);
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        const yaw = new THREE.Euler();
        play(game, 3.5, () => {
          yaw.setFromQuaternion(pivot.quaternion, 'YXZ');
          const v = [tilt(pivot).z, pivot.position.x, yaw.y];
          for (let i = 0; i < 3; i++) {
            lo[i] = Math.min(lo[i], v[i]);
            hi[i] = Math.max(hi[i], v[i]);
          }
        });
        sway.push(hi[0] - lo[0] + hi[1] - lo[1] + hi[2] - lo[2]);
        if (stage === 2) c.expect(e.visual.motionStyle.menace > 0.5, `stage 3 menace ${e.visual.motionStyle.menace.toFixed(2)}`);
      });
    }
    c.expect(sway[1] > sway[0] * 1.5, `stage 3 sway ${sway[1].toFixed(3)} vs stage 1 ${sway[0].toFixed(3)}`);
    c.note(`idle sway (roll + shift + yaw) stage 1 ${sway[0].toFixed(3)}, stage 3 ${sway[1].toFixed(3)}`);
  });

  qa.add('anim.update_cost', (c) => {
    // Three looks updating every frame (the player, the rival and a double fight's partner).
    withStage(c, game, byId('obama'), 0, () => {
      const ws: Wizard[] = [...game.wizards];
      const frames = 600;
      for (let i = 0; i < 60; i++) for (const w of ws) w.visual.update(w, 1 / 60, 1);
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        for (const w of ws) {
          w.intent.move.set(Math.sin(i * 0.05), 0, Math.cos(i * 0.05));
          w.visual.update(w, 1 / 60, 1);
        }
      }
      const per = (performance.now() - t0) / (frames * ws.length);
      c.expect(per < 0.5, `${per.toFixed(3)} ms per visual update`);
      c.note(`${ws.length} wizards (${ws.map((w) => (w.visual.rigged ? 'rigged' : w.visual.usesModel ? 'static' : 'placeholder')).join(', ')}): ${per.toFixed(3)} ms per visual update`);
    });
  });
}
