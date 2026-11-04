# Higgsfield Workflow Guide: Sprite Sheets and Rigged 3D Characters

Prices checked 2026-11-04 with Higgsfield's live price check, on the Ultra plan. No jobs were submitted. Re-check before each paid step, because prices may change and these checks ran without an uploaded image.

**Default:** use the low-cost workflow. Use the free workflow when you have more time than credits.

**What "free" means:** no credits beyond the Ultra plan. Concept images are free only on higgsfield.ai with the Unlimited toggle on. Unlimited does not apply through MCP or CLI, so generating them from a Claude chat costs about 1 credit each. Check Manage Account → Subscription → Active unlimited models for what is currently active.

## Which workflow each game uses

| Game | Workflow |
|---|---|
| Sproto Duel, NOBU | Rigged 3D character |
| HPOS10I, The People's Bitcoin, Sproto Arena, Sproto Arcade | Sprite sheets |
| Metaverse Hub | Both |

## How every task runs

1. **Brief:** give the task type, free or low cost, credit limit, game engine, and sprite size or polygon limit.
2. **Price check:** Claude runs a live check before each paid step.
3. **Approval steps:** nothing paid or larger-scale starts until you say yes, unless you turn on skip approvals.
4. **Retries:** Claude shows the reason and price, then waits for approval, unless you turn on skip approvals.
5. **Report:** you get the credits used and final files at the end.

## Skip approvals

When you say so, such as "skip approvals", Claude completes the whole workflow for that task without stopping at approval steps. It never carries over to another task.

- **Decisions:** at each "You approve" step, Claude checks the result against your brief, makes the call and continues.
- **Price checks:** these still run before each paid step.
- **Credit limit:** with no limit in your brief, the limit is the workflow's listed cost plus about 1 credit for each concept image generated from a chat. That's about 10 credits for five sprite actions on Turbo, or about 84 for a 3D character with one mesh retry. A free workflow's limit is 0 credits.
- **Retries:** Claude retries a failed step once without asking, if it stays within the limit.

Claude still stops and asks if:

- The next step would go over the credit limit.
- A step fails again after its retry.
- A step needs your login or something only you can do, such as switching on the Unlimited toggle.
- A repo's instructions pause that work. For example, a stop on animation production in `AGENTS.md` still applies.

Skip approvals covers only the steps in this guide. Committing, merging and publishing still follow each repo's rules.

The final report also lists each decision Claude made, each retry, and anything it couldn't check itself, such as how the result feels in your game.

## 1. Sprite sheets

### Free

| Step | Use | You approve |
|---|---|---|
| 1. Style | FLUX.2 Pro: 3–4 tests | Art style, palette, camera view, sprite size |
| 2. Character | Nano Banana, with the approved style as a reference | Character design from the game's camera view |
| 3. Key poses | Nano Banana or Seedream 5.0 Lite: 4–8 poses for one action | Poses before making the other actions |
| 4. First animation | Free editor such as LibreSprite or Piskel: clean up, align and loop | Motion at game speed |
| 5. Full set | Repeat steps 3–4 and export the sheet | Final sheet in your game |

Expect some jitter between frames, so this works best for short, simple loops.

### Low cost: about 10 credits for five actions on Turbo

| Step | Use | Cost | You approve |
|---|---|---|---|
| 1–2. Style and character | Same as the free workflow | 0 | Style and character |
| 3. Test animation | AutoSprite Turbo: walk | 2 credits | Sheet running in your game |
| 4. Quality check, if needed | AutoSprite Pro: walk | 3 credits | Whether Pro is visibly better |
| 5. Remaining actions | Whichever tier you approved | 8 credits for four more on Turbo, 12 on Pro | Final set |

Avoid AutoSprite Max at 14 credits per sheet (checked at 25 frames, 256 px) unless Pro falls short. Leave sound off, because it adds cost.

## 2. Rigged 3D character

### Free

| Step | Use | You approve |
|---|---|---|
| 1. Concept | Nano Banana: 3–4 designs | Design and silhouette |
| 2. Model sheet | Seedream 4.5: front, side and back views in an A-pose | Proportions and outfit, with no loose props |
| 3. Mesh | TripoSR on your computer, or Blender by hand | Shape, before any rigging |
| 4. Rig | Mixamo for two-legged characters | Walk test with no broken joints |
| 5. Finish | Blender: fix the mesh and textures, then export | Final model in your engine |

- **Hardware:** TripoSR reportedly needs about 6 GB of video memory, and its rough output will need cleanup.
- **Free tiers:** Meshy's free tier is reportedly non-commercial, so check its terms before using it for a game you'll sell.
- **Mixamo risk:** its current status was not confirmed with Adobe, and a competing vendor reports login problems. AccuRIG is the suggested Windows backup.

### Low cost: about 46 credits per character

| Step | Use | Cost | You approve |
|---|---|---|---|
| 1–2. Concept and model sheet | Same as the free workflow | 0 | Design and all views |
| 3. Textured mesh | Meshy 7 Image to 3D, in an A-pose | 38 credits | Shape and textures |
| 4. Rig and test animation | Meshy 3D Rigging with a walk clip | 8 credits (5 for rig only) | Joints and movement |
| 5. More animations | Mixamo, if it works for your model | 0 | Final animation set |

- **Retries:** budget about 84 credits with one mesh retry.
- **Don't bundle the steps:** mesh and rig in one run costs 44 credits and removes the chance to reject the mesh before rigging.
- **Optional mesh savings:** Tripo P2 cost 34 credits at fast texture quality and 20,000 faces. It may output FBX rather than the GLB the rigging step needs, so Meshy 7 stays the default.

## Prices checked

| Model and settings | Credits |
|---|---|
| Nano Banana, 1:1 | 1 |
| FLUX.2 Pro, 1K, 1:1 | 1 |
| Seedream 4.5, basic, 16:9 | 1 |
| AutoSprite Turbo, walk (8 frames at 128 px, 16 at 128 px, 25 at 256 px) | 2 |
| AutoSprite Pro, walk (8 frames at 128 px, 25 at 256 px) | 3 |
| AutoSprite Max, walk, 25 frames at 256 px | 14 |
| Meshy 7, untextured (standard or low-poly) | 25 |
| Meshy 7, textured (standard or low-poly) | 38 |
| Meshy 7, standard, textured, A-pose, rigged | 44 |
| Meshy 7, low-poly, textured, PBR, A-pose, rigged, animated | 47.5 |
| Tripo P2, textured, fast quality, 20,000 faces, no PBR | 34 |
| Meshy 3D Rigging | 5 |
| Meshy 3D Rigging with one animation | 8 |

## Known gaps

- AutoSprite was priced only for the walk action, not other actions or isometric directions.
- Multi-Image to 3D needs uploaded images before it will quote, so it has no price here. Use it only if a single image gets the shape wrong.
- None of these workflows have been test-run, and the model picks come from catalog descriptions.
- Free tool details come mostly from third-party blogs, some run by competitors. Check licenses and availability first.
- Higgsfield's official pages disagree on some unlimited models, so trust the Active unlimited models list in your account.

## Sources

- [Higgsfield pricing explained](https://higgsfield.ai/blog/higgsfield-pricing-explained)
- [Higgsfield 7-day Unlimited bonus](https://higgsfield.ai/blog/higgsfield-7-day-unlimited-bonus)
- [Mixamo and alternatives guide](https://app.cinevva.com/guides/free-character-animations-rigging)
- [Mixamo alternative comparison](https://sorceress.games/blog/mixamo-alternative-auto-rig-3d-characters-in-the-browser)
- [Free image-to-3D generators](https://www.scriptbyai.com/best-free-ai-image-to-3d-generators/)
- [Free AI 3D generators compared](https://www.3daistudio.com/blog/best-free-ai-3d-model-generators-2026)
- [TripoSR listing](https://ai-tools-finder.pages.dev/tools/triposr)
