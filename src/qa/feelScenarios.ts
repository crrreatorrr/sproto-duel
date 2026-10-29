import * as THREE from 'three';
import { CONFIG } from '../config';
import { MODELS } from '../assets/manifest';
import type { Game } from '../core/Game';
import type { QAHarness } from './QAHarness';

const DT = CONFIG.sim.fixedDt;
const H = CONFIG.pickupHighlight;

/** Closest distance from p to segment a-b. */
function segDist(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const ab = new THREE.Vector3().subVectors(b, a);
  const t = THREE.MathUtils.clamp(new THREE.Vector3().subVectors(p, a).dot(ab) / Math.max(1e-10, ab.lengthSq()), 0, 1);
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

/**
 * Feel fixes: the camera backed against cover rises and the player's own look fades instead of the
 * view sitting inside the robe; the player's long staff never passes through the body; pickups
 * call for attention with a pulsing floor ring.
 */
export function registerFeelScenarios(qa: QAHarness, game: Game): void {
  qa.add('camera.backed_against_cover_rises_and_hides_player', (c) => {
    c.setup();
    const p = game.player, rig = game.rig;
    // Back the player up to a pillar, the camera looking away from it (so it must pull in).
    const pillar = game.arena.pillars.find((x) => x.alive && Math.hypot(x.position.x, x.position.z) > 4)!;
    const cx = pillar.position.x, cz = pillar.position.z;
    const d = Math.hypot(cx, cz);
    const ux = -cx / d, uz = -cz / d;
    let k = 0;
    while (pillar.surfaceDistance(cx + ux * k, cz + uz * k) < 0.45) k += 0.05;
    // The camera hangs over the right shoulder: stand that far to the left, so it is the one backed up.
    const yaw = Math.atan2(ux, uz);
    const rx = -Math.cos(yaw), rz = Math.sin(yaw);
    p.spawn(cx + ux * k - rx * CONFIG.camera.shoulder, cz + uz * k - rz * CONFIG.camera.shoulder, 0);
    rig.snap(p.pos, yaw);
    rig.pitch = -0.1;
    for (let i = 0; i < 40; i++) {
      rig.yaw = yaw;
      rig.update(DT, p.pos, game.physics, false, false);
      game.updateOcclusionFade(DT);
    }
    c.expect(rig.distance < 0.6, `camera still ${rig.distance.toFixed(2)} m back with cover behind`);
    c.expect(rig.rise > 0.3, `camera rose only ${rig.rise.toFixed(2)} m`);
    // The player's own look: gone with the camera inside it, see-through close by, solid further off.
    const PF = CONFIG.camera.playerFade;
    const at = p.visual.root.position;
    const head = new THREE.Vector3(at.x, at.y + 1.5, at.z);
    const side = (m: number) => head.clone().add(new THREE.Vector3(p.visual.boundsRadius * p.visual.root.scale.x + m, 0, 0));
    c.expect(game.closeTarget(p, head) === 0, 'camera inside the player: look not hidden');
    const mid = game.closeTarget(p, side((PF.clear + PF.near) / 2));
    c.expect(mid > PF.minVisible && mid < 1, `half way: ${mid.toFixed(2)}`);
    c.expect(game.closeTarget(p, side(PF.near + 0.1)) === 1, 'player faded with the camera clear of it');
    // Out in the open: back to the normal pull-back, no rise, solid.
    p.spawn(0, 0, 0);
    rig.snap(p.pos, 0);
    for (let i = 0; i < 90; i++) {
      rig.yaw = 0;
      rig.update(DT, p.pos, game.physics, false, false);
      game.updateOcclusionFade(DT);
    }
    c.expect(rig.rise < 0.02 && p.visual.fade === 1, `in the open: rise ${rig.rise.toFixed(2)}, fade ${p.visual.fade.toFixed(2)}`);
    c.note(`backed up: ${k.toFixed(2)} m from cover`);
  });

  qa.add('anim.staff_clear_of_body', (c) => {
    c.setup();
    const p = game.player, v = p.visual, a = v.animator;
    const spec = MODELS.wizardPlayer.rigged?.staff;
    if (!v.rigged || !a || !spec) {
      c.note('no rigged player with a staff: skipped');
      return;
    }
    const bone = (name: string) => v.root.getObjectByName(name)!;
    const hand = bone(spec.bone);
    const caps = spec.body.map((b) => ({ from: bone(b.from), to: bone(b.to), r: b.radius }));
    const tip = new THREE.Vector3(...spec.tip), butt = new THREE.Vector3(...spec.butt), grip = new THREE.Vector3(...spec.grip);
    const A = new THREE.Vector3(), B = new THREE.Vector3(), G = new THREE.Vector3(), P = new THREE.Vector3(), X = new THREE.Vector3(), Y = new THREE.Vector3();
    const rows: string[] = [];
    for (const clip of ['idle', 'run', 'strafeL', 'strafeR', 'jump', 'cast', 'castBig', 'dodge', 'hit', 'stunned', 'victory'] as const) {
      if (a.duration(clip) <= 0) continue;
      let worst = 0;
      for (let i = 0; i < 20; i++) {
        a.direct(clip, (a.duration(clip) * i) / 20, 0);
        v.update(p, DT, 1);
        v.root.updateMatrixWorld(true);
        A.copy(tip).applyMatrix4(hand.matrixWorld);
        B.copy(butt).applyMatrix4(hand.matrixWorld);
        G.copy(grip).applyMatrix4(hand.matrixWorld);
        for (let j = 0; j <= 30; j++) {
          P.lerpVectors(A, B, j / 30);
          if (P.distanceTo(G) < spec.gripReach) continue;
          for (const cap of caps) worst = Math.max(worst, cap.r - segDist(P, cap.from.getWorldPosition(X), cap.to.getWorldPosition(Y)));
        }
      }
      a.direct(null);
      // A few cm into the coat doesn't show; the roll is a 0.34 s blur with the body folded round the staff.
      const limit = clip === 'dodge' ? 0.08 : 0.05;
      c.expect(worst <= limit, `${clip}: the staff is ${(worst * 100).toFixed(1)} cm inside the body`);
      rows.push(`${clip} ${(worst * 100).toFixed(1)}cm`);
    }
    c.note(rows.join(', '));
  });

  qa.add('pickups.glow_and_pulse_rings', (c) => {
    c.setup();
    const fx = game.fx;
    const rings: number[] = [];
    const orig = fx.ring.bind(fx);
    fx.ring = (pos, color, radius, duration) => {
      rings.push(color);
      orig(pos, color, radius, duration);
    };
    try {
      const t = game.tickets.spawnAt(4, 4);
      c.expect(!!t, 'no ticket');
      const spawnRings = rings.length;
      for (let i = 0; i < Math.round((H.pulseEvery * 3 + 0.1) / DT); i++) game.tickets.updateVisual(DT, game.renderer.camera.position);
      c.expect(rings.length - spawnRings >= 3, `${rings.length - spawnRings} pulse rings in ${(H.pulseEvery * 3).toFixed(1)} s`);
      c.expect(t!.beam.material.uniforms.uOpacity.value > 0.6, `ticket beam opacity ${t!.beam.material.uniforms.uOpacity.value.toFixed(2)}`);
    } finally {
      fx.ring = orig;
      game.tickets.clear();
    }
  });
}
