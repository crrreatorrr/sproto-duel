# Arcane Duel

Arena wizard duels in the browser. Quick Duel: best of three rounds against an AI wizard, 60–90
seconds a round. Boss Gauntlet: five long single-life boss fights, each boss with three stages and
a cinematic transformation between them, and every boss you beat teaches you its spell for good.
Three.js + TypeScript + Vite, Rapier for physics, Howler for audio. Everything is code.

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
| Z X V G T | **Boss spells** once learned: Magic Carpet, Pump It, Vape Cloud, Lock-On, Hellfire Breath (see [Boss spells](#boss-spells)) |
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
| D-pad ← ↑ → ↓ | D-pad ← ↑ → ↓ | Boss spells: Magic Carpet, Pump It, Vape Cloud, Lock-On |
| X | □ | Boss spell: Hellfire Breath |
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
round timer and won rounds in the middle, and your spells with their cooldowns at the bottom (a
second row above them holds the boss spells you have learned). A golden mana bar with a countdown
chip means that wizard has a golden-ticket boost. The plates, the clock and the spell rows sit on a
translucent, blurred dark backing so they read over any sky; the HUD steps aside behind menus.

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
**New Gauntlet** only replaces a saved run once you press **Begin** on fight 1's card (the button
says so); backing out to the main menu keeps Continue.

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
rest of a cinematic faster. Pausing pauses it. Before the shot the camera picks the side of its
orbit with the most clearance (sphere casts at every beat; a lift over the cover only if every
side is blocked), so stalls, cubicles, cars and rocks never push it into the boss. The light show
is in the boss's colours rather than white, and bright arenas (desert, volcano) turn their bloom,
flashes and sparks down for the shot so the new form reads. Headless runs (QA, soaks) transform
instantly on sim time instead. Tuning: `CONFIG.campaign.cinematic`; code: `src/campaign/BossCinematic.ts`.

**Safety caps.** A stage still going after 9 minutes pulls the fire ring in to close quarters
(it opens again when the stage ends); after 35 minutes of fighting the ring closes completely,
so a stalemate always ends. Golden tickets come less often in boss fights
(`CONFIG.tickets.bossSpawnInterval`). Tuning: `CONFIG.campaign.fight`.

**God mode** wins don't save progress or count clears; the results say so. They still move you on
in that session, but the save never skips a fight: a win is saved only if every earlier fight of
the run is (`Campaign.continuesSave`), so a fair win after god-mode wins saves nothing either, and
teaches no spell, until you start over (New Gauntlet) or pick your saved run back up (Continue).
While god mode is on, the boss card's reward line reads "God mode: progress not saved" (or "Not
saved" after god-mode wins). A fight's result is settled the moment it ends: toggling god mode
before the results show changes nothing.

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
  repeats runs; `{ spells: 'none' }` (or `'all'`, or a list) changes the boss spells the reference
  AI brings (default: the ones it would have learned on the way, see [Boss spells](#boss-spells)). `__duel.qa.runAll('campaign.')`, `'stages.'`, `'cinematic.'`, `'lifepacks.'` and
  `'duo.'` check the rules. `__duel.config` and `__duel.bosses` are the live tuning tables.

## Boss spells

Every Boss Gauntlet boss you beat teaches you its themed spell **for good**: it's yours in every
later gauntlet fight and in Quick Duel. Beating a boss again teaches nothing new, New Gauntlet keeps
them, and Settings → **Forget learned spells** (press twice) wipes them (progress stays). Bosses
never cast these.

| Beat | Spell | Key | Pad | Effect |
|---|---|---|---|---|
| Sahil | **Magic Carpet** | Z | D-pad ← | 2.5 s on a flying carpet: 2.2× speed, hovering 0.45 m up (no lava or fire-ring burn; it glides up over low cover like rug piles, car hoods and carts). No casting while you ride; press again to hop off. 12 s cooldown, 20 mana |
| Bitcoin Obama & The Midget | **Pump It** | X | D-pad ↑ | 6 s surge: +50% spell damage and 1.5× Ultimate charge. Phones orbit you and a green chart arrow climbs over your head. 20 s cooldown, 25 mana |
| Broccoli Head | **Vape Cloud** | V | D-pad → | A 5 m smoke screen at your feet for 6 s. Enemies inside it or looking through it lose track of you and fire at your last known spot (the arena vape-cloud perception, `Arena.obscured`). You heal 2 HP/s inside. Attacking from inside gives you away: the AI sees you for 0.5 s after each attack (`CONFIG.ai.castRevealTime`), and the healing pauses for 1 s. 22 s cooldown |
| Glowie | **Lock-On** | G | D-pad ↓ | 6 s of homing bolts: each bolt turns gently (2.4 rad/s) toward the nearest enemy in a 70° cone in front of you; a green reticle marks it. Rolls still slip them; shields, reflects and clashes work as usual. 20 s cooldown |
| Tinubu | **Hellfire Breath** | T | X / □ | Channel a 6 m, 35° cone of fire from your staff for 2 s: 16 damage/s in the cone and a 4 s burn (5/s) after; you move at 35% speed. Shields block it, a roll dodges it, and cover stops it, office glass included (the flames crack a pane; three licks shatter it, like three bolts). 18 s cooldown, 30 mana |

- **Unlocking:** a win saves the spell with the progress (`unlockedSpells` in the campaign save;
  a double fight teaches its spell once both bosses are down). Saves from before the spells are
  migrated: every boss before your saved fight counts as beaten, a cleared gauntlet as all five.
  God mode wins teach nothing, but **god mode itself grants all five** for the session (never saved).
- **Learning it:** after the victory results, **Continue** opens a "New spell learned" screen
  with the icon, name, what it does and its key and pad button, then goes on to the next boss's card
  (or the completion screen). The boss card says "Defeat to learn: …"; How to Play lists all five
  with their keys and whether you have them.
- **HUD:** a second row above your spells, one slot per learned spell: icon, key or pad glyph,
  cooldown sweep and seconds, dimmed when you lack the mana, and a ring that runs down while the
  effect lasts. Every cast plays its own sound (whoosh, coin pump, puff, lock beep, fire roar) and
  effect, with the spell's name popping over you.
- **AI and balance:** bosses never get them. The campaign soak's reference AI uses the spells it
  would have learned on the way (fight N gets spells 1..N-1) with simple rules (`CONFIG.ai.rewards`):
  the carpet to escape when low and under fire or under a volley, the vape cloud when low (then it
  stays inside to heal), Pump It before a bolt burst, Lock-On while the target strafes across its
  line of fire, the breath at close range. The later bosses were buffed to match (below).
- Code: [src/spells/RewardSpells.ts](src/spells/RewardSpells.ts) (rules),
  [src/spells/rewardCatalog.ts](src/spells/rewardCatalog.ts) (names, descriptions, icons),
  [src/fx/RewardFx.ts](src/fx/RewardFx.ts) (carpet, phones and chart, flames); the carpet's flight
  is in `Wizard.updateMovement`, the smoke in `Arena.addSmoke`. Tuning: `CONFIG.rewardSpells`; keys:
  `CONFIG.controls` / `CONFIG.gamepad.bindings`. Icons: `ui/spells/spell_<id>.png`.

**Reference ladder** (`await __duel.qa.campaignSoak(16, { seed: 2026, spells: 'ladder' })`, the
reference AI bringing the boss spells it would have learned by then; single-life fights):

| Fight | Spells the AI brings | Win rate | Fight length | Stage reached | Minutes per stage | Boss damage/s per stage |
|---|---|---|---|---|---|---|
| Sahil | none | 100% (16/16) | 15.5 min | 3 | 5.0 / 5.3 / 5.2 | 0.10 / 0.28 / 0.39 |
| Bitcoin Obama & The Midget | carpet | 69% (11/16) | 14.2 min | 3 / 3 | 5.8 / 6.8 / 3.0 | 0.20 / 0.52 / 0.52 |
| Broccoli Head | carpet, pump | 44% (7/16) | 13.2 min | 3 | 4.2 / 4.5 / 4.9 | 0.27 / 0.50 / 0.82 |
| Glowie | carpet, pump, vape | 19% (3/16) | 14.5 min | 3 | 4.8 / 5.4 / 5.9 | 0.35 / 0.53 / 0.84 |
| Tinubu | carpet, pump, vape, lock-on | 4% (1/24) | 10.1 min | 2.5 | 4.6 / 4.7 / 3.4 | 0.46 / 0.92 / 1.34 |

The soak isn't bit-for-bit repeatable across page sessions (the physics state carries between
fights), so a 16-fight rate moves by roughly ±10 points between runs. Final tuning (after the vape
cloud was toned down: 2 HP/s, none right after attacking, and attacking from it gives you away):
the duo ×0.93, Broccoli Head ×1.0, Glowie ×1.0 and Tinubu ×1.0 damage, with Tinubu's last bar at
800. Every boss hits harder than before the "bosses do more damage" pass (stage damage ×1 / ×1.25 /
×1.5, up from ×1 / ×1.1 / ×1.25). Tinubu is almost impossible: the reference AI usually dies in his
second or third form, and in the rare win his final form falls in about 3.5 minutes.

## God mode (testing)

No damage taken (hits still flash and show **IMMUNE**), unlimited mana (spells never fail, sprint
never runs dry), no spell cooldowns (Blast, Shield and Stun are ready again at once and the
Ultimate is always charged; bolts keep their normal fire rate), all five boss spells (with no
cooldowns either), 5× damage and 5× clash power. Toggle it any time by typing **9 9** quickly, with
**F9**, or in Settings; start with it on via `?god` in the URL. A **GOD MODE** badge shows on the
HUD. It is never saved: a reload turns it off. Standing in lava or the fire ring doesn't flash you
white (zero-damage hazard ticks skip the hit flash). The menus' background duel ignores it (stock
stats until a match starts). Tuning: `CONFIG.debug`.

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
                        boss projectile skins (instanced rugs, phones, pigs, bullets...: ProjectileSkins.ts),
                        boss reward spells (RewardSpells.ts, rewardCatalog.ts)
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

A QA harness runs inside the game (228 scenarios, about 1.5 to 2.5 minutes in a real-sized window). Open the browser console:

```js
await __duel.qa.runAll()            // deterministic scenarios over the real simulation
await __duel.qa.runAll('muzzles.')  // spells leave each caster's staff, phones, vape, gun, hand, mouth
await __duel.qa.runAll('anim.')     // rigged files preferred, clip state machine, root pinned, sockets, no leaks
await __duel.qa.runAll('rewards.')  // boss spells: unlocks, save + migration, each effect, cooldowns, keys, HUD, reveal
await __duel.qa.runAll('ui.')       // menus fit a 900x560 window (the menus are a size container), banners
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
- No first-use hitches: when a fight is dressed (behind its boss card) `Game.warmUp` draws the
  whole scene once offscreen, hidden pools included (tickets, life pack, projectile skins, muzzle
  and reward-spell effects, the cinematic's shells and rings) plus a hidden copy of every stage
  model of the boss, so every shader is compiled and every texture uploaded before the fight
  (`perf.no_first_use_hitch`).
- The hit flash is a capped glow in the wizard's own colour that settles under rapid hits
  (`CONFIG.wizard.hitGlow`), so bloom never turns a model into a white blob.
- Rapier ships its WebAssembly inlined (about 1.7 MB gzipped) in its own cached chunk.
