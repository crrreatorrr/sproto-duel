/** The committed server bundle replays every golden log to its frozen result, in a bare Node context. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { replay } from './replay';

const ROOT = path.resolve(__dirname, '../..');
const bundle = fs.readFileSync(path.join(ROOT, 'dist/duel-sim.server.js'), 'utf8');
const dir = path.join(ROOT, 'tests/golden');
const goldens = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

describe('server bundle', () => {
  const ctx = vm.createContext({});
  vm.runInContext(bundle, ctx);
  const version = vm.runInContext('DUEL_SIM_VERSION', ctx) as string;

  it('exposes the locked interface', () => {
    expect(version).toMatch(/^[0-9a-f]{16}$/);
    expect(vm.runInContext('typeof DuelSim.replay', ctx)).toBe('function');
    expect(vm.runInContext('DuelSim.DUEL_SIM_VERSION', ctx)).toBe(version);
  });

  for (const g of goldens) {
    it(`replays ${g.name} (source and bundle agree with the golden)`, () => {
      const fromSource = replay(g.log, { anyVersion: true });
      ctx.LOG = JSON.stringify({ ...g.log, simVersion: version });
      const fromBundle = JSON.parse(vm.runInContext('JSON.stringify(DuelSim.replay(LOG))', ctx));
      for (const k of Object.keys(g.expect)) {
        expect(fromSource[k as keyof typeof fromSource], `source ${k}`).toEqual(g.expect[k]);
        expect(fromBundle[k], `bundle ${k}`).toEqual(g.expect[k]);
      }
      expect(fromBundle.simVersion).toBe(version);
    }, 60000);
  }
});
