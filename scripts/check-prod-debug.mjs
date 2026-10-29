/**
 * Production bundles must not ship the QA harness or the debug global.
 * God mode itself stays (Settings, F9, the "99" cheat).
 */
import fs from 'node:fs';
import path from 'node:path';

const dist = path.resolve('dist');
const banned = ['__duel', 'QAHarness', 'registerSpellScenarios', 'campaignSoak'];
const hits = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(js|css|html|map)$/.test(entry.name)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const word of banned) {
        if (text.includes(word)) hits.push(`${path.relative(dist, file)} contains ${word}`);
      }
    }
  }
}

if (!fs.existsSync(dist)) {
  console.error('dist/ is missing. Run the production build first.');
  process.exit(1);
}
walk(dist);
if (hits.length) {
  console.error(hits.join('\n'));
  process.exit(1);
}
console.log('Production bundle has no debug globals or QA harness.');
