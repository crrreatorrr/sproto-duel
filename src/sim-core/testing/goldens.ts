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

const ALL_SPELLS = ['carpet', 'pump', 'vape', 'lockon', 'breath'];
const BOSS_LIST = ['sahil', 'obama', 'broccoli', 'agent', 'tinubu'];
const STAFF_LIST = ['duel_staff_sproto', 'duel_staff_momentum', 'duel_staff_moonward', 'duel_staff_nobu', 'duel_staff_fighters_might', 'duel_staff_alien_ray'];

export const GOLDEN_CASES: GoldenCase[] = [
  // Online and Local Versus: both seats logged, staffs are looks only.
  { name: 'online-busy-vs-calm', setup: { seed: 101, rules: 'online', arena: 'moonlit', staffs: ['duel_staff_sproto', 'duel_staff_nobu'] }, styles: [BUSY, CALM], botSeeds: [1, 2] },
  { name: 'versus-busy-mirror', setup: { seed: 102, rules: 'versus', arena: 'moonlit', staffs: [null, null] }, styles: [BUSY, BUSY], botSeeds: [3, 4] },
  { name: 'online-forfeit-seat1', setup: { seed: 103, rules: 'online', arena: 'moonlit', staffs: [null, null] }, styles: [BUSY, CALM], botSeeds: [5, 6], forfeit: { tick: 3000, seat: 1 } },
  { name: 'online-forfeit-seat0-intro', setup: { seed: 105, rules: 'online', arena: 'moonlit', staffs: [null, null] }, styles: [CALM, BUSY], botSeeds: [9, 10], forfeit: { tick: 60, seat: 0 } },
  // Round 1: nobody fights (a draw on time); round 2: a timeout won on health; round 3 a KO.
  { name: 'online-draw-timeout-ko', setup: { seed: 104, rules: 'online', arena: 'moonlit', staffs: [null, null] }, styles: [[DUMMY, CALM, BUSY], [DUMMY, DUMMY, CALM]], botSeeds: [7, 8] },
  { name: 'versus-timeouts', setup: { seed: 106, rules: 'versus', arena: 'moonlit', staffs: [null, null] }, styles: [[CALM], [DUMMY]], botSeeds: [11, 12] },
  // Quick Duel against the CPU rival, one per staff (staff stats apply here).
  ...STAFF_LIST.map((staff, i) => ({ name: 'quick-' + staff.replace('duel_staff_', ''), setup: { seed: 200 + i, rules: 'quick' as const, arena: 'moonlit' as const, staffs: [staff, null] }, styles: [BUSY], botSeeds: [20 + i] })),
  { name: 'quick-learned-spells', setup: { seed: 210, rules: 'quick', arena: 'moonlit', staffs: ['duel_staff_momentum', null], learned: ALL_SPELLS }, styles: [BUSY], botSeeds: [30] },
  { name: 'quick-god-mode', setup: { seed: 211, rules: 'quick', arena: 'moonlit', staffs: [null, null], godMode: true }, styles: [CALM], botSeeds: [31] },
  // Boss Gauntlet: a god-mode win through all three stages, and an honest loss, per boss.
  ...BOSS_LIST.map((boss, i) => ({ name: 'gauntlet-' + boss + '-god-win', setup: { seed: 300 + i, rules: 'gauntlet' as const, arena: 'moonlit' as const, staffs: ['duel_staff_fighters_might', null], bossId: boss, learned: ALL_SPELLS.slice(0, i), godMode: true }, styles: [BUSY], botSeeds: [40 + i] })),
  ...BOSS_LIST.map((boss, i) => ({ name: 'gauntlet-' + boss + '-loss', setup: { seed: 400 + i, rules: 'gauntlet' as const, arena: 'moonlit' as const, staffs: [STAFF_LIST[i], null], bossId: boss, learned: ALL_SPELLS.slice(0, i) }, styles: [BUSY], botSeeds: [50 + i] })),
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
