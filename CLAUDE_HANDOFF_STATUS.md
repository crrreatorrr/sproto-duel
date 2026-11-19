# Handoff status: `CLAUDE_HANDOFF_OPTIMIZATION.md` (sproto-duel)

Branch `claude/happy-pasteur-0dhfzp`, based on `main` at `5550627` plus the handoff and brief docs.
I checked every item against the code before acting on it. Gameplay, balance, the sim (`src/sim-core/`),
`DUEL_SIM_VERSION` (`8f68aa09e9873540`) and the 26 golden replays are unchanged.

Status values: **done** (commit), **partial** (what remains), **skipped** (why), **blocked** (on what).

## Phase 0: security and quick wins

| Item | Status | Notes |
| --- | --- | --- |
| §2.3.1 God-mode wins post `sproto.boss_defeated` | done `997ba85` | Anyone can turn god mode on (`?god`, F9, Settings), and a god-mode win paid Tickets through the boss event. `planDuelWin` now returns nothing for a god-mode win. Tests in `report.test.ts` and `link.test.ts`. |

## Phase 1: boot and assets (§1)

| Item | Status | Notes |
| --- | --- | --- |
| §1.1 Remove Rapier | skipped (partial win in `81d729c`) | Rapier still drives gameplay input and three runtime paths. (1) `PlayerController.updateAim` raycasts the crosshair against walls, pillars and wizard capsules in every real match, and the hit becomes the `aimPoint` sent to the sim (online too). Swapping in an analytic caster would change aim points: an input change. (2) The menu's attract duel runs the legacy Rapier `Wizard`/`SpellSystem`/`AIController` path. (3) The QA harness and its ~30 scenario files (`qaMode`/`inSandbox`), `GoldenTickets`, `LifePacks`, `BossCinematic` and the camera use it too. Porting all of that is a rewrite, not a load-time fix. What I did instead: Rapier is now a dynamic import (`Physics.create`). Its 1.65 MB chunk is no longer modulepreloaded and downloads beside the boot assets. |
| §1.2.1 Only the equipped staff at boot | done `3b80b46` | `loadAll(…, [getLoadout().staff])`. `App.mountStaff` and `TitleStaffPreview` load other staffs when equipped (rack pick, online rival) and swap them in when they land. The dev build prefetches every staff for QA. |
| §1.2.1 `golden_ticket.png` as WebP | done `0a84d3e` | 935 KB → 382 KB (near-lossless; lossy WebP smeared the gold lettering). |
| §1.2.2 Transcode 54 WAVs | done `1e2ce83` | MP3 (LAME VBR q4) instead of Opus+MP3. Opus mangled the 50 ms `uiHover` (9.9 dB mean band error vs < 1.3 dB for MP3). MP3 is about the same size (569 vs 581 KB) and plays everywhere. 3.30 MB → 0.58 MB. Chromium decodes the MP3s to the WAVs' exact sample count, so the loops stay seamless. `gen:audio` writes MP3 through ffmpeg, or WAV without it. Its output is byte-identical to the committed MP3s. |
| §1.2.2 Tiered audio loading | done `1e2ce83`, `bcaeb7e` | Boot preloads `uiClick`, `uiHover` and `musicMenu`. Everything else loads through `AudioManager.loadAll()`, once the first menu is idle (rIC, 2.5 s) and again at match start. A sound played before it has loaded is queued until it has. |
| §1.2.3 Boss prefetch | done `d94754e` | Was all 18 rigged boss models 1.5 s after boot. Now: the saved gauntlet fight's boss only (`App.prefetchNextBoss`), and the boss card prefetches the next one. Nothing while an online duel is set up or running. |
| §1.3.1 Purge non-LOD1 staff GLBs (6.5 MB) | done, as exclusion `a7515cd` | Nothing loads them: `staffModelPath` returns `-lod1` only, and only `tools/blender` docs mention them. They are the full-detail authoring outputs of `tools/blender/finish-staff.mjs`, so they stay in git. The build deletes them from `dist/`, and `virtual:asset-index` leaves them out (`ARCHIVED_ASSETS` in `vite.config.ts`). |
| §1.3.1 Purge 19 static boss/player GLBs (3.2 MB) | skipped | The handoff's claim is wrong. `AssetLoader.loadModelVariant` falls back to the static mesh when the rigged GLB fails to load, so these are a runtime fallback. They are never fetched in normal play, so they cost deploy size only. |
| §1.3.2 `ui/bosses/*.png`, theme JPGs, other UI → WebP | done `0a84d3e` | 46 files, 20.74 MB → 8.96 MB, **same resolution** (not capped at 1024). Every file is ≥ 38 dB premultiplied-RGBA PSNR against its source, and side-by-side crops at 1:1 show no difference. Re-run with `node scripts/convert-images-webp.mjs`. Manifest paths are unchanged because `resolveImage` finds the `.webp`. `ui/player.png` is unreferenced: excluded from `dist/` and left as it is. |
| §1.3.3 Re-pack shooter/fighter/alien_ray `-lod1` | done (partial) `a92a4b9` | Base colour and RM/emissive textures are now WebP (EXT_texture_webp) at 1024². Normal maps stay JPEG, because lossy WebP misses 38 dB on them. 2.85 MB → 2.54 MB. I did not downscale: these staffs no longer load at boot, and the title preview shows them close up. Old and new GLBs render at 54–58 dB PSNR. |
| §1.3.4 Shared CDN for Sproto assets | blocked | Waits on metaverse-hub to expose `play.<domain>/shared-assets/sproto/`. |

## Phase 2: online (§2)

| Item | Status | Notes |
| --- | --- | --- |
| §2.1 Guest movement prediction and reconciliation | done `fa1757e`, `2e8e587` | `src/net/GuestPredictor.ts` steps the guest's own wizard with sim-core's `SimWizard`/`SimArena` (the host's own movement, fixed point), one step per sent frame. It reconciles against each snapshot at `ack` and replays the unacked frames. It handles the countdown boundary (from the intro's `phaseTime`), rebuilds the sim's jump/roll input buffer (not for a jump the host already used), syncs broken cover and the fire ring, and applies the ring push. `PredictionSmoother` eases corrections (τ 90 ms) and snaps past 2 m. The opponent and projectiles stay interpolated/extrapolated. Visual only: the host's sim is the sole authority. Settings live in `OnlineController`'s `PREDICTION`, not `CONFIG`, because CONFIG is inside `dist/duel-sim.server.js` and adding to it would change `DUEL_SIM_VERSION`. Not predicted (corrected at the next snapshot, smoothed): spell knockback, stuns, casts started in the unacked window, moving cover (it stays at its rail start in the predictor). |
| §2.1 Prediction tests | done `fa1757e` | `guestPredictor.test.ts` links a real host `SimWorld` (online rules) to the predictor over a delayed, lossy link with the real `RemoteInputBuffer` and wire-quantized snapshots. Worst error between the prediction shown for a frame and the host's state after it, 12 s of walking, sprinting, jumping and rolling: 0 ms RTT 1.2 cm, 60 ms 1.3 cm, 150 ms 3.2 cm (snapshot centimetre quantization). With 5% loss (both directions), the final error after standing still is ≤ 0.5 cm at every RTT. |
| §2.2 `rejoin` handler | done `2e8e587` | `OnlineSession.onRejoin` resyncs the snapshot clock, drops stale queued input, re-primes a host's input buffer (keeping the ack), pings at once, then emits `'rejoin'`. `OnlineController` resets the prediction. A START re-sent while playing (same seat) resyncs the clock and is not a new match. A re-sent START with a *different* seat is still ignored, as before; the server should never send one. |
| §2.2 SnapshotBuffer clock recovery | done `239e494` | Three snapshots in a row ≥ 250 ms late re-anchor the offset at once (a single spike doesn't). `resync()` follows the least offset of the last three for 10 snapshots, so a stale pre-outage packet can't pin it. Also: back from an outage (the buffer dry for 10+ ticks, then 20+ frames deep), `RemoteInputBuffer` jumps to the newest frames instead of playing the guest at 2× for as long as the outage lasted, dropping presses older than `maxLag` (`3575b96`). |
| §2.2 Reconnect test | done `2e8e587` | `onlineSession.test.ts` › "OnlineSession rejoin": a 3 s guest drop with every link 100 ms slower on return (playout lag back to 60–150 ms; the host within 30 frames of the guest's newest), a host rejoin, a re-sent START. Without the fix, the first two fail (lag −112 ms; host 152 frames behind). |
| §2.3.1 God-mode boss event | done `997ba85` | See Phase 0. |
| §2.3.2 Guest input proof, client side | done `2e8e587` | The guest sends `inputs` (`InputDigestMsg`) in OP.RESULT. The host sends `net.guestFrames` in the OP.LOG JSON. Both are additive (see the server contract below). The OP.LOG format is backward compatible: `net` is a new top-level key that `setupFromLog`/`replay` ignore, and the sim log fields and the chunking are unchanged. |
| §2.3.3 Server-issued gauntlet seeds, verified `sproto_wins` | blocked | Needs a hub RPC (challenge seed on gauntlet start) and the hub SDK re-vendor this pass may not do. Client today: `Match.startSimMatch` draws the seed locally. |
| §2.3.4 Goja replay timeout → Node replay-verifier | blocked | Server-side (metaverse-hub `services/replay-verifier`). Nothing changes in this repo: the bundle stays as it is. |

### Server contract for §2.3.2 (for the metaverse-hub `sproto_arena` session)

I could not read metaverse-hub from this session (the repo isn't attached), so this follows the protocol as
`src/net/protocol.ts` and `FakeArenaServer` model it. Reference code: `src/net/inputProof.ts`.

1. **Relay record.** For the guest seat (`1 - hostSeat`), keep every frame of every relayed OP.INPUT,
   unpacked with the same rules as `unpackFrames` (8 numbers per frame: `tick, mx, mz, facing, ax, ay, az,
   held | press << 2`). Keep the **first** copy seen per tick (INPUTs repeat recent frames for redundancy).
2. **Digest check.** `digestFrames(frames)` is FNV-1a 32 over the unique frames in ascending tick order. Each
   frame is the 8 packed numbers, each as a little-endian int32 (`v | 0`); start 0x811c9dc5, prime 0x01000193,
   output 8 lowercase hex digits. Compare it with the guest's OP.RESULT `inputs` = `{ n, first, last, fnv }`,
   computing the server side over the relayed frames with `first <= tick <= last` only. The guest flushes its
   queued frames just before RESULT and seals the digest there, then keeps sending until OUTCOME.
   Equal means the relay and the guest agree on every frame. Expect a mismatch, and don't treat it as cheating,
   when the guest dropped and rejoined (frames sent into the dead socket never reached the server) or sent no
   RESULT. A RESULT without `inputs` comes from an older client: skip the check.
3. **Log check.** OP.LOG's JSON may carry `net: { v: 1, guestSeat, guestFrames: [[simTick, guestTick, count], …] }`.
   Within a run the guest tick rises by one per sim tick, and `guestTick` −1 is a run of holds. For each sim tick
   `k` (0-based, as the log's input stream counts) the host played guest frame `g = guestTicks.at(k)`. Rebuild the
   guest seat's sim input during the replay and compare it with `inputs[guestSeat]` at tick `k`:
   - played frame `F` (relayed tick `g`): `move = quantizeMove(normalize(F.mx/127, F.mz/127))`, `held = F.held`,
     `facing = quantizeYaw(F.facing / 65536 · 2π)`, aim from `F.aim` (cm) relative to the guest wizard's
     chest *in the replay at tick k*, exactly as `src/core/simInput.ts` `sampleSimInput`. Press: `F.press`, OR-ed
     with the presses of guest frames the host skipped or got late since the previous played frame
     (RemoteInputBuffer's "owed" rule). So check `logged.press ⊆ F.press | presses of relayed frames in
     (previous g, g)`.
   - hold (−1): movement, held and facing of the last played frame, `press = 0`; idle before any frame.
   - idle hold (−2): the guest had left (PEER absent; `RemoteInputBuffer.clearHeld`): no movement, `held = 0`,
     `press = 0`, facing of the last played frame.
   - `g` not in the relay record: the host invented a frame → dispute.
   A log without `net` comes from an older client: fall back to today's behaviour.

## Phase 3: polish (§3)

| Item | Status | Notes |
| --- | --- | --- |
| §3.1 Second WebGL context in `TitleStaffPreview` | skipped | There are two ways, and both risk a visible change on the title screen. (a) Draw the stage into the main canvas with a scissor pass after the composer. The stage then sits *under* the menu's DOM layer instead of inside it, so the menu backdrop and gradients would cover the character. It also has to redraw every main frame (the composer clears the canvas), and it touches the split-screen viewport code. (b) Render to a target and copy it into the stage's 2D canvas each frame: `readPixels` stalls the GPU. The second context is small (`low-power`, capped size) and is disposed when a match starts (`disposeTitleStage`). Worth a follow-up with someone checking the title screen. |
| §3.2 Lazy hub feedback | done `655a679` | `installGameFeedback` is a dynamic import, installed on idle about 1 s after boot. Main chunk 936.6 → 911.8 kB raw. The handoff's 93 KB is too high: the SDK's feedback code is 25 kB, and `modern-screenshot` was already a lazy chunk. Until it's installed (the first second), N-N and the pause menu's button do nothing, and early crashes aren't listed in feedback notes. |
| §3.3 Account-scoped staff and skin | done `a30ba0a`, `53e4f6d` | `<key>@<playerId>` with a hub session (the campaign run's convention), set in `main.ts` before `App` reads them. An account with no choice of its own starts from the browser's (checked against its relics and unlocks), so existing players keep theirs. Standalone keeps the browser's keys. Not handled: switching accounts without a reload (the session is set once at boot, as for the campaign). |
| §3.4 Non-blocking fonts | done `28af583` | `media="print" onload="this.media='all'"` plus a `<noscript>` copy. Not self-hosted: that needs the font files in the repo (no new assets this pass). |

## Final review

I reviewed the whole diff against `origin/main` with `/code-review` (high effort). It found seven issues, all fixed:

| Finding | Fix |
| --- | --- |
| Prediction corrections were never smoothed: `before` aliased the array `pose()` overwrites | `ff9de26`: the bookkeeping moved into `PredictedView` (copies first), with a test |
| The guest digest hashed frames at queue time and after RESULT, so it would never match the server's | `a437a2d`: hash as INPUT sends, flush before RESULT, seal at RESULT; test checks the `[first, last]` range |
| After a host rejoin, `reset(keepAck)` let redundant copies of frames already played play again | `cd03a31`: frames at or before the kept ack are ignored; test |
| The boot staff preload ran `getLoadout()` before relics were known (could reset the saved staff) | `2d917b9`: `peekSavedStaff()` reads without validating or writing |
| SFX played before loading were queued and burst out late | `be83fab`: skipped, and the load starts; music and ambience still wait |
| Boot boss prefetch could read the campaign before the account's cloud save arrived | `f4b0830`: waits for `campaign.attach` |
| A not-yet-loaded staff swaps its mesh after a match starts | `f4b0830`: documented as look-only; it normally lands inside the 2.4 s intro |

## Independent review (fresh subagent, given the diff and the rules, not my conclusions)

It found no important bugs and confirmed that `src/sim-core/`, `src/config.ts` and `dist/` are untouched and that the protocol is still compatible. Its four nits are fixed:

| Finding | Fix |
| --- | --- |
| After a rejoin, the playout fell back to the oldest buffered snapshot for a round trip (wizards jumped back about 1 s) | `4ac3234`: the old clock estimate stands until a new snapshot replaces it; test |
| Holds after the guest left are idle (clearHeld), not "the last frame again": the documented rule would dispute an honest host | `285c3a1`: those ticks are `-2` in `net.guestFrames`; contract below updated |
| The boot staff guess read the browser's key for hub players | `53e4f6d`: once the account is known, `main.ts` loads its staff before App shows it |
| Existing hub players would lose their staff and skin choice once (no migration to the per-account keys) | `53e4f6d`: an account with no choice of its own reads the browser's, still checked against its relics and unlocks |

## QA playtest (`qa-tester` agent, HEAD `2e8e587`)

Production and dev builds were compared side by side with `main` (SwiftShader, so frame rates are only comparable
branch against main: no regression, p95 within noise). Bytes over the first ~40 s: about 3.5 MB here, about 20.5 MB on `main`.
Staff lazy-loading, the deferred sounds and the next-boss-only prefetch all worked. `net.` QA scenarios: 4/4.

| Finding | Severity | Status |
| --- | --- | --- |
| After an outage, the input-buffer catch-up fired presses seconds old, all on one frame | major | fixed `3575b96`: catch up only after the buffer ran dry for 10 ticks, and drop presses past `maxLag`; test |
| The title preview showed an empty hand while a picked staff loaded (and for good if the load failed) | polish | fixed `4b9e3a0`; checked in the production build with the GLB held back 4 s |
| Guest's own wizard: corrections of ~0.1 m (p95) under 60 ms jitter, and a snap (3.4 m) after a 1 s outage, because the host holds the guest's last movement for the whole outage | minor | not changed. The smoother eases the jitter corrections, and the outage snap is the correct catch-up to where the host had the wizard. Decaying the held movement during long underruns is a change to how the host plays the guest (input policy), so I left it to the owner. Possible tuning: `PREDICTION.smoothMs` 90 → 120. |
| HUD and stats name the new staff while its model is still loading | minor | documented (`applyStaff`): look-only, normally done inside the 2.4 s intro. Blocking the match start on the download was judged worse. |
| `/favicon.ico` 404 | polish | pre-existing on `main`; no new asset this pass |

The guest-side prediction could not be played by hand: `?netsim` always makes the page the host. The probe and unit
tests are the evidence. Suggested follow-up: a `net.guest-predicts` QA scenario and a `?netsim=80&seat=guest` dev mode.

## Fixes after the merge (#50)

The QA harness failures that were already failing on `main`, and the favicon 404. Full `qa:headless` run after these: 273 passed, 0 failed (with the flaky probe below passing that time).

| Item | Fix |
| --- | --- |
| `rewards.unlock_per_boss_and_persist`, `rewards.save_migration` checked the pre-#49 save format | `f02b5d3`: they now check the progress store's format and the legacy migration as it runs now |
| `sim.live_practice_runs_every_lesson` looked for `practiceDone` in the settings key | `6ace24c`: it checks the campaign progress (and a fresh read), with the save stashed and restored |
| `duo.hud_cards_and_banners_name_both`: on short screens the boss and partner plates ran past the top half | `348d693`: compact plates under 520 px of height, more compact under 380 px; 640 px and taller unchanged |
| `/favicon.ico` 404 at every boot | `53c34af`: an empty `data:` icon in `index.html` |
| `campaign.ladder_escalates` fails about one run in three, on `main` and here, each time on a different boss | **not fixed, and not a balance bug** (I said it was, earlier). Runs of the same build give different stage numbers, even two runs in one page, although the probe seeds `Math.random`: something outside the seeded stream feeds the legacy `AIController` path it measures. Muting gameplay audio (which draws from `Math.random`) did not settle it, and the results fall into a few repeating patterns, so it is probably carried-over discrete state. The probe also measures the legacy Rapier AI, not the sim-core AI real gauntlet fights use. Follow-up: make it deterministic, or port it onto `SimWorld` (`src/qa/simProbe.ts` has the pieces). |

## Measurements

`node scripts/measure-boot.mjs` (Playwright Chromium, cache disabled, `vite preview` serves gzip). "Boot" counts requests
sent before the main menu's DOM first appears. "Idle" counts everything 6 s later. Baseline is `main` (`d112157`)
built in a worktree and measured with the same script.

| | `main` | this branch |
| --- | --- | --- |
| Boot requests / bytes | 105 / 10.62 MB | 20–23 / 3.04–3.10 MB |
| — of which models | 10 / 4.32 MB (8 staffs) | 3 / 0.55 MB (player, life pack, equipped staff) |
| — audio | 54 / 3.31 MB | 3 / 0.08 MB |
| — images | 1 / 0.89 MB | 1 / 0.36 MB |
| — JS (Rapier 1.65 MB) | 3 / 2.03 MB | 3 / 2.03 MB |
| After 6 s idle | 147 / 16.96 MB | 86 / 4.86 MB |
| Menu up, 10 Mbit/s 40 ms RTT (`--mbps 10 --latency 40`) | 6.8–6.9 s | 3.1–3.7 s (run to run) |
| Main JS chunk (raw) | 935.3 kB | 912.1 kB (feedback is a 25 kB lazy chunk) |
| `public/assets/` | 48.53 MB | 32.92 MB (6.9 MB of it archived, not shipped) |
| `dist/` | 54.62 MB | 32.53 MB |

The handoff's target of under 1.5 MB at boot needs Rapier gone (1.65 MB on its own), and §1.1 explains why it stays.

## Checks

Run on this branch after Phase 1:

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm test` | pass: 47 files, 365 tests (the golden replays included) |
| `npm run build` | pass. `dist/duel-sim.server.js` is unchanged (version `8f68aa09e9873540`). |
| `npm run check:assets` | pass |
| `npm run check:server-sim` | pass |

Handoff Verification Checklist, golden replays on three engines: Node (`npm test`, server-bundle suite) 26/26;
Chromium `npm run test:goldens-browser`: 26 goldens, 0 failed; Goja `npm run test:goja` (Go 1.24.7): 26 goldens,
0 failed, slowest replay 51.4 s (§2.3.4's timeout concern, server-side).

Final (after both reviews and the playtest fixes, HEAD of this branch): typecheck pass, `npm test` pass (49 files,
394 tests), `test:goldens-browser` 26/26, `qa:headless net.` 4/4. The server bundle is byte-identical to `main`'s:
`dist/duel-sim.server.js`, sha256 `e41e427fb55c6307029548e3b4af986027f8fa359dd5653a10ee5a33ed98503c`, built by
`npm run build:server-sim` (part of `npm run build`), so the Goja result above still applies. Earlier final pass: `npm test` pass (49 files, 391 tests), build
pass (`dist/duel-sim.server.js` unchanged, version `8f68aa09e9873540`), check:assets pass, check:server-sim pass.

After Phase 2: typecheck pass, `npm test` pass (49 files, 388 tests), build pass (`dist/duel-sim.server.js`
unchanged, version `8f68aa09e9873540`), check:assets pass, check:server-sim pass.

`npm run qa:headless` (in-browser QA harness, SwiftShader): the `net.` scenarios pass (4/4) after Phase 2. The full run
started after Phase 1 (268 passed, 5 failed) failed these: `campaign.ladder_escalates`, `duo.hud_cards_and_banners_name_both`,
`rewards.unlock_per_boss_and_persist`, `rewards.save_migration` and `sim.live_practice_runs_every_lesson`. All five fail the same way on `main` (checked in a
`main` worktree), so this branch didn't cause them.

## Cross-repo follow-ups

- metaverse-hub: a shared asset CDN path for §1.3.4.
- metaverse-hub `sproto_arena`: implement the §2.3.2 relay record, digest check and log check above. The
  client already sends `inputs` and `net.guestFrames`.
- metaverse-hub: a challenge-seed RPC for gauntlet starts and replay proof for `sproto_wins` (§2.3.3). It needs
  a hub-sdk re-vendor here afterwards (not done in this pass, per the brief).
- metaverse-hub: run `dist/duel-sim.server.js` in the Node replay-verifier (§2.3.4). No change here.

## Proposed repo-hygiene deletions (owner's call)

- `public/assets/models/staffs/staff_*.glb` without `-lod1` (6.5 MB): authoring outputs. They could move out
  of `public/`, e.g. to `art-src/`.
- `public/assets/ui/player.png` (402 KB): nothing loads it.
