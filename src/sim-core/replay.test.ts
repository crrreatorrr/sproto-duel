import { describe, expect, it } from 'vitest';
import { CHUNK_BYTES, LOG_MAX_BYTES, chunkLog, joinChunks, replay, type DuelLog } from './index';
import { BUSY, Bot, CALM } from './testing/bot';
import { recordMatch } from './testing/record';

const any = { anyVersion: true };

describe('record and replay', () => {
  it('replays a recorded online match to the same result and hash', () => {
    const rec = recordMatch({ seed: 42, rules: 'online', arena: 'moonlit', staffs: ['duel_staff_nobu', 'duel_staff_momentum'] }, [new Bot(1, 0, BUSY), new Bot(2, 1, CALM)]);
    expect(rec.world.over).toBe(true);
    const r = replay(rec.log, any);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.endHash).toBe(rec.world.hash());
    expect(r.winnerSeat).toBe(rec.world.match.winner);
    expect(r.ticks).toBe(rec.world.tick);
    const json = JSON.stringify(rec.log);
    console.log('online log', json.length, 'bytes for', r.ticks, 'ticks, rounds', r.rounds, 'raw', rec.bytes);
    expect(json.length).toBeLessThan(LOG_MAX_BYTES);
    const chunks = chunkLog(json, 'm1');
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_BYTES);
    expect(joinChunks(chunks.slice().reverse())).toBe(json);
  });

  it('rejects a tampered log', () => {
    const rec = recordMatch({ seed: 9, rules: 'versus', arena: 'moonlit', staffs: [null, null] }, [new Bot(3, 0, BUSY), new Bot(4, 1, BUSY)]);
    const log: DuelLog = JSON.parse(JSON.stringify(rec.log));
    expect(replay(log, any).ok).toBe(true);
    // Another seed changes ticket spawns: the claimed result or the ending no longer holds.
    const other = replay({ ...log, seed: 10 }, any);
    expect(other.ok === false || other.endHash !== rec.world.hash()).toBe(true);
    // Claiming the other winner.
    const lie = replay({ ...log, claimed: { ...log.claimed, winnerSeat: log.claimed!.winnerSeat === 0 ? 1 : 0 } }, any);
    expect(lie.ok).toBe(false);
    // A truncated stream.
    const cut = replay({ ...log, inputs: [log.inputs[0].slice(0, 40), log.inputs[1]] }, any);
    expect(cut.ok).toBe(false);
    expect(typeof cut.endHash).toBe('string');
  });

  it('never throws on garbage', () => {
    const junk: unknown[] = [null, undefined, 0, 'x', [], {}, { schema: 1 }, { schema: 1, seed: 1, rules: 'online', staffs: [null, null], ticks: 5, inputs: ['@@@@', ''] },
      { schema: 1, seed: 1.5, rules: 'online', staffs: [null, null], ticks: 5, inputs: ['', ''] }, { schema: 1, seed: 1, rules: 'nope', staffs: [null, null], ticks: 5, inputs: [] }];
    for (const j of junk) {
      const r = replay(j as DuelLog, any);
      expect(r.ok).toBe(false);
      expect(typeof r.error).toBe('string');
      expect(typeof r.endHash).toBe('string');
    }
    expect(replay({ schema: 1, simVersion: 'nope', seed: 1, rules: 'online', staffs: [null, null], ticks: 5, inputs: ['', ''] }).error).toBe('simVersion mismatch');
  });

  it('handles forfeits', () => {
    const rec = recordMatch({ seed: 5, rules: 'online', arena: 'moonlit', staffs: [null, null] }, [new Bot(5, 0, BUSY), new Bot(6, 1, BUSY)], { forfeit: { tick: 2000, seat: 1 } });
    const r = replay(rec.log, any);
    expect(r.ok).toBe(true);
    expect(r.winnerSeat).toBe(0);
    expect(r.endReason).toBe('forfeit');
  });
});

describe('logs taken mid-match', () => {
  it('a log taken mid-match does not corrupt the final one', async () => {
    const { SimWorld, LogRecorder } = await import('./index');
    const { BUSY, Bot } = await import('./testing/bot');
    const world = new SimWorld({ seed: 4, rules: 'quick', arena: 'moonlit', staffs: [null, null] });
    const rec = new LogRecorder(world);
    const bot = new Bot(1, 0, BUSY);
    let t = 0;
    while (!world.over && t++ < 60 * 300) {
      const f = bot.input(world);
      rec.frame(0, f);
      world.step([f]);
      rec.after();
      if (t % 1200 === 0) rec.log();
    }
    const r = replay(rec.log(), { anyVersion: true });
    expect(r.error).toBeUndefined();
    expect(r.endHash).toBe(world.hash());
  });
});
