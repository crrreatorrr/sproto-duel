/**
 * OnlineLobby over the hub SDK's realtime client (Contract C9): quick match through the Nakama
 * matchmaker (the hub's dispatcher routes `game: "sproto"` to sproto_arena), private rooms through
 * the `sproto.room_create` / `sproto.room_join` RPCs. The SDK reconnects by itself and re-joins
 * the match; the server keeps the seat for CONFIG.net.reconnectGraceS.
 */
import type { HubRealtime } from '@metaverse/hub-sdk';
import { asOnlineCount, matchmakerRequest, NET_VERSION, RPC_ONLINE_COUNT, RPC_ROOM_CREATE, RPC_ROOM_JOIN, type OnlineCount } from './protocol';
import type { OnlineLobby } from './OnlineSession';
import { HubRealtimeTransport, type NetTransport } from './transport';

export class HubLobby implements OnlineLobby {
  private ticket: string | null = null;
  private stopWaiting: (() => void) | null = null;

  constructor(private readonly rt: HubRealtime) {}

  get selfId(): string | null {
    return this.rt.self?.userId ?? null;
  }

  async connect(): Promise<void> {
    if (this.rt.state !== 'open') await this.rt.connect();
  }

  quickMatch(): Promise<NetTransport> {
    return new Promise<NetTransport>((resolve, reject) => {
      const off = this.rt.onMatchmakerMatched((m) => {
        if (!m.matchId) return;
        off();
        this.stopWaiting = null;
        this.ticket = null;
        this.rt.joinMatch({ matchId: m.matchId }).then((h) => resolve(new HubRealtimeTransport(h)), reject);
      });
      this.stopWaiting = () => {
        off();
        reject(new Error('cancelled'));
      };
      this.rt.addMatchmaker(matchmakerRequest()).then((r) => (this.ticket = r.ticket), (err) => {
        off();
        reject(err);
      });
    });
  }

  async createRoom(): Promise<{ code: string; transport: NetTransport }> {
    const r = await this.rt.rpc<{ matchId: string; code: string }>(RPC_ROOM_CREATE, { v: NET_VERSION });
    const h = await this.rt.joinMatch({ matchId: r.matchId });
    return { code: r.code, transport: new HubRealtimeTransport(h) };
  }

  async joinRoom(code: string): Promise<NetTransport> {
    const r = await this.rt.rpc<{ matchId: string }>(RPC_ROOM_JOIN, { code, v: NET_VERSION });
    const h = await this.rt.joinMatch({ matchId: r.matchId });
    return new HubRealtimeTransport(h);
  }

  async joinMatch(matchId: string): Promise<NetTransport> {
    const h = await this.rt.joinMatch({ matchId });
    return new HubRealtimeTransport(h);
  }

  async onlineCount(): Promise<OnlineCount> {
    const raw = await this.rt.rpc<unknown>(RPC_ONLINE_COUNT, {});
    const count = asOnlineCount(raw);
    if (!count) throw new Error('bad_count');
    return count;
  }

  cancel(): void {
    if (this.ticket) void this.rt.removeMatchmaker(this.ticket).catch(() => {});
    this.ticket = null;
    this.stopWaiting?.();
    this.stopWaiting = null;
  }
}
