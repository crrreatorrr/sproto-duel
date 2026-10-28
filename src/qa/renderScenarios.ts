import * as THREE from 'three';
import { CONFIG } from '../config';
import type { App } from '../App';
import { BOSSES } from '../campaign/levels';
import type { Game } from '../core/Game';
import type { QAHarness } from './QAHarness';
import { deplete, jump, withLiveFight } from './cinematicScenarios';
import { events } from '../core/events';
import { lookPixels } from './pixels';

const G = CONFIG.wizard.hitGlow;
const DT = CONFIG.sim.fixedDt;
const FRAME = 1 / 60;
const tmp = new THREE.Vector3();
const WHITE = new THREE.Color(1, 1, 1);

/**
 * Rendering: the hit flash stays a capped glow in the wizard's colours (never a white blob under
 * bloom), and nothing compiles a shader or uploads a texture mid-fight once the fight is warmed up
 * (Game.warmUp, behind the boss card).
 */
export function registerRenderScenarios(qa: QAHarness, game: Game, app: App): void {
  qa.add('wizard.hit_flash_capped_tinted_no_repeak', (c) => {
    // Tinubu (white robes, the brightest look) 4.5 m from the player: one hit, then Hellfire Breath
    // ticks every 0.25 s with bolts in between (a hit every ~0.12 s), drawn frame by frame.
    const prev = game.boss;
    game.setupEnemy(BOSSES[4]);
    try {
      c.setup({ player: [0, -4.5], enemy: [0, 0] });
      const e = game.enemy, p = game.player;
      const v = e.visual;
      game.simulating = true;
      let t = 0;
      const hits: number[] = [];
      const hit = (kind: 'bolt' | 'breath') => {
        e.health = e.maxHealth;
        game.spells.dealDamage(e, p, kind === 'breath' ? 2 : 4, e.chest(tmp), kind);
        hits.push(t);
      };
      const sample = (seconds: number, each?: () => void) => {
        const out: number[] = [];
        for (let i = 0; i < Math.round(seconds / FRAME); i++) {
          each?.();
          game.advance(FRAME);
          t += FRAME;
          out.push(v.hitGlowLevel);
        }
        return out;
      };
      // Let any glow left from earlier hits die out, then one hit: it reaches the cap, never more,
      // in his palette (not white), and fades quickly.
      sample(1.5);
      hit('bolt');
      const one = sample(0.35);
      const peak1 = Math.max(...one);
      c.expect(peak1 <= G.peak + 1e-6 && peak1 >= 0.9 * G.peak, `single hit peaks at ${peak1.toFixed(2)} (cap ${G.peak})`);
      c.expect(one[one.length - 1] < 0.05, `the flash lingers (${one[one.length - 1].toFixed(2)} after 0.35 s)`);
      hit('bolt');
      game.advance(FRAME);
      const em = v.hitEmissive.clone();
      const want = new THREE.Color(e.team.spell).lerp(WHITE, G.white).multiplyScalar(v.hitGlowLevel);
      const tinted = Math.max(em.r, em.g, em.b) - Math.min(em.r, em.g, em.b) > 0.25 * Math.max(em.r, em.g, em.b);
      c.expect(tinted && Math.abs(em.r - want.r) + Math.abs(em.g - want.g) + Math.abs(em.b - want.b) < 1e-3,
        `flash emissive ${em.getHexString()} is not his palette (${want.getHexString()})`);
      sample(1);
      // The barrage: breath ticks every 0.25 s, bolts 0.12 s after each tick, for 2 s.
      const start = t;
      let nextTick = t, nextBolt = t + 0.12;
      const barrage = sample(2, () => {
        if (t >= nextTick - 1e-9) {
          hit('breath');
          nextTick += 0.25;
        }
        if (t >= nextBolt - 1e-9) {
          hit('bolt');
          nextBolt += 0.25;
        }
      });
      const max = Math.max(...barrage);
      // After the first half second the glow has settled: no hit re-peaks to the cap.
      const late = barrage.slice(Math.round(0.5 / FRAME));
      const lateMax = Math.max(...late), lateMin = Math.min(...late);
      const within = hits.filter((h, i) => i > 0 && h >= start && h - hits[i - 1] < 0.3).length;
      c.expect(within >= 10, `only ${within} hits came within 0.3 s of the last one`);
      c.expect(max <= G.peak + 1e-6, `rapid hits pushed the flash to ${max.toFixed(2)} (cap ${G.peak})`);
      c.expect(lateMax <= 0.75 * G.peak, `rapid hits keep re-peaking (${lateMax.toFixed(2)} of ${G.peak})`);
      c.expect(lateMin >= 0.15 * G.peak, `the glow strobes to nothing between rapid hits (${lateMin.toFixed(2)})`);
      c.note(`single ${peak1.toFixed(2)}; barrage max ${max.toFixed(2)}, settled ${lateMin.toFixed(2)}-${lateMax.toFixed(2)} over ${hits.length} hits; emissive #${em.getHexString()}`);
    } finally {
      game.simulating = false;
      game.setupEnemy(prev);
    }
  });

  qa.add('wizard.no_white_silhouette_under_breath', (c) => {
    // Tinubu in stage 3 at 4.5 m, under the player's Hellfire Breath and bolts, seen over the
    // player's shoulder: his silhouette is not blown out to white and the cone of fire reads.
    withLiveFight(c, game, app, 4, () => {
      const e = game.enemy, p = game.player;
      jump(game.stages, 2);
      p.learned.add('breath');
      c.aimAt(p, e);
      p.mana = CONFIG.wizard.maxMana;
      p.intent.press('breath');
      const hits = { breath: 0, bolt: 0 };
      const off = events.on('damage', (d) => {
        if (d.target === e && (d.kind === 'breath' || d.kind === 'bolt')) hits[d.kind]++;
      });
      const rows: string[] = [];
      try {
        for (let i = 0; i < 100; i++) {
          e.health = e.maxHealth;
          p.mana = CONFIG.wizard.maxMana;
          c.aimAt(p, e);
          if (i % 8 === 4) {
            // A bolt landing between the ticks (the breath channel stops the player's own bolts:
            // these stand in for an ally's), with its impact burst.
            const at = e.chest(tmp);
            game.spells.dealDamage(e, p, CONFIG.spells.bolt.damage * 0.25, at, 'bolt');
            game.fx.impact(at, null, p.team.spell, 1);
          }
          game.advance(FRAME);
          if (i >= 30 && i % 10 === 0) {
            const s = lookPixels(game, e);
            rows.push(`${(s.blown * 100).toFixed(0)}%/${s.mean.toFixed(2)}`);
            c.expect(s.pixels > 400, `Tinubu is not on screen (${s.pixels} px)`);
            c.expect(s.blown <= 0.15, `${(s.blown * 100).toFixed(0)}% of Tinubu is blown out to white under the breath (mean ${s.mean.toFixed(2)})`);
            c.expect(e.visual.hitGlowLevel <= G.peak + 1e-6, `flash ${e.visual.hitGlowLevel.toFixed(2)} over the cap`);
          }
        }
      } finally {
        off();
      }
      c.expect(hits.breath >= 4 && hits.bolt >= 3, `the barrage didn't land (${hits.breath} breath ticks, ${hits.bolt} bolts)`);
      c.note(`blown/mean ${rows.join(' ')}; ${hits.breath} breath ticks, ${hits.bolt} bolts`);
    }, { player: [0, -2.25], enemy: [0, 2.25] });
  });

  qa.add('perf.no_first_use_hitch', (c) => {
    // Every boss arena, as the gauntlet plays it: the boss card dresses the fight and warms it up
    // (its first frame); then the fight's first tickets, life pack, volley, spells, reward spells,
    // both stage swaps (cinematics) and the partner's compile no shader program and upload no
    // texture. Every material in the scene has its program by then.
    const r = game.renderer.renderer;
    const programs = r.info.programs!;
    const created: string[] = [];
    const push = programs.push;
    programs.push = function (this: typeof programs, ...a: typeof programs) {
      for (const pr of a) created.push(pr.cacheKey.slice(0, 32).replace(/\s+/g, ' '));
      return push.apply(this, a);
    };
    const rows: string[] = [];
    try {
      for (let index = 0; index < BOSSES.length; index++) {
        const boss = BOSSES[index];
        // The card (outside the sandbox's headless mode, as in the game): its first frame warms up.
        app.campaign.index = index;
        game.inSandbox = false;
        try {
          app.showBossCard();
          game.advance(FRAME);
        } finally {
          game.inSandbox = true;
        }
        const warm = { ...game.lastWarmUp };
        c.expect(warm.key.startsWith(`${boss.id}|`) && warm.key.endsWith(`|${boss.theme}`), `${boss.id}: no warm-up behind the card (${warm.key})`);
        // Structural: everything in the scene has a compiled program.
        const missing = new Set<string>();
        game.renderer.scene.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
          if (!m || !((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite || (o as THREE.Line).isLine)) return;
          for (const mat of Array.isArray(m) ? m : [m]) {
            const props = r.properties.get(mat) as { programs?: Map<string, unknown> };
            if (!props.programs?.size) missing.add(`${o.name || o.type}:${mat.type}`);
          }
        });
        c.expect(missing.size === 0, `${boss.id}: ${missing.size} materials never compiled after the warm-up: ${[...missing].slice(0, 6).join(', ')}`);
        withLiveFight(c, game, app, index, () => {
          const e = game.enemy, p = game.player;
          const tex0 = r.info.memory.textures;
          const before = programs.length;
          created.length = 0;
          let worst = 0;
          const run = (seconds: number, dt = FRAME) => {
            for (let i = 0; i < Math.round(seconds / dt); i++) {
              const t0 = performance.now();
              game.advance(dt);
              worst = Math.max(worst, performance.now() - t0);
            }
          };
          const untilCalm = () => {
            for (let g = 0; g < 200 && app.cinematic.active; g++) run(0.05, 0.05);
            c.step(CONFIG.campaign.cinematic.grace + DT);
          };
          game.tickets.spawnAt(3, -4);
          game.tickets.spawnAt(-3, -4);
          game.tickets.spawnAt(0, 3);
          game.lifePacks.spawnAt(-5, 0);
          run(0.2);
          const volleyOf = (w: typeof e) => {
            const st = game.stagesOf(w)!;
            const def = st.boss!.stages.map((s) => s.attacks.volley).find((x) => x);
            w.mana = CONFIG.wizard.maxMana;
            if (def) game.spells.castVolley(w, def);
            w.intent.press('blast');
          };
          volleyOf(e);
          run(0.4);
          // The player's reward spells (all five) and a bolt.
          for (const id of ['carpet', 'pump', 'vape', 'lockon', 'breath'] as const) p.learned.add(id);
          for (const id of ['carpet', 'pump', 'vape', 'breath', 'lockon', 'bolt'] as const) {
            p.mana = CONFIG.wizard.maxMana;
            p.intent.press(id);
            run(0.15);
          }
          // Both stage swaps, through their cinematics, then the stage-3 volley.
          deplete(game, e);
          untilCalm();
          deplete(game, e);
          untilCalm();
          volleyOf(e);
          run(0.3);
          if (game.partnerActive) {
            const q = game.partner;
            volleyOf(q);
            run(0.3);
            deplete(game, q);
            untilCalm();
          }
          const tex = r.info.memory.textures - tex0;
          c.expect(created.length === 0 && programs.length <= before, `${boss.id}: ${created.length} programs compiled on first use (${[...new Set(created)].join(' / ')})`);
          c.expect(tex <= 0, `${boss.id}: ${tex} textures first uploaded mid-fight`);
          rows.push(`${boss.id}: warm-up ${warm.programs} programs ${warm.ms.toFixed(0)} ms, fight +${created.length} programs, worst frame ${worst.toFixed(1)} ms`);
        });
      }
    } finally {
      programs.push = push;
    }
    c.note(rows.join(' | '));
  });
}
