# Test Lab plan: Sproto Duel

Status: plan only; nothing is built yet. This plan was written on 7 November 2026 from a read-only pass over `main` at `126eeb2`.
Implementer: Cursor, working on branch `cursor/test-lab`.

## What the lab is for

The lab is a separate page, `lab.html`. It covers:
- The player wizard and all five bosses, `sahil`, `obama` (with partner `midget`), `broccoli`, `agent` and `tinubu`, across their three stages each.
- Every animation clip and both animator layers.
- Staff sockets and muzzle points.
- Every spell, reward spell, boss power and projectile skin.
- Every arena theme and cover layout.
- The authoritative sim-core shapes drawn over the model bounds.
- A live sandbox that drives the real `SimWorld`.

## Owner decisions (7 November 2026, the same for every game repo)

These answers came from the owner's Q&A and apply to every game. Repo-specific sections below may add to them, but never relax them.

1. **A separate page.** The lab is its own HTML entry, `lab.html`, at the root of the built site, with its own JS bundle. The game's `index.html` must not import, link to or preload anything from the lab.
   - Measure the game's load before and after: JS bytes, request count and time to first frame. Put both sets of numbers in the PR. The game's numbers must not change.
2. **A hidden URL in production.** The lab ships in the production build at `lab.html`, relative to the game's base path.
   - Nothing in the game links to it.
   - It has `<meta name="robots" content="noindex,nofollow">`.
   - It must pass every existing production check, including banned-string scans. The repo section lists them.
3. **Desktop browser only:** keyboard and mouse. No touch layout.
4. **Automated QA.** Expose a small automation API on `window.testLab`. Never reuse an existing debug handle name. It needs at least:
   - `list()`, which returns every entity with its id, kind and animations/attacks;
   - `select(id)`;
   - `play(clipOrAttack)`;
   - `step(n)`;
   - `state()`, which returns position, velocity, state, clip, frame and HP;
   - `ready`, a promise that resolves when the current view has finished loading and drawing.

   Add a headless script (Playwright or CDP) that opens `lab.html`, visits every entity and every animation, and fails on console errors, failed requests or a blank canvas. Wire it into the repo's checks where browser checks already exist.
5. **Interaction:**
   - **Playback controls:** play, pause, step ±1 frame or tick, speed from 0.1× to 4×, scrub and loop.
   - **Live sandbox:** drive the character with the game's own controls. Show a live readout of position, velocity, facing, state, current animation and frame.
   - **Overlays:** see item 8.
   - **Spawn and fire:** spawn any enemy or boss; force any boss phase or attack; set HP; freeze AI; give any weapon, item or power-up; fire any attack on demand.
6. **Extras:**
   - **Load-time panel.** For each asset show bytes, fetch ms, decode ms and whether it came from cache; show a total per character. Load each character only when it is selected, never the whole roster up front. Use `PerformanceResourceTiming` plus timing around decode.
   - **Side-by-side compare.** Two entities, or two phases or variants of one entity, on one shared clock.
   - **Share links.** Keep all view state in the URL hash, for example `#tab=anim&id=x&clip=y&frame=12`, so a reload restores the exact view. Add a "Save PNG" button.
7. **No sim edits.** The lab is lab-only code. Do not change gameplay or sim files, or anything that changes a sim fingerprint, server bundle, replay golden or gameplay hash.
   - If the lab needs a private value, such as a collision function the game does not export, mirror it in lab code.
   - Add a unit test that fails when the mirror drifts from the source, for example by comparing outputs on sample inputs.
8. **Overlays show the game's truth plus the art's bounds.** Draw exactly what gameplay uses (hit, hurt and collision shapes; anchors; muzzle and spawn points) in one colour, and the sprite or model bounds in another, so mismatches are obvious. Also draw a grid with world coordinates.
9. **Accepted art only.** The roster lists only art the game currently uses. Pending or archived art may appear only in a tab labelled "Archive (not in game)", never in the sandbox.
10. **Isolation.** The lab never writes the player's real save, never takes tab or writer locks, never initialises the hub and never sends scores or tickets. Use an in-memory save with everything unlocked.
11. **Free-form per repo.** Fit the layout to the game. There is no shared kit across repos.
12. **Branch and PR.** Work on `cursor/test-lab`. It was created from the latest `main` with this plan committed. Commit after each phase below, and open a PR into `main` when done. Never push to `main`. Run every repo check and report any you could not run. A different agent reviews the PR.

## Sproto Duel-specific rules

- **Banned strings.** `scripts/check-prod-debug.mjs:8` fails the production build if any file in `dist/` (including `.js`, `.css`, `.html` and `.map`) contains `__duel`, `QAHarness`, `registerSpellScenarios` or `campaignSoak`. The lab must never import `src/qa/**` or the scenario files, and it must use only `window.testLab`. metaverse-hub separately bans `__duel` as well.
- **Sim isolation.** Do not edit `src/sim-core/**`, because that changes the server bundle and the 23 golden replays. Build the lab against the exported API in `src/sim-core/index.ts`: `SimWorld`, `SimArena`, `ARENA_IDS` and `SimWizard`.
- **Deploy.** The production `dist/` is deployed whole with rsync (handoff.md §1.3), so the lab ships at `/lab.html` hidden and with `noindex`, as decided.
- **Shared files.** Other agents work in this repo too. Keep edits to `vite.config.ts` and other shared files minimal.

## Facts this plan relies on

### Stack and assets
- Three 0.186, Rapier compat 0.21 (WASM), Howler and Vite 8 (rolldown). There is one entry point today, so add a `rolldownOptions.input` map (`vite.config.ts:70`). The `three` and `rapier` vendor chunks are already split out, so the lab reuses them.
- Assets come through `virtual:asset-index` and `AssetLoader`. The manifest is `src/assets/manifest.ts`: `MODELS`, `TEXTURES`, `SOUNDS`, `THEME_ASSETS`, `OBSTACLE_MODELS`, `RIG_SOCKETS` and `bossStages()`.
- `AssetLoader.loadAll()` loads everything that isn't a boss. **The lab loads per entity** using `ensureModels` and `modelVariant` (rigged → static → placeholder).

### Roster
- `wizardPlayer` is rigged and holds a staff on its RightHand bone.
- `wizardRival` has no GLB, so it always uses the placeholder. Show it in the roster with a "placeholder" badge.
- The bosses are in `src/campaign/levels.ts` `BOSSES`, three stages each, with muzzle, attacks, palette and powers.

### Animation
- `src/wizard/Animator.ts` has two layers. Its sources are idle, loco, jump, cast, castBig, dodge, hit, stunned, victory and defeat.
- Its API: `has`, `weight`, `time`, `duration`, `direct(clip,time,fade)`, `peak` and `update`.
- The GLB clip names are mapped in `WIZARD_CLIPS` (`manifest.ts:144`).
- `midget_stage3` is missing jump and the strafes. Tinubu skips dodge and jump (`RIG_SKIP_CLIPS`).
- Cast peaks are `RIG_CAST_PEAKS`. Root motion is pinned (`src/assets/rig.ts`).

### Spells and powers
- Core spells: bolt, blast, shield, stun and ultimate.
- Reward spells: carpet, pump, vape, lockon and breath.
- Boss power kinds: strike, barrage, march, rings, sweep, cone, seekers, flash and cloud.
- Projectile skins come from `ProjectileSkins.ts` and `skinLooks.ts`.
- Muzzles are in `wizard/muzzles.ts`. Staffs are in `staff/catalog.ts`.
- Pickups: golden tickets and the life pack. Hazards: the fire ring, arena shifts and lava.

### Arenas
- `THEME_IDS` and `arena.applyTheme(id)` handle themes. Layouts are rings, bazaar, exchange, streets, cubicles and caldera.

### Physics
- sim-core is authoritative. It uses Q16 integers and 1/6000 s ticks. Wizards are cylinders, the wall is a circle, and obstacles are boxes with grown edges.
- Rapier is now visual only, used for the camera and the crosshair.
- `SimDriver` maps sim state onto the game's objects.

### Building blocks
- `Game.create` builds everything at once, which is too heavy for the lab. **Assemble the lab from smaller parts**: `WizardVisual`, `Animator`, `AssetLoader`, `Arena`, `SimWorld` and `SimDriver`. `src/ui/TitleStaffPreview.ts` is a working example of a small standalone rig viewer.
- `main.ts` calls `connectHub()`. The lab must not call it.

## Owner decisions applied here

- **Overlays.**
  - *Game truth* means the sim-core shapes, converted from Q16: wizard cylinders (fit-height hurtbox), projectile radii and sweeps, obstacle grown boxes, the circular arena wall, and hazard areas.
  - *Art bounds* means the model `Box3`, plus the bones and the staff and muzzle sockets.
  - Rapier colliders are not the gameplay truth. Leave them off by default and allow them only as an optional toggle labelled "visual collider (camera only)". This keeps the decision to show game truth plus art bounds.
- **Boss control.** Pick a boss and a stage (1–3). Fire any of its powers or attacks on demand. Set HP, freeze its AI, and pick a difficulty (easy/normal/hard). The sandbox uses sim-core, so movement and AI match online play and the goldens. The QA sandbox runs the older engine and does not.

## Tabs

1. **Wizards.** A turntable view of the player, each boss at each stage, and the partner. Includes a clip list with playback, layer weights, cast-peak markers, a missing-clip table, and bone, socket and muzzle axes.
2. **Staffs.** Every staff on the player rig, at LOD0 and LOD1, with socket alignment.
3. **Spells.** Cast each core spell, reward spell and boss power from a chosen caster at a target dummy. Shows the projectile skin, sweep overlay and damage readout.
4. **Sandbox.** A real `SimWorld` on a chosen arena (theme × layout).
   - Drive the player with the game's controls, with the AI opponent set to any boss and stage.
   - Pause, step one tick, and change the time scale.
   - A live readout of Q16 position, velocity, facing, sim state, current clip and frame, and HP and mana.
   - Spawn pickups and hazards.
   - Show `SimWorld.hash()` on screen.
5. **Arenas.** Every theme and layout, with obstacle models and sim shapes overlaid.
6. **Compare.** Boss stage 1 vs stage 3, or two bosses, on one clock.
7. **Loading.** The load-time panel, plus the Rapier WASM init cost.

## Files

- Add:
  - `lab.html`
  - `src/lab/**`, which is typechecked through the tsconfig include
  - `tests/lab/*.test.ts`. These cover: hash state round-trip; the lab sandbox reproducing a golden replay's hash (proving the lab drives the same sim); every boss/stage/power listed is castable; and the clip-coverage table matching the GLB headers.
  - `scripts/lab-smoke.mjs`
- Edit:
  - `vite.config.ts`, adding the input map
  - `README.md` and `ASSETS.md`, with a short note each
- Do not touch: `src/sim-core/**`, `src/qa/**`, `src/core/Game.ts` behaviour, `tests/golden/**`, `vendor/hub-sdk`.

## Phases

1. Skeleton. Add the entry and the input map. Confirm `npm run build` (including check-prod-debug and the server-sim build) still passes, and that `dist/duel-sim.server.js` is byte-identical. Record before/after numbers for `index.html`.
2. The Wizards and Staffs tabs.
3. The Spells tab and the Sandbox on `SimWorld`, with overlays.
4. Arenas, Compare, Loading, PNG export, `window.testLab`, the smoke test, docs, and the PR.

## Acceptance

- These all pass: `npm run typecheck`, `npm test`, `npm run build`, `npm run check:assets`, and the CI extras (`check:server-sim`, `test:goldens-browser`).
- No banned string appears in `dist/`.
- The server bundle and goldens are unchanged.
- Every boss at every stage plays every clip it has, and fires every power in the lab without errors.
- A lab sandbox replay matches a golden hash.

## Cursor prompt

The owner pastes this into Cursor:

```text
You are working in the Sproto Duel repo (crrreatorrr/sproto-duel). Check out the existing branch `cursor/test-lab`. It was created from the latest `main` and already contains `docs/test-lab-plan.md`.

1. Read `AGENTS.md`, `README.md`, `ASSETS.md`, `handoff.md` and `docs/SERVER-SIM.md`, then read `docs/test-lab-plan.md` in full. That plan is the spec. It records the owner's answers, so follow it exactly and don't re-ask anything it already settles.
2. Build the Test Lab phase by phase as the plan lays out, and commit after each phase. The lab is a separate, unlinked `lab.html` page with `noindex` and its own bundle. It loads each character only when that character is selected. It ships hidden in the production build.
3. Repo-specific hard rules:
   - The production build must not contain `__duel`, `QAHarness`, `registerSpellScenarios` or `campaignSoak` (`scripts/check-prod-debug.mjs`). Never import `src/qa/**`.
   - Don't edit `src/sim-core/**` or `tests/golden/**`. The sandbox drives the exported `SimWorld`, and a test must show a lab replay matching a golden hash. `dist/duel-sim.server.js` must stay byte-identical.
   - Overlays show the sim-core shapes, which are the gameplay truth, plus the model bounds, sockets and muzzles. Rapier colliders are an optional toggle labelled "camera only".
   - Never call `connectHub()`. Assemble the lab from WizardVisual, Animator, AssetLoader, Arena, SimWorld and SimDriver, not `Game.create`. Keep the `vite.config.ts` edit small.
4. Never write the real save, never take tab or writer locks, and never initialise the hub. Use `window.testLab` as the automation handle.
5. When done, run: `npm run typecheck`, `npm test`, `npm run build`, `npm run check:assets`, `npm run check:server-sim`, `npm run test:goldens-browser`, and the new `scripts/lab-smoke.mjs`. Then open a PR from `cursor/test-lab` into `main` titled "Add Test Lab (lab.html)". In the PR, report:
   - the game page's load numbers (JS bytes, request count, time to first frame) before and after;
   - the result of every check, and any check you could not run, with the reason;
   - every place you mirrored private code, and the drift test that guards it.
6. If part of the plan can only be done by breaking one of these rules, stop and ask me rather than editing a protected file.
```
