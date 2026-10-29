import * as THREE from 'three';
import { CONFIG } from '../config';
import { MODELS, type ModelKey } from '../assets/manifest';
import type { ModelInstance } from '../assets/AssetLoader';
import type { Pillar } from '../arena/Pillar';
import type { ArenaThemeId } from '../arena/themes';
import { muzzleSetFor } from '../campaign/muzzleIndex';
import { BOSSES, bossFighters, type BossDef, type BossFighter } from '../campaign/levels';
import { events } from '../core/events';
import type { Game } from '../core/Game';
import { GROUP } from '../physics/Physics';
import { muzzleLocal, PLACEHOLDER_MUZZLES, type CastKind, type MuzzleSet, type MuzzleType } from '../wizard/muzzles';
import type { Wizard } from '../wizard/Wizard';
import type { QAHarness } from './QAHarness';

type Ctx = Parameters<Parameters<QAHarness['add']>[1]>[0];
type Spell = 'bolt' | 'blast' | 'stun';

const DT = CONFIG.sim.fixedDt;
const S = CONFIG.spells;
const C = CONFIG.campaign;
const W = CONFIG.wizard;
const FADE = CONFIG.camera.bossFade;
/** Spawn vs muzzle tolerance (m): the simulation point itself, so only float error. */
const TIGHT = 0.02;
/**
 * Rendered muzzle point vs spawn (m): the render pose breathes, sways and bobs (a late boss stage
 * looms with a slow sway and hunch, WizardVisual's MotionStyle).
 */
const POSE = 0.1;

const byId = (id: string): BossDef => BOSSES.find((b) => b.id === id)!;

/** Each fighter's expected muzzle types, from the brief. */
const EXPECTED: Record<string, MuzzleType[]> = {
  sahil: ['staff'],
  obama: ['phone'],
  midget: ['phone'],
  broccoli: ['vape'],
  agent: ['gun'],
  tinubu: ['hand', 'mouth'],
};

/** Names of the points `kind` may leave from in `set` (the documented rule, re-derived here). */
function pointsFor(set: MuzzleSet, kind: CastKind): readonly string[] {
  return set.use?.[kind] ?? set.use?.bolt ?? Object.keys(set.points);
}

/** `local` (look frame, already scaled) placed on `w` at `pos`, turned by its facing. */
function toWorld(w: Wizard, local: THREE.Vector3, out: THREE.Vector3, pos: THREE.Vector3 = w.pos): THREE.Vector3 {
  const s = Math.sin(w.facing), c = Math.cos(w.facing);
  return out.set(pos.x + local.x * c + local.z * s, pos.y + local.y, pos.z - local.x * s + local.z * c);
}

/** A world point in `w`'s own frame (x = its left, z = forward), before the look's scale. */
function toLocal(w: Wizard, p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const s = Math.sin(w.facing), c = Math.cos(w.facing);
  const dx = p.x - w.pos.x, dz = p.z - w.pos.z;
  return out.set(dx * c - dz * s, p.y - w.pos.y, dx * s + dz * c);
}

/** Where stage `stage` of `fighter`'s data says point `name` is, in world space on `w` (root scale included). */
function dataPoint(w: Wizard, fighter: BossFighter, stage: number, name: string, out: THREE.Vector3, pos?: THREE.Vector3, spell: Spell = 'bolt'): THREE.Vector3 {
  // A rigged look fires from its animated prop at the cast's release (WizardVisual.measureRelease).
  const idx = w.visual.muzzles?.points.findIndex((p) => p.name === name) ?? -1;
  if (idx >= 0 && w.visual.muzzleReleased(idx)) {
    w.visual.muzzlePoint(idx, out, spell).multiplyScalar(w.visual.root.scale.x);
    return toWorld(w, out, out, pos);
  }
  const st = fighter.stages[stage];
  muzzleLocal(st.muzzle.points[name].at, MODELS[st.model].fitHeight!, w.visual.root.scale.x, out);
  return toWorld(w, out, out, pos);
}

/** Make `w` cast `spell` now (windups included) and return where it left from (the 'cast' event), or null. */
function castFrom(c: Ctx, w: Wizard, spell: Spell): THREE.Vector3 | null {
  w.mana = W.maxMana;
  w.cd.bolt = w.cd.blast = w.cd.stun = 0;
  w.cast = null;
  let seen: THREE.Vector3 | null = null;
  const off = events.on('cast', (e) => {
    if (e.wizard === w && e.spell === spell && !seen) seen = e.pos.clone();
  });
  try {
    w.intent.press(spell);
    const ticks = spell === 'bolt' ? 1 : Math.ceil(S[spell].castTime / DT) + 2;
    for (let i = 0; i < ticks && !seen; i++) c.step(DT);
  } finally {
    off();
    w.intent.clear();
    w.intent.facing = w.facing;
  }
  return seen;
}

/** Let the render pose settle (no motion, no recoil) so its anchors can be compared with the simulation. */
function settle(w: Wizard): void {
  w.castPulse = 0;
  for (let i = 0; i < 30; i++) w.visual.update(w, 1 / 30, 1);
}

/** Put `w` on (x, z) facing `facing` and aiming at `target`'s chest. */
function place(game: Game, w: Wizard, x: number, z: number, facing: number, target: Wizard): void {
  w.spawn(x, z, facing);
  target.chest(w.aimPoint);
  game.physics.step();
}

/** Dress the rival as `boss` (with its partner), evolve every fighter to `stage` through BossStages, run `fn`, restore. */
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
    // A flying stage (The Midget's last) climbs to its hover first.
    if (game.enemies.some((w) => w.flying)) c.step(1.2);
    fn();
  } finally {
    game.setupEnemy(prev);
  }
}

/** A stand-in GLB: one box, enough for WizardVisual to treat it as a model. */
function fakeModel(): ModelInstance {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 2, 0.4).translate(0, 1, 0), new THREE.MeshStandardMaterial()));
  return { root, animations: [] };
}

/** 3D gap from a point to an obstacle's standing parts (negative never: 0 = touching or inside). */
function partGap(p: Pillar, v: THREE.Vector3): number {
  let best = Infinity;
  for (const part of p.shape.parts) {
    const dx = v.x - p.position.x, dz = v.z - p.position.z;
    const y = p.shape.yaw;
    const lx = dx * Math.cos(y) - dz * Math.sin(y) - part.x;
    const lz = dx * Math.sin(y) + dz * Math.cos(y) - part.z;
    const c = Math.cos(part.yaw), s = Math.sin(part.yaw);
    const px = lx * c - lz * s, pz = lx * s + lz * c;
    const h = part.shape === 'box'
      ? Math.hypot(Math.max(0, Math.abs(px) - part.halfX), Math.max(0, Math.abs(pz) - part.halfZ))
      : Math.max(0, Math.hypot(px, pz) - part.radius);
    const vy = v.y > part.height ? v.y - part.height : v.y < part.y0 ? part.y0 - v.y : 0;
    best = Math.min(best, Math.hypot(h, vy));
  }
  return best;
}

/**
 * Muzzles (src/wizard/muzzles.ts): every caster's spells leave from its prop (staff orb, phones,
 * vape, gun barrel, Tinubu's palm and mouth) in world space after the stage scale and yaw, with
 * pooled effects there; never from inside cover; the player's aim is unchanged. Plus the camera
 * fade on big bosses and the lean lift on wide ones (WizardVisual).
 */
export function registerMuzzleScenarios(qa: QAHarness, game: Game): void {
  const v3 = () => new THREE.Vector3();

  qa.add('muzzles.data_for_every_caster', (c) => {
    const seen: string[] = [];
    for (const boss of BOSSES) {
      for (const f of bossFighters(boss)) {
        const sizes: number[] = [];
        f.stages.forEach((st, s) => {
          const pts = Object.values(st.muzzle.points);
          const types = [...new Set(pts.map((p) => p.type))].sort().join(',');
          c.expect(types === [...EXPECTED[f.id]].sort().join(','), `${f.id} stage ${s + 1}: muzzle types ${types}`);
          for (const p of pts) {
            const [fwd, up, right] = p.at;
            c.expect(up > 0.2 && up < 0.95 && Math.abs(fwd) < 0.5 && Math.abs(right) < 0.45, `${f.id} stage ${s + 1}: point ${p.at} outside the model`);
          }
          c.expect(muzzleSetFor(MODELS[st.model]) === st.muzzle, `${f.id} stage ${s + 1}: ${st.model} does not find its stage muzzles`);
          sizes.push(pts[0].size ?? 1);
        });
        if (f.id === 'broccoli' || f.id === 'agent') c.expect(sizes[0] < sizes[1] && sizes[1] < sizes[2], `${f.id}: prop sizes ${sizes} do not grow`);
        seen.push(`${f.id}=${EXPECTED[f.id].join('+')}`);
      }
    }
    const tin = byId('tinubu').stages[0].muzzle;
    c.expect(pointsFor(tin, 'bolt').join() === 'hand' && pointsFor(tin, 'blast').join() === 'mouth' && pointsFor(tin, 'volley').join() === 'mouth', 'Tinubu: bolts hand, blasts and volleys mouth');
    c.expect(pointsFor(tin, 'ultimate').length === 2, 'Tinubu: the Ultimate from hand and mouth');
    const player = MODELS.wizardPlayer.muzzle;
    c.expect(!!player && Object.values(player.points).every((p) => p.type === 'staff'), 'the player casts from a staff');
    c.expect(game.player.visual.usesModel === false || game.player.visual.muzzleType(0) === 'staff', 'the player look has no staff muzzle');
    c.note(seen.join(' '));
  });

  qa.add('muzzles.boss_stages_cast_from_their_props', (c) => {
    const notes: string[] = [];
    const exp = v3(), got = v3(), anchor = v3();
    for (const boss of BOSSES) {
      for (let stage = 0; stage < 3; stage++) {
        withStage(c, game, boss, stage, () => {
          const fighters = bossFighters(boss);
          const wizards = [game.enemy, game.partner].slice(0, fighters.length);
          const p = game.player;
          place(game, p, 0, -6, 0, game.enemy);
          let worst = 0;
          wizards.forEach((w, i) => {
            const f = fighters[i];
            const st = f.stages[stage];
            const glb = w.visual.usesModel;
            c.expect(glb, `${f.id} stage ${stage + 1}: no GLB on disk (expected one)`);
            // Turned and off the spawn line, so a missing yaw would show.
            place(game, w, i === 0 ? 2 : -3, 6, Math.PI + (i === 0 ? 0.5 : -0.4), p);
            for (const spell of ['bolt', 'blast'] as const) {
              const idx = w.muzzleIndex(spell);
              const name = w.visual.muzzles!.points[idx].name;
              c.expect(pointsFor(st.muzzle, spell).includes(name), `${f.id} stage ${stage + 1}: ${spell} from '${name}'`);
              // The render pose's measured point agrees with the simulation point (a rigged look's glow
              // rides its bone socket instead: animScenarios checks that).
              settle(w);
              if (!w.visual.muzzleReleased(idx)) {
                w.visual.muzzleHomeWorld(idx, anchor);
                w.castPoint(spell, got, idx);
                c.expect(anchor.distanceTo(got) < POSE, `${f.id} stage ${stage + 1}: muzzle anchor ${anchor.distanceTo(got).toFixed(3)} m from castPoint`);
              }
              const from = castFrom(c, w, spell);
              c.expect(!!from, `${f.id} stage ${stage + 1}: no ${spell}`);
              dataPoint(w, f, stage, name, exp, undefined, spell);
              const d = from!.distanceTo(exp);
              worst = Math.max(worst, d);
              c.expect(d < TIGHT, `${f.id} stage ${stage + 1}: ${spell} left ${d.toFixed(3)} m from its ${name}`);
            }
            // Airborne: the muzzle rides up with the jump.
            w.vy = W.jump.velocity;
            w.grounded = false;
            c.step(0.12);
            const at = w.pos.clone();
            const idx = w.muzzleIndex('bolt');
            const from = castFrom(c, w, 'bolt');
            dataPoint(w, f, stage, w.visual.muzzles!.points[idx].name, exp, at);
            c.expect(at.y > 0.5 && !!from && from.distanceTo(exp) < TIGHT, `${f.id} stage ${stage + 1}: jumping bolt ${from ? from.distanceTo(exp).toFixed(3) : 'none'} m off (feet at ${at.y.toFixed(2)})`);
            c.step(0.8);
          });
          notes.push(`${boss.id}${stage + 1}:${(worst * 1000).toFixed(0)}mm`);
        });
      }
    }
    c.note(notes.join(' '));
  });

  qa.add('muzzles.tinubu_hand_and_mouth', (c) => {
    const boss = byId('tinubu');
    const exp = v3();
    const notes: string[] = [];
    for (let stage = 0; stage < 3; stage++) {
      withStage(c, game, boss, stage, () => {
        const w = game.enemy, p = game.player;
        place(game, p, 0, -6, 0, w);
        place(game, w, 0, 6, Math.PI + 0.3, p);
        const pts = w.visual.muzzles!.points;
        const hand = pts.findIndex((q) => q.name === 'hand'), mouth = pts.findIndex((q) => q.name === 'mouth');
        const check = (label: Spell, from: THREE.Vector3 | null, name: string) => {
          dataPoint(w, boss, stage, name, exp, undefined, label);
          c.expect(!!from && from.distanceTo(exp) < TIGHT, `stage ${stage + 1}: ${label} ${from ? from.distanceTo(exp).toFixed(3) : 'none'} m from the ${name}`);
        };
        check('bolt', castFrom(c, w, 'bolt'), 'hand');
        check('blast', castFrom(c, w, 'blast'), 'mouth');
        check('stun', castFrom(c, w, 'stun'), 'hand');
        // A volley: every shot out of the mouth.
        const shots: THREE.Vector3[] = [];
        const off = events.on('cast', (e) => e.wizard === w && e.spell === 'bolt' && shots.push(e.pos.clone()));
        try {
          w.mana = W.maxMana;
          c.expect(game.spells.castVolley(w, { name: 'QA Breath', count: 3, spreadDeg: 20, interval: 0, cooldown: 1, damageScale: 0.5 }), 'volley refused');
          c.step(DT);
        } finally {
          off();
        }
        dataPoint(w, boss, stage, 'mouth', exp, undefined, 'bolt'); // volleys release like bolts (the cast clip)
        c.expect(shots.length === 3 && shots.every((s) => s.distanceTo(exp) < TIGHT), `stage ${stage + 1}: volley shots not from the mouth (${shots.length})`);
        // The Ultimate flares the palm and the mouth together.
        w.ult = S.ultimate.chargeMax;
        w.cast = null;
        w.intent.press('ultimate');
        c.step(S.ultimate.castTime + DT * 2);
        c.expect(w.visual.muzzleFlare(hand) > 0.5 && w.visual.muzzleFlare(mouth) > 0.5, `stage ${stage + 1}: Ultimate flares hand ${w.visual.muzzleFlare(hand).toFixed(2)} mouth ${w.visual.muzzleFlare(mouth).toFixed(2)}`);
        notes.push(`s${stage + 1} ok`);
      });
    }
    c.expect(game.spells.muzzleFx.counts.hand > 0 && game.spells.muzzleFx.counts.mouth > 0, 'no hand or mouth effects played');
    c.note(notes.join(' '));
  });

  qa.add('muzzles.partner_fires_from_phones', (c) => {
    const boss = byId('obama');
    const partner = boss.partner!;
    const exp = v3(), local = v3();
    // Stage 1: The Midget's phone is in his left hand.
    withStage(c, game, boss, 0, () => {
      const q = game.partner;
      place(game, q, -3, 6, Math.PI, game.player);
      const from = castFrom(c, q, 'bolt');
      dataPoint(q, partner, 0, 'phone', exp);
      c.expect(!!from && from.distanceTo(exp) < TIGHT, `Midget stage 1: bolt ${from ? from.distanceTo(exp).toFixed(3) : 'none'} m from his phone`);
      toLocal(q, from!, local);
      // His left hand at hand height of a 1.25 m man: his own over-shoulder throw whips that hand in
      // to his centre line at the release, so it is on the line or left of it (+x), never his right.
      c.expect(local.x > -0.1 && local.y > 0.4 && local.y < 1.0, `Midget stage 1: bolt at local (${local.x.toFixed(2)}, ${local.y.toFixed(2)}): not his left hand's phone`);
      c.expect(q.visual.muzzleSocketed(q.muzzleIndex('bolt')), 'Midget stage 1: phone not riding his hand');
      c.expect(q.visual.muzzleType(q.muzzleIndex('bolt')) === 'phone', 'Midget muzzle is not a phone');
    });
    // Stages 2 and 3: a phone in each hand, shots alternate; stage 3's are drawn in his fists.
    for (const stage of [1, 2]) {
      withStage(c, game, boss, stage, () => {
        for (const [w, f] of [[game.partner, partner], [game.enemy, boss]] as const) {
          place(game, w, w === game.partner ? -3 : 2, 6, Math.PI, game.player);
          const sides: number[] = [];
          for (let i = 0; i < 4; i++) {
            const idx = w.muzzleIndex('bolt');
            const name = w.visual.muzzles!.points[idx].name;
            const from = castFrom(c, w, 'bolt');
            dataPoint(w, f, stage, name, exp);
            c.expect(!!from && from.distanceTo(exp) < TIGHT, `${f.id} stage ${stage + 1}: bolt ${i} off its ${name}`);
            sides.push(Math.sign(toLocal(w, from!, local).x));
            c.step(S.bolt.fireInterval);
          }
          c.expect(sides[0] !== sides[1] && sides[0] === sides[2] && sides[1] === sides[3], `${f.id} stage ${stage + 1}: phones fired ${sides.join()} (want them to alternate)`);
          if (stage === 2) c.expect(w.visual.muzzleProp(0) && w.visual.muzzleProp(1), `${f.id} stage 3: no phones drawn in the fists`);
        }
      });
    }
    c.expect(game.spells.muzzleFx.counts.phone > 0, 'no phone effects played');
  });

  qa.add('muzzles.player_staff_hits_what_the_crosshair_is_on', (c) => {
    const p = game.player, e = game.enemy, rig = game.rig;
    const aimAt = (target: THREE.Vector3) => {
      // Turn the camera until its forward ray goes through `target` (the camera orbits as it turns).
      rig.snap(p.pos, Math.atan2(target.x - p.pos.x, target.z - p.pos.z));
      for (let i = 0; i < 6; i++) {
        rig.update(1, p.pos, game.physics, false, false);
        const cam = rig.camera.position;
        const dx = target.x - cam.x, dy = target.y - cam.y, dz = target.z - cam.z;
        rig.yaw = Math.atan2(dx, dz);
        rig.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      }
      rig.update(1, p.pos, game.physics, false, false);
      p.facing = p.intent.facing = rig.yaw;
      (game.playerController as unknown as { updateAim(pad: boolean): void }).updateAim(false);
    };
    const target = v3(), cross = v3(), from = v3(), dir = v3();
    let shots = 0, hits = 0;
    const misses: string[] = [];
    // Near, far, wide; the crosshair on the chest, the hips and the shoulder.
    for (const [x, z] of [[0, 5], [3, 9], [-6, 12], [8, 18], [-2, 26], [10, 4]]) {
      for (const dy of [0, -0.55, 0.35]) {
        c.setup({ player: [0, -6], enemy: [x, z - 6] });
        e.chest(target).y += dy;
        aimAt(target);
        // The crosshair really is on the target: the camera ray reaches the enemy's capsule.
        rig.getForward(dir);
        const hit = game.physics.raycast(rig.camera.position, dir, 90, GROUP.WORLD | GROUP.WIZARD | GROUP.GROUND, p.collider);
        if (!hit || hit.tag.kind !== 'wizard' || hit.tag.wizard !== e) continue;
        cross.copy(p.aimPoint);
        p.castPoint('bolt', from);
        // Cover between the staff and the target (parallax from the shoulder camera) is not a miss.
        dir.subVectors(cross, from);
        const len = dir.length();
        if (game.physics.raycast(from, dir.divideScalar(len), len, GROUP.WORLD)) continue;
        const hp = e.health;
        p.intent.press('bolt');
        c.step(0.9);
        shots++;
        if (e.health < hp) hits++;
        else misses.push(`(${x},${z}) dy ${dy}: from (${from.x.toFixed(2)},${from.y.toFixed(2)},${from.z.toFixed(2)}) to (${cross.x.toFixed(2)},${cross.y.toFixed(2)},${cross.z.toFixed(2)})`);
      }
    }
    c.expect(shots >= 15, `only ${shots} placements had the crosshair on the target`);
    c.expect(hits === shots, `${shots - hits}/${shots} staff bolts missed what the crosshair was on: ${misses.join('; ')}`);
    c.note(`${hits}/${shots} hit from the staff orb`);
  });

  qa.add('muzzles.never_spawn_inside_cover', (c) => {
    // Casters hugging cover in every boss arena, including the one whose cannon sticks out 1.2 m.
    const arena = game.arena;
    const themes: ArenaThemeId[] = ['desert', 'void', 'city', 'office', 'volcano'];
    const q = v3(), n = v3(), axis = v3(), span = v3();
    let tests = 0, pulled = 0;
    const notes: string[] = [];
    const check = (w: Wizard, label: string) => {
      for (const spell of ['bolt', 'blast'] as const) {
        const ideal = w.castPoint(spell, v3());
        const from = castFrom(c, w, spell);
        c.expect(!!from, `${label}: no ${spell}`);
        tests++;
        if (from!.distanceTo(ideal) > 1e-3) pulled++;
        // Nothing solid between the caster's own axis and the spawn point (so not inside, not beyond).
        axis.set(w.pos.x, from!.y, w.pos.z);
        span.subVectors(from!, axis);
        const len = span.length();
        if (len > 1e-3) {
          const hit = game.physics.raycast(axis, span.divideScalar(len), len, GROUP.WORLD);
          c.expect(!hit, `${label}: ${spell} spawned ${hit ? (len - hit.distance).toFixed(2) : 0} m into a ${hit?.tag.kind}`);
        }
        for (const p of arena.pillars) {
          if (p.alive && p.active) c.expect(partGap(p, from!) > 1e-3, `${label}: ${spell} spawned inside a ${p.shape.kind}`);
        }
        c.expect(Math.hypot(from!.x, from!.z) < CONFIG.arena.wallRadius, `${label}: ${spell} spawned beyond the wall`);
        game.spells.clear();
      }
    };
    const casters: [BossDef | null, number][] = [[null, 0], [byId('broccoli'), 2], [byId('agent'), 2], [byId('tinubu'), 2]];
    const start = arena.theme, dev = arena.devTheme;
    arena.devTheme = null;
    try {
      for (const [boss, stage] of casters) {
        const run = () => {
          const w = boss ? game.enemy : game.player;
          const other = boss ? game.player : game.enemy;
          for (const id of themes) {
            void arena.applyTheme(id);
            const list = arena.pillars.filter((p) => p.alive && p.active && p.shape.height > 0.8);
            for (const p of list.slice(0, 6)) {
              // Stand on its side toward the arena centre, pressed against it, facing it.
              const r0 = Math.hypot(p.position.x, p.position.z);
              const ux = r0 > 0.5 ? -p.position.x / r0 : 1, uz = r0 > 0.5 ? -p.position.z / r0 : 0;
              const sx = p.position.x + ux * 8, sz = p.position.z + uz * 8;
              p.closestPoint(sx, sz, q);
              n.set(sx - q.x, 0, sz - q.z);
              if (n.lengthSq() < 1e-6) continue;
              n.normalize();
              const x = q.x + n.x * (w.radius + 0.03), z = q.z + n.z * (w.radius + 0.03);
              if (arena.pillars.some((o) => o.alive && o.active && o.surfaceDistance(x, z) < w.radius)) continue;
              place(game, other, x + n.x * 8, z + n.z * 8, 0, w);
              place(game, w, x, z, Math.atan2(-n.x, -n.z), other);
              w.aimPoint.set(q.x - n.x * 3, 1.2, q.z - n.z * 3);
              check(w, `${boss?.id ?? 'player'}${boss ? stage + 1 : ''} at a ${id} ${p.shape.kind}`);
            }
            // Backed up against the arena wall, facing out, somewhere no cover stands.
            const r = CONFIG.arena.wallRadius - w.radius - 0.03;
            for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
              const x = Math.sin(a) * r, z = Math.cos(a) * r;
              if (arena.pillars.some((o) => o.alive && o.active && o.surfaceDistance(x, z) < 2)) continue;
              place(game, other, x * 0.5, z * 0.5, 0, w);
              place(game, w, x, z, a, other);
              w.aimPoint.set(Math.sin(a) * (r + 5), 1.2, Math.cos(a) * (r + 5));
              check(w, `${boss?.id ?? 'player'} at the ${id} wall`);
              break;
            }
          }
          notes.push(`${boss?.id ?? 'player'} ok`);
        };
        if (boss) withStage(c, game, boss, stage, run);
        else {
          c.setup();
          run();
        }
      }
    } finally {
      void arena.applyTheme(start);
      arena.devTheme = dev;
    }
    c.expect(pulled > 0, 'no spawn point ever needed pulling back (the hug placement is wrong)');
    c.note(`${tests} hugging casts, ${pulled} pulled back clear of cover; ${notes.join(', ')}`);
  });

  qa.add('muzzles.fx_pooled', (c) => {
    const scene = game.renderer.scene;
    const mfx = game.spells.muzzleFx;
    const before = { children: scene.children.length, lights: mfx.stats().lights, bubbles: mfx.stats().bubbles };
    const objects = new Map<Wizard, number>();
    let frames = 0;
    const render = (seconds: number) => {
      for (let t = 0; t < seconds; t += 1 / 30) {
        for (const w of game.wizards) w.visual.update(w, 1 / 30, 1);
        game.spells.sync(1, t, 1 / 30);
        game.fx.update(1 / 30);
        frames++;
      }
    };
    const counts0 = { ...mfx.counts };
    for (const [boss, stage] of [[byId('sahil'), 0], [byId('obama'), 1], [byId('broccoli'), 0], [byId('broccoli'), 2], [byId('agent'), 2], [byId('tinubu'), 1]] as const) {
      withStage(c, game, boss, stage, () => {
        for (const w of game.enemies) objects.set(w, w.visual.muzzleObjects);
        for (let round = 0; round < 4; round++) {
          for (const w of [game.player, ...game.enemies]) {
            castFrom(c, w, 'bolt');
            castFrom(c, w, 'blast');
          }
          const volley = boss.stages[stage].attacks.volley ?? { name: 'QA', count: 7, spreadDeg: 7, interval: 0.07, cooldown: 1, damageScale: 0.4 };
          game.enemy.mana = W.maxMana;
          game.spells.castVolley(game.enemy, volley);
          for (let k = 0; k < 15; k++) {
            c.step(DT * 2);
            render(1 / 30);
          }
          render(0.5);
          c.expect(mfx.stats().bubblesActive <= mfx.stats().bubbles, 'bubble pool overflowed');
        }
        for (const w of game.enemies) c.expect(w.visual.muzzleObjects === objects.get(w), `${boss.id}: muzzle objects grew`);
        game.spells.clear(); // nothing in flight, so the boss's object looks are freed on restore
      });
    }
    render(2);
    const st = mfx.stats();
    c.expect(scene.children.length === before.children, `scene grew from ${before.children} to ${scene.children.length} objects`);
    c.expect(st.lights === before.lights && st.bubbles === before.bubbles, `muzzle pools changed: ${st.lights}/${st.bubbles}`);
    c.expect(st.bubblesActive === 0, `${st.bubblesActive} bubbles never popped`);
    const played = (Object.keys(mfx.counts) as (keyof typeof mfx.counts)[]).filter((k) => mfx.counts[k] > counts0[k]);
    for (const t of ['staff', 'phone', 'vape', 'gun', 'hand', 'mouth']) c.expect(played.includes(t), `no ${t} effect played`);
    c.expect(game.fx.sparks.alive <= game.fx.sparks.capacity && game.fx.smoke.alive <= game.fx.smoke.capacity, 'particles past capacity');
    c.note(`${frames} frames; casts by type ${played.map((k) => `${k} ${mfx.counts[k] - counts0[k]}`).join(', ')}; scene ${scene.children.length} objects`);
  });

  qa.add('muzzles.charge_glow_sits_at_the_muzzle', (c) => {
    const glow = v3(), anchor = v3();
    // The player's staff orb charges a blast; Tinubu's palm and mouth both charge the Ultimate.
    c.setup();
    const p = game.player;
    p.mana = W.maxMana;
    p.intent.press('blast');
    c.step(S.blast.castTime * 0.6);
    c.expect(!!p.cast, 'no blast windup');
    settle(p);
    p.visual.chargeGlowWorld(glow);
    const idx = p.muzzleIndex('blast');
    if (idx >= 0) p.visual.muzzleWorld(idx, anchor);
    else p.castPoint('blast', anchor, idx);
    c.expect(glow.distanceTo(anchor) < 0.25, `player charge glow ${glow.distanceTo(anchor).toFixed(2)} m from the staff orb`);
    c.expect(p.visual.lightLevel > 0.2 && p.visual.lightPos.distanceTo(anchor) < 0.05, 'the charging orb asks for no light');
    c.step(0.5);
    withStage(c, game, byId('tinubu'), 1, () => {
      const w = game.enemy;
      w.ult = S.ultimate.chargeMax;
      w.intent.press('ultimate');
      c.step(S.ultimate.castTime * 0.7);
      c.expect(w.cast?.spell === 'ultimate', 'no Ultimate windup');
      settle(w);
      w.visual.chargeGlowWorld(glow);
      const hand = w.visual.muzzles!.points.findIndex((q) => q.name === 'hand');
      w.visual.muzzleWorld(hand, anchor);
      c.expect(glow.distanceTo(anchor) < 0.4, `Tinubu's charge glow ${glow.distanceTo(anchor).toFixed(2)} m from his palm`);
      c.expect(w.visual.lightLevel > 0.2, 'Tinubu charging: no muzzle light');
    });
  });

  qa.add('muzzles.placeholders_and_missing_glbs', (c) => {
    const orig = game.assets.instantiate.bind(game.assets);
    const stageKeys = new Set<ModelKey>(BOSSES.flatMap((b) => bossFighters(b).flatMap((f) => f.stages.map((s) => s.model))));
    const exp = v3(), local = v3();
    const notes: string[] = [];
    // No boss GLBs at all: every boss and The Midget fire from the placeholder's own prop.
    game.assets.instantiate = (key) => (stageKeys.has(key) ? null : orig(key));
    try {
      for (const boss of BOSSES) {
        game.setupEnemy(null);
        for (const stage of [0, 1]) {
          withStage(c, game, boss, stage, () => {
            bossFighters(boss).forEach((f, i) => {
              const w = i === 0 ? game.enemy : game.partner;
              c.expect(!w.visual.usesModel, `${f.id}: a GLB showed while missing`);
              place(game, w, i === 0 ? 2 : -3, 6, Math.PI - 0.4, game.player);
              const pt = Object.values(PLACEHOLDER_MUZZLES[f.id].points)[0];
              const k = w.visual.fxScale; // the placeholder's own scale-down (The Midget)
              const scale = w.visual.root.scale.x;
              muzzleLocal(pt.at, 1, k * scale, local);
              toWorld(w, local, exp);
              const from = castFrom(c, w, 'bolt');
              c.expect(!!from && from.distanceTo(exp) < TIGHT, `${f.id} placeholder stage ${stage + 1}: bolt ${from ? from.distanceTo(exp).toFixed(3) : 'none'} m from its ${pt.type}`);
              if (stage === 1) c.expect(Math.abs(scale - C.placeholderScale[1]) < 1e-6, `${f.id}: placeholder stage 2 scale ${scale}`);
              settle(w);
              const idx = w.muzzleIndex('bolt');
              w.visual.muzzleWorld(idx, local);
              c.expect(local.distanceTo(exp) < POSE + 0.02, `${f.id} placeholder: prop anchor ${local.distanceTo(exp).toFixed(3)} m from the spawn`);
            });
          });
        }
        notes.push(boss.id);
      }
    } finally {
      game.assets.instantiate = orig;
      game.setupEnemy(null);
    }
    // Only stage 2's GLB: stage 3 keeps it, grown, and fires from stage 2's staff gem.
    const sahil = byId('sahil');
    game.assets.instantiate = (key) => (key === sahil.stages[1].model ? orig(key) : stageKeys.has(key) ? null : orig(key));
    try {
      game.setupEnemy(null);
      withStage(c, game, sahil, 2, () => {
        const w = game.enemy;
        c.expect(w.visual.usesModel && Math.abs(w.visual.root.scale.x - C.placeholderScale[2] / C.placeholderScale[1]) < 1e-6, `Sahil stage 3 on stage 2's model: scale ${w.visual.root.scale.x}`);
        place(game, w, 2, 6, Math.PI, game.player);
        const from = castFrom(c, w, 'bolt');
        dataPoint(w, sahil, 1, 'staff', exp);
        c.expect(!!from && from.distanceTo(exp) < TIGHT, `Sahil stage 3 (stage 2 model, grown): bolt ${from ? from.distanceTo(exp).toFixed(3) : 'none'} m from the gem`);
      });
    } finally {
      game.assets.instantiate = orig;
      game.setupEnemy(null);
    }
    // The player: placeholder staff without the GLB, the generic wand with an unknown GLB.
    const p = game.player;
    try {
      c.setup();
      p.visual.setAppearance(p.team, null, MODELS.wizardPlayer, 'wizard');
      const pt = PLACEHOLDER_MUZZLES.wizard.points.staff;
      toWorld(p, muzzleLocal(pt.at, 1, 1, local), exp);
      let from = castFrom(c, p, 'bolt');
      c.expect(!!from && from.distanceTo(exp) < TIGHT, `player placeholder: bolt ${from ? from.distanceTo(exp).toFixed(3) : 'none'} m from its staff`);
      p.visual.setAppearance(p.team, fakeModel(), { path: 'models/qa_unknown.glb', fitHeight: 1.9 }, 'wizard');
      c.expect(p.visual.muzzles === null && p.muzzleIndex('bolt') === -1, 'an unknown GLB has muzzles');
      const k = p.sizeScale;
      toWorld(p, local.set(-0.34 * k, 1.36 * k, 0.72 * k), exp);
      from = castFrom(c, p, 'bolt');
      c.expect(!!from && from.distanceTo(exp) < TIGHT, `unknown GLB: bolt ${from ? from.distanceTo(exp).toFixed(3) : 'none'} m from the generic wand point`);
    } finally {
      p.visual.setAppearance(p.team, game.assets.instantiate('wizardPlayer'), MODELS.wizardPlayer, 'wizard');
    }
    c.expect(p.visual.usesModel === (game.assets.instantiate('wizardPlayer') !== null), 'player look not restored');
    c.note(`placeholders: ${notes.join(', ')}; partial GLBs and generic wand ok`);
  });

  qa.add('camera.boss_model_never_hides_player', (c) => {
    withStage(c, game, byId('tinubu'), 2, () => {
      const p = game.player, e = game.enemy, rig = game.rig, cam = rig.camera;
      c.expect(e.visual.usesModel, 'no stage 3 Tinubu GLB to test with');
      const ray = new THREE.Raycaster();
      const chest = v3(), dir = v3(), v = v3();
      const notes: string[] = [];
      let blockedCount = 0, insideCount = 0;
      const view = () => {
        game.physics.step();
        for (const w of [p, e]) w.visual.update(w, 0, 1);
        rig.snap(p.pos, 0);
        for (let i = 0; i < 3; i++) rig.update(1, p.visual.root.position, game.physics, false, false);
        cam.updateMatrixWorld();
        e.visual.root.updateMatrixWorld(true);
        game.updateOcclusionFade(1);
      };
      for (const d of [0.5, 1, 1.5, 2, 3, 4, 5]) {
        for (const side of [0, 0.8, -1.2]) {
          p.spawn(0, -1, 0);
          e.spawn(side, -1 - d, 0);
          view();
          const fade = e.visual.fade;
          const meshes = e.visual.lookMeshes();
          // Nothing of the boss within 0.35 m of the camera may render (the near plane is 6 cm).
          let near = Infinity;
          for (const m of meshes) {
            const pos = m.geometry.attributes.position;
            for (let i = 0; i < pos.count; i++) near = Math.min(near, v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).distanceTo(cam.position));
          }
          if (near < 0.35) {
            insideCount++;
            c.expect(fade === 0, `boss ${d} m behind (side ${side}): camera ${near.toFixed(2)} m from its mesh but fade ${fade.toFixed(2)}`);
          }
          // Between the camera and the player: see-through.
          let blocked = false;
          for (const y of [1.2, 1.75]) {
            chest.set(p.pos.x, p.pos.y + y, p.pos.z);
            dir.subVectors(chest, cam.position);
            const len = dir.length();
            ray.set(cam.position, dir.divideScalar(len));
            ray.far = len;
            if (ray.intersectObjects(meshes, false).length) blocked = true;
          }
          if (blocked) {
            blockedCount++;
            c.expect(fade <= FADE.occluded + 1e-3, `boss ${d} m behind (side ${side}) hides the player at fade ${fade.toFixed(2)}`);
          }
          notes.push(`${d}/${side}:${fade.toFixed(2)}${blocked ? 'b' : ''}${near < 0.35 ? 'i' : ''}`);
        }
      }
      c.expect(blockedCount > 5, `only ${blockedCount} placements put the boss in the way: the test is not testing`);
      // Off to the side, far from the camera: solid again.
      p.spawn(0, -1, 0);
      e.spawn(9, 6, Math.PI);
      view();
      c.expect(e.visual.fade === 1, `a boss clear of the view stays faded (${e.visual.fade.toFixed(2)})`);
      c.expect(p.visual.fade === 1, 'the player faded');
      c.note(`${blockedCount} in the way, ${insideCount} at the camera; ${notes.join(' ')}`);
    });
  });

  qa.add('visual.lean_keeps_wide_models_on_the_floor', (c) => {
    const notes: string[] = [];
    for (const [id, stage] of [['tinubu', 2], ['sahil', 2], ['broccoli', 2]] as const) {
      withStage(c, game, byId(id), stage, () => {
        const e = game.enemy, vis = e.visual;
        e.spawn(0, 6, 0);
        // A static mesh: its lowest point after a second. A rigged look's clips swing hems, staffs and
        // feet on their own, so there: the lowest point over a run cycle, measured against the same
        // clips with the procedural motion off (what the lean adds is what this checks).
        const pose = () => {
          let low = Infinity;
          for (let i = 0; i < 90; i++) {
            vis.update(e, 1 / 60, 1);
            if (i === 89 || (vis.rigged && i >= 50 && i % 2 === 0)) low = Math.min(low, vis.lookBottom());
          }
          return low;
        };
        const floor = (vx: number, vz: number) => {
          if (!vis.rigged) return 0;
          vis.proceduralOff = true;
          e.vel.set(vx, 0, vz);
          const low = pose();
          vis.proceduralOff = false;
          return low;
        };
        e.vel.set(0, 0, 0);
        const still = pose() - floor(0, 0);
        // A rigged idle plants its feet by itself, within a few cm (Broccoli Head stage 3 sits ~3 cm deep).
        c.expect(Math.abs(still) < (vis.rigged ? 0.04 : 0.03), `${id}: standing, its lowest point is at ${still.toFixed(3)} m`);
        let worst = Infinity, lift = 0;
        // Sprinting every way, and a knockback slide faster than a sprint.
        for (const [vx, vz] of [[0, 9.6], [0, -9.6], [9.6, 0], [-9.6, 0], [6.8, 6.8], [-6.8, -6.8], [0, 15], [15, 0]]) {
          const base = floor(vx, vz);
          e.vel.set(vx, 0, vz);
          const low = pose() - base;
          worst = Math.min(worst, low);
          lift = Math.max(lift, vis.leanLift);
          // (A rigged look's two windows catch its clips at different phases: a little more slack.)
          c.expect(low > (vis.rigged ? -0.05 : -0.03), `${id}: leaning at (${vx}, ${vz}) m/s its lowest point is ${(-low * 100).toFixed(1)} cm under the floor${vis.rigged ? ' (below its clip pose)' : ''}`);
          // Wide bosses lean less instead of hopping up: the lift stays small (10 cm a side, both on a diagonal).
          const diagonal = vx !== 0 && vz !== 0;
          c.expect(vis.leanLift < (diagonal ? 0.22 : 0.12), `${id}: leaning at (${vx}, ${vz}) m/s lifts it ${(vis.leanLift * 100).toFixed(1)} cm`);
        }
        e.vel.set(0, 0, 0);
        pose();
        notes.push(`${id}${stage + 1}${vis.rigged ? ' (rigged, vs its clips)' : ''} lowest ${(worst * 100).toFixed(1)} cm (lift up to ${(lift * 100).toFixed(1)} cm)`);
      });
    }
    c.note(notes.join(', '));
  });
}
