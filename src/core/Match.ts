import { Vector3 } from 'three';
import { CONFIG } from '../config';
import { BOSSES, type BossDef } from '../campaign/levels';
import { events } from './events';
import { feel } from './feel';
import type { Game } from './Game';
import type { Wizard } from '../wizard/Wizard';

export type Phase = 'menu' | 'intro' | 'fight' | 'roundEnd' | 'matchEnd';

const M = CONFIG.match;
const A = CONFIG.arena;

/**
 * Best-of-N round flow: intro countdown, fight with timer and sudden death, KO/timeout, results.
 * Sides, not wizards, win: the player's side (0) takes a round by knocking out every enemy (both
 * bosses in a double fight; a fallen one stays down), the enemies' side (1) by knocking out the
 * player. `wins` is indexed by side. Winners are reported as the side's leader: `game.player` or
 * `game.enemy`.
 */
export class Match {
  phase: Phase = 'menu';
  round = 1;
  /** Rounds won per side: [player, enemies]. */
  readonly wins = [0, 0];
  timer: number = M.roundTime;
  /** Seconds left in the current intro/round-end phase. */
  phaseTime = 0;
  /** Campaign boss for this match (null in Quick Duel). */
  boss: BossDef | null = null;
  lastWinner: Wizard | null = null;
  roundWinners: (Wizard | null)[] = [];
  private lastCount = -1;
  private suddenDeathAnnounced = false;

  constructor(private readonly game: Game) {
    events.on('ko', (e) => {
      if (this.phase === 'fight' && !game.qaMode) this.onKO(e.loser);
    });
    game.onTick((dt) => this.update(dt));
  }

  /** The wizard reported as `side`'s winner. */
  leader(side: number): Wizard {
    return side === 0 ? this.game.player : this.game.enemy;
  }

  /** A KO mid-fight: the round ends once a whole side is down; a lone fallen boss is called out. */
  private onKO(loser: Wizard): void {
    const g = this.game;
    const team = loser.side === 0 ? [g.player] : g.enemies;
    if (team.some((w) => w.alive)) {
      events.emit('callout', { pos: loser.chest(new Vector3()).setY(loser.pos.y + loser.tagHeight), text: `${loser.name} is down!`, style: 'boss' });
      return;
    }
    this.endRound(this.leader(1 - loser.side), 'ko');
  }

  /**
   * Who wins on time: the player's health fraction against the enemies' combined fraction (their
   * health over their max health, KO'd ones at 0). Equal is a draw (null).
   */
  timeoutWinner(): Wizard | null {
    const g = this.game;
    const p = g.player.health / g.player.maxHealth;
    let hp = 0, max = 0;
    for (const e of g.enemies) {
      hp += e.health;
      max += e.maxHealth;
    }
    const e = max > 0 ? hp / max : 0;
    return Math.abs(p - e) < 1e-9 ? null : p > e ? g.player : this.leader(1);
  }

  /** 0-based position of this match's boss in the gauntlet, or -1. */
  get bossIndex(): number {
    return this.boss ? BOSSES.indexOf(this.boss) : -1;
  }

  get inRound(): boolean {
    return this.phase === 'intro' || this.phase === 'fight' || this.phase === 'roundEnd';
  }

  /** `boss`: the campaign fight being played, or null for a Quick Duel. */
  startMatch(boss: BossDef | null = null): void {
    this.boss = boss;
    this.round = 1;
    this.wins[0] = this.wins[1] = 0;
    this.roundWinners = [];
    for (const w of this.game.wizards) {
      w.ult = 0;
      w.resetStats();
    }
    this.startRound();
  }

  startRound(): void {
    const g = this.game;
    g.resetArena();
    for (const w of g.wizards) {
      w.resetForRound(M.ultCarriesOver);
      w.visual.celebrate = false;
    }
    g.spawnWizards();
    g.enemyController?.reset?.();
    this.timer = M.roundTime;
    this.phase = 'intro';
    this.phaseTime = M.introTime;
    this.lastCount = -1;
    this.suddenDeathAnnounced = false;
    g.simulating = true;
    g.actionsLocked = true;
    events.emit('roundIntro', { round: this.round });
  }

  private update(dt: number): void {
    const g = this.game;
    g.actionsLocked = this.phase !== 'fight';
    switch (this.phase) {
      case 'intro': {
        this.phaseTime -= dt;
        const count = Math.ceil(this.phaseTime / (M.introTime / 3));
        if (count !== this.lastCount && count > 0 && count <= 3) {
          this.lastCount = count;
          events.emit('countdown', { value: count });
        }
        if (this.phaseTime <= 0) {
          this.phase = 'fight';
          g.actionsLocked = false;
          events.emit('roundStart', { round: this.round });
        }
        break;
      }
      case 'fight': {
        this.timer = Math.max(0, this.timer - dt);
        if (this.timer < A.suddenDeathAt) {
          if (!this.suddenDeathAnnounced) {
            this.suddenDeathAnnounced = true;
            events.emit('suddenDeath', {});
          }
          const t = this.timer / A.suddenDeathAt; // 1 -> 0
          g.arena.fireRadius = A.suddenDeathMinRadius + (A.fireRadius - A.suddenDeathMinRadius) * t;
        }
        if (this.timer <= 0) this.endRound(this.timeoutWinner(), 'time');
        break;
      }
      case 'roundEnd': {
        this.phaseTime -= dt;
        const won = this.lastWinner;
        for (const w of g.wizards) if (w.alive && won && w.side === won.side) w.visual.celebrate = true;
        if (this.phaseTime <= 0) this.next();
        break;
      }
      default:
        break;
    }
  }

  private endRound(winner: Wizard | null, reason: 'ko' | 'time'): void {
    this.phase = 'roundEnd';
    this.phaseTime = M.roundEndTime;
    this.lastWinner = winner;
    this.roundWinners.push(winner);
    if (winner) this.wins[winner.side]++;
    if (reason === 'ko') feel.slowMo(CONFIG.feel.koSlowMoScale, CONFIG.feel.koSlowMoTime);
    events.emit('roundEnd', { winner, reason });
  }

  private next(): void {
    const decided = this.wins[0] >= M.roundsToWin || this.wins[1] >= M.roundsToWin;
    if (decided) {
      this.phase = 'matchEnd';
      const winner = this.leader(this.wins[0] > this.wins[1] ? 0 : 1);
      events.emit('matchEnd', { winner });
      return;
    }
    this.round++;
    this.startRound();
  }
}
