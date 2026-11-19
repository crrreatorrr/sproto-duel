import './styles.css';
import { App } from './App';
import { Game } from './core/Game';
import { Campaign } from './campaign/Campaign';
import { connectHub } from './hub/link';
import { HUB_GAME_ID } from './hub/config';
import { hubVisitStarting } from '@metaverse/hub-sdk';
import { crashGuard } from './core/crash';
import { setLoadoutAccount } from './staff/loadout';
import { setSkinAccount } from './campaign/skins';
import { showCrashPanel } from './ui/CrashPanel';

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
  const attached = hub.connected && hub.playerId ? campaign.attach(hub.sdk, hub.playerId) : (campaign.release(), Promise.resolve());
  // The equipped staff and the skin belong to the account too (App reads them as it starts).
  const account = hub.connected && hub.playerId ? hub.playerId : null;
  setLoadoutAccount(account);
  setSkinAccount(account);
  loading.remove();
  const app = new App(game, campaign, hub);
  game.start();
  // N twice (or the pause menu's button) opens the hub feedback window. It and its screenshot code
  // load after the first frames, off the boot path.
  whenIdle(() => {
    void import('./hub/feedback').then(({ installGameFeedback }) => installGameFeedback(game, app, hub)).catch((err) => console.warn('[feedback] not loaded', err));
  }, import.meta.env.DEV ? 0 : 1000);
  // Fight sounds and battle music (the menu's three sounds loaded with the page): once it is idle.
  whenIdle(() => app.audio.loadAll(), import.meta.env.DEV ? 0 : 2500);

  if (import.meta.env.DEV) {
    const netsim = new URLSearchParams(location.search).get('netsim');
    if (netsim !== null) {
      const { netsimLobby } = await import('./net/devNetsim');
      app.devLobby = () => netsimLobby(Math.max(0, Number(netsim) || 80));
      // The title screen was drawn before this lobby existed. Repaint so Online is playable.
      if (app.state === 'menu' && app.menus.current === 'main') app.toMenu();
    }
    // QA scenarios dress bosses synchronously: every model is in before the harness appears.
    await Promise.all([game.assets.prefetchBosses(), game.assets.prefetchStaffs()]);
    const { installDevTools } = await import('./qa/dev');
    installDevTools(game, app);
  } else {
    // The next gauntlet boss's models arrive in the background once the menu is up (not all 18
    // stage models: the other bosses load when the gauntlet reaches them, see App.showBossCard),
    // and once a hub account's cloud save is in, so it is that save's next boss.
    const settled = attached.then(() => undefined, () => undefined);
    setTimeout(() => void settled.then(() => app.prefetchNextBoss()), 1500);
  }
}

/** Run `fn` after `delayMs`, at the next idle moment (rIC where the browser has it). */
function whenIdle(fn: () => void, delayMs: number): void {
  setTimeout(() => {
    if ('requestIdleCallback' in window) requestIdleCallback(() => fn(), { timeout: 2000 });
    else fn();
  }, delayMs);
}

// A failed boot (an asset, the physics module) shows the same panel, with Retry and the details.
boot().catch((err) => {
  document.querySelector('#ui > .loading')?.remove();
  crashGuard.report(err, 'boot');
});
