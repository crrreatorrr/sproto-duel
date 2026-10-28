import './styles.css';
import { App } from './App';
import { Game } from './core/Game';
import { QAHarness } from './qa/QAHarness';
import { registerAIScenarios } from './qa/aiScenarios';
import { registerSpellScenarios } from './qa/spellScenarios';
import { registerRegressionScenarios } from './qa/regressionScenarios';
import { registerArenaScenarios } from './qa/arenaScenarios';
import { soak } from './qa/soak';
import type { Difficulty } from './config';

async function boot() {
  const container = document.getElementById('game')!;
  const ui = document.getElementById('ui')!;
  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.textContent = 'Summoning the arena…';
  ui.appendChild(loading);

  const game = await Game.create(container, ui);
  loading.remove();
  const app = new App(game);
  game.start();

  // Debug/QA handle: `await __duel.qa.runAll()` in the console.
  const qa = new QAHarness(game);
  registerSpellScenarios(qa, game);
  registerAIScenarios(qa, game);
  registerRegressionScenarios(qa, game);
  registerArenaScenarios(qa, game);
  const qaApi = Object.assign(qa, {
    /** `await __duel.qa.soak('normal', 6)`: headless AI-vs-AI rounds for pacing and balance. */
    soak: (difficulty: Difficulty = 'normal', rounds = 6) => soak(qa, game, difficulty, rounds),
  });
  (window as unknown as { __duel: unknown }).__duel = { game, app, qa: qaApi };
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${String(err?.stack ?? err)}</pre>`);
});
