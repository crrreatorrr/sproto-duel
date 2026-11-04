import { createMockRealtimeServer } from '@metaverse/hub-sdk';
import { describe, expect, it } from 'vitest';
import { HubLobby } from './HubLobby';
import { GAME_ID, NET_VERSION, OP, RPC_ROOM_CREATE, RPC_ROOM_JOIN } from './protocol';

describe('HubLobby over the hub-sdk mock realtime server', () => {
  it('quick match pairs two players and moves messages both ways', async () => {
    const server = createMockRealtimeServer();
    const requests: unknown[] = [];
    server.onMatchmakerMatched((entries) => {
      requests.push(...entries.map((e) => e.request));
      return server.createMatch();
    });
    const a = new HubLobby(server.connect({ userId: 'ua', username: 'alice' }));
    const b = new HubLobby(server.connect({ userId: 'ub', username: 'bob' }));
    await a.connect();
    await b.connect();
    const ta = a.quickMatch();
    const tb = b.quickMatch();
    await server.flush();
    const [la, lb] = await Promise.all([ta, tb]);
    expect(requests[0]).toMatchObject({ minCount: 2, maxCount: 2, stringProperties: { game: GAME_ID, v: NET_VERSION } });
    const got: [number, string, string | undefined][] = [];
    lb.onMessage((op, data, sender) => got.push([op, data, sender?.userId]));
    la.send(OP.HELLO, '{"v":"1"}');
    await server.flush();
    expect(got).toEqual([[OP.HELLO, '{"v":"1"}', 'ua']]);
    expect(a.selfId).toBe('ua');
  });

  it('rooms go through the sproto RPCs; cancel stops a search', async () => {
    const server = createMockRealtimeServer();
    let roomMatch = '';
    server.registerRpc(RPC_ROOM_CREATE, (_ctx, body) => {
      expect(body).toEqual({ v: NET_VERSION });
      roomMatch = server.createMatch();
      return { matchId: roomMatch, code: 'ABC234' };
    });
    server.registerRpc(RPC_ROOM_JOIN, (_ctx, body) => {
      const b = body as { code: string };
      if (b.code !== 'ABC234') return { error: 'room_not_found' };
      return { matchId: roomMatch };
    });
    const a = new HubLobby(server.connect({ userId: 'ua' }));
    const b = new HubLobby(server.connect({ userId: 'ub' }));
    await a.connect();
    await b.connect();
    const room = await a.createRoom();
    expect(room.code).toBe('ABC234');
    await b.joinRoom('ABC234');
    await expect(b.joinRoom('ZZZZZZ')).rejects.toMatchObject({ code: 'room_not_found' });
    const search = b.quickMatch();
    await server.flush();
    b.cancel();
    await expect(search).rejects.toThrow('cancelled');
  });
});
