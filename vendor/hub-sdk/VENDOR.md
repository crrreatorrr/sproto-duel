# Vendored @metaverse/hub-sdk

- repo: https://github.com/crrreatorrr/metaverse-hub
- branch: claude/loving-galileo-ndy2tu
- sha: 36e4eb2
- package: packages/hub-sdk @ 0.5.0
- built with: `node scripts/vendor-sdk.mjs`

Layout: `package.json`, `README.md`, `dist/*.js`, `dist/*.d.ts`. No source maps are included, and `sourceMappingURL` lines are stripped.

Ticket redeem is `authenticateCustom` (`t:` + ticket, create=false) with the Nakama server key as Basic auth, then `profile.get`. Later calls send only the session token.

The previous vendor tracked hub #25 at 947ed4c, which redeemed without the server key. The merged hub server requires it, so every redeem failed and the game ran with no hub session.

0.5.0 adds the realtime client (`createRealtime`, `realtimeFromSdk`), its mock server
(`createMockRealtimeServer`, used by `src/net/hubLobby.test.ts`) and the optional
`getSession` / `refreshSession` / `getLeaderboard`. Sproto Duel uses `realtimeFromSdk` for Online
Duel only, through `HubLobby` (`src/net/HubLobby.ts`): matchmaker quick match with
`{game: "sproto", v}` and the `sproto.room_create` / `sproto.room_join` RPCs served by the hub's
`sproto_arena` match. `submitScore` no longer skips unranked sessions (the server decides), and the
server refuses `sproto_wins` from clients (`server_board`); the game still sends it for Quick Duel
and gauntlet wins, which is harmless.

This vendor is from the hub's realtime branch before it merged to main (the online code needs
it). After the hub PR merges, re-vendor from main with
`node /path/to/metaverse-hub/scripts/vendor-sdk.mjs /path/to/sproto-duel --branch main`, then
`npm install`.

Re-sync this tree to hub main whenever packages/hub-sdk changes.
