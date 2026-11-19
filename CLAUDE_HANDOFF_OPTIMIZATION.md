# Claude Code Implementation Handoff — `sproto-duel`

**Branch:** `claude/pvp-prediction-and-load-optimization-handoff`  
**Scope:** Eliminate ~2 MB Rapier 3D WASM boot block, slash cold-boot assets from ~10.5 MB (incl. 54 eager WAVs + all 8 staffs) to <1.5 MB, purge 9.30 MB of unused GLBs and compress 47 MB `public/assets/` → ~13–16 MB, implement guest client-side movement prediction (cutting 230–290 ms self-lag to 0 ms local feel), wire the dead `rejoin` handler, eliminate the 2nd title-screen WebGL context, and close PvP & Gauntlet anti-cheat gaps.

---

## 0. Hard Invariants (`AGENTS.md` & CI)

- `src/sim-core/` (~9,693 LOC, Q16 fixed-point 60 Hz deterministic sim) is compiled into `dist/duel-sim.server.js` (ES5 for Nakama Goja) by `scripts/build-server-sim.mjs` and checked by `scripts/check-server-bundle.mjs` + 26 golden replays (`tests/golden/*.json`) across Node VM, Chromium Playwright, and Goja (`tools/goja-replay/`).
- **Do NOT alter `src/sim-core/` gameplay behavior** for load-time or rendering fixes so all 26 golden replays and `DUEL_SIM_VERSION` remain identical (only update `dist/duel-sim.server.js` if explicitly touching `sim-core`).
- Never push directly to `main`; open a PR after running all checks.

---

## 1. P0 — Boot & Asset Load-Time Overhaul (~10.5 MB → <1.5 MB Boot; 47 MB → ~13–16 MB `public/assets/`)

### 1.1 Remove `@dimforge/rapier3d-compat` (~2 MB Inlined WASM) From Boot & Runtime
- **Files:** `src/core/Game.ts:246`, `src/camera/CameraRig.ts:110-132`, `src/player/PlayerController.ts`, `src/physics/`, `src/sim-core/arena.ts`, `vite.config.ts:90-99`, `package.json`
- **Current Problem:** Every real match already runs on `src/sim-core/arena.ts`'s pure-TS analytical collision engine (`Game.useSim = true`). Yet `Game.create()` (`src/core/Game.ts:246`) still blocks boot on `RAPIER.init()` (~2 MB WASM chunk) and steps `physics.step()` every frame solely for 3 camera `sphereCast` calls (`CameraRig.ts:110-132`), crosshair raycasting (`PlayerController.ts`), and menu attract mode.
- **Exact Changes:**
  1. Expose/use `src/sim-core/arena.ts`'s analytical sphere-sweep and raycast helpers (against arena boundary wall, cylindrical pillars, and axis-aligned obstacles) inside `CameraRig.ts:110-132` and `PlayerController.ts`.
  2. Switch title-screen attract mode (AI vs AI duel) to run on `SimDriver` (matching real matches), allowing legacy Rapier-backed `Wizard`/`SpellSystem`/`AIController` code paths to be removed from the production client bundle.
  3. Remove `@dimforge/rapier3d-compat` from `package.json`, `Game.create()`, and `vite.config.ts:90-99`.
- **Impact:** Removes **~2 MB WASM** download + compilation from boot and drops per-frame `physics.step()` CPU overhead.

### 1.2 Stop Blocking Boot on 7 Unequipped Staffs & Fix 54-Request Eager WAV Audio Storm
- **Files:** `src/assets/AssetLoader.ts:122-135`, `src/audio/AudioManager.ts:108-115`, `src/main.ts:16-62`, `public/audio/placeholder/*`
- **Current Problem:**
  1. `AssetLoader.loadAll()` (`AssetLoader.ts:122-135`) blocks initial screen render on **5.20 MB** (11 files), including **all 8 `-lod1.glb` staffs (3.97 MB)** even though the player spawns with only 1 staff equipped, plus `textures/golden_ticket.png` (**914 KB** PNG).
  2. `new AudioManager()` (`AudioManager.ts:108-115`) instantiates **54 `Howl({ preload: true })` objects** immediately on title screen init, firing **54 concurrent HTTP requests (3.30 MB of uncompressed PCM `.wav` files, incl. `musicBattle.wav` 700 KB & `musicMenu.wav` 689 KB)**.
  3. `src/main.ts:60` blindly calls `game.assets.prefetchBosses()` 1.5 s after boot, downloading **all 18 rigged boss GLBs (5.70 MB)** even if the player only wants Online PvP!
- **Exact Changes:**
  1. In `AssetLoader.loadAll()`, load **only the currently equipped staff** (`getLoadout().staff`) + `rigged/wizard_player.glb` + `pickups/life_pack.glb` + WebP `golden_ticket` (**-3.5+ MB** off boot critical path). Lazy-load other staffs on Staff Rack open or when an opponent equips one in a match.
  2. Transcode all 54 `public/audio/placeholder/*.wav` files to **Opus/OGG + MP3/M4A** (3.30 MB WAV → **~400–600 KB**, ~85% reduction), and change `AudioManager.ts:113` to **tiered lazy loading**: preload only menu UI SFX + `musicMenu` at boot, and load combat SFX + `musicBattle` on match start.
  3. Change `src/main.ts:60` background prefetch to prefetch **only** the next boss in `campaign.saved.next` (and only when hovering/entering Boss Gauntlet, never during Online PvP).

### 1.3 Purge 9.30 MB of Dead GLBs & Convert Oversized PNG/JPG/Staff Textures to WebP
- **Files:** `public/assets/models/staffs/*`, `public/assets/models/bosses/*`, `public/assets/models/wizard_player.glb`, `public/assets/textures/golden_ticket.png`, `public/assets/ui/bosses/*`, `public/assets/textures/themes/*`, `src/assets/AssetLoader.ts:91`
- **Current Problem:** `public/assets/` (47 MB) contains **9.30 MB of dead/unreachable GLBs**:
  - **6 non-LOD1 staff GLBs (6.22 MB**, up to 1.83 MB `staff_alien_ray.glb`) — `staffModelPath()` (`src/staff/catalog.ts:110`) ONLY ever loads `*-lod1.glb`!
  - **19 static fallback boss/player GLBs (3.08 MB)** — `selectModelSpec()` (`AssetLoader.ts:91`) always picks the rigged GLB in `models/rigged/` whenever present in `virtual:asset-index`!
  - Plus huge PNG/JPG textures: `textures/themes/*.jpg` (**12.28 MB**, 2048×2048 floors up to 1.64 MB), `ui/bosses/*.png` (**6.86 MB**, 18 × 512×512 PNGs), `textures/golden_ticket.png` (**914 KB**), and 3 `-lod1.glb` staffs (`shooter`, `fighter`, `alien_ray`, 2.85 MB combined with embedded JPEGs).
- **Exact Changes:**
  1. Remove the 6 unused non-LOD1 staff GLBs (6.22 MB) and 19 unreachable static boss/player GLBs (3.08 MB) from `public/assets/` (archive source meshes outside `public/` if needed for authoring; update `ASSETS.md` & `npm run check:assets`).
  2. Convert `textures/golden_ticket.png` → WebP (914 KB → ~40 KB), `ui/bosses/*.png` → WebP (6.86 MB → ~0.7–1.0 MB), and `textures/themes/*.jpg` → WebP capped at 1024×1024 (12.28 MB → ~3–4 MB).
  3. Re-pack the 3 largest `-lod1.glb` staffs (`shooter`, `fighter`, `alien_ray`) with `gltf-transform` `EXT_texture_webp` + resized textures (2.85 MB → ~0.8 MB).
  4. *(Shared CDN opportunity)*: Once `metaverse-hub` exposes `https://play.<domain>/shared-assets/sproto/`, point shared Sproto stage & character assets there so players hopping between `sproto-duel` and `sproto-shooter` reuse browser cache.

---

## 2. P1 — Online PvP Feel (Guest Prediction + Reconnect) & Anti-Cheat Hardening

### 2.1 Implement Guest Client-Side Movement Prediction & Reconciliation
- **Files:** `src/net/OnlineController.ts:98-111, 136-178`, `src/net/SnapshotBuffer.ts`, `src/sim-core/`
- **Current Problem:** In Online PvP (`role = 'replica'`), the guest runs **zero simulation** and interpolates **both** wizards (including its own avatar!) `interpDelayMs = 100 ms` behind host time. Combined with input batching (16.7 ms), `RTT/2`, `RemoteInputBuffer` cushion (33.3 ms), snapshot interval (16.7 ms), and `RTT/2`, the guest suffers **`RTT + 167 ms+` (~230–290 ms on a 60 ms link)** of self-movement lag while the host has **0 ms** lag!
- **Exact Changes:**
  1. Leverage the already-existing `Snapshot.ack` and `CONFIG.net.maxPredictionReplay = 30` scaffolding:
     - Maintain a ring buffer of unacknowledged local guest inputs (`inputHistory[]`, keyed by `seq`/tick).
     - Step a lightweight local `SimWorld` movement predictor for the guest's **own seat** every 60 Hz tick so local movement/aim/dash responds at **0 ms** latency.
     - Keep `SnapshotBuffer` interpolation (`interpDelayMs = 100 ms`) strictly for the **remote (host) wizard** and host-owned projectiles/pillars.
     - On each incoming `OP.SNAPSHOT`, reconcile the guest's predicted state against authoritative `snapshot.wizards[guestSeat]` at `snapshot.ack`, replaying buffered inputs `seq > snapshot.ack` up to current local tick; smoothly decay small visual error (e.g., `tau = 80–100 ms`) and snap past a threshold (e.g., `2.0 m`).
  2. Add deterministic reconciliation unit tests in `tests/` verifying zero drift under 0 ms, 60 ms, and 150 ms simulated RTT + 5% packet loss.

### 2.2 Wire the Dead `OnlineSession` `'rejoin'` Handler & Fix `SnapshotBuffer` Clock Recovery
- **Files:** `src/net/OnlineSession.ts:244, 276`, `src/net/OnlineController.ts`, `src/net/SnapshotBuffer.ts`
- **Current Problem:** `OnlineSession` emits `'rejoin'` when `HubRealtime` reconnects within the 10 s grace window, **but zero listeners subscribe to `'rejoin'` anywhere in `src/`**. A re-sent `OP.START` is ignored while `state === 'playing'` (`OnlineSession.ts:276`), and `SnapshotBuffer`'s clock offset eases upward at only `0.002` (0.2%/ms — taking ~50 s to absorb a +100 ms latency shift after reconnect!).
- **Exact Changes:**
  1. Subscribe to `session.on('rejoin', ...)` in `OnlineController` to:
     - Reset `SnapshotBuffer` clock offset immediately so the next snapshot snaps the playout clock cleanly.
     - Clear stuck input buttons/prediction queue and allow re-syncing from the next authoritative `OP.SNAPSHOT` (and handle re-sent `OP.START` cleanly if seat state changed).
  2. Increase `SnapshotBuffer` clock-offset convergence after a gap/rejoin (or snap on >250 ms jump).
  3. Add a Vitest reconnect test using `FakeArenaServer` simulating a 3 s guest drop and recovery.

### 2.3 Close PvP & Gauntlet Anti-Cheat / Trust-Boundary Gaps
- **Files:** `src/hub/report.ts:15, 61-78`, `src/net/OnlineController.ts`, `src/net/protocol.ts` (coordinated with `metaverse-hub/server/modules/src/games/sproto_arena.ts`)
- **Current Problem:**
  1. **Host-only `OP.LOG` upload:** Only the host records and submits `OP.LOG`, so a cheating host can fabricate guest inputs inside `OP.LOG` to pass `DuelSim.replay()`.
  2. **God-mode boss events still posted:** `planDuelWin()` (`src/hub/report.ts:61-70`) skips the leaderboard when `godMode` is true, **but still posts `sproto.boss_defeated`**.
  3. **Client-chosen gauntlet seeds & unverified `sproto_wins`:** Single-player boss seeds are generated client-side, and `sproto_wins` submits `{ matchId, boss }` without replay proof.
  4. **Goja replay timeout (`docs/SERVER-SIM.md:303-321`):** `DuelSim.replay()` takes 1.5–55 s in Goja vs 25–400 ms in Node/V8.
- **Exact Changes:**
  1. In `src/hub/report.ts:61`, do **not** emit `sproto.boss_defeated` when `win.godMode === true` (or any god toggle was used during the fight).
  2. In `OnlineController`, have the guest also compute a rolling SHA-256 / FNV digest of its transmitted `OP.INPUT` frames (and submit it in `OP.RESULT` / let `sproto_arena` hash relayed guest `OP.INPUT` frames server-side) so the verifier confirms `OP.LOG.inputs[guestSeat]` matches what the guest actually sent.
  3. Coordinate with `metaverse-hub` to run `dist/duel-sim.server.js` in the shared Node/V8 `services/replay-verifier` worker pool (25–400 ms) and accept server-issued challenge seeds on gauntlet start.

---

## 3. P2 — Rendering, Bundle & UX Polish

1. **Eliminate 2nd WebGL Context (`src/ui/TitleStaffPreview.ts:84`):** Render the title staff/character preview inside the primary `Renderer` (viewport/scissor pass or offscreen render target copied to a 2D canvas) instead of creating a 2nd `THREE.WebGLRenderer({ preserveDrawingBuffer: true })`.
2. **Lazy-Load Hub Feedback (`src/main.ts:10`, `src/hub/feedback.ts`):** Dynamically `import('./hub/feedback.ts')` only when triggered (`N-N` or Pause menu) or on `requestIdleCallback` after first paint — removes `hub-sdk`'s 93 KB `feedback.js` + `modern-screenshot.js` from the initial boot bundle.
3. **Account-Scope Staff & Skin Selection (`src/staff/loadout.ts`, `src/campaign/skins.ts`):** Scope `arcane-duel-loadout` and `arcane-duel-skin` by `playerId` (or fold into `CampaignProgress` cloud save) so switching hub accounts on a shared browser doesn't leak cosmetics.
4. **Non-Blocking Fonts (`index.html:12`):** Self-host WOFF2 subsets of `Cinzel` and `Rajdhani` or load Google Fonts non-blocking (`media="print" onload="this.media='all'"`).

---

## 4. Verification Checklist

Run before opening PR (from `AGENTS.md`):
```bash
npm run typecheck
npm test
npm run build
npm run check:assets
```
Verify explicitly:
- All 26 golden replays (`tests/golden/*.json`) pass across Node VM, Playwright, and Goja (`scripts/check-server-bundle.mjs`).
- Measure cold boot network transfer: confirm **<1.5 MB** before menu interactive (0 Rapier WASM, 1 equipped staff, 0 eager combat WAVs) and `public/assets/` **≤16 MB** (down from 47 MB).
- Confirm guest PvP movement prediction + `'rejoin'` resync tests pass under simulated 100 ms RTT and packet drop.
