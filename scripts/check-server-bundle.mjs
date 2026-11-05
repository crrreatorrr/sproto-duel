#!/usr/bin/env node
/**
 * Checks dist/duel-sim.server.js is safe for the hub's goja runtime:
 * - parses as ES5 (acorn, ecmaVersion 5): no classes, let/const, arrows, async, generators...
 * - no WASM, async, timers, DOM, Date, Math.random, require/import, typed arrays or ES2015+
 *   built-ins (Map, Set, Symbol, Promise, Array.from, String#includes...)
 * - Math is used only for floor/ceil/round/abs/min/max/sqrt/PI (the others differ between engines)
 * - the header version equals sha256(body)[0:16]
 * - it runs: top-level DUEL_SIM_VERSION and DuelSim.replay exist, and replay(null) returns ok:false
 * With `--base <ref>`: fails if the bundle differs from <ref>'s but its version header does not.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { parseBundle } from './build-server-sim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REL = 'dist/duel-sim.server.js';
const file = process.argv.find((a) => a.endsWith('.js') && !a.endsWith('check-server-bundle.mjs')) ?? path.join(ROOT, REL);
const text = fs.readFileSync(file, 'utf8');
const problems = [];

const BANNED_GLOBALS = new Set([
  'Date', 'Promise', 'WebAssembly', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Proxy', 'Reflect',
  'require', 'process', 'window', 'document', 'globalThis', 'self', 'performance', 'navigator',
  'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'requestAnimationFrame',
  'fetch', 'XMLHttpRequest', 'eval', 'Function', 'Atomics', 'SharedArrayBuffer', 'ArrayBuffer', 'DataView',
  'Float32Array', 'Float64Array', 'Int8Array', 'Int16Array', 'Int32Array', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Uint8ClampedArray',
  'Intl', 'crypto', 'console', 'BigInt', 'atob', 'btoa', 'TextEncoder', 'TextDecoder',
]);
const MATH_OK = new Set(['floor', 'ceil', 'round', 'abs', 'min', 'max', 'sqrt', 'PI']);
/** ES2015+ static methods. */
const STATIC_BANNED = { Object: ['entries', 'values', 'fromEntries', 'getOwnPropertySymbols', 'is', 'setPrototypeOf'], Array: ['from', 'of'], Number: ['isFinite', 'isInteger', 'isNaN', 'isSafeInteger', 'parseFloat', 'parseInt', 'EPSILON'], String: ['raw', 'fromCodePoint'], Math: [] };
/** ES2015+ prototype methods (called as x.name(...)). */
const METHOD_BANNED = new Set(['includes', 'find', 'findIndex', 'findLast', 'findLastIndex', 'fill', 'copyWithin', 'padStart', 'padEnd', 'repeat', 'startsWith', 'endsWith', 'codePointAt', 'normalize', 'flat', 'flatMap', 'at', 'trimStart', 'trimEnd', 'replaceAll', 'matchAll']);

let ast;
try {
  ast = acorn.parse(text, { ecmaVersion: 5, sourceType: 'script', locations: true });
} catch (e) {
  problems.push(`not ES5: ${e.message}`);
}

function walk(node, parent, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => walk(c, node, fn));
    else if (v && typeof v.type === 'string') walk(v, node, fn);
  }
}

if (ast) {
  // Names declared anywhere in the bundle (a local `Map` variable would be fine, but we have none).
  walk(ast, null, (n, p) => {
    const at = n.loc ? `line ${n.loc.start.line}` : '';
    if (n.type === 'Identifier') {
      const isKey = p && ((p.type === 'MemberExpression' && p.property === n && !p.computed) || (p.type === 'Property' && p.key === n && !p.computed));
      if (!isKey && BANNED_GLOBALS.has(n.name)) problems.push(`${n.name} (${at})`);
    }
    if (n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier') {
      const o = n.object.name, k = n.property.name;
      if (o === 'Math' && !MATH_OK.has(k)) problems.push(`Math.${k} (${at})`);
      if (STATIC_BANNED[o] && STATIC_BANNED[o].includes(k)) problems.push(`${o}.${k} (${at})`);
      if (o === 'Object' && k === 'assign' && !(p && p.type === 'LogicalExpression' && p.operator === '||' && p.left === n)) problems.push(`Object.assign (${at})`);
    }
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed && METHOD_BANNED.has(n.callee.property.name)) {
      problems.push(`.${n.callee.property.name}() (${at})`);
    }
    if (n.type === 'Literal' && n.regex) problems.push(`regular expression (${at})`);
  });
}
for (const word of ['WebAssembly', 'async ', 'await ', '.wasm', 'import(', 'Math.random', 'Date.now', 'new Date']) {
  if (text.includes(word)) problems.push(`text contains "${word}"`);
}

const { declared, actual } = parseBundle(text);
if (!declared) problems.push('first line is not `var DUEL_SIM_VERSION = \'<16 hex>\';`');
else if (declared !== actual) problems.push(`version header ${declared} != sha256(body)[0:16] ${actual}`);

// It runs, in a bare context, as goja would load it.
try {
  const ctx = vm.createContext({});
  vm.runInContext(text, ctx, { filename: REL });
  const v = vm.runInContext('typeof DUEL_SIM_VERSION === "string" && typeof DuelSim === "object" && typeof DuelSim.replay === "function" && JSON.stringify(DuelSim.replay(null))', ctx);
  const r = v && JSON.parse(v);
  if (!r || r.ok !== false || typeof r.error !== 'string' || typeof r.endHash !== 'string' || r.simVersion !== declared) problems.push(`smoke run failed: ${v}`);
} catch (e) {
  problems.push(`does not run: ${e.message}`);
}

const bi = process.argv.indexOf('--base');
if (bi > 0) {
  const ref = process.argv[bi + 1];
  let before = null;
  try {
    before = execFileSync('git', ['show', `${ref}:${REL}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    before = null; // new file on this branch
  }
  if (before !== null && before !== text && parseBundle(before).declared === declared) problems.push(`bundle changed since ${ref} but DUEL_SIM_VERSION did not`);
}

if (problems.length) {
  console.error(`${REL}: ${problems.length} problem(s)`);
  for (const p of [...new Set(problems)].slice(0, 60)) console.error('  - ' + p);
  process.exit(1);
}
console.log(`${REL}: ES5, goja-safe, version ${declared} matches its body`);
