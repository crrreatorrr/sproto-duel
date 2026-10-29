import { mintMockTicket, type HubSdkEnv } from '@metaverse/hub-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectHub } from './link';

/**
 * Sproto Duel's own calls into the real SDK.
 * Mock mode stands in for Nakama so init, the Tinubu report, and exit can run here.
 * Outbox, idempotency, and duplicate delivery are covered in the hub repo.
 */
const harness = vi.hoisted(() => ({
  hash: '',
  hubUrl: undefined as string | undefined,
  assigned: [] as string[],
  games: [] as string[],
  events: [] as { eventId: string; data: object; key: string }[],
}));

vi.mock('@metaverse/hub-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@metaverse/hub-sdk')>();
  return {
    ...actual,
    createHubSdk(env: HubSdkEnv = {}) {
      harness.hubUrl = env.hubUrl;
      const sdk = actual.createHubSdk({
        ...env,
        useMock: true,
        session: globalThis.sessionStorage,
        readHash: () => harness.hash,
        writeHash: (next: string) => {
          harness.hash = next;
        },
        assign: (url: string) => {
          harness.assigned.push(url);
        },
        releasePointer: () => undefined,
        clearBeforeUnload: () => undefined,
      });
      const init = sdk.init.bind(sdk);
      const reportEvent = sdk.reportEvent.bind(sdk);
      sdk.init = (gameId) => {
        harness.games.push(gameId);
        return init(gameId);
      };
      sdk.reportEvent = (eventId, data, key) => {
        harness.events.push({ eventId, data, key });
        return reportEvent(eventId, data, key);
      };
      return sdk;
    },
  };
});

function installSessionStorage(): void {
  const map = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  });
}

describe('Sproto Duel hub integration', () => {
  beforeEach(() => {
    harness.hash = '';
    harness.hubUrl = undefined;
    harness.assigned.length = 0;
    harness.games.length = 0;
    harness.events.length = 0;
    installSessionStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls init with sproto and exits to /hub/#from=sproto', async () => {
    harness.hash = `#t=${await mintMockTicket({ game: 'sproto', playerId: 'player-1' })}`;
    const link = await connectHub();
    expect(link.error).toBeNull();
    expect(link.connected).toBe(true);
    expect(harness.games).toEqual(['sproto']);
    expect(harness.hubUrl).toBe('/hub/');
    link.exitHub();
    expect(harness.assigned).toEqual(['/hub/#from=sproto']);
  });

  it('reports sproto.boss_defeated for tinubu and shows the crown grant', async () => {
    harness.hash = `#t=${await mintMockTicket({ game: 'sproto', playerId: 'player-1', ranked: true })}`;
    const link = await connectHub();
    expect(link.connected).toBe(true);
    const notes: string[] = [];
    await link.onDuelWin(
      { playerWon: true, bossId: 'tinubu', godMode: true, elapsed: 40.4 },
      (title, sub) => notes.push(`${title}|${sub}`),
    );
    expect(harness.events).toEqual([
      {
        eventId: 'sproto.boss_defeated',
        data: { boss: 'tinubu', elapsed: 40 },
        key: expect.stringMatching(/^sproto\.boss_defeated:/),
      },
    ]);
    expect(notes[0]).toContain("Tinubu's Crown");
  });
});
