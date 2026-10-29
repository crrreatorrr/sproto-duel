import { App } from '../App';
import { Game } from '../core/Game';
import { QAHarness } from './QAHarness';
import { registerAIScenarios } from './aiScenarios';
import { registerSpellScenarios } from './spellScenarios';
import { registerRegressionScenarios } from './regressionScenarios';
import { registerGamepadScenarios } from './gamepadScenarios';
import { registerJumpScenarios } from './jumpScenarios';
import { registerArenaScenarios } from './arenaScenarios';
import { registerCampaignScenarios } from './campaignScenarios';
import { registerArenaKitScenarios } from './arenaKitScenarios';
import { registerOfficeScenarios } from './officeScenarios';
import { registerSkinScenarios } from './skinScenarios';
import { registerStageScenarios } from './stageScenarios';
import { registerTicketScenarios } from './ticketScenarios';
import { registerDuoScenarios } from './duoScenarios';
import { registerLifePackScenarios } from './lifePackScenarios';
import { registerCinematicScenarios } from './cinematicScenarios';
import { registerMuzzleScenarios } from './muzzleScenarios';
import { registerRewardSpellScenarios } from './rewardSpellScenarios';
import { registerAnimScenarios } from './animScenarios';
import { registerRenderScenarios } from './renderScenarios';
import { registerPowerScenarios } from './powerScenarios';
import { registerArenaShiftScenarios } from './arenaShiftScenarios';
import { registerFeelScenarios } from './feelScenarios';
import { registerMenuScenarios } from './menuScenarios';
import { campaignSoak, soak, type CampaignSoakOptions } from './soak';
import { CONFIG, type Difficulty } from '../config';
import { BOSSES } from '../campaign/levels';
import type { ArenaThemeId } from '../arena/themes';

/** Dev-only console handle. Production builds do not import this module. */
export function installDevTools(game: Game, app: App): void {
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
  registerPowerScenarios(qa, game, app);
  registerArenaShiftScenarios(qa, game);
  registerFeelScenarios(qa, game);
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
