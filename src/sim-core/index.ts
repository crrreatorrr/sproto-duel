/** Deterministic duel simulation (pure TypeScript, no DOM, no Rapier). See docs/SERVER-SIM.md. */
export * from './fixed';
export { Rng } from './rng';
export { Hasher } from './hash';
export { SimArena, ARENA_IDS, ARENA_LAYOUTS, isArenaId, type ArenaId, type Obstacle } from './arena';
export { SimEvents, type SimEvent } from './events';
export { SimWizard, ACTIONS, HELD_BOLT, HELD_SPRINT, emptyInput, type SimInput, type StaffStats } from './wizard';
export { SimSpells, type SimProjectile } from './spells';
export { SimTickets } from './tickets';
export { STAFFS, STAFF_IDS, staffStats } from './staffs';
export { simRules, RULES_IDS, isRulesId, type RulesId, type SimRules } from './rules';
export { SimWorld, DIFFICULTIES, isDifficulty, type SimSetup, type MatchState, type Phase } from './world';
export { replay, LogRecorder, MAX_TICKS, type ReplayResult } from './replay';
export { LOG_SCHEMA, SeatReader, SeatWriter, chunkLog, joinChunks, toBase64, fromBase64, CHUNK_BYTES, LOG_MAX_BYTES, type DuelLog } from './log';
export { simVersion, setSimVersion } from './version';
export { AIM_DIST, moveVector } from './wizard';
