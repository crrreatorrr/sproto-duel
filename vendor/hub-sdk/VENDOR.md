# Vendor

Source this directory is meant to track:

- repo: https://github.com/crrreatorrr/metaverse-hub
- directory: `packages/hub-sdk`
- branch: `cursor/ticket-redeem-custom-auth-c054`
- sha: `947ed4c` (hub pull request #25)

This environment's GitHub App can only read `crrreatorrr/sproto-duel`, so a pack of `947ed4c` could not be fetched. The tree started from `@metaverse/hub-sdk` 0.1.0 packed from metaverse-hub `26903a4`, then the portal redeem was switched to Nakama custom authentication and every later call was limited to the session token from that redeem. Dev credential fallbacks were removed. Source maps were deleted so they cannot keep the old strings.

Do not merge until hub #25 has merged. If that merge commit is not `947ed4c`, replace this directory with a fresh pack of hub main and update the sha above.

## Local patch: `tidebreaker_belt`

The hub's fifth game, Sproto Fighter, added the Relic `tidebreaker_belt` (hub
`packages/hub-sdk/src/types.ts`, `RELIC_IDS`). This vendored build filters every relic list it
returns (`init` against Nakama in `live.js` `asRelics`, the mock `hub:relics` in
`createHubSdk.js` `readRelics`, and event grants) through `isRelicId`, which checks a fixed
`RELIC_IDS` array. Without the id there, `init` silently dropped the Belt and Fighter's Might
(`duel_staff_fighters_might`) could never unlock.

The only change: `'tidebreaker_belt'` appended to `RELIC_IDS` in `dist/types.js` and
`dist/types.d.ts`. `GAME_IDS`, `RELIC_BY_GAME`, redeem and every call are untouched. Do not swap in
a newer hub pack to get this: newer builds need the game to pass a Nakama server key, and redeem
would break. When this directory is next replaced with a fresh pack, check its `RELIC_IDS`
already lists `tidebreaker_belt` and drop this note.
