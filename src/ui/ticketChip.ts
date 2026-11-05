import type { HubStatus } from '../hub/link';

/**
 * The main menu's Ticket chip: the balance only (no exchange or purchase from it).
 * "--" without a hub session, and while a linked visit's balance is not known yet.
 */
export function ticketChipText(status: Pick<HubStatus, 'connected' | 'balance'>): string {
  if (!status.connected || status.balance === null || !Number.isFinite(status.balance)) return '--';
  return Math.max(0, Math.floor(status.balance)).toLocaleString('en-US');
}

/** The chip's tooltip and accessible label. */
export function ticketChipLabel(status: Pick<HubStatus, 'connected' | 'balance'>): string {
  if (!status.connected) return 'Tickets: not linked to the hub. Enter Sproto Duel from its portal.';
  if (status.balance === null) return 'Tickets: checking your balance';
  return `Tickets: ${ticketChipText(status)}`;
}
