/**
 * Runs a match on the deterministic sim (src/sim-core) and makes the game follow it.
 *
 * Every fixed tick: each input seat's intent (local humans, an online guest's frames) is quantized
 * into a SimInput and recorded in the input log; the sim steps; its state is written onto the
 * game's wizards, projectiles, cover, tickets and match (the visuals read those as before); and its
 * events are turned into the game's event bus plus the effects SpellSystem used to play inline.
 * The game's own gameplay code (SpellSystem.update, Wizard.updateMovement, Match flow, the AI) does
 * not run while a driver is active. Rapier stays for the camera and the crosshair raycast.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import {
  LogRecorder, ONE, SimWorld, TURN, emptyInput, type DuelLog, type SimEvent, type SimInput, type SimSetup, type SimWizard,
} from '../sim-core';
import { SURFACE_FLOOR, SURFACE_PILLAR, SURFACE_WALL } from '../sim-core/spells';
import type { Wizard } from '../wizard/Wizard';
import type { CastKind } from '../wizard/muzzles';
import type { Game } from './Game';
import { events, type DamageKind, type GameEvents } from './events';
import type { SpellId } from '../spells/types';
import type { RewardSpellId } from '../spells/rewardCatalog';
import type { SimHazardView } from '../spells/BossPowers';
import { feel } from './feel';
import { sampleSimInput, simPressCounters } from './simInput';

const S = CONFIG.spells;
const q = (v: number) => v / ONE;
const sec = (tu: number) => tu / 6000;
const rad = (a: number) => (a / TURN) * Math.PI * 2;

const tmp = new THREE.Vector3();
const tmpDir = new THREE.Vector3();

/** What the game reads off a finished sim match. */
export interface SimOutcome {
  log: DuelLog;
  winnerSeat: 0 | 1 | null;
}

export class SimDriver {
  readonly world: SimWorld;
  readonly recorder: LogRecorder;
  /** Game wizard for each sim wizard index (online: by network seat). */
  readonly seats: Wizard[];
  private readonly counters: Record<string, number>[] = [];
  private readonly inputs: (SimInput | null)[] = [null, null, null];
  /** Spell-wave effects by sim wave id. */
  private readonly waves = new Map<number, NonNullable<ReturnType<Game['spells']['spellFx']['wave']>>>();
  /** Sim tick of the last state applied. */
  applied = 0;

  constructor(
    private readonly game: Game,
    setup: SimSetup,
    seats: Wizard[],
  ) {
    this.world = new SimWorld(setup);
    this.seats = seats;
    this.recorder = new LogRecorder(this.world);
    for (let i = 0; i < this.world.inputSeats().length; i++) this.counters.push(simPressCounters());
    // Counters start where the intents are now, so presses made before the match don't fire.
    this.world.inputSeats().forEach((s, i) => Object.assign(this.counters[i], seats[s].intent.presses));
    this.apply();
    this.present();
  }

  get over(): boolean {
    return this.world.over;
  }

  /** One fixed tick: sample, record, step, apply, present. */
  tick(): void {
    if (this.world.over) return;
    const ws = this.world.inputSeats();
    for (let i = 0; i < ws.length; i++) {
      const gw = this.seats[ws[i]];
      const f = sampleSimInput(gw.intent, gw.aimPoint, this.counters[i], this.world.wizards[ws[i]]);
      this.inputs[ws[i]] = f;
      this.recorder.frame(i, f);
    }
    this.world.step(this.inputs);
    this.recorder.after();
    this.apply();
    this.present();
    const g = this.game, dt = 1 / 60;
    g.spells.presentTick(dt);
    g.arena.updatePresentation(dt);
    g.stages.update(dt);
    g.partnerStages.update(dt);
  }

  /** A seat leaves (online forfeit): recorded, and the other side wins. */
  forfeit(seat: number): void {
    if (this.world.over) return;
    this.recorder.markForfeit(seat);
    this.world.forfeit(seat);
    this.apply();
    this.present();
  }

  /**
   * God mode on or off mid-fight, from the next tick: recorded in the log so the replay matches.
   * False when it could not apply (the match is over, or the log holds no more toggles).
   */
  setGodMode(on: boolean): boolean {
    if (this.world.over || this.world.godMode === on) return !this.world.over;
    if (!this.recorder.markGodMode(on)) return false;
    this.world.setGodMode(on);
    this.apply();
    return true;
  }

  /** The input log so far, with the result claimed from the sim. */
  log(): DuelLog {
    const m = this.world.match;
    return this.recorder.log({
      winnerSeat: this.world.over ? (m.winner as 0 | 1) : null,
      wins: [m.wins[0], m.wins[1]],
      rounds: m.roundWinners.length,
      ticks: this.world.tick,
      bossId: this.world.setup.bossId ?? null,
    });
  }

  // ---------------------------------------------------------------- state

  private apply(): void {
    const g = this.game;
    const sw = this.world;
    sw.wizards.forEach((s, i) => applyWizard(this.seats[i], s));
    // Projectiles by id.
    const pool = g.spells.pool;
    const want = new Map<number, (typeof sw.spells.active)[number]>();
    for (const p of sw.spells.active) want.set(p.id, p);
    for (let i = pool.active.length - 1; i >= 0; i--) if (!want.has(pool.active[i].netId)) pool.release(pool.active[i]);
    const have = new Map<number, (typeof pool.active)[number]>();
    for (const p of pool.active) have.set(p.netId, p);
    for (const s of sw.spells.active) {
      const owner = this.seats[s.owner.index];
      let p = have.get(s.id);
      const fresh = !p;
      if (!p) {
        p = pool.spawn(s.kind) ?? undefined;
        if (!p) continue;
        p.netId = s.id;
        p.caster = this.seats[s.caster.index];
        // Staff colours and size, as an offline cast gets them in SpellSystem.launchBolt.
        if (s.kind === 'bolt') p.applyStaffLook(p.caster?.staff);
      }
      p.prevPos.copy(fresh ? tmp.set(q(s.pos.x), q(s.pos.y), q(s.pos.z)) : p.pos);
      p.pos.set(q(s.pos.x), q(s.pos.y), q(s.pos.z));
      p.vel.set(q(s.vel.x), q(s.vel.y), q(s.vel.z));
      const relook = fresh || p.owner !== owner || p.radius !== q(s.radius);
      p.owner = owner;
      p.radius = q(s.radius);
      p.reflected = s.reflected;
      if (relook) p.refreshLook();
    }
    // Cover: health, crumbling and sliding.
    const pillars = g.arena.pillars;
    sw.arena.obstacles.forEach((ob, i) => {
      const pl = pillars[i];
      if (!pl) return;
      if (ob.mover) pl.moveTo(q(ob.x), q(ob.z));
      pl.setNetState(ob.alive ? q(ob.hp) : -1);
    });
    g.arena.fireRadius = q(sw.arena.fireRadius);
    g.tickets.applyNetState(sw.tickets.list.map((t) => ({ id: t.id, x: q(t.x), z: q(t.z), age: sec(t.age) })));
    // Ultimate waves.
    const live = new Set<number>();
    for (const wv of sw.spells.waves) {
      live.add(wv.id);
      let fx = this.waves.get(wv.id);
      if (!fx) {
        const f = g.spells.spellFx.wave(this.seats[wv.owner.index].team.ultimate);
        if (!f) continue;
        this.waves.set(wv.id, (fx = f));
      }
      const t = q(wv.radius) / S.ultimate.maxRadius;
      g.spells.spellFx.setWave(fx, tmp.set(q(wv.x), 0, q(wv.z)), q(wv.radius), 1 - t * t);
    }
    for (const [id, fx] of this.waves) {
      if (live.has(id)) continue;
      g.spells.spellFx.releaseWave(fx);
      this.waves.delete(id);
    }
    // Match.
    const m = g.match, sm = sw.match;
    if (m) {
      m.phase = sm.phase;
      m.round = sm.round;
      // Match.wins is by game side; sim wins are by seat.
      m.wins[this.seats[0].side] = sm.wins[0];
      m.wins[this.seats[1].side] = sm.wins[1];
      m.timer = sec(sm.timer);
      m.phaseTime = sec(sm.phaseTime);
      m.clock.elapsed = sec(sw.rules.single ? sw.clock.elapsed : sm.elapsed);
    }
    g.actionsLocked = sw.actionsLocked;
    if (sw.boss) this.applyBossFight();
    this.applied = sw.tick;
  }

  /** Boss fights: power hazards, smoke screens, arena shifts, the life pack and the ring cap. */
  private applyBossFight(): void {
    const g = this.game, sw = this.world;
    const views: SimHazardView[] = [];
    for (const h of sw.powers.hazards) {
      if (!h.active) continue;
      views.push({
        active: true, id: h.id, kind: h.kind, power: h.power, owner: h.owner.index, target: h.target ? h.target.index : -1, index: h.index,
        delay: sec(h.delay), x: q(h.at.x), y: q(h.at.y), z: q(h.at.z), radius: q(h.radius), track: sec(h.track), warn: sec(h.warn), warnTotal: sec(h.warnTotal),
        t: sec(h.t), life: sec(h.life), speed: q(h.speed), angle: rad(h.angle), start: rad(h.start), arc: rad(h.arc), dir: h.dir, prev: h.kind === 'ring' ? q(h.prev) : rad(h.prev),
        fired: h.fired, linger: sec(h.linger), vx: q(h.vel.x), vy: q(h.vel.y), vz: q(h.vel.z),
      });
    }
    g.spells.powers.applySim(views, (i) => this.wiz(i));
    g.arena.applySimSmokes(sw.rewards.smokes.map((m) => ({ owner: this.seats[m.owner], x: q(m.x), z: q(m.z), radius: q(m.r), height: q(m.height), age: sec(m.age), life: sec(m.life) })));
    g.shifts.applySim(sw.shifts.features.map((f) => ({ id: f.id, kind: f.kind, x: q(f.x), z: q(f.z), r: q(f.r), age: sec(f.age), charge: q(f.charge), timer: sec(f.timer), period: sec(f.period) })), sw.shifts.stage);
    const pk = sw.lifePacks.pack;
    g.lifePacks.applySim(pk.active, pk.id, q(pk.x), q(pk.z), sec(pk.age));
    g.arena.ringCap = q(sw.arena.ringCap);
  }

  // ---------------------------------------------------------------- events

  private wiz(i: number): Wizard | null {
    return i >= 0 ? this.seats[i] ?? null : null;
  }

  /**
   * The wizard reported as sim side `side`'s winner (Match.leader). Sim side 0 is seat 0, side 1
   * seat 1 (the rival or the boss); an online host holding seat 1 plays sim side 1 as game.player.
   */
  private leader(side: number): Wizard | null {
    return side === 0 || side === 1 ? this.seats[side] : null;
  }

  private present(): void {
    for (const e of this.world.events.take()) this.event(e);
  }

  private event(e: SimEvent): void {
    const g = this.game;
    const fx = g.fx;
    const pos = new THREE.Vector3(q(e.x), q(e.y), q(e.z));
    const w = this.wiz(e.w);
    const o = this.wiz(e.o);
    const emit = <K extends keyof GameEvents>(name: K, payload: GameEvents[K]) => events.emit(name, payload);
    const callout = (text: string, style: GameEvents['callout']['style'], at = w ? w.chest(new THREE.Vector3()) : pos) => emit('callout', { pos: at, text, style });
    switch (e.type) {
      case 'cast': {
        if (!w) break;
        const spell = (e.s === 'volley' ? 'bolt' : e.s) as SpellId;
        if (e.s === 'bolt' || e.s === 'volley' || e.s === 'blast' || e.s === 'stun') {
          const kind = e.s as CastKind;
          const p = g.spells.pool.active.find((x) => x.netId === e.n);
          tmpDir.copy(p ? p.vel : w.forward(tmpDir)).normalize();
          g.spells.muzzleFx.cast(w, kind, w.visual.muzzleIndex(kind, Math.max(0, w.muzzleTurn - 1)), pos, tmpDir);
          if (e.s === 'blast') feel.shakeAt(pos, 0.12, 6);
        } else if (e.s === 'ultimate') {
          const color = w.team.ultimate;
          const chest = w.chest(new THREE.Vector3());
          fx.explosion(chest, color, 2.0);
          fx.ring(pos, color, S.ultimate.maxRadius, S.ultimate.maxRadius / S.ultimate.waveSpeed);
          fx.light(chest, color, 30, 0.5);
          feel.shake(0.55);
          feel.screenFlash(color, 0.5);
        }
        emit('cast', { wizard: w, spell, pos });
        break;
      }
      case 'castStart':
        if (w) emit('castStart', { wizard: w, spell: e.s as SpellId, pos });
        break;
      case 'damage':
        if (w) emit('damage', { target: w, source: o, amount: q(e.n), point: pos, kind: e.s as DamageKind });
        break;
      case 'impact': {
        const owner = w;
        const color = owner ? (e.s === 'blast' ? owner.team.blast : owner.staff?.boltColor || owner.team.spell) : 0xffffff;
        if (e.s === 'stun') {
          const c = owner ? owner.team.stun : 0xffffff;
          fx.impact(pos, null, c, 1.2);
          fx.flash(pos, c, 1.4, 0.12);
          feel.freeze(S.stun.hitStopMs);
          feel.shakeAt(pos, 0.35);
          break;
        }
        const surface = e.o >= 0 ? 'wizard' : e.o === SURFACE_PILLAR ? 'pillar' : e.o === SURFACE_WALL ? 'wall' : 'floor';
        if (e.s === 'bolt') {
          if (e.o >= 0) {
            fx.impact(pos, null, color, (e.f ? 1.6 : 1) * (owner?.staff?.boltScale ?? 1));
            feel.freeze(S.bolt.hitStopMs, !e.f);
            const target = this.wiz(e.o);
            if (feel.isLocal(target) || feel.isLocal(owner)) feel.shake(S.bolt.shake);
            else feel.shakeAt(pos, S.bolt.shake);
          } else if (e.o === SURFACE_PILLAR) {
            fx.impact(pos, null, color, 0.8);
            fx.dust(pos, 3, 0.4);
          } else fx.impact(pos, null, color, e.o === SURFACE_FLOOR ? 0.6 : 0.6);
        }
        emit('impact', { pos, spell: e.s as SpellId, surface });
        break;
      }
      case 'fizzle':
        fx.impact(pos, null, w ? w.team.spell : 0xffffff, 0.4);
        break;
      case 'explosion': {
        const radius = q(e.n);
        if (w) fx.explosion(pos, w.team.blast, radius);
        feel.freeze(e.s === 'hit' ? S.blast.hitStopMs : 25);
        feel.shakeAt(pos, S.blast.shake);
        if (w) emit('explosion', { pos, radius, owner: w });
        break;
      }
      case 'shieldUp':
        if (w) emit('shieldUp', { wizard: w });
        break;
      case 'block':
        if (!w) break;
        w.visual.shieldImpact(e.f);
        if (!e.f) callout('BLOCK', 'block', pos);
        emit('block', { wizard: w, pos, perfect: e.f, spell: e.s as SpellId });
        break;
      case 'perfect':
        if (!w) break;
        fx.flash(pos, 0xffffff, 4, 0.18);
        fx.light(pos, w.team.spell, 40, 0.3);
        feel.freeze(S.shield.hitStopMs);
        feel.slowMo(CONFIG.feel.perfectSlowMoScale, CONFIG.feel.perfectSlowMoTime);
        feel.shakeAt(pos, 0.3);
        callout('PERFECT!', 'perfect', pos);
        break;
      case 'clash': {
        const a = w ? w.team.spell : 0xffffff, b = o ? (o.team.ultimate ?? o.team.spell) : 0xffffff;
        fx.clash(pos, a, b, 1);
        feel.freeze(CONFIG.clash.hitStopMs);
        feel.shakeAt(pos, CONFIG.clash.shake);
        emit('clash', { pos, winner: (e.s || null) as SpellId | null });
        break;
      }
      case 'beam': {
        // `beam` carries the origin; `beamEnd` (next) carries the end.
        this.beamFrom.copy(pos);
        this.beamCaster = w;
        break;
      }
      case 'beamEnd':
        if (this.beamCaster) g.spells.spellFx.beam(this.beamFrom, pos, this.beamCaster.team.stun, S.stun.beamVisualTime);
        break;
      case 'dodge':
        if (w) emit('dodge', { wizard: w });
        break;
      case 'blink':
        if (w) emit('blink', { wizard: w, color: w.staff?.trailColor ?? 0x3fe6ff, width: CONFIG.staffs.momentum.blink.trailWidth, dps: CONFIG.staffs.momentum.blink.trailDps, life: CONFIG.staffs.momentum.blink.trailTime });
        break;
      case 'dodgeEvade':
        if (!w) break;
        callout('DODGE', 'info', pos);
        emit('dodgeEvade', { wizard: w, pos });
        break;
      case 'evaded':
        if (!w) break;
        callout('EVADED', 'perfect', pos);
        emit('dodgeEvade', { wizard: w, pos });
        break;
      case 'cover':
        callout('COVER', 'info', pos);
        break;
      case 'jump':
        if (w) emit('jump', { wizard: w, pos: w.pos });
        break;
      case 'land':
        if (w) emit('land', { wizard: w, pos: w.pos, speed: w.landSpeed });
        break;
      case 'stunned':
        if (!w) break;
        emit('stunned', { wizard: w });
        callout('STUNNED', 'stun');
        break;
      case 'burn':
        if (!w) break;
        emit('burn', { wizard: w });
        fx.impact(tmp.set(w.pos.x, w.pos.y + 1, w.pos.z), null, 0xff7a2a, 0.5);
        break;
      case 'pillarHit':
        g.arena.debris.spawn(pos, 2, 0.6);
        emit('pillarHit', { pos });
        break;
      case 'pillarBreak':
        emit('pillarBreak', { pos, glass: e.s === 'glass' });
        break;
      case 'ultReady':
        if (w) emit('ultReady', { wizard: w });
        break;
      case 'noMana':
        if (!w) break;
        callout('NO MANA', 'info');
        emit('noMana', { wizard: w });
        break;
      case 'notCharged':
        callout('NOT CHARGED', 'info');
        break;
      case 'ultWave':
        if (w) emit('ultWave', { wizard: w, pos });
        break;
      case 'ko':
        if (w) emit('ko', { loser: w, winner: o });
        break;
      case 'roundIntro':
        this.game.onSimRoundIntro();
        emit('roundIntro', { round: e.n });
        break;
      case 'countdown':
        emit('countdown', { value: e.n });
        break;
      case 'roundStart':
        emit('roundStart', { round: e.n });
        break;
      case 'roundEnd': {
        const winner = this.leader(e.w);
        if (this.game.match) {
          this.game.match.lastWinner = winner;
          this.game.match.roundWinners.push(winner);
        }
        if (e.s === 'ko') feel.slowMo(CONFIG.feel.koSlowMoScale, CONFIG.feel.koSlowMoTime);
        emit('roundEnd', { winner, reason: e.s as 'ko' | 'time' });
        break;
      }
      case 'matchEnd':
        emit('matchEnd', { winner: this.leader(e.w) });
        break;
      case 'suddenDeath':
        emit('suddenDeath', {});
        break;
      case 'fightCap':
        emit('fightCap', {});
        break;
      case 'ticketSpawn':
        emit('ticketSpawn', { id: e.n, pos });
        break;
      case 'ticketPickup':
        if (w) emit('ticketPickup', { id: e.n, pos, wizard: w, refreshed: e.s === 'refreshed' });
        break;
      case 'ticketExpire':
        emit('ticketExpire', { id: e.n, pos, reason: e.s as 'timeout' | 'fire' });
        break;
      case 'manaBoostEnd':
        if (w) emit('manaBoostEnd', { wizard: w });
        break;
      case 'volley':
        if (w) emit('volley', { wizard: w, name: e.s, count: e.n, pos });
        break;
      case 'bossEvolve': {
        // The game's own BossStages plays the transformation (look, cinematic) and emits bossEvolve.
        if (!w) break;
        // The sim's grace timer is already on the wizard; BossStages only plays the change.
        const grace = w.evolveTime;
        w.evolveTime = 0;
        this.game.stagesOf(w)?.evolveTo(e.n);
        w.evolveTime = Math.max(w.evolveTime, grace);
        break;
      }
      case 'bossPower': {
        if (!w) break;
        const st = g.stagesOf(w);
        const power = st?.boss?.powers[e.o];
        if (power) emit('bossPower', { wizard: w, power, phase: e.s as GameEvents['bossPower']['phase'], pos, hazard: e.n });
        break;
      }
      case 'powerHit':
        feel.freeze(CONFIG.powers.hitStopMs);
        if (feel.isLocal(w)) feel.shake(CONFIG.powers.shake);
        else feel.shakeAt(pos, CONFIG.powers.shake);
        break;
      case 'lookedAway':
        callout('LOOKED AWAY', 'perfect', pos);
        if (w) emit('dodgeEvade', { wizard: w, pos });
        break;
      case 'blinded':
        callout('BLINDED', 'stun', pos);
        break;
      case 'infected':
        callout('INFECTED', 'stun', pos);
        break;
      case 'callout':
        callout(e.s, e.s === 'BLOCK' ? 'block' : e.s === 'NOT LEARNED' ? 'info' : e.s === 'RAMMED!' ? 'perfect' : 'spell', pos);
        break;
      case 'rewardCast':
        if (w) emit('rewardCast', { wizard: w, spell: e.s as RewardSpellId, pos });
        break;
      case 'rewardEnd':
        if (w) emit('rewardEnd', { wizard: w, spell: e.s as RewardSpellId });
        break;
      case 'rewardHeal':
        if (w) emit('rewardHeal', { wizard: w, amount: q(e.n) });
        break;
      case 'carpetRam':
        if (w && o) emit('carpetRam', { wizard: w, target: o, pos });
        break;
      case 'arenaShift': {
        const shift = this.world.boss?.shift;
        if (shift) emit('arenaShift', { stage: e.n, shift });
        break;
      }
      case 'ventWarn':
      case 'ventErupt': {
        const color = this.world.boss?.shift.vents.color ?? 0xffffff;
        emit(e.type as 'ventWarn' | 'ventErupt', { pos, color });
        break;
      }
      case 'springHeal':
        if (w) emit('springHeal', { wizard: w, amount: q(e.n), pos });
        break;
      case 'lifePackSpawn':
        emit('lifePackSpawn', { id: e.o, pos, first: e.f, left: e.n });
        break;
      case 'lifePackPickup':
        if (w) emit('lifePackPickup', { id: e.o, pos, wizard: w, healed: q(e.n) });
        break;
      case 'phasePotion':
        if (w) emit('phasePotion', { wizard: w, healed: q(e.n) });
        break;
      case 'lifePackExpire':
        emit('lifePackExpire', { id: e.o, pos });
        break;
      default:
        this.game.presentSimEvent?.(e, pos, w, o);
        break;
    }
  }

  private readonly beamFrom = new THREE.Vector3();
  private beamCaster: Wizard | null = null;
}

/** Put a game wizard in the sim wizard's state (visuals, HUD and camera read it). */
export function applyWizard(w: Wizard, s: SimWizard): void {
  w.prevPos.copy(w.pos);
  w.pos.set(q(s.pos.x), q(s.pos.y), q(s.pos.z));
  w.vel.set(q(s.vel.x), 0, q(s.vel.z));
  w.knock.set(q(s.knock.x), 0, q(s.knock.z));
  w.vy = q(s.vy);
  w.grounded = s.grounded;
  w.groundY = q(s.groundY);
  w.prevFacing = w.facing;
  w.facing = rad(s.facing);
  w.maxHealth = q(s.maxHealth);
  w.health = q(s.health);
  w.mana = q(s.mana);
  w.manaBoost = sec(s.manaBoost);
  w.ult = q(s.ult);
  const cds = ['bolt', 'blast', 'shield', 'stun', 'dodge', 'blink'] as const;
  for (let i = 0; i < cds.length; i++) w.cd[cds[i]] = sec(s.cd[i]);
  const rcds = ['carpet', 'pump', 'vape', 'lockon', 'breath'] as const;
  for (let i = 0; i < rcds.length; i++) w.rcd[rcds[i]] = sec(s.rcd[i]);
  w.stunTime = sec(s.stunTime);
  w.shieldTime = sec(s.shieldTime);
  w.shieldAge = sec(s.shieldAge);
  w.dodgeTime = sec(s.dodgeTime);
  w.iframes = sec(s.iframes);
  w.blinkTime = sec(s.blinkTime);
  w.blinkFrom.set(q(s.blinkFrom.x), q(s.blinkFrom.y), q(s.blinkFrom.z));
  w.evolveTime = sec(s.evolveTime);
  w.dodgeDir.set(q(s.dodgeDir.x), 0, q(s.dodgeDir.z));
  w.cast = s.cast ? { spell: s.cast.spell, elapsed: sec(s.cast.elapsed), duration: sec(s.cast.duration) } : null;
  w.castPulse = q(s.castPulse);
  w.hitFlash = sec(s.hitFlash);
  w.burning = s.burning;
  w.sprinting = s.sprinting;
  w.jumps = s.jumps;
  w.landings = s.landings;
  w.landSpeed = q(s.landSpeed);
  w.sinceAttack = sec(s.sinceAttack);
  w.muzzleTurn = s.muzzleTurn;
  w.carpetTime = sec(s.carpetTime);
  w.pumpTime = sec(s.pumpTime);
  w.lockTime = sec(s.lockTime);
  w.breathTime = sec(s.breathTime);
  w.scorchTime = sec(s.scorchTime);
  w.flyHeight = q(s.flyHeight);
  const st = s.stats;
  w.stats.damageDealt = q(st.damageDealt);
  w.stats.casts = st.casts;
  w.stats.hits = st.hits;
  w.stats.perfects = st.perfects;
  w.stats.dodges = st.dodges;
  w.setAlive(s.alive);
  w.placeBody();
}

export { emptyInput };
