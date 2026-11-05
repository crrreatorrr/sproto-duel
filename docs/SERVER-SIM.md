# Server-verifiable Duel simulation

`src/sim-core/` is a deterministic, pure-TypeScript simulation of a Sproto Duel fight. The hub's
Nakama runtime (goja) re-runs a match from its recorded inputs and gets the same result, so the
browser no longer decides who won.

This document grows with the stacked pull requests:

| PR | Adds |
|---|---|
| A1 | `src/sim-core`: fixed-point math, arena and collision, wizards, spells, golden tickets, fire ring, round flow, state hash |
| A3 | input log format, `replay(log)`, the goja-safe bundle `dist/duel-sim.server.js` and its checker |
| A4 | golden replays, fuzz test, goja runner, CI jobs |
| A5 | the CPU rival's AI and the story bosses inside the sim |
| A2 | the game runs on sim-core (local, CPU and online host); Rapier is visual only |

## Locked bundle contract (hub)

```js
// dist/duel-sim.server.js: goja-safe ES5, one file, top-level globals, no imports at runtime,
// no WASM, async, Date or Math.random.
var DUEL_SIM_VERSION = '<sha256(body)[0:16]>';
DuelSim.replay(log) -> { ok, error?, simVersion, winnerSeat: 0|1|null, wins: [n, n], rounds, ticks, bossId?, endHash }
```

- `log`: `{ schema: 1, simVersion, seed, rules, staffs, ticks, inputs, claimed: {...} }`. `inputs`
  holds one run-length-encoded, base64 input stream per seat. The hub ignores `claimed` except to
  compare it with the replay.
- `replay` is pure and never throws: bad input gives `{ ok: false, error, simVersion, endHash }`.
  `endHash` is always present.
- `bossId` strings: `sahil`, `obama`, `broccoli`, `agent`, `tinubu`.
- The seed is server-issued and travels in the log (online: the `OP_START` seed).
- Targets: a full match replays in under 50 ms; a log is at most 16 KB and is sent in socket chunks
  of at most 4096 bytes.
- CI fails if the bundle changes without its version header changing.

## Input log (schema 1)

```js
{
  schema: 1,
  simVersion: '04bb17c13f61ddde',   // DUEL_SIM_VERSION of the bundle built from the client's source
  seed: 123456,                     // server-issued (online: OP_START seed)
  rules: 'online',                  // 'online' | 'versus' | 'quick' | 'gauntlet'
  staffs: ['duel_staff_nobu', null],// hub item id per seat; even rules (online, versus) ignore staff stats
  bossId: 'sahil',                  // gauntlet only
  ticks: 13464,                     // 60 Hz ticks simulated, up to and including the match's last
  inputs: ['<base64>', '<base64>'], // one stream per input seat (seat 0 first); CPU seats are simulated
  forfeit: { tick: 3000, seat: 1 }, // optional: seat leaving before tick index `tick`
  claimed: { winnerSeat: 1, wins: [1, 2], rounds: 3, ticks: 13464 }
}
```

Each seat's stream (`src/sim-core/log.ts`) is a varint record count followed by range-coded
records (`rc.ts`, an adaptive binary range coder in integer math). A record is written only on a
tick where something changed or was read: the gap since the previous record, a flags byte, then
the changed fields:

| Field | When | Content |
|---|---|---|
| move | the move changed | 0 = none, else 1 + 32 directions x 4 speeds; persists |
| held | held buttons changed | bit 0 hold bolt, bit 1 sprint; persists |
| press | a button was pressed | 12 bits in intent-frame order (bolt, blast, shield, stun, ultimate, dodge, jump, carpet, pump, vape, lockon, breath) |
| facing | the sim read the facing | 1/1024 turn, delta-coded |
| aim | the sim read the aim | yaw and pitch from the chest (1/1024 turn) and a distance bucket (0.5 m x 1.25^k) |

**Facing and aim are read lazily.** The sim pulls them only on ticks that use them: a spell
leaving the muzzle, a roll with no direction, a boss flash checking where you look. The log
keeps them only for those ticks. A replay that needs one the log doesn't carry fails with
`facing or aim missing`, and a logged one that goes unused fails with `unused facing or aim`.
Both are tamper checks. This is what keeps logs small: aim moves every frame, but it matters
only a few times a second.

The game records the stream as it plays (`LogRecorder` in `replay.ts`): before each tick it
quantizes each local seat's intent into a `SimInput`, and after the step writes whatever the sim
read.

### Sizes

The scripted bots in `src/sim-core/testing/bot.ts` play busier than most people do: they change
direction constantly and fire in bursts. A full three-round online match (13 464 ticks, both seats
logged) takes 10.0 KB of JSON, against the hub's 16 KB limit. Gauntlet and Quick Duel logs carry
one seat. `chunkLog(json, id)` splits a log into socket messages of at most 4096 bytes
(`id:i:n:part`), and `joinChunks` reassembles them in any order (both are exported by the bundle
too).

## Calling replay() on the hub

```js
// Load once at module init (like Fighter's vendor/sproto-sim.js): it defines DUEL_SIM_VERSION and DuelSim.
var r = DuelSim.replay(logObjectOrJson);
if (!r.ok) { /* reject: r.error says why; r.endHash is still set */ }
// r.winnerSeat (0 | 1), r.wins, r.rounds, r.ticks, r.endHash, r.endReason ('ko' | 'time' | 'forfeit')
```

- `replay` checks `log.simVersion === DUEL_SIM_VERSION` and rejects anything else. Keep the
  bundle of every client build still in play if old logs must verify (one per version).
- It rejects logs that run past the match's end, end before it, carry streams that don't decode,
  or whose `claimed` result differs from the replay. Compare `winnerSeat` with the seat the
  reporting player holds.
- **Seats:** seat 0 always spawns on the -z mark (side 0) and seat 1 on +z, whichever client
  hosts. Online, seat numbers are the server's `OP_START` seats.
- `endReason` is an extra field beyond the locked contract: the forfeit pay rules need it.

## Versioning

`DUEL_SIM_VERSION` is `sha256(body)[0:16]`, where *body* is every byte of the bundle after its
first line (the first line is `var DUEL_SIM_VERSION = '...';\n`). Any change to `src/sim-core` or
to the tuning it reads (`src/config.ts`) changes the bundle and so the version, and old logs stop
verifying against the new bundle. `npm run build:server-sim` regenerates it. CI fails when:

- the committed bundle differs from a fresh build (`npm run check:server-sim`);
- the header doesn't match the body hash, or the bundle uses anything outside ES5 or the allowed
  `Math` functions (`scripts/check-server-bundle.mjs`);
- a pull request changes the bundle without changing the version (`--base origin/main`).

## Determinism

- **Integers only.** Every simulated quantity is an integer in a JS number, far inside +-2^53, so
  add, subtract and multiply are exact. Division and square root go through `Math.floor` of an
  IEEE-754 result, identical on V8, SpiderMonkey, JavaScriptCore and goja. `isqrt` corrects the
  root to the exact floor.
- **Units** (`src/sim-core/fixed.ts`): distance, speed, health, mana, Ultimate charge and multipliers
  are Q16 (65536 = 1.0); time is TU = 1/6000 s, so one 60 Hz tick is exactly 100 TU; angles are
  1/65536 of a turn.
- **No engine math.** `Math.sin/cos/atan2/exp/pow/hypot/random` differ in their last bits between
  engines and are never used inside the sim. Sine comes from an integer quarter-wave table
  (`tables.ts`, generated once by `scripts/gen-sim-tables.mjs`); `atan2` is integer CORDIC; the
  per-tick exponential decays are precomputed Q16 constants.
- **Seeded PRNG** (`rng.ts`, sfc32 on 32-bit integer ops). Golden-ticket spots, deflect scatter and
  every other random choice come from it, seeded by the log's `seed`.
- **Fixed tick**: 60 Hz, one input frame per seat per tick. The game's hit-stop and slow motion
  stay presentation-only.
- **State hash** (`hash.ts`): two-lane FNV-1a over every outcome-relevant integer (wizards,
  projectiles, waves, trails, obstacles, tickets, fire ring, match state, PRNG state), 16 hex digits.

## What the sim covers (A1)

The port follows the game's own code paths, tick order and tuning (`CONFIG` in `src/config.ts` is
read directly, so tuning cannot drift):

- `world.ts`: Game.tick order (intents, timers, spells, movement, moving cover, fire ring, tickets,
  match flow) and Match (intro countdown, 80 s rounds, sudden death closing the fire ring, KO and
  timeout winners, best of three, forfeits).
- `wizard.ts`: Wizard (mana and regen, sprint exhaustion, cooldowns, input buffering, dodge rolls,
  Momentum blinks, jumps with coyote time, standing on stumps and low cover, sliding off heads,
  knockback).
- `spells.ts`: SpellSystem (bolts, blasts with splash and cover, shields with perfect reflects and
  deflects, the stun beam, the Ultimate wave with jump clearance and cover, clashes, the blink trail,
  the single damage rule).
- `arena.ts`: every layout (pillar rings, the office, the four boss arenas), obstacle health,
  crumbling to stumps, glass, sliding blocks, lava, drifting clouds, and the collision queries.
- `tickets.ts`: golden tickets.
- `staffs.ts`: all staffs, including `duel_staff_fighters_might` (Fist Bolt: 2x damage, 1.85x fire
  interval). The game's Staff Rack has no mesh for it yet; the sim accepts it in a loadout.

## Differences from the Rapier version

Kept small on purpose; each is a consequence of replacing the physics engine:

- Wizards collide as vertical cylinders, not capsules (the capsule's rounded ends only mattered on
  ledge corners).
- The outer wall is a true circle (Rapier used 56 boxes, whose inner faces sit on the same circle).
- Projectiles are swept spheres against cover grown by the sphere's radius: box corners are
  slightly generous (square instead of rounded by 0.16 m for a bolt).
- The character controller is a custom slide: horizontal substeps of at most 0.15 m pushed out of
  cover, then a vertical step that lands on tops. Wizards move one after another within a tick
  (Rapier moved them against each other's previous positions).
- Facing follows the input directly when read (the game smoothed it over about two ticks; the
  smoothing stays in the visuals).
- Spells leave from each look's static muzzle point (the manifest's measured point), not from a
  rigged animation's release position.
- Floor positions round to 1/65536 m and timers to 1/6000 s.
