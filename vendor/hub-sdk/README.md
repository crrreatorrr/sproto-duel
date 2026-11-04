# @metaverse/hub-sdk

Client for a game page that was opened from the hub. The hub puts a one-time ticket in the URL fragment (`#t=`). `redeemTicket` strips that fragment immediately and exchanges it for a Nakama session using the server key only. Later calls use that session. With no ticket and no saved session, every method no-ops, so the game still runs on its own.

Version 0.6.0 adds the `sproto-arcade` game id, the `breakwater_coin` Relic and its `arcade.boss_defeated` event, and optional cloud saves: `loadSave()` / `writeSave(data)` (RPCs `save.get` / `save.put`, one JSON object of at most 4096 bytes per player per game, no-op standalone). Games must re-vendor to see the new Relic, because the SDK drops relic ids it does not know.

Version 0.5.0 added the realtime client (`createRealtime`, `realtimeFromSdk`), an in-memory realtime mock for game tests, `getSession` / `refreshSession` / `getLeaderboard`, and a `ScoreResult` answer from `submitScore`. Everything is additive: 0.4 callers and test doubles still typecheck. `redeemTicket` is the handoff. Shop calls (`spendTickets`, `sellItem`, and `getTicketBalance`) sit on the same surface. Method names, argument order, game ids, relic ids, and event ids stay stable.

## Install

The package lives in this monorepo, so install the packed tarball rather than the git repo root.

```bash
git clone --depth 1 https://github.com/crrreatorrr/metaverse-hub.git
cd metaverse-hub
npm ci
npm pack -w @metaverse/hub-sdk
```

That writes `metaverse-hub-sdk-0.5.0.tgz` in the repo root. In the game:

```bash
npm install /absolute/path/to/metaverse-hub-sdk-0.5.0.tgz
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

// sproto_wins is written by the server (the Sproto Duel match), never by the client.

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
submitScore(boardId: string, value: number, meta?: object): Promise<ScoreResult | void>
getSession?(): { token; playerId; game; ranked; expiresAt } | null
refreshSession?(): Promise<HubSessionInfo | null>
getLeaderboard?(boardId, { variant?, limit? }): Promise<{ boardId; variant; order; rows: { userId; name; value; rank }[]; me }>
loadSave?(): Promise<{ data: object | null; updatedAt: number }>
writeSave?(data: object): Promise<{ data: object | null; updatedAt: number }>
earnTickets(amount: number, reason: string, key: string): Promise<{ balance: number; capped: boolean }>
exchange(tickets: number, key: string): Promise<{ verse: number; ticketsLeft: number; balance: number; receiptId: string; verseCapLeft?: number }>
spendTickets(shopId: string, itemId: string, packs: number, key: string): Promise<{ shop_id: string; item_id: string; packs: number; units: number; spent: number; balance: number }>
sellItem(shopId: string, itemId: string, packs: number, key: string): Promise<{ shop_id: string; item_id: string; packs: number; units: number; credited: number; balance: number }>
getTicketBalance(): Promise<{ balance: number; sessionCapLeft: number; dailyCapLeft: number; serverTime: number }>
exit(reason?: string): void
```

Game ids: `hpos10i`, `nobu`, `peoples-bitcoin`, `sproto`, `sproto-fighter`.

| Event | Grants |
| --- | --- |
| `ready` | nothing |
| `game_beaten` | nothing. A client cannot claim a Relic by saying it won |
| `hpos10i.level_complete` with zone `z1_retro_rush_hills` and act `1` | `hpos10i_core` |
| `pb.quest_complete` with quest `quest_tutorial` | `genesis_shard` |
| `nobu.boss_defeated` with boss `cone` | `cones_tip` |
| `sproto.boss_defeated` with boss `tinubu` | `tinubu_crown` |
| `fighter.story_level_complete` with world `1` | `tidebreaker_belt` |
| `arcade.boss_defeated` with boss `bront` | `breakwater_coin` |

God-mode flags inside `data` do not block a grant. The hub lights Tinubu's Crown from the server profile when the player returns.

Guest accounts and recovery codes live in the hub, not in the game. The device id is `localStorage['hub:deviceId']`.

## Scores

`submitScore(boardId, value, meta)` always reaches the server when there is a game session; the server decides. It answers `{ accepted, posted?, value?, order?, reason? }`, where `reason` is `god_mode`, `server_board` or `unranked`. Errors throw `HubSdkError` with `session_closed`, `not_game_session`, `bad_board`, `bad_score`, `bad_variant`, `implausible_score` or `rate_limited`.

- `nobu_trial_time` is per level: pass `meta.level` (`1`, `2` or `3`) and an **integer number of milliseconds**. Floors are `NOBU_TRIAL_FLOOR_MS` (15000, 15000, 12000), the ceiling is `NOBU_TRIAL_CEIL_MS` (30 min). NOBU trials count from unranked sessions. One submit per level per 5 s.
- `sproto_wins` and `meta` are server boards (`reason: 'server_board'`).
- `meta.godMode === true` posts nothing (`reason: 'god_mode'`).

`getLeaderboard(boardId, { variant, limit })` reads `leaderboard.top`: `{ boardId, variant, order, rows: [{ userId, name, value, rank }], me }`. Values come back in the unit they were posted (ms for NOBU).

## Realtime

Dependency-free WebSocket client for Nakama's realtime API (matches, matchmaker, chat channels, socket RPCs). It uses the global `WebSocket` and `fetch`, so it also runs in Node 22 bots.

```ts
import { realtimeFromSdk } from '@metaverse/hub-sdk';

await hub.init('sproto');
const rt = realtimeFromSdk(hub); // null standalone: keep the game offline
if (rt) {
  await rt.connect();
  rt.onMatchmakerMatched(async (m) => {
    const match = await rt.joinMatch(m.matchId ? { matchId: m.matchId } : { token: m.token! });
    match.onMessage((msg) => handle(msg.opCode, msg.json()));
    match.onRejoin(() => match.send(OP_RESYNC));       // after a reconnect
    match.onClose((reason) => backToMenu(reason));      // 'left' | 'kicked' | 'ended' | 'rejoin_failed'
    match.send(OP_HELLO, { v: NET_VERSION });           // synchronous; object → JSON, string → UTF-8, Uint8Array as is
  });
  await rt.addMatchmaker({ query: '+properties.game:sproto +properties.v:3', minCount: 2, maxCount: 2, stringProperties: { game: 'sproto', v: '3' } });
}
```

- `createRealtime({ serverUrl, getToken })` is the low-level constructor; `realtimeFromSdk(sdk)` wires `getToken` to the SDK's game session and refreshes it within 5 minutes of expiry.
- Sharded worlds place players on the server: `rt.joinViaRpc('hub.join', {})` calls the RPC, reads `{ matchId }` and joins it. `rt.listMatches({ query: '+label.kind:pb_world +label.open:T' })` and `joinMatchByQuery` are there for listings.
- Chat: `const ch = await rt.joinChat({ room: 'hub.1' })`, `ch.send({ text, color, effect })`, `ch.history({ limit: 30 })` (newest first), `ch.onMessage`. Rooms a session may join are decided by the server.
- Reconnect: an unexpected close goes `reconnecting` with jittered exponential backoff, calls `getToken()` again, re-joins every open match (success fires `onRejoin`, failure closes it with `rejoin_failed`), re-joins chat channels and re-adds matchmaker tickets (the original ticket string keeps working for `removeMatchmaker`). Pending requests reject with `rt_disconnected`.
- Errors are `HubSdkError` with codes such as `rt_closed`, `rt_timeout`, `rt_disconnected`, `no_session`, `match_not_found`, `match_rejected:<reason>`, `room_not_allowed`, `wrong_scope`, `chat_rate_limited`, `chat_muted`, `chat_duplicate`, `chat_rejected`. A server hook's `Error: <code> at …` message becomes `<code>`.
- `friends` methods reject with `not_implemented` for now.

The Vite dev server must proxy `/ws` with `ws: true` (see the config above). Production Caddy already does.

### Testing with the mock

```ts
import { createMockRealtimeServer } from '@metaverse/hub-sdk';

const server = createMockRealtimeServer();
server.registerMatch('arena', { init: () => ({ state: {} }), loop: (state, msgs, d) => { for (const m of msgs) d.broadcast(2, m.data); } });
server.onMatchmakerMatched(() => server.createMatch('arena'));
const a = server.connect({ userId: 'a' });
await a.connect();
// …drive the game's net layer with `a`, then:
server.tick();          // run authoritative loops
await server.flush();   // deliver queued messages
server.drop('a');       // simulate a dropped socket; the client reconnects and re-joins
```

The mock speaks the same envelopes as Nakama through the real client, applies the server's chat rules (`validateChatContent`, burst 5, 1 per 1.5 s, 30 s duplicate window) and accepts every room unless `allowRooms(pattern)` is called.
