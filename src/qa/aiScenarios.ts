import { CONFIG, type Difficulty } from '../config';
import type { Game } from '../core/Game';
import { AIController } from '../enemy/AIController';
import type { QAHarness } from './QAHarness';

const DT = CONFIG.sim.fixedDt;

/** Run `fn` with a temporary AI driving the enemy, then detach its event listeners. */
function withAI<T>(game: Game, difficulty: Difficulty, fn: (ai: AIController) => T): T {
  const ai = new AIController(game.enemy, game.player, game.spells, game.physics, game.arena, difficulty);
  try {
    return fn(ai);
  } finally {
    ai.dispose();
  }
}

export function registerAIScenarios(qa: QAHarness, game: Game): void {
  qa.add('ai.attacks_static_player', (c) => {
    c.setup();
    withAI(game, 'normal', (ai) => c.step(8, () => ai.update(DT)));
    const dmg = CONFIG.wizard.maxHealth - c.player.health;
    c.expect(c.enemy.stats.casts > 5, `AI barely cast (${c.enemy.stats.casts})`);
    c.expect(dmg > 0, 'AI dealt no damage to a static player in 8s');
    c.note(`AI casts=${c.enemy.stats.casts} dmg=${dmg}`);
  });

  qa.add('ai.harder_dodges_more', (c) => {
    // Player fires perfectly-led bolts; harder AIs should take fewer of them.
    const rates: Record<string, number> = {};
    for (const d of ['easy', 'hard'] as Difficulty[]) {
      let hits = 0;
      let shots = 0;
      for (let trial = 0; trial < 3; trial++) {
        c.setup();
        withAI(game, d, (ai) => {
          c.step(6, () => {
            ai.update(DT);
            c.enemy.health = CONFIG.wizard.maxHealth; // keep it alive
            c.player.health = CONFIG.wizard.maxHealth;
            c.player.mana = 1e6;
            const travel = c.player.pos.distanceTo(c.enemy.pos) / CONFIG.spells.bolt.speed;
            c.enemy.chest(c.player.aimPoint).addScaledVector(c.enemy.vel, travel);
            c.player.intent.holdBolt = true;
          });
        });
        hits += c.player.stats.hits;
        shots += c.player.stats.casts;
      }
      rates[d] = hits / Math.max(1, shots);
    }
    c.note(`hit rate easy=${(rates.easy * 100).toFixed(0)}% hard=${(rates.hard * 100).toFixed(0)}%`);
    c.expect(rates.hard < rates.easy, 'Archmage AI is not harder to hit than Apprentice');
  });

  qa.add('ai.stays_out_of_fire', (c) => {
    const r0 = CONFIG.arena.fireRadius - 1.2;
    c.setup({ player: [0, -4], enemy: [r0, 0] });
    let maxR = 0;
    withAI(game, 'normal', (ai) =>
      c.step(5, () => {
        ai.update(DT);
        maxR = Math.max(maxR, Math.hypot(c.enemy.pos.x, c.enemy.pos.z));
      }),
    );
    const r = Math.hypot(c.enemy.pos.x, c.enemy.pos.z);
    c.expect(r < CONFIG.arena.fireRadius - 1, `AI ended at r=${r.toFixed(2)}, too close to the fire`);
    c.note(`end r=${r.toFixed(1)} max r=${maxR.toFixed(1)}`);
  });

  qa.add('ai.retreats_when_low_mana', (c) => {
    c.setup();
    withAI(game, 'normal', (ai) => {
      c.enemy.mana = 3;
      c.step(0.5, () => ai.update(DT));
      c.expect(ai.state === 'retreat', `state=${ai.state}, expected retreat`);
    });
  });

  qa.add('ai.uses_its_states', (c) => {
    c.setup({ player: [0, -14], enemy: [0, 14] });
    const seen = new Set<string>();
    withAI(game, 'hard', (ai) =>
      c.step(15, () => {
        ai.update(DT);
        seen.add(ai.state);
        c.player.health = c.enemy.health = CONFIG.wizard.maxHealth;
        // Player strafes and shoots back so the AI has threats to evade.
        c.player.intent.move.set(Math.sin(game.simTime * 1.3) > 0 ? 1 : -1, 0, 0);
        c.player.mana = 1e6;
        c.enemy.chest(c.player.aimPoint);
        c.player.intent.holdBolt = true;
      }),
    );
    c.note(`states=${[...seen].join(',')}`);
    for (const s of ['approach', 'attack', 'evade']) c.expect(seen.has(s), `never entered ${s}`);
  });
}
