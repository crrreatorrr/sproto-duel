import { describe, expect, it } from 'vitest';
import { LogRecorder, SimWorld, replay } from '../sim-core';
import { sampleSimInput, simPressCounters } from './simInput';

describe('game input sampling', () => {
  it('a match sampled like the game replays to the same hash', () => {
    const world = new SimWorld({ seed: 3, rules: 'quick', arena: 'moonlit', staffs: ['duel_staff_sproto', null] });
    const rec = new LogRecorder(world);
    const presses: Record<string, number> = { bolt: 0, blast: 0, shield: 0, stun: 0, ultimate: 0, dodge: 0, jump: 0, carpet: 0, pump: 0, vape: 0, lockon: 0, breath: 0 };
    const intent = { move: { x: 0, z: 0 }, sprint: false, holdBolt: false, facing: 0, presses };
    const aim = { x: 0, y: 0, z: 0 };
    const last = simPressCounters();
    let t = 0;
    while (!world.over && t < 60 * 60 * 5) {
      t++;
      const p = world.wizards[0], e = world.wizards[1];
      const a = Math.atan2((e.pos.x - p.pos.x) / 65536, (e.pos.z - p.pos.z) / 65536);
      const side = Math.floor(t / 90) % 2 ? 1 : -1;
      intent.move.x = Math.sin(a + side * 1.3);
      intent.move.z = Math.cos(a + side * 1.3);
      intent.facing = a;
      intent.holdBolt = t % 120 < 80;
      aim.x = e.pos.x / 65536;
      aim.y = e.pos.y / 65536 + 1.2;
      aim.z = e.pos.z / 65536;
      if (t % 97 === 0) presses.dodge++;
      if (t % 211 === 0) presses.blast++;
      if (t % 389 === 0) presses.shield++;
      const f = sampleSimInput(intent, aim, last, p);
      rec.frame(0, f);
      world.step([f]);
      rec.after();
    }
    const r = replay(rec.log(), { anyVersion: true });
    expect(r.error).toBeUndefined();
    expect(r.endHash).toBe(world.hash());
  });
});
