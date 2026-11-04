import { describe, expect, it } from 'vitest';
import { nakamaServerKey } from './serverKey';

describe('Nakama server key', () => {
  it('uses VITE_NAKAMA_SERVER_KEY whenever it is set', () => {
    expect(nakamaServerKey({ envKey: 'prodkey', dev: false, hostname: 'play.example.com' })).toBe('prodkey');
    expect(nakamaServerKey({ envKey: 'prodkey', dev: false, hostname: 'localhost' })).toBe('prodkey');
  });

  it('falls back to the stock key under vite dev', () => {
    expect(nakamaServerKey({ dev: true, hostname: 'play.example.com' })).toBe('defaultkey');
  });

  // The dev hub serves a game build from apps/hub/public/play/<slug>/. Without this the
  // ticket redeem gets 401 "Server key invalid" and the game runs with no hub session.
  it('falls back to the stock key for a build served from this machine', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]', 'hub.localhost']) {
      expect(nakamaServerKey({ dev: false, hostname: host })).toBe('defaultkey');
    }
  });

  it('sends no key from a build on any other host', () => {
    for (const host of ['play.example.com', '192.168.1.20', 'localhost.example.com', '', undefined]) {
      expect(nakamaServerKey({ dev: false, hostname: host })).toBe('');
    }
  });
});
