import * as THREE from 'three';
import { CONFIG } from '../config';
import type { App } from '../App';
import { BOSSES, bossFighters, type BossDef, type BossFighter, type PowerDef, type PowerKind } from '../campaign/levels';
import { events, type GameEvents } from '../core/events';
import type { Game } from '../core/Game';
import { AIController } from '../enemy/AIController';
import type { Hazard } from '../spells/BossPowers';
import type { Wizard } from '../wizard/Wizard';
import { withSeededRandom } from './campaignScenarios';
import type { QAHarness } from './QAHarness';

const DT = CONFIG.sim.fixedDt;
const P = CONFIG.powers;
const J = CONFIG.wizard.jump;

type Ctx = Parameters<Parameters<QAHarness['add']>[1]>[0];

function record<K extends keyof GameEvents>(type: K): () => GameEvents[K][] {
  const seen: GameEvents[K][] = [];
  const off = events.on(type, (e) => void seen.push({ ...e }));
  return () => {
    off();
    return seen;
  };
}

/** Every power in the roster: its boss (or partner), the fight it is in, its index. */
function allPowers(): { boss: BossDef; fighter: BossFighter; partner: boolean; def: PowerDef; k: number }[] {
  const out: { boss: BossDef; fighter: BossFighter; partner: boolean; def: PowerDef; k: number }[] = [];
  for (const boss of BOSSES) {
    for (const f of bossFighters(boss)) f.powers.forEach((def, k) => out.push({ boss, fighter: f, partner: f !== boss, def, k }));
  }
  return out;
}

/** Run `fn` against `boss` with its stages live, in `stage` (all three bosses' bars full); the rival is restored after. */
function withBoss(c: Ctx, game: Game, boss: BossDef, stage: number, fn: () => void, setup?: Parameters<Ctx['setup']>[0]): void {
  const prev = game.boss;
  game.stages.suspended = game.partnerStages.suspended = false;
  game.setupEnemy(boss);
  try {
    c.setup(setup ?? { player: [0, -6], enemy: [0, 4], partner: [9, 9] });
    for (const st of [game.stages, game.partnerStages]) {
      if (!st.boss || stage === 0) continue;
      st.evolveTo(stage);
      st.release(0);
    }
    c.step(DT);
    fn();
  } finally {
    game.spells.powers.clear();
    game.setupEnemy(prev);
  }
}

/** The wizard playing `fighter` in the current fight. */
const caster = (game: Game, partner: boolean): Wizard => (partner ? game.partner : game.enemy);

/** Use `def` on the player now (recharge reset first). */
function cast(game: Game, w: Wizard, def: PowerDef, stage: number): boolean {
  game.spells.powers.setCooldown(w, def, 0);
  return game.spells.powers.cast(w, def, game.player, stage);
}

/** Power damage the player took (amount and sim time after `t0`) from `w`. */
function powerHits(seen: GameEvents['damage'][], game: Game, w: Wizard): GameEvents['damage'][] {
  return seen.filter((d) => d.target === game.player && d.source === w && (d.kind === 'power' || d.kind === 'toxic') && d.amount > 0);
}

/** The first live hazard of `kind` owned by `w`. */
const hazardOf = (game: Game, w: Wizard, kind?: Hazard['kind']): Hazard | undefined =>
  game.spells.powers.hazards.find((h) => h.active && h.owner === w && (!kind || h.kind === kind));

/**
 * Boss special powers (src/spells/BossPowers.ts): every boss has several, each telegraphed before
 * it hurts, each with its own way out (and rolling through any of them), recharging on its own,
 * unlocking stage by stage, called off by a transformation or a KO, harmless to the boss's own side;
 * the reference AI reads them; the boss plate shows them.
 */
export function registerPowerScenarios(qa: QAHarness, game: Game, app: App): void {
  qa.add('powers.roster_distinct_and_staged', (c) => {
    const kinds = new Set<PowerKind>();
    for (const boss of BOSSES) {
      for (const f of bossFighters(boss)) {
        const tag = f.name;
        c.expect(f.powers.length >= 3, `${tag}: only ${f.powers.length} powers`);
        const own = new Set(f.powers.map((d) => d.kind));
        c.expect(own.size === f.powers.length, `${tag}: two powers of the same kind`);
        const at = (s: number) => f.powers.filter((d) => d.from <= s).length;
        c.expect(at(0) >= 1 && at(1) > at(0) && at(2) > at(1), `${tag}: stages unlock ${at(0)} / ${at(1)} / ${at(2)} powers`);
        for (const d of f.powers) {
          kinds.add(d.kind);
          c.expect(d.name.length > 0 && d.cooldown >= 8 && d.damage > 0 && d.range > 0, `${tag} ${d.name}: bad tuning`);
          // Falling, thrown and homing objects are the boss's own looks (prepared with the fight).
          c.expect(!d.skin || d.skin === f.skins.bolt || d.skin === f.skins.blast, `${tag} ${d.name}: skin ${d.skin} isn't one of the boss's`);
        }
      }
    }
    c.expect(kinds.size >= 8, `only ${kinds.size} kinds of power: ${[...kinds].join(', ')}`);
    c.note(`${kinds.size} kinds: ${[...kinds].join(', ')}`);
  });

  qa.add('powers.telegraphed_before_they_hit', (c) => {
    // Every power, on a player standing still (looking at it): nothing for at least 0.6 s, then it
    // lands. Rings and the sweep pass at their own speed; seekers fly in.
    const rows: string[] = [];
    for (const { boss, partner, def } of allPowers()) {
      withBoss(c, game, boss, 2, () => {
        const w = caster(game, partner);
        let t = 0, first = -1;
        const p = game.player;
        const off = events.on('damage', (d) => {
          if (first < 0 && powerHits([d], game, w).length) first = t;
        });
        try {
          c.expect(cast(game, w, def, 2), `${def.name}: did not start`);
          c.step(6, () => {
            t += DT;
            p.intent.move.set(0, 0, 0);
            const h = hazardOf(game, w, 'flash');
            if (h) p.facing = p.intent.facing = Math.atan2(h.at.x - p.pos.x, h.at.z - p.pos.z);
            p.health = p.maxHealth;
          });
        } finally {
          off();
        }
        c.expect(first >= 0, `${w.name} ${def.name} (${def.kind}): never hit a player standing in it`);
        c.expect(first >= 0.6, `${w.name} ${def.name} (${def.kind}): hit ${first.toFixed(2)} s after it started`);
        rows.push(`${def.name} ${first.toFixed(2)}s`);
      });
    }
    c.note(rows.join(', '));
  });

  qa.add('powers.each_kind_has_its_way_out', (c) => {
    const p = game.player;
    const out: string[] = [];
    /** Damage `w`'s power `def` does to the player while `each` steers it, over `seconds`. */
    const run = (boss: BossDef, partner: boolean, k: number, seconds: number, each: (t: number, w: Wizard) => void, setup?: Parameters<Ctx['setup']>[0]) => {
      let taken = 0, evaded = 0, blocked = 0, stunned = false;
      withBoss(c, game, boss, 2, () => {
        const w = caster(game, partner);
        const def = (partner ? boss.partner! : boss).powers[k];
        const dmg = record('damage'), ev = record('dodgeEvade'), bl = record('callout');
        c.expect(cast(game, w, def, 2), `${def.name}: did not start`);
        let t = 0;
        c.step(seconds, () => {
          t += DT;
          each(t, w);
          if (p.stunned) stunned = true;
        });
        taken = powerHits(dmg(), game, w).reduce((a, d) => a + d.amount, 0);
        evaded = ev().filter((e) => e.wizard === p).length;
        blocked = bl().filter((e) => e.text === 'BLOCK').length;
      }, setup);
      return { taken, evaded, blocked, stunned };
    };
    const still = () => p.intent.move.set(0, 0, 0);
    const sideways = () => p.intent.move.set(1, 0, 0);

    // A strike: stand in it and it hits; walk out once it locks and it misses.
    const strike = BOSSES[3].powers[0];
    if (strike.kind !== 'strike') throw new Error('Glowie power 0 is not a strike');
    const hitStrike = run(BOSSES[3], false, 0, strike.track + strike.warn + 0.4, still);
    const dodgedStrike = run(BOSSES[3], false, 0, strike.track + strike.warn + 0.4, (t) => (t > strike.track ? sideways() : still()));
    c.expect(hitStrike.taken > 0 && dodgedStrike.taken === 0, `strike: ${hitStrike.taken} standing, ${dodgedStrike.taken} walking out after the lock`);
    // Rolling through it as it lands evades it.
    let rolled = false;
    const rollStrike = run(BOSSES[3], false, 0, strike.track + strike.warn + 0.4, (t) => {
      still();
      if (!rolled && t > strike.track + strike.warn - 0.12) {
        rolled = true;
        p.intent.move.set(0, 0, 1);
        p.intent.press('dodge');
      }
    });
    c.expect(rollStrike.taken === 0 && rollStrike.evaded > 0, `strike: rolling as it landed took ${rollStrike.taken} (evaded ${rollStrike.evaded})`);
    out.push(`strike ${hitStrike.taken.toFixed(0)}/${dodgedStrike.taken}/${rollStrike.taken}`);

    // A march: sidestep the line.
    const march = run(BOSSES[1], false, 0, 3, sideways);
    const marchHit = run(BOSSES[1], false, 0, 3, still);
    c.expect(marchHit.taken > 0 && march.taken === 0, `march: ${marchHit.taken} standing, ${march.taken} sidestepping`);
    out.push(`march ${marchHit.taken.toFixed(0)}/${march.taken}`);

    // Rings: jump each as it arrives.
    const rings = BOSSES[1].powers[2];
    if (rings.kind !== 'rings') throw new Error('Obama power 2 is not rings');
    const apex = J.velocity / J.gravity;
    const jumpRings = run(BOSSES[1], false, 2, rings.warn + rings.interval * rings.count + 1.5, (t) => {
      still();
      for (let i = 0; i < rings.count; i++) {
        const arrive = rings.warn + i * rings.interval + (p.pos.distanceTo(game.enemy.pos) - p.radius) / rings.speed;
        if (Math.abs(t - (arrive - apex)) < DT / 2 + 1e-6) p.intent.press('jump');
      }
    });
    const standRings = run(BOSSES[1], false, 2, rings.warn + rings.interval * rings.count + 1.5, still);
    c.expect(standRings.taken > 0 && jumpRings.taken === 0 && jumpRings.evaded >= rings.count, `rings: ${standRings.taken} standing, ${jumpRings.taken} jumping (${jumpRings.evaded} evaded)`);
    out.push(`rings ${standRings.taken.toFixed(0)}/${jumpRings.taken}`);

    // The sweep: jump as the beam passes (it reaches the target halfway through).
    const sweep = BOSSES[3].powers[2];
    if (sweep.kind !== 'sweep') throw new Error('Glowie power 2 is not a sweep');
    const jumpSweep = run(BOSSES[3], false, 2, sweep.warn + sweep.duration + 0.3, (t) => {
      still();
      if (Math.abs(t - (sweep.warn + sweep.duration / 2 - apex)) < DT / 2 + 1e-6) p.intent.press('jump');
    });
    const standSweep = run(BOSSES[3], false, 2, sweep.warn + sweep.duration + 0.3, still);
    c.expect(standSweep.taken > 0 && jumpSweep.taken === 0, `sweep: ${standSweep.taken} standing, ${jumpSweep.taken} jumping`);
    out.push(`sweep ${standSweep.taken.toFixed(0)}/${jumpSweep.taken}`);

    // The cone: step out of it.
    const cone = BOSSES[2].powers[2];
    if (cone.kind !== 'cone') throw new Error('Broccoli power 2 is not a cone');
    const near: Parameters<Ctx['setup']>[0] = { player: [0, -3], enemy: [0, 4] };
    const outCone = run(BOSSES[2], false, 2, cone.warn + 0.4, sideways, near);
    const inCone = run(BOSSES[2], false, 2, cone.warn + 0.4, still, near);
    c.expect(inCone.taken > 0 && outCone.taken === 0, `cone: ${inCone.taken} standing, ${outCone.taken} stepping out`);
    out.push(`cone ${inCone.taken.toFixed(0)}/${outCone.taken}`);

    // Seekers: a shield raised as they arrive blocks them.
    const shieldSeekers = run(BOSSES[1], false, 1, 5, (_t, w) => {
      still();
      const near = game.spells.powers.hazards.some((h) => h.active && h.owner === w && h.kind === 'seeker' && h.delay <= 0 && h.at.distanceTo(p.chest(new THREE.Vector3())) < 3);
      if (near && !p.shielded && p.cd.shield <= 0) p.intent.press('shield');
    });
    const standSeekers = run(BOSSES[1], false, 1, 5, still);
    c.expect(standSeekers.taken > 0 && shieldSeekers.blocked > 0 && shieldSeekers.taken < standSeekers.taken, `seekers: ${standSeekers.taken} standing, ${shieldSeekers.taken} shielding (${shieldSeekers.blocked} blocked)`);
    out.push(`seekers ${standSeekers.taken.toFixed(0)}/${shieldSeekers.taken.toFixed(0)}`);

    // The flashbang: looking at it blinds (stuns); looking away doesn't.
    const flash = BOSSES[3].powers[1];
    if (flash.kind !== 'flash') throw new Error('Glowie power 1 is not a flash');
    const face = (away: boolean) => (_t: number, w: Wizard) => {
      still();
      const h = hazardOf(game, w, 'flash');
      if (!h) return;
      const a = Math.atan2(h.at.x - p.pos.x, h.at.z - p.pos.z) + (away ? Math.PI : 0);
      p.facing = p.intent.facing = a;
    };
    const look = run(BOSSES[3], false, 1, flash.warn + 0.3, face(false));
    const away = run(BOSSES[3], false, 1, flash.warn + 0.3, face(true));
    c.expect(look.stunned && !away.stunned && away.taken === 0, `flashbang: looking ${look.stunned ? 'blinded' : 'not blinded'}, away ${away.stunned ? 'blinded' : 'clear'} (${away.taken} dmg)`);
    out.push(`flash ${look.stunned}/${away.stunned}`);

    // The toxic cloud: leaving it at once costs far less than standing in it.
    const cloud = BOSSES[2].powers[1];
    if (cloud.kind !== 'cloud') throw new Error('Broccoli power 1 is not a cloud');
    const stay = run(BOSSES[2], false, 1, cloud.warn + 3, still);
    const leave = run(BOSSES[2], false, 1, cloud.warn + 3, sideways);
    c.expect(stay.taken > 0 && leave.taken < stay.taken * 0.3, `cloud: ${stay.taken.toFixed(1)} staying, ${leave.taken.toFixed(1)} leaving`);
    out.push(`cloud ${stay.taken.toFixed(0)}/${leave.taken.toFixed(0)}`);
    c.note(`standing / evading damage: ${out.join(', ')}`);
  });

  qa.add('powers.recharge_unlocks_and_turns', (c) => {
    const pw = game.spells.powers;
    withBoss(c, game, BOSSES[4], 0, () => {
      const e = game.enemy;
      const [first] = BOSSES[4].powers;
      c.expect(cast(game, e, first, 0), 'Tinubu could not use his first power');
      c.near(pw.cooldown(e, first), pw.recharge(first, 0), 1e-6, 'recharge after use (s)');
      c.expect(!pw.open, 'another power could start at once (no gap)');
      c.expect(!pw.cast(e, first, game.player, 0), 'a power fired again before recharging');
      c.step(P.gap + DT);
      c.expect(pw.open, `still closed after the ${P.gap} s gap`);
      c.expect(pw.recharge(first, 2) < pw.recharge(first, 0) * 0.8, 'stage 3 recharges no faster');
    });
    // A boss AI fighting a target that can't be hurt: stage 1 uses only stage-1 powers; stage 3 uses
    // several, one at a time, at least the gap apart.
    const used = (stage: number) => withSeededRandom(77 + stage, () => {
      const casts: { name: string; t: number }[] = [];
      withBoss(c, game, BOSSES[4], stage, () => {
        const e = game.enemy, p = game.player;
        const ai = new AIController(e, p, game.spells, game.physics, game.arena);
        const seen = record('bossPower');
        try {
          events.emit('bossStage', { wizard: e, boss: BOSSES[4], stage });
          let t = 0;
          c.step(70, () => {
            t += DT;
            ai.update(DT);
            p.health = p.maxHealth;
            p.stunTime = 0;
            e.mana = e.maxMana;
          });
          for (const ev of seen()) if (ev.phase === 'cast' && ev.wizard === e) casts.push({ name: ev.power.name, t: 0 });
        } finally {
          ai.dispose();
        }
      }, { player: [0, -5], enemy: [0, 5] });
      return casts;
    });
    const s1 = used(0), s3 = used(2);
    const allowed1 = BOSSES[4].powers.filter((d) => d.from === 0).map((d) => d.name);
    c.expect(s1.length >= 2 && s1.every((x) => allowed1.includes(x.name)), `stage 1 used ${s1.map((x) => x.name).join(', ')}`);
    const kinds3 = new Set(s3.map((x) => x.name));
    c.expect(s3.length > s1.length && kinds3.size >= 3, `stage 3 used ${s3.length} powers (${[...kinds3].join(', ')}), stage 1 ${s1.length}`);
    c.note(`70 s: stage 1 ${s1.length} powers, stage 3 ${s3.length} (${[...kinds3].join(', ')})`);
  });

  qa.add('powers.called_off_by_transform_and_ko', (c) => {
    withBoss(c, game, BOSSES[4], 0, () => {
      const e = game.enemy;
      const dmg = record('damage');
      c.expect(cast(game, e, BOSSES[4].powers[0], 0), 'no power');
      c.step(0.2);
      // The bar breaks: he transforms, and what he had telegraphed is gone.
      game.spells.dealDamage(e, game.player, (e.health + 10) / game.player.damageMultiplier, e.chest(new THREE.Vector3()), 'blast');
      c.step(DT * 2);
      c.expect(e.evolving && !hazardOf(game, e), 'hazards outlived the transformation');
      c.step(CONFIG.campaign.evolveTime + 2);
      c.expect(powerHits(dmg(), game, e).length === 0, 'a called-off power still hit');
      // KO'd: called off too.
      cast(game, e, BOSSES[4].powers[0], 1);
      game.stages.evolveTo(2);
      game.stages.release(0);
      cast(game, e, BOSSES[4].powers[0], 2);
      game.spells.dealDamage(e, game.player, 1e6, e.chest(new THREE.Vector3()), 'blast');
      c.step(DT * 2);
      c.expect(!e.alive && !hazardOf(game, e), 'hazards outlived the KO');
    });
  });

  qa.add('powers.duo_no_friendly_fire', (c) => {
    // The Midget's stomp right next to Bitcoin Obama: Obama takes nothing, the player does.
    withBoss(c, game, BOSSES[1], 0, () => {
      const q = game.partner, e = game.enemy;
      c.expect(game.partnerActive, 'no partner');
      const dmg = record('damage');
      c.expect(cast(game, q, BOSSES[1].partner!.powers[0], 0), 'no stomp');
      c.step(4, () => (game.player.health = game.player.maxHealth));
      const seen = dmg();
      c.expect(!seen.some((d) => d.target === e && d.source === q), 'the stomp hurt Bitcoin Obama');
      c.expect(powerHits(seen, game, q).length > 0, 'the stomp missed the player');
    }, { player: [0, -4], enemy: [2, 3], partner: [-1, 3] });
  });

  qa.add('powers.reference_ai_reads_telegraphs', (c) => {
    // Each power 4 times on the soak's reference player AI (Adept) and on a player who just stands:
    // the AI takes clearly less (it runs out of circles and cones, jumps rings and the sweep, rolls,
    // shields seekers, looks away from flashbangs).
    let ai = 0, idle = 0;
    const per: string[] = [];
    const trial = (react: boolean, boss: BossDef, partner: boolean, def: PowerDef, seed: number): number =>
      withSeededRandom(seed, () => {
        let taken = 0;
        withBoss(c, game, boss, 2, () => {
          const w = caster(game, partner), p = game.player;
          const brain = react ? new AIController(p, w, game.spells, game.physics, game.arena, 'normal') : null;
          const dmg = record('damage');
          try {
            cast(game, w, def, 2);
            c.step(5, () => {
              if (brain) {
                brain.update(DT);
                p.intent.holdBolt = false;
              } else p.intent.move.set(0, 0, 0);
              if (p.health < 60) p.health = p.maxHealth;
            });
            taken = powerHits(dmg(), game, w).reduce((a, d) => a + d.amount, 0);
          } finally {
            brain?.dispose();
          }
        });
        return taken;
      });
    let better = 0, n = 0;
    allPowers().forEach(({ boss, partner, def }, i) => {
      let a = 0, b = 0;
      for (let k = 0; k < 4; k++) {
        a += trial(true, boss, partner, def, 3000 + i * 10 + k);
        b += trial(false, boss, partner, def, 3000 + i * 10 + k);
      }
      ai += a;
      idle += b;
      n++;
      if (a < b) better++;
      per.push(`${def.name} ${a.toFixed(0)}/${b.toFixed(0)}`);
    });
    c.expect(ai < idle * 0.6, `the reference AI took ${ai.toFixed(0)} vs ${idle.toFixed(0)} standing still`);
    c.expect(better >= n * 0.7, `it did better than standing still against only ${better} of ${n} powers`);
    c.note(`AI/idle damage: total ${ai.toFixed(0)}/${idle.toFixed(0)} | ${per.join(', ')}`);
  });

  qa.add('powers.boss_plate_shows_recharge', (c) => {
    // In a live gauntlet fight the boss plate lists his powers: locked ones dimmed, the ready one
    // lit, one just used filling up again.
    try {
      app.campaign.index = 4;
      app.startBossFight();
      game.stages.suspended = false;
      c.setup();
      app.match.phase = 'fight';
      game.actionsLocked = false;
      const e = game.enemy;
      const pw = game.spells.powers;
      for (const d of BOSSES[4].powers) pw.setCooldown(e, d, 0);
      app.hud.update(0);
      const chips = [...app.hud.root.querySelectorAll('.plate-right:not(.plate-partner) .plate-powers .pw')] as HTMLElement[];
      c.expect(chips.length === BOSSES[4].powers.length, `${chips.length} chips for ${BOSSES[4].powers.length} powers`);
      const locked = BOSSES[4].powers.filter((d) => d.from > 0).length;
      c.expect(chips.filter((x) => x.classList.contains('locked')).length === locked, 'locked powers not dimmed');
      c.expect(chips[0].classList.contains('ready'), `first chip "${chips[0].className}"`);
      cast(game, e, BOSSES[4].powers[0], 0);
      c.step(5);
      app.hud.update(0);
      c.expect(chips[0].classList.contains('charging'), `after use the chip is "${chips[0].className}"`);
      const fill = (chips[0].querySelector('i') as HTMLElement).style.transform;
      c.expect(/scaleX\(0\.[1-9]/.test(fill), `recharge fill ${fill}`);
    } finally {
      game.spells.powers.clear();
      app.toMenu();
    }
  });
}
