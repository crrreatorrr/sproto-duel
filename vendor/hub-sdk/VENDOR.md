# Vendored @metaverse/hub-sdk

- repo: https://github.com/crrreatorrr/metaverse-hub
- branch: claude/festive-ptolemy-4mg8oe
- sha: b9ac308
- package: packages/hub-sdk @ 0.7.0
- built with: `node scripts/vendor-sdk.mjs`
- iife: dist/hub-sdk.iife.js (global HubSDK; classic script, not a CDN import)
- iife sha256: 092603b61a3511fbbcaa3b674b16f02b24d581752e1fa1dc69eeb577bc5ae5e8
- source src/createHubSdk.ts: 4ae184ef8b4a6e97192769a4118ea855fcd4463176ee7bac295a884e449ebcdf
- source src/env.ts: c3a8eb38ea73539fa4d971da705e004355bed8258079a73a2ecbda912c35ef46
- source src/errors.ts: 4eaba836a4dfad994b3926d90b66a158c4384ce6f100bf8a0791877c0646b541
- source src/events.ts: 584d264acb48d7e63746bc63b56767577dd4370a0b5fbdf4ddd73fc0fd2b9f64
- source src/feedback.ts: f3670ed8604dd94df22260e54cde3802fb9310f96504f4e031ee9944f052f4ca
- source src/index.ts: 4f1d93041a8b2fb275e4a25761a2c4ed465e88ac4692c2fc856c704b3cd90767
- source src/live.ts: 1ceddf637cccbb7c346509a9c17b4e29db75097bb1d07ff5c9a27ade5410624c
- source src/nakama.ts: 67a701b47178244f1a63b433f8d715aea824b1599a49f140b35b401950ee266a
- source src/pbShop.ts: 3bbeff5bcf3b6e2c724409eadce9907432e1e52b02988938ff5e6f2ebdfe0faf
- source src/realtime/chatRules.ts: 26913facb5c4c28c0a3529a4ecb6a3a50fadfe067736c74fb571184a9aa81b0e
- source src/realtime/client.ts: 09b799cc261ae06eb36a3141722e7752b603c58eac66fdb2b2a4f88f4ae08b79
- source src/realtime/friends.ts: d2b309fca509ab6e46def7d4be20e470d7d932f6eacef63287ce7697225f86ef
- source src/realtime/mock.ts: e476f22d8c78c0b1e0dc5cb0e7fc553bfd3534dd22d45920aeb903c8dfa049a7
- source src/realtime/protocol.ts: 9f25c52103c82110eb518043395fed92a71f5c713f70c6e7369072ce988ea14e
- source src/realtime/types.ts: dc8a6a5f62c5e0f2874819a79dd473b5b41b3cbdb29aad8bfd2a0fc4687734cf
- source src/save.ts: 098fb0a6834e43bdad620c2729b0abf28a9551b8c4ab8cc7cb3428ebba8aea98
- source src/storage.ts: 7a1f52e2f432026590ed99e85c318ea21ef10c6fe83b9e0c1ebe8c173ced5344
- source src/ticket.ts: b01e1635c7031dd0e6855ecb22b99af1654395c41f0296863b627a31ded41033
- source src/types.ts: ab27892b60750a4dc4ea50c2aec33e17034f4d2d91f774d038cc0501675e2a5c

Layout: `package.json`, `README.md`, `SOURCE.pin.json`, `dist/*.js`, `dist/*.d.ts`, including `dist/hub-sdk.iife.js` (global `HubSDK`). No source maps are included, and `sourceMappingURL` lines are stripped.

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

0.6.0 adds the `sproto-arcade` game, its Relic `breakwater_coin` and the optional `loadSave` / `writeSave`.

0.6.3 (hub main `5cc4e48`, PR #90) is a fix release. No method or type changes. The classic-script
build is `dist/hub-sdk.iife.js`; its sha256 and the source hashes are in the header above and in
`SOURCE.pin.json`.

0.6.4 (hub main `2a82e9e`, PR #117) adds Relics `marina_anchor` (Sproto Coop Battle,
`coop.stage_clear` with stage 1) and `dragon_scale` (Sproto Shooter, `shooter.wave_clear` with
wave 1). No method changes. Sproto Duel does not grant either Relic. The classic-script build is
`dist/hub-sdk.iife.js`; its sha256 and the source hashes are in the header above and in
`SOURCE.pin.json`.

0.7.0 adds in-game feedback: `installFeedback` (the N-N window), `feedbackTransportFromSdk` and the
optional `feedbackAccess` / `submitFeedback`. This copy was vendored from hub branch
`claude/festive-ptolemy-4mg8oe` at `b9ac308`, which is **not merged to hub main yet**; re-vendor
from main once it lands. Sproto Duel's adapter is `src/hub/feedback.ts`.

Re-sync this tree to hub main whenever packages/hub-sdk changes:
`node /path/to/metaverse-hub/scripts/vendor-sdk.mjs /path/to/sproto-duel --branch main`, then
`npm install`.
