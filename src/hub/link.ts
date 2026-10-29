import { earnTickets, exchange, exit, init, reportEvent, submitScore, HubError, type HubSdk, type HubSession } from '@metaverse/hub-sdk';
import { HUB_GAME_ID, TICKETS_PER_VERSE } from './config';
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

const browserApi: HubSdk = { init, reportEvent, earnTickets, exchange, submitScore, exit };

/**
 * The game's view of one hub visit. Standalone (no portal ticket, no cached session)
 * leaves `connected` false and never calls the server.
 */
export class HubLink {
  connected = false;
  ranked = false;
  balance: number | null = null;
  ticketsCapLeft: number | null = null;
  error: string | null = null;

  constructor(private readonly api: HubSdk = browserApi) {}

  static standalone(): HubLink {
    return new HubLink();
  }

  attach(session: HubSession | null): void {
    this.connected = session !== null;
    this.ranked = session?.ranked ?? false;
    this.ticketsCapLeft = session?.ticketsCapLeft ?? null;
    this.error = null;
  }

  fail(err: unknown): void {
    this.connected = false;
    this.ranked = false;
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
   */
  async onDuelWin(win: Omit<DuelWin, 'matchId' | 'ranked'>, notify: Notify = () => {}): Promise<void> {
    if (!this.connected) return;
    const calls = planDuelWin({ ...win, ranked: this.ranked, matchId: crypto.randomUUID() });
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
        const message = err instanceof HubError && err.queued
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
    try {
      const result = await this.api.exchange(tickets, `sproto:exchange:${crypto.randomUUID()}`);
      this.balance = result.ticketsLeft;
      return { ok: true, verse: result.verse, ticketsLeft: result.ticketsLeft, receiptId: result.receiptId };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  exitHub(): void {
    this.api.exit('return');
  }
}

/** Redeem a portal ticket when the fragment has one, or resume a cached session. Never throws. */
export async function connectHub(api: HubSdk = browserApi): Promise<HubLink> {
  const link = new HubLink(api);
  try {
    link.attach(await api.init(HUB_GAME_ID));
  } catch (err) {
    link.fail(err);
  }
  return link;
}
