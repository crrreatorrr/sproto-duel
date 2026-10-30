# Vendor

Source this directory is meant to track:

- repo: https://github.com/crrreatorrr/metaverse-hub
- directory: `packages/hub-sdk`
- branch: `cursor/ticket-redeem-custom-auth-c054`
- sha: `947ed4c` (hub pull request #25)

This environment's GitHub App can only read `crrreatorrr/sproto-duel`, so a pack of `947ed4c` could not be fetched. The tree started from `@metaverse/hub-sdk` 0.1.0 packed from metaverse-hub `26903a4`, then the portal redeem was switched to Nakama custom authentication and every later call was limited to the session token from that redeem. Dev credential fallbacks were removed. Source maps were deleted so they cannot keep the old strings.

Do not merge until hub #25 has merged. If that merge commit is not `947ed4c`, replace this directory with a fresh pack of hub main and update the sha above.
