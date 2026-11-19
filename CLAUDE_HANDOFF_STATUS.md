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

## Measurements

`node scripts/measure-boot.mjs` (Playwright Chromium, cache disabled, `vite preview` serves gzip). "Boot" counts requests
sent before the main menu's DOM first appears. "Idle" counts everything 6 s later. Baseline is `main` (`d112157`)
built in a worktree and measured with the same script.

| | `main` | this branch |
| --- | --- | --- |
| Boot requests / bytes | 105 / 10.62 MB | 23 / 3.10 MB |
| — of which models | 10 / 4.32 MB (8 staffs) | 3 / 0.55 MB (player, life pack, equipped staff) |
| — audio | 54 / 3.31 MB | 3 / 0.08 MB |
| — images | 1 / 0.89 MB | 1 / 0.36 MB |
| — JS (Rapier 1.65 MB) | 3 / 2.03 MB | 3 / 2.03 MB |
| After 6 s idle | 147 / 16.96 MB | 85 / 4.87 MB |
| Menu up, 10 Mbit/s 40 ms RTT (`--mbps 10 --latency 40`) | 6.8 s | 3.2 s |
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

## Cross-repo follow-ups

- metaverse-hub: a shared asset CDN path for §1.3.4.

## Proposed repo-hygiene deletions (owner's call)

- `public/assets/models/staffs/staff_*.glb` without `-lod1` (6.5 MB): authoring outputs. They could move out
  of `public/`, e.g. to `art-src/`.
- `public/assets/ui/player.png` (402 KB): nothing loads it.
