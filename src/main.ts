import './styles.css';
import { App } from './App';
import { Game } from './core/Game';
import { Campaign } from './campaign/Campaign';
import { connectHub } from './hub/link';

async function boot() {
  const container = document.getElementById('game')!;
  const ui = document.getElementById('ui')!;
  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.textContent = 'Summoning the arena…';
  ui.appendChild(loading);

  // A portal ticket is redeemed while the arena loads. No ticket: standalone, same as before.
  const hubPromise = connectHub();
  const game = await Game.create(container, ui);
  const hub = await hubPromise;
  loading.remove();
  const app = new App(game, new Campaign(), hub);
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

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${String(err?.stack ?? err)}</pre>`);
});
