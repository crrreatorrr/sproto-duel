import { CONFIG } from '../config';
import { events } from '../core/events';
import type { Game } from '../core/Game';
import { AIController } from '../enemy/AIController';
import type { Pillar } from '../arena/Pillar';
import type { Wizard } from '../wizard/Wizard';
import type { QAHarness } from './QAHarness';

const DT = CONFIG.sim.fixedDt;
const W = CONFIG.wizard;
const J = W.jump;
const P = CONFIG.arena.pillars;
const S = CONFIG.spells;
const MAXHP = W.maxHealth;
const APEX = (J.velocity * J.velocity) / (2 * J.gravity);
const AIRTIME = (2 * J.velocity) / J.gravity;
/** Matches Pillar's stump collider (Physics.addPillar scales the radius by 1.15). */
const STUMP_TOP = 0.9;
const STUMP_RADIUS = P.radius * 1.15;

/** Gap between a wizard's capsule and a pillar (whole or stump). Negative = inside it. */
function clearance(w: Wizard, pillar: Pillar): number {
  const top = pillar.alive ? P.height : STUMP_TOP;
  const radius = pillar.alive ? P.radius : STUMP_RADIUS;
  const dh = Math.hypot(w.pos.x - pillar.position.x, w.pos.z - pillar.position.z);
  // Capsule = segment of the axis between the two hemisphere centers, inflated by W.radius.
  const segBottom = w.pos.y + 0.02 + W.radius;
  const v = Math.max(0, segBottom - top);
  const g = Math.max(0, dh - radius);
  return Math.hypot(g, v) - W.radius;
}

/** Collect callout texts emitted while `fn` runs. */
function withCallouts(fn: (texts: string[]) => void): void {
  const texts: string[] = [];
  const off = events.on('callout', (e) => texts.push(e.text));
  try {
    fn(texts);
  } finally {
    off();
  }
}

export function registerJumpScenarios(qa: QAHarness, game: Game): void {
  /** Crumble a pillar after setup() (which restores them) and let the stump collider take over. */
  const crumble = (pillar: Pillar) => {
    pillar.damage(1e6, pillar.position.clone().setY(1));
    game.physics.step();
  };
  /** Drop a wizard from `y` at (x, z) and let it settle. */
  const perch = (w: Wizard, x: number, z: number, y: number) => {
    w.pos.set(x, y, z);
    w.prevPos.copy(w.pos);
    w.vel.set(0, 0, 0);
    w.vy = 0;
    w.grounded = false;
    w.placeBody();
    game.physics.step();
  };
  /** Step one tick at a time until `done` or `limit` seconds pass. Returns seconds stepped. */
  const stepUntil = (done: () => boolean, limit: number, each?: () => void) => {
    let t = 0;
    while (t < limit && !done()) {
      each?.();
      game.tick(DT);
      t += DT;
    }
    return t;
  };

  qa.add('jump.apex_airtime_and_landing', (c) => {
    c.setup();
    const w = c.player;
    const jumps = w.jumps;
    const landings = w.landings;
    w.intent.press('jump');
    let apex = 0;
    let air = 0;
    let bodyOffset = 0;
    c.step(DT);
    c.expect(!w.grounded && w.pos.y > 0, 'jump did not leave the ground');
    air += DT;
    const t = stepUntil(() => w.grounded, 2, () => {
      if (w.pos.y > apex) {
        apex = w.pos.y;
        bodyOffset = w.body.translation().y - w.pos.y;
      }
    });
    air += t;
    c.near(apex, APEX, 0.02, 'apex m');
    c.near(air, AIRTIME, 2 * DT + 0.001, 'airtime s');
    // The capsule rides along: same offset above the feet as when standing.
    c.near(bodyOffset, W.height / 2 + 0.02, 0.01, 'capsule offset at apex');
    c.expect(w.grounded && w.pos.y === 0, `did not land back on y=0 (y=${w.pos.y})`);
    c.expect(w.jumps === jumps + 1 && w.landings === landings + 1, `jumps ${w.jumps - jumps}, landings ${w.landings - landings}`);
    c.expect(w.vy === 0, `vy=${w.vy} after landing`);
  });

  qa.add('jump.no_double_jump', (c) => {
    c.setup();
    const w = c.player;
    const jumps = w.jumps;
    w.intent.press('jump');
    c.step(DT);
    let apex = 0;
    // Mash jump every tick of the airtime.
    stepUntil(() => w.grounded, 2, () => {
      w.intent.press('jump');
      apex = Math.max(apex, w.pos.y);
    });
    c.expect(w.jumps === jumps + 1, `jumped ${w.jumps - jumps} times before landing`);
    c.near(apex, APEX, 0.02, 'apex while mashing');
  });

  qa.add('jump.buffered_press_fires_on_landing', (c) => {
    c.setup();
    const w = c.player;
    w.intent.press('jump');
    c.step(DT);
    // Press again on the way down, about 4 ticks before touchdown.
    stepUntil(() => w.vy < 0 && w.pos.y < 0.5, 2);
    c.expect(!w.grounded, 'landed before the early press');
    w.intent.press('jump');
    const jumps = w.jumps;
    stepUntil(() => w.grounded, 1);
    const landedAt = game.simTime;
    stepUntil(() => w.jumps > jumps, 0.2);
    c.expect(w.jumps === jumps + 1, 'buffered jump never fired');
    const delay = game.simTime - landedAt;
    c.expect(delay <= 2 * DT + 1e-6, `buffered jump fired ${(delay * 1000).toFixed(0)} ms after landing`);
    c.note(`fired ${Math.round(delay / DT)} tick(s) after touchdown`);

    // A press long before touchdown expires instead.
    stepUntil(() => w.vy < 0, 1);
    w.intent.press('jump');
    const t = stepUntil(() => w.grounded, 1);
    c.expect(t > CONFIG.feel.inputBuffer + DT, 'test setup: press was not early enough');
    const before = w.jumps;
    c.step(0.1);
    c.expect(w.jumps === before, 'a press made well before touchdown still fired');
  });

  qa.add('jump.lands_on_stump_and_walks_off', (c) => {
    const pillar = game.arena.pillars[0];
    const center = pillar.position;
    const out = center.clone().setY(0).normalize();
    // Start on the arena side of the stump, run at it, jump, and stop over the top.
    const start = center.clone().addScaledVector(out, -2.2);
    c.setup({ player: [start.x, start.z], enemy: [0, 8] });
    crumble(pillar);
    const w = c.player;
    let worst = Infinity;
    const track = () => (worst = Math.min(worst, clearance(w, pillar)));
    const toward = out.clone();
    w.intent.move.copy(toward).multiplyScalar(0.5);
    w.intent.press('jump');
    const landings = w.landings;
    stepUntil(() => w.landings > landings && w.grounded, 2, () => {
      const dh = Math.hypot(w.pos.x - center.x, w.pos.z - center.z);
      if (dh < 0.3) w.intent.move.set(0, 0, 0);
      track();
    });
    c.expect(w.grounded, 'never landed');
    c.near(w.pos.y, STUMP_TOP, 0.03, 'standing height on stump');
    // Stand still: no sinking, no drift.
    const y0 = w.pos.y;
    w.intent.move.set(0, 0, 0);
    c.step(1, track);
    c.expect(w.grounded && Math.abs(w.pos.y - y0) < 0.005, `drifted on the stump: ${y0.toFixed(3)} -> ${w.pos.y.toFixed(3)}`);
    // Walk off the far side, fall, land on the floor.
    w.intent.move.copy(toward);
    stepUntil(() => !w.grounded, 2, track);
    c.expect(!w.grounded, 'never walked off the stump');
    stepUntil(() => w.grounded, 2, track);
    c.step(0.2, track);
    c.expect(w.grounded && w.pos.y === 0, `did not end on the floor (y=${w.pos.y.toFixed(3)})`);
    c.note(`min clearance=${worst.toFixed(3)}m`);
    c.expect(worst > -0.01, `capsule went ${(-worst).toFixed(3)} m into the stump`);
  });

  qa.add('jump.coyote_time_after_ledge', (c) => {
    const pillar = game.arena.pillars[3];
    const center = pillar.position;
    const out = center.clone().setY(0).normalize();
    const tryAfter = (delay: number) => {
      c.setup({ player: [0, 0], enemy: [0, 8] });
      crumble(pillar);
      const w = c.player;
      perch(w, center.x, center.z, 1.4);
      stepUntil(() => w.grounded, 1);
      c.near(w.pos.y, STUMP_TOP, 0.03, 'perched');
      w.intent.move.copy(out);
      stepUntil(() => !w.grounded, 2);
      c.step(delay);
      const jumps = w.jumps;
      w.intent.press('jump');
      c.step(DT);
      return { jumped: w.jumps > jumps, rising: w.vy > 0 };
    };
    const early = tryAfter(J.coyoteTime * 0.5);
    c.expect(early.jumped && early.rising, 'no jump inside the coyote window');
    const late = tryAfter(J.coyoteTime + 0.05);
    c.expect(!late.jumped, 'jumped in mid-air after the coyote window');
  });

  qa.add('jump.ultimate_wave_cleared_by_timed_jump', (c) => {
    c.setup();
    const d = c.player.pos.distanceTo(c.enemy.pos) - W.radius;
    const arrive = S.ultimate.castTime + d / S.ultimate.waveSpeed;
    withCallouts((texts) => {
      c.player.ult = S.ultimate.chargeMax;
      c.player.intent.press('ultimate');
      // Takeoff timed so the apex meets the wavefront.
      c.step(arrive - J.velocity / J.gravity);
      c.enemy.intent.press('jump');
      c.step(1.2);
      c.expect(c.enemy.health === MAXHP, `took ${MAXHP - c.enemy.health} despite a timed jump`);
      c.expect(texts.includes('EVADED'), `no EVADED callout (${texts.join(',')})`);
    });
  });

  qa.add('jump.ultimate_wave_hits_mistimed_jump', (c) => {
    const d = 12 - W.radius;
    const arrive = S.ultimate.castTime + d / S.ultimate.waveSpeed;
    for (const [label, at] of [['early', 0], ['late', arrive - 0.06]] as const) {
      c.setup();
      c.player.ult = S.ultimate.chargeMax;
      c.player.intent.press('ultimate');
      c.step(at);
      c.enemy.intent.press('jump');
      c.step(1.2);
      c.near(MAXHP - c.enemy.health, S.ultimate.damage, 0.01, `${label} jump dmg`);
    }
  });

  qa.add('jump.airborne_wizard_hit_by_bolt', (c) => {
    c.setup();
    let airborneHit = -1;
    const off = events.on('damage', (e) => {
      if (e.target === c.enemy) airborneHit = c.enemy.airHeight;
    });
    try {
      c.enemy.intent.press('jump');
      const travel = (c.player.pos.distanceTo(c.enemy.pos) - 1) / S.bolt.speed;
      c.step(J.velocity / J.gravity - travel);
      // Aim where the chest will be at the apex.
      c.player.aimPoint.set(c.enemy.pos.x, APEX + 1.2, c.enemy.pos.z);
      c.player.intent.press('bolt');
      c.step(0.6);
    } finally {
      off();
    }
    c.near(MAXHP - c.enemy.health, S.bolt.damage, 0.01, 'bolt dmg');
    c.expect(airborneHit > 1, `hit at feet height ${airborneHit.toFixed(2)}, expected near the apex`);
  });

  qa.add('jump.blast_splash_reaches_airborne', (c) => {
    c.setup();
    // Feet-aimed blast (what the AI throws) arriving as the target peaks: it bursts underneath.
    c.player.aimPoint.set(c.enemy.pos.x, S.blast.radius, c.enemy.pos.z);
    c.player.intent.press('blast');
    const flight = S.blast.castTime + (c.player.pos.distanceTo(c.enemy.pos) - 0.8) / S.blast.speed;
    c.step(flight - J.velocity / J.gravity);
    c.enemy.intent.press('jump');
    c.step(1.2);
    const dmg = MAXHP - c.enemy.health;
    c.note(`airborne splash=${dmg.toFixed(1)}`);
    c.expect(dmg > 0 && dmg < S.blast.damage, `splash ${dmg.toFixed(1)} should be partial (0..${S.blast.damage})`);
  });

  qa.add('jump.no_roll_midair_but_casts', (c) => {
    c.setup();
    const w = c.player;
    w.intent.press('jump');
    c.step(0.12);
    w.intent.press('dodge');
    w.intent.press('bolt');
    c.step(0.1);
    c.expect(!w.grounded, 'test setup: landed too soon');
    c.expect(w.stats.dodges === 0, 'rolled in mid-air');
    c.expect(w.stats.casts === 1, `mid-air bolt did not cast (casts=${w.stats.casts})`);
    // A roll pressed just before touchdown fires on landing.
    stepUntil(() => w.vy < 0 && w.pos.y < 0.5, 1);
    w.intent.move.set(1, 0, 0);
    w.intent.press('dodge');
    stepUntil(() => w.grounded, 1);
    c.step(2 * DT);
    c.expect(w.stats.dodges === 1, 'roll pressed just before landing was dropped');
  });

  qa.add('jump.cannot_clear_wall', (c) => {
    c.setup({ player: [0, -(CONFIG.arena.wallRadius - 3)], enemy: [0, 8] });
    game.arena.fireRadius = 1000; // no fire push: just the wall
    const w = c.player;
    let maxR = 0;
    c.step(4, () => {
      w.intent.move.set(0, 0, -1);
      w.intent.sprint = true;
      w.mana = W.maxMana;
      if (w.grounded) w.intent.press('jump');
      maxR = Math.max(maxR, Math.hypot(w.pos.x, w.pos.z));
    });
    c.note(`max r=${maxR.toFixed(2)} wall=${CONFIG.arena.wallRadius}`);
    c.expect(maxR < CONFIG.arena.wallRadius, `jumped over the wall (r=${maxR.toFixed(2)})`);
    c.expect(maxR > CONFIG.arena.wallRadius - W.radius - 0.2, 'test setup: never reached the wall');
  });

  qa.add('jump.slides_off_heads', (c) => {
    const pillar = game.arena.pillars[1];
    const center = pillar.position;
    const out = center.clone().setY(0).normalize();
    // Enemy stands just outside the stump; the player hops off the stump onto its head.
    const e = center.clone().addScaledVector(out, STUMP_RADIUS + W.radius + 0.1);
    c.setup({ player: [0, 0], enemy: [e.x, e.z] });
    crumble(pillar);
    const w = c.player;
    perch(w, center.x, center.z, 1.4);
    stepUntil(() => w.grounded, 1);
    w.intent.move.copy(out).multiplyScalar(0.35);
    w.intent.press('jump');
    let minGap = Infinity;
    let t = 0;
    c.step(2.5, () => {
      const dh = Math.hypot(w.pos.x - c.enemy.pos.x, w.pos.z - c.enemy.pos.z);
      const v = Math.max(0, Math.abs(w.pos.y - c.enemy.pos.y) - (W.height - 2 * W.radius));
      minGap = Math.min(minGap, Math.hypot(dh, v) - 2 * W.radius);
      if ((t += DT) > 0.6) w.intent.move.set(0, 0, 0);
    });
    c.note(`final y=${w.pos.y.toFixed(2)} min capsule gap=${minGap.toFixed(3)}`);
    c.expect(w.grounded, 'still airborne after 2.5 s');
    c.expect(w.pos.y < 0.05 || Math.abs(w.pos.y - STUMP_TOP) < 0.05, `came to rest at y=${w.pos.y.toFixed(2)} (on a head?)`);
    c.expect(minGap > -0.03, `capsules overlapped by ${(-minGap).toFixed(3)} m`);
  });

  qa.add('jump.camera_settles_on_landing', (c) => {
    c.setup();
    const rig = game.rig;
    const w = c.player;
    rig.snap(w.pos, w.facing);
    // Long enough for any leftover pull-back (from earlier ultimates) to die out.
    for (let i = 0; i < 400; i++) rig.update(DT, w.pos, game.physics, false, false);
    const rest = rig.camera.position.y;
    w.intent.press('jump');
    let maxRise = 0;
    c.step(DT);
    stepUntil(() => w.grounded, 2, () => {
      rig.update(DT, w.pos, game.physics, false, false);
      maxRise = Math.max(maxRise, rig.camera.position.y - rest);
    });
    rig.update(DT, w.pos, game.physics, false, false);
    const settle = Math.abs(rig.camera.position.y - rest);
    c.note(`camera rise=${maxRise.toFixed(2)} of ${APEX.toFixed(2)}, off by ${settle.toFixed(3)} at touchdown`);
    c.expect(maxRise > 0.3 && maxRise < APEX * 0.75, `camera rise ${maxRise.toFixed(2)} should follow the jump softly`);
    c.expect(settle < 0.02, `camera ${settle.toFixed(3)} m off its resting height on landing`);
  });

  qa.add('jump.spam_no_nan_never_inside', (c) => {
    c.setup({ player: [0, -4], enemy: [0, 4] });
    const pillars = game.arena.pillars;
    for (let i = 0; i < pillars.length; i += 2) crumble(pillars[i]);
    let worst = Infinity;
    let maxY = 0;
    let bad = '';
    // A wizard that lands on the other one's head (capsules are solid) may jump again from there:
    // that flight is no double jump, so it stays out of the height check until it is back down.
    const headHop = new Set<Wizard>();
    let headHops = 0;
    c.step(14, () => {
      for (const w of game.wizards) {
        const o = game.wizards.find((x) => x !== w && x.active);
        if (o && Math.hypot(w.pos.x - o.pos.x, w.pos.z - o.pos.z) < 2 * W.radius + 0.1 && w.pos.y > o.pos.y + 1) {
          if (!headHop.has(w)) headHops++;
          headHop.add(w);
        } else if (w.grounded && w.pos.y < STUMP_TOP + 0.05) headHop.delete(w);
        if (Math.random() < 0.02) w.intent.move.set(Math.random() * 2 - 1, 0, Math.random() * 2 - 1).normalize();
        // Steer back toward the pillar ring so stumps get hopped on.
        const r = Math.hypot(w.pos.x, w.pos.z);
        if (r > 13) w.intent.move.set(-w.pos.x / r, 0, -w.pos.z / r);
        w.intent.sprint = Math.random() < 0.5;
        if (Math.random() < 0.3) w.intent.press('jump');
        if (Math.random() < 0.02) w.intent.press('dodge');
        if (Math.random() < 0.01) w.addKnockback(Math.random() - 0.5, Math.random() - 0.5, 25);
        w.mana = W.maxMana;
        w.health = MAXHP;
        if (!Number.isFinite(w.pos.x + w.pos.y + w.pos.z + w.vy + w.vel.x + w.vel.z)) bad = 'NaN';
        if (w.pos.y < 0) bad = `below floor y=${w.pos.y}`;
        if (!headHop.has(w)) maxY = Math.max(maxY, w.pos.y);
        for (const p of pillars) worst = Math.min(worst, clearance(w, p));
      }
    });
    c.note(`jumps=${c.player.jumps + c.enemy.jumps} min clearance=${worst.toFixed(3)}m maxY=${maxY.toFixed(2)}${headHops ? ` (${headHops} head hops left out)` : ''}`);
    c.expect(!bad, bad);
    c.expect(maxY <= STUMP_TOP + APEX + 0.05, `rose to ${maxY.toFixed(2)} m (double jump?)`);
    c.expect(worst > -0.02, `capsule went ${(-worst).toFixed(3)} m into a pillar`);
    for (const w of game.wizards) c.expect(Math.hypot(w.pos.x, w.pos.z) < CONFIG.arena.wallRadius, 'escaped the wall');
  });

  qa.add('jump.ai_jumps_over_ultimate', (c) => {
    const saved = { wave: J.aiWaveJump, hop: J.aiHopRate };
    J.aiWaveJump = 100; // always pick the jump when reacting
    J.aiHopRate = 0; // no idle hops to spoil the timing
    let jumped = 0;
    let evaded = 0;
    try {
      for (let trial = 0; trial < 6; trial++) {
        c.setup();
        const ai = new AIController(game.enemy, game.player, game.spells, game.physics, game.arena, 'hard');
        try {
          const jumps = c.enemy.jumps;
          c.player.ult = S.ultimate.chargeMax;
          c.player.intent.press('ultimate');
          c.step(1.4, () => ai.update(DT));
          if (c.enemy.jumps > jumps) {
            jumped++;
            if (c.enemy.health === MAXHP) evaded++;
          }
        } finally {
          ai.dispose();
        }
      }
    } finally {
      J.aiWaveJump = saved.wave;
      J.aiHopRate = saved.hop;
    }
    c.note(`AI jumped ${jumped}/6, cleared ${evaded}`);
    c.expect(jumped > 0, 'AI never jumped over an ultimate');
    c.expect(evaded === jumped, `AI mistimed ${jumped - evaded} of ${jumped} wave jumps`);
  });

  qa.add('jump.ai_hops_only_when_skilled', (c) => {
    const hops: Record<string, number> = {};
    // ~8 hops a minute at Archmage: a long sample so "never hopped" can't happen by chance.
    const seconds = { easy: 20, hard: 60 };
    for (const d of ['easy', 'hard'] as const) {
      c.setup();
      const ai = new AIController(game.enemy, game.player, game.spells, game.physics, game.arena, d);
      const jumps = c.enemy.jumps;
      try {
        c.step(seconds[d], () => {
          ai.update(DT);
          c.player.health = c.enemy.health = MAXHP;
        });
      } finally {
        ai.dispose();
      }
      hops[d] = c.enemy.jumps - jumps;
    }
    c.note(`hops: easy=${hops.easy} in ${seconds.easy}s, hard=${hops.hard} in ${seconds.hard}s`);
    c.expect(hops.easy === 0, 'Apprentice AI hopped');
    c.expect(hops.hard > 0 && hops.hard < 40, `Archmage hops=${hops.hard}, expected a light touch`);
  });

  qa.add('jump.ai_hits_hopping_player', (c) => {
    c.setup();
    const ai = new AIController(game.enemy, game.player, game.spells, game.physics, game.arena, 'normal');
    let airHits = 0;
    const off = events.on('damage', (e) => {
      if (e.target === c.player && c.player.airHeight > 0.3) airHits++;
    });
    try {
      c.step(10, () => {
        ai.update(DT);
        if (c.player.grounded) c.player.intent.press('jump');
        c.player.health = MAXHP;
      });
    } finally {
      off();
      ai.dispose();
    }
    c.note(`AI casts=${c.enemy.stats.casts} hits=${c.enemy.stats.hits} airborne hits=${airHits}`);
    c.expect(airHits > 0, 'AI never hit a hopping player in mid-air');
  });
}
