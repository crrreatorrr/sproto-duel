import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { BOSS_IDS, bossArena } from './bosses';
import { ONE } from './fixed';
import { SimWorld } from './world';
import { emptyInput } from './wizard';

describe('gauntlet setup', () => {
  for (const id of BOSS_IDS) {
    it(`builds the ${id} fight`, () => {
      const w = new SimWorld({ seed: 1, rules: 'gauntlet', arena: 'moonlit', staffs: ['duel_staff_sproto', null], bossId: id, learned: ['carpet'] });
      expect(w.arena.id).toBe(bossArena(id));
      expect(w.wizards.length).toBe(id === 'obama' ? 3 : 2);
      expect(w.inputSeats()).toEqual([0]);
      expect(w.wizards[1].maxHealth).toBeGreaterThan(300 * ONE);
      for (let t = 0; t < 600; t++) w.step([emptyInput()]);
      expect(w.match.phase).toBe('fight');
    });
  }
});

describe('gauntlet checkpoints', () => {
  const CK = CONFIG.campaign.checkpoint;

  function fight(bossId = 'sahil'): SimWorld {
    const w = new SimWorld({ seed: 3, rules: 'gauntlet', arena: 'moonlit', staffs: [null, null], bossId });
    w.ais.length = 0;
    w.events.enabled = true;
    while (w.actionsLocked) w.step([null]);
    return w;
  }
  /** Empty each boss's bar until it stands in `stage` (0-based). */
  function toStage(w: SimWorld, stage: number): void {
    for (let s = 0; s < stage; s++) {
      for (const st of w.stages) st.owner.health = 0;
      // The new form is immune for a moment (cinematic.grace) before its bar can empty again.
      for (let i = 0; i < 40; i++) w.step([null]);
    }
    for (const st of w.stages) expect(st.stage).toBe(stage);
  }
  const knockOut = (w: SimWorld) => {
    const p = w.wizards[0];
    w.spells.dealDamage(p, null, p.maxHealth * 2, { x: p.pos.x, y: ONE, z: p.pos.z }, 'fire', null, 0);
    w.step([null]);
  };

  it('stage 1 has none: the knockout ends the fight', () => {
    const w = fight();
    expect(w.checkpointStage()).toBe(-1);
    knockOut(w);
    expect(w.wizards[0].alive).toBe(false);
    expect(w.decidedWinner).toBe(1);
    expect(w.checkpoints).toBe(0);
  });

  for (const stage of [1, 2]) {
    it(`stage ${stage + 1} restarts once, with a life pack back, then a knockout is the defeat`, () => {
      const w = fight();
      const p = w.wizards[0], boss = w.wizards[1];
      toStage(w, stage);
      expect(w.checkpointStage()).toBe(stage);
      // Mid-stage: the boss is hurt, the player has charge, two packs are spent, a bolt is in the air.
      boss.health -= 500 * ONE;
      p.ult = 40 * ONE;
      w.lifePacks.spawned = 2;
      for (let i = 0; i < 20; i++) w.step([{ ...emptyInput(), held: 1 }]);
      const elapsed = w.clock.elapsed;
      w.events.take();
      knockOut(w);
      expect(w.decidedWinner).toBe(-1);
      expect(p.alive).toBe(true);
      expect(p.health).toBe(p.maxHealth);
      expect(p.ult).toBeGreaterThanOrEqual(40 * ONE);
      expect(boss.health).toBe(boss.maxHealth);
      expect(w.stages[0].stage).toBe(stage);
      expect(w.spells.active.length).toBe(0);
      expect(w.lifePacks.spawned).toBe(2 - CK.lifePacks);
      expect(w.match.phase).toBe('intro');
      expect(w.actionsLocked).toBe(true);
      expect(w.checkpointUsed[stage]).toBe(true);
      expect(w.checkpointStage()).toBe(-1);
      expect(w.events.take().filter((e) => e.type === 'checkpoint').map((e) => e.n)).toEqual([stage]);
      // The same countdown as a round start brings the fight back; the fight clock kept its time.
      const counts: number[] = [];
      let ticks = 0;
      while (w.actionsLocked && ticks++ < 600) {
        w.step([null]);
        for (const e of w.events.take()) if (e.type === 'countdown') counts.push(e.n);
      }
      expect(counts).toEqual([3, 2, 1]);
      expect(ticks / 60).toBeCloseTo(CONFIG.match.introTime + CK.banner, 1);
      expect(w.match.phase).toBe('fight');
      expect(w.clock.elapsed).toBeGreaterThanOrEqual(elapsed);
      knockOut(w);
      expect(p.alive).toBe(false);
      expect(w.decidedWinner).toBe(1);
      expect(w.checkpoints).toBe(1);
    });
  }

  it('each of stages 2 and 3 has its own', () => {
    const w = fight();
    toStage(w, 1);
    knockOut(w);
    while (w.actionsLocked) w.step([null]);
    toStage(w, 2);
    expect(w.checkpointStage()).toBe(2);
    knockOut(w);
    expect(w.decidedWinner).toBe(-1);
    expect(w.checkpoints).toBe(2);
  });

  it('a double fight: both bosses refill, a fallen one stays down', () => {
    const w = fight('obama');
    toStage(w, 2);
    const [a, b] = [w.wizards[1], w.wizards[2]];
    // The partner falls for good (its last bar empties), the lead is hurt.
    w.spells.dealDamage(b, w.wizards[0], b.maxHealth * 2, { x: b.pos.x, y: ONE, z: b.pos.z }, 'bolt', null, 0);
    w.step([null]);
    expect(b.alive).toBe(false);
    a.health -= 100 * ONE;
    knockOut(w);
    expect(w.decidedWinner).toBe(-1);
    expect(a.health).toBe(a.maxHealth);
    expect(b.alive).toBe(false);
  });

  it('Quick Duel has none', () => {
    const w = new SimWorld({ seed: 3, rules: 'quick', arena: 'moonlit', staffs: [null, null] });
    while (w.actionsLocked) w.step([null]);
    expect(w.checkpointStage()).toBe(-1);
    knockOut(w);
    expect(w.wizards[0].alive).toBe(false);
    expect(w.match.wins[1]).toBe(1);
  });
});
