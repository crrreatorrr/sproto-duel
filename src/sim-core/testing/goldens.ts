/**
 * The golden replay set: recorded matches whose results and end hashes are frozen in
 * tests/golden/*.json. `npm run gen:goldens` rewrites them (only when a sim change is intended);
 * tests replay them from source, from the bundle in Node, in a browser and on goja.
 */
import { replay } from '../replay';
import type { SimSetup } from '../world';
import { BUSY, Bot, CALM, DUMMY, type BotStyle } from './bot';
import { recordMatch } from './record';

export interface GoldenCase {
  name: string;
  setup: SimSetup;
  styles: (BotStyle | BotStyle[])[];
  botSeeds: number[];
  forfeit?: { tick: number; seat: number };
  maxTicks?: number;
}

export const GOLDEN_CASES: GoldenCase[] = [
  { name: 'online-busy-vs-calm', setup: { seed: 101, rules: 'online', arena: 'moonlit', staffs: ['duel_staff_sproto', 'duel_staff_nobu'] }, styles: [BUSY, CALM], botSeeds: [1, 2] },
  { name: 'versus-busy-mirror', setup: { seed: 102, rules: 'versus', arena: 'moonlit', staffs: [null, null] }, styles: [BUSY, BUSY], botSeeds: [3, 4] },
  { name: 'online-forfeit', setup: { seed: 103, rules: 'online', arena: 'moonlit', staffs: [null, null] }, styles: [BUSY, CALM], botSeeds: [5, 6], forfeit: { tick: 3000, seat: 1 } },
  // Round 1: nobody fights (a draw on time); round 2: a timeout won on health; round 3 a KO.
  { name: 'online-draw-timeout-ko', setup: { seed: 104, rules: 'online', arena: 'moonlit', staffs: [null, null] }, styles: [[DUMMY, CALM, BUSY], [DUMMY, DUMMY, CALM]], botSeeds: [7, 8] },
];

export interface GoldenFile {
  name: string;
  log: ReturnType<typeof recordMatch>['log'];
  expect: Record<string, unknown>;
}

export function buildGolden(c: GoldenCase): GoldenFile {
  const bots = c.styles.map((s, i) => new Bot(c.botSeeds[i], i, s));
  const rec = recordMatch(c.setup, bots, { forfeit: c.forfeit, maxTicks: c.maxTicks });
  const log = { ...rec.log, simVersion: 'any' };
  const r = replay(log, { anyVersion: true });
  if (!r.ok) throw new Error(`${c.name}: replay failed: ${r.error}`);
  const expect: Record<string, unknown> = { ok: r.ok, winnerSeat: r.winnerSeat, wins: r.wins, rounds: r.rounds, ticks: r.ticks, endHash: r.endHash, endReason: r.endReason };
  if (r.bossId) expect.bossId = r.bossId;
  return { name: c.name, log, expect };
}
