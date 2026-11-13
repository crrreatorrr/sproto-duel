import { createHubSdk, HubSdkError, type HubRealtime, type HubSdk, type InitResult, type RealtimeOptions, type RelicId } from '@metaverse/hub-sdk';
import { HUB_EXIT_SLUG, HUB_GAME_ID, TICKETS_PER_VERSE } from './config';
import { openGuestRealtime } from './guestSession';
import { planDuelWin, type DuelWin } from './report';
import { pageServerKey } from './serverKey';

export interface HubStatus {
  connected: boolean;
  balance: number | null;
  ticketsCapLeft: number | null;
  /** Set when the portal ticket could not be redeemed. Standalone play leaves this null. */
  error: string | null;
}

export type ExchangeView =
  | { ok: true; verse: number; ticketsLeft: number; receiptId: string }
  | { ok: false; message: string };

type Notify = (title: string, sub: string) => void;

/** Written by the SDK when a portal ticket or a cached visit is live. */
const HUB_SESSION_KEY = `hub:${HUB_GAME_ID}:session`;

// Nakama's client server key. The rule (env key, else the local stock key in dev or on a
// loopback host) is in ./serverKey.ts.
const NAKAMA_SERVER_KEY = pageServerKey();

/**
 * The game's view of one hub visit.
 * `init` returns a profile even for standalone play. This visit is hub-connected only when
 * sessionStorage holds `hub:sproto:session`. Otherwise the game plays on its own and does not
 * report wins or exchange Tickets.
 */
export class HubLink {
  connected = false;
  /** The hub account playing this visit, or null when standalone. Progress is saved under it. */
  playerId: string | null = null;
  ranked = false;
  /**
   * Relics from the hub init result for this visit. Empty when the visit is standalone.
   * Updated when the hub grants a relic during this visit.
   */
  relics: readonly RelicId[] = [];
  balance: number | null = null;
  ticketsCapLeft: number | null = null;
  error: string | null = null;

  constructor(private readonly api: HubSdk = createBrowserSdk()) {}

  /** The SDK behind this visit (the feedback window sends through it). */
  get sdk(): HubSdk {
    return this.api;
  }

  private rt: HubRealtime | null = null;
  /** Device-auth session for a visit that has no portal ticket. Ranked stays 0. */
  private guestRt: HubRealtime | null = null;
  /**
   * One id per fight. `beginFight` mints it; otherwise the first `onDuelWin` for a payload
   * mints it and a repeat of that same payload reuses it. The next different win mints another.
   */
  private fightMatchId: string | null = null;
  /** True after `beginFight` until the next one: every report in between shares `fightMatchId`. */
  private fightOpen = false;
  /** Payload of the win that owns `fightMatchId` when the fight was not opened with `beginFight`. */
  private fightSignature: string | null = null;
  /** Match id already sent to the hub. A second handler call for that fight does not post again. */
  private reportedMatchId: string | null = null;

  /**
   * The portal visit's realtime client, or null when this visit has no hub session.
   * Online Duel for that visit goes through `openOnlineRealtime`, which also covers a guest.
   */
  realtime(make: (sdk: HubSdk, opts: Omit<RealtimeOptions, 'getToken'>) => HubRealtime | null): HubRealtime | null {
    if (!this.connected) return null;
    // `make` is the SDK's realtimeFromSdk, passed in from the lazily loaded online stack.
    this.rt ??= make(this.api, { serverUrl: nakamaUrl() });
    return this.rt;
  }

  /**
   * Realtime client for Online Duel. A portal visit keeps its game session and is never swapped
   * for a device guest. Anyone else, including a guest, gets a device session and
   * `sproto.standalone_session` (`ranked` 0, no wager). Created once. The socket opens on connect.
   */
  openOnlineRealtime(make: (sdk: HubSdk, opts: Omit<RealtimeOptions, 'getToken'>) => HubRealtime | null): HubRealtime | null {
    if (this.connected) return this.realtime(make);
    this.guestRt ??= openGuestRealtime({ serverUrl: nakamaUrl(), serverKey: pageServerKey() });
    return this.guestRt;
  }

  /**
   * An online match ended. The stake is 0 Tickets until a server-verified Duel sim exists.
   * This does not call earnTickets, getTicketBalance, exchange, or any other Ticket mint,
   * and it does not toast a payout. `paid` on the outcome is ignored.
   */
  async onOnlineOutcome(
    _outcome: { status: string; paid: Record<string, number>; balances?: Record<string, number> },
    _selfId: string | null,
    _notify: Notify = () => {},
  ): Promise<void> {
    /* no Ticket stake, no wager hold */
  }

  static standalone(): HubLink {
    return new HubLink();
  }

  attach(session: InitResult | null): void {
    this.connected = session !== null;
    // Only a live hub session names the account: a standalone profile's id is not one.
    this.playerId = session?.playerId || null;
    this.ranked = session?.ranked ?? false;
    this.relics = [...(session?.relics ?? [])];
    this.ticketsCapLeft = session?.ticketsCapLeft ?? null;
    this.error = null;
  }

  fail(err: unknown): void {
    this.connected = false;
    this.playerId = null;
    this.ranked = false;
    this.relics = [];
    this.error = err instanceof Error ? err.message : String(err);
  }

  status(): HubStatus {
    return {
      connected: this.connected,
      balance: this.balance,
      ticketsCapLeft: this.ticketsCapLeft,
      error: this.error,
    };
  }

  /** In-flight balance read, and when the last one finished (ms, performance clock). */
  private balanceJob: Promise<number | null> | null = null;
  private balanceAt = -Infinity;

  /**
   * Read the Ticket balance (the SDK's `getTicketBalance`, read only) for the main menu's chip.
   * Standalone visits do nothing. At most one read in flight and one per `minGapMs`. Earning or
   * exchanging updates `balance` on its own. A failed read keeps the last known balance.
   */
  refreshBalance(minGapMs = 30_000): Promise<number | null> {
    if (!this.connected) return Promise.resolve(null);
    if (this.balanceJob) return this.balanceJob;
    if (this.balance !== null && performance.now() - this.balanceAt < minGapMs) return Promise.resolve(this.balance);
    this.balanceJob = this.api.getTicketBalance()
      .then((r) => {
        if (Number.isFinite(r.balance)) this.balance = r.balance;
        return this.balance;
      })
      .catch(() => this.balance)
      .finally(() => {
        this.balanceAt = performance.now();
        this.balanceJob = null;
      });
    return this.balanceJob;
  }

  /** The last finished match's input log and its match id (hub verification; see docs/SERVER-SIM.md). */
  lastReplay: { matchId: string; log: object } | null = null;

  beginFight(): string {
    this.fightMatchId = crypto.randomUUID();
    this.fightOpen = true;
    this.fightSignature = null;
    this.reportedMatchId = null;
    return this.fightMatchId;
  }

  /**
   * Report a finished duel. Losses and standalone visits do nothing.
   * This never calls earnTickets. A story-boss gauntlet win posts `sproto.boss_defeated`
   * (the hub pays 20 T once per boss per UTC day and may grant Tinubu's Crown).
   * After that event, the shown balance is refreshed. When the hub returns `tickets` (SDK 0.7.1)
   * the toast says what the win paid, or that it paid none today; without it, a Ticket toast
   * appears only when the balance rose.
   * The match id is assigned once per fight (`beginFight`, or the first report of this win)
   * and the operation id is `sproto.boss_defeated:<id>`. A second call for that fight does not post.
   * On a queued error the SDK has already saved that id and resends it on the next init.
   * A replay log is kept on `lastReplay` under that same match id.
   */
  async onDuelWin(win: Omit<DuelWin, 'matchId' | 'ranked'> & { matchId?: string }, notify: Notify = () => {}): Promise<void> {
    if (!this.connected) return;
    const matchId = this.matchIdFor(win);
    if (win.replay) this.lastReplay = { matchId, log: win.replay };
    const calls = planDuelWin({ ...win, ranked: this.ranked, matchId });
    if (calls.length === 0 || this.reportedMatchId === matchId) return;
    this.reportedMatchId = matchId;
    let title = '';
    let sub = '';
    let crown = false;
    let eventPosted = false;
    /** Tickets the hub says this win paid (SDK 0.7.1). Undefined when the server did not say. */
    let paid: number | undefined;
    for (const call of calls) {
      try {
        if (call.kind === 'event') {
          const reported = await this.api.reportEvent(call.eventId, call.data, call.key);
          eventPosted = true;
          if (reported.granted === 'tinubu_crown') crown = true;
          if (typeof reported.tickets === 'number') paid = reported.tickets;
        } else {
          await this.api.submitScore(call.boardId, call.value, call.meta);
        }
      } catch (err) {
        const message = err instanceof HubSdkError && err.code === 'queued'
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
        if (!title) title = 'Tickets';
        sub = sub ? `${sub} · ${message}` : message;
      }
    }
    if (eventPosted) {
      const before = this.balance;
      try {
        const next = (await this.api.getTicketBalance()).balance;
        if (paid === undefined && typeof before === 'number' && next > before) {
          title = `+${next - before} Tickets`;
          sub = sub ? `Balance ${next} · ${sub}` : `Balance ${next}`;
        } else if (paid !== undefined) {
          sub = sub ? `Balance ${next} · ${sub}` : `Balance ${next}`;
        }
        this.balance = next;
      } catch {
        /* without `tickets`, no Ticket toast unless the shown balance actually rose */
      }
    }
    if (paid !== undefined) {
      // The hub said what this boss win paid. A replayed key returns the same number, so it is shown, never added.
      const line = paid > 0 ? `This boss win paid ${paid} Tickets` : 'This boss already paid its Tickets today';
      title = paid > 0 ? `+${paid} Tickets` : 'No Tickets today';
      sub = sub ? `${line} · ${sub}` : line;
    }
    if (crown) {
      if (!this.relics.includes('tinubu_crown')) this.relics = [...this.relics, 'tinubu_crown'];
      sub = sub ? `${sub} · Tinubu's Crown` : "Tinubu's Crown";
      if (!title) title = "Tinubu's Crown";
    }
    if (title) notify(title, sub);
  }

  /**
   * The id for this win. A passed `matchId` or an open `beginFight` id is reused for every
   * call until the next fight. With neither, the first call mints one and a repeat of the
   * same win (mode, boss, god mode, result, elapsed) reuses it; a different win mints another.
   */
  private matchIdFor(win: Omit<DuelWin, 'matchId' | 'ranked'> & { matchId?: string }): string {
    if (win.matchId) {
      if (win.matchId !== this.fightMatchId) {
        this.fightMatchId = win.matchId;
        this.fightOpen = true;
        this.fightSignature = HubLink.fightSignature(win);
        if (this.reportedMatchId !== win.matchId) this.reportedMatchId = null;
      }
      return win.matchId;
    }
    const signature = HubLink.fightSignature(win);
    if (this.fightOpen && this.fightMatchId) {
      this.fightSignature = signature;
      return this.fightMatchId;
    }
    if (this.fightMatchId && this.fightSignature === signature) return this.fightMatchId;
    this.fightMatchId = crypto.randomUUID();
    this.fightSignature = signature;
    this.fightOpen = false;
    return this.fightMatchId;
  }

  private static fightSignature(win: Omit<DuelWin, 'matchId' | 'ranked'>): string {
    return `${win.mode ?? ''}|${win.bossId ?? ''}|${win.godMode}|${win.playerWon}|${win.elapsed}`;
  }

  /** Spend Tickets for Verse. The server enforces the rate and the daily cap. */
  async exchangeTickets(tickets: number): Promise<ExchangeView> {
    if (!this.connected) {
      return { ok: false, message: 'Enter from the hub portal to exchange Tickets.' };
    }
    if (!Number.isInteger(tickets) || tickets <= 0 || tickets % TICKETS_PER_VERSE !== 0) {
      return { ok: false, message: `Exchange ${TICKETS_PER_VERSE} Tickets at a time (that is 1 Verse).` };
    }
    // One operation id for this attempt. A queued error is flushed on the next init, not retried here.
    const operationId = `sproto:exchange:${crypto.randomUUID()}`;
    try {
      const result = await this.api.exchange(tickets, operationId);
      this.balance = result.ticketsLeft;
      return { ok: true, verse: result.verse, ticketsLeft: result.ticketsLeft, receiptId: result.receiptId };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Close the hub session, then leave for the portal.
   * Games are hosted on `play.<domain>`, so the return URL is the absolute hub
   * (`VITE_HUB_URL`, `/hub/` in dev) plus `#from=sproto-duel`. The SDK only navigates
   * when a session is open, and it would use `#from=sproto`, so this always sends
   * the portal slug.
   */
  exitHub(): void {
    const sdkNavigates = this.connected;
    this.api.exit('return');
    if (!sdkNavigates) redirectToHub();
  }
}

/** Redeem a portal ticket when the fragment has one, or resume a cached session. Never throws. */
export async function connectHub(api?: HubSdk): Promise<HubLink> {
  const sdk = api ?? createBrowserSdk();
  const link = new HubLink(sdk);
  try {
    const profile = await sdk.init(HUB_GAME_ID);
    // A standalone profile is not a hub visit. Only a saved session is.
    link.attach(hubSessionPresent() ? profile : null);
  } catch (err) {
    link.fail(err);
  }
  return link;
}

/** Nakama's HTTP origin (VITE_NAKAMA_URL; the compose default in dev). */
function nakamaUrl(): string {
  return (import.meta.env.VITE_NAKAMA_URL || 'http://127.0.0.1:7350').replace(/\/$/, '');
}

function createBrowserSdk(): HubSdk {
  const serverUrl = nakamaUrl();
  return createHubSdk({
    serverUrl,
    serverKey: NAKAMA_SERVER_KEY,
    hubUrl: hubPageUrl(),
    // The SDK appends `#from=<game id>`. Replace that with the portal slug.
    assign: () => redirectToHub(),
  });
}

/** Build-time hub page. Dev default is same-origin `/hub/`; production is `https://<domain>/hub`. */
function hubPageUrl(): string {
  const configured = import.meta.env.VITE_HUB_URL?.trim();
  return configured ? configured.split('#')[0] : '/hub/';
}

/** `https://<domain>/hub` + `#from=sproto-duel`, or `/hub/#from=sproto-duel` in dev. */
function hubExitUrl(): string {
  return `${hubPageUrl()}#from=${HUB_EXIT_SLUG}`;
}

function redirectToHub(): void {
  if (typeof window === 'undefined') return;
  window.location.assign(hubExitUrl());
}

function hubSessionPresent(): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(HUB_SESSION_KEY) !== null;
  } catch {
    return false;
  }
}
