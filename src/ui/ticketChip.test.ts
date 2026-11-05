import { describe, expect, it } from 'vitest';
import { ticketChipLabel, ticketChipText } from './ticketChip';

describe('ticketChipText', () => {
  it('shows -- without a hub session, whatever balance is cached', () => {
    expect(ticketChipText({ connected: false, balance: null })).toBe('--');
    expect(ticketChipText({ connected: false, balance: 120 })).toBe('--');
  });

  it('shows -- while a linked balance is unknown', () => {
    expect(ticketChipText({ connected: true, balance: null })).toBe('--');
    expect(ticketChipText({ connected: true, balance: Number.NaN })).toBe('--');
  });

  it('shows the balance with thousands separators', () => {
    expect(ticketChipText({ connected: true, balance: 0 })).toBe('0');
    expect(ticketChipText({ connected: true, balance: 140 })).toBe('140');
    expect(ticketChipText({ connected: true, balance: 12500 })).toBe('12,500');
  });

  it('labels the chip for screen readers', () => {
    expect(ticketChipLabel({ connected: false, balance: null })).toMatch(/not linked/);
    expect(ticketChipLabel({ connected: true, balance: null })).toMatch(/checking/);
    expect(ticketChipLabel({ connected: true, balance: 1234 })).toBe('Tickets: 1,234');
  });
});
