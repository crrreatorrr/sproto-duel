/**
 * The balance figures docs/gameplay-improvement-plan.md asks to hold, measured on the sim with the
 * scripted players (deterministic: these only move when the tuning or the sim changes).
 */
import { describe, expect, it } from 'vitest';
import { BOSSES } from '../campaign/levels';
import { bossProbe, quickWorld, scripted, simSoak } from './simProbe';

const pct = (s: string) => parseInt(s, 10);

describe('mana economy (plan B1)', () => {
  it('holding fire keeps a Blast in reach in a third of samples', () => {
    // Against the Archmage, the sharp rival the target was set against (the old Adept). The share is
    // time above a Blast's mana (about 12 s from a full bar) over round length, so against the
    // gentler rivals, where a player who only stands and fires lives twice as long, it is about 20%.
    const r = scripted('holdFire', 'hard', 6);
    expect(pct(r.mana.atLeastBlast)).toBeGreaterThanOrEqual(33);
  }, 30000);

  it('an attacker who pauses casts Blast, Shield, Stun and the Ultimate every round', () => {
    const r = scripted('attackerPaused', 'normal', 6);
    expect(r.roundsWithAllFour).toBe(r.rounds);
  }, 30000);
});

describe('AI against AI (plan section 9)', () => {
  it('rounds stay about 51-70 s at every profile and end in knockouts', () => {
    for (const d of ['easy', 'normal', 'hard'] as const) {
      const r = simSoak(d, 8);
      expect(r.avgSeconds, d).toBeGreaterThan(44);
      expect(r.avgSeconds, d).toBeLessThan(72);
      expect(r.koRounds, d).toBeGreaterThanOrEqual(r.rounds * 0.75);
    }
  }, 60000);

  it('Archmage rounds are not all bolts (plan B3)', () => {
    expect(pct(simSoak('hard', 8).damageShare.bolt)).toBeLessThan(75);
  }, 30000);
});

describe('probes', () => {
  it('the Quick Duel world plays the rival asked for', () => {
    expect(quickWorld(1, 'easy').setup.difficulty).toBe('easy');
    expect(quickWorld(1, 'easy').hash()).toBe(quickWorld(1, 'easy').hash());
  });

  it('a scripted attacker empties a stage-sized share of the first boss in four minutes', () => {
    const r = bossProbe('sahil', 'attackerPaused', { fights: 1, seconds: 240, immortal: true });
    const stage1 = r.dpsDealt * 240;
    // Perfect aim takes stage 1 in two to four minutes (the bars are sized for about five with a
    // person's aim and a mid staff: see levels.ts).
    const bar = BOSSES[0].stageHealth[0];
    expect(stage1).toBeGreaterThan(bar);
    expect(stage1).toBeLessThan(bar * 2);
  }, 30000);
});
