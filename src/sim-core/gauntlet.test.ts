import { describe, expect, it } from 'vitest';
import { BOSS_IDS, bossArena } from './bosses';
import { ONE } from './fixed';
import { SimWorld } from './world';
import { emptyInput } from './wizard';

describe('gauntlet setup', () => {
  for (const id of BOSS_IDS) {
    it(`builds the ${id} fight`, () => {
      const w = new SimWorld({ seed: 1, rules: 'gauntlet', arena: 'moonlit', staffs: ['duel_staff_sproto', null], bossId: id, learned: ['carpet'] });
      expect(w.arena.id).toBe(bossArena(id));
      expect(w.wizards.length).toBe(id === 'obama' ? 3 : 2);
      expect(w.inputSeats()).toEqual([0]);
      expect(w.wizards[1].maxHealth).toBeGreaterThan(300 * ONE);
      for (let t = 0; t < 600; t++) w.step([emptyInput()]);
      expect(w.match.phase).toBe('fight');
    });
  }
});
