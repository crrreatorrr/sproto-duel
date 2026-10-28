import './styles.css';
import { App } from './App';
import { Game } from './core/Game';
import { QAHarness } from './qa/QAHarness';
import { registerAIScenarios } from './qa/aiScenarios';
import { registerSpellScenarios } from './qa/spellScenarios';
import { registerRegressionScenarios } from './qa/regressionScenarios';
import { registerGamepadScenarios } from './qa/gamepadScenarios';
import { registerJumpScenarios } from './qa/jumpScenarios';
import { registerArenaScenarios } from './qa/arenaScenarios';
import { registerCampaignScenarios } from './qa/campaignScenarios';
import { registerOfficeScenarios } from './qa/officeScenarios';
import { registerSkinScenarios } from './qa/skinScenarios';
import { registerStageScenarios } from './qa/stageScenarios';
import { registerTicketScenarios } from './qa/ticketScenarios';
import { campaignSoak, soak } from './qa/soak';
import type { Difficulty } from './config';
import type { ArenaThemeId } from './arena/themes';

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
  registerGamepadScenarios(qa, game, app);
  registerJumpScenarios(qa, game);
  registerArenaScenarios(qa, game);
  registerCampaignScenarios(qa, game, app);
  registerSkinScenarios(qa, game, app);
  registerStageScenarios(qa, game, app);
  registerTicketScenarios(qa, game, app);
  registerOfficeScenarios(qa, game);
  const qaApi = Object.assign(qa, {
    /**
     * `await __duel.qa.soak('normal', 6)`: headless AI-vs-AI rounds for pacing and balance.
     * Add a theme to fight in that environment: `await __duel.qa.soak('normal', 6, 'office')`.
     */
    soak: (difficulty: Difficulty = 'normal', rounds = 6, theme?: ArenaThemeId) => soak(qa, game, difficulty, rounds, theme),
    /** `await __duel.qa.campaignSoak(4)`: a reference AI vs each gauntlet boss, round lengths per boss. */
    campaignSoak: (rounds = 4, reference: Difficulty = 'normal') => campaignSoak(qa, game, rounds, reference),
  });
  (window as unknown as { __duel: unknown }).__duel = { game, app, qa: qaApi };
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${String(err?.stack ?? err)}</pre>`);
});
