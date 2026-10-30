# @metaverse/hub-sdk

Client for a game page that was opened from the hub. The hub puts a short-lived signed ticket in the URL fragment (`#t=`). `init` strips that fragment and redeems the ticket with Nakama custom authentication (`t:` + ticket, `create=false`, `vars.game`). Later calls send only the session token from that redeem. With no ticket and no saved session, every method no-ops, so the game still runs on its own.

Version 0.1.0 is the surface Sproto Duel should build against. Method names, argument order, game ids, relic ids, and event ids below stay stable.

## Install

The package lives in this monorepo, so install the packed tarball rather than the git repo root.

```bash
git clone --depth 1 https://github.com/crrreatorrr/metaverse-hub.git
cd metaverse-hub
npm ci
npm pack -w @metaverse/hub-sdk
```

That writes `metaverse-hub-sdk-0.1.0.tgz` in the repo root. In the game:

```bash
npm install /absolute/path/to/metaverse-hub-sdk-0.1.0.tgz
```

A folder install also works after `npm ci` in the hub repo:

```bash
npm install /absolute/path/to/metaverse-hub/packages/hub-sdk
```

## Wire it into a Three.js + Vite game

Load the SDK from the game's own page. There is no iframe and no `postMessage`. Point Vite at Nakama so the page can call `/v2` on its own origin:

```ts
// vite.config.ts
export default defineConfig({
  base: './',
  server: {
    proxy: {
      '/v2': { target: 'http://127.0.0.1:7350', changeOrigin: true },
      '/ws': { target: 'http://127.0.0.1:7350', ws: true, changeOrigin: true },
    },
  },
});
```

A game on another port can instead set `serverUrl` to `http://127.0.0.1:8080`, where the hub's Caddy adds CORS. Same-origin proxy is the one this repo uses.

```ts
import { HubEvent, createHubSdk, installHubSdk } from '@metaverse/hub-sdk';

const hub = installHubSdk(createHubSdk({
  serverUrl: '', // same origin; the Vite proxy forwards /v2
  hubUrl: 'http://127.0.0.1:5173/hub/',
}));

const profile = await hub.init('sproto');
// profile.playerId, profile.ranked, profile.relics, profile.effects, profile.ticketsCapLeft
```

`installHubSdk` also sets `window.hubSdk` for HPOS10I's JavaScriptBridge. Call `init` once at boot, before play starts. A reload keeps the session in `sessionStorage` under `hub:<game>:session`, so a ticket is not required twice. `init` removes `#t=` with `history.replaceState`.

When Tinubu falls, including a god-mode win, report it and do not send a score in god mode:

```ts
const outcome = await hub.reportEvent(
  HubEvent.SprotoBossDefeated,
  { boss: 'tinubu', elapsed, godMode },
  `sproto:tinubu:${profile.playerId}`,
);
// outcome.granted === 'tinubu_crown' the first time only

if (!godMode && profile.ranked) {
  await hub.submitScore('sproto_wins', 1);
}

hub.exit('match_end'); // releases pointer lock and goes to /hub/#from=sproto
```

Against Nakama, earn, relic events, and exchange are written to IndexedDB (`hub-outbox`, store `writes`) before they are sent. The record keeps the `key` you passed, plus the body, RPC name, session token, and game id. That key is not replaced on a retry. The call rejects if the response is lost, and the record stays queued. It is deleted only after the RPC resolves. `init` drains every queued record, including in a tab with no saved session, using the stored token and key. Nakama returns the stored result when that same key and body are repeated.

A different operation id is a new request. The relic itself is still earn-once: the server's primary key is `(player, relic)`, so a second boss event cannot grant Tinubu's Crown again.

`earnTickets` records Tickets on the server. `exchange` turns Tickets into Verse at 10 to 1, at most 50 Verse per game per day, and returns a `receiptId`. God-mode wins should still call `earnTickets` and should skip `submitScore`. `submitScore` is accepted and stored nowhere yet.

## API

```ts
init(gameId): Promise<{
  playerId: string;
  ranked: boolean;
  relics: RelicId[];
  effects: Record<string, number | boolean | string>;
  ticketsCapLeft: number;
}>

reportEvent(eventId: string, data: object, key: string): Promise<{ granted?: RelicId }>
submitScore(boardId: string, value: number, meta?: object): Promise<void>
earnTickets(amount: number, reason: string, key: string): Promise<{ balance: number; capped: boolean }>
exchange(tickets: number, key: string): Promise<{ verse: number; ticketsLeft: number; receiptId: string }>
exit(reason?: string): void
```

Game ids: `hpos10i`, `nobu`, `pb`, `sproto`.

| Event | Grants |
| --- | --- |
| `ready` | nothing |
| `game_beaten` | that game's relic, once |
| `hpos10i.level_complete` with zone `z1_retro_rush_hills` and act `1` | `hpos10i_core` |
| `pb.quest_complete` with quest `quest_tutorial` | `genesis_shard` |
| `nobu.boss_defeated` with boss `cone` | `cones_tip` |
| `sproto.boss_defeated` with boss `tinubu` | `tinubu_crown` |

God-mode flags inside `data` do not block a grant. The hub lights Tinubu's Crown from the server profile when the player returns.

Guest accounts and recovery codes live in the hub, not in the game. The device id is `localStorage['hub:deviceId']`.
