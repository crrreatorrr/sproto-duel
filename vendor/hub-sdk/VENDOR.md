# Vendored @metaverse/hub-sdk

- repo: https://github.com/crrreatorrr/metaverse-hub
- branch: claude/loving-galileo-ndy2tu
- sha: 441b7c4
- package: packages/hub-sdk @ 0.5.0
- built with: `node scripts/vendor-sdk.mjs`

Layout: `package.json`, `README.md`, `dist/*.js`, `dist/*.d.ts`. No source maps are included, and `sourceMappingURL` lines are stripped.

Ticket redeem is `authenticateCustom` (`t:` + ticket, create=false) with the Nakama server key as Basic auth, then `profile.get`. Later calls send only the session token.

The previous vendor tracked hub #25 at 947ed4c, which redeemed without the server key. The merged hub server requires it, so every redeem failed and the game ran with no hub session.

Re-sync this tree to hub main whenever packages/hub-sdk changes.
