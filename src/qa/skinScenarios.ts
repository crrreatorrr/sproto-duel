import * as THREE from 'three';
import { CONFIG, type TeamPalette } from '../config';
import type { App } from '../App';
import { SOUNDS, type SoundKey } from '../assets/manifest';
import { skinSound } from '../audio/AudioManager';
import { BOSSES, type BossDef } from '../campaign/levels';
import { events, type GameEvents } from '../core/events';
import type { Game } from '../core/Game';
import type { Projectile } from '../spells/Projectile';
import { OBJECT_SKINS } from '../spells/ProjectileSkins';
import type { Wizard } from '../wizard/Wizard';
import type { QAHarness } from './QAHarness';

const S = CONFIG.spells;
const DT = CONFIG.sim.fixedDt;

type Ctx = Parameters<Parameters<QAHarness['add']>[1]>[0];
type Skins = Wizard['skins'];

const byName = (id: string): BossDef => BOSSES.find((b) => b.id === id)!;

/** The newest live projectile of `kind` cast by `w`. */
function lastCast(game: Game, w: Wizard, kind: 'bolt' | 'blast'): Projectile | undefined {
  const list = game.spells.pool.active.filter((p) => p.caster === w && p.kind === kind);
  return list.sort((a, b) => a.age - b.age)[0];
}

/** Make `w` cast `kind` now (blasts wind up first) and return the projectile. */
function cast(c: Ctx, game: Game, w: Wizard, kind: 'bolt' | 'blast'): Projectile | undefined {
  w.intent.press(kind);
  c.step(kind === 'bolt' ? DT * 2 : S.blast.castTime + DT * 3);
  return lastCast(game, w, kind);
}

/** Collect `skinLaunch` events while `fn` runs. */
function launches(fn: () => void): GameEvents['skinLaunch'][] {
  const got: GameEvents['skinLaunch'][] = [];
  const off = events.on('skinLaunch', (e) => got.push({ ...e, pos: e.pos.clone() }));
  try {
    fn();
  } finally {
    off();
  }
  return got;
}

/** Instanced skin meshes currently in the scene, by name. */
function skinMeshes(game: Game): string[] {
  const out: string[] = [];
  game.renderer.scene.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh && o.name.startsWith('skin:')) out.push(o.name);
  });
  return out.sort();
}

/**
 * Boss projectile skins (src/spells/ProjectileSkins.ts): objects picked from the caster, kept
 * through reflects, pooled per skin, purely visual (same hitboxes and hits), with launch cues.
 */
export function registerSkinScenarios(qa: QAHarness, game: Game, app: App): void {
  /** Run with the rival dressed as `boss` (null = default rival), then restore the previous look. */
  const withBoss = (boss: BossDef | null, fn: () => void) => {
    const prev = game.boss;
    try {
      game.setupEnemy(boss);
      fn();
    } finally {
      game.setupEnemy(prev);
    }
  };
  /** Run with `w` throwing `skins`, then restore (and free the looks it no longer uses). */
  const withSkins = (w: Wizard, skins: Skins, fn: () => void) => {
    const prev = w.skins;
    try {
      w.skins = skins;
      fn();
    } finally {
      w.skins = prev;
      game.spells.pool.releaseAll();
      game.spells.pool.prepareSkins(w.index, prev);
    }
  };

  qa.add('skins.boss_bolts_and_blasts', (c) => {
    const seen: string[] = [];
    for (const boss of BOSSES) {
      withBoss(boss, () => {
        c.setup();
        const e = game.enemy;
        c.expect(e.skins === boss.skins, `${boss.id}: setupEnemy did not give the rival the boss's skins`);
        // Checked as soon as each is in flight (a recycled projectile goes back to 'orb').
        const look = (kind: 'bolt' | 'blast') => {
          const p = cast(c, game, e, kind);
          c.expect(!!p && p.skin === boss.skins[kind] && !!p.skinSlot, `${boss.id}: ${kind} is ${p?.skin}, expected ${boss.skins[kind]}`);
          c.expect(p!.radius === S[kind].radius, `${boss.id}: ${kind} hitbox radius changed`);
          return p!.skin;
        };
        let got = '';
        const ev = launches(() => {
          got = `${look('bolt')}/${look('blast')}`;
        });
        const kinds = ev.map((x) => `${x.kind}:${x.skin}`).join(',');
        c.expect(kinds === `bolt:${boss.skins.bolt},blast:${boss.skins.blast}` && ev.every((x) => x.wizard === e), `${boss.id}: launch events ${kinds}`);
        seen.push(`${boss.id}=${got}`);
      });
    }
    c.expect(byName('obama').skins.blast === 'pig' && byName('sahil').skins.blast === 'carpet', 'Obama throws pigs, Sahil carpets');
    c.note(seen.join(' '));
  });

  qa.add('skins.every_skin_spawns', (c) => {
    // Every object look works for both kinds, on any wizard (here the player).
    const p = game.player;
    for (const skin of OBJECT_SKINS) {
      withSkins(p, { bolt: skin, blast: skin }, () => {
        c.setup();
        for (const kind of ['bolt', 'blast'] as const) {
          const shot = cast(c, game, p, kind);
          c.expect(shot?.skin === skin, `${skin}: ${kind} came out as ${shot?.skin}`);
          game.spells.sync(1, 1, DT); // poses every instance once
          // The drawn object rides its projectile (carpets bob a few centimetres).
          const at = game.spells.pool.skins.instancePosition(shot!.skinSlot!, new THREE.Vector3());
          c.expect(at.distanceTo(shot!.group.position) < 0.08, `${skin}: ${kind} instance not at its projectile (${at.toArray()})`);
        }
      });
    }
    c.note(`${OBJECT_SKINS.length} skins incl. pig: ${OBJECT_SKINS.includes('pig')}`);
  });

  qa.add('skins.orb_for_player_and_quick_duel', (c) => {
    withBoss(byName('agent'), () => {
      c.setup();
      for (const w of game.wizards) if (w !== game.enemy) c.expect(w.skins === null, `wizard ${w.index} has skins with a boss on`);
      for (const kind of ['bolt', 'blast'] as const) {
        const shot = cast(c, game, game.player, kind);
        c.expect(!!shot && shot.skin === 'orb' && !shot.skinSlot, `player ${kind} is ${shot?.skin}`);
      }
    });
    withBoss(null, () => {
      c.setup();
      c.expect(game.wizards.every((w) => w.skins === null), 'Quick Duel rival still has skins');
      const ev = launches(() => {
        for (const kind of ['bolt', 'blast'] as const) {
          const shot = cast(c, game, game.enemy, kind);
          c.expect(!!shot && shot.skin === 'orb', `rival ${kind} is ${shot?.skin}`);
        }
      });
      c.expect(ev.length === 0, `${ev.length} object launches from orbs`);
      c.setup();
      game.setupEnemy(null); // with nothing in flight, the boss's looks are freed
      const kept = game.spells.pool.skins.stats().skins.filter((k) => k.endsWith(`:${game.enemy.index}`));
      c.expect(kept.length === 0, `rival skin batches kept in Quick Duel: ${kept}`);
    });
  });

  qa.add('skins.by_caster_any_wizard', (c) => {
    // The look comes from the caster, whoever it is: the player throwing phones and pigs...
    withSkins(game.player, { bolt: 'phone', blast: 'pig' }, () => {
      c.setup();
      c.expect(cast(c, game, game.player, 'bolt')?.skin === 'phone', 'player bolt is not a phone');
      c.expect(cast(c, game, game.player, 'blast')?.skin === 'pig', 'player blast is not a pig');
    });
    // ...and a wizard index beyond the two built-in teams (a third wizard), in its own palette.
    c.setup();
    const pool = game.spells.pool;
    const palette: TeamPalette = { ...CONFIG.teams[1], name: 'Third', spell: 0x33ff99, blast: 0xff33cc };
    const third = { index: 2, team: palette, skins: { bolt: 'bullet', blast: 'grenade' } } as unknown as Wizard;
    const spawn = (kind: 'bolt' | 'blast') => {
      const p = pool.spawn(kind)!;
      p.owner = p.caster = third;
      p.pos.set(0, 1.4, 0);
      p.prevPos.copy(p.pos);
      p.vel.set(0, 0, 10);
      p.radius = S[kind].radius;
      p.life = 1;
      p.refreshLook();
      return p;
    };
    const b = spawn('bolt'), g = spawn('blast');
    c.expect(b.skin === 'bullet' && g.skin === 'grenade', `third wizard threw ${b.skin}/${g.skin}`);
    c.expect(pool.skins.stats().skins.includes('bullet:2'), `no batch for wizard 2: ${pool.skins.stats().skins}`);
    const want = new THREE.Color(palette.spell).multiplyScalar(1.8);
    const got = pool.teamBoltColor(2);
    c.expect(Math.abs(got.r - want.r) + Math.abs(got.g - want.g) + Math.abs(got.b - want.b) < 1e-3, 'third wizard glow not in its palette');
    pool.release(b);
    pool.release(g);
    pool.prepareSkins(2, null);
    c.expect(!pool.skins.stats().skins.some((k) => k.endsWith(':2')), 'idle third-wizard batches not freed');
  });

  qa.add('skins.reflect_keeps_skin', (c) => {
    withBoss(byName('obama'), () => {
      const e = game.enemy, p = game.player;
      // Perfect shield: the phone flies back at Obama, still a phone, now in the player's glow.
      c.setup();
      const phone = cast(c, game, e, 'bolt')!;
      c.step(0.08);
      p.intent.press('shield');
      let reflected = false;
      c.step(0.6, () => {
        if (phone.active && phone.reflected && !reflected) {
          reflected = true;
          c.expect(phone.skin === 'phone' && !!phone.skinSlot && phone.owner === p && phone.caster === e, `reflected bolt is ${phone.skin}`);
        }
      });
      c.expect(reflected && p.stats.perfects === 1, `no perfect reflect (perfects=${p.stats.perfects})`);
      c.expect(e.health < e.maxHealth, 'reflected phone did not hit Obama');
      // A late shield deflects instead: still a phone.
      c.setup();
      p.intent.press('shield');
      c.step(0.3);
      const late = cast(c, game, e, 'bolt')!;
      let deflected = false;
      c.step(0.4, () => {
        if (late.active && late.owner === p) {
          deflected = true;
          c.expect(late.skin === 'phone', `deflected bolt is ${late.skin}`);
        }
      });
      c.expect(deflected, 'late block did not deflect the phone');
      // A perfectly reflected pig is still a pig.
      c.setup();
      const pig = cast(c, game, e, 'blast')!;
      c.step(0.3);
      p.intent.press('shield');
      let pigBack = false;
      c.step(0.8, () => {
        if (pig.active && pig.reflected) pigBack ||= pig.skin === 'pig';
      });
      c.expect(pigBack, 'reflected pig changed look or never reflected');
    });
  });

  qa.add('skins.pool_reuse_no_leaks', (c) => {
    const pool = game.spells.pool;
    const e = game.enemy;
    withBoss(byName('agent'), () => {
      c.setup();
      const meshes = skinMeshes(game);
      const stats0 = pool.skins.stats();
      c.expect(stats0.skins.includes(`bullet:${e.index}`) && stats0.skins.includes(`grenade:${e.index}`), `boss skins not prepared: ${stats0.skins}`);
      e.mana = 1e6;
      c.step(6, () => {
        e.intent.holdBolt = true;
        e.mana = 1e6;
        if (e.cd.blast <= 0) e.intent.press('blast');
      });
      e.intent.holdBolt = false;
      const casts = e.stats.casts;
      c.expect(casts > 30, `only ${casts} casts`);
      c.expect(pool.skins.stats().batches === stats0.batches && skinMeshes(game).join() === meshes.join(), 'skin batches/meshes grew while firing');
      c.step(S.blast.lifetime + 0.3);
      c.expect(pool.active.length === 0 && pool.skins.stats().active === 0, `leaked: ${pool.active.length} projectiles, ${pool.skins.stats().active} instances`);
      c.note(`${casts} casts, meshes ${meshes.length}`);
    });
    // Cycle every boss twice: batches follow the current boss and never pile up.
    let peak = 0;
    for (let round = 0; round < 2; round++) {
      for (const boss of BOSSES) {
        withBoss(boss, () => {
          c.setup();
          cast(c, game, e, 'bolt');
          cast(c, game, e, 'blast');
          peak = Math.max(peak, skinMeshes(game).length);
          c.step(S.blast.lifetime + 0.3);
        });
      }
    }
    withBoss(null, () => {
      c.expect(!pool.skins.stats().skins.some((k) => k.endsWith(`:${e.index}`)), `rival batches kept after Quick Duel: ${pool.skins.stats().skins}`);
    });
    c.expect(peak <= 4, `up to ${peak} skin meshes for one boss`);
    c.note(`peak meshes per boss ${peak}`);
  });

  qa.add('skins.stun_ultimate_unchanged', (c) => {
    withBoss(byName('tinubu'), () => {
      const e = game.enemy, p = game.player;
      c.setup();
      const ev = launches(() => {
        e.intent.press('stun');
        c.step(S.stun.castTime + 0.05);
        c.expect(p.stunned, 'boss stun beam missed');
        c.expect(game.spells.pool.active.length === 0, 'stun spawned a projectile');
        c.setup();
        e.ult = S.ultimate.chargeMax;
        e.intent.press('ultimate');
        c.step(S.ultimate.castTime + 0.6);
        c.expect(p.health < p.maxHealth, 'boss ultimate wave missed');
        c.expect(game.spells.pool.active.length === 0, 'ultimate spawned a projectile');
      });
      c.expect(ev.length === 0, `${ev.length} object launches from stun/ultimate`);
    });
  });

  qa.add('skins.hitbox_unchanged', (c) => {
    // Same flight, same tick of impact, same damage as the orb, for every object.
    const ticksToHit = (skins: Skins, kind: 'bolt' | 'blast'): [number, number] => {
      let out: [number, number] = [-1, 0];
      withSkins(game.player, skins, () => {
        c.setup();
        const full = game.enemy.health;
        if (kind === 'blast') game.player.aimPoint.y = 1.0;
        game.player.intent.press(kind);
        for (let t = 1; t < 120; t++) {
          c.step(DT);
          if (game.enemy.health < full) {
            out = [t, full - game.enemy.health];
            break;
          }
        }
      });
      return out;
    };
    for (const kind of ['bolt', 'blast'] as const) {
      const orb = ticksToHit(null, kind);
      c.expect(orb[0] > 0, `orb ${kind} never hit`);
      for (const skin of OBJECT_SKINS) {
        const got = ticksToHit({ bolt: skin, blast: skin }, kind);
        c.expect(got[0] === orb[0] && Math.abs(got[1] - orb[1]) < 1e-6, `${skin} ${kind}: hit on tick ${got[0]} for ${got[1]}, orb tick ${orb[0]} for ${orb[1]}`);
      }
      c.note(`${kind} hits on tick ${orb[0]} for ${orb[1]}`);
    }
  });

  qa.add('skins.launch_sounds_and_cues', (c) => {
    for (const skin of OBJECT_SKINS) c.expect(skinSound(skin) in SOUNDS, `${skin}: no sound`);
    const audio = app.audio;
    const played: SoundKey[] = [];
    const realPlay = audio.play;
    const realMuted = audio.gameplayMuted;
    const fx = game.fx;
    const realFlash = fx.muzzleFlash;
    let flashes = 0;
    audio.play = (key: SoundKey) => {
      played.push(key);
      return null;
    };
    audio.gameplayMuted = false;
    fx.muzzleFlash = function (...args: Parameters<typeof realFlash>) {
      flashes++;
      return realFlash.apply(this, args);
    };
    try {
      withBoss(byName('agent'), () => {
        c.setup();
        cast(c, game, game.enemy, 'bolt');
        c.expect(played.includes('gunshot') && !played.includes('boltCast'), `agent bolt played ${played}`);
        c.expect(flashes === 1, `${flashes} muzzle flashes for one bullet`);
        played.length = 0;
        cast(c, game, game.player, 'bolt');
        c.expect(played.includes('boltCast') && !played.includes('gunshot'), `player bolt played ${played}`);
        c.expect(flashes === 1, 'player orb made a gun flash');
      });
      withBoss(byName('obama'), () => {
        c.setup();
        played.length = 0;
        const pig = cast(c, game, game.enemy, 'blast')!;
        c.expect(played.includes('pigOink') && !played.includes('blastCast'), `pig blast played ${played}`);
        // The pig bursts in a pink puff.
        const smoke = fx.smoke.alive;
        game.spells.pool.release(pig);
        c.expect(fx.smoke.alive > smoke, 'no pink puff when the pig burst');
      });
    } finally {
      audio.play = realPlay;
      audio.gameplayMuted = realMuted;
      fx.muzzleFlash = realFlash;
    }
  });

  qa.add('skins.draw_calls_constant', (c) => {
    // Objects are instanced: 24 rugs and carpets add one sprite each plus two instanced draws.
    withBoss(byName('sahil'), () => {
      c.setup();
      const pool = game.spells.pool;
      const e = game.enemy;
      const list: Projectile[] = [];
      for (let i = 0; i < 24; i++) {
        const kind = i % 4 === 0 ? 'blast' : 'bolt';
        const p = pool.spawn(kind)!;
        p.owner = p.caster = e;
        p.pos.set((i % 6) - 2.5, 1.4, i * 0.3);
        p.prevPos.copy(p.pos);
        p.vel.set(0, 0, -20);
        p.radius = S[kind].radius;
        p.life = 5;
        p.refreshLook();
        list.push(p);
      }
      game.spells.sync(1, 2, DT);
      const st = pool.skins.stats();
      c.expect(st.active === 24 && st.meshes === 2, `instances ${st.active} in ${st.meshes} meshes`);
      const visible = skinMeshes(game).length;
      c.expect(visible === 2, `${visible} skin meshes in the scene`);
      for (const p of list) pool.release(p);
      c.expect(pool.skins.stats().active === 0, 'instances not returned');
    });
  });
}
