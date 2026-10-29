import * as THREE from 'three';
import { CONFIG, type AIProfile, type Difficulty } from '../config';
import { events } from '../core/events';
import type { TickController } from '../core/Game';
import { chance, clamp, rand, randInt, wrapAngle } from '../core/math';
import type { Physics } from '../physics/Physics';
import type { Arena } from '../arena/Arena';
import { stageProfile } from '../campaign/BossStages';
import type { BossFighter, PowerDef, StageAttacks } from '../campaign/levels';
import type { GoldenTickets } from '../arena/GoldenTickets';
import type { LifePacks } from '../arena/LifePacks';
import type { ArenaShifts } from '../arena/ArenaShifts';
import type { SpellSystem } from '../spells/SpellSystem';
import type { Wizard } from '../wizard/Wizard';

export type AIState = 'approach' | 'attack' | 'evade' | 'retreat';

interface Reaction {
  at: number;
  action: 'dodge' | 'shield' | 'jump';
  dir: THREE.Vector3;
}

const AI = CONFIG.ai;
const SP = CONFIG.spells;
const VOLLEY = CONFIG.campaign.volley;
const DUO = CONFIG.campaign.duo;
const TK = CONFIG.tickets;
const RS = CONFIG.rewardSpells;
const RAI = CONFIG.ai.rewards;
const PW = CONFIG.powers;
const PAI = CONFIG.powers.ai;

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();

/**
 * Enemy wizard brain. A small state machine (approach, attack, evade, retreat) that only writes
 * to the wizard's intent, exactly like the player controller. Difficulty is a tuning profile.
 * Campaign bosses follow their stage (the `bossStage` event): a scaled profile, gated attacks and
 * the stage's signature volley, cast through SpellSystem.castVolley. In a double fight each boss
 * has its own controller; `allies` keeps the pair spread out and flanking the player.
 */
export class AIController implements TickController {
  state: AIState = 'approach';
  profile: AIProfile;
  /** What this AI may cast beyond bolts, shield and rolls (a boss stage), or null for everything. */
  attacks: StageAttacks | null = null;
  /** Seconds until the stage's volley may fire again. */
  private volleyCd = 0;
  private time = 0;
  private stateTime = 0;
  private reactions: Reaction[] = [];
  private strafeDir = 1;
  private strafeTimer = 0;
  private burstLeft = 0;
  private burstCastsAtStart = 0;
  private pauseTimer = 0;
  private decisionTimer = 0;
  private punishTimer = 0;
  private losTimer = 0;
  private hasLos = true;
  /** The target is hidden by soft cover (a vape cloud): aim and move at where it was last seen... */
  private lost = false;
  /** ...and nothing solid is in the way, so keep firing there for a while. */
  private blind = false;
  private readonly lastSeen = new THREE.Vector3();
  private lastSeenAt = -1e9;
  private comboBlastAt = -1;
  private readonly desiredMove = new THREE.Vector3();
  private readonly aimNoise = new THREE.Vector3();
  private readonly aimNoiseTarget = new THREE.Vector3();
  private noiseTimer = 0;
  private readonly coverPoint = new THREE.Vector3();
  private hasCover = false;
  private ultWatch = -1;
  /** Seconds before the AI may start another retreat (prevents retreat loops). */
  private retreatCooldown = 0;
  private readonly unsubs: (() => void)[] = [];
  /**
   * Teammates (e.g. Game.enemies, which includes this AI's own wizard): stay `spacing` apart from
   * them and circle away from them around the target (CONFIG.campaign.duo). Empty: fights alone.
   */
  allies: readonly Wizard[] = [];
  /** Golden tickets on the field (src/arena/GoldenTickets.ts); null = ignore them. */
  tickets: GoldenTickets | null = null;
  /**
   * Life packs (Boss Gauntlet health pickups); null = ignore them. Only the player can collect
   * them, so only an AI driving the player (the soak's reference AI) gets them.
   */
  lifePacks: LifePacks | null = null;
  /** Arena shifts' springs (src/arena/ArenaShifts.ts); null = ignore them (bosses do; the soak's reference AI uses them). */
  shifts: ArenaShifts | null = null;
  /** The pickup (a ticket or a life pack) this AI is detouring to, if any (checked by id: they are pooled). */
  private ticketGoal: { readonly active: boolean; readonly id: number; readonly pos: THREE.Vector3 } | null = null;
  /** The goal is a life pack (worth more: no give-up check against the opponent's distance). */
  private goalIsPack = false;
  private ticketGoalId = 0;
  private ticketGoalTime = 0;
  private ticketCheck = 0;
  private lastHurtAt = -1e9;
  /** Boss reward spells (only if this AI's wizard learned some: the soak's reference player). */
  private rewardCheck = 0;
  /** Use learned reward spells at all (off for the menu's background duel). */
  useRewards = true;
  /** When an enemy last fired a signature volley within range. */
  private volleyAlertAt = -1e9;
  /** Seconds the target has been strafing across our line of fire (Lock-On). */
  private targetStrafe = 0;
  /** The boss this AI plays and its stage (bossStage), for its special powers; null: none. */
  private boss: BossFighter | null = null;
  private stage = 0;
  /** Boss powers coming at us (evadePowers): when each hazard was first noticed (by id), and those already planned for. */
  private readonly noticed = new Map<number, number>();
  private readonly planned = new Set<number>();
  /** Running out of a telegraphed zone or cone: where to, until when. */
  private readonly escapeDir = new THREE.Vector3();
  private escapeUntil = -1;
  /** Turned away from a flashbang about to pop: which way, until when. */
  private lookAwayAngle = 0;
  private lookAwayUntil = -1;

  constructor(
    private readonly self: Wizard,
    private target: Wizard,
    private readonly spells: SpellSystem,
    private readonly physics: Physics,
    private readonly arena: Arena,
    difficulty: Difficulty = 'normal',
  ) {
    this.profile = AI.difficulty[difficulty];
    this.listen();
  }

  /** Who this AI fights (the soak's reference player switches to the nearest standing enemy). */
  get opponent(): Wizard {
    return this.target;
  }

  setTarget(w: Wizard): void {
    if (w === this.target) return;
    this.target = w;
    this.ultWatch = -1;
    this.punishTimer = 0;
    this.comboBlastAt = -1;
    this.losTimer = 0;
    // Forget where the old target was last seen (e.g. inside a vape cloud).
    this.lastSeen.copy(w.pos);
    this.lastSeenAt = -1e9;
    this.lost = this.blind = false;
  }

  setDifficulty(d: Difficulty): void {
    this.profile = AI.difficulty[d];
  }

  /** Use an arbitrary tuning profile (campaign bosses). `setDifficulty` switches back to a preset. */
  setProfile(profile: AIProfile): void {
    this.profile = profile;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
  }

  reset(): void {
    this.state = 'approach';
    this.stateTime = 0;
    this.reactions = [];
    this.burstLeft = 0;
    this.pauseTimer = rand(0.3, 0.8);
    this.punishTimer = 0;
    this.comboBlastAt = -1;
    this.ultWatch = -1;
    this.retreatCooldown = 0;
    this.desiredMove.set(0, 0, 0);
    this.aimNoise.set(0, 0, 0);
    this.resetVolley();
    this.ticketGoal = null;
    this.goalIsPack = false;
    this.lastHurtAt = -1e9;
    this.rewardCheck = 0;
    this.volleyAlertAt = -1e9;
    this.targetStrafe = 0;
    this.noticed.clear();
    this.planned.clear();
    this.escapeUntil = this.lookAwayUntil = -1;
    this.armPowers();
  }

  /** First volley of a stage comes a little after it begins. */
  private resetVolley(): void {
    this.volleyCd = (this.attacks?.volley?.cooldown ?? 0) * VOLLEY.cooldownScale * VOLLEY.firstDelay;
  }

  /** True while detouring to a golden ticket. */
  get seekingTicket(): boolean {
    return this.ticketGoal !== null;
  }

  /** Punish windows come from game events: a whiffed Blast, a stunned or empty opponent. */
  private listen(): void {
    this.unsubs.push(
      events.on('explosion', (e) => {
        if (e.owner === this.target && e.pos.distanceTo(this.self.pos) > SP.blast.splashRadius) this.tryPunish();
      }),
      events.on('stunned', (e) => {
        if (e.wizard === this.target) this.tryPunish();
      }),
      events.on('ultWave', (e) => {
        if (e.wizard === this.target) this.ultWatch = this.self.health;
      }),
      events.on('dodgeEvade', (e) => {
        if (e.wizard === this.self && this.ultWatch >= 0) this.tryPunish();
      }),
      // Campaign boss stages: the boss's base profile scaled per stage, and that stage's attacks.
      events.on('bossStage', (e) => {
        if (e.wizard !== this.self) return;
        this.attacks = e.boss ? e.boss.stages[e.stage].attacks : null;
        if (e.boss) this.setProfile(stageProfile(e.boss, e.stage));
        this.boss = e.boss;
        this.stage = e.stage;
        this.resetVolley();
        this.armPowers();
      }),
      events.on('damage', (e) => {
        if (e.target === this.self) this.lastHurtAt = this.time;
      }),
      events.on('volley', (e) => {
        if (e.wizard.side !== this.self.side && e.pos.distanceTo(this.self.pos) < VOLLEY.range + 4) this.volleyAlertAt = this.time;
      }),
    );
  }

  private tryPunish(): void {
    if (chance(this.profile.punishChance)) this.punishTimer = AI.punishTime;
  }

  private setState(s: AIState): void {
    if (this.state === s) return;
    this.state = s;
    this.stateTime = 0;
  }

  update(dt: number): void {
    const w = this.self;
    const intent = w.intent;
    this.time += dt;
    this.stateTime += dt;
    if (this.punishTimer > 0) this.punishTimer -= dt;
    if (this.retreatCooldown > 0) this.retreatCooldown -= dt;

    if (!w.alive || !this.target.alive || w.evolving) {
      intent.move.set(0, 0, 0);
      intent.holdBolt = false;
      intent.sprint = false;
      if (w.evolving) {
        // Transforming: frozen, and whatever it was about to do is forgotten.
        this.reactions.length = 0;
        this.burstLeft = 0;
        this.comboBlastAt = -1;
      }
      return;
    }
    if (this.volleyCd > 0) this.volleyCd -= dt;

    // Line of sight is a raycast, so only refresh it a few times per second. Soft cover (vape
    // clouds) hides the target too: the AI then goes for where it last saw it. Attacking from
    // inside gives the target away for a moment (CONFIG.ai.castRevealTime): it is seen again, so
    // `lastSeen` follows it and the AI aims at it instead of firing blind.
    this.losTimer -= dt;
    if (this.losTimer <= 0) {
      this.losTimer = 0.15;
      const a = w.chest(tmpB), b = this.target.chest(tmpC);
      const solid = this.physics.lineOfSight(a, b);
      const revealed = this.target.sinceAttack < AI.castRevealTime;
      this.lost = !revealed && this.arena.obscured(a, b);
      this.hasLos = solid && !this.lost;
      if (this.hasLos) {
        this.lastSeen.copy(this.target.pos);
        this.lastSeenAt = this.time;
      }
      // Firing blind into the haze, at the last known spot, for a while (not through solid cover).
      this.blind = this.lost && solid && this.time - this.lastSeenAt < AI.lostTrackTime;
    }

    const toTarget = tmpA.subVectors(this.lost ? this.lastSeen : this.target.pos, w.pos).setY(0);
    const dist = toTarget.length();
    toTarget.divideScalar(dist || 1);

    this.perceiveThreats();
    this.evadePowers();
    this.runReactions();
    this.chooseState(dist);
    this.thinkTickets(dt);
    this.thinkRewards(dt, toTarget, dist);
    this.steer(dt, toTarget, dist);
    this.thinkPowers(dist);
    this.aimAndAttack(dt, dist);
    // Channelling a power (the cone, the sweep, its rings): plant and face it.
    const pw = this.spells.powers;
    if (pw.channeling(w)) {
      intent.move.set(0, 0, 0);
      this.desiredMove.set(0, 0, 0);
      intent.sprint = false;
      intent.holdBolt = false;
      const f = pw.channelFacing(w);
      if (f !== null) intent.facing = f;
    }
    // Eyes off a flashbang about to pop.
    if (this.time < this.lookAwayUntil) {
      intent.facing = this.lookAwayAngle;
      intent.holdBolt = false;
    }
  }

  // ------------------------------------------------------------------ boss powers

  /** A boss's stage starts (or a round): each of its powers comes up after part of its recharge. */
  private armPowers(): void {
    const b = this.boss;
    if (!b) return;
    const pw = this.spells.powers;
    for (const d of b.powers) if (d.from <= this.stage) pw.setCooldown(this.self, d, pw.recharge(d, this.stage) * PW.firstDelay * rand(0.8, 1.4));
  }

  /**
   * Boss special powers: when the fight's bosses aren't mid-power (CONFIG.powers.gap), start one of
   * this stage's that has recharged and has the target in range (and in sight, except those that
   * come from above), picked at random.
   */
  private thinkPowers(dist: number): void {
    const b = this.boss, w = this.self, pw = this.spells.powers;
    if (!b || b.powers.length === 0 || !pw.open || !w.canAct || pw.busy(w) || this.target.evolving || this.spells.volleyFiring(w)) return;
    if (this.state !== 'attack' && this.state !== 'approach') return;
    const sees = this.hasLos && !this.lost;
    let pick: PowerDef | null = null;
    let n = 0;
    for (const d of b.powers) {
      if (d.from > this.stage || pw.cooldown(w, d) > 0 || dist > d.range) continue;
      const fromAbove = d.kind === 'strike' || d.kind === 'barrage' || d.kind === 'cloud';
      if (PW.needSight && !sees && !fromAbove) continue;
      if (chance(1 / ++n)) pick = d;
    }
    if (pick) pw.cast(w, pick, this.target, this.stage);
  }

  /**
   * Boss powers coming at us (CONFIG.powers.ai), each noticed with the profile's dodge chance and
   * reacted to after its reaction time: run out of a zone, a cone or a toxic cloud about to fire (and
   * roll out if still inside at the last moment), jump a shockwave ring or the sweep as it arrives
   * (or roll through it), roll through a seeker about to hit, look away from a flashbang. A
   * strike's reticle can't be outrun while it follows: it is dodged once it locks.
   */
  private evadePowers(): void {
    const w = this.self, p = this.profile, pw = this.spells.powers;
    if (!w.alive || w.stunned) return;
    const esc = tmpB.set(0, 0, 0);
    let roll: THREE.Vector3 | null = null;
    for (const h of pw.hazards) {
      if (!h.active || h.owner.side === w.side || h.delay > 0 || h.done.includes(w)) continue;
      let seen = this.noticed.get(h.id);
      if (seen === undefined) {
        seen = chance(p.dodgeChance + (1 - p.dodgeChance) * PAI.notice) ? this.time : Infinity;
        this.noticed.set(h.id, seen);
      }
      if (this.time - seen < p.reactionTime * rand(0.9, 1.1)) continue;
      const dx = w.pos.x - h.at.x, dz = w.pos.z - h.at.z;
      const d = Math.hypot(dx, dz);
      switch (h.kind) {
        case 'zone':
        case 'flash':
        case 'cloud': {
          if (h.track > 0 || (h.fired && h.kind !== 'cloud')) break;
          const fires = h.fired ? 0 : h.warn;
          if (fires > PAI.zoneHorizon) break;
          if (h.kind === 'flash' && d < h.radius + 1 && fires < 0.4) {
            this.lookAwayAngle = Math.atan2(dx, dz);
            this.lookAwayUntil = this.time + fires + 0.15;
          }
          const reach = h.radius + w.radius * PW.zoneGrace;
          if (d > reach + PAI.zoneMargin) break;
          const k = 1 / Math.max(0.15, fires);
          if (d > 0.05) esc.x += (dx / d) * k, esc.z += (dz / d) * k;
          else esc.x += Math.cos(w.facing) * k, esc.z -= Math.sin(w.facing) * k;
          if (h.kind === 'zone' && d < reach && fires < PAI.rollLead && !roll) roll = tmpC.set(d > 0.05 ? dx / d : Math.cos(w.facing), 0, d > 0.05 ? dz / d : -Math.sin(w.facing));
          break;
        }
        case 'cone': {
          if (h.fired || d > h.radius + 1.5) break;
          const off = wrapAngle(Math.atan2(dx, dz) - h.angle);
          if (Math.abs(off) > h.arc / 2 + 0.35) break;
          // Out of the side it is nearer to.
          const side = off >= 0 ? 1 : -1;
          const sx = Math.cos(h.angle) * side, sz = -Math.sin(h.angle) * side;
          const k = 1 / Math.max(0.15, h.warn);
          esc.x += sx * k;
          esc.z += sz * k;
          if (h.warn < PAI.rollLead && !roll) roll = tmpC.set(sx, 0, sz);
          break;
        }
        case 'ring':
        case 'sweep': {
          if (this.planned.has(h.id)) break;
          let arrive: number;
          if (h.kind === 'ring') {
            const gap = d - w.radius - h.radius;
            if (gap < 0) break;
            arrive = (h.fired ? 0 : h.warn) + gap / h.speed;
          } else {
            if (d > h.radius + 1) break;
            const from = h.fired ? h.angle : h.start;
            const left = wrapAngle(Math.atan2(dx, dz) - from) * h.dir;
            if (left < 0) break;
            arrive = (h.fired ? 0 : h.warn) + (left / h.arc) * h.life;
          }
          // Jump the moment it is a jump's apex away (so the feet are highest as it passes),
          // or, if a jump isn't possible, roll through it just before it arrives.
          const J = CONFIG.wizard.jump;
          const lead = J.velocity / J.gravity + rand(-1, 1) * J.aiWaveJumpError * (1 - p.dodgeChance);
          if (w.canJump) {
            if (arrive > lead) break;
            this.planned.add(h.id);
            w.intent.press('jump');
          } else {
            if (arrive > CONFIG.wizard.dodge.iframes * 0.5) break;
            this.planned.add(h.id);
            if (!roll) roll = tmpC.set(-dx, 0, -dz).normalize();
          }
          break;
        }
        case 'seeker': {
          if (h.target !== w) break;
          const chest = w.chest(tmpA);
          const dist = chest.distanceTo(h.at);
          if (dist / Math.max(1, h.speed) > PAI.seekerLead || this.planned.has(h.id)) break;
          this.planned.add(h.id);
          const canShield = w.cd.shield <= 0 && w.mana >= SP.shield.manaCost;
          if (canShield && chance(p.shieldPreference)) this.reactions.push({ at: this.time, action: 'shield', dir: new THREE.Vector3() });
          else if (!roll) roll = tmpC.set(-h.vel.z, 0, h.vel.x).normalize();
          break;
        }
      }
    }
    if (esc.lengthSq() > 1e-6) {
      this.escapeDir.copy(esc).setY(0).normalize();
      this.biasAwayFromHazards(this.escapeDir);
      this.escapeUntil = this.time + 0.2;
    }
    if (roll && w.cd.dodge <= 0 && !w.dodging && w.grounded) {
      this.biasAwayFromHazards(roll);
      w.intent.move.copy(roll);
      this.desiredMove.copy(roll);
      w.intent.press('dodge');
      this.setState('evade');
    }
    if (this.noticed.size > 96) {
      // Forget hazards long gone.
      const live = new Set(pw.hazards.map((h) => h.id));
      for (const id of this.noticed.keys()) if (!live.has(id)) this.noticed.delete(id);
      for (const id of this.planned) if (!live.has(id)) this.planned.delete(id);
    }
  }

  // ------------------------------------------------------------------ reward spells

  /**
   * Boss reward spells, by simple rules (CONFIG.ai.rewards), only for spells this wizard learned
   * (the soak's reference player; bosses never have any): the carpet to escape when low and under
   * fire or when a volley comes in, the vape cloud when low, Pump It before a burst (aimAndAttack),
   * Lock-On while the target strafes, Hellfire Breath at close range.
   */
  private thinkRewards(dt: number, toTarget: THREE.Vector3, dist: number): void {
    const w = this.self;
    if (!this.useRewards || w.learned.size === 0) return;
    const t = this.target;
    // How fast the target crosses our line of fire.
    const lateral = Math.abs(t.vel.x * -toTarget.z + t.vel.z * toTarget.x);
    this.targetStrafe = lateral > RAI.strafeSpeed ? this.targetStrafe + dt : Math.max(0, this.targetStrafe - dt * 2);
    this.rewardCheck -= dt;
    if (this.rewardCheck > 0) return;
    this.rewardCheck = RAI.checkInterval;
    const R = this.spells.rewards;
    const ready = (id: Parameters<typeof R.ready>[1]) => R.ready(w, id) && !w.intent.wants(id);
    const hp = w.health / w.maxHealth;
    const incoming = this.incomingCount(RAI.incomingHorizon);
    const volley = this.time - this.volleyAlertAt < RAI.volleyMemory;
    if (ready('carpet') && ((hp < RAI.carpetHealth && this.underFire()) || incoming >= RAI.carpetIncoming || (volley && incoming >= 2))) {
      w.intent.press('carpet');
      return;
    }
    if (ready('vape') && hp < RAI.vapeHealth) {
      w.intent.press('vape');
      return;
    }
    const sees = this.hasLos && !this.lost;
    if (ready('breath') && sees && dist < RS.breath.range * RAI.breathRange && !t.shielded && this.facingTarget(RAI.breathFacing)) {
      w.intent.press('breath');
      return;
    }
    if (ready('lockon') && sees && this.state === 'attack' && this.targetStrafe > RAI.strafeTime) w.intent.press('lockon');
  }

  /** Enemy projectiles on course to pass within ~1 m of our chest in the next `horizon` s. */
  private incomingCount(horizon: number): number {
    const w = this.self;
    const chest = w.chest(tmpC);
    let n = 0;
    for (const proj of this.spells.pool.active) {
      if (proj.owner.side === w.side) continue;
      const rx = chest.x - proj.pos.x, ry = chest.y - proj.pos.y, rz = chest.z - proj.pos.z;
      const v2 = proj.vel.lengthSq();
      if (v2 < 1e-4) continue;
      const tt = (rx * proj.vel.x + ry * proj.vel.y + rz * proj.vel.z) / v2;
      if (tt < 0 || tt > horizon) continue;
      if (Math.hypot(rx - proj.vel.x * tt, ry - proj.vel.y * tt, rz - proj.vel.z * tt) < 1.1) n++;
    }
    return n;
  }

  /** The wizard faces the target within `degrees`. */
  private facingTarget(degrees: number): boolean {
    const w = this.self, t = this.target;
    const want = Math.atan2(t.pos.x - w.pos.x, t.pos.z - w.pos.z);
    return Math.abs(wrapAngle(want - w.facing)) < THREE.MathUtils.degToRad(degrees);
  }

  // ------------------------------------------------------------------ perception

  private perceiveThreats(): void {
    const w = this.self;
    const p = this.profile;
    const chest = w.chest(tmpB);
    for (const proj of this.spells.pool.active) {
      const bit = 1 << w.index;
      // Our own side's spells pass through us harmlessly.
      if (proj.owner.side === w.side || proj.seenMask & bit) continue;
      // Closest approach of the projectile to our chest, assuming we stand still.
      const rx = proj.pos.x - chest.x, ry = proj.pos.y - chest.y, rz = proj.pos.z - chest.z;
      const v2 = proj.vel.lengthSq();
      if (v2 < 1e-4) continue;
      const t = -(rx * proj.vel.x + ry * proj.vel.y + rz * proj.vel.z) / v2;
      if (t < 0 || t > 1.0) continue;
      const mx = rx + proj.vel.x * t, my = ry + proj.vel.y * t, mz = rz + proj.vel.z * t;
      const splash = proj.kind === 'blast' ? SP.blast.splashRadius * 0.6 : 0;
      const miss = Math.hypot(mx, my, mz);
      if (miss > CONFIG.wizard.radius + proj.radius + 0.35 + splash) continue;
      proj.seenMask |= bit;
      if (!chance(p.dodgeChance)) continue;

      const reactAt = this.time + p.reactionTime * rand(0.8, 1.25);
      const impactAt = this.time + t;
      const canShield = w.cd.shield <= 0 && w.mana >= SP.shield.manaCost;
      if (reactAt > impactAt - 0.03) {
        // Too late for this one, but a shield still catches the rest of the volley.
        if (canShield && proj.kind === 'bolt' && chance(p.shieldPreference * 0.6) && !this.reactions.some((r) => r.action === 'shield')) {
          this.reactions.push({ at: reactAt, action: 'shield', dir: new THREE.Vector3() });
        }
        continue;
      }

      const wantShield = canShield && (proj.kind === 'bolt' || chance(0.5)) && chance(p.shieldPreference);
      if (wantShield) {
        // Good players time the shield so the spell lands inside the perfect window.
        const perfect = chance(p.perfectShieldChance);
        const at = perfect ? Math.max(reactAt, impactAt - SP.shield.perfectWindow * 0.6) : reactAt;
        this.reactions.push({ at, action: 'shield', dir: new THREE.Vector3() });
      } else {
        // Roll perpendicular to the projectile's path, away from it, as late as reaction allows.
        const side = tmpC.set(-proj.vel.z, 0, proj.vel.x).normalize();
        if (side.x * mx + side.z * mz > 0) side.negate(); // move away from where it will pass
        this.biasAwayFromHazards(side);
        const at = Math.max(reactAt, impactAt - CONFIG.wizard.dodge.iframes * 0.7);
        this.reactions.push({ at, action: 'dodge', dir: side.clone() });
      }
    }

    // Telegraphed windups: Stun beam and Ultimate.
    const tc = this.target.cast;
    if (tc && tc.elapsed < 0.02 && (tc.spell === 'stun' || tc.spell === 'ultimate') && chance(p.dodgeChance)) {
      const remaining = tc.duration - tc.elapsed;
      const reactAt = this.time + p.reactionTime * rand(0.8, 1.2);
      if (tc.spell === 'stun' && reactAt < this.time + remaining + 0.05) {
        const dir = tmpC.subVectors(this.self.pos, this.target.pos).setY(0).normalize();
        dir.set(-dir.z, 0, dir.x).multiplyScalar(chance(0.5) ? 1 : -1);
        this.biasAwayFromHazards(dir);
        this.reactions.push({ at: Math.max(reactAt, this.time + remaining - 0.08), action: 'dodge', dir: dir.clone() });
      } else if (tc.spell === 'ultimate') {
        const d = this.self.pos.distanceTo(this.target.pos);
        const arrive = this.time + remaining + d / SP.ultimate.waveSpeed;
        const J = CONFIG.wizard.jump;
        if (chance(J.aiWaveJump * p.dodgeChance)) {
          // Hop over it: takeoff timed so the apex meets the wavefront, less precisely when less skilled.
          const error = rand(-1, 1) * J.aiWaveJumpError * (1 - p.dodgeChance);
          this.reactions.push({ at: Math.max(reactAt, arrive - J.velocity / J.gravity + error), action: 'jump', dir: new THREE.Vector3() });
        } else {
          // Roll through the wave as it arrives.
          const dir = tmpC.subVectors(this.target.pos, this.self.pos).setY(0).normalize();
          this.reactions.push({ at: Math.max(reactAt, arrive - CONFIG.wizard.dodge.iframes * 0.5), action: 'dodge', dir: dir.clone() });
        }
      }
    }
  }

  private runReactions(): void {
    const w = this.self;
    for (let i = this.reactions.length - 1; i >= 0; i--) {
      const r = this.reactions[i];
      if (this.time < r.at) continue;
      this.reactions.splice(i, 1);
      if (w.stunned) continue;
      const canShield = w.cd.shield <= 0 && w.mana >= SP.shield.manaCost;
      if (r.action === 'shield' && canShield) {
        w.intent.press('shield');
      } else if (r.action === 'jump') {
        w.intent.press('jump');
      } else if (!w.grounded && !w.dodging) {
        // Mid-hop there is no roll: shield instead if it's ready.
        if (canShield) w.intent.press('shield');
      } else if (w.cd.dodge <= 0 && !w.dodging) {
        if (r.dir.lengthSq() < 0.01) r.dir.set(-Math.cos(w.facing), 0, Math.sin(w.facing));
        w.intent.move.copy(r.dir);
        this.desiredMove.copy(r.dir);
        w.intent.press('dodge');
        this.setState('evade');
      }
    }
  }

  /** Nudge a direction away from the fire ring, and never roll into a lava pool. */
  private biasAwayFromHazards(dir: THREE.Vector3): void {
    const w = this.self;
    const r = Math.hypot(w.pos.x, w.pos.z);
    const limit = this.fireRadius() - AI.fireMargin - CONFIG.wizard.dodge.speed * 0.3;
    if (r > limit) {
      const outward = (dir.x * w.pos.x + dir.z * w.pos.z) / (r || 1);
      if (outward > 0) dir.negate();
    }
    const roll = CONFIG.wizard.dodge.speed * CONFIG.wizard.dodge.duration * 0.8;
    if (this.arena.hazardAt(w.pos.x + dir.x * roll, w.pos.z + dir.z * roll, CONFIG.wizard.radius)) dir.negate();
  }

  private fireRadius(): number {
    return this.arena.fireRadius;
  }

  // ------------------------------------------------------------------ decisions

  private chooseState(dist: number): void {
    const w = this.self;
    const p = this.profile;
    if (this.state === 'evade' && (w.dodging || this.stateTime < 0.25)) return;

    if (this.state === 'retreat') {
      const recovered = w.mana / CONFIG.wizard.maxMana > 0.6;
      if (!recovered && this.stateTime < 3 && this.punishTimer <= 0) return;
      this.retreatCooldown = AI.retreatCooldown;
    } else if (this.punishTimer <= 0 && this.retreatCooldown <= 0) {
      const hp = w.health / w.maxHealth;
      const lowHealth = hp < AI.retreatHealth && hp < this.target.health / this.target.maxHealth;
      const lowMana = w.mana / CONFIG.wizard.maxMana < AI.lowMana;
      if (lowMana || (lowHealth && this.stateTime > 1.5 && chance(0.01))) {
        this.findCover();
        this.setState('retreat');
        return;
      }
    }

    const [near, far] = p.preferredRange;
    const maxRange = this.punishTimer > 0 ? near : far;
    if (dist > maxRange + 2 || (!this.hasLos && !this.blind)) this.setState('approach');
    else this.setState('attack');
  }

  /**
   * Golden tickets: now and then, when nothing is coming at it, detour to a ticket that is near and
   * closer to it than to the opponent (any near one when mana is low). Gives up if it takes too long.
   */
  private thinkTickets(dt: number): void {
    const w = this.self;
    const goal = this.ticketGoal;
    const giveUp = this.goalIsPack ? CONFIG.lifePacks.aiGiveUpTime : TK.aiGiveUpTime;
    if (goal && (!goal.active || goal.id !== this.ticketGoalId || w.stunned || (this.ticketGoalTime += dt) > giveUp)) {
      this.ticketGoal = null;
    }
    // A life pack when hurt beats any ticket.
    const LP = CONFIG.lifePacks;
    if (this.lifePacks && !this.goalIsPack && w.health < w.maxHealth * LP.aiSeekHealth && this.state !== 'evade') {
      const pack = this.lifePacks.bestFor(w, LP.aiSeekRange);
      if (pack) {
        this.ticketGoal = pack;
        this.ticketGoalId = pack.id;
        this.ticketGoalTime = 0;
        this.goalIsPack = true;
        return;
      }
    }
    // ...and so does a spring that is still running.
    const SH = CONFIG.arenaShifts;
    if (this.shifts && !this.ticketGoal && w.health < w.maxHealth * SH.aiSeekHealth && this.state !== 'evade') {
      const spring = this.shifts.springFor(w, SH.aiSeekRange);
      if (spring) {
        this.ticketGoal = spring;
        this.ticketGoalId = spring.id;
        this.ticketGoalTime = 0;
        this.goalIsPack = true;
        return;
      }
    }
    if (!this.ticketGoal) this.goalIsPack = false;
    if (this.ticketGoal || !this.tickets || this.tickets.activeCount === 0) return;
    this.ticketCheck -= dt;
    if (this.ticketCheck > 0) return;
    this.ticketCheck = TK.aiCheckInterval;
    if (this.state === 'evade' || this.punishTimer > 0 || w.manaBoost > TK.boostDuration / 3 || this.underFire()) return;
    if (!chance(TK.aiSeekChance)) return;
    const lowMana = w.mana < CONFIG.wizard.maxMana * TK.aiLowMana;
    const t = this.tickets.bestFor(w, this.target, TK.aiSeekRange, lowMana);
    if (!t) return;
    this.ticketGoal = t;
    this.ticketGoalId = t.id;
    this.ticketGoalTime = 0;
  }

  /** Hit recently, a spell on course to hit it, a big windup from the opponent, or already reacting. */
  private underFire(): boolean {
    const w = this.self;
    if (this.time - this.lastHurtAt < TK.aiHurtMemory || this.reactions.length > 0 || w.stunned) return true;
    if (this.target.cast) return true;
    const chest = w.chest(tmpC);
    for (const proj of this.spells.pool.active) {
      if (proj.owner === w) continue;
      const rx = chest.x - proj.pos.x, ry = chest.y - proj.pos.y, rz = chest.z - proj.pos.z;
      const v2 = proj.vel.lengthSq();
      if (v2 < 1e-4) continue;
      const t = (rx * proj.vel.x + ry * proj.vel.y + rz * proj.vel.z) / v2;
      if (t < 0 || t > 1.2) continue;
      if (Math.hypot(rx - proj.vel.x * t, ry - proj.vel.y * t, rz - proj.vel.z * t) < 2) return true;
    }
    return false;
  }

  private findCover(): void {
    let best = Infinity;
    this.hasCover = false;
    for (const pillar of this.arena.pillars) {
      if (!pillar.alive || !pillar.cover) continue;
      const away = tmpC.subVectors(pillar.position, this.target.pos).setY(0).normalize();
      // Just behind the far side of the footprint (a cylinder's radius, or a box's extent that way).
      const spot = tmpB.copy(pillar.position).addScaledVector(away, pillar.extentToward(away.x, away.z) + 1.3);
      if (this.arena.hazardAt(spot.x, spot.z, CONFIG.wizard.radius + 0.5)) continue;
      const d = spot.distanceTo(this.self.pos) + spot.distanceTo(this.target.pos) * 0.3;
      if (d < best) {
        best = d;
        this.coverPoint.copy(spot);
        this.hasCover = true;
      }
    }
  }

  private steer(dt: number, toTarget: THREE.Vector3, dist: number): void {
    const w = this.self;
    const p = this.profile;
    const move = tmpB.set(0, 0, 0);

    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = rand(0.8, 2.4);
      if (chance(0.6)) this.strafeDir *= -1;
    }
    const strafe = tmpC.set(-toTarget.z, 0, toTarget.x).multiplyScalar(this.strafeDir);
    let sprint = false;

    switch (this.state) {
      case 'approach': {
        move.copy(toTarget).addScaledVector(strafe, 0.45);
        sprint = dist > p.preferredRange[1] + 6;
        if (!this.hasLos) move.addScaledVector(strafe, 0.6); // work around the pillar
        break;
      }
      case 'attack': {
        const [near, far] = p.preferredRange;
        const ideal = this.punishTimer > 0 ? near * 0.7 : (near + far) / 2;
        const radial = clamp((dist - ideal) / 4, -1, 1);
        move.copy(strafe).multiplyScalar(p.strafeSpeed).addScaledVector(toTarget, radial * 0.8);
        // Skilled duelists hop now and then mid-strafe (it also slips bolts aimed at the chest).
        const J = CONFIG.wizard.jump;
        const hopSkill = clamp((p.dodgeChance - J.aiHopMinSkill) / (1 - J.aiHopMinSkill), 0, 1);
        const hopRate = p.hopRate ?? J.aiHopRate * hopSkill;
        if (hopRate > 0 && w.grounded && !w.cast && chance(hopRate * dt)) w.intent.press('jump');
        break;
      }
      case 'retreat': {
        if (this.hasCover && this.coverPoint.distanceTo(w.pos) > 0.8) {
          move.subVectors(this.coverPoint, w.pos).setY(0).normalize();
          // Sprinting blocks mana regen, so only sprint to cover when retreating for health.
          sprint = w.mana > 50;
        } else {
          move.copy(toTarget).negate().addScaledVector(strafe, 0.5);
        }
        break;
      }
      case 'evade':
        move.copy(this.desiredMove);
        break;
    }
    // Detour to a golden ticket, still strafing a little (and still shooting: aiming is separate).
    const goal = this.ticketGoal;
    if (goal && this.state !== 'evade') {
      move.subVectors(goal.pos, w.pos).setY(0);
      const d = move.length();
      move.divideScalar(d || 1).addScaledVector(strafe, d > 3 ? 0.25 : 0);
      sprint = d > 5 && w.mana > CONFIG.wizard.sprintRecoverMana;
    }
    if (this.state !== 'evade') this.keepFormation(move);
    // On the carpet: get away fast, sideways and back (a life pack goal above still wins).
    if (w.riding && !goal) move.copy(toTarget).multiplyScalar(-0.55).addScaledVector(strafe, 1);
    // Hurt, in our own vape cloud: stay inside it (healing, hidden) and keep moving within it.
    const smoke = this.useRewards && w.learned.has('vape') && w.health < w.maxHealth * RAI.vapeStayHealth ? this.arena.smokeAt(w.pos.x, w.pos.z, w) ?? this.ownSmokeNear() : null;
    if (smoke && this.state !== 'evade' && !goal) {
      const dx = smoke.x - w.pos.x, dz = smoke.z - w.pos.z;
      const d = Math.hypot(dx, dz);
      const pull = clamp((d - smoke.radius * 0.45) / (smoke.radius * 0.3), -0.6, 1.2);
      move.copy(strafe).multiplyScalar(0.7);
      if (d > 1e-3) {
        move.x += (dx / d) * pull;
        move.z += (dz / d) * pull;
      }
      sprint = false;
    }

    // Running out of a telegraphed boss power wins over everything else.
    const escaping = this.time < this.escapeUntil && this.state !== 'evade';
    if (escaping) {
      move.copy(this.escapeDir);
      sprint = w.mana > CONFIG.wizard.sprintRecoverMana;
    }

    // Steer round standing toxic clouds (an enemy boss's), like lava.
    for (const h of this.spells.powers.hazards) {
      if (!h.active || h.kind !== 'cloud' || !h.fired || h.owner.side === w.side) continue;
      const dx = w.pos.x - h.at.x, dz = w.pos.z - h.at.z;
      const d = Math.hypot(dx, dz) || 1e-3;
      const reach = h.radius + PAI.cloudMargin + w.radius;
      if (d > reach + 1.5) continue;
      const push = clamp((reach + 1.5 - d) / 1.5, 0, 2);
      move.x += (dx / d) * push;
      move.z += (dz / d) * push;
    }

    // Stay out of lava and the fire.
    this.arena.avoidHazards(w.pos, move);
    const r = Math.hypot(w.pos.x, w.pos.z);
    const safe = this.fireRadius() - AI.fireMargin;
    if (r > safe - 2) {
      const push = clamp((r - (safe - 2)) / 2, 0, 1.5);
      move.x -= (w.pos.x / r) * push * 1.5;
      move.z -= (w.pos.z / r) * push * 1.5;
      if (this.state === 'attack' && r > safe) this.strafeDir *= -1;
    }

    if (move.lengthSq() > 1) move.normalize();
    // Smooth direction changes so movement reads as intentional, not jittery (a dash out of a power is sharp).
    if (escaping) this.desiredMove.copy(move);
    else if (this.state !== 'evade') this.desiredMove.lerp(move, 1 - Math.exp(-10 * dt));
    w.intent.move.copy(this.desiredMove);
    w.intent.sprint = sprint;
  }

  /** Our own vape cloud within a few metres (to step back into), if any. */
  private ownSmokeNear(): { x: number; z: number; radius: number } | null {
    const w = this.self;
    for (const s of this.arena.smokes) if (s.owner === w && Math.hypot(w.pos.x - s.x, w.pos.z - s.z) < s.radius + 3) return s;
    return null;
  }

  /**
   * Double fights: push away from allies closer than CONFIG.campaign.duo.spacing, and drift around
   * the target away from an ally until flankDegrees separate the two (so one can't be watched
   * without losing sight of the other). Mild: added on top of the state's own movement.
   */
  private keepFormation(move: THREE.Vector3): void {
    const w = this.self, t = this.target;
    const flank = THREE.MathUtils.degToRad(DUO.flankDegrees);
    for (const a of this.allies) {
      if (a === w || !a.alive) continue;
      const dx = w.pos.x - a.pos.x, dz = w.pos.z - a.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < DUO.spacing) {
        const push = (1 - d / DUO.spacing) * DUO.spacingWeight;
        if (d > 1e-3) {
          move.x += (dx / d) * push;
          move.z += (dz / d) * push;
        } else {
          move.x += push * (w.index % 2 ? 1 : -1);
        }
      }
      // Angular separation around the target, + when we are counter-clockwise of the ally.
      const sep = wrapAngle(Math.atan2(w.pos.x - t.pos.x, w.pos.z - t.pos.z) - Math.atan2(a.pos.x - t.pos.x, a.pos.z - t.pos.z));
      if (Math.abs(sep) < flank) {
        const sign = Math.abs(sep) > 1e-3 ? Math.sign(sep) : w.index % 2 ? 1 : -1;
        const rx = w.pos.x - t.pos.x, rz = w.pos.z - t.pos.z;
        const r = Math.hypot(rx, rz) || 1;
        // Tangent pointing toward larger angles: d(atan2(x, z)) > 0 along (rz, -rx).
        const k = (1 - Math.abs(sep) / flank) * DUO.flankWeight * sign;
        move.x += (rz / r) * k;
        move.z += (-rx / r) * k;
      }
    }
  }

  private aimAndAttack(dt: number, dist: number): void {
    const w = this.self;
    const t = this.target;
    const p = this.profile;
    const intent = w.intent;

    // Smoothly wandering aim error, scaled by distance.
    this.noiseTimer -= dt;
    if (this.noiseTimer <= 0) {
      this.noiseTimer = rand(0.25, 0.6);
      this.aimNoiseTarget.set(rand(-1, 1), rand(-0.5, 0.5), rand(-1, 1)).multiplyScalar(p.aimError * dist);
    }
    this.aimNoise.lerp(this.aimNoiseTarget, 1 - Math.exp(-6 * dt));

    // Lead the target based on the spell we'd throw.
    const usingBlast = w.cast?.spell === 'blast' || intent.wants('blast');
    const speed = usingBlast ? SP.blast.speed : SP.bolt.speed;
    const lead = (dist / speed) * p.leadFactor;
    const aim = w.aimPoint;
    if (this.lost) {
      // Lost in a cloud: aim (and, if blind, fire) at where the target was last seen.
      aim.set(this.lastSeen.x, this.lastSeen.y + 1.2, this.lastSeen.z);
    } else {
      t.chest(aim).addScaledVector(t.vel, lead);
    }
    if (!t.grounded && !this.lost) {
      // Ballistic lead for a jumping target, never below the ground it will land on.
      const g = CONFIG.wizard.jump.gravity;
      const feetY = Math.max(t.groundY, t.pos.y + t.vy * lead - 0.5 * g * lead * lead);
      aim.y += feetY - t.pos.y;
    }
    if (usingBlast) aim.y = t.pos.y + 0.5; // splash at the feet (a flying target's, in the air)
    // A stun beam and the fire breath aim true (the breath is a short cone anyway).
    if (w.cast?.spell !== 'stun' && !w.breathing) aim.add(this.aimNoise);
    intent.facing = Math.atan2(aim.x - w.pos.x, aim.z - w.pos.z);

    intent.holdBolt = false;
    const sees = this.hasLos || this.blind;
    if (this.state !== 'attack' && !(this.state === 'approach' && sees && dist < 22)) return;
    // A transforming boss is immune: hold fire (and let mana recover) until it is done.
    if (!sees || w.cast || w.stunned || t.evolving || this.spells.volleyFiring(w) || this.spells.powers.channeling(w)) return;
    // Boss stages gate everything beyond bolts (charge still builds while the Ultimate is locked).
    const a = this.attacks;
    const canBlast = !a || a.blast, canStun = !a || a.stun, canUlt = !a || a.ultimate;

    // Ultimate when it would land: opponent not shielding, and either their roll is on cooldown or
    // they're already coming down from a jump (both evasions are spent).
    const committed = t.cd.dodge > 0.3 || t.stunned || (!t.grounded && t.vy < 0);
    if (canUlt && w.ult >= SP.ultimate.chargeMax && !t.shielded && (committed || chance(0.01))) {
      intent.press('ultimate');
      return;
    }

    // Stun -> Blast combo.
    if (this.comboBlastAt > 0 && this.time >= this.comboBlastAt) {
      this.comboBlastAt = -1;
      if (t.stunned && canBlast) intent.press('blast');
    }

    // Signature volley, on its own cooldown, whenever the target is in range.
    const volley = a?.volley;
    if (volley && this.volleyCd <= 0 && dist <= VOLLEY.range && this.spells.castVolley(w, volley)) {
      this.volleyCd = volley.cooldown * VOLLEY.cooldownScale * rand(0.85, 1.15);
      this.burstLeft = 0;
      this.pauseTimer = Math.max(this.pauseTimer, rand(p.burstPause[0], p.burstPause[1]) * 0.6);
      return;
    }

    this.decisionTimer -= dt;
    if (this.decisionTimer <= 0) {
      this.decisionTimer = rand(0.35, 0.7);
      const aggressive = this.punishTimer > 0;
      if (canStun && w.cd.stun <= 0 && w.mana >= SP.stun.manaCost && dist < 20 && chance(aggressive ? 0.7 : p.stunChance * 0.5)) {
        intent.press('stun');
        this.comboBlastAt = this.time + SP.stun.castTime + 0.15;
        return;
      }
      if (canBlast && w.cd.blast <= 0 && w.mana >= SP.blast.manaCost && chance(aggressive || t.stunned ? 0.9 : p.blastChance * 0.5)) {
        intent.press('blast');
        return;
      }
    }

    // Bolt bursts.
    if (this.pauseTimer > 0) {
      this.pauseTimer -= dt;
      return;
    }
    if (this.burstLeft <= 0) {
      // Pump It before a burst, if it was learned and there is mana to spare for the burst.
      if (this.useRewards && w.learned.has('pump') && this.spells.rewards.ready(w, 'pump') && w.mana >= RS.pump.manaCost + RAI.pumpManaSpare) {
        intent.press('pump');
      }
      this.burstLeft = randInt(p.burst[0], p.burst[1]) + (this.punishTimer > 0 ? 2 : 0);
      this.burstCastsAtStart = w.stats.casts;
    }
    intent.holdBolt = true;
    if (w.stats.casts - this.burstCastsAtStart >= this.burstLeft || w.mana < SP.bolt.manaCost) {
      this.burstLeft = 0;
      intent.holdBolt = false;
      this.pauseTimer = rand(p.burstPause[0], p.burstPause[1]) * (this.punishTimer > 0 ? 0.4 : 1);
    }
  }
}
