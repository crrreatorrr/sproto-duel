# Arcane Duel

Fast arena wizard duels in the browser. Best of three rounds against an AI wizard, 60–90 seconds a
round. Three.js + TypeScript + Vite, Rapier for physics, Howler for audio. Everything is code.

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
rises from 100 to **150** and refills at once, mana regenerates twice as fast, and spending it no
longer pauses regeneration. Another ticket during the boost resets it to 15 seconds (it doesn't
stack). When the boost ends, mana drops back to at most 100. A ticket left alone blinks and fades
after 20 seconds, and the closing fire burns any it reaches. Rivals go for tickets too, when one
is near, closer to them than to you (or their mana is low), and nothing is flying at them; a gold
aura shows who is boosted.

While boosted, your mana bar turns gold and stretches to the bigger pool (a notch marks the old
100), with a chip counting down the seconds left. Tuning: `CONFIG.tickets` in
[src/config.ts](src/config.ts); code: [src/arena/GoldenTickets.ts](src/arena/GoldenTickets.ts). The
ticket face is `textures/golden_ticket.png` (a canvas-drawn face is used without it).

## Boss Gauntlet

Five bosses in a row, each a best-of-three duel in their own arena: Bramble (grove), Cinder
(volcano), Ysolde (glacier), Khepri (desert) and Morvane (void). Fight 1 is very easy and every
fight after it is harder; this ladder is the game's only difficulty setting (Quick Duel is one
fixed rival). A card introduces each boss; beat them to unlock the next, lose and you retry the
same boss. Progress is saved in the browser, so **Continue** on the main menu resumes at the next
boss. Beating Morvane clears the gauntlet.

- Bosses, their AI profiles, health/damage multipliers, palettes, themes and intro lines:
  [src/campaign/levels.ts](src/campaign/levels.ts). Flow: `src/App.ts`; progress: `src/campaign/Campaign.ts`.
- Boss models load from `models/bosses/<id>.glb` and portraits from `ui/bosses/<id>.png` when
  present; otherwise the rival is a primitive wizard in the boss's colours and headgear, and the
  portrait is a stylized silhouette.
- `await __duel.qa.campaignSoak(6)` plays a reference AI against each boss and reports round
  lengths and win rates; `__duel.qa.run('campaign.ladder_escalates')` checks the ladder.

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

The arena is 30 m to the wall, with 14 pillars in two rings. Each campaign boss fights in its own
environment; Quick Duel and the menu use `moonlit`:

| Theme | Mood | Boss |
|---|---|---|
| `moonlit` | Moonlit ruins, violet night (the default) | |
| `grove` | Twilight forest glade, green spirit fire, fireflies | Bramble |
| `volcano` | Basalt over lava under a red ash sky, embers and ash | Cinder |
| `glacier` | Ice crystals under an aurora, blue-white fire, snow | Ysolde |
| `desert` | Sandstone ruins at golden dusk, drifting sand | Khepri |
| `void` | Floating arena in a nebula, purple fire, motes | Morvane |

`game.arena.applyTheme(id)` switches everything: sky, fog, lights, floor, wall, pillars, props,
debris, braziers, fire-ring colours and ambient particles. It is synchronous (the theme is fully
visible when it returns, with procedural stand-ins for any missing file) and returns a promise
that resolves once the theme's optional files have loaded and been swapped in. Await it only if you
want to avoid pop-in. Theme looks live in [src/arena/themes.ts](src/arena/themes.ts), and asset
paths in `THEME_ASSETS` in [src/assets/manifest.ts](src/assets/manifest.ts). Files load on first
use and are cached; GPU memory for inactive themes is released.

For testing, add `?theme=volcano` to the URL (it replaces `moonlit` in the menu and Quick Duel), or
run `__duel.game.arena.applyTheme('glacier')` in the console.

## Project layout

```
src/
  config.ts             all tuning numbers
  App.ts                menus, match, pause, pointer lock, settings
  main.ts               boot + debug handle (window.__duel)
  assets/               manifest.ts (asset keys -> files) and the loader with fallbacks
  core/                 Game loop (fixed 60 Hz sim + interpolation), Match flow, Input, events, feel (hit-stop/shake/flash)
  physics/              Rapier wrapper: character controller, sphere casts, raycasts
  wizard/               shared Wizard entity + its visual (placeholder or GLB, procedural animation)
  player/               keyboard + mouse controller (input buffering, aim assist)
  enemy/                AI state machine (approach / attack / evade / retreat)
  spells/               casting rules, projectiles (pooled), shields, clashes, stun beam, ultimate
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
- Pixel ratio capped at 1.5, bloom at half resolution, one shadow-casting light. Bloom and shadows
  can be turned off in Settings.
- Rapier ships its WebAssembly inlined (about 1.7 MB gzipped) in its own cached chunk.
