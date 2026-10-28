import * as THREE from 'three';
import { CONFIG, type AIProfile, type Difficulty } from '../config';
import { events } from '../core/events';
import type { TickController } from '../core/Game';
import { chance, clamp, rand, randInt } from '../core/math';
import type { Physics } from '../physics/Physics';
import type { Arena } from '../arena/Arena';
import { stageProfile } from '../campaign/BossStages';
import type { StageAttacks } from '../campaign/levels';
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

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();

/**
 * Enemy wizard brain. A small state machine (approach, attack, evade, retreat) that only writes
 * to the wizard's intent, exactly like the player controller. Difficulty is a tuning profile.
 * Campaign bosses follow their stage (the `bossStage` event): a scaled profile, gated attacks and
 * the stage's signature volley, cast through SpellSystem.castVolley.
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

  constructor(
    private readonly self: Wizard,
    private readonly target: Wizard,
    private readonly spells: SpellSystem,
    private readonly physics: Physics,
    private readonly arena: Arena,
    difficulty: Difficulty = 'normal',
  ) {
    this.profile = AI.difficulty[difficulty];
    this.listen();
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
  }

  /** First volley of a stage comes a little after it begins. */
  private resetVolley(): void {
    this.volleyCd = (this.attacks?.volley?.cooldown ?? 0) * VOLLEY.firstDelay;
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
        this.resetVolley();
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

    const toTarget = tmpA.subVectors(this.target.pos, w.pos).setY(0);
    const dist = toTarget.length();
    toTarget.divideScalar(dist || 1);

    // Line of sight is a raycast, so only refresh it a few times per second.
    this.losTimer -= dt;
    if (this.losTimer <= 0) {
      this.losTimer = 0.15;
      this.hasLos = this.physics.lineOfSight(w.chest(tmpB), this.target.chest(tmpC));
    }

    this.perceiveThreats();
    this.runReactions();
    this.chooseState(dist);
    this.steer(dt, toTarget, dist);
    this.aimAndAttack(dt, dist);
  }

  // ------------------------------------------------------------------ perception

  private perceiveThreats(): void {
    const w = this.self;
    const p = this.profile;
    const chest = w.chest(tmpB);
    for (const proj of this.spells.pool.active) {
      const bit = 1 << w.index;
      if (proj.owner === w || proj.seenMask & bit) continue;
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

  /** Nudge a direction away from the fire ring. */
  private biasAwayFromHazards(dir: THREE.Vector3): void {
    const w = this.self;
    const r = Math.hypot(w.pos.x, w.pos.z);
    const limit = this.fireRadius() - AI.fireMargin - CONFIG.wizard.dodge.speed * 0.3;
    if (r > limit) {
      const outward = (dir.x * w.pos.x + dir.z * w.pos.z) / (r || 1);
      if (outward > 0) dir.negate();
    }
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
    if (dist > maxRange + 2 || !this.hasLos) this.setState('approach');
    else this.setState('attack');
  }

  private findCover(): void {
    let best = Infinity;
    this.hasCover = false;
    for (const pillar of this.arena.pillars) {
      if (!pillar.alive) continue;
      const away = tmpC.subVectors(pillar.position, this.target.pos).setY(0).normalize();
      const spot = tmpB.copy(pillar.position).addScaledVector(away, CONFIG.arena.pillars.radius + 1.3);
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
        if (hopSkill > 0 && w.grounded && !w.cast && chance(J.aiHopRate * hopSkill * dt)) w.intent.press('jump');
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

    // Stay out of the fire.
    const r = Math.hypot(w.pos.x, w.pos.z);
    const safe = this.fireRadius() - AI.fireMargin;
    if (r > safe - 2) {
      const push = clamp((r - (safe - 2)) / 2, 0, 1.5);
      move.x -= (w.pos.x / r) * push * 1.5;
      move.z -= (w.pos.z / r) * push * 1.5;
      if (this.state === 'attack' && r > safe) this.strafeDir *= -1;
    }

    if (move.lengthSq() > 1) move.normalize();
    // Smooth direction changes so movement reads as intentional, not jittery.
    if (this.state !== 'evade') this.desiredMove.lerp(move, 1 - Math.exp(-10 * dt));
    w.intent.move.copy(this.desiredMove);
    w.intent.sprint = sprint;
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
    t.chest(aim).addScaledVector(t.vel, lead);
    if (!t.grounded) {
      // Ballistic lead for a jumping target, never below the ground it will land on.
      const g = CONFIG.wizard.jump.gravity;
      const feetY = Math.max(t.groundY, t.pos.y + t.vy * lead - 0.5 * g * lead * lead);
      aim.y += feetY - t.pos.y;
    }
    if (usingBlast) aim.y = 0.5; // splash at the feet
    if (w.cast?.spell !== 'stun') aim.add(this.aimNoise);
    intent.facing = Math.atan2(aim.x - w.pos.x, aim.z - w.pos.z);

    intent.holdBolt = false;
    if (this.state !== 'attack' && !(this.state === 'approach' && this.hasLos && dist < 22)) return;
    // A transforming boss is immune: hold fire (and let mana recover) until it is done.
    if (!this.hasLos || w.cast || w.stunned || t.evolving || this.spells.volleyFiring(w)) return;
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
      this.volleyCd = volley.cooldown * rand(0.85, 1.15);
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
