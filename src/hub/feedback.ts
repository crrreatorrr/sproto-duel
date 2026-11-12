/**
 * In-game feedback: N twice (or the pause menu's Send Feedback) opens the hub SDK's feedback
 * window. The window, the screenshot and the sending live in the vendored SDK; this is only Sproto
 * Duel's adapter: how to freeze and unfreeze the game, and what "right now" looks like. The SDK
 * draws the HTML menus and HUD over the arena canvas itself (0.7.2).
 * See docs/feedback.md in metaverse-hub.
 */
import { feedbackTransportFromSdk, installFeedback, type FeedbackContext, type FeedbackHandle } from '@metaverse/hub-sdk';
import type { App, FeedbackHold } from '../App';
import type { Game } from '../core/Game';
import type { Wizard } from '../wizard/Wizard';
import { crashGuard } from '../core/crash';
import { events } from '../core/events';
import { BOSSES } from '../campaign/levels';
import type { HubLink } from './link';

const MODE_LABEL = { quick: 'Quick Duel', gauntlet: 'Boss Gauntlet', versus: 'Local Versus', online: 'Online Duel', practice: 'Practice' } as const;

const round1 = (n: number) => Math.round(n * 10) / 10;
const xyz = (w: Wizard) => ({ x: round1(w.pos.x), y: round1(w.pos.y), z: round1(w.pos.z) });

/** A snapshot of the fight for a feedback note. Read only; called once, when the window opens. */
export function feedbackContext(game: Game, app: App): FeedbackContext {
  const m = app.match;
  const p = game.player;
  const e = game.enemy;
  const boss = m.boss;
  const fighting = app.state === 'playing' || app.state === 'paused';
  const opponent = boss ? boss.name : e.name;
  const extra: Record<string, unknown> = {
    screen: app.state,
    menu: app.menus.current,
    phase: m.phase,
    opponent,
    opponentHealth: Math.round(e.health),
    opponentMaxHealth: Math.round(e.maxHealth),
    opponentPosition: xyz(e),
    difficulty: boss ? `gauntlet fight ${m.bossIndex + 1} of ${BOSSES.length}` : app.mode === 'quick' ? game.simDifficulty : 'normal',
    wins: [...m.wins],
    godMode: app.godUsed,
    inputDevice: game.input.pad.device,
  };
  if (boss) extra.bossStage = (game.stagesOf(e)?.stage ?? 0) + 1;
  if (game.partnerActive) {
    extra.partner = game.partner.name;
    extra.partnerHealth = Math.round(game.partner.health);
  }
  if (app.mode === 'online') extra.onlineRole = app.onlineCtl ? (app.onlineCtl.isHost ? 'host' : 'guest') : 'lobby';
  return {
    level: fighting ? `${game.arena.theme} · vs ${opponent}` : `${game.arena.theme} · menu`,
    mode: MODE_LABEL[app.mode] ?? app.mode,
    position: xyz(p),
    gameTime: round1(m.elapsed),
    player: {
      health: Math.round(p.health),
      maxHealth: Math.round(p.maxHealth),
      mana: Math.round(p.mana),
      ult: Math.round(p.ult),
      staff: p.staff?.id ?? null,
      casting: p.cast?.spell ?? null,
      round: m.round,
      alive: p.alive,
      learned: [...p.learned],
    },
    extra,
  };
}

/** Install the feedback shortcut and window. Call once, after the App exists. */
export function installGameFeedback(game: Game, app: App, hub: HubLink): FeedbackHandle | null {
  // The crash guard counts errors but keeps no list: keep the last few here for the note.
  const errors: { message: string; stack: string; at: number; source: string }[] = [];
  crashGuard.onCrash((r) => {
    errors.push({ message: r.message, stack: r.stack, at: Math.round(performance.now()), source: r.source });
    if (errors.length > 10) errors.shift();
  });

  let handle: FeedbackHandle;
  try {
    handle = installFeedback({
      title: 'Sproto Duel',
      version: __BUILD_ID__,
      // A visit without a hub session answers `standalone`: the SDK shows a one-line message.
      transport: feedbackTransportFromSdk(hub.sdk),
      pause: () => app.holdForFeedback(),
      resume: (token) => app.releaseFeedback(token as FeedbackHold),
      onClose: () => app.endFeedback(),
      context: () => {
        try {
          return feedbackContext(game, app);
        } catch {
          return { mode: app.mode };
        }
      },
      // The loop renders while paused, but not once the crash guard has stopped it, and the
      // drawing buffer is not preserved: draw one frame so the screenshot is never blank.
      beforeCapture: () => game.renderer.render(),
      canvases: () => [game.renderer.canvas],
      errors: () => errors,
      theme: {
        font: "'Rajdhani', 'Segoe UI', system-ui, sans-serif",
        titleFont: "'Cinzel', 'Trajan Pro', Georgia, serif",
        background: 'rgba(6, 4, 14, 0.62)',
        panel: 'rgba(14, 10, 28, 0.96)',
        text: '#f3ecff',
        muted: '#b8acd6',
        accent: '#ffd27a',
        accentText: '#1a1206',
        border: 'rgba(190, 170, 255, 0.22)',
        radius: '8px',
        css: '.root { font-size: 16px; font-weight: 600; } .title { letter-spacing: 0.08em; text-transform: uppercase; color: #ffd27a; }',
      },
    });
  } catch (err) {
    // Feedback is an extra: it must never stop the game from starting.
    console.warn('[feedback] not installed', err);
    return null;
  }
  app.onFeedback = () => handle.open();

  // Breadcrumbs: the last few fight events, sent with a note. Listeners only; no game logic.
  const side = (w: Wizard | null) => (w === null ? 'draw' : w === game.player ? 'player' : w.name);
  let lastMode = '';
  events.on('roundStart', ({ round }) => {
    if (app.mode !== lastMode) {
      lastMode = app.mode;
      handle.breadcrumb('mode', { mode: app.mode });
    }
    if (round === 1) handle.breadcrumb('duel_start', { mode: app.mode, arena: game.arena.theme, opponent: app.match.boss?.name ?? game.enemy.name });
    else handle.breadcrumb('round_start', { round });
  });
  events.on('roundEnd', ({ winner, reason }) => handle.breadcrumb('round_end', { round: app.match.round, winner: side(winner), reason }));
  events.on('ko', ({ loser }) => handle.breadcrumb(loser === game.player ? 'death' : 'ko', { who: side(loser), t: round1(app.match.elapsed) }));
  events.on('bossStage', ({ stage, boss }) => {
    if (boss && stage > 0) handle.breadcrumb('boss_stage', { boss: boss.name, stage: stage + 1 });
  });
  events.on('matchEnd', ({ winner }) => handle.breadcrumb(winner === game.player ? 'win' : 'loss', { mode: app.mode, winner: side(winner), wins: [...app.match.wins] }));
  return handle;
}
