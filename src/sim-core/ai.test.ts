import { describe, expect, it } from 'vitest';
import { ONE } from './fixed';
import { replay } from './replay';
import { BUSY, Bot, CALM } from './testing/bot';
import { SimWorld } from './world';
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

  it('a boss walks round cover instead of hanging behind it (Tinubu and a player standing at the spawn)', () => {
    // Seed 7000: Tinubu ends up with a basalt outcrop between him and the player and a lava pool at
    // his side. He used to pace there, out of sight, for nine minutes; now he sidesteps the rock.
    const w = new SimWorld({ seed: 7000, rules: 'gauntlet', arena: 'moonlit', staffs: [null, null], bossId: 'tinubu' });
    w.events.enabled = false;
    const boss = w.wizards[1], p = w.wizards[0];
    let ax = boss.pos.x, az = boss.pos.z, still = 0, worst = 0, fight = 0;
    while (!w.over && fight < 60 * 60 * 5) {
      const fighting = w.match.phase === 'fight';
      w.step([null, null, null]);
      if (!fighting) continue;
      fight++;
      const dx = boss.pos.x - ax, dz = boss.pos.z - az;
      const blind = !w.arena.clear(boss.pos.x, boss.pos.y + boss.chestY, boss.pos.z, p.pos.x, p.pos.y + p.chestY, p.pos.z, false);
      if (!blind || dx * dx + dz * dz > (3 * ONE) * (3 * ONE)) {
        ax = boss.pos.x;
        az = boss.pos.z;
        still = 0;
      } else if (++still > worst) worst = still;
    }
    console.log('tinubu vs a standing player: worst stall', (worst / 60).toFixed(1), 's, over', w.over, 'after', (fight / 60).toFixed(0), 's');
    expect(worst).toBeLessThan(60 * 20);
    expect(w.over).toBe(true);
  });
});
