import * as THREE from 'three';
import { CONFIG } from '../config';
import type { App } from '../App';
import { resolveAsset } from '../assets/AssetLoader';
import { MODELS, type ModelKey } from '../assets/manifest';
import { STAGE_COUNT, stageProfile } from '../campaign/BossStages';
import { BOSSES, type BossDef } from '../campaign/levels';
import { events, type GameEvents } from '../core/events';
import type { Game } from '../core/Game';
import { AIController } from '../enemy/AIController';
import { withSeededRandom } from './campaignScenarios';
import { GROUP } from '../physics/Physics';
import type { Wizard } from '../wizard/Wizard';
import type { QAHarness } from './QAHarness';

const DT = CONFIG.sim.fixedDt;
const C = CONFIG.campaign;
const W = CONFIG.wizard;
const deg = THREE.MathUtils.degToRad;

type Ctx = Parameters<Parameters<QAHarness['add']>[1]>[0];
type SetupOpts = Parameters<Ctx['setup']>[0];

/** Fight 2: Bitcoin Obama (the rival) & The Midget (Game.partner). */
const DUO: BossDef = BOSSES.find((b) => b.partner)!;
const MIDGET = DUO.partner!;

const tmp = new THREE.Vector3();

/** Collect events of `type` until the returned function is called; it returns what was seen. */
function record<K extends keyof GameEvents>(type: K): () => GameEvents[K][] {
  const seen: GameEvents[K][] = [];
  const off = events.on(type, (e) => void seen.push({ ...e }));
  return () => {
    off();
    return seen;
  };
}

/**
 * Run `fn` in the double fight: both bosses dressed (boss stats, skins, hitboxes) and placed by
 * `setup`. `live`: their stages run (evolution, enrage); otherwise suspended like every QA run.
 * The previous rival (and partner) are restored afterwards.
 */
function withDuo(c: Ctx, game: Game, fn: () => void, opts: { live?: boolean; setup?: SetupOpts } = {}): void {
  const prev = game.boss;
  if (opts.live) game.stages.suspended = game.partnerStages.suspended = false; // the sandbox restores them
  game.setupEnemy(DUO);
  try {
    c.setup(opts.setup);
    fn();
  } finally {
    game.setupEnemy(prev);
  }
}

/** Let Match see KOs and the clock while `fn` runs (scenarios run in qaMode, which it ignores). */
function withMatchFlow(game: Game, fn: () => void): void {
  game.qaMode = false;
  try {
    fn();
  } finally {
    game.qaMode = true;
  }
}

/** Bring `w` down to `fraction` of its health with one hit from the player. */
function hitTo(game: Game, w: Wizard, fraction: number): void {
  const p = game.player;
  game.spells.dealDamage(w, p, (w.health - w.maxHealth * fraction) / p.damageMultiplier, w.chest(new THREE.Vector3()), 'bolt');
}

const ko = (game: Game, w: Wizard, by: Wizard) => game.spells.dealDamage(w, by, 1e5, w.chest(new THREE.Vector3()), 'bolt');

/** Put boss `w` straight into its last stage (full last bar, no transformation to wait for), so the next big hit is a KO. */
function jumpLast(game: Game, w: Wizard): void {
  const st = game.stagesOf(w);
  if (!st?.active || st.stage >= STAGE_COUNT - 1) return;
  st.evolveTo(STAGE_COUNT - 1);
  st.release(0);
}

/** The match phase, read fresh (TypeScript narrows `m.phase` after a scenario assigns it). */
const phaseOf = (m: App['match']): string => m.phase;

const popupShown = (game: Game, text: string) => [...game.ui.querySelectorAll('.popup')].some((el) => el.textContent === text);

/**
 * The Boss Gauntlet's double fight (fight 2): Bitcoin Obama and The Midget at once. A third wizard
 * that joins only this fight, team rules (no friendly fire), match rules for two enemies, per-boss
 * stages with enrage, the short hitbox, aim assist between two targets, and the two-plate HUD.
 */
export function registerDuoScenarios(qa: QAHarness, game: Game, app: App): void {
  const sharedList = () => (game.spells as unknown as { wizards: Wizard[] }).wizards;

  qa.add('duo.partner_only_in_double_fight', (c) => {
    const q = game.partner;
    const parked = (when: string) => {
      c.expect(!game.partnerActive && game.wizards.length === 2 && !game.wizards.includes(q), `${when}: ${game.wizards.length} wizards in the fight`);
      c.expect(game.enemies.length === 1 && game.enemies[0] === game.enemy, `${when}: enemies ${game.enemies.map((w) => w.name)}`);
      c.expect(!q.collider.isEnabled() && !q.visual.root.visible && !q.alive, `${when}: parked partner collider=${q.collider.isEnabled()} visible=${q.visual.root.visible}`);
      c.expect(sharedList() === game.wizards, `${when}: SpellSystem no longer shares Game.wizards`);
    };
    try {
      app.campaign.index = 0;
      app.startBossFight();
      parked('Sahil');
      app.campaign.index = BOSSES.indexOf(DUO);
      app.startBossFight();
      c.expect(DUO === BOSSES[1], 'the double fight is not fight 2');
      c.expect(game.partnerActive && game.wizards.length === 3 && game.wizards[2] === q && game.enemies[1] === q, 'partner not in the Obama fight');
      c.expect(q.index === 2 && q.side === 1 && q.name === 'The Midget' && q.alive, `partner #${q.index} side ${q.side} "${q.name}"`);
      c.expect(q.collider.isEnabled() && q.visual.root.visible && sharedList() === game.wizards, 'partner not solid/visible/shared');
      c.expect(q.team === MIDGET.palette && q.skins === MIDGET.skins && q.maxHealth === MIDGET.stageHealth[0], 'partner not dressed as The Midget');
      c.expect(game.partnerStages.boss === MIDGET && game.stages.boss === DUO, 'stages not keyed to each boss');
      // Side by side on the enemy spawn line.
      const e = game.enemy;
      c.near(Math.abs(e.pos.x - q.pos.x), C.duo.spawnSpacing, 0.01, 'spawn gap m');
      c.expect(Math.abs(e.pos.z - q.pos.z) < 0.01 && Math.abs(e.pos.z - CONFIG.arena.spawnDistance / 2) < 0.01, 'bosses not on the enemy spawn line');
      app.campaign.index = 2;
      app.startBossFight();
      parked('after Obama');
      // Nothing hits where the parked partner is.
      c.expect(!game.physics.raycast(new THREE.Vector3(q.pos.x, q.pos.y + 0.5, q.pos.z - 2), new THREE.Vector3(0, 0, 1), 4, GROUP.WIZARD), 'parked partner still has a live collider');
      app.startMatch();
      parked('Quick Duel');
    } finally {
      app.toMenu();
    }
  });

  qa.add('duo.no_friendly_fire', (c) => {
    withDuo(c, game, () => {
      const e = game.enemy, q = game.partner, p = game.player;
      const unhurt = (w: Wizard, what: string) => {
        c.expect(w.health === w.maxHealth && w.knock.lengthSq() < 1e-9 && !w.stunned, `${what}: ${w.name} hp ${w.health}/${w.maxHealth} knock ${w.knock.length().toFixed(2)} stunned ${w.stunned}`);
      };
      // Bolt: Obama fires through The Midget standing in the line of fire; it flies on into the player.
      c.setup({ player: [0, -6], enemy: [0, 8], partner: [0, 2] });
      c.aimAt(e, p);
      e.intent.press('bolt');
      c.step(0.6);
      unhurt(q, 'bolt');
      c.expect(p.health < p.maxHealth, 'the bolt stopped at The Midget instead of passing through');
      // His raised shield doesn't catch it either.
      c.setup({ player: [0, -6], enemy: [0, 8], partner: [0, 2] });
      c.aimAt(e, p);
      q.intent.press('shield');
      c.step(DT);
      c.expect(q.shielded, 'no shield');
      e.intent.press('bolt');
      c.step(0.6);
      unhurt(q, 'shielded ally');
      c.expect(p.health < p.maxHealth, "an ally's shield blocked the bolt");
      // Blast: Obama's blast bursts at The Midget's feet. No damage, no push.
      c.setup({ player: [0, -12], enemy: [0, 8], partner: [0, 3] });
      c.aimAt(e, q);
      e.aimPoint.set(q.pos.x, 0.2, q.pos.z);
      const booms = record('explosion');
      e.intent.press('blast');
      c.step(1);
      const b = booms();
      c.expect(b.length === 1 && b[0].pos.distanceTo(q.pos) < CONFIG.spells.blast.splashRadius, `blast burst ${b.length ? b[0].pos.distanceTo(q.pos).toFixed(2) + ' m' : 'nowhere'} from The Midget`);
      unhurt(q, 'blast splash');
      // Ultimate: The Midget's wave rolls over Obama and hits the player.
      c.setup({ player: [0, -4], enemy: [2, 6], partner: [0, 6] });
      q.ult = CONFIG.spells.ultimate.chargeMax;
      q.intent.press('ultimate');
      c.step(1.2);
      unhurt(e, 'ultimate');
      c.expect(p.health < p.maxHealth && p.knock.lengthSq() > 0, 'the wave missed the player');
      // Stun: a beam through an ally stuns only the enemy behind him.
      c.setup({ player: [0, -6], enemy: [0, 8], partner: [0, 2] });
      c.aimAt(e, p);
      e.intent.press('stun');
      c.step(CONFIG.spells.stun.castTime + 0.1);
      unhurt(q, 'stun');
      c.expect(p.stunned, 'the stun beam stopped at The Midget');
      // And the damage rule itself.
      c.setup();
      c.expect(game.spells.dealDamage(q, e, 50, q.pos, 'blast', tmp.set(1, 0, 0), 10) === 0, 'dealDamage between allies dealt damage');
      unhurt(q, 'dealDamage');
    });
  });

  qa.add('duo.no_same_side_clash', (c) => {
    withDuo(c, game, () => {
      const e = game.enemy, q = game.partner, p = game.player;
      // Obama and The Midget fire straight at each other: the bolts cross without clashing.
      c.setup({ player: [0, -14], enemy: [-4, 6], partner: [4, 6] });
      c.aimAt(e, q);
      c.aimAt(q, e);
      const clashes = record('clash');
      e.intent.press('bolt');
      q.intent.press('bolt');
      c.step(0.5);
      c.expect(clashes().length === 0, 'two allied bolts clashed');
      c.expect(e.health === e.maxHealth && q.health === q.maxHealth, 'allied bolts hurt each other');
      // The same head-on shot across sides does clash.
      c.setup({ player: [0, -6], enemy: [9, 12], partner: [0, 6] });
      c.aimAt(p, q);
      c.aimAt(q, p);
      // Truly head-on: each aims at where the other's bolt will leave (staff orb, phone), not the chest.
      q.castPoint('bolt', p.aimPoint);
      p.castPoint('bolt', q.aimPoint);
      const cross = record('clash');
      p.intent.press('bolt');
      q.intent.press('bolt');
      c.step(0.4);
      c.expect(cross().length >= 1, "the player's bolt did not clash with The Midget's");
    });
  });

  qa.add('duo.round_continues_until_both_down', (c) => {
    const prev = game.boss;
    try {
      app.campaign.index = 1;
      app.startBossFight();
      game.stages.suspended = game.partnerStages.suspended = false;
      const m = app.match, e = game.enemy, q = game.partner, p = game.player;
      c.setup({ player: [0, -6], enemy: [0, 0], partner: [0, 6] });
      m.phase = 'fight';
      game.actionsLocked = false; // Match.update would unlock the fight; it doesn't run in qaMode
      const ends = record('roundEnd');
      // One life, stage bars: a boss falls only when his last stage's bar runs out.
      withMatchFlow(game, () => ko(game, e, p));
      c.expect(e.alive && game.stages.stage === 1, 'emptying a first-stage bar knocked Obama out');
      c.step(C.evolveTime + 0.1);
      jumpLast(game, e);
      withMatchFlow(game, () => ko(game, e, p));
      c.expect(!e.alive && q.alive && phaseOf(m) === 'fight' && ends().length === 0, `round ended when only Obama fell (phase ${m.phase})`);
      c.expect(popupShown(game, 'Bitcoin Obama is down!'), 'no "Bitcoin Obama is down!" callout');
      c.expect(m.wins[0] === 0 && m.wins[1] === 0, `wins ${m.wins}`);
      c.expect(m.koWinnerSide() === -1 && !m.enemiesDown() && !m.playerDown(), 'side-down helpers with one boss left');
      // The fallen boss stays down and doesn't block shots: a bolt at The Midget passes through the body.
      c.step(C.evolveTime + 0.1); // The Midget's enrage transformation
      c.expect(!e.alive && e.health === 0, 'Obama got back up');
      c.aimAt(p, q);
      const hp = q.health;
      p.intent.press('bolt');
      c.step(0.6);
      c.expect(q.health < hp, "a fallen boss's body blocked the player's bolt");
      const hit = game.physics.raycast(p.chest(new THREE.Vector3()), new THREE.Vector3(0, 0, 1), 20, GROUP.WIZARD | GROUP.WORLD, p.collider);
      c.expect(hit?.tag.kind === 'wizard' && hit.tag.wizard === q, `the first wizard along the line is ${hit?.tag.kind === 'wizard' ? hit.tag.wizard.name : hit?.tag.kind}`);
      // Both down: the player's side takes the round.
      const last = record('roundEnd');
      withMatchFlow(game, () => ko(game, q, p));
      const end = last();
      c.expect(phaseOf(m) === 'roundEnd' && end.length === 1 && end[0].winner === p && end[0].reason === 'ko', `phase ${m.phase}, roundEnd ${end.length}`);
      c.expect(m.wins[0] === 1 && m.wins[1] === 0 && m.lastWinner === p, `wins ${m.wins}`);
      c.expect(m.enemiesDown() && m.koWinnerSide() === 0, 'enemiesDown/koWinnerSide after both fell');
    } finally {
      app.toMenu();
      game.setupEnemy(prev);
    }
  });

  qa.add('duo.player_ko_ends_round_wins_by_side', (c) => {
    try {
      app.campaign.index = 1;
      app.startBossFight();
      const m = app.match, e = game.enemy, q = game.partner, p = game.player;
      c.setup();
      m.phase = 'fight';
      // The Midget lands the KO: the enemies' side (1) wins, reported as its leader, the rival.
      withMatchFlow(game, () => ko(game, p, q));
      c.expect(phaseOf(m) === 'roundEnd' && m.wins.length === 2 && m.wins[1] === 1 && m.wins[0] === 0, `phase ${m.phase} wins ${m.wins}`);
      c.expect(m.lastWinner === e && m.roundWinners[0] === e, `round winner ${m.lastWinner?.name}`);
      c.expect(m.playerDown() && m.koWinnerSide() === 1, 'playerDown/koWinnerSide after the player fell');
      c.expect(e.alive && q.alive, 'a boss went down with the player');
      // One life: that KO decides the match for the enemies.
      c.expect(m.roundsToWin === 1, `gauntlet rounds to win ${m.roundsToWin}`);
      const done = record('matchEnd');
      withMatchFlow(game, () => c.step(CONFIG.match.roundEndTime + 0.1));
      const ev = done();
      c.expect(phaseOf(m) === 'matchEnd' && ev.length === 1 && ev[0].winner === e, `match end ${m.phase}, winner ${ev[0]?.winner?.name}`);
    } finally {
      app.toMenu();
    }
  });

  qa.add('duo.timeout_combined_fraction', (c) => {
    try {
      app.campaign.index = 1;
      app.startBossFight();
      const m = app.match, e = game.enemy, q = game.partner, p = game.player;
      c.setup();
      const set = (pf: number, ef: number, qf: number) => {
        p.health = p.maxHealth * pf;
        e.health = e.maxHealth * ef;
        q.health = q.maxHealth * qf;
      };
      const combined = () => (e.health + q.health) / (e.maxHealth + q.maxHealth);
      // The bigger boss untouched and the smaller one at 0 beats a half-health player (their combined
      // fraction is over 1/2, where averaging the two fractions would call it a draw)...
      const bigIsObama = e.maxHealth > q.maxHealth;
      set(0.5, bigIsObama ? 1 : 0, bigIsObama ? 0 : 1);
      c.expect(combined() > 0.5 && m.timeoutWinner() === e, `combined ${combined().toFixed(3)} vs 0.5: winner ${m.timeoutWinner()?.name}`);
      // ...and the other way round the smaller one alone is under half: the player wins.
      set(0.5, bigIsObama ? 0 : 1, bigIsObama ? 1 : 0);
      c.expect(combined() < 0.5 && m.timeoutWinner() === p, `combined ${combined().toFixed(3)} vs 0.5: winner ${m.timeoutWinner()?.name}`);
      // Equal fractions: a draw.
      set(0.5, 0.5, 0.5);
      c.expect(m.timeoutWinner() === null, 'equal fractions are not a draw');
      // The gauntlet has no round clock: the old timer running out ends nothing (the safety caps do, see campaign.*).
      c.setup();
      set(0.4, 0.7, 0.3);
      m.phase = 'fight';
      m.timer = DT / 2;
      const ends = record('roundEnd');
      withMatchFlow(game, () => c.step(DT * 3));
      c.expect(ends().length === 0 && phaseOf(m) === 'fight', `the gauntlet fight timed out (phase ${m.phase})`);
    } finally {
      app.toMenu();
    }
  });

  qa.add('duo.stages_per_boss_and_enrage', (c) => {
    withDuo(c, game, () => {
      const e = game.enemy, q = game.partner, p = game.player;
      const st = game.stages, pst = game.partnerStages;
      const ai = new AIController(q, p, game.spells, game.physics, game.arena);
      const finish = () => c.step(C.evolveTime + 0.05);
      try {
        c.setup();
        c.expect(st.boss === DUO && pst.boss === MIDGET && st.stage === 0 && pst.stage === 0, 'not both in stage 1');
        // The Midget evolves on his own health bar; Obama doesn't.
        hitTo(game, q, 0);
        c.expect(pst.stage === 1 && q.evolving && st.stage === 0 && !e.evolving, `Midget stage ${pst.stage + 1}, Obama stage ${st.stage + 1}`);
        c.expect(JSON.stringify(ai.profile) === JSON.stringify(stageProfile(MIDGET, 1)) && ai.attacks === MIDGET.stages[1].attacks, "partner AI not on The Midget's stage 2");
        c.expect(Math.abs(q.damageMultiplier - MIDGET.damageMultiplier * C.stageDamage[1]) < 1e-9, `partner damage x${q.damageMultiplier}`);
        finish();
        const expectModel = (s: number): ModelKey | null => {
          for (let k = s; k >= 0; k--) if (resolveAsset(MODELS[MIDGET.stages[k].model].path)) return MIDGET.stages[k].model;
          return null;
        };
        c.expect(pst.modelShown === expectModel(1), `Midget stage 2 look ${pst.modelShown}, expected ${expectModel(1)}`);
        hitTo(game, e, 0);
        c.expect(st.stage === 1 && pst.stage === 1, 'Obama did not evolve on his own bar');
        finish();
        // Obama falls (his last bar out): The Midget is enraged, straight to stage 3 on a full last bar.
        q.health = q.maxHealth * 0.4;
        jumpLast(game, e);
        const evolves = record('bossEvolve');
        ko(game, e, p);
        const ev = evolves();
        c.expect(pst.stage === STAGE_COUNT - 1 && q.evolving, `enrage left The Midget in stage ${pst.stage + 1}`);
        c.expect(ev.length === 1 && ev[0].wizard === q && ev[0].enraged && ev[0].stage === 2 && ev[0].from === 1, `bossEvolve ${JSON.stringify(ev.map((x) => [x.wizard.name, x.from, x.stage, x.enraged]))}`);
        const banner = app.hud.root.querySelector('.banner')?.textContent ?? '';
        c.expect(banner.includes('The Midget is enraged!'), `banner "${banner}"`);
        c.expect(q.maxHealth === MIDGET.stageHealth[2], `enraged bar ${q.maxHealth}`);
        c.expect(JSON.stringify(ai.profile) === JSON.stringify(stageProfile(MIDGET, 2)) && ai.attacks?.volley?.name === MIDGET.stages[2].attacks.volley?.name, 'enraged AI not on stage 3');
        finish();
        c.expect(pst.modelShown === expectModel(2), `enraged look ${pst.modelShown}`);
        c.expect(q.health === q.maxHealth && q.maxHealth === MIDGET.stageHealth[2], `enraged Midget ${q.health}/${q.maxHealth}: not a full last bar`);
        // Mid-transformation, the enrage waits for it to finish.
        c.setup();
        jumpLast(game, e);
        hitTo(game, q, 0);
        ko(game, e, p);
        c.expect(pst.stage === 1 && q.evolving, 'enrage cut a transformation short');
        const late = record('bossEvolve');
        finish();
        const l = late();
        c.expect(pst.stage === 2 && q.evolving && l.length === 1 && l[0].enraged, `queued enrage: stage ${pst.stage + 1}, events ${l.length}`);
        finish();
        // Already in stage 3: nothing more.
        c.setup();
        pst.evolveTo(2);
        finish();
        jumpLast(game, e);
        const none = record('bossEvolve');
        ko(game, e, p);
        c.expect(none().length === 0 && !q.evolving, 'a stage 3 Midget transformed again');
        // The Midget falls first: Obama is enraged.
        c.setup();
        jumpLast(game, q);
        const rev = record('bossEvolve');
        ko(game, q, p);
        const r = rev();
        c.expect(st.stage === 2 && e.evolving && r.length === 1 && r[0].wizard === e && r[0].enraged, `Obama after The Midget fell: stage ${st.stage + 1}`);
        // QA stock stats (stages suspended): no enrage.
        c.setup();
        st.suspended = pst.suspended = true;
        ko(game, e, p);
        c.expect(pst.stage === 0 && !q.evolving, 'enraged while stages were suspended');
        st.suspended = pst.suspended = false;
      } finally {
        ai.dispose();
      }
    }, { live: true });
  });

  qa.add('duo.short_hitbox_high_bolt_passes_over', (c) => {
    withDuo(c, game, () => {
      const e = game.enemy, q = game.partner, p = game.player;
      const v = new THREE.Vector3();
      c.expect(q.height === MIDGET.hitbox.height && q.radius === MIDGET.hitbox.radius, `hitbox ${q.radius}/${q.height}`);
      const chest = q.chest(v).y - q.pos.y, wand = q.castPoint('bolt', v).y - q.pos.y;
      c.expect(chest < 0.9 && wand < 1 && q.tagHeight < 1.8 && q.shieldCenterY < 0.75, `aim points not scaled: chest ${chest.toFixed(2)} wand ${wand.toFixed(2)}`);
      const shot = (fullHeight = false) => {
        c.setup({ player: [0, -6], enemy: [0, 8], partner: [0, 1] });
        // (A round reset gives each boss its stage hurtbox, so the control capsule goes on after it.)
        if (fullHeight) q.setHitbox(W.radius, W.height);
        p.facing = p.intent.facing = 0;
        p.aimPoint.set(0, 1.75, 8); // high on Obama
        p.intent.press('bolt');
        c.step(0.6);
      };
      // Over The Midget's head and into Obama.
      shot();
      c.expect(q.health === q.maxHealth, 'a high bolt hit The Midget');
      c.expect(e.health < e.maxHealth, 'the high bolt missed Obama');
      // A full-height wizard in his place would have taken it.
      try {
        shot(true);
        c.expect(q.health < q.maxHealth && e.health === e.maxHealth, 'control: a full-height wizard did not block the shot');
      } finally {
        q.setHitbox(MIDGET.hitbox.radius, MIDGET.hitbox.height);
      }
      // Shots at his chest land.
      c.setup({ player: [0, -6], enemy: [8, 8], partner: [0, 4] });
      c.aimAt(p, q);
      p.intent.press('bolt');
      c.step(0.6);
      c.expect(q.health < q.maxHealth, 'a bolt at his chest missed');
    });
  });

  qa.add('duo.aim_assist_targets_nearest_to_crosshair', (c) => {
    withDuo(c, game, () => {
      const e = game.enemy, q = game.partner, p = game.player;
      const pc = game.playerController, rig = game.rig;
      const settle = (yaw: number) => {
        rig.snap(p.pos, yaw);
        for (let i = 0; i < 40; i++) rig.update(DT, p.pos, game.physics, false, false);
      };
      /** Camera yaw that puts the crosshair on `w` (the camera orbits with the yaw, so iterate). */
      const yawTo = (w: Wizard) => {
        let yaw = rig.yaw;
        for (let i = 0; i < 4; i++) {
          settle(yaw);
          const cam = rig.camera.position;
          yaw = Math.atan2(w.pos.x - cam.x, w.pos.z - cam.z);
        }
        return yaw;
      };
      const target = (): Wizard | null => pc.target;
      const aim = (yaw: number) => {
        settle(yaw);
        pc.update();
        return target();
      };
      settle(0);
      pc.target = null;
      const ye = yawTo(e), yq = yawTo(q);
      c.expect(aim(ye) === e, `crosshair on Obama targets ${target()?.name}`);
      c.expect(aim(yq) === q, `crosshair on The Midget targets ${target()?.name}`);
      // Hysteresis: a degree past halfway toward Obama keeps The Midget; well past it switches.
      const toward = Math.sign(ye - yq);
      const mid = (ye + yq) / 2;
      c.expect(aim(mid + toward * deg(1)) === q, 'target flickered at the halfway point');
      c.expect(aim(mid + toward * deg(4)) === e, `well past halfway the target is ${target()?.name}`);
      // Assist pulls the shot toward the chosen target (here Obama, crosshair slightly off him).
      aim(ye + deg(1.5) * toward);
      const fwd = rig.getForward(new THREE.Vector3());
      const raw = game.physics.raycast(rig.camera.position, fwd, 90, GROUP.WORLD | GROUP.WIZARD | GROUP.GROUND, p.collider);
      const crosshair = raw ? raw.point : rig.camera.position.clone().addScaledVector(fwd, 90);
      const chest = e.chest(new THREE.Vector3());
      c.expect(p.aimPoint.distanceTo(chest) < crosshair.distanceTo(chest) - 0.3, `aim assist did not bend toward Obama (${p.aimPoint.distanceTo(chest).toFixed(2)} m vs ${crosshair.distanceTo(chest).toFixed(2)} m)`);
      c.expect(p.aimPoint.distanceTo(chest) < p.aimPoint.distanceTo(q.chest(tmp)), 'aim assist bent toward the other boss');
      // A KO'd boss is never the target.
      ko(game, e, p);
      c.expect(aim(ye) === q, `crosshair on Obama's body targets ${target()?.name}`);
      // One enemy: always that one.
      game.setupEnemy(BOSSES[0]);
      c.setup();
      settle(0);
      c.expect(aim(0.6) === game.enemy, 'single enemy not targeted');
    }, { setup: { player: [0, -6], enemy: [4, 8], partner: [-4, 8] } });
  });

  qa.add('duo.ai_pair_spreads_out_and_flanks', (c) => {
    withDuo(c, game, () => {
      const e = game.enemy, q = game.partner, p = game.player;
      const ai = new AIController(e, p, game.spells, game.physics, game.arena);
      const aq = new AIController(q, p, game.spells, game.physics, game.arena);
      ai.setProfile(DUO.ai);
      aq.setProfile(MIDGET.ai);
      ai.allies = aq.allies = game.enemies;
      const ref = new AIController(p, e, game.spells, game.physics, game.arena);
      try {
        // Start bunched up 1.5 m apart; they should spread out around the player and stay apart.
        // Seeded (three runs) so the AI's dice repeat.
        let gap = 0, sep = 0, n = 0, stacked = 0;
        const dmg = { e: 0, q: 0 };
        const off = events.on('damage', (ev) => {
          if (ev.target === p && ev.source === e) dmg.e += ev.amount;
          if (ev.target === p && ev.source === q) dmg.q += ev.amount;
        });
        for (const seed of [11, 22, 33]) {
          withSeededRandom(seed, () => {
            c.setup({ player: [0, -8], enemy: [0.75, 8], partner: [-0.75, 8] });
            ai.reset();
            aq.reset();
            let t = 0;
            c.step(8, () => {
              t += DT;
              ai.update(DT);
              aq.update(DT);
              for (const w of [p, e, q]) w.health = w.maxHealth;
              if (t < 2) return;
              const d = e.pos.distanceTo(q.pos);
              gap += d;
              if (d < 2.5) stacked++;
              const a = Math.atan2(e.pos.x - p.pos.x, e.pos.z - p.pos.z) - Math.atan2(q.pos.x - p.pos.x, q.pos.z - p.pos.z);
              sep += Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
              n++;
            });
          });
        }
        off();
        gap /= n;
        sep = THREE.MathUtils.radToDeg(sep / n);
        c.note(`avg gap ${gap.toFixed(1)} m, ${((stacked / n) * 100).toFixed(0)}% of the time within 2.5 m, ${sep.toFixed(0)}° apart around the player, dmg Obama ${dmg.e.toFixed(0)} Midget ${dmg.q.toFixed(0)}`);
        c.expect(gap > C.duo.spacing * 0.8 && stacked / n < 0.15, `bosses stayed bunched (avg gap ${gap.toFixed(1)} m, ${((stacked / n) * 100).toFixed(0)}% stacked)`);
        c.expect(sep > 15, `no flank (avg ${sep.toFixed(0)}° apart around the player)`);
        // Gauntlet bosses pick their moments (slow bursts, wide aim): both must attack, not necessarily land.
        c.expect(e.stats.casts > 2 && q.stats.casts > 2, `one of the pair never attacked (casts ${e.stats.casts} / ${q.stats.casts})`);
        // setTarget: an AI can switch to the other enemy (the soak's reference AI does).
        ref.setTarget(q);
        c.expect(ref.opponent === q, 'setTarget did not switch');
        c.step(1, () => ref.update(DT));
        const want = Math.atan2(q.pos.x - p.pos.x, q.pos.z - p.pos.z);
        const err = Math.abs(Math.atan2(Math.sin(p.intent.facing - want), Math.cos(p.intent.facing - want)));
        c.expect(err < deg(25), `reference AI faces ${THREE.MathUtils.radToDeg(err).toFixed(0)}° off The Midget`);
      } finally {
        ai.dispose();
        aq.dispose();
        ref.dispose();
      }
    });
  });

  qa.add('duo.hud_cards_and_banners_name_both', (c) => {
    try {
      app.campaign.index = 1;
      app.showBossCard();
      const card = app.menus.root.querySelector('.boss-card')!;
      c.expect((card.querySelector('.boss-name')?.textContent ?? '') === 'Bitcoin Obama & The Midget', `card name "${card.querySelector('.boss-name')?.textContent}"`);
      c.expect(card.querySelectorAll('.boss-stages').length === 2 && (card.textContent ?? '').includes(MIDGET.stages[2].name), 'card does not list both bosses\' stages');
      app.startBossFight();
      app.hud.update(0);
      const root = app.hud.root;
      const plates = [...root.querySelectorAll<HTMLElement>('.plates-right .plate')];
      c.expect(root.classList.contains('duo') && plates.length === 2, 'no second enemy plate');
      const [ob, mid] = plates;
      c.expect(getComputedStyle(mid).display !== 'none', 'partner plate hidden');
      const text = (el: Element) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      c.expect(text(ob).includes('Bitcoin Obama') && text(ob).includes(DUO.stages[0].name), `Obama plate "${text(ob)}"`);
      c.expect(text(mid).includes('The Midget') && text(mid).includes(MIDGET.stages[0].name), `Midget plate "${text(mid)}"`);
      const pips = (el: Element) => [...el.querySelectorAll('.stage-pips i')].map((i) => i.className).join(',');
      c.expect(ob.classList.contains('staged') && mid.classList.contains('staged') && pips(ob) === 'on,,' && pips(mid) === 'on,,', `pips ${pips(ob)} / ${pips(mid)}`);
      const accent = `#${new THREE.Color(MIDGET.palette.spell).getHexString()}`;
      c.expect(mid.style.getPropertyValue('--rival') === accent, `partner plate colour ${mid.style.getPropertyValue('--rival')} != ${accent}`);
      // Stacked: Obama on top, The Midget below and narrower, both on screen.
      const a = ob.getBoundingClientRect(), b = mid.getBoundingClientRect();
      c.expect(a.bottom <= b.top + 1 && b.width < a.width, `plates not stacked (${a.top.toFixed(0)}-${a.bottom.toFixed(0)}, ${b.top.toFixed(0)}-${b.bottom.toFixed(0)})`);
      c.expect(b.right <= innerWidth + 1 && b.bottom < innerHeight * 0.5, `partner plate off screen (${b.right.toFixed(0)}x${b.bottom.toFixed(0)} in ${innerWidth}x${innerHeight})`);
      c.expect(root.querySelectorAll('.enemy-tag').length === 2 && root.querySelectorAll('.offscreen-arrow').length === 2, 'not one tag and arrow per enemy');
      c.note(`plates "${text(ob)}" / "${text(mid)}" at ${innerWidth}x${innerHeight}`);
      // Each plate follows its own boss's stages.
      game.partnerStages.evolveTo(1);
      app.hud.update(0);
      c.expect(pips(mid) === 'done,on evolving,' && pips(ob) === 'on,,', `after the Midget evolves: ${pips(ob)} / ${pips(mid)}`);
      c.expect(mid.classList.contains('refill'), 'the Midget plate does not show its bar refilling');
      const banner = text(root.querySelector('.banner')!);
      c.expect(banner.includes(MIDGET.stages[1].name), `stage banner "${banner}"`);
      // Round banners, pause and results name the pair.
      events.emit('roundIntro', { round: 1 });
      c.expect(text(root.querySelector('.banner')!).includes('Bitcoin Obama & The Midget'), `round banner "${text(root.querySelector('.banner')!)}"`);
      app.pause();
      const pause = app.menus.root.querySelector('.pause')!;
      const lines = [...pause.querySelectorAll('.pause-stage')].map(text);
      c.expect(text(pause).includes('Bitcoin Obama & The Midget') && lines.length === 2 && lines[1].includes('The Midget'), `pause "${lines.join(' | ')}"`);
      app.resume();
      const m = app.match;
      m.wins[0] = 2;
      m.wins[1] = 0;
      m.roundWinners = [game.player, game.player];
      m.phase = 'matchEnd';
      app.showResults();
      const res = text(app.menus.root.querySelector('.results')!);
      c.expect(res.includes('Bitcoin Obama & The Midget') && res.includes('fall.'), `results "${res.slice(0, 120)}"`);
      // Quick Duel: one plate, one tag.
      app.startMatch();
      app.hud.update(0);
      c.expect(!root.classList.contains('duo') && getComputedStyle(mid).display === 'none' && !mid.classList.contains('staged'), 'Quick Duel still shows the partner plate');
      c.expect(!root.querySelector('.enemy-tag.partner.on'), 'Quick Duel shows a partner tag');
    } finally {
      app.toMenu();
    }
  });

  qa.add('duo.quick_duel_unaffected', (c) => {
    try {
      app.campaign.index = 1;
      app.startBossFight();
      app.startMatch();
      const m = app.match, e = game.enemy, p = game.player;
      c.expect(!game.partnerActive && game.wizards.length === 2 && game.enemies.length === 1 && game.enemies[0] === e, 'Quick Duel has a partner');
      c.expect(p.side === 0 && e.side === 1 && e.height === W.height && e.radius === W.radius && e.skins === null, 'rival changed');
      c.expect(e.pos.x === 0 && Math.abs(e.pos.z - CONFIG.arena.spawnDistance / 2) < 1e-6, `rival spawned at ${e.pos.x.toFixed(2)}, ${e.pos.z.toFixed(2)}`);
      c.setup();
      m.phase = 'fight';
      withMatchFlow(game, () => ko(game, e, p));
      c.expect(phaseOf(m) === 'roundEnd' && m.wins[0] === 1 && m.lastWinner === p, `one KO did not end the Quick Duel round (${m.phase})`);
      c.expect(!popupShown(game, 'Rival is down!'), 'a "down" callout in a 1v1');
      // Timeout compares health fractions (equal max health: plain health).
      c.setup();
      p.health = 100;
      e.health = 99;
      c.expect(m.timeoutWinner() === p, 'timeout winner');
      e.health = 100;
      c.expect(m.timeoutWinner() === null, 'timeout draw');
    } finally {
      app.toMenu();
    }
  });
}
