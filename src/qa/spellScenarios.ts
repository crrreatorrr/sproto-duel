import { CONFIG } from '../config';
import type { Game } from '../core/Game';
import type { QAHarness } from './QAHarness';

const S = CONFIG.spells;
const MAXHP = CONFIG.wizard.maxHealth;

export function registerSpellScenarios(qa: QAHarness, game: Game): void {
  // ------------------------------------------------------------------ Blast
  qa.add('blast.direct_hit_damage_and_cooldown', (c) => {
    c.setup();
    c.player.aimPoint.y = 1.0;
    c.player.intent.press('blast');
    c.step(0.05);
    c.expect(c.player.cast?.spell === 'blast', 'blast windup did not start');
    c.step(1.2);
    const dmg = MAXHP - c.enemy.health;
    c.near(dmg, S.blast.damage, 0.01, 'direct hit');
    c.expect(c.player.cd.blast > 0, 'blast cooldown not running');
  });

  qa.add('blast.cooldown_blocks_recast', (c) => {
    c.setup();
    c.player.intent.press('blast');
    c.step(0.5);
    c.player.intent.press('blast');
    c.step(1.0);
    c.expect(c.player.stats.casts === 1, `recast during cooldown (casts=${c.player.stats.casts})`);
    c.step(S.blast.cooldown);
    c.player.intent.press('blast');
    c.step(0.3);
    c.expect(c.player.stats.casts === 2, 'could not recast after cooldown');
  });

  qa.add('blast.splash_hits_near_miss', (c) => {
    c.setup();
    // Aim 1.5 m beside the enemy at orb-center height so it lands next to them.
    c.player.aimPoint.set(c.enemy.pos.x + 1.5, S.blast.radius, c.enemy.pos.z);
    c.player.intent.press('blast');
    c.step(1.5);
    const dmg = MAXHP - c.enemy.health;
    c.expect(dmg > 0 && dmg < S.blast.damage, `splash damage ${dmg.toFixed(1)} should be between 0 and ${S.blast.damage}`);
    c.note(`splash=${dmg.toFixed(1)}`);
  });

  // ----------------------------------------------------------------- Shield
  qa.add('shield.blocks_bolt_late', (c) => {
    c.setup();
    c.enemy.intent.press('shield');
    c.step(0.35);
    c.player.intent.press('bolt');
    c.step(0.4);
    c.expect(c.enemy.health === MAXHP, 'bolt went through a raised shield');
    c.expect(c.player.health === MAXHP, 'non-perfect block should not reflect damage back');
    c.expect(c.enemy.stats.perfects === 0, 'late block counted as perfect');
  });

  qa.add('shield.perfect_reflects_bolt', (c) => {
    c.setup();
    c.player.intent.press('bolt');
    c.step(0.1);
    c.enemy.intent.press('shield');
    c.step(1.0);
    c.expect(c.enemy.stats.perfects === 1, `perfects=${c.enemy.stats.perfects}`);
    c.expect(c.enemy.health === MAXHP, 'shielder took damage');
    const dmg = MAXHP - c.player.health;
    c.near(dmg, S.bolt.damage * S.shield.reflectDamageMultiplier, 0.01, 'reflected dmg');
  });

  qa.add('shield.absorbs_blast', (c) => {
    c.setup();
    c.enemy.intent.press('shield');
    c.step(0.05);
    c.player.intent.press('blast');
    c.step(0.6);
    c.expect(c.enemy.health === MAXHP, `shielded wizard took ${MAXHP - c.enemy.health} from a blast`);
  });

  qa.add('shield.perfect_reflects_stun', (c) => {
    c.setup();
    c.player.intent.press('stun');
    c.step(S.stun.castTime - 0.08);
    c.enemy.intent.press('shield');
    c.step(0.12);
    c.expect(c.player.stunned, 'perfect shield did not bounce the stun back');
    c.expect(!c.enemy.stunned, 'shielder got stunned');
  });

  qa.add('shield.cooldown_and_duration', (c) => {
    c.setup();
    c.enemy.intent.press('shield');
    c.step(0.05);
    c.expect(c.enemy.shielded, 'shield not up');
    c.step(S.shield.duration);
    c.expect(!c.enemy.shielded, 'shield lasted too long');
    c.enemy.intent.press('shield');
    c.step(0.1);
    c.expect(!c.enemy.shielded, 'shield re-raised during cooldown');
  });

  // ------------------------------------------------------------------- Stun
  qa.add('stun.freezes_for_duration', (c) => {
    c.setup();
    c.player.intent.press('stun');
    c.step(S.stun.castTime + 0.05);
    c.expect(c.enemy.stunned, 'stun beam missed a static target');
    const pos = c.enemy.pos.clone();
    c.enemy.intent.move.set(1, 0, 0);
    c.enemy.intent.press('bolt');
    c.step(S.stun.duration - 0.15);
    c.expect(c.enemy.pos.distanceTo(pos) < 0.3, 'stunned wizard moved');
    c.expect(c.enemy.stats.casts === 0, 'stunned wizard cast a spell');
    c.step(0.3);
    c.expect(!c.enemy.stunned, 'stun lasted too long');
    c.near(MAXHP - c.enemy.health, S.stun.damage, 0.01, 'stun dmg');
  });

  qa.add('stun.dodged_with_iframes', (c) => {
    c.setup();
    c.player.intent.press('stun');
    c.step(S.stun.castTime + 0.05, () => (c.enemy.iframes = 0.1));
    c.expect(!c.enemy.stunned, 'stun hit a wizard with i-frames');
  });

  qa.add('stun.blocked_by_pillar', (c) => {
    const p = game.arena.pillars[1].position;
    const dir = p.clone().setY(0).normalize();
    c.setup({ player: [p.x - dir.x * 5, p.z - dir.z * 5], enemy: [p.x + dir.x * 3, p.z + dir.z * 3] });
    c.player.intent.press('stun');
    c.step(0.4);
    c.expect(!c.enemy.stunned, 'stun went through a pillar');
  });

  // --------------------------------------------------------------- Ultimate
  qa.add('ultimate.requires_full_charge', (c) => {
    c.setup();
    c.player.ult = S.ultimate.chargeMax - 1;
    c.player.intent.press('ultimate');
    c.step(1.5);
    c.expect(c.enemy.health === MAXHP, 'ultimate fired without full charge');
  });

  qa.add('ultimate.hits_and_resets_charge', (c) => {
    c.setup();
    c.player.ult = S.ultimate.chargeMax;
    c.player.intent.press('ultimate');
    c.step(S.ultimate.castTime + 1.2);
    c.near(MAXHP - c.enemy.health, S.ultimate.damage, 0.01, 'ult dmg');
    c.expect(c.player.ult < 1, 'charge not consumed');
  });

  qa.add('ultimate.shield_reduces', (c) => {
    c.setup();
    c.player.ult = S.ultimate.chargeMax;
    c.player.intent.press('ultimate');
    c.step(S.ultimate.castTime);
    c.enemy.intent.press('shield');
    c.step(1.0);
    c.near(MAXHP - c.enemy.health, S.ultimate.damage * S.ultimate.shieldMultiplier, 0.01, 'shielded ult dmg');
  });

  qa.add('ultimate.cover_protects', (c) => {
    const p = game.arena.pillars[2].position;
    const dir = p.clone().setY(0).normalize();
    c.setup({ player: [p.x - dir.x * 6, p.z - dir.z * 6], enemy: [p.x + dir.x * 1.8, p.z + dir.z * 1.8] });
    c.player.ult = S.ultimate.chargeMax;
    c.player.intent.press('ultimate');
    c.step(S.ultimate.castTime + 1.2);
    c.expect(c.enemy.health === MAXHP, `took ${MAXHP - c.enemy.health} behind cover`);
    c.expect(game.arena.pillars[2].hp < CONFIG.arena.pillars.hp, 'pillar took no damage from the wave');
  });

  qa.add('ultimate.roll_through_wave', (c) => {
    c.setup();
    c.player.ult = S.ultimate.chargeMax;
    c.player.intent.press('ultimate');
    c.step(S.ultimate.castTime + 1.2, () => (c.enemy.iframes = 0.1));
    c.expect(c.enemy.health === MAXHP, 'wave hit a rolling wizard');
  });

  qa.add('ultimate.charges_from_damage', (c) => {
    c.setup();
    game.spells.dealDamage(c.enemy, c.player, 40, c.enemy.pos, 'bolt');
    c.near(c.player.ult, 40 * S.ultimate.chargePerDamageDealt, 0.01, 'ult charge');
  });

  // ---------------------------------------------------------------- Clashes
  qa.add('clash.blast_beats_bolt', (c) => {
    c.setup();
    c.enemy.intent.press('blast');
    c.step(S.blast.castTime + 0.05);
    c.player.intent.press('bolt');
    let clashed = false;
    c.step(0.6, () => {
      if (!clashed && game.spells.pool.active.some((p) => p.kind === 'blast' && p.power < S.blast.power)) clashed = true;
    });
    c.expect(clashed, 'bolt and blast never clashed head-on');
    c.note('blast survived weakened');
  });

  qa.add('clash.bolts_destroy_each_other', (c) => {
    c.setup();
    c.player.aimPoint.copy(c.enemy.wandTip(c.enemy.aimPoint.clone()));
    c.enemy.aimPoint.copy(c.player.wandTip(c.player.aimPoint.clone()));
    c.player.intent.press('bolt');
    c.enemy.intent.press('bolt');
    c.step(0.6);
    const hurt = c.player.health < MAXHP || c.enemy.health < MAXHP;
    c.expect(!hurt, 'head-on bolts passed through each other');
  });

  // ------------------------------------------------------------------- Fire
  qa.add('fire.burns_and_pushes_inward', (c) => {
    const r = CONFIG.arena.fireRadius + 0.1;
    c.setup({ player: [r, 0], enemy: [0, 6] });
    c.step(0.6);
    const dmg = MAXHP - c.player.health;
    const rNow = Math.hypot(c.player.pos.x, c.player.pos.z);
    c.expect(dmg > 0, 'fire did no damage');
    c.expect(rNow < r - 0.5, `not pushed out of the fire (r=${rNow.toFixed(2)})`);
    c.note(`fire dmg=${dmg.toFixed(1)} r=${rNow.toFixed(1)}`);
  });
}
