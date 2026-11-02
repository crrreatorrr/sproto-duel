import { createHubSdk, HubSdkError, type HubSdk, type InitResult, type RelicId } from '@metaverse/hub-sdk';
import { HUB_EXIT_SLUG, HUB_GAME_ID, TICKETS_PER_VERSE } from './config';
import { planDuelWin, type DuelWin } from './report';

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

/**
 * The game's view of one hub visit.
 * `init` returns a profile even for standalone play. This visit is hub-connected only when
 * sessionStorage holds `hub:sproto:session`. Otherwise the game plays on its own and does not
 * report wins or exchange Tickets.
 */
export class HubLink {
  connected = false;
  ranked = false;
  /**
   * Relics from the hub init result for this visit. Empty when the visit is standalone.
   * A copy of what `init` already returned. Nothing in the game writes this back.
   */
  relics: readonly RelicId[] = [];
  balance: number | null = null;
  ticketsCapLeft: number | null = null;
  error: string | null = null;

  constructor(private readonly api: HubSdk = createBrowserSdk()) {}

  static standalone(): HubLink {
    return new HubLink();
  }

  attach(session: InitResult | null): void {
    this.connected = session !== null;
    this.ranked = session?.ranked ?? false;
    this.relics = [...(session?.relics ?? [])];
    this.ticketsCapLeft = session?.ticketsCapLeft ?? null;
    this.error = null;
  }

  fail(err: unknown): void {
    this.connected = false;
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

  /**
   * Report a finished duel. Losses and standalone visits do nothing.
   * God-mode wins still earn Tickets and can grant Tinubu's Crown; they do not post a score.
   * The match id is the operation id (`sproto:win:<id>`, `sproto.boss_defeated:<id>`).
   * On a queued error the SDK has already saved that id and resends it on the next init,
   * so this does not call again with a new one.
   */
  async onDuelWin(win: Omit<DuelWin, 'matchId' | 'ranked'>, notify: Notify = () => {}): Promise<void> {
    if (!this.connected) return;
    const matchId = crypto.randomUUID();
    const calls = planDuelWin({ ...win, ranked: this.ranked, matchId });
    let title = '';
    let sub = '';
    for (const call of calls) {
      try {
        if (call.kind === 'earn') {
          const earned = await this.api.earnTickets(call.amount, call.reason, call.key);
          this.balance = earned.balance;
          title = earned.capped ? 'Tickets capped' : `+${call.amount} Tickets`;
          sub = earned.capped ? `Daily cap reached · Balance ${earned.balance}` : `Balance ${earned.balance}`;
        } else if (call.kind === 'event') {
          const reported = await this.api.reportEvent(call.eventId, call.data, call.key);
          if (reported.granted === 'tinubu_crown') sub = sub ? `${sub} · Tinubu's Crown` : "Tinubu's Crown";
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
    if (title) notify(title, sub);
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

function createBrowserSdk(): HubSdk {
  const serverUrl = (import.meta.env.VITE_NAKAMA_URL || 'http://127.0.0.1:7350').replace(/\/$/, '');
  return createHubSdk({
    serverUrl,
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
