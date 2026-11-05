/**
 * The CPU rival's and the bosses' brain in the sim: the deterministic port of
 * src/enemy/AIController.ts (approach / attack / evade / retreat, threat perception, timed shields
 * and rolls, wave jumps, golden tickets, double-fight formation, boss volleys and special powers,
 * evading the player's... and its own side's... nothing). It writes the wizard's intent like a
 * controller and draws every random choice from the world's seeded PRNG.
 *
 * Left out on purpose: the reward-spell, life-pack and spring logic of AIController. Only the QA
 * soak's reference AI (driving the player) ever used them; the rival and the bosses never do.
 */
import { CONFIG, type AIProfile } from '../config';
import type { BossFighter, PowerDef, StageAttacks } from '../campaign/levels';
import type { Obstacle } from './arena';
import {
  ONE, abs, atan2, clamp, cos, deg, div, fx, len2, len3, max, mul, muldiv, sec, setLength2, sin, wrapAngle, type V3,
} from './fixed';
import { stageProfile } from './stages';
import {
  A_BLAST, A_DODGE, A_JUMP, A_SHIELD, A_STUN, A_ULT, CD_BLAST, CD_DODGE, CD_SHIELD, CD_STUN, type SimWizard,
} from './wizard';
import type { SimWorld } from './world';

const AI = CONFIG.ai;
const SP = CONFIG.spells;
const VOLLEY = CONFIG.campaign.volley;
const DUO = CONFIG.campaign.duo;
const TK = CONFIG.tickets;
const PW = CONFIG.powers;
const PAI = CONFIG.powers.ai;
const J = CONFIG.wizard.jump;
const WZ = CONFIG.wizard;

type State = 'approach' | 'attack' | 'evade' | 'retreat';

interface Reaction {
  at: number;
  action: 'dodge' | 'shield' | 'jump';
  x: number;
  z: number;
}

/** An AIProfile in sim units. */
interface Profile {
  reaction: number;
  aimError: number;
  lead: number;
  dodge: number;
  shieldPref: number;
  perfect: number;
  burst: [number, number];
  burstPause: [number, number];
  blast: number;
  stun: number;
  punish: number;
  strafe: number;
  range: [number, number];
  /** Hops per second (Q16). */
  hop: number;
}

function convert(p: AIProfile): Profile {
  const hopSkill = clamp((p.dodgeChance - J.aiHopMinSkill) / (1 - J.aiHopMinSkill), 0, 1);
  return {
    reaction: sec(p.reactionTime),
    aimError: fx(p.aimError),
    lead: fx(p.leadFactor),
    dodge: fx(p.dodgeChance),
    shieldPref: fx(p.shieldPreference),
    perfect: fx(p.perfectShieldChance),
    burst: [p.burst[0], p.burst[1]],
    burstPause: [sec(p.burstPause[0]), sec(p.burstPause[1])],
    blast: fx(p.blastChance),
    stun: fx(p.stunChance),
    punish: fx(p.punishChance),
    strafe: fx(p.strafeSpeed),
    range: [fx(p.preferredRange[0]), fx(p.preferredRange[1])],
    hop: fx(p.hopRate !== undefined ? p.hopRate : J.aiHopRate * hopSkill),
  };
}

const K = {
  shieldMana: fx(SP.shield.manaCost),
  stunMana: fx(SP.stun.manaCost),
  blastMana: fx(SP.blast.manaCost),
  boltMana: fx(SP.bolt.manaCost),
  ultMax: fx(SP.ultimate.chargeMax),
  splash: fx(SP.blast.splashRadius),
  splashSeen: fx(SP.blast.splashRadius * 0.6),
  wizR: fx(WZ.radius),
  boltSpeed: fx(SP.bolt.speed),
  blastSpeed: fx(SP.blast.speed),
  waveSpeed: fx(SP.ultimate.waveSpeed),
  gravity: fx(J.gravity),
  /** Seconds from takeoff to apex, TU. */
  apex: sec(J.velocity / J.gravity),
  waveJumpErr: sec(J.aiWaveJumpError),
  waveJump: fx(J.aiWaveJump),
  iframes: sec(WZ.dodge.iframes),
  dodgeSpeed: fx(WZ.dodge.speed),
  dodgeReach: fx(WZ.dodge.speed * WZ.dodge.duration * 0.8),
  perfectWindow: sec(SP.shield.perfectWindow),
  stunCast: sec(SP.stun.castTime),
  maxMana: fx(WZ.maxMana),
  sprintRecover: fx(WZ.sprintRecoverMana),
  punishTime: sec(AI.punishTime),
  retreatCooldown: sec(AI.retreatCooldown),
  retreatHealth: fx(AI.retreatHealth),
  lowMana: fx(AI.lowMana),
  fireMargin: fx(AI.fireMargin),
  lavaMargin: fx(CONFIG.arena.lavaMargin),
  castReveal: sec(AI.castRevealTime),
  lostTrack: sec(AI.lostTrackTime),
  volleyRange: fx(VOLLEY.range),
  volleyCdScale: fx(VOLLEY.cooldownScale),
  volleyFirst: fx(VOLLEY.firstDelay),
  duoSpacing: fx(DUO.spacing),
  duoSpacingW: fx(DUO.spacingWeight),
  duoFlank: deg(DUO.flankDegrees),
  duoFlankW: fx(DUO.flankWeight),
  ticketRange: fx(TK.aiSeekRange),
  ticketLow: fx(WZ.maxMana * TK.aiLowMana),
  ticketChance: fx(TK.aiSeekChance),
  ticketCheck: sec(TK.aiCheckInterval),
  ticketGiveUp: sec(TK.aiGiveUpTime),
  hurtMemory: sec(TK.aiHurtMemory),
  boost3: sec(TK.boostDuration / 3),
  ticketY: fx(TK.hoverHeight),
  zoneGrace: fx(PW.zoneGrace),
  zoneMargin: fx(PAI.zoneMargin),
  zoneHorizon: sec(PAI.zoneHorizon),
  rollLead: sec(PAI.rollLead),
  seekerLead: sec(PAI.seekerLead),
  notice: fx(PAI.notice),
  cloudMargin: fx(PAI.cloudMargin),
  firstDelay: fx(PW.firstDelay),
};
/** 1 - exp(-10 dt) and 1 - exp(-6 dt) per 60 Hz tick (steer and aim-noise smoothing). */
const STEER_SMOOTH = 10061;
const NOISE_SMOOTH = 6237;
const F = (x: number) => fx(x);
const F_0_05 = F(0.05), F_0_25 = F(0.25), F_0_3 = F(0.3), F_0_35 = F(0.35);
const F_0_45 = F(0.45), F_0_5 = F(0.5), F_0_6 = F(0.6), F_0_7 = F(0.7), F_0_8 = F(0.8), F_0_9 = F(0.9), F_1_1 = F(1.1), F_1_2 = F(1.2), F_1_25 = F(1.25), F_1_3 = F(1.3);
const F_1_4 = F(1.4), F_1_5 = F(1.5), F_1_6 = F(1.6), F_2 = F(2), F_22 = F(22), F_0_4 = F(0.4), F_0_01 = F(0.01), F_0_85 = F(0.85), F_1_15 = F(1.15), F_50 = F(50), F_6 = F(6);

export class SimAI {
  state: State = 'approach';
  private p: Profile;
  attacks: StageAttacks | null = null;
  private stage = 0;
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
  private lost = false;
  private blind = false;
  private readonly lastSeen: V3 = { x: 0, y: 0, z: 0 };
  private lastSeenAt = -1e12;
  private comboBlastAt = -1;
  private readonly desired: V3 = { x: 0, y: 0, z: 0 };
  private readonly noise: V3 = { x: 0, y: 0, z: 0 };
  private readonly noiseTarget: V3 = { x: 0, y: 0, z: 0 };
  private noiseTimer = 0;
  private readonly cover: V3 = { x: 0, y: 0, z: 0 };
  private hasCover = false;
  private ultWatch = -1;
  private retreatCooldown = 0;
  private ticketGoal = 0;
  private ticketGoalTime = 0;
  private ticketCheck = 0;
  private lastHurtAt = -1e12;
  /** Hazards noticed (id -> time, or -1 never) and planned for, as parallel arrays. */
  private readonly noticedIds: number[] = [];
  private readonly noticedAt: number[] = [];
  private readonly planned: number[] = [];
  private readonly escape: V3 = { x: 0, y: 0, z: 0 };
  private escapeUntil = -1;
  private lookAwayAngle = 0;
  private lookAwayUntil = -1;

  constructor(
    private readonly world: SimWorld,
    readonly self: SimWizard,
    public target: SimWizard,
    profile: AIProfile,
    readonly boss: BossFighter | null,
  ) {
    this.p = convert(profile);
    const ev = world.events;
    const me = self.index;
    ev.on('explosion', (e) => {
      if (e.w === this.target.index && len3(e.x - self.pos.x, e.y - self.pos.y, e.z - self.pos.z) > K.splash) this.tryPunish();
    });
    ev.on('stunned', (e) => {
      if (e.w === this.target.index) this.tryPunish();
    });
    ev.on('ultWave', (e) => {
      if (e.w === this.target.index) this.ultWatch = self.health;
    });
    ev.on('dodgeEvade', (e) => {
      if (e.w === me && this.ultWatch >= 0) this.tryPunish();
    });
    ev.on('evaded', (e) => {
      if (e.w === me && this.ultWatch >= 0) this.tryPunish();
    });
    ev.on('damage', (e) => {
      if (e.w === me) this.lastHurtAt = this.time;
    });
    const st = world.stages.filter((s) => s.owner === self)[0];
    if (st && boss) {
      st.onStage = (stage) => {
        this.attacks = boss.stages[stage].attacks;
        this.p = convert(stageProfile(boss, stage));
        this.stage = stage;
        this.resetVolley();
        this.armPowers();
      };
    }
  }

  private get rng() {
    return this.world.rng;
  }

  private chance(p: number): boolean {
    return this.rng.chance(p);
  }

  /** A random value in [lo, hi] (Q16 or TU). */
  private rand(lo: number, hi: number): number {
    return this.rng.range(lo, hi);
  }

  reset(): void {
    this.state = 'approach';
    this.stateTime = 0;
    this.reactions = [];
    this.burstLeft = 0;
    this.pauseTimer = this.rand(sec(0.3), sec(0.8));
    this.punishTimer = 0;
    this.comboBlastAt = -1;
    this.ultWatch = -1;
    this.retreatCooldown = 0;
    this.desired.x = this.desired.z = 0;
    this.noise.x = this.noise.y = this.noise.z = 0;
    this.resetVolley();
    this.ticketGoal = 0;
    this.lastHurtAt = -1e12;
    this.noticedIds.length = this.noticedAt.length = this.planned.length = 0;
    this.escapeUntil = this.lookAwayUntil = -1;
    this.armPowers();
  }

  private resetVolley(): void {
    const v = this.attacks && this.attacks.volley;
    this.volleyCd = v ? mul(mul(sec(v.cooldown), K.volleyCdScale), K.volleyFirst) : 0;
  }

  private tryPunish(): void {
    if (this.chance(this.p.punish)) this.punishTimer = K.punishTime;
  }

  private setState(s: State): void {
    if (this.state === s) return;
    this.state = s;
    this.stateTime = 0;
  }

  update(dt: number): void {
    const w = this.self;
    this.time += dt;
    this.stateTime += dt;
    if (this.punishTimer > 0) this.punishTimer -= dt;
    if (this.retreatCooldown > 0) this.retreatCooldown -= dt;

    if (!w.alive || !this.target.alive || w.evolving) {
      w.moveX = w.moveZ = 0;
      w.holdBolt = w.sprint = false;
      if (w.evolving) {
        this.reactions.length = 0;
        this.burstLeft = 0;
        this.comboBlastAt = -1;
      }
      return;
    }
    if (this.volleyCd > 0) this.volleyCd -= dt;

    this.losTimer -= dt;
    if (this.losTimer <= 0) {
      this.losTimer = sec(0.15);
      const t = this.target;
      const ay = w.pos.y + w.chestY, by = t.pos.y + t.chestY;
      const solid = this.world.arena.clear(w.pos.x, ay, w.pos.z, t.pos.x, by, t.pos.z, false);
      const revealed = t.sinceAttack < K.castReveal;
      this.lost = !revealed && this.obscured(w.pos.x, ay, w.pos.z, t.pos.x, by, t.pos.z);
      this.hasLos = solid && !this.lost;
      if (this.hasLos) {
        this.lastSeen.x = t.pos.x;
        this.lastSeen.y = t.pos.y;
        this.lastSeen.z = t.pos.z;
        this.lastSeenAt = this.time;
      }
      this.blind = this.lost && solid && this.time - this.lastSeenAt < K.lostTrack;
    }

    const goal = this.lost ? this.lastSeen : this.target.pos;
    let tx = goal.x - w.pos.x, tz = goal.z - w.pos.z;
    const dist = len2(tx, tz);
    if (dist > 0) {
      tx = muldiv(tx, ONE, dist);
      tz = muldiv(tz, ONE, dist);
    }

    this.perceiveThreats();
    this.evadePowers();
    this.runReactions();
    this.chooseState(dist);
    this.thinkTickets(dt);
    this.steer(dt, tx, tz, dist);
    this.thinkPowers(dist);
    this.aimAndAttack(dt, dist);
    const pw = this.world.powers;
    if (pw.channeling(w)) {
      w.moveX = w.moveZ = 0;
      this.desired.x = this.desired.z = 0;
      w.sprint = w.holdBolt = false;
      const f = pw.channelFacing(w);
      if (f >= 0) w.facing = f;
    }
    if (this.time < this.lookAwayUntil) {
      w.facing = this.lookAwayAngle;
      w.holdBolt = false;
    }
  }

  /** Soft cover (layout clouds, dropped smoke) between a and b, or either end inside one. */
  private obscured(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    for (const c of this.world.arena.clouds) if (segmentInCloud(ax, ay, az, bx, by, bz, c.cx, c.cz, c.r, c.height)) return true;
    for (const s of this.world.rewards.smokes) if (segmentInCloud(ax, ay, az, bx, by, bz, s.x, s.z, s.r, s.height)) return true;
    return false;
  }

  // ------------------------------------------------------------------ boss powers

  private armPowers(): void {
    const b = this.boss;
    if (!b) return;
    const pw = this.world.powers;
    for (const d of b.powers) {
      if (d.from <= this.stage) pw.setCooldown(this.self, d, mul(mul(pw.recharge(d, this.stage), K.firstDelay), this.rand(F_0_8, F_1_4)));
    }
  }

  private thinkPowers(dist: number): void {
    const b = this.boss, w = this.self, pw = this.world.powers;
    if (!b || b.powers.length === 0 || !pw.open || !w.canAct || pw.busy(w) || this.target.evolving || this.world.spells.volleyFiring(w)) return;
    if (this.state !== 'attack' && this.state !== 'approach') return;
    const sees = this.hasLos && !this.lost;
    let pick: PowerDef | null = null;
    let n = 0;
    for (const d of b.powers) {
      if (d.from > this.stage || pw.cooldown(w, d) > 0 || dist > fx(d.range)) continue;
      const fromAbove = d.kind === 'strike' || d.kind === 'barrage' || d.kind === 'cloud';
      if (PW.needSight && !sees && !fromAbove) continue;
      n++;
      if (this.chance(div(ONE, n * ONE))) pick = d;
    }
    if (pick) pw.cast(w, pick, this.target, this.stage);
  }

  private noticedTime(id: number): number | null {
    const i = this.noticedIds.indexOf(id);
    return i < 0 ? null : this.noticedAt[i];
  }

  private evadePowers(): void {
    const w = this.self, p = this.p, pw = this.world.powers;
    if (!w.alive || w.stunned) return;
    let ex = 0, ez = 0;
    let roll = false, rx = 0, rz = 0;
    for (const h of pw.hazards) {
      if (!h.active || h.owner.side === w.side || h.delay > 0 || h.done.indexOf(w.index) >= 0) continue;
      let seen = this.noticedTime(h.id);
      if (seen === null) {
        seen = this.chance(p.dodge + mul(ONE - p.dodge, K.notice)) ? this.time : -1;
        this.noticedIds.push(h.id);
        this.noticedAt.push(seen);
      }
      if (seen < 0 || this.time - seen < mul(p.reaction, this.rand(F_0_9, F_1_1))) continue;
      const dx = w.pos.x - h.at.x, dz = w.pos.z - h.at.z;
      const d = len2(dx, dz);
      const face = w.facing;
      switch (h.kind) {
        case 'zone':
        case 'flash':
        case 'cloud': {
          if (h.track > 0 || (h.fired && h.kind !== 'cloud')) break;
          const fires = h.fired ? 0 : h.warn;
          if (fires > K.zoneHorizon) break;
          if (h.kind === 'flash' && d < h.radius + ONE && fires < sec(0.4)) {
            this.lookAwayAngle = atan2(dx, dz);
            this.lookAwayUntil = this.time + fires + sec(0.15);
          }
          const reach = h.radius + mul(w.radius, K.zoneGrace);
          if (d > reach + K.zoneMargin) break;
          const k = muldiv(ONE, 6000, max(sec(0.15), fires));
          // Away from the centre (cos/-sin of the facing when standing on it, as the original).
          const ux = d > F_0_05 ? muldiv(dx, ONE, d) : cos(face);
          const uz = d > F_0_05 ? muldiv(dz, ONE, d) : -sin(face);
          ex += mul(ux, k);
          ez += mul(uz, k);
          if (h.kind === 'zone' && d < reach && fires < K.rollLead && !roll) {
            roll = true;
            rx = ux;
            rz = uz;
          }
          break;
        }
        case 'cone': {
          if (h.fired || d > h.radius + F_1_5) break;
          const off = wrapAngle(atan2(dx, dz) - h.angle);
          if (abs(off) > (h.arc >> 1) + rad035) break;
          const side = off >= 0 ? 1 : -1;
          const sx = cos(h.angle) * side, sz = -sin(h.angle) * side;
          const k = muldiv(ONE, 6000, max(sec(0.15), h.warn));
          ex += mul(sx, k);
          ez += mul(sz, k);
          if (h.warn < K.rollLead && !roll) {
            roll = true;
            rx = sx;
            rz = sz;
          }
          break;
        }
        case 'ring':
        case 'sweep': {
          if (this.planned.indexOf(h.id) >= 0) break;
          let arrive: number;
          if (h.kind === 'ring') {
            const gap = d - w.radius - h.radius;
            if (gap < 0) break;
            arrive = (h.fired ? 0 : h.warn) + muldiv(gap, 6000, max(1, h.speed));
          } else {
            if (d > h.radius + ONE) break;
            const from = h.fired ? h.angle : h.start;
            const left = wrapAngle(atan2(dx, dz) - from) * h.dir;
            if (left < 0) break;
            arrive = (h.fired ? 0 : h.warn) + muldiv(left, h.life, max(1, h.arc));
          }
          const lead = K.apex + mul(mul(this.rand(-ONE, ONE), K.waveJumpErr), ONE - p.dodge);
          if (w.canJump) {
            if (arrive > lead) break;
            this.planned.push(h.id);
            w.press(A_JUMP);
          } else {
            if (arrive > (K.iframes >> 1)) break;
            this.planned.push(h.id);
            if (!roll) {
              const u = { x: 0, y: 0, z: 0 };
              if (setLength2(u, -dx, -dz, ONE)) {
                roll = true;
                rx = u.x;
                rz = u.z;
              }
            }
          }
          break;
        }
        case 'seeker': {
          if (h.target !== w) break;
          const cd = len3(w.pos.x - h.at.x, w.pos.y + w.chestY - h.at.y, w.pos.z - h.at.z);
          if (muldiv(cd, 6000, max(ONE, h.speed)) > K.seekerLead || this.planned.indexOf(h.id) >= 0) break;
          this.planned.push(h.id);
          const canShield = w.cd[CD_SHIELD] <= 0 && w.mana >= K.shieldMana;
          if (canShield && this.chance(p.shieldPref)) this.reactions.push({ at: this.time, action: 'shield', x: 0, z: 0 });
          else if (!roll) {
            const u = { x: 0, y: 0, z: 0 };
            if (setLength2(u, -h.vel.z, h.vel.x, ONE)) {
              roll = true;
              rx = u.x;
              rz = u.z;
            }
          }
          break;
        }
      }
    }
    if (ex !== 0 || ez !== 0) {
      const u = { x: 0, y: 0, z: 0 };
      if (setLength2(u, ex, ez, ONE)) {
        this.biasAway(u);
        this.escape.x = u.x;
        this.escape.z = u.z;
        this.escapeUntil = this.time + sec(0.2);
      }
    }
    if (roll && w.cd[CD_DODGE] <= 0 && !w.dodging && w.grounded) {
      const u = { x: rx, y: 0, z: rz };
      this.biasAway(u);
      w.moveX = this.desired.x = u.x;
      w.moveZ = this.desired.z = u.z;
      w.press(A_DODGE);
      this.setState('evade');
    }
    if (this.noticedIds.length > 96) {
      // Forget hazards long gone.
      const live: number[] = [];
      for (const h of pw.hazards) if (h.active) live.push(h.id);
      for (let i = this.noticedIds.length - 1; i >= 0; i--) {
        if (live.indexOf(this.noticedIds[i]) < 0) {
          this.noticedIds.splice(i, 1);
          this.noticedAt.splice(i, 1);
        }
      }
      for (let i = this.planned.length - 1; i >= 0; i--) if (live.indexOf(this.planned[i]) < 0) this.planned.splice(i, 1);
    }
  }

  // ------------------------------------------------------------------ perception

  private perceiveThreats(): void {
    const w = this.self, p = this.p;
    const cx = w.pos.x, cy = w.pos.y + w.chestY, cz = w.pos.z;
    const bit = 1 << w.index;
    const list = this.world.spells.active;
    for (let i = 0; i < list.length; i++) {
      const proj = list[i];
      if (proj.owner.side === w.side || proj.seen & bit) continue;
      const rx = proj.pos.x - cx, ry = proj.pos.y - cy, rz = proj.pos.z - cz;
      const v2 = mul(proj.vel.x, proj.vel.x) + mul(proj.vel.y, proj.vel.y) + mul(proj.vel.z, proj.vel.z);
      if (v2 < 7) continue;
      const t = div(-(mul(rx, proj.vel.x) + mul(ry, proj.vel.y) + mul(rz, proj.vel.z)), v2);
      if (t < 0 || t > ONE) continue;
      const mx = rx + mul(proj.vel.x, t), my = ry + mul(proj.vel.y, t), mz = rz + mul(proj.vel.z, t);
      const splash = proj.kind === 'blast' ? K.splashSeen : 0;
      if (len3(mx, my, mz) > K.wizR + proj.radius + F_0_35 + splash) continue;
      proj.seen |= bit;
      if (!this.chance(p.dodge)) continue;
      const reactAt = this.time + mul(p.reaction, this.rand(F_0_8, F_1_25));
      const impactAt = this.time + muldiv(t, 6000, ONE);
      const canShield = w.cd[CD_SHIELD] <= 0 && w.mana >= K.shieldMana;
      if (reactAt > impactAt - sec(0.03)) {
        if (canShield && proj.kind === 'bolt' && this.chance(mul(p.shieldPref, F_0_6)) && !this.hasReaction('shield')) {
          this.reactions.push({ at: reactAt, action: 'shield', x: 0, z: 0 });
        }
        continue;
      }
      const wantShield = canShield && (proj.kind === 'bolt' || this.chance(F_0_5)) && this.chance(p.shieldPref);
      if (wantShield) {
        const perfect = this.chance(p.perfect);
        const at = perfect ? max(reactAt, impactAt - mul(K.perfectWindow, F_0_6)) : reactAt;
        this.reactions.push({ at, action: 'shield', x: 0, z: 0 });
      } else {
        const side = { x: 0, y: 0, z: 0 };
        if (!setLength2(side, -proj.vel.z, proj.vel.x, ONE)) continue;
        if (mul(side.x, mx) + mul(side.z, mz) > 0) {
          side.x = -side.x;
          side.z = -side.z;
        }
        this.biasAway(side);
        this.reactions.push({ at: max(reactAt, impactAt - mul(K.iframes, F_0_7)), action: 'dodge', x: side.x, z: side.z });
      }
    }

    // Telegraphed windups: the stun beam and the Ultimate.
    const tc = this.target.cast;
    if (tc && tc.elapsed < sec(0.02) && (tc.spell === 'stun' || tc.spell === 'ultimate') && this.chance(p.dodge)) {
      const remaining = tc.duration - tc.elapsed;
      const reactAt = this.time + mul(p.reaction, this.rand(F_0_8, F_1_2));
      if (tc.spell === 'stun' && reactAt < this.time + remaining + sec(0.05)) {
        const d = { x: 0, y: 0, z: 0 };
        if (setLength2(d, w.pos.x - this.target.pos.x, w.pos.z - this.target.pos.z, ONE)) {
          const s = this.chance(F_0_5) ? 1 : -1;
          const dir = { x: -d.z * s, y: 0, z: d.x * s };
          this.biasAway(dir);
          this.reactions.push({ at: max(reactAt, this.time + remaining - sec(0.08)), action: 'dodge', x: dir.x, z: dir.z });
        }
      } else if (tc.spell === 'ultimate') {
        const d = len3(w.pos.x - this.target.pos.x, w.pos.y - this.target.pos.y, w.pos.z - this.target.pos.z);
        const arrive = this.time + remaining + muldiv(d, 6000, K.waveSpeed);
        if (this.chance(mul(K.waveJump, p.dodge))) {
          const error = mul(mul(this.rand(-ONE, ONE), K.waveJumpErr), ONE - p.dodge);
          this.reactions.push({ at: max(reactAt, arrive - K.apex + error), action: 'jump', x: 0, z: 0 });
        } else {
          const dir = { x: 0, y: 0, z: 0 };
          if (!setLength2(dir, this.target.pos.x - w.pos.x, this.target.pos.z - w.pos.z, ONE)) dir.z = ONE;
          this.reactions.push({ at: max(reactAt, arrive - (K.iframes >> 1)), action: 'dodge', x: dir.x, z: dir.z });
        }
      }
    }
  }

  private hasReaction(a: Reaction['action']): boolean {
    for (const r of this.reactions) if (r.action === a) return true;
    return false;
  }

  private runReactions(): void {
    const w = this.self;
    for (let i = this.reactions.length - 1; i >= 0; i--) {
      const r = this.reactions[i];
      if (this.time < r.at) continue;
      this.reactions.splice(i, 1);
      if (w.stunned) continue;
      const canShield = w.cd[CD_SHIELD] <= 0 && w.mana >= K.shieldMana;
      if (r.action === 'shield' && canShield) {
        w.press(A_SHIELD);
      } else if (r.action === 'jump') {
        w.press(A_JUMP);
      } else if (!w.grounded && !w.dodging) {
        if (canShield) w.press(A_SHIELD);
      } else if (w.cd[CD_DODGE] <= 0 && !w.dodging) {
        if (mul(r.x, r.x) + mul(r.z, r.z) < F_0_01) {
          r.x = -cos(w.facing);
          r.z = sin(w.facing);
        }
        w.moveX = this.desired.x = r.x;
        w.moveZ = this.desired.z = r.z;
        w.press(A_DODGE);
        this.setState('evade');
      }
    }
  }

  /** Nudge a direction away from the fire ring, and never roll into a lava pool. */
  private biasAway(dir: V3): void {
    const w = this.self;
    const r = len2(w.pos.x, w.pos.z);
    const limit = this.world.arena.fireRadius - K.fireMargin - mul(K.dodgeSpeed, F_0_3);
    if (r > limit && r > 0) {
      const outward = muldiv(mul(dir.x, w.pos.x) + mul(dir.z, w.pos.z), ONE, r);
      if (outward > 0) {
        dir.x = -dir.x;
        dir.z = -dir.z;
      }
    }
    if (this.world.arena.hazardAt(w.pos.x + mul(dir.x, K.dodgeReach), w.pos.z + mul(dir.z, K.dodgeReach), K.wizR, this.world.shifts.hazards)) {
      dir.x = -dir.x;
      dir.z = -dir.z;
    }
  }

  // ------------------------------------------------------------------ decisions

  private chooseState(dist: number): void {
    const w = this.self, p = this.p;
    if (this.state === 'evade' && (w.dodging || this.stateTime < sec(0.25))) return;
    if (this.state === 'retreat') {
      const recovered = w.mana > mul(K.maxMana, F_0_6);
      if (!recovered && this.stateTime < sec(3) && this.punishTimer <= 0) return;
      this.retreatCooldown = K.retreatCooldown;
    } else if (this.punishTimer <= 0 && this.retreatCooldown <= 0) {
      const t = this.target;
      const hp = muldiv(w.health, ONE, w.maxHealth);
      const lowHealth = hp < K.retreatHealth && hp < muldiv(t.health, ONE, t.maxHealth);
      const lowMana = w.mana < mul(K.maxMana, K.lowMana);
      if (lowMana || (lowHealth && this.stateTime > sec(1.5) && this.chance(F_0_01))) {
        this.findCover();
        this.setState('retreat');
        return;
      }
    }
    const maxRange = this.punishTimer > 0 ? p.range[0] : p.range[1];
    if (dist > maxRange + F_2 || (!this.hasLos && !this.blind)) this.setState('approach');
    else this.setState('attack');
  }

  private thinkTickets(dt: number): void {
    const w = this.self;
    const tickets = this.world.tickets;
    if (this.ticketGoal && (!this.ticketById(this.ticketGoal) || w.stunned || (this.ticketGoalTime += dt) > K.ticketGiveUp)) this.ticketGoal = 0;
    if (this.ticketGoal || tickets.list.length === 0) return;
    this.ticketCheck -= dt;
    if (this.ticketCheck > 0) return;
    this.ticketCheck = K.ticketCheck;
    if (this.state === 'evade' || this.punishTimer > 0 || w.manaBoost > K.boost3 || this.underFire()) return;
    if (!this.chance(K.ticketChance)) return;
    const lowMana = w.mana < K.ticketLow;
    // TicketPool.bestFor: nearest seen ticket in range, closer to us than to the rival (unless low).
    let best = 0, bestD = K.ticketRange;
    for (const t of tickets.list) {
      const d = len2(w.pos.x - t.x, w.pos.z - t.z);
      if (d > bestD) continue;
      if (!lowMana && len2(this.target.pos.x - t.x, this.target.pos.z - t.z) <= d) continue;
      if (!this.world.arena.clear(w.pos.x, w.pos.y + w.chestY, w.pos.z, t.x, K.ticketY, t.z, false)) continue;
      bestD = d;
      best = t.id;
    }
    if (!best) return;
    this.ticketGoal = best;
    this.ticketGoalTime = 0;
  }

  private ticketById(id: number): { x: number; z: number } | null {
    for (const t of this.world.tickets.list) if (t.id === id) return t;
    return null;
  }

  private underFire(): boolean {
    const w = this.self;
    if (this.time - this.lastHurtAt < K.hurtMemory || this.reactions.length > 0 || w.stunned) return true;
    if (this.target.cast) return true;
    const cx = w.pos.x, cy = w.pos.y + w.chestY, cz = w.pos.z;
    for (const proj of this.world.spells.active) {
      if (proj.owner === w) continue;
      const rx = cx - proj.pos.x, ry = cy - proj.pos.y, rz = cz - proj.pos.z;
      const v2 = mul(proj.vel.x, proj.vel.x) + mul(proj.vel.y, proj.vel.y) + mul(proj.vel.z, proj.vel.z);
      if (v2 < 7) continue;
      const t = div(mul(rx, proj.vel.x) + mul(ry, proj.vel.y) + mul(rz, proj.vel.z), v2);
      if (t < 0 || t > F_1_2) continue;
      if (len3(rx - mul(proj.vel.x, t), ry - mul(proj.vel.y, t), rz - mul(proj.vel.z, t)) < F_2) return true;
    }
    return false;
  }

  private findCover(): void {
    let best = -1;
    this.hasCover = false;
    const t = this.target;
    for (const ob of this.world.arena.obstacles) {
      if (!ob.alive || !ob.cover) continue;
      const away = { x: 0, y: 0, z: 0 };
      if (!setLength2(away, ob.x - t.pos.x, ob.z - t.pos.z, ONE)) continue;
      const reach = extentToward(ob, away.x, away.z) + F_1_3;
      const sx = ob.x + mul(away.x, reach), sz = ob.z + mul(away.z, reach);
      if (this.world.arena.hazardAt(sx, sz, K.wizR + F_0_5, this.world.shifts.hazards)) continue;
      const d = len2(sx - this.self.pos.x, sz - this.self.pos.z) + mul(len2(sx - t.pos.x, sz - t.pos.z), F_0_3);
      if (best < 0 || d < best) {
        best = d;
        this.cover.x = sx;
        this.cover.z = sz;
        this.hasCover = true;
      }
    }
  }

  private steer(dt: number, tx: number, tz: number, dist: number): void {
    const w = this.self, p = this.p;
    let mx = 0, mz = 0;
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = this.rand(sec(0.8), sec(2.4));
      if (this.chance(F_0_6)) this.strafeDir = -this.strafeDir;
    }
    const sx = -tz * this.strafeDir, sz = tx * this.strafeDir;
    let sprint = false;
    switch (this.state) {
      case 'approach':
        mx = tx + mul(sx, F_0_45);
        mz = tz + mul(sz, F_0_45);
        sprint = dist > p.range[1] + F_6;
        if (!this.hasLos) {
          mx += mul(sx, F_0_6);
          mz += mul(sz, F_0_6);
        }
        break;
      case 'attack': {
        const ideal = this.punishTimer > 0 ? mul(p.range[0], F_0_7) : (p.range[0] + p.range[1]) >> 1;
        const radial = clamp(div(dist - ideal, fx(4)), -ONE, ONE);
        mx = mul(sx, p.strafe) + mul(tx, mul(radial, F_0_8));
        mz = mul(sz, p.strafe) + mul(tz, mul(radial, F_0_8));
        if (p.hop > 0 && w.grounded && !w.cast && this.chance(muldiv(p.hop, dt, 6000))) w.press(A_JUMP);
        break;
      }
      case 'retreat':
        if (this.hasCover && len2(this.cover.x - w.pos.x, this.cover.z - w.pos.z) > F_0_8) {
          const u = { x: 0, y: 0, z: 0 };
          setLength2(u, this.cover.x - w.pos.x, this.cover.z - w.pos.z, ONE);
          mx = u.x;
          mz = u.z;
          sprint = w.mana > F_50;
        } else {
          mx = -tx + mul(sx, F_0_5);
          mz = -tz + mul(sz, F_0_5);
        }
        break;
      case 'evade':
        mx = this.desired.x;
        mz = this.desired.z;
        break;
    }
    const goal = this.ticketGoal ? this.ticketById(this.ticketGoal) : null;
    if (goal && this.state !== 'evade') {
      const gx = goal.x - w.pos.x, gz = goal.z - w.pos.z;
      const d = len2(gx, gz);
      mx = d > 0 ? muldiv(gx, ONE, d) : 0;
      mz = d > 0 ? muldiv(gz, ONE, d) : 0;
      if (d > fx(3)) {
        mx += mul(sx, F_0_25);
        mz += mul(sz, F_0_25);
      }
      sprint = d > fx(5) && w.mana > K.sprintRecover;
    }
    if (this.state !== 'evade') {
      const m = { x: mx, y: 0, z: mz };
      this.keepFormation(m);
      mx = m.x;
      mz = m.z;
    }
    const escaping = this.time < this.escapeUntil && this.state !== 'evade';
    if (escaping) {
      mx = this.escape.x;
      mz = this.escape.z;
      sprint = w.mana > K.sprintRecover;
    }
    // Round standing toxic clouds (an enemy boss's), like lava.
    for (const h of this.world.powers.hazards) {
      if (!h.active || h.kind !== 'cloud' || !h.fired || h.owner.side === w.side) continue;
      const dx = w.pos.x - h.at.x, dz = w.pos.z - h.at.z;
      const d = max(len2(dx, dz), 66);
      const reach = h.radius + K.cloudMargin + w.radius;
      if (d > reach + F_1_5) continue;
      const push = clamp(div(reach + F_1_5 - d, F_1_5), 0, F_2);
      mx += mul(muldiv(dx, ONE, d), push);
      mz += mul(muldiv(dz, ONE, d), push);
    }
    // Out of lava (and shift pools) and away from the fire.
    const hz = this.world.arena.hazards;
    const sh = this.world.shifts.hazards;
    for (let i = 0; i < hz.length + sh.length; i++) {
      const h = i < hz.length ? hz[i] : sh[i - hz.length];
      const dx = w.pos.x - h.x, dz = w.pos.z - h.z;
      const d = max(len2(dx, dz), 66);
      const reach = h.r + K.lavaMargin + K.wizR;
      if (d > reach + F_1_5) continue;
      const push = clamp(div(reach + F_1_5 - d, F_1_5), 0, F_2);
      mx += mul(mul(muldiv(dx, ONE, d), push), F_1_6);
      mz += mul(mul(muldiv(dz, ONE, d), push), F_1_6);
    }
    const r = len2(w.pos.x, w.pos.z);
    const safe = this.world.arena.fireRadius - K.fireMargin;
    if (r > safe - F_2 && r > 0) {
      const push = clamp(div(r - (safe - F_2), F_2), 0, F_1_5);
      mx -= mul(mul(muldiv(w.pos.x, ONE, r), push), F_1_5);
      mz -= mul(mul(muldiv(w.pos.z, ONE, r), push), F_1_5);
      if (this.state === 'attack' && r > safe) this.strafeDir = -this.strafeDir;
    }
    const l = len2(mx, mz);
    if (l > ONE) {
      mx = muldiv(mx, ONE, l);
      mz = muldiv(mz, ONE, l);
    }
    if (escaping) {
      this.desired.x = mx;
      this.desired.z = mz;
    } else if (this.state !== 'evade') {
      this.desired.x += mul(mx - this.desired.x, STEER_SMOOTH);
      this.desired.z += mul(mz - this.desired.z, STEER_SMOOTH);
    }
    w.moveX = this.desired.x;
    w.moveZ = this.desired.z;
    w.sprint = sprint;
  }

  /** Double fights: keep apart from the partner and drift round the target until flanking it. */
  private keepFormation(m: V3): void {
    const w = this.self, t = this.target;
    for (const a of this.world.wizards) {
      if (a === w || !a.alive || a.side !== w.side || !a.active) continue;
      const dx = w.pos.x - a.pos.x, dz = w.pos.z - a.pos.z;
      const d = len2(dx, dz);
      if (d < K.duoSpacing) {
        const push = mul(ONE - muldiv(d, ONE, K.duoSpacing), K.duoSpacingW);
        if (d > 66) {
          m.x += mul(muldiv(dx, ONE, d), push);
          m.z += mul(muldiv(dz, ONE, d), push);
        } else {
          m.x += push * (w.index % 2 ? 1 : -1);
        }
      }
      const sep = wrapAngle(atan2(w.pos.x - t.pos.x, w.pos.z - t.pos.z) - atan2(a.pos.x - t.pos.x, a.pos.z - t.pos.z));
      if (abs(sep) < K.duoFlank) {
        const sign = abs(sep) > 11 ? (sep > 0 ? 1 : -1) : w.index % 2 ? 1 : -1;
        const rx = w.pos.x - t.pos.x, rz = w.pos.z - t.pos.z;
        const r = len2(rx, rz) || ONE;
        const k = mul(ONE - muldiv(abs(sep), ONE, K.duoFlank), K.duoFlankW) * sign;
        m.x += mul(muldiv(rz, ONE, r), k);
        m.z += mul(muldiv(-rx, ONE, r), k);
      }
    }
  }

  private aimAndAttack(dt: number, dist: number): void {
    const w = this.self, t = this.target, p = this.p;
    this.noiseTimer -= dt;
    if (this.noiseTimer <= 0) {
      this.noiseTimer = this.rand(sec(0.25), sec(0.6));
      const e = mul(p.aimError, dist);
      this.noiseTarget.x = mul(this.rand(-ONE, ONE), e);
      this.noiseTarget.y = mul(this.rand(-F_0_5, F_0_5), e);
      this.noiseTarget.z = mul(this.rand(-ONE, ONE), e);
    }
    this.noise.x += mul(this.noiseTarget.x - this.noise.x, NOISE_SMOOTH);
    this.noise.y += mul(this.noiseTarget.y - this.noise.y, NOISE_SMOOTH);
    this.noise.z += mul(this.noiseTarget.z - this.noise.z, NOISE_SMOOTH);

    const usingBlast = (w.cast !== null && w.cast.spell === 'blast') || w.wants(A_BLAST);
    const speed = usingBlast ? K.blastSpeed : K.boltSpeed;
    // Lead time (Q16 s) = dist / speed x leadFactor.
    const lead = mul(div(dist, speed), p.lead);
    const aim = w.aim;
    if (this.lost) {
      aim.x = this.lastSeen.x;
      aim.y = this.lastSeen.y + F_1_2;
      aim.z = this.lastSeen.z;
    } else {
      aim.x = t.pos.x + mul(t.vel.x, lead);
      aim.y = t.pos.y + t.chestY;
      aim.z = t.pos.z + mul(t.vel.z, lead);
    }
    if (!t.grounded && !this.lost) {
      const feetY = max(t.groundY, t.pos.y + mul(t.vy, lead) - (mul(K.gravity, mul(lead, lead)) >> 1));
      aim.y += feetY - t.pos.y;
    }
    if (usingBlast) aim.y = t.pos.y + F_0_5;
    if (!(w.cast !== null && w.cast.spell === 'stun') && !w.breathing) {
      aim.x += this.noise.x;
      aim.y += this.noise.y;
      aim.z += this.noise.z;
    }
    w.facing = atan2(aim.x - w.pos.x, aim.z - w.pos.z);

    w.holdBolt = false;
    const sees = this.hasLos || this.blind;
    if (this.state !== 'attack' && !(this.state === 'approach' && sees && dist < F_22)) return;
    if (!sees || w.cast || w.stunned || t.evolving || this.world.spells.volleyFiring(w) || this.world.powers.channeling(w)) return;
    const a = this.attacks;
    const canBlast = !a || a.blast, canStun = !a || a.stun, canUlt = !a || a.ultimate;

    const committed = t.cd[CD_DODGE] > sec(0.3) || t.stunned || (!t.grounded && t.vy < 0);
    if (canUlt && w.ult >= K.ultMax && !t.shielded && (committed || this.chance(F_0_01))) {
      w.press(A_ULT);
      return;
    }
    if (this.comboBlastAt > 0 && this.time >= this.comboBlastAt) {
      this.comboBlastAt = -1;
      if (t.stunned && canBlast) w.press(A_BLAST);
    }
    const volley = a ? a.volley : undefined;
    if (volley && this.volleyCd <= 0 && dist <= K.volleyRange && this.world.spells.castVolley(w, volley)) {
      this.volleyCd = mul(mul(sec(volley.cooldown), K.volleyCdScale), this.rand(F_0_85, F_1_15));
      this.burstLeft = 0;
      this.pauseTimer = max(this.pauseTimer, mul(this.rand(p.burstPause[0], p.burstPause[1]), F_0_6));
      return;
    }
    this.decisionTimer -= dt;
    if (this.decisionTimer <= 0) {
      this.decisionTimer = this.rand(sec(0.35), sec(0.7));
      const aggressive = this.punishTimer > 0;
      if (canStun && w.cd[CD_STUN] <= 0 && w.mana >= K.stunMana && dist < fx(20) && this.chance(aggressive ? F_0_7 : p.stun >> 1)) {
        w.press(A_STUN);
        this.comboBlastAt = this.time + K.stunCast + sec(0.15);
        return;
      }
      if (canBlast && w.cd[CD_BLAST] <= 0 && w.mana >= K.blastMana && this.chance(aggressive || t.stunned ? F_0_9 : p.blast >> 1)) {
        w.press(A_BLAST);
        return;
      }
    }
    if (this.pauseTimer > 0) {
      this.pauseTimer -= dt;
      return;
    }
    if (this.burstLeft <= 0) {
      this.burstLeft = this.rand(p.burst[0], p.burst[1]) + (this.punishTimer > 0 ? 2 : 0);
      this.burstCastsAtStart = w.stats.casts;
    }
    w.holdBolt = true;
    if (w.stats.casts - this.burstCastsAtStart >= this.burstLeft || w.mana < K.boltMana) {
      this.burstLeft = 0;
      w.holdBolt = false;
      this.pauseTimer = mul(this.rand(p.burstPause[0], p.burstPause[1]), this.punishTimer > 0 ? F_0_4 : ONE);
    }
  }
}

/** 0.35 rad in angle units (the cone's escape margin). */
const rad035 = Math.round((0.35 / (2 * Math.PI)) * 65536);

function segmentInCloud(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cz: number, r: number, h: number): boolean {
  const dx = bx - ax, dz = bz - az;
  const l2 = mul(dx, dx) + mul(dz, dz);
  const t = l2 > 0 ? clamp(div(mul(cx - ax, dx) + mul(cz - az, dz), l2), 0, ONE) : 0;
  const px = ax + mul(dx, t), pz = az + mul(dz, t);
  const y = ay + mul(by - ay, t);
  return len2(px - cx, pz - cz) < r && y < h;
}

/** How far the standing footprint reaches from the centre along unit (dx, dz) (Pillar.extentToward). */
function extentToward(ob: Obstacle, dx: number, dz: number): number {
  const c0 = cos(ob.yaw), s0 = sin(ob.yaw);
  const lx = mul(dx, c0) - mul(dz, s0);
  const lz = mul(dx, s0) + mul(dz, c0);
  let best = 0;
  for (const p of ob.parts) {
    if (p.y0 > 0) continue;
    let e: number;
    if (p.box) {
      const c = cos(p.yaw), s = sin(p.yaw);
      e = mul(abs(mul(lx, c) - mul(lz, s)), p.hx) + mul(abs(mul(lx, s) + mul(lz, c)), p.hz);
    } else e = p.r;
    best = max(best, mul(p.x, lx) + mul(p.z, lz) + e);
  }
  return best;
}

