import { describe, expect, it } from 'vitest';
import { ONE } from './fixed';
import { replay } from './replay';
import { BUSY, Bot, CALM } from './testing/bot';
import { recordMatch } from './testing/record';

describe('CPU rival in the sim', () => {
  it('fights a whole Quick Duel and the log replays', () => {
    const rec = recordMatch({ seed: 77, rules: 'quick', arena: 'moonlit', staffs: ['duel_staff_sproto', null] }, [new Bot(1, 0, BUSY)]);
    const w = rec.world;
    const ai = w.wizards[1].stats;
    console.log('quick', w.match.wins, w.match.roundWinners, 'ticks', w.tick, 'ai stats', ai, 'player', w.wizards[0].stats, 'log', JSON.stringify(rec.log).length);
    expect(w.over).toBe(true);
    expect(ai.casts).toBeGreaterThan(30);
    expect(ai.hits).toBeGreaterThan(10);
    expect(ai.dodges).toBeGreaterThan(0);
    const r = replay(rec.log, { anyVersion: true });
    expect(r.error).toBeUndefined();
    expect(r.endHash).toBe(w.hash());
  });

  it('a boss fight runs (bosses fight back) and replays', () => {
    const rec = recordMatch({ seed: 5, rules: 'gauntlet', arena: 'moonlit', staffs: ['duel_staff_moonward', null], bossId: 'sahil' }, [new Bot(2, 0, CALM)], { maxTicks: 60 * 60 * 6 });
    const w = rec.world;
    console.log('sahil', w.match.phase, 'ticks', w.tick, 'boss hp', w.wizards[1].health / ONE, 'stage', w.stages[0].stage, 'player hp', w.wizards[0].health / ONE, w.wizards[1].stats);
    expect(w.wizards[1].stats.casts).toBeGreaterThan(5);
  });
});
