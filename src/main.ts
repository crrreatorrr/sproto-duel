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
import { registerArenaKitScenarios } from './qa/arenaKitScenarios';
import { registerOfficeScenarios } from './qa/officeScenarios';
import { registerSkinScenarios } from './qa/skinScenarios';
import { registerStageScenarios } from './qa/stageScenarios';
import { registerTicketScenarios } from './qa/ticketScenarios';
import { registerDuoScenarios } from './qa/duoScenarios';
import { registerLifePackScenarios } from './qa/lifePackScenarios';
import { registerCinematicScenarios } from './qa/cinematicScenarios';
import { registerMuzzleScenarios } from './qa/muzzleScenarios';
import { registerRewardSpellScenarios } from './qa/rewardSpellScenarios';
import { registerAnimScenarios } from './qa/animScenarios';
import { registerRenderScenarios } from './qa/renderScenarios';
import { registerMenuScenarios } from './qa/menuScenarios';
import { campaignSoak, soak, type CampaignSoakOptions } from './qa/soak';
import { CONFIG, type Difficulty } from './config';
import { BOSSES } from './campaign/levels';
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
  registerDuoScenarios(qa, game, app);
  registerLifePackScenarios(qa, game, app);
  registerCinematicScenarios(qa, game, app);
  registerMuzzleScenarios(qa, game);
  registerRewardSpellScenarios(qa, game, app);
  registerMenuScenarios(qa, game, app);
  registerAnimScenarios(qa, game);
  registerOfficeScenarios(qa, game);
  registerArenaKitScenarios(qa, game);
  registerRenderScenarios(qa, game, app);
  const qaApi = Object.assign(qa, {
    /**
     * `await __duel.qa.soak('normal', 6)`: headless AI-vs-AI rounds for pacing and balance.
     * Add a theme to fight in that environment: `await __duel.qa.soak('normal', 6, 'office')`.
     */
    soak: (difficulty: Difficulty = 'normal', rounds = 6, theme?: ArenaThemeId) => soak(qa, game, difficulty, rounds, theme),
    /**
     * `await __duel.qa.campaignSoak(12)`: a reference AI fights each gauntlet boss `fights` times as
     * the real single-life fight; per boss: win rate, fight length, stage reached, minutes per stage,
     * boss damage per second per stage, life pack use. Options: `{ only: [4], immortal: true, seed: 1 }`.
     */
    campaignSoak: (fights = 4, opts: CampaignSoakOptions = {}) => campaignSoak(qa, game, fights, opts),
  });
  // `config` and `bosses` are the live tuning tables (edit them in the console to try values).
  (window as unknown as { __duel: unknown }).__duel = { game, app, qa: qaApi, config: CONFIG, bosses: BOSSES };
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${String(err?.stack ?? err)}</pre>`);
});
