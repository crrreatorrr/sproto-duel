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
const F = CONFIG.campaign.fight;

/**
 * A Boss Gauntlet fight's clock and safety caps (CONFIG.campaign.fight), shared by Match and the
 * campaign soak. Counts fight time and time in the current stage; a stage running past `stageCap`
 * pulls the fire ring in to `stageCapRadius` (it opens again when the stage ends), and past
 * `safetyCap` the ring closes completely.
 */
export class GauntletClock {
  elapsed = 0;
  /** Seconds since a boss last transformed or fell (Game.fightProgress changed). */
  stageElapsed = 0;
  /** Fire ring radius now. */
  radius: number = A.fireRadius;
  private stage = 0;

  reset(): void {
    this.elapsed = this.stageElapsed = 0;
    this.stage = 0;
    this.radius = A.fireRadius;
  }

  /** The current stage has run past its cap (the ring is pulling in). */
  get stageCapped(): boolean {
    return this.stageElapsed > F.stageCap;
  }

  /** The whole fight has run past the safety cap (the ring closes all the way). */
  get capped(): boolean {
    return this.elapsed > F.safetyCap;
  }

  /** Advance one fight tick; `stage` is Game.fightProgress (any change restarts the stage clock). Returns the ring radius. */
  update(dt: number, stage: number): number {
    this.elapsed += dt;
    if (stage !== this.stage) {
      this.stage = stage;
      this.stageElapsed = 0;
    }
    this.stageElapsed += dt;
    const close = (over: number, to: number) => A.fireRadius + (to - A.fireRadius) * Math.min(1, over / F.capCloseTime);
    let target: number = A.fireRadius;
    if (this.stageCapped) target = close(this.stageElapsed - F.stageCap, F.stageCapRadius);
    if (this.capped) target = Math.min(target, close(this.elapsed - F.safetyCap, F.capMinRadius));
    // Closing follows the target; opening again (a new stage) is gradual.
    this.radius = target < this.radius ? target : Math.min(target, this.radius + F.reopenSpeed * dt);
    return this.radius;
  }
}

/**
 * Round flow: intro countdown, fight, KO (or timeout), results. Two modes:
 * - Quick Duel: best of three, each round on the `roundTime` clock with sudden death at the end.
 * - Boss Gauntlet (`single`): one round and one life. No clock: it counts up (`elapsed`), the
 *   player's KO is a defeat (Retry), and the round is won once every boss's last stage is
 *   depleted. After CONFIG.campaign.fight.safetyCap the fire ring closes so it always ends.
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
  /** The gauntlet's fight clock (counts up) and safety caps. */
  readonly clock = new GauntletClock();
  /** A Boss Gauntlet fight (there is a boss): one round, one life, no round timer. */
  get single(): boolean {
    return this.boss !== null;
  }
  /** Seconds left in the current intro/round-end phase. */
  phaseTime = 0;
  /** Campaign boss for this match (null in Quick Duel). */
  boss: BossDef | null = null;
  lastWinner: Wizard | null = null;
  roundWinners: (Wizard | null)[] = [];
  private lastCount = -1;
  private suddenDeathAnnounced = false;
  private capAnnounced = false;

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

  /** The player's side is out: the enemies take the round. */
  playerDown(): boolean {
    return !this.game.player.alive;
  }

  /** Every enemy in the fight is out (both bosses of a double fight): the player takes the round. */
  enemiesDown(): boolean {
    return this.game.enemies.every((w) => !w.alive);
  }

  /**
   * The side that has won by knockout (0 the player, 1 the enemies), or -1 while both still stand.
   * Rounds end on this; a single-round mode can reuse it as is.
   */
  koWinnerSide(): number {
    return this.playerDown() ? 1 : this.enemiesDown() ? 0 : -1;
  }

  /** A KO mid-fight: the round ends once a whole side is down; a lone fallen boss is called out. */
  private onKO(loser: Wizard): void {
    const side = this.koWinnerSide();
    if (side >= 0) {
      this.endRound(this.leader(side), 'ko');
      return;
    }
    events.emit('callout', { pos: loser.chest(new Vector3()).setY(loser.pos.y + loser.tagHeight), text: `${loser.name} is down!`, style: 'boss' });
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

  /** Rounds a side needs to take the match: 1 in the gauntlet, else CONFIG.match.roundsToWin. */
  get roundsToWin(): number {
    return this.single ? 1 : M.roundsToWin;
  }

  /** Seconds of fight phase this round (the gauntlet's clock counts up). */
  get elapsed(): number {
    return this.clock.elapsed;
  }

  /** A gauntlet safety cap (the stage's or the whole fight's) is pulling the fire ring in. */
  get capped(): boolean {
    return this.single && (this.clock.capped || this.clock.stageCapped);
  }

  get inRound(): boolean {
    return this.phase === 'intro' || this.phase === 'fight' || this.phase === 'roundEnd';
  }

  /** `boss`: the campaign fight being played (one round, one life), or null for a Quick Duel. */
  startMatch(boss: BossDef | null = null): void {
    this.boss = boss;
    // A fresh fight: its full budget of life packs (Retry too).
    this.game.lifePacks.reset();
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
    // Gauntlet fights last 15+ minutes: golden tickets come at their slower pace there.
    g.tickets.spawnInterval = this.single ? CONFIG.tickets.bossSpawnInterval : CONFIG.tickets.spawnInterval;
    this.timer = M.roundTime;
    this.clock.reset();
    this.phase = 'intro';
    this.phaseTime = M.introTime;
    this.lastCount = -1;
    this.suddenDeathAnnounced = false;
    this.capAnnounced = false;
    g.simulating = true;
    g.actionsLocked = true;
    events.emit('roundIntro', { round: this.round });
  }

  private update(dt: number): void {
    const g = this.game;
    g.actionsLocked = this.phase !== 'fight';
    g.tickets.enabled = this.phase === 'fight';
    g.lifePacks.enabled = this.phase === 'fight' && (this.single || CONFIG.lifePacks.quickDuel);
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
        if (this.single) {
          // No round clock: a stage (or the fight) past its safety cap pulls the fire ring in.
          g.arena.fireRadius = this.clock.update(dt, g.fightProgress());
          if (this.capped !== this.capAnnounced) {
            this.capAnnounced = this.capped;
            if (this.capped) events.emit('fightCap', {});
          }
          break;
        }
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
    const decided = this.wins[0] >= this.roundsToWin || this.wins[1] >= this.roundsToWin;
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
