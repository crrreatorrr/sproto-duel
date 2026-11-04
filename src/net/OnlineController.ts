/**
 * Wires an OnlineSession to the Game for one online match.
 *
 * Seats: each client plays its own wizard as `game.player` (camera, HUD "you", blue) and the
 * opponent as `game.enemy`. `seats` maps network seats to those local wizards, so snapshots,
 * events, rounds and results travel by seat.
 *
 * Host: the full sim runs with ONLINE rules and `fixedTimeScale`; the guest's wizard is driven by
 * a RemoteSource from the session's input buffer; every `snapEveryTicks` a snapshot (with the
 * events recorded since the last one) goes out; ROUND after each round and RESULT at the end.
 * Guest (replica): no gameplay runs; local input is sampled per tick and sent; snapshots are
 * applied (both wizards interpolated, projectiles extrapolated) and the host's events re-emitted,
 * so HUD, audio and effects behave as offline. RESULT goes out from the replicated matchEnd.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import { events, type GameEvents } from '../core/events';
import type { Game } from '../core/Game';
import type { Match } from '../core/Match';
import type { Wizard } from '../wizard/Wizard';
import { EventPlayer, EventRecorder, NET_EVENT_NAMES, type EventWorld } from './events';
import { encodeIntent, pressCounters } from './intent';
import type { OnlineSession } from './OnlineSession';
import type { StartMsg } from './protocol';
import { RemoteSource } from './RemoteSource';
import { applyProjectiles, applySnapshot, captureSnapshot } from './snapshot';
import { emptyPose } from './SnapshotBuffer';
import { encodeSnapshot, type Snapshot } from './state';
import type { Scheduler } from './transport';

const N = CONFIG.net;

export class OnlineController {
  /** Wizards by network seat. */
  seats: Wizard[] = [];
  private readonly offs: (() => void)[] = [];
  private recorder: EventRecorder<Wizard, THREE.Vector3> | null = null;
  private player: EventPlayer<Wizard, THREE.Vector3> | null = null;
  private lastPresses = pressCounters();
  private rounds = 0;
  private resultSent = false;
  private readonly pose = emptyPose();
  /** Snapshots sent (host) or applied (guest). */
  snapshots = 0;
  /** Guest: point the camera at the replicated pose on the next frame (match and round starts). */
  private needSnap = true;
  active = false;

  constructor(
    private readonly game: Game,
    private readonly match: Match,
    readonly session: OnlineSession,
    private readonly scheduler: Scheduler,
  ) {}

  get isHost(): boolean {
    return this.session.isHost;
  }

  private world(): EventWorld<Wizard, THREE.Vector3> {
    return {
      seatOf: (w) => this.seats.indexOf(w),
      wizardAt: (s) => this.seats[s] ?? null,
      vec: (x, y, z) => new THREE.Vector3(x, y, z),
    };
  }

  /**
   * START arrived: set the game up for this match's role. The caller has dressed the arena and
   * the HUD and starts the Match (host) right after.
   */
  begin(start: StartMsg): void {
    const g = this.game;
    this.stop();
    this.active = true;
    this.rounds = 0;
    this.resultSent = false;
    this.snapshots = 0;
    this.lastPresses = pressCounters();
    this.seats = start.seat === 0 ? [g.player, g.enemy] : [g.enemy, g.player];
    g.fixedTimeScale = true;
    g.enemyController = null;
    g.enemy.intent.clear();
    if (this.isHost) {
      g.role = 'host';
      g.controllers[1] = new RemoteSource(g.enemy, this.session.remoteInput);
      const rec = (this.recorder = new EventRecorder(this.world()));
      for (const name of NET_EVENT_NAMES) {
        this.offs.push(events.on(name as keyof GameEvents, (p) => rec.record(name, p as unknown as Record<string, unknown>)));
      }
      g.onTick(this.hostTick);
    } else {
      g.role = 'replica';
      g.controllers[1] = null;
      g.spells.pool.releaseAll();
      this.player = new EventPlayer(this.world(), (name, payload) => events.emit(name as keyof GameEvents, payload as never));
      this.offs.push(this.session.on('snapshot', (snap) => this.onSnapshot(snap)));
      g.replicaHooks.push(this.guestTick);
      // A new round on the host: clear the replica's arena the way Match.startRound does there.
      this.needSnap = true;
      this.offs.push(events.on('roundIntro', () => {
        if (g.role !== 'replica') return;
        g.resetArena();
        // The host respawned everyone: face the way the replicated wizard does, once it has moved there.
        this.needSnap = true;
      }));
    }
    this.offs.push(events.on('roundEnd', (e) => this.onRoundEnd(e.winner, e.reason)));
    this.offs.push(events.on('matchEnd', (e) => this.onMatchEnd(e.winner)));
  }

  /** Host, every fixed tick (a Game tick hook): stream a snapshot every snapEveryTicks. */
  private readonly hostTick = (): void => {
    if (!this.active || this.game.role !== 'host' || this.session.state !== 'playing') return;
    if (this.game.simTick % N.snapEveryTicks !== 0) return;
    const snap = captureSnapshot(this.game, this.match, this.game.simTick, this.session.remoteInput.lastApplied, this.seats);
    const ev = this.recorder?.take();
    if (ev) snap.ev = ev;
    this.session.sendSnapshot(encodeSnapshot(snap));
    this.snapshots++;
  };

  /** Guest, every fixed tick: sample the local intent and queue it for the host. */
  private readonly guestTick = (_dt: number, simTick: number): void => {
    if (!this.active || this.session.state !== 'playing') return;
    const p = this.game.player;
    this.session.queueInput(encodeIntent(p.intent, p.aimPoint, this.lastPresses, simTick));
  };

  private onSnapshot(snap: Snapshot): void {
    if (!this.active) return;
    applySnapshot(this.game, this.match, snap, { seats: this.seats, skipMovement: [0, 1], projectiles: false });
    if (snap.ev) this.player?.play(snap.ev);
    this.snapshots++;
  }

  /** Every rendered frame: PINGs, and on a replica the interpolated wizards and projectiles. */
  frame(): void {
    if (!this.active) return;
    const now = this.scheduler.now();
    this.session.update(now);
    if (this.game.role !== 'replica' || !this.session.snapshots.newest) return;
    const pose = this.pose;
    this.seats.forEach((w, seat) => {
      if (!this.session.snapshots.sampleWizard(seat, now, pose)) return;
      w.pos.set(pose.pos[0], pose.pos[1], pose.pos[2]);
      w.prevPos.copy(w.pos);
      w.vel.set(pose.vel[0], 0, pose.vel[1]);
      w.vy = pose.vy;
      w.grounded = pose.grounded;
      w.facing = w.prevFacing = pose.facing;
      w.placeBody();
    });
    if (this.needSnap && this.match.phase === 'intro') {
      // Our wizard's spawn mark on the host may be the far side (seat 1): snap the camera behind it
      // once the interpolated pose (100 ms behind) has reached the newest snapshot's.
      const p = this.game.player;
      const mine = this.session.snapshots.newest?.wizards[this.session.seat];
      if (mine && Math.hypot(mine.pos[0] - p.pos.x, mine.pos[2] - p.pos.z) < 0.3) {
        this.game.rig.snap(p.pos, p.facing);
        this.needSnap = false;
      }
    }
    applyProjectiles(this.game, this.session.snapshots.extrapolatedProjectiles(now), this.seats);
    for (const p of this.game.spells.pool.active) p.prevPos.copy(p.pos);
  }

  private winsBySeat(): [number, number] {
    return [this.match.wins[this.seats[0].side], this.match.wins[this.seats[1].side]];
  }

  private onRoundEnd(winner: Wizard | null, reason: 'ko' | 'time'): void {
    if (!this.active) return;
    this.rounds++;
    if (!this.isHost) {
      // The replica's round strip (the host's Match keeps its own).
      this.match.roundWinners.push(winner);
      return;
    }
    const s = winner ? this.seats.indexOf(winner) : -1;
    this.session.sendRound({ round: this.rounds, winnerSeat: s === 0 || s === 1 ? s : null, reason, wins: this.winsBySeat() });
  }

  private onMatchEnd(winner: Wizard | null): void {
    if (!this.active || this.resultSent) return;
    this.resultSent = true;
    const s = winner ? this.seats.indexOf(winner) : -1;
    this.session.sendResult({ winnerSeat: s === 0 || s === 1 ? s : null, wins: this.winsBySeat(), rounds: this.rounds });
  }

  /** Back to a local game: roles, controllers and hooks undone. */
  stop(): void {
    const g = this.game;
    for (const off of this.offs) off();
    this.offs.length = 0;
    const i = g.replicaHooks.indexOf(this.guestTick);
    if (i >= 0) g.replicaHooks.splice(i, 1);
    g.offTick(this.hostTick);
    if (g.controllers[1] instanceof RemoteSource) g.controllers[1] = null;
    if (this.active) {
      g.role = 'local';
      g.fixedTimeScale = false;
    }
    this.recorder = null;
    this.player = null;
    this.active = false;
  }
}
