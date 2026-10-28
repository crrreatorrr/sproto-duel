# Arcane Duel

Fast arena wizard duels in the browser. Best of three rounds against an AI wizard, 60–90 seconds a
round. Three.js + TypeScript + Vite, Rapier for physics, Howler for audio. Everything is code.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173, pick a difficulty, click **Begin Duel** (the game captures the mouse).

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
| Left click / 1 | **Bolt**: fast, cheap, no cooldown, hold to fire |
| Right click / 2 | **Blast**: slow big orb, area damage, 3 s cooldown |
| Q / 3 | **Shield**: blocks for 0.8 s. Raise it in the last 0.2 s before a hit to reflect the spell back, faster and stronger |
| E / 4 | **Stun**: beam that freezes the target for 1 s, 8 s cooldown |
| R / 5 | **Ultimate**: charged by dealing damage. An arena-wide shockwave. Roll through it, hide behind a pillar, or shield to reduce it |
| Esc / P | Pause |

Spells that collide in mid-air clash; the bigger spell survives, weakened by what it beat. The
ring of fire at the edge burns, and in the last 30 seconds it closes in. Pillars crumble after
enough hits.

## Balancing

Every tuning number lives in [src/config.ts](src/config.ts): movement, dodge timing, each spell's
damage/speed/cost/cooldown, hit-stop and shake, camera, AI difficulty profiles, round length, team
colours. The dev server hot-reloads on save.

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
  arena/                floor, sky, wall, destructible pillars, fire ring, debris
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
await __duel.qa.soak('normal', 6)   // headless AI-vs-AI rounds: pacing and damage share
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
