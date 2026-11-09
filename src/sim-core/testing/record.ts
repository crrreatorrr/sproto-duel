/** Record a whole match driven by bots (tests, goldens, size measurements). */
import { LogRecorder } from '../replay';
import type { DuelLog } from '../log';
import { SimWorld, type SimSetup } from '../world';
import type { SimInput } from '../wizard';
import type { Bot } from './bot';

export interface Recorded {
  world: SimWorld;
  log: DuelLog;
  bytes: number;
}

/**
 * Play `setup` with one bot per input seat (in world.inputSeats() order) until the match ends,
 * `maxTicks` pass, or `forfeit` fires (a seat leaving before tick `forfeit.tick`). `godToggles`
 * turn seat 0's god mode on or off before the given ticks, as the game does mid-fight.
 */
export function recordMatch(
  setup: SimSetup,
  bots: Bot[],
  opts: { maxTicks?: number; forfeit?: { tick: number; seat: number }; godToggles?: { tick: number; on: boolean }[] } = {},
): Recorded {
  const world = new SimWorld(setup);
  world.events.enabled = false;
  const rec = new LogRecorder(world);
  const seats = world.inputSeats();
  const frames: (SimInput | null)[] = [null, null, null];
  const max = opts.maxTicks ?? 60 * 60 * 40;
  while (!world.over && rec.ticks < max) {
    for (const g of opts.godToggles ?? []) {
      if (g.tick === rec.ticks && rec.markGodMode(g.on)) world.setGodMode(g.on);
    }
    if (opts.forfeit && opts.forfeit.tick === rec.ticks) {
      rec.markForfeit(opts.forfeit.seat);
      world.forfeit(opts.forfeit.seat);
      break;
    }
    for (let i = 0; i < seats.length; i++) {
      const f = bots[i].input(world);
      frames[seats[i]] = f;
      rec.frame(i, f);
    }
    world.step(frames);
    rec.after();
  }
  const r = world.match;
  const log = rec.log({ winnerSeat: world.over ? (r.winner as 0 | 1) : null, wins: [r.wins[0], r.wins[1]], rounds: r.roundWinners.length, ticks: world.tick });
  return { world, log, bytes: rec.size };
}
