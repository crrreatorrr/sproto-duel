import './styles.css';
import { App } from './App';
import { Game } from './core/Game';
import { Campaign } from './campaign/Campaign';
import { connectHub } from './hub/link';
import { HUB_GAME_ID } from './hub/config';
import { hubVisitStarting } from '@metaverse/hub-sdk';
import { crashGuard } from './core/crash';
import { showCrashPanel } from './ui/CrashPanel';
import { installGameFeedback } from './hub/feedback';

// Uncaught errors and rejections share the loop's counter; the panel opens once the game pauses.
crashGuard.install(window, document);
crashGuard.onFatal((report) => showCrashPanel(report));

async function boot() {
  const container = document.getElementById('game')!;
  const ui = document.getElementById('ui')!;
  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.textContent = 'Summoning the arena…';
  ui.appendChild(loading);

  // Progress belongs to the hub account that earned it. A portal ticket or a live session: hold
  // progress until the account is known, so nothing lands in this browser's own copy.
  const campaign = new Campaign();
  if (hubVisitStarting(HUB_GAME_ID)) campaign.hold();
  addEventListener('storage', (e) => {
    if (campaign.watches(e.key)) campaign.refresh();
  });
  addEventListener('pagehide', () => void campaign.flush());

  // A portal ticket is redeemed while the arena loads. No ticket: standalone, same as before.
  const hubPromise = connectHub();
  const game = await Game.create(container, ui);
  const hub = await hubPromise;
  // A live session: the account's own progress, synced with its cloud save. Otherwise this browser's.
  if (hub.connected && hub.playerId) void campaign.attach(hub.sdk, hub.playerId);
  else campaign.release();
  loading.remove();
  const app = new App(game, campaign, hub);
  // N twice (or the pause menu's button) opens the hub feedback window.
  installGameFeedback(game, app, hub);
  game.start();

  if (import.meta.env.DEV) {
    const netsim = new URLSearchParams(location.search).get('netsim');
    if (netsim !== null) {
      const { netsimLobby } = await import('./net/devNetsim');
      app.devLobby = () => netsimLobby(Math.max(0, Number(netsim) || 80));
      // The title screen was drawn before this lobby existed. Repaint so Online is playable.
      if (app.state === 'menu' && app.menus.current === 'main') app.toMenu();
    }
    // QA scenarios dress bosses synchronously: every model is in before the harness appears.
    await game.assets.prefetchBosses();
    const { installDevTools } = await import('./qa/dev');
    installDevTools(game, app);
  } else {
    // The gauntlet's boss models arrive in the background once the menu is up.
    setTimeout(() => void game.assets.prefetchBosses(), 1500);
  }
}

// A failed boot (an asset, the physics module) shows the same panel, with Retry and the details.
boot().catch((err) => {
  document.querySelector('#ui > .loading')?.remove();
  crashGuard.report(err, 'boot');
});
