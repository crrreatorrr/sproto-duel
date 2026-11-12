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
- Targets: a full match replays in under 50 ms; a log is sent in socket chunks of at most 4096
  bytes. A duel log stays under 16 KB; a boss-fight log does not (see Sizes: allow 64 KB). The
  client and the bundle enforce no size limit themselves: `replay` bounds a log by ticks
  (`MAX_TICKS`, 45 minutes), and the hub should cap the bytes it accepts.
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
  godMode: true,                    // optional: seat 0 starts in god mode (not under even rules)
  godToggles: [{ tick: 900, on: false }], // optional: god mode set before tick index `tick`, in order
  difficulty: 'easy',               // optional, Quick Duel only: the CPU rival ('easy' | 'normal' | 'hard'); missing = 'normal'
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
logged) takes about 7 to 12 KB of JSON. Gauntlet and Quick Duel logs carry one seat, but a boss
fight is much longer: the scripted bot's losses in the golden set (sim version `8f68aa09e9873540`)
are 5.9 KB (13 400 ticks, 3.7 minutes) to 26.4 KB (76 600 ticks, 21.3 minutes, the first boss), about
1.2 to 1.6 KB a minute, and a fight that uses both checkpoints and runs to its caps can be longer
still. A hub limit of 16 KB rejects honest boss fights, and 32 KB is too close to the longest golden:
allow 64 KB. At the bot's rate the 45-minute tick bound is about 56 to 68 KB; people press less than
the bot, but that has not been measured, so size the limit from the bot. `chunkLog(json, id)` splits a log into socket messages of at most 4096 bytes
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
- `endReason` is an extra field beyond the locked contract: the forfeit pay rules need it. So is
  `checkpoints` (boss fights: stage checkpoints the player used, 0 to 2).

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
  interval) and `duel_staff_alien_ray` (Alien Ray: 3x damage, stock fire interval).

## CPU rival and story bosses (A5)

Quick Duel and Boss Gauntlet fights run their CPU fighters inside the sim, so the server
re-runs the opponent exactly. Only seat 0 (the player) is logged.

- `ai.ts` ports `src/enemy/AIController.ts`: states, threat perception, timed and perfect
  shields, rolls, wave jumps, retreats to cover, golden tickets, double-fight formation, stage
  volleys, special powers and evading them. Every random choice comes from the world's PRNG.
  The reward-spell, life-pack and spring logic of AIController is left out: only the QA soak's
  reference player used it, never the rival or a boss.
- `stages.ts` ports BossStages: three bars per boss, stage stats (damage, spell damage,
  Ultimate charge, hurtbox from the stage model's fit height, muzzles, flight), the evolve
  shockwave. **Transformations follow the live game.** The cinematic freezes the world, then the
  boss is back with a full bar and is immune for `cinematic.grace` s. In the sim this happens in
  zero ticks: the game stops stepping the sim while its cinematic plays, so the log has no ticks
  for it.
- `powers.ts` (BossPowers: all nine hazard kinds), `rewards.ts` (the five reward spells),
  `shifts.ts` (pools, quicksand, spring, vents, ring cap) and `lifepacks.ts` port the rest of a
  boss fight.
- The gauntlet clock and its safety caps (stage cap, 35-minute cap) close the fire ring as in
  `GauntletClock`.
- **Boss ids**: `sahil`, `obama` (the double fight with The Midget: one defeat when both are
  down), `broccoli`, `agent`, `tinubu`. The arena comes from the boss.
- **Extra log fields**: `bossId` (gauntlet), `learned` (the reward spells the player brings: the
  hub should check they are ones this account has earned), `godMode` (seat 0 starts in god mode)
  and `godToggles` (turned on or off mid-fight). The replay simulates both, and the hub decides
  whether such a win pays; we suggest not.
- **Checkpoints** (`CONFIG.campaign.checkpoint`): a knockout of the player in a boss's second or
  third stage restarts that stage instead of ending the fight, once per stage. In the same tick the
  sim clears spells, hazards, tickets and the life pack, puts everyone standing back on the mark,
  refills the player (the Ultimate charge is kept) and each standing boss's current bar, hands
  back one spent life pack and runs a countdown (`introTime` + `banner` s of locked ticks, which
  are in the log like any other). The arena, its shifts and the fight clock carry on; the stage's
  cap clock starts over. The replay result's additive `checkpoints` (boss fights only) says how
  many were used, so the hub can tell a clean win from one that needed them.
- **Combat rules:** a stunned wizard takes `stunnedDamageMultiplier` (1.5×) damage, and a hit that
  lands while its caster is stunned deals 1.5× (both stack). The stun beam's own hit lands before
  its stun. Each boss transformation heals the player by `campaign.phasePotionHeal` (33%) of max
  health (the `phasePotion` event).
- **Quick Duel rival**: the player picks Apprentice, Adept or Archmage on the main menu. The log's
  `difficulty` (`easy`, `normal`, `hard`) names the profile the sim's CPU plays; it is left out for
  `normal` and rejected under any other rules. A win's replay proves which rival was beaten, so the
  hub can weigh an Apprentice win differently if it wants to.
- **Size**: one seat, about 1.2 to 1.6 KB of log per minute for the scripted bot; the bot's losses
  are 6 to 26 KB (see Sizes above for what the hub should allow).

## The game on the sim (A2)

Every match the game plays runs on sim-core: Quick Duel, Local Versus, the Boss Gauntlet and the
online host. `src/core/SimDriver.ts` does this every fixed tick:

1. Each input seat's intent is quantized into a `SimInput` (`src/core/simInput.ts`) and recorded.
   Local humans are sampled from the controller's intent and the camera aim point. The online
   guest is sampled from its intent frames (RemoteSource). The aim is turned into yaw, pitch and
   distance from the sim wizard's chest before the step, exactly as the sim rebuilds it.
2. `SimWorld.step`.
3. The sim's state is written onto the game's objects: wizards, projectiles by id, cover health,
   crumbling and sliding, golden tickets, Ultimate waves, the fire ring and the match. In boss fights
   it also writes power hazards, smoke screens, arena shifts, the life pack and the ring cap. The
   visuals and the HUD read those objects as before.
4. The sim's events become the game's event bus (audio, HUD, popups, cinematics), plus the effects
   SpellSystem used to play inline (impacts, explosions, clashes, beams, hit-stop, shake, PERFECT!).

While a driver runs, the game's own gameplay code does not: SpellSystem casting and damage,
Wizard movement, Match's flow, the AIControllers, BossPowers, RewardSpells, ArenaShifts and
LifePacks. These classes only present now. Rapier still serves the camera collision and the
crosshair raycast.

- **Boss transformations:** the sim emits `bossEvolve`, and the game's BossStages plays the look
  change and BossCinematic its cinematic. While the cinematic freezes the world the game doesn't step
  the sim, so no ticks are logged for it.
- **The online host** sets the sim's seed, staffs and seats from `OP_START`. Sim seat N is network
  seat N, so a host holding seat 1 plays sim seat 1 (it spawns on the +z mark). It sends the log
  in `OP.LOG` chunks after RESULT and on a forfeit. If the opponent forfeits, the log records that
  first. The guest is unchanged: a replica of the host's snapshots.
- **Hub reports:** a Quick Duel or gauntlet win passes the log to `HubLink.onDuelWin`. It rides in
  the boss event's data (`replay`, today only Tinubu's `sproto.boss_defeated`) and is kept as
  `HubLink.lastReplay`. **The SDK's `earnTickets` takes no data, so the Tickets earn call can't carry
  it.** The hub needs a `sproto.boss_defeated` report for every boss, or an RPC that takes the log,
  before it can pay the per-boss reward on a verified replay.
- **God mode** can be toggled mid-fight. The setup's `godMode` is how the fight starts, and each
  toggle goes into the log's `godToggles` and applies before that tick, in the game and the replay
  alike (`SimWorld.setGodMode`). God mode also teaches all five reward spells; the log's `learned`
  holds only the spells the player brought, and they come back when god mode turns off. A log
  holds at most 256 toggles (`MAX_GOD_TOGGLES`); past that the game refuses further toggles in
  that fight. Any `on: true` toggle means god mode was used.
- **Not on the sim:** the QA sandbox's older scenarios and its `soak` / `campaignSoak` still run
  the legacy engine, so they test the old code paths (the legacy engine has no checkpoints).
  `__duel.qa.sim`, the `sim.*` scenarios and `npm run probe:sim` run the sim itself (README, QA). Online replicas run no sim at all.
- `node scripts/check-game-sim-e2e.mjs` plays a Quick Duel and a boss fight in the real game in
  Chromium and checks the game's own log replays, with the server bundle, to the game's own end
  hash. It takes a few minutes and is not in CI.

### Feel differences

On top of the physics differences listed below:

- **Facing** follows the camera at once. The visual smoothing is unchanged.
- **Aim and movement** are quantized: 32 move directions and 4 speeds, aim in 1/1024 turn and
  log-spaced distance buckets.
- **Transformations** use the live game's rule in every gauntlet fight: a full bar after the
  cinematic, and 0.35 s of immunity.
- **Muzzles:** spells leave from the static muzzle points.

None of this has been playtested by people yet.

## Golden replays and tests (A4)

`tests/golden/*.json` holds 26 recorded matches: `{ name, log, expect }`. `npm run gen:goldens`
rewrites them from `src/sim-core/testing/goldens.ts`. Run it only for an intended sim change, and
review the diff. They cover:

- online and Local Versus: KO, timeouts, a drawn round, and forfeits by either seat, one of them
  during the intro;
- Quick Duel against the CPU rival with every staff, including `duel_staff_fighters_might` and
  `duel_staff_alien_ray`; with all reward spells learned; and in god mode;
- every boss: a god-mode win through all three stages, and an honest loss;
- two boss fights where god mode goes off in a later stage, so a knockout there takes the stage
  checkpoint and the next one is the defeat.

The inputs come from scripted bots (`src/sim-core/testing/bot.ts`), not people. The same logs are
checked in four places, and each must give the frozen `endHash` and result:

| Where | Command | CI |
|---|---|---|
| source, Node | `npm test` (`src/sim-core/bundle.test.ts`) | test and build |
| bundle, Node (bare vm context) | `npm test` | test and build |
| bundle, Chromium | `npm run test:goldens-browser` | server-sim |
| bundle, goja | `npm run test:goja` (`tools/goja-replay`) | server-sim |

`src/sim-core/fuzz.test.ts` replays 24 random well-formed logs twice, which must hash the same,
and 200 random byte streams, which must be rejected without throwing.

## Performance

Measured on the 23 goldens of the time (4-core 2.8 GHz Xeon container; the scripted bot's boss
losses run longer since the 2026-11 balance batches, up to about 77k ticks, and take up to about 55 s on goja on a loaded machine):

| Engine | Duel (7k-19k ticks) | Boss fight, god-mode win (2k-4k ticks) | Boss fight, long loss (16k-36k ticks) |
|---|---|---|---|
| Node 22 (V8), bundle in plain script scope, warm | 40-80 ms | 25-50 ms | 100-400 ms |
| Chromium (V8) | 25-55 ms | | |
| goja | 1.5-2.8 s | 1.2-1.4 s | 4-20 s |

**The 50 ms target is not met on goja.** On this machine goja runs a bare `for` loop at about
540 ns per iteration and a function call at about 0.85 us. A 14,000-tick match at 60 Hz therefore
leaves a budget of about 3.5 us, roughly four calls, per tick. Two optimisation passes (no per-tick
allocations, cheap bounding-box rejects) gave about 30%. Inlining the fixed-point helpers at build
time gave about 5% more and was dropped. Options for the hub:

1. Verify off the request path: replay at match end on a pooled JS VM, and pay when it's done.
2. Run `dist/duel-sim.server.js` in a small Node sidecar: duels in under 100 ms, boss fights in
   under half a second.
3. Keep goja and accept multi-second verifies for long fights.

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
