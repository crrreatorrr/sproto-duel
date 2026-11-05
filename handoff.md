# Handoff: Sproto Duel PvP (Local Versus + Online Duel)

Only the steps that need you. Everything else (code, tests, docs) is done on the branches.

## 1. Merge and deploy, in this order

The server migrations must land in id order (hub `0011`–`0012`, People's Bitcoin `0013`–`0019`,
Sproto `0020`), because the hub refuses to apply an id below the highest one already recorded.

1. Merge the hub PRs in this order: hub realtime (`claude/realtime-hub` / `contract/hub-v1`), then
   People's Bitcoin's hub branch (`claude/pb-world`) if it ships now, then `claude/sproto-arena`.
   - `claude/sproto-arena` also touches two lines of the hub-owned `server/test/unit/scaffold.test.ts`
     (its "no sproto yet" assertions follow the registry now, and its fake migration ids moved to
     0089/0090). If the hub branch changed those lines too, keep both intents.
   - If People's Bitcoin's migrations ship **after** 0020 is deployed, renumber them above 0020 first.
2. Rebuild Nakama on the VPS (the module is baked into the image):
   ```bash
   cd /opt/metaverse && git pull
   deploy/scripts/bootstrap.sh
   ```
   Check the boot log for the migration and the new match:
   ```bash
   docker compose --project-directory /opt/metaverse/deploy --env-file /opt/metaverse/deploy/.env \
     -f /opt/metaverse/deploy/compose.yml logs nakama | grep -E '0020_sproto_pvp|sproto_arena|Registered'
   ```
3. Merge the sproto-duel PR, build and deploy the game (Online Duel is on the main menu, stake 0 T):
   ```bash
   cd sproto-duel && npm ci
   VITE_NAKAMA_URL=https://<domain> VITE_NAKAMA_SERVER_KEY=<server key> VITE_HUB_URL=https://<domain>/hub npm run build
   # from the hub repo, on the build machine:
   deploy/scripts/check-dist-secrets.sh ../sproto-duel/dist
   rsync -a ../sproto-duel/dist/ <vps>:/tmp/sproto-duel/
   ssh <vps> /opt/metaverse/deploy/scripts/deploy-game.sh sproto-duel /tmp/sproto-duel
   ```

## 2. Playtest Local Versus (real screen, real controllers)

1. Open `https://play.<domain>/sproto-duel/` (or `npm run dev` locally) on a laptop with two
   controllers, or one controller plus keyboard and mouse.
2. Main menu → Local Versus → press A on the controller for Player 2 → Fight.
3. Check: each half follows its own wizard, both crosshairs aim, Start pauses from either pad,
   the results say "Player 1 wins" / "Player 2 wins", and no Tickets toast appears.
4. Check the frame rate on a laptop GPU. If it stutters, try Settings → Bloom off and Shadows off,
   then tell an agent which one fixed it (the split-screen defaults live in `CONFIG.versus`).

## 3. Two-machine online playtest

Online Duel is on the main menu. The stake is 0 Tickets (no wager, no Ticket mint from the client).

1. Build a test copy and deploy it next to the live one (or locally with
   `npm run dev -- --host` on one machine):
   ```bash
   VITE_NAKAMA_URL=https://<domain> VITE_NAKAMA_SERVER_KEY=<server key> VITE_HUB_URL=https://<domain>/hub npm run build
   ```
2. Two people on **different networks** (for example home Wi-Fi and a phone hotspot). A portal
   visit and a direct visit can both play, including a hub guest. There is no qualifying step.
   The stake stays 0 Tickets. A direct visit needs the hub RPC `sproto.standalone_session`.
3. Both: Online Duel → Quick Match. Play a full best of three. Then try Create Room on one machine
   and Join Room with the code on the other.
4. Check: the ping chip shows a sane number, movement and spells feel responsive for both
   players (the one who is not hosting sees everything about 100 ms late, by design in v1), the
   result says "0 Tickets" after "Confirming…", and pulling one player's network cable for
   under 10 s resumes the match while longer gives the other player a forfeit win.
5. Tuning, if it feels off: `CONFIG.net.interpDelayMs` (100; lower = snappier but jerkier for the
   guest) and `CONFIG.net.inputDelayTicks` (2; higher = smoother for the host's view of the guest).
6. When it plays well, ship the production build from step 1 and deploy it as in section 1.3.

## 4. Not needed now

- No TURN server or new accounts: v1 runs over the existing Nakama WebSocket (`/ws`, already
  proxied by Caddy). TURN (coturn or a managed one, UDP 3478 plus the relay range, and
  `VITE_ICE_SERVERS`) is only needed if the WebRTC stretch goal is ever built.
