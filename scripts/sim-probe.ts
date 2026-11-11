/**
 * Balance probes on the shipping simulation, in Node (no browser): `npm run probe:sim`.
 *
 *   npm run probe:sim                 # the whole report (docs/gameplay-improvement-plan.md section 9)
 *   npm run probe:sim -- 0.5          # the same with half the matches (quicker, noisier)
 *   npm run probe:sim -- soak hard 20 # one AI-against-AI soak
 *   npm run probe:sim -- boss sahil attackerPaused
 *
 * The same functions are `__duel.qa.sim` in the dev build; results are identical there.
 */
import { BOSS_IDS } from '../src/sim-core/bosses';
import type { Difficulty } from '../src/config';
import { SCRIPT_KINDS, balanceReport, bossProbe, scripted, simSoak, type ScriptKind } from '../src/qa/simProbe';

const [what, a, b] = process.argv.slice(2);
let out: unknown;
if (what === 'soak') out = simSoak((a || 'normal') as Difficulty, Number(b) || 8);
else if (what === 'boss') out = bossProbe(a || BOSS_IDS[0], (b || 'attackerPaused') as ScriptKind, { immortal: true });
else if (what && (SCRIPT_KINDS as readonly string[]).includes(what)) out = scripted(what as ScriptKind, (a || 'normal') as Difficulty, Number(b) || 6);
else out = balanceReport(Number(what) || 1);
console.log(JSON.stringify(out, null, 1));
