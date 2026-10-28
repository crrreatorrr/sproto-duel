# Arcane Duel

Arena wizard duels in the browser. Quick Duel: best of three rounds against an AI wizard, 60–90
seconds a round. Boss Gauntlet: five long single-life boss fights, each boss with three stages and
a cinematic transformation between them. Three.js + TypeScript + Vite, Rapier for physics, Howler
for audio. Everything is code.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173 and pick **Boss Gauntlet** or **Quick Duel** (the game captures the mouse).

```bash
npm run build      # typecheck + production build into dist/
npm run gen:audio  # regenerate the synthesized placeholder sounds
```

## Controls

| Input | Action |
|---|---|
| W A S D | Move |
| Shift | Sprint (drains mana; runs dry, then needs to recover) |
| Space | Dodge roll, with brief invulnerability |
| F / C | Jump: hop the Ultimate's shockwave (feet clear at the wavefront) or onto crumbled pillar stumps. Cast freely in the air; no rolling until you land |
| Left click / 1 | **Bolt**: fast, cheap, no cooldown, hold to fire |
| Right click / 2 | **Blast**: slow big orb, area damage, 3 s cooldown |
| Q / 3 | **Shield**: blocks for 0.8 s. Raise it in the last 0.2 s before a hit to reflect the spell back, faster and stronger |
| E / 4 | **Stun**: beam that freezes the target for 1 s, 8 s cooldown |
| R / 5 | **Ultimate**: charged by dealing damage. An arena-wide shockwave. Roll through it, hide behind a pillar, or shield to reduce it |
| Esc / P | Pause |

### Controller

Any pad the browser reports in the "standard" mapping works (Xbox, PlayStation, Switch Pro), wired or
Bluetooth; press a button once so the browser exposes it. Keyboard and mouse keep working alongside it,
and the HUD and menu prompts switch to whichever device you used last (PlayStation glyphs for
DualShock/DualSense). With a controller the game never needs to capture the mouse.

| Xbox | PlayStation | Action |
|---|---|---|
| Left stick | Left stick | Move (analog) |
| Right stick | Right stick | Camera (with turn acceleration at the edge of the stick) |
| LS click (hold) | L3 (hold) | Sprint |
| RT (hold) | R2 (hold) | **Bolt** |
| LT | L2 | **Blast** |
| LB | L1 | **Shield** |
| RB | R1 | **Stun** |
| Y | △ | **Ultimate** |
| A | ✕ | Jump |
| B | ○ | Dodge roll |
| Menu | Options | Pause / resume |
| D-pad or left stick, A, B | D-pad or left stick, ✕, ○ | Menus: move focus, select, back; left/right adjusts sliders |

Settings has controller look sensitivity, a separate invert Y, aim assist strength and vibration.
Aim assist with a pad uses a wider cone than the mouse plus a gentle pull toward the opponent while
you move or aim near them. Deadzones, response curves, bindings, aim assist and rumble strengths are
in `CONFIG.gamepad` ([src/config.ts](src/config.ts)). Unplugging the pad mid-duel pauses the game.

Spells that collide in mid-air clash; the bigger spell survives, weakened by what it beat. The
ring of fire at the edge burns, and in the last 30 seconds it closes in. Pillars crumble after
enough hits.

The HUD shows each wizard's health, mana and Ultimate charge at the top (yours on the left), the
round timer and won rounds in the middle, and your spells with their cooldowns at the bottom. A
golden mana bar with a countdown chip means that wizard has a golden-ticket boost.

## Golden tickets

During every round's fight (Quick Duel and the Boss Gauntlet), a floating golden ticket appears
every 6–12 seconds at a random open spot inside the fire ring, at most 3 at a time; look for the
gold light beams. Touch one (walking or mid-jump) to collect it: for **15 seconds** your max mana
rises from 100 to **150** and refills at once, so you can chain far more spells. Another ticket during the boost resets it to 15 seconds (it doesn't
stack). When the boost ends, mana drops back to at most 100. A ticket left alone blinks and fades
after 20 seconds, and the closing fire burns any it reaches. Rivals go for tickets too, when one
is near, closer to them than to you (or their mana is low), and nothing is flying at them; a gold
aura shows who is boosted.

While boosted, your mana bar turns gold and stretches to the bigger pool (a notch marks the old
100), with a chip counting down the seconds left. Tuning: `CONFIG.tickets` in
[src/config.ts](src/config.ts); code: [src/arena/GoldenTickets.ts](src/arena/GoldenTickets.ts). The
ticket face is `textures/golden_ticket.png` (a canvas-drawn face is used without it).

## Boss Gauntlet

Five fights in a row, each in the boss's own arena: Sahil, the RugMaster (The Grand Bazaar);
**Bitcoin Obama & The Midget** (The Blockchain Void, a double fight); Broccoli Head (Los Angeles);
Glowie (Government Office); and Tinubu (Hellfire Caldera). Fight 1 is very easy and every fight
after it is a clear step up; Tinubu is close to impossible. This ladder is the game's only
difficulty setting (Quick Duel is one fixed rival, best of three). A card introduces each fight;
win to unlock the next, lose and you retry the same one. Progress is saved in the browser, so
**Continue** on the main menu resumes at the next fight. Beating Tinubu clears the gauntlet.

**One life.** A boss fight is a single round and you have one life: if you fall, it's a defeat and
**Retry** starts that boss again from stage 1 at full health. There is no round timer; the HUD's
clock counts the fight up and there are no round pips. Your health does not refill between the
boss's stages.

**Three stages, three health bars.** Every boss has three stages and each stage has its own,
bigger health bar (`stageHealth` in levels.ts). Empty it and the boss doesn't fall: it transforms
and comes back with the next stage's full bar (the hit that emptied the bar loses its overflow,
and the boss is immune while it transforms). Only emptying the last stage's bar knocks it out.
Each stage hits harder (`stageDamage`), thinks faster and sharper (`stageAI`), and unlocks more
attacks (Blast, Stun, the Ultimate, a signature volley). Stages are sized to last about five
minutes each against a competent player, so a fight runs 15 minutes or more. The boss plate shows
the current stage's bar, its stage pips and name; the bar sweeps up as the boss transforms.

**Life packs.** Up to three health pickups per fight (a red potion with a light beam): one comes
in each stage, a minute or more in, sooner when you're below 40% health. Only you can collect
them; each heals half your max health. An uncollected pack vanishes after 40 s and still counts.
The hearts under your bars show how many are left. Quick Duel has none. Tuning: `CONFIG.lifePacks`.

**Transformation cinematics.** Every transformation is a short cinematic. The fight freezes (no
one moves, casts, burns or takes damage, and your input is ignored), letterbox bars slide in and
the camera swoops in to orbit the boss. He rises off the ground spinning and shuddering, glows
brighter and brighter and cracks with light while an energy vortex spirals into him, the floor
cracks under him and the sky and fog tint toward his colours. Then the old form bursts into light
(bloom, a roar, the stage's title card with its concept art and the refilling bar), the new form
grows out of the light with an overshoot squash and stretch, and he slams down: an arena-wide
shockwave ring, debris and a big shake. The camera returns to your shoulder, a quick "3 2 1"
plays, and the fight resumes (the boss stays frozen and immune for a moment). Stage 3 is longer
and bigger (higher rise, more spins, a wider orbit, more debris, a false burst first, a bigger
card), and so is a double fight's enrage. Press Space, Enter, click or the pad's A to play the
rest of a cinematic faster. Pausing pauses it. Headless runs (QA, soaks) transform instantly on
sim time instead. Tuning: `CONFIG.campaign.cinematic`; code: `src/campaign/BossCinematic.ts`.

**Safety caps.** A stage still going after 9 minutes pulls the fire ring in to close quarters
(it opens again when the stage ends); after 35 minutes of fighting the ring closes completely,
so a stalemate always ends. Golden tickets come less often in boss fights
(`CONFIG.tickets.bossSpawnInterval`). Tuning: `CONFIG.campaign.fight`.

**God mode** wins don't save progress or count clears; the results say so.

**The double fight.** In fight 2 you face Bitcoin Obama (tall) and The Midget (short, quick and
jumpy) at the same time. Each has his own stage bars, AI and palette (both throw phones and pigs),
and the two keep apart and try to flank you. Spells never hurt, push, stun, block or clash with
their own side, so their shots pass through each other. You win once both are knocked out (a
fallen boss stays down and doesn't block shots). When one of them falls, the other is **enraged**:
he transforms straight into his last stage with a full last-stage bar. Aim assist locks onto
whichever standing boss is nearest your crosshair. The Midget's hitbox is 1.25 m tall, so a bolt
aimed high at Obama can fly over his head. Every boss's hurtbox grows with its stage model.

- Bosses, stages, stage bars, AI profiles, damage multipliers, palettes, themes, intro lines and
  the double fight's `partner`: [src/campaign/levels.ts](src/campaign/levels.ts). Stages:
  `src/campaign/BossStages.ts` (one per boss wizard); cinematics: `src/campaign/BossCinematic.ts`;
  life packs: `src/arena/LifePacks.ts`. The partner is a third wizard (`Game.partner`, side 1)
  that joins `Game.wizards` only during that fight. Flow: `src/App.ts`; rounds and the safety
  caps: `src/core/Match.ts`; progress: `src/campaign/Campaign.ts`. Tuning: `CONFIG.campaign`
  (`fight`, `cinematic`, `stageAI`, `stageDamage`, `hurtbox`, `duo`) and `CONFIG.lifePacks`.
- Stage models load from `models/bosses/<id>/stage1..3.glb` and portraits from
  `ui/bosses/<id>.png` (`<id>_stage2.png`, `<id>_stage3.png` for later stages) when present;
  otherwise the boss is a primitive wizard in its colours and headgear that grows each stage, and
  the portrait is a stylized silhouette. The life pack is `models/pickups/life_pack.glb` (a
  code-built flask without it). See [ASSETS.md](ASSETS.md).
- `await __duel.qa.campaignSoak(20)` plays a reference AI through each fight as the real
  single-life fight (life packs, tickets, the boss's arena; the double fight with both bosses) and
  reports per boss: win rate, fight length, stage reached, minutes per stage, the bosses' damage
  per second per stage, life pack use and wins the packs saved. `{ immortal: true }` measures
  stage lengths and damage without the fight ending; `{ only: [4], seed: 1 }` picks fights and
  repeats runs. `__duel.qa.runAll('campaign.')`, `'stages.'`, `'cinematic.'`, `'lifepacks.'` and
  `'duo.'` check the rules. `__duel.config` and `__duel.bosses` are the live tuning tables.

## God mode (testing)

No damage taken (hits still flash and show **IMMUNE**), unlimited mana (spells never fail, sprint
never runs dry), no spell cooldowns (Blast, Shield and Stun are ready again at once and the
Ultimate is always charged; bolts keep their normal fire rate), 5× damage and 5× clash power. Toggle it any time by typing **9 9** quickly, with
**F9**, or in Settings; start with it on via `?god` in the URL. A **GOD MODE** badge shows on the
HUD. It is never saved: a reload turns it off. Tuning: `CONFIG.debug`.

## Balancing

Every tuning number lives in [src/config.ts](src/config.ts): movement, dodge timing, each spell's
damage/speed/cost/cooldown, hit-stop and shake, camera, AI profiles (Quick Duel uses `normal`), round length, team
colours. The dev server hot-reloads on save.

## Environments

The arena is 30 m to the wall. Quick Duel uses 14 pillars in two rings; every boss arena has its
own obstacles (see below). Each campaign boss fights in its own environment; Quick Duel and
the menu use `moonlit`:

| Theme | Mood | Boss |
|---|---|---|
| `moonlit` | Moonlit ruins, violet night (the default) | Quick Duel |
| `grove` | Twilight forest glade, green spirit fire, fireflies | (none; `?theme=grove`) |
| `volcano` | Basalt outcrops and lava pools under a red ash sky, embers and ash | Tinubu |
| `glacier` | Ice crystals under an aurora, blue-white fire, snow | (none; `?theme=glacier`) |
| `desert` | A sandstone bazaar at golden dusk: market stalls, rugs, drifting sand | Sahil |
| `void` | Floating arena in a nebula: candlestick charts, chained and sliding blocks, purple fire | Bitcoin Obama |
| `city` | Los Angeles at sunset: an intersection with crosswalks, graffiti freeway columns, palms, storefront neon, smog, a skyline on the horizon, hot-pink fire, drifting pastel vape clouds | Broccoli Head |
| `office` | Government Office: indoors under fluorescent ceiling panels, grey-blue carpet with an eye-in-a-triangle emblem, beige walls with blinds, a sea of cubicles, green screen glow, the office on fire, dust in the light | Glowie |

`game.arena.applyTheme(id)` switches everything: sky, fog, lights, floor, wall, cover layout,
pillars, props, debris, braziers, fire-ring colours and ambient particles. It is synchronous (the
theme is fully visible when it returns, with procedural stand-ins for any missing file) and returns
a promise that resolves once the theme's optional files have loaded and been swapped in. Await it
only if you want to avoid pop-in. Theme looks live in [src/arena/themes.ts](src/arena/themes.ts),
and asset paths in `THEME_ASSETS` in [src/assets/manifest.ts](src/assets/manifest.ts). Files load
on first use and are cached; GPU memory for inactive themes is released.

**Cover layouts.** A theme's `layout` picks its cover. Quick Duel's `moonlit` (and the spare
`grove` and `glacier`) keep the two `rings` of pillars (`CONFIG.arena.pillars`); every boss arena has
its own obstacle kit. Obstacle types (`CONFIG.arena.obstacles`) define their collider (boxes and
cylinders, compound for cars, bus stops, palm planters and rocks, roofs you can walk under), height
class (anything under ~1.3 m can be jumped onto: the apex is 1.4 m), health (0 = indestructible),
the stump they leave, whether the AI may hide behind them, and whether they are see-through. Layouts
(`CONFIG.arena.layouts`, and `CONFIG.arena.cubicles` for the office) place them, mirrored so both
spawns get the same cover, with the spawn line clear and everything well inside the fire.

| Layout | Arena | Cover | Special |
|---|---|---|---|
| `bazaar` | The Grand Bazaar (Sahil) | 16 market stalls (2.6 x 1.8 x 2.4 m, full cover) in rows along a central street, 10 rug piles (1 m, stand on them, never break), carts, clusters of clay pots | |
| `exchange` | The Blockchain Void (Bitcoin Obama) | 16 candlestick-chart bars (red/green, 1-4.5 m: low ones you hop), 8 obsidian blocks joined by glowing chains | **Moving cover:** 4 blocks slide on glowing rails (kinematic colliders; they turn back rather than push into a wizard) |
| `streets` | Los Angeles (Broccoli Head) | 8 parked cars (hood 0.95 m, roof 1.4 m), 2 food trucks, 4 dumpsters, 2 bus-stop shelters, 4 palm planters, 2 freeway columns | **Soft cover:** 3 drifting vape clouds stop no spell but hide wizards from the AI, which fires at your last known position for a few seconds |
| `cubicles` | Government Office (Glowie) | 16 cubicles (2.2 x 2.2 x 1.3 m: bolts and sight blocked, you can stand on top), filing-cabinet banks, copiers, water coolers | **Glass partitions:** 4 see-through panels that stop spells and shatter after 3 bolts |
| `caldera` | Hellfire Caldera (Tinubu) | 8 basalt outcrops (compound colliders, permanent cover), 6 broken columns | **Hazard:** 4 lava pools burn anyone standing in them (`lavaDps`); the AI steers, rolls and picks cover around them |

Destructible cover takes damage from bolts, Blasts and the Ultimate, crumbles (or shatters) into
debris and resets every round. The AI's cover search, line of sight and aiming, the camera's
collision, spells and golden tickets all use the same colliders (tickets also keep out of lava,
clouds and rails). `arena.pillars` lists the current layout's cover.

For testing, add `?theme=volcano` (or any theme id) to the URL (it replaces `moonlit` in the menu
and Quick Duel), or run `__duel.game.arena.applyTheme('office')` in the console.
`await __duel.qa.soak('normal', 6, 'office')` runs AI-vs-AI rounds in a theme.

## Spell visuals

Spells, the bosses' thrown objects and every effect are built in code (no assets). Each spell
leaves its caster from a **muzzle** on the current look (`src/wizard/muzzles.ts`):

- **Where:** `Wizard.castPoint(kind, out)` (bolt, volley, blast, stun, ultimate) puts the look's
  measured point in the world: turned by the facing, scaled by the boss stage's size
  (`visual.root.scale`) and raised with jumps. Points are stored per model in fractions of its
  height (`levels.ts` stages, the player's on its manifest entry); placeholders use their code-built
  prop (a staff, phone, vape pen, pistol, or Tinubu's palm and mouth). An unknown model falls back
  to the old wand offset. Projectiles still aim from the muzzle at the crosshair's point, so what
  the crosshair is on is what gets hit. A muzzle that would be inside or past a wall, pillar, car or
  pane of glass (a caster hugging cover) is pulled back toward the caster first
  (`SpellSystem.muzzleOrigin`).
- **Effects** (`src/fx/MuzzleFx.ts`, plus the glows anchored to the prop in `WizardVisual`), all
  pooled:
  - staff: the orb or gem glows, pulses and swells while a spell charges, and flares with a spark
    ring on release;
  - phone: the screen glows and flashes, and notification bubbles pop off it;
  - vape: a pastel vapour puff (bigger each stage) and a lingering haze wisp; the cannon billows;
  - gun: a hard muzzle star on the barrel every shot (Full Auto strobes) with the gunshot flash and
    a light;
  - hand: a fiery palm glow and a burst of flame;
  - mouth: a jaw glow and a cone of fire breath.
  The spell's charge glow sits at the muzzle it will leave from, and two shared point lights go to
  the brightest charging or flashing muzzles. Cosmetic randomness doesn't touch the gameplay's dice.
- **Big bosses near the camera** are dithered see-through (`Game.updateOcclusionFade`,
  `CONFIG.camera.bossFade`): within 2 m of the camera or standing between the camera and you, and
  gone entirely when the camera is inside one. Wide models lean less and are lifted while leaning
  so their hems never dip into the floor.

## Character animation

Every character moves, rigged or not (`src/wizard/WizardVisual.ts`, `src/wizard/Animator.ts`):

- **Rigged looks** (skinned GLBs in `public/assets/models/rigged/`, preferred over the static mesh
  when the file exists; see ASSETS.md) play their baked clips through a two-layer state machine:
  - **legs**: idle; locomotion blended by direction relative to facing (run, strafe left/right,
    run back), phase-synced and sped up with the speed; jump, roll, hit, stun, victory, defeat;
  - **upper body**: follows the legs, but casts and hit reactions play here over running, so the
    legs keep running while the arms cast.
  Cross-fades take 0.06-0.25 s with normalized weights. Casts are scrubbed so the staff thrust
  peaks exactly on release (blast and the Ultimate use `cast_big` through the follow-through), hits
  hold ~0.35 s, a stun's ice freezes the pose once formed, and hit-stop freezes everything. Root
  motion is pinned at load so the body stays over its collider; the mocap's turned stances are
  turned back (a constant hips yaw per clip, measured at load) and a look-at keeps the eyes on the
  target. Missing clips fall back gracefully (no strafe clips: the hips turn toward the travel
  while the chest keeps facing the target); Tinubu's split wings flap procedurally.
- **Procedural motion** on the hip pivot (all of it for static meshes and placeholders, a lighter
  share on top of clips): breathing and idle sway, a lean into movement, acceleration and turns, a
  footstep bob and waddle paced by the stride, jump squash and stretch, a flinch along the
  knockback, a gather-and-lunge on casts, the roll flip and death topple when there is no clip.
  Boss stages carry themselves heavier each stage (slower idle and stride, bigger landings) and the
  last stage looms with a slow sway and hunch (manifest `motion`).
- **Muzzle sockets**: on a rigged look the staff orb, phone, vape or gun glow, charge glow, muzzle
  light and cast effects ride a bone socket (manifest `rigged.sockets`), so they follow the animated
  prop. Projectiles still spawn from the measured muzzle point (`Wizard.castPoint`).

## Project layout

```
src/
  config.ts             all tuning numbers
  App.ts                menus, match, pause, pointer lock, settings
  main.ts               boot + debug handle (window.__duel)
  assets/               manifest.ts (asset keys -> files), the loader with fallbacks (rigged -> static -> placeholder),
                        rig.ts (skinned models: root motion, body-half clip split)
  core/                 Game loop (fixed 60 Hz sim + interpolation), Match flow, Input, events, feel (hit-stop/shake/flash)
  physics/              Rapier wrapper: character controller, sphere casts, raycasts
  wizard/               shared Wizard entity + its visual (placeholder, static or rigged GLB), clip state machine
                        (Animator.ts), procedural motion, muzzles
  player/               keyboard + mouse controller (input buffering, aim assist)
  enemy/                AI state machine (approach / attack / evade / retreat)
  spells/               casting rules, projectiles (pooled), shields, clashes, stun beam, ultimate,
                        boss projectile skins (instanced rugs, phones, pigs, bullets...: ProjectileSkins.ts)
  fx/                   particle systems, effect recipes, spell shaders, procedural textures
  arena/                floor, sky, wall, destructible pillars, fire ring, debris, environment themes, golden tickets
  camera/               over-the-shoulder rig with collision and trauma shake
  ui/                   HUD, menus, damage numbers, icons
  audio/                Howler audio manager (events -> sounds)
  qa/                   QA harness, scenarios, AI-vs-AI soak
public/assets/          drop generated models, textures and sounds here (see ASSETS.md)
```

Gameplay never calls UI or audio directly: it emits typed events (`src/core/events.ts`), and the HUD,
audio and popups subscribe.

## Assets

The game ships with placeholders: primitive wizards and pillars, procedural textures, and
synthesized sounds. [ASSETS.md](ASSETS.md) lists every asset to generate with Higgsfield, with
prompts and specs. Drop a file at its manifest path and it replaces the placeholder automatically.

## QA

A QA harness runs inside the game. Open the browser console:

```js
await __duel.qa.runAll()            // deterministic scenarios over the real simulation
await __duel.qa.runAll('muzzles.')  // spells leave each caster's staff, phones, vape, gun, hand, mouth
await __duel.qa.runAll('anim.')     // rigged files preferred, clip state machine, root pinned, sockets, no leaks
await __duel.qa.soak('normal', 6)   // headless AI-vs-AI rounds: pacing, damage share, tickets per side
await __duel.qa.perf(8)             // real frame-time stats while you play
```

`?nolock` in the URL runs the game without pointer lock (for automation).

There is also a QA subagent definition at `.claude/agents/qa-tester.md`. Ask Claude Code to "run the
qa-tester agent" after a change: it builds an isolated snapshot, runs the harness, playtests with
synthetic input, measures performance, and reports bugs and feel problems by severity.

## Performance notes

- Fixed 60 Hz simulation with render interpolation; hit-stop pauses the sim, not the camera.
- Projectiles, particles, debris, popups, flashes and beams are pooled; nothing is allocated per
  frame in the hot paths.
- Rigged characters: every clip action is created once per look and driven by weights and explicit
  times (no per-frame allocation); skinned meshes skip frustum culling (three at most on screen).
- Pixel ratio capped at 1.5, bloom at half resolution, one shadow-casting light. Bloom and shadows
  can be turned off in Settings.
- Rapier ships its WebAssembly inlined (about 1.7 MB gzipped) in its own cached chunk.
