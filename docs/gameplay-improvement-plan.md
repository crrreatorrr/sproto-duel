# Sproto Duel: gameplay improvement plan

## 1. Status

Implemented on 2026-11-11, except B4, D3 and D4: see section 11 for what shipped, the values used
and the measurements after, section 12 for the follow-up, and section 13 for the independent check
of 2026-11-12, which is the current state where the three differ. Sections 2 to 10 are the plan as it was written, before any code
changed; where section 11 differs from a proposed number, section 11 is what the game does.

- Audited 2026-11-09 at `b59fd30`. Re-read 2026-11-11 at `2d4b984`: two commits landed in between,
  adding the relic-unlocked Fighter and Shooter staves and fixing the title staff preview. The core
  tuning (mana, spells, roll, AI profiles, boss health) is unchanged, so the findings stand. The new
  staves add finding F7. Line numbers below are from `2d4b984`.
- Measurements were taken at `b59fd30` and were not re-run.

## 2. How this was audited and how far to trust it

| Evidence | What was done | Limits |
| --- | --- | --- |
| Build | Typecheck clean. The QA harness is stripped from production builds, so a dev-mode snapshot was built. | |
| QA harness | 138 scenarios passed, 0 failed. Two timed out on a loaded machine (`arena.theme_cycle_no_leaks`, `campaign.ladder_reference_win_rates`). 124 of 264 were not run. | The harness scenarios run the legacy engine, not `src/sim-core` (F10). |
| Live playtest | The shipping `src/sim-core` path with real key and mouse events and rendering stubbed for speed: scripted players against the Rival, a full match to the results screen, four minutes of boss 1, input timing, pause, fire ring, resize, screenshots. No console errors. | Scripted players are not people. |
| AI against AI | Soaks on the legacy QA path at each profile. | |
| Reading | Online, Local Versus (needs a controller), bosses 2-5, cinematics. | Not exercised. Audio was not heard. |

Headless frame times (4-26 fps under load) are unusable; 134-147 draw calls and 62k triangles were
counted. The scripts were not kept. The scripted players were: "hold fire" (aim at the opponent,
hold bolt), "attacker" (the same with strafing, perfect aim variant included), "idle", "strafe" and
"roll spam" (roll on cooldown), each started from the title through real input events.

## 3. What already works and should be kept

- Movement reaches 95% of top speed in 6 frames and stops in 7.
- A bolt is cast on the frame after the press.
- AI-against-AI rounds last 51-70 s and all end in a knockout, never a stalemate.
- The HUD, boss cards and results screen are clear.
- No console errors and no NaN after key spam.

## 4. Findings

Current tuning (`src/config.ts`):

| Thing | Values |
| --- | --- |
| Mana | 100 maximum (line 396), regenerates 13 per second (397) after 0.3 s without spending (399) |
| Bolt | 4 damage, 5 mana, one every 0.17 s while held, speed 52 (467-473) |
| Blast | 20 damage with splash, 24 mana, 3 s cooldown, speed 20 (482-488) |
| Shield | 12 mana, 0.8 s, 5 s cooldown, perfect window 0.2 s, reflects at 1.5x damage |
| Stun | 6 damage, 22 mana, 8 s cooldown, 1.0 s stun, stunned targets take 1.5x |
| Ultimate | 38 damage; charge 0.5 per damage dealt and 0.2 per damage taken, 100 to fill (525-528) |
| Roll | 0.34 s, 0.28 s invulnerable, 0.55 s cooldown, no mana cost (422-424) |
| Sprint | 10 mana per second; needs 18 mana to re-engage after running dry (402-404) |
| Input buffer | 0.15 s (1050) |

### F1. Mana starvation breaks the core loop (High, observed)

Holding fire spends 5 mana every 0.17 s, about 29 per second, so a full bar is gone in 3.4 s. Each
bolt restarts the 0.3 s regeneration delay, which is longer than the 0.17 s fire interval, so mana
barely returns while the button is held: the measured result was 6 bolts per 5 s once dry. Blast
(24), Shield (12), Stun (22) and sprint all stay locked. The scripted players sat at 0-10 mana in
every sample. Refilling from empty takes about 8 s of not casting (0.3 s + 100 / 13). The most
natural thing to do in a wizard duel, hold fire, removes the rest of the kit.

### F2. Boss fights are long and low-threat (High, stage 1 observed, the rest read)

`src/campaign/levels.ts:204-212` says each stage is "sized for about five minutes", a fight "runs
15+ minutes", and the player has one life and three life packs. The first boss, Sahil, has 1620,
1660 and 1710 health (line 261); the comment on that line shows stage 1 was raised from 1490 on
purpose to keep it near five minutes. A scripted player dealt 1104 damage in 240 s (4.6 per second)
and took 51. That is about six minutes for stage 1 and eighteen for the fight, with almost no
danger, and a death anywhere restarts from stage 1.

Stage health for the ladder, in file order:

| Line | Stage health |
| --- | --- |
| 261 (Sahil) | 1620 / 1660 / 1710 |
| 318 | 380 / 440 / 500 |
| 369 | 450 / 515 / 560 |
| 419 | 880 / 900 / 1000 |
| 472 | 1096 / 1118 / 1274 |
| 531 | 1100 / 1111 / 800 |

The first fight has by far the most health. Later bosses were not played.

### F3. Quick Duel's only opponent is too strong and there is no choice (High, observed)

Quick Duel always uses the `normal` profile, the Rival (`src/App.ts:65-66`; the comment says the
Gauntlet is the difficulty ladder). The `easy` profile ("Apprentice": reaction 0.45 s, aim error
0.16, dodge 0.25) placed in the player's seat went 0-40 against it. Scripted attackers, including
one with perfect aim, won 0 of 8 rounds. `easy` and `hard` exist (`src/config.ts:1104` onward) but
cannot be selected. Quick Duel is the highlighted button on the menu, so it is most players' first
match.

### F4. Blast, Stun and the Ultimate fade as skill rises (Medium, soak)

Share of damage by spell in AI-against-AI soaks:

| Profile | Bolt | Blast | Stun | Ultimate |
| --- | --- | --- | --- | --- |
| easy | 39% | 39% | 11% | 11% |
| normal | 55% | 31% | 5% | 10% |
| hard | 86% | 9% | 1% | 5% |

Blast travels at 20 against the bolt's 52 and is easy to sidestep. The Ultimate does 38 damage and
needs about 200 damage dealt to charge; the hard AI jumped all six waves it faced.

### F5. Roll is free and dominant (Medium, observed)

Roll costs no mana and is invulnerable for 0.28 s of every 0.55 s cooldown. Time survived against
the Rival doing nothing else: idle 31.5 s, strafing 46.9 s, rolling on cooldown 70.8 s (Rival
accuracy 75%, 50%, 30%). Rolling while firing cost no damage output. A roll pressed during a roll
is dropped, because the 0.15 s buffer is shorter than the 0.55 s cooldown.

### F6. The Alien Ray Staff trivialises fights against the AI (Medium, observed)

It triples bolt damage at the same mana cost (`src/config.ts:813`). The scripted player that lost
with the stock staff won rounds in 31-35 s with it, and Sahil's first stage fell in about 95 s. The
Moonward staff is 1.5x (line 776).

### F7. The new staves bypass the mana economy (Medium, read at `2d4b984`, not played)

The Fighter Staff sets `boltManaMult: 0` (line 833): bolts cost nothing, which removes F1 for
whoever holds it and makes holding fire strictly correct. The Shooter Staff is 4x damage for 2x
mana (lines 823-824), double the damage per mana of the stock staff. Both are unlocked by Relics
from other games, so players who own them play a different game from those who do not, including
in any mode where staves apply online.

### F8. The online guest has no prediction (Medium, read)

The guest's own wizard is driven by the host with a 2-tick input delay plus 100 ms interpolation
(`README.md`, `src/config.ts:162-166`). Expect visibly late movement for the guest.

### F9. Onboarding is a text page below the fold (Medium, observed)

At 1280x720 the main menu is 1009 px tall; How to Play and Settings need scrolling. There is no
tutorial, and nothing teaches mana, reflecting with the shield, or Golden Tickets.

### F10. Smaller items (Low)

- The boss card says Magic Carpet lasts "2.5 s"; it is 3.5 s (`src/spells/rewardCatalog.ts:32`).
- Two "PERFECT!" callouts overlap illegibly.
- The desert arena washed out near the fire ring in one screenshot (unverified).
- Harness scenarios run the legacy engine while live fights run `src/sim-core`
  (`src/core/Match.ts`, `src/core/Game.ts`), so a harness pass does not prove the shipping path.
- All 54 sounds are synthesised placeholders.

## 5. The plan

Effort: S is under a day, M a few days, L a week or more. Proposed numbers are starting points.
"Sim change" means the server bundle must be rebuilt (section 6).

### Phase A: quick wins, no sim change

**A1. Fix the carpet text** to 3.5 s, or read it from config. `src/spells/rewardCatalog.ts:32`.
Effort S.

**A2. Stack callouts.** Offset a second "PERFECT!" by its height instead of drawing on top.
`src/ui/HUD.ts`. Effort S.

**A3. Menu fold.** Move How to Play and Settings above the character rack, or make the rack
collapse at heights under 800 px. `src/ui/Menus.ts`, `src/styles.css`. Effort S.

**A4. Quick Duel difficulty select** (against the choice recorded at `src/App.ts:65`; decision
8.2). Add Apprentice / Adept / Archmage to the Quick Duel setup using the existing profiles, default
Apprentice, remembered in settings. Replace the three `setProfile(QUICK_DUEL_AI)` calls
(`src/App.ts:937`, 1195, 1291). Check whether the match log needs to carry the profile for
verification. Effort S.

### Phase B: mana economy and core balance (sim change, one batch)

**B1. Mana economy** (F1).

| Value | Now | Proposed | Effect |
| --- | --- | --- | --- |
| `bolt.manaCost` | 5 | 3 | Held fire drains about 17.6 per second: 5.7 s from full |
| `manaRegen` | 13 | 18 | |
| `manaRegenDelay` | 0.3 | 0.12 | Shorter than the 0.17 s fire interval, so mana returns between bolts |
| Refill from empty | about 8 s | about 5.7 s | |

With these, held fire settles near a floor of regeneration rather than at zero, and a player who
pauses for two seconds can afford a Blast. Acceptance: in the scripted "hold fire" run, mana is
above 24 (one Blast) in at least a third of samples; in the "attacker" run with occasional pauses,
all four spells are cast at least once per round.

Because sustained bolt damage rises, re-tune health afterwards so AI-against-AI rounds stay at
51-70 s.

**B2. Give roll a cost** (F5). Cooldown 0.55 to 0.9 s, or a mana cost of 8. Raise the input buffer
for roll to 0.3 s so a second press is not lost. Acceptance: roll-on-cooldown survival falls from
70.8 s to within 15% of strafing.

**B3. Make the big spells worth casting** (F4).

| Value | Now | Proposed |
| --- | --- | --- |
| `blast.speed` | 20 | 26 |
| `stun.manaCost` | 22 | 14 |
| `ultimate.damage` | 38 | 55 |
| `ultimate.chargePerDamageTaken` | 0.2 | 0.5 (a comeback mechanic) |

Acceptance: at the hard profile, bolt share falls from 86% to under 70%.

**B4. Bring staves inside the economy** (F6, F7; decision 8.3). Options per staff: Alien Ray 3x to
2x; Shooter 4x for 2x mana to 3x for 2x; Fighter 0 mana to 0.5x mana. Or keep them as they are
against the AI and normalise them in Quick Duel difficulty above Apprentice and in all player
versus player modes.

Tests for the batch: update `src/sim-core/staffs.test.ts` and any pinned numbers; add harness
scenarios for the mana floor and the roll survival figure; re-run the AI soaks and record the
table from F4. Effort M.

### Phase C: Gauntlet pacing (sim change; decision 8.1)

**C1. Per-stage checkpoints.** A death on stage 2 or 3 restarts that stage with one life pack
restored, at most once per stage. `src/campaign/Campaign.ts`, `src/core/Match.ts`. Effort M.

**C2. Re-size stage health after Phase B.** Higher sustained damage will already shorten fights
and may undershoot the five-minute target recorded at `levels.ts:206`. Measure first, then set
health to hit whatever target the owner chooses. Fix the ladder so the first boss is not the
longest (F2 table). Effort S once the target is known.

**C3. Raise threat instead of length.** If shorter stages are chosen, raise boss damage per second
modestly so a stage costs the player roughly a third of a life rather than 51 health in four
minutes.

### Phase D: onboarding, harness, online, audio

**D1. Practice dummy or playable tutorial** covering mana, perfect shield and reflect, roll,
Blast and Golden Tickets. No sim change. Effort M.

**D2. Point the QA harness at `src/sim-core`** so scenario passes describe the shipping path.
Effort M.

**D3. Guest-side prediction** for the guest's own wizard, with reconciliation. `src/net`. Effort L.

**D4. Real audio pass** replacing the 54 placeholders. Effort L; needs assets.

## 6. Order and batching

1. Phase A (no sim change), with A4 once decision 8.2 is made.
2. Phase B as one sim change, then C2 and C3 in the same or the next batch so the hub is updated
   once or twice in total, not per number.
3. C1, then Phase D.

For each sim change: `npm run build:server-sim` rebuilds `dist/duel-sim.server.js`;
`npm run check:server-sim` checks the bundle; `npm run test:goja` replays the goldens under
`tests/golden`, which must be regenerated for intended behaviour changes; then metaverse-hub
re-vendors the bundle (see `docs/SERVER-SIM.md`). Say in the pull request that the sim version
changed.

## 7. Hub integration

From the hub audit of 2026-11-09 (the hub has changed a great deal since; confirm before acting):

- 20 Tickets per story boss per day, up to five; player-versus-player wins pay nothing.
- The wins leaderboard is written by the server; the Crown Relic is live.
- Ticket-to-Verse exchange works here, but the ceiling was about 10 Verse a day, a fifth of NOBU
  or People's Bitcoin.
- The staves in F6 and F7 are cross-game rewards. Changing them (B4) changes what a Relic from
  another game is worth, so agree it with the hub before shipping.
- Shorter boss fights (Phase C) make the daily Tickets faster to earn; the daily limit bounds it.

## 8. Decisions for the owner

1. **Gauntlet length.** The code records about five minutes a stage as the target. Options: keep it
   and add checkpoints (C1); shorten to two or three minutes a stage with more threat (C2, C3); or
   change nothing until Phase B is measured. Recommendation: Phase B first, then C1, then decide.
2. **One Quick Duel opponent or a difficulty select?** The single Rival is deliberate. The audit
   found no scripted player could win a round against it. Recommendation: add the select and
   default to Apprentice (A4).
3. **May reward staves be changed?** See B4. Recommendation: normalise them in player-versus-player
   modes at least.
4. **Is one hub re-vendor per balance batch acceptable?**

## 9. How to verify

- Repeat the scripted runs: mana samples (B1), roll survival (B2), spell share by profile (B3),
  damage per second and damage taken on Sahil stage 1 (C2).
- AI-against-AI rounds remain 51-70 s with every round ending in a knockout.
- A scripted Apprentice in the player seat wins 40-60% against the default Quick Duel opponent.
- Human playtest checklist: Does a new player win a round in their first three Quick Duels? Do they
  cast Blast, Shield and Stun without being told to? Do they run out of mana, and do they
  understand why? Does the first boss feel like a fight or a chore? Can they explain Golden Tickets
  afterwards?

## 10. Not audited

Online play, Local Versus with two controllers, bosses 2-5 in play, cinematics, audio by ear, real
hardware performance, and the 124 harness scenarios not run.

## 11. What was implemented (2026-11-11)

The owner's instruction was to implement everything with one exception: **no staff's bolt damage
or bolt mana multiplier changes, and the bolt itself stays at 4 damage and 5 mana.** So B4 was
skipped, and B1 met its target with the other levers.

| Item | Result |
| --- | --- |
| A1 | Done. The carpet texts read the ride time from config. |
| A2 | Done. A callout spawned over another sits above it. |
| A3 | Done. How to Play and Settings (and Practice) sit above the racks: on screen at 1280x720. |
| A4 | Done. Apprentice / Adept / Archmage under Quick Duel, Apprentice by default, saved. The rival runs in the sim, so the choice travels in the input log (`difficulty`). |
| B1 | Done without touching the bolt: `maxMana` 100 to 160, `manaRegen` 13 to 16, `manaRegenDelay` 0.3 to 0. `maxHealth` 220 to 330 to hold round length; fixed-amount damage (fire ring, lava, pools, vents, boss powers) up by the same 1.5x. |
| B2 | Partly. Roll cooldown 0.55 to 1.2 s and a 0.3 s roll buffer shipped. The 15% target is not met (see below). |
| B3 | Done, with numbers scaled to the new health: blast speed 28, stun cost 14, Ultimate 65 damage, charge per damage taken 0.4. |
| B4 | Skipped (owner). |
| C1 | Done. One checkpoint in each of stages 2 and 3. |
| C2 | Done. Stage bars re-sized for about five minutes a stage against the soak's reference AI; Sahil is now the shortest fight. |
| C3 | Not applied as written (stages were not shortened). Boss stage damage was re-scaled (x1.2 / x1.4 / x1.5) to keep the reference ladder where it was. |
| D1 | Done. Practice: eight lessons against a training dummy. |
| D2 | Partly. Probes, `sim.*` scenarios and pinned figures run on the sim; the older scenarios, `soak` and `campaignSoak` still run the legacy engine. |
| D3 | Skipped: guest-side prediction with reconciliation is a netcode change that needs two-client latency testing to do properly. |
| D4 | Skipped: needs recorded audio assets; none were generated. |

Measured on the sim with scripted players rebuilt for this pass (`src/qa/simProbe.ts`, `npm run
probe:sim`; the same numbers in the dev build as `__duel.qa.sim.balanceReport()`), and with the
legacy `soak` / `campaignSoak` in the dev build:

| Measure | Before | After |
| --- | --- | --- |
| Hold fire: samples with a Blast's mana (24) | 9% | 34% |
| Hold fire: samples at 10 mana or less | 86% | 55% |
| Attacker with pauses: rounds with all four spells cast | 15 of 15 | 14 of 14 |
| Survival doing nothing else: idle / strafing / rolling on cooldown (60 rounds each) | 31.7 / 59.3 / 76.1 s | 25.3 / 48.0 / 63.5 s |
| Rolling on cooldown against strafing | +28% | +32% |
| AI against AI round length, sim: easy / normal / hard | 60.5 / 60.7 / 67.3 s | 62.0 / 53.4 / 50.6 s |
| The same on the legacy engine (30 rounds each after) | 59.2 / 55.8 / 66.9 s | 66.2 / 60.7 / 51.0 s |
| Bolt share of spell damage, hard profile: sim / legacy | 83% / 88% | 69% / 72% |
| Scripted attacker on Sahil: damage a second dealt / damage taken in four minutes | 4.55 / 40 | 10.25 / 69 |
| Sahil stage 1 for that attacker (bar / damage a second) | 1620 / 4.55 = 5.9 min | 2940 / 10.25 = 4.8 min |
| Reference AI, minutes per stage, Sahil | 4.8 / 5.1 / 4.9 | 4.5 / 4.5 / 4.5 |
| Reference ladder win rates (Sahil to Tinubu) | 100 / 67 / 33 / 25 / 0% | 100 / 50 / 42 / 8 / 0% (12 fights each, about +-15 points) |

What did not reach its target, and why:

- **B2.** Rolling on cooldown survives 63.5 s instead of 76.1 s, but strafing fell by as much (the
  rival hits harder now), so the gap did not close: it is still about 30% (the figure moves a few
  points with the sample). Most of a roll's value is the sidestep, not the invulnerability, so
  cutting the invulnerable share from 31% to 18% of the time moved it little. A cooldown of about
  2.4 s reaches 15%, but the Archmage relies on its roll and its rounds against itself fall to
  about 42 s, outside the 51-70 s band. A mana cost was
  tried and dropped: at the new regen it only binds while the player is also firing, where it shows
  up as "no mana" on a dodge.
- **Round length, hard profile.** 50.6 s on the sim and 51.0 s on the legacy engine sit at the
  bottom of the band; easy sits near the top with a few rounds going to time (as before). The
  spread comes from the mana change itself: profiles that fire continuously gain the most.

Hub: the sim changed twice (A4, then the balance batch). `DUEL_SIM_VERSION` is `4f7f69b4961a6169`;
old logs do not verify against it. Boss-fight logs and goja replay times are longer than before
(the scripted bot's losses reach 19 KB and 67 s on goja), and a fight that uses its checkpoints
runs longer still: see `docs/SERVER-SIM.md`.

## 12. Follow-up after QA (2026-11-11)

The owner kept the health and mana change and lifted the staff freeze for the two staves that lost
standing. Sections 11's tables predate this; where they differ, this section is current.

- **Staves.** Fighter Staff: bolt damage x2.5 (10 a bolt, still free). Shooter Staff: bolt damage
  x4 to x6 (24 a bolt, still 10 mana). Stock, Moonward and Alien Ray are untouched. Held fire with
  a person's aim on Sahil (`bossProbe('sahil', 'holdFire', { aim: 'human', staff })`):

  | Staff | Damage a second | Stage 1 (1870) | Against stock (before the pass) |
  | --- | --- | --- | --- |
  | Stock | 3.87 | 8.1 min | 1 (1) |
  | Moonward | 6.02 | 5.2 min | 1.6 (1.5) |
  | Shooter | 12.35 | 2.5 min | 3.2 (3.1) |
  | Alien Ray | 12.87 | 2.4 min | 3.3 (3.2) |
  | Fighter | 17.96 | 1.7 min | 4.6 (4.2) |

  Fighter's held-fire damage in a Quick Duel round: 262 of 330 against the old Adept profile (it
  was 168 of 220), 309 against the softened Adept, where every staff deals more (stock 173).
- **Stage health** x0.636 for every boss (Sahil 1870 / 1910 / 1970): about five minutes a stage
  for the human-aim script with Moonward. Five minutes with the stock staff would have meant 1160,
  which the Fighter Staff clears in about a minute.
- **Adept** is a middle step: the scripted attacker wins about a third of its rounds (39% with
  perfect aim, 29-34% with a person's), against about three in four against the Apprentice and none
  against the Archmage. The profile is also the campaign soak's reference player and the default
  when a Quick Duel log names no rival; online play has no AI. Adept-against-Adept rounds average
  about 61 s.
- **Mana figure.** Holding fire against the softened Adept shows a Blast's mana in 21% of samples,
  not 34%: the bar empties as before (about 12 s), but a player who only stands and fires now
  lives 67 s instead of 43 s. Against the Archmage it is 45%. The pinned check uses the Archmage.
- **Roll.** The roll buffer is back to 0.15 s (no late rolls), the ROLL bar is larger, dim while
  it refills and bright when ready, and a press that is refused flashes it red with NOT READY.
- **Practice.** "Let it refill" completes when the bar is full, so skipping "Mana" cannot strand it.
- **Logs.** The unused 16 KB constant is gone; real sizes are in `docs/SERVER-SIM.md` (boss fights
  12.6 to 21.9 KB for the scripted bot).
- **Ladder.** With the softened Adept as the reference player and the smaller bars the soak reads
  100 / 92 / 83 / 58 / 0%: the middle is easier than before. Boss damage was not re-tuned for it.

## 13. Independent check and retune (2026-11-12)

Section 12 merged without review. It was re-measured with separate scripts (the probes of
`src/qa/simProbe.ts` driven from outside, the pre-pass commit `2d4b984` checked out beside it, and
the legacy `campaignSoak` in headless Chromium, 24 to 36 seeded fights a boss), and the misses were
fixed. `DUEL_SIM_VERSION` is `8f68aa09e9873540`; where this section differs from 11 or 12, this one
is current.

- **Staves.** Held fire with a person's aim on Sahil (12 fights of 5 minutes each, immortal), as
  damage a second against the stock staff:

  | Staff | Before the pass (`2d4b984`) | Section 12 | Now | Damage a second now | Stage 1 (1870) |
  | --- | --- | --- | --- | --- | --- |
  | Stock | 1 (1.74 a second) | 1 | 1 | 3.90 | 8.0 min |
  | Moonward | 1.55 | 1.52 | 1.52 | 5.93 | 5.3 min |
  | Shooter | 2.80 | 3.27 | 2.78 | 10.84 | 2.9 min |
  | Alien Ray | 3.19 | 3.25 | 3.25 | 12.69 | 2.5 min |
  | Fighter | 3.77 | 4.55 | 3.71 | 14.45 | 2.2 min |

  Section 12's "before" ratios (3.1 and 4.2) could not be reproduced: at `2d4b984` the Shooter
  Staff measured 2.8 and the Fighter Staff 3.8. At x6 the Shooter had also overtaken the Alien
  Ray, which changes the old order. So Shooter is x5.25 (21 a bolt, 10 mana) and Fighter x2.1
  (8.4 a bolt, free). Stock, Moonward and Alien Ray are untouched. Held fire in a Quick Duel round
  against the Archmage (the one profile that kept its aim) deals 50 / 77 / 103 / 148 / 130 of 330
  health for the five staves, against 28 / 38 / 52 / 72 / 99 of 220 before the pass. The order and
  the band are pinned in `src/qa/simProbe.test.ts`.
- **Quick Duel.** The scripted attacker (strafes, holds fire, casts what it can afford; 400 rounds
  a rival, perfect and human aim) won 70% / 58% of rounds against the Apprentice, 27% / 25% against
  the Adept and none against the Archmage, so the Adept was still too sharp for a middle step.
  Adept: reaction 0.32 to 0.34 s, aim error 0.15 to 0.16, dodge chance 0.4 to 0.3, shield
  preference 0.35 to 0.28. Apprentice: aim error 0.16 to 0.17. Now 68% / 62%, 37% / 41%, 0% / 0%
  (65%, 39% and 0% over both aims). With pauses to let mana return the same script wins 78%, 50%
  and 0%.
- **Roll.** The gentler rivals take most of the 80 s round to knock out anything that moves, so
  the gap only shows against the Archmage: strafing lived 24.7 s and rolling on cooldown 32.0 s,
  30% longer (180 rounds each). The roll's own numbers move it little (cooldown 2.0 s: 21%, with
  Archmage rounds down to 46 s), because half of what the roll saves is shots aimed where the
  roller no longer is. The rivals now treat rolling on cooldown as the whiff it is: a roll with
  none of the AI's spells in the air and no cast winding up, within 4 s of the last such roll
  (`CONFIG.ai.rollPunishWindow`), opens the profile's ordinary punish window. One roll to
  reposition, and any roll that dodges something, is never punished. Now 24.3 s against 27.7 s
  (14%, 240 rounds each); against the Adept 68.6 s against 66.8 s. Archmage rounds against itself
  fell from 50.3 to 48.8 s with that, so its dodge chance went from 0.78 to 0.84: 50.8 s (311
  rounds; Apprentice 65.4 s, Adept 59.0 s). The same rule is in the legacy `AIController`.
- **ROLL cue**, checked in Chromium: the bar is bright with ROLL when ready, dim while it
  refills, and a press too early to be buffered turns it red with NOT READY for 0.4 s; a press
  within 0.15 s of ready rolls with no flash. Two gaps were closed: a press during a roll, and a
  press that the buffer could not turn into a roll (in the air, stunned), did nothing and showed
  nothing. Both flash now, and the label no longer lags the colour by a frame.
- **Ladder.** The reference soak on the tree as merged (and with the softer Adept) read
  100 / 75-88 / 92 / 67 / 0%. Stage health stays: with Moonward and a person's aim a stage takes 5.3
  minutes standing still on Sahil and 3.4 to 5.3 minutes across the ladder for a player who also
  strafes and casts. The stock staff's longest stage is 8.1 minutes standing still on Sahil and 7.5
  minutes for the strafing script anywhere on the ladder, under the nine-minute cap; standing still
  and only holding fire against Tinubu it is 10 to 11 minutes (the cap's closing ring then ends it),
  which no living player does.
  Boss damage was raised instead (`damageMultiplier`): Bitcoin Obama 0.64 to 0.73 and The Midget
  0.46 to 0.53, Broccoli Head 0.76 to 0.93, Glowie 0.86 to 1.0. Sahil and Tinubu are unchanged.
  The ladder reads 100% (48/48), 69% (25/36), 39% (14/36), 21% (5/24), 0% (0/48); Broccoli Head
  moved between 29% and 58% across 24-fight runs near this value, so read it as about 45%.
- **Practice**, played in Chromium with key and mouse events: all eight lessons complete when
  started fresh, with the bar drained and every cooldown running, with fire held through the
  skips, and from beside the fire ring; Restart, Quit, Practice Again and a Quick Duel straight
  after all leave nothing behind. One wrinkle fixed: a lesson whose goal was already met when it
  came up ("Let it refill" on a full bar, "Mana" on a bar already run down) completed on its first
  tick, unseen, and counted as done, so skipping everything ended on "1 of 8 lessons done". It now
  stays on screen for 3 s and moves on uncounted.
- **Feedback window** (N twice, and the pause menu's button) in a Quick Duel, Practice and a boss
  fight: the sim does not advance while it is open (tick, clock, health and the lesson's own timer
  unchanged over 240 frames; Enter does not skip a lesson; a roll press does nothing), Escape closes
  it and the game resumes where it was, or stays paused if it was. Opened over a boss win, the
  results wait and the win is reported once.
- **Rewards**, with a hub double counting calls: a boss win posts `sproto.boss_defeated` once,
  with its replay, with no checkpoint used and with both used; a loss posts nothing; Practice makes
  no report; a Quick Duel win posts no event (a ranked portal session still posts its one
  `sproto_wins` score, as before).
- **Logs.** The scripted bot's losses are now 5.9 to 26.4 KB (the first boss, 21 minutes): the hub
  should allow 64 KB (`docs/SERVER-SIM.md`).

Not tested: frame times (the container renders about one frame a second, on a machine shared with
other jobs, so the browser checks ran on the game's own frame path at a fixed 60 Hz without
drawing), audio, a real controller, Local Versus, online play, and people.
