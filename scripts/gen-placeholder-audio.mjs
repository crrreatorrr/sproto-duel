// Synthesizes placeholder sound effects and music loops as 16-bit mono WAVs into
// public/assets/audio/placeholder/<key>.wav. Run with `npm run gen:audio`.
// Real files at the manifest paths (public/assets/audio/<name>.mp3 etc.) always win.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 22050;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'audio', 'placeholder');
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- tiny DSP kit
let seed = 1234567;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const buf = (sec) => new Float32Array(Math.ceil(sec * SR));
const lerp = (a, b, t) => a + (b - a) * t;

/** Add an oscillator with a frequency function f(t) and amplitude envelope env(t). */
function osc(out, start, dur, freq, env, type = 'sine', gain = 1) {
  let phase = 0;
  const n0 = Math.floor(start * SR), n = Math.floor(dur * SR);
  for (let i = 0; i < n && n0 + i < out.length; i++) {
    const t = i / SR, u = t / dur;
    phase += (typeof freq === 'function' ? freq(u, t) : freq) / SR;
    const p = phase % 1;
    let v;
    if (type === 'sine') v = Math.sin(p * Math.PI * 2);
    else if (type === 'saw') v = p * 2 - 1;
    else if (type === 'square') v = p < 0.5 ? 1 : -1;
    else v = 1 - 4 * Math.abs(p - 0.5); // triangle
    out[n0 + i] += v * env(u, t) * gain;
  }
}

function noise(out, start, dur, env, gain = 1, color = 0) {
  // color: 0 white .. 0.99 heavily low-passed
  let last = 0;
  const n0 = Math.floor(start * SR), n = Math.floor(dur * SR);
  for (let i = 0; i < n && n0 + i < out.length; i++) {
    const u = i / n;
    const c = typeof color === 'function' ? color(u) : color;
    last = last * c + rnd() * (1 - c);
    out[n0 + i] += last * env(u, i / SR) * gain * (1 + c * 3);
  }
}

const decay = (k) => (u) => Math.exp(-u * k);
const adsr = (a, r) => (u) => (u < a ? u / a : Math.pow(1 - (u - a) / (1 - a), r));
const swell = (u) => Math.sin(Math.PI * u);

function lowpass(x, cutoff) {
  const rc = 1 / (2 * Math.PI * cutoff), a = (1 / SR) / (rc + 1 / SR);
  let y = 0;
  for (let i = 0; i < x.length; i++) x[i] = y = y + a * (x[i] - y);
  return x;
}
function highpass(x, cutoff) {
  const rc = 1 / (2 * Math.PI * cutoff), a = rc / (rc + 1 / SR);
  let y = 0, prev = 0;
  for (let i = 0; i < x.length; i++) {
    const cur = x[i];
    y = a * (y + cur - prev);
    prev = cur;
    x[i] = y;
  }
  return x;
}
function echo(x, delay, fb, mix) {
  const d = Math.floor(delay * SR);
  const y = Float32Array.from(x);
  for (let i = d; i < y.length; i++) y[i] += y[i - d] * fb;
  for (let i = 0; i < x.length; i++) x[i] = x[i] * (1 - mix) + y[i] * mix;
  return x;
}
function drive(x, amount) {
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * amount) / Math.tanh(amount);
  return x;
}
function normalize(x, peak = 0.89) {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
  return x;
}
/** Fade the last `sec` seconds into the start so the file loops without a click. */
function loopify(x, sec) {
  const n = Math.floor(sec * SR);
  const out = x.slice(0, x.length - n);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    out[i] = out[i] * t + x[x.length - n + i] * (1 - t);
  }
  return out;
}

function writeWav(name, x) {
  const data = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) data.writeInt16LE(Math.max(-1, Math.min(1, x[i])) * 32767 | 0, i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path.join(OUT, `${name}.wav`), Buffer.concat([h, data]));
}

const note = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDI -> Hz

// --------------------------------------------------------------------- sounds
const S = {};

S.boltCast = () => {
  const x = buf(0.16);
  osc(x, 0, 0.14, (u) => lerp(1700, 520, u), decay(6), 'saw', 0.5);
  osc(x, 0, 0.12, (u) => lerp(2400, 900, u), decay(8), 'sine', 0.4);
  noise(x, 0, 0.06, decay(10), 0.35);
  return highpass(x, 300);
};
S.boltHit = () => {
  const x = buf(0.25);
  noise(x, 0, 0.2, decay(9), 0.8, 0.5);
  osc(x, 0, 0.18, (u) => lerp(260, 70, u), decay(7), 'sine', 0.9);
  return drive(x, 2);
};
S.fizzle = () => {
  const x = buf(0.22);
  noise(x, 0, 0.2, decay(7), 0.5);
  return highpass(x, 1500);
};
S.blastCharge = () => {
  const x = buf(0.3);
  osc(x, 0, 0.3, (u) => lerp(180, 720, u * u), (u, t) => u * (0.7 + 0.3 * Math.sin(t * 90)), 'saw', 0.4);
  osc(x, 0, 0.3, (u) => lerp(360, 1440, u * u), (u) => u, 'sine', 0.3);
  return lowpass(x, 3000);
};
S.blastCast = () => {
  const x = buf(0.45);
  noise(x, 0, 0.4, adsr(0.15, 2), 0.7, (u) => lerp(0.6, 0.95, u));
  osc(x, 0, 0.35, (u) => lerp(220, 90, u), decay(5), 'saw', 0.4);
  return lowpass(x, 2500);
};
S.blastExplode = () => {
  const x = buf(1.1);
  noise(x, 0, 1.05, decay(4.5), 1.0, (u) => lerp(0.75, 0.97, u));
  osc(x, 0, 0.6, (u) => lerp(90, 30, u), decay(5), 'sine', 1.0);
  noise(x, 0, 0.05, decay(20), 0.6);
  return drive(lowpass(x, 3500), 2.5);
};
S.shieldUp = () => {
  const x = buf(0.55);
  for (const [f, g] of [[660, 0.4], [990, 0.3], [1320, 0.25], [1650, 0.15]]) osc(x, 0, 0.5, (u) => f * (1 + u * 0.06), adsr(0.04, 2), 'sine', g);
  noise(x, 0, 0.2, swell, 0.15);
  return echo(highpass(x, 400), 0.07, 0.35, 0.3);
};
S.shieldBlock = () => {
  const x = buf(0.45);
  for (const [f, g] of [[523, 0.4], [1187, 0.3], [1789, 0.22], [2631, 0.12]]) osc(x, 0, 0.42, f, decay(7), 'sine', g);
  noise(x, 0, 0.03, decay(25), 0.6);
  return x;
};
S.shieldPerfect = () => {
  const x = buf(0.9);
  for (const [f, g] of [[784, 0.35], [1175, 0.3], [1568, 0.25], [2349, 0.18]]) osc(x, 0, 0.85, f, decay(4), 'sine', g);
  osc(x, 0, 0.35, (u) => lerp(600, 2400, u), adsr(0.05, 1), 'saw', 0.15);
  noise(x, 0, 0.04, decay(25), 0.6);
  return echo(x, 0.09, 0.4, 0.35);
};
S.stunCharge = () => {
  const x = buf(0.24);
  osc(x, 0, 0.24, (u) => lerp(300, 1300, u), (u) => u, 'square', 0.25);
  noise(x, 0, 0.24, (u, t) => (Math.sin(t * 600) > 0.6 ? u : 0), 0.4);
  return highpass(x, 600);
};
S.stunBeam = () => {
  const x = buf(0.4);
  osc(x, 0, 0.38, (u, t) => 880 + Math.sin(t * 70) * 60, adsr(0.02, 1.5), 'square', 0.3);
  osc(x, 0, 0.38, (u, t) => 1760 + Math.sin(t * 50) * 90, adsr(0.02, 2), 'sine', 0.3);
  noise(x, 0, 0.3, decay(6), 0.3);
  return lowpass(x, 5000);
};
S.stunHit = () => {
  const x = buf(0.6);
  for (let k = 0; k < 6; k++) noise(x, k * 0.035, 0.05, decay(30), 0.5 - k * 0.05);
  osc(x, 0, 0.55, 2093, decay(5), 'sine', 0.3);
  osc(x, 0, 0.55, 3136, decay(7), 'sine', 0.2);
  return highpass(x, 800);
};
S.ultReady = () => {
  const x = buf(0.7);
  [69, 73, 76, 81].forEach((n, i) => osc(x, i * 0.09, 0.4, note(n), decay(5), 'triangle', 0.5));
  return echo(x, 0.12, 0.35, 0.3);
};
S.ultCharge = () => {
  const x = buf(0.45);
  osc(x, 0, 0.45, (u) => lerp(55, 220, u * u), (u) => u, 'saw', 0.6);
  noise(x, 0, 0.45, (u) => u * u, 0.6, 0.8);
  return lowpass(x, 1800);
};
S.ultWave = () => {
  const x = buf(1.8);
  noise(x, 0, 1.75, adsr(0.02, 1.6), 1.0, (u) => lerp(0.5, 0.97, u));
  osc(x, 0, 1.2, (u) => lerp(70, 28, u), decay(3), 'sine', 1.0);
  osc(x, 0, 0.6, (u) => lerp(400, 60, u), decay(4), 'saw', 0.3);
  return drive(echo(lowpass(x, 4000), 0.15, 0.3, 0.3), 2);
};
S.clash = () => {
  const x = buf(0.6);
  noise(x, 0, 0.5, decay(7), 0.8, 0.3);
  osc(x, 0, 0.4, (u) => lerp(420, 80, u), decay(6), 'saw', 0.5);
  for (const f of [740, 1610, 2380]) osc(x, 0, 0.5, f, decay(8), 'sine', 0.18);
  return drive(x, 2);
};
S.dodge = () => {
  const x = buf(0.3);
  noise(x, 0, 0.28, swell, 0.9, (u) => lerp(0.3, 0.85, u));
  return highpass(x, 350);
};
S.hurt = () => {
  const x = buf(0.28);
  osc(x, 0, 0.25, (u) => lerp(170, 55, u), decay(6), 'sine', 1);
  noise(x, 0, 0.12, decay(12), 0.5, 0.6);
  return drive(x, 1.6);
};
S.noMana = () => {
  const x = buf(0.2);
  osc(x, 0, 0.18, (u) => lerp(140, 90, u), decay(8), 'square', 0.5);
  return lowpass(x, 700);
};
S.pillarHit = () => {
  const x = buf(0.25);
  noise(x, 0, 0.2, decay(14), 0.9, 0.7);
  osc(x, 0, 0.15, 95, decay(12), 'sine', 0.6);
  return x;
};
S.pillarCrumble = () => {
  const x = buf(1.6);
  noise(x, 0, 1.55, adsr(0.03, 1.4), 0.9, 0.93);
  for (let k = 0; k < 18; k++) noise(x, Math.random() * 1.2, 0.08, decay(18), 0.5, 0.6);
  osc(x, 0, 0.8, (u) => lerp(70, 35, u), decay(4), 'sine', 0.7);
  return lowpass(x, 2500);
};
S.fireBurn = () => {
  const x = buf(0.35);
  noise(x, 0, 0.32, decay(6), 0.8, 0.5);
  for (let k = 0; k < 5; k++) noise(x, Math.random() * 0.25, 0.02, decay(30), 0.7);
  return highpass(lowpass(x, 5000), 200);
};
S.fireLoop = () => {
  const x = buf(4.3);
  noise(x, 0, 4.3, () => 0.35, 1, 0.85);
  for (let k = 0; k < 90; k++) noise(x, Math.random() * 4.25, 0.015, decay(25), 0.4 + Math.random() * 0.4);
  return loopify(highpass(x, 120), 0.3);
};
S.countdown = () => {
  const x = buf(0.2);
  osc(x, 0, 0.18, 660, adsr(0.01, 2), 'triangle', 0.7);
  return x;
};
S.roundStart = () => {
  const x = buf(1.8);
  for (const [f, g] of [[110, 0.6], [222, 0.4], [331, 0.3], [497, 0.15]]) osc(x, 0, 1.75, f, decay(2.5), 'sine', g);
  noise(x, 0, 0.06, decay(15), 0.6, 0.4);
  return echo(x, 0.18, 0.3, 0.25);
};
S.roundWin = () => {
  const x = buf(0.9);
  [60, 64, 67, 72].forEach((n, i) => osc(x, i * 0.1, 0.5, note(n), decay(4), 'triangle', 0.5));
  return echo(x, 0.14, 0.3, 0.25);
};
S.roundLose = () => {
  const x = buf(1.0);
  [67, 63, 60, 55].forEach((n, i) => osc(x, i * 0.13, 0.55, note(n), decay(4), 'triangle', 0.5));
  return echo(x, 0.14, 0.3, 0.25);
};
S.victory = () => {
  const x = buf(2.2);
  [60, 64, 67, 72, 76].forEach((n, i) => osc(x, i * 0.11, 0.4, note(n), decay(4), 'saw', 0.18));
  for (const n of [60, 64, 67, 72]) osc(x, 0.6, 1.5, note(n), adsr(0.05, 1.5), 'triangle', 0.3);
  return echo(lowpass(x, 4000), 0.16, 0.35, 0.3);
};
S.defeat = () => {
  const x = buf(2.2);
  [69, 65, 62, 57].forEach((n, i) => osc(x, i * 0.18, 0.6, note(n), decay(3), 'triangle', 0.35));
  for (const n of [45, 48, 52]) osc(x, 0.75, 1.4, note(n), adsr(0.1, 1.5), 'saw', 0.15);
  return echo(lowpass(x, 2500), 0.2, 0.35, 0.3);
};
S.uiHover = () => {
  const x = buf(0.05);
  osc(x, 0, 0.04, 1250, decay(10), 'sine', 0.5);
  return x;
};
S.uiClick = () => {
  const x = buf(0.09);
  osc(x, 0, 0.08, (u) => lerp(700, 1300, u), decay(7), 'triangle', 0.6);
  return x;
};

// ---------------------------------------------------------------------- music
S.musicMenu = () => {
  // A minor pad: Am - F - C - G, 4 s each, slow swells, loops cleanly.
  const bar = 4;
  const chords = [[57, 60, 64, 69], [53, 57, 60, 65], [48, 55, 60, 64], [55, 59, 62, 67]];
  const x = buf(bar * chords.length + 1);
  chords.forEach((c, i) => {
    for (const n of c) {
      osc(x, i * bar, bar + 1, note(n), (u) => Math.sin(Math.PI * Math.min(1, u * 1.1)) ** 1.5, 'triangle', 0.12);
      osc(x, i * bar, bar + 1, note(n) * 1.003, (u) => Math.sin(Math.PI * Math.min(1, u * 1.1)) ** 1.5, 'sine', 0.1);
    }
    // Twinkles.
    for (let k = 0; k < 6; k++) osc(x, i * bar + k * 0.66, 0.6, note(c[k % 4] + 24), decay(5), 'sine', 0.05);
  });
  return loopify(echo(lowpass(x, 3000), 0.33, 0.45, 0.35), 1);
};
S.musicBattle = () => {
  // 120 BPM, D minor, 8 bars = 16 s.
  const beat = 0.5;
  const bars = 8;
  const x = buf(bars * 4 * beat + 0.5);
  const roots = [50, 50, 46, 48, 50, 50, 53, 52];
  for (let b = 0; b < bars; b++) {
    const t0 = b * 4 * beat;
    for (let k = 0; k < 4; k++) {
      const t = t0 + k * beat;
      osc(x, t, 0.3, (u) => lerp(150, 45, u), decay(8), 'sine', 0.9); // kick
      if (k % 2 === 1) noise(x, t, 0.18, decay(14), 0.45, 0.2); // snare
      noise(x, t + beat / 2, 0.04, decay(30), 0.15); // hat
    }
    // Driving bass eighths.
    for (let k = 0; k < 8; k++) osc(x, t0 + k * beat / 2, beat / 2, note(roots[b] - 12), adsr(0.02, 2), 'saw', 0.22);
    // Arpeggio.
    const arp = [0, 3, 7, 12, 7, 3, 0, 10];
    for (let k = 0; k < 8; k++) osc(x, t0 + k * beat / 2, beat / 2 * 0.9, note(roots[b] + 12 + arp[k]), decay(5), 'square', 0.06);
  }
  return loopify(lowpass(x, 5000), 0.25);
};

let total = 0;
for (const [name, fn] of Object.entries(S)) {
  const x = normalize(fn(), name.startsWith('music') ? 0.7 : 0.89);
  writeWav(name, x);
  total += x.length * 2;
}
console.log(`Wrote ${Object.keys(S).length} placeholder sounds (${(total / 1024 / 1024).toFixed(1)} MB) to ${path.relative(process.cwd(), OUT)}`);
