# @metaverse/hub-sdk

Client for a game page that was opened from the hub. The hub puts a one-time ticket in the URL fragment (`#t=`). `redeemTicket` strips that fragment immediately and exchanges it for a Nakama session using the server key only. Later calls use that session. With no ticket and no saved session, every method no-ops, so the game still runs on its own.

Version 0.4.0-redeem.1 (a prerelease of 0.4.0). `redeemTicket` is the handoff. Shop calls (`spendTickets`, `sellItem`, and `getTicketBalance`) sit on the same surface. Method names, argument order, game ids, relic ids, and event ids stay stable.

## Install

The package lives in this monorepo, so install the packed tarball rather than the git repo root.

```bash
git clone --depth 1 https://github.com/crrreatorrr/metaverse-hub.git
cd metaverse-hub
npm ci
npm pack -w @metaverse/hub-sdk
```

That writes `metaverse-hub-sdk-0.4.0-redeem.1.tgz` in the repo root. In the game:

```bash
npm install /absolute/path/to/metaverse-hub-sdk-0.4.0-redeem.1.tgz
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
  serverKey: import.meta.env.VITE_NAKAMA_SERVER_KEY, // server key only; never the HTTP key
  hubUrl: 'http://127.0.0.1:5173/hub/',
}));

const profile = await hub.init('sproto');
// profile.playerId, profile.ranked, profile.relics, profile.effects, profile.ticketsCapLeft, profile.serverTime
```

`init` redeems `#t=` when it is still there. To take the session and refresh token yourself, call `redeemTicket` instead of that first `init` (it removes the fragment, so do not call both on the same load):

```ts
const session = await hub.redeemTicket({ game: 'sproto' });
// session.token, session.refreshToken
```

`redeemTicket({ game })` is the handoff Sproto Duel and HPOS10I should call when they want the Nakama session and refresh token. It reads `#t=` from `location.hash`, removes it with `history.replaceState` before any network call, then:

```ts
client.authenticateCustom('t:' + ticket, false, { game: 'sproto' })
```

That request uses the Nakama server key (`Authorization: Basic`). It does not send the HTTP key. The server burns the ticket and signs in the hub account. The function returns:

```ts
redeemTicket({ game }: { game: GameId }): Promise<{ token: string; refreshToken: string }>
```

`init(gameId)` still performs that exchange when `#t=` is present and `authenticateCustom` is available, then loads the profile. Call either `redeemTicket` or `init`, not both on the same fragment: the first call removes `#t=`. A reload keeps the session in `sessionStorage` under `hub:<game>:session`, so a ticket is not required twice.

`installHubSdk` also sets `window.hubSdk` for HPOS10I's JavaScriptBridge. Call `redeemTicket` or `init` once at boot, before play starts. Pass `serverKey` from the game's build (`VITE_NAKAMA_SERVER_KEY` in production). Do not ship Nakama's HTTP key.

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

Against Nakama, earn, relic events, exchange, shop purchases, and shop sales are written to IndexedDB (`hub-outbox`, store `writes`) before they are sent. The record keeps the `key` you passed, plus the body, RPC name, session token, and game id. That key is not replaced on a retry. The call rejects if the response is lost, and the record stays queued. It is deleted only after the RPC resolves. `init` drains every queued record, including in a tab with no saved session, using the stored token and key. Nakama returns the stored result when that same key and body are repeated. `getTicketBalance` is a read and is not queued.

A different operation id is a new request. The relic itself is still earn-once: the server's primary key is `(player, relic)`, so a second boss event cannot grant Tinubu's Crown again.

`earnTickets` records Tickets on the server. `exchange` turns Tickets into Verse at 10 to 1, at most 50 Verse per game per day, and returns a `receiptId` plus the Ticket `balance`. `spendTickets(shopId, itemId, packs, key)` buys `packs` at that shop's price per pack (`price * packs`). `sellItem(shopId, itemId, packs, key)` credits `sell_price * packs` through the same session cap (200) and daily earn window as `earnTickets`. A sale worth 0 Tickets returns `zero_value` and leaves the item, the wallet, and the cap untouched. A sale that does not fit the session cap is rejected entirely with `session_ticket_cap` and `sessionCapLeft`. A credit that does not fit today's earn window is rejected entirely with `daily_ticket_cap` and `dailyCapLeft`. The server does not partial-credit. A successful shop call returns `units` (`packs * pack_size`) and `balance`. An unknown shop item returns `unknown_item`. `getTicketBalance()` returns `{ balance, sessionCapLeft, dailyCapLeft, serverTime }` so the game can bank only what still fits. `serverTime` is epoch milliseconds from PostgreSQL `now()` on the Nakama server. `init` returns that clock after the portal ticket is swapped for a session, and again from `profile.get` when a saved session is reused. The in-memory mock fills it from `serverNow`, or from `now` when `serverNow` is omitted.

## API

```ts
redeemTicket({ game }: { game: GameId }): Promise<{ token: string; refreshToken: string }>

init(gameId): Promise<{
  playerId: string;
  ranked: boolean;
  relics: RelicId[];
  effects: Record<string, number | boolean | string>;
  ticketsCapLeft: number;
  serverTime: number;
}>

reportEvent(eventId: string, data: object, key: string): Promise<{ granted?: RelicId }>
submitScore(boardId: string, value: number, meta?: object): Promise<void>
earnTickets(amount: number, reason: string, key: string): Promise<{ balance: number; capped: boolean }>
exchange(tickets: number, key: string): Promise<{ verse: number; ticketsLeft: number; balance: number; receiptId: string; verseCapLeft?: number }>
spendTickets(shopId: string, itemId: string, packs: number, key: string): Promise<{ shop_id: string; item_id: string; packs: number; units: number; spent: number; balance: number }>
sellItem(shopId: string, itemId: string, packs: number, key: string): Promise<{ shop_id: string; item_id: string; packs: number; units: number; credited: number; balance: number }>
getTicketBalance(): Promise<{ balance: number; sessionCapLeft: number; dailyCapLeft: number; serverTime: number }>
exit(reason?: string): void
```

Game ids: `hpos10i`, `nobu`, `peoples-bitcoin`, `sproto`.

| Event | Grants |
| --- | --- |
| `ready` | nothing |
| `game_beaten` | nothing. A client cannot claim a Relic by saying it won |
| `hpos10i.level_complete` with zone `z1_retro_rush_hills` and act `1` | `hpos10i_core` |
| `pb.quest_complete` with quest `quest_tutorial` | `genesis_shard` |
| `nobu.boss_defeated` with boss `cone` | `cones_tip` |
| `sproto.boss_defeated` with boss `tinubu` | `tinubu_crown` |

God-mode flags inside `data` do not block a grant. The hub lights Tinubu's Crown from the server profile when the player returns.

Guest accounts and recovery codes live in the hub, not in the game. The device id is `localStorage['hub:deviceId']`.
