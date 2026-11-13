# Vendored @metaverse/hub-sdk

- repo: https://github.com/crrreatorrr/metaverse-hub
- branch: claude/account-progress
- sha: dbbf398
- package: packages/hub-sdk @ 0.8.0
- built with: `node scripts/vendor-sdk.mjs`
- iife: dist/hub-sdk.iife.js (global HubSDK; classic script, not a CDN import)
- iife sha256: b65b550cf9921dab8a272685a5d610c0a1b3f298cba9519b20308e545a542a1d
- source src/createHubSdk.ts: 4ae184ef8b4a6e97192769a4118ea855fcd4463176ee7bac295a884e449ebcdf
- source src/env.ts: c3a8eb38ea73539fa4d971da705e004355bed8258079a73a2ecbda912c35ef46
- source src/errors.ts: 4eaba836a4dfad994b3926d90b66a158c4384ce6f100bf8a0791877c0646b541
- source src/events.ts: 584d264acb48d7e63746bc63b56767577dd4370a0b5fbdf4ddd73fc0fd2b9f64
- source src/feedback.ts: 3ee200cafc7d07ca4b0c995a56a0d3ef5a6046e262fc62c7aef0bb903e83cf67
- source src/index.ts: b7db97e20962db7bdfc123f539af28a47e109062cf5ed74a374e09ef4b3cd457
- source src/live.ts: 9272fe0acd8c0b8171028f163df42f7e9545408d28194da7de19e037f0417527
- source src/nakama.ts: 67a701b47178244f1a63b433f8d715aea824b1599a49f140b35b401950ee266a
- source src/pageShot.ts: 8e562aa07991d5b716d9f83aa2f659dbd43782b5b6e063d411895f52dfc84af9
- source src/pbShop.ts: 3bbeff5bcf3b6e2c724409eadce9907432e1e52b02988938ff5e6f2ebdfe0faf
- source src/progress.ts: f091cbd4d2dc7326e1da99a3198a681fe6fac7a6015f4b65d6919ee1a31f4b95
- source src/realtime/chatRules.ts: 26913facb5c4c28c0a3529a4ecb6a3a50fadfe067736c74fb571184a9aa81b0e
- source src/realtime/client.ts: 09b799cc261ae06eb36a3141722e7752b603c58eac66fdb2b2a4f88f4ae08b79
- source src/realtime/friends.ts: d2b309fca509ab6e46def7d4be20e470d7d932f6eacef63287ce7697225f86ef
- source src/realtime/mock.ts: e476f22d8c78c0b1e0dc5cb0e7fc553bfd3534dd22d45920aeb903c8dfa049a7
- source src/realtime/protocol.ts: 9f25c52103c82110eb518043395fed92a71f5c713f70c6e7369072ce988ea14e
- source src/realtime/types.ts: dc8a6a5f62c5e0f2874819a79dd473b5b41b3cbdb29aad8bfd2a0fc4687734cf
- source src/save.ts: 098fb0a6834e43bdad620c2729b0abf28a9551b8c4ab8cc7cb3428ebba8aea98
- source src/storage.ts: 7a1f52e2f432026590ed99e85c318ea21ef10c6fe83b9e0c1ebe8c173ced5344
- source src/third_party/modern-screenshot.d.ts: 22372ef230b98655ee2597c8c741d75e397405f22dbb5c2f45521e6fe9950056
- source src/third_party/modern-screenshot.js: c1d44ba7cf8a296754c7013a12c79266235550b0564d17487a76e006f8472721
- source src/ticket.ts: b01e1635c7031dd0e6855ecb22b99af1654395c41f0296863b627a31ded41033
- source src/types.ts: 90b551a3fe2b4e85f81b82bc7c9c1909654715f2a45a85cb7d683f6f05d309ab

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
optional `feedbackAccess` / `submitFeedback`. Sproto Duel's adapter is `src/hub/feedback.ts`.

0.7.1 (hub main `e19c27a`, PR #179) adds one optional field: the live `reportEvent` returns
`tickets`, the Tickets the server credited for that event (20 for a story boss, once per boss per
UTC day), absent when the event paid nothing. Sproto Duel shows it on the story boss win screen
(`src/hub/report.ts`). This copy is from hub main, which also replaces the earlier unmerged 0.7.0
copy from branch `claude/festive-ptolemy-4mg8oe`.

0.7.2 makes the N-N feedback screenshot show the whole page. 0.7.1 copied only canvases, so the
main menu (HTML in `#ui`) came out as the arena behind it. The SDK now draws the page's HTML over
the canvases itself with modern-screenshot (MIT, `dist/third_party/modern-screenshot.js`, loaded on
demand). Sproto Duel needs no adapter code for it. Two changes here help it:
`index.html` loads Google Fonts with `crossorigin="anonymous"` so the fonts can be embedded, and the
title turntable keeps its drawing buffer (`src/ui/TitleStaffPreview.ts`) so it is not blank in the
screenshot. This copy is from hub main `c6627e5` (PR #183, merge `bb0017c`). The SDK
sources match the earlier pin at `5099cb5`; later hub commits did not change the package.

0.8.0 adds `createProgressStore` and `hubVisitStarting` (progress per hub account) and raises the
cloud save limit to 16384 bytes. Sproto Duel keeps the gauntlet's earned progress in one store
(`src/campaign/progress.ts`, used by `Campaign`). **This copy is from the unmerged hub branch
`claude/account-progress` (`dbbf398`). Re-vendor from hub main after that hub PR merges, and before
the Sproto Duel PR merges.**

Re-sync this tree to hub main whenever packages/hub-sdk changes:
`node /path/to/metaverse-hub/scripts/vendor-sdk.mjs /path/to/sproto-duel --branch main`, then
`npm install`.
