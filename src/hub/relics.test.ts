import { RELIC_IDS, createHubSdk, isRelicId, memoryKeyValue, mintMockTicket } from '@metaverse/hub-sdk';
import { describe, expect, it } from 'vitest';

/**
 * The vendored SDK drops any relic id that is not in its fixed RELIC_IDS list (init results, the
 * mock relic cache, event grants). The Tidebreaker Belt is patched in (vendor/hub-sdk/VENDOR.md).
 */
describe('vendored hub SDK relic ids', () => {
  it('keeps tidebreaker_belt', () => {
    expect(RELIC_IDS).toContain('tidebreaker_belt');
    expect(isRelicId('tidebreaker_belt')).toBe(true);
  });

  it('still lists the four original relics and rejects unknown ids', () => {
    for (const id of ['hpos10i_core', 'genesis_shard', 'cones_tip', 'tinubu_crown']) expect(isRelicId(id)).toBe(true);
    expect(isRelicId('not_a_relic')).toBe(false);
  });

  it('returns tidebreaker_belt from init', async () => {
    const local = memoryKeyValue();
    local.setItem('hub:relics', JSON.stringify(['tidebreaker_belt', 'cones_tip', 'not_a_relic']));
    let hash = `#t=${await mintMockTicket({ game: 'sproto', playerId: 'player-1' })}`;
    const sdk = createHubSdk({
      useMock: true,
      local,
      session: memoryKeyValue(),
      readHash: () => hash,
      writeHash: (next) => {
        hash = next;
      },
      assign: () => undefined,
      releasePointer: () => undefined,
      clearBeforeUnload: () => undefined,
    });
    const profile = await sdk.init('sproto');
    expect(profile.relics).toEqual(['tidebreaker_belt', 'cones_tip']);
  });
});
