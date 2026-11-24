# Blender tasks

Model, rig and animation work found by the gameplay QA pass of 2026-11-24 (against `main` at
58de65d). None of it was attempted in code. Each task says what is wrong, how to see it, what is
expected and how to check it in the game.

A static check of every rigged GLB came back clean: all 19 files in
`public/assets/models/rigged/` have one skin and one mesh, every clip name in the manifest's
`WIZARD_CLIPS` is present (The Midget's stage 3 has no `strafe_l`, `strafe_r`, `run_back` or
`jump` on purpose, see ASSETS.md), and every bone named by `RIG_SOCKETS` and the player's staff
spec exists. The tasks below are the model files the manifest names that are not in the repo.

## 1. The Quick Duel rival has no model

- **Asset:** `public/assets/models/wizard_rival.glb` (manifest key `wizardRival`,
  `src/assets/manifest.ts`). There is no rigged file for it either: the entry has no `rigged`
  block and `public/assets/models/rigged/` has no rival.
- **What is wrong:** the file does not exist, so the opponent in Quick Duel, Player 2 in Local
  Versus, the online opponent and the menu's background duellist are the code-built placeholder:
  a red cone-robed figure with a hat and a stick, sliding without leg or arm animation. The
  player and all six bosses are rigged characters, so the rival is the one character on screen
  that is not.
- **How to see it:** `npm run dev`, main menu, **Quick Duel**. The rival across the arena is the
  red primitive figure. Local Versus shows it close up in the right half of the screen.
- **Expected:** a rival wizard to the spec in ASSETS.md (`wizard_rival`: crimson and gold,
  1.85 m, at most 10,000 triangles, feet at y = 0), rigged like the player: the 24-joint humanoid
  skeleton, facing +Z, the 13 clips `idle`, `run`, `strafe_l`, `strafe_r`, `run_back`, `jump`,
  `cast`, `cast_big`, `roll`, `hit`, `stun`, `victory`, `defeat`, and a staff or wand on the right
  hand bone. Static mesh at `models/wizard_rival.glb`, rigged file at
  `models/rigged/wizard_rival.glb`. The manifest entry then needs a `rigged` block with the
  measured staff socket (a code change for whoever lands the asset).
- **Verify in game:** `npm run check:assets` lists the file within budget. In a Quick Duel the
  rival runs, strafes, casts, rolls, is stunned and falls with its own clips, its bolts leave the
  staff tip, and `await __duel.qa.runAll('anim.')` and `runAll('muzzles.')` pass.

## 2. The moonlit arena (Quick Duel, Local Versus, online, menu) has no models

- **Assets:** `public/assets/models/pillar.glb`, `pillar_broken.glb`, `pillar_debris.glb`,
  `arena_ruins.glb` and `brazier.glb` (manifest keys `pillar`, `pillarBroken`, `pillarDebris`,
  `arenaRuins`, `brazier`).
- **What is wrong:** none of the five files exists. The default arena is drawn with code-built
  stand-ins: plain cylinders for the 14 pillars, a plain stump and box chunks when one crumbles,
  slab "standing stones" outside the wall and simple bowls for the braziers. Every boss arena has
  its own modelled pillar and prop (`models/themes/<theme>/`), so the arena a new player sees
  first is the least finished one.
- **How to see it:** main menu background, or any Quick Duel. Fire bolts at a pillar until it
  crumbles to see the stump and the debris.
- **Expected:** the five models to the sizes and budgets in ASSETS.md (pillar 5.5 m tall and
  about 1.7 m wide, roughly round because its collider is a cylinder; stump 1.0 m with the same
  footprint; one debris chunk under 400 triangles; ruins piece 6 m; brazier 1.6 m). Origins at
  the base centre, upright, real-world scale.
- **Verify in game:** `npm run check:assets` lists them within budget. In a Quick Duel the
  pillars, stumps, debris, backdrop ruins and braziers use the models, a wizard cannot walk into
  a pillar's visible stone or stand inside it, and bolts stop at its surface.

## Not checked

The boss stage models and their clips were not inspected close up in this pass (the headless
software renderer runs at a few frames a second and the close-up captures did not frame the
bosses). The in-game `anim.`, `muzzles.` and `render.` QA scenarios pass for them. A person
should still watch each boss stage once for skinning or foot-sliding problems.
