'use strict';
// Runs identical inputs through web/dsp-core.js (JS) and core/CanliTuneEngine.hpp (C++ via ctrun)
// and compares outputs + telemetry. Usage: node core/test/equivalence.test.js <path-to-ctrun>
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const { AutoTuneEngine } = require(path.join(__dirname, '..', '..', 'web', 'dsp-core.js'));
const CT = process.argv[2] || path.join(__dirname, 'ctrun');
const FS = 48000, B = 128;
let fails = 0;
const check = (n, ok, i) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${i}`); if (!ok) fails++; };

function vowelGlide(dur) { // gliding vowel with vibrato + noise burst (exercise voiced/unvoiced + note changes)
  const n = dur * FS, s = new Float32Array(n); let ph = 0, seed = 7;
  const F = [[700, 80, 1], [1220, 90, .6], [2600, 120, .25]], env = f => F.reduce((a, [c, b, g]) => a + g / (1 + ((f - c) / b) ** 2), .02);
  for (let i = 0; i < n; i++) {
    const t = i / FS, f0 = 150 * Math.pow(2, (t < 1.5 ? t : 3 - t) * 0.8) * (1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t));
    ph += 2 * Math.PI * f0 / FS; let v = 0; for (let k = 1; k * f0 < 4500; k++) v += env(k * f0) / k * Math.sin(k * ph);
    seed = (seed * 16807) % 2147483647;
    const gate = (t > 1.9 && t < 2.1) ? 0 : 1, noise = (t > 1.9 && t < 2.1) ? (seed / 2147483647 - 0.5) * 0.3 : 0;
    s[i] = 0.08 * v * gate + noise;
  }
  return s;
}
function runJS(sig, p) {
  const e = new AutoTuneEngine(FS); e.setParams(p);
  const out = new Float32Array(sig.length), L = new Float32Array(B), R = new Float32Array(B), t = new Float32Array(12), tele = [];
  for (let i = 0; i + B <= sig.length; i += B) { e.process(sig.subarray(i, i + B), L, R, B); out.set(L, i); e.telemetry(t); tele.push(Float32Array.from(t)); }
  return { out, tele };
}
function runCPP(sig, p) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-')), fi = path.join(dir, 'in.f32'), fo = path.join(dir, 'out.f32');
  fs.writeFileSync(fi, Buffer.from(sig.buffer, sig.byteOffset, sig.byteLength));
  const args = [String(FS), fi, fo];
  for (const k in p) { if (k === 'mask') args.push('maskBits=' + p.mask.reduce((a, v, i) => a | (v ? 1 << i : 0), 0)); else args.push(`${k}=${typeof p[k] === 'boolean' ? (p[k] ? 1 : 0) : p[k]}`); }
  execFileSync(CT, args);
  const ob = fs.readFileSync(fo), tb = fs.readFileSync(fo + '.tele');
  const out = new Float32Array(ob.buffer, ob.byteOffset, ob.length / 4), tf = new Float32Array(tb.buffer, tb.byteOffset, tb.length / 4), tele = [];
  for (let i = 0; i < tf.length; i += 12) tele.push(tf.subarray(i, i + 12));
  return { out, tele };
}
const sig = vowelGlide(3);
const CASES = {
  'hard-tune splice, C minor': { mask: [1,0,1,1,0,1,0,1,1,0,1,0], retuneMs: 0, mode: 0, compRatio: 1, howlGuard: false },
  'PSOLA + formant + 2nd voice octave': { mask: [1,1,1,1,1,1,1,1,1,1,1,1], retuneMs: 15, mode: 1, formant: 3, v2Level: 0.4, v2Interval: -12, humanize: 40, flex: 30 },
  'full FX chain (Future preset-like)': { mask: [1,0,1,1,0,1,0,1,1,0,1,0], retuneMs: 15, mode: 0, compThr: -24, compRatio: 4, compAtk: 20, compRel: 120, compMakeup: 5, satDrive: 6, satMix: 0.25, dlyMs: 428, dlyFb: 0.25, dlyMix: 0.15, revTime: 0.75, revPre: 15, revMix: 0.18, v2Level: 0.18, v2Detune: 8 },
};
for (const [name, p] of Object.entries(CASES)) {
  const a = runJS(sig, p), b = runCPP(sig, p);
  let num = 0, den = 0, maxd = 0;
  for (let i = 0; i < a.out.length; i++) { const d = a.out[i] - b.out[i]; num += d * d; den += a.out[i] * a.out[i]; maxd = Math.max(maxd, Math.abs(d)); }
  const snr = 10 * Math.log10(den / Math.max(num, 1e-30));
  let noteMismatch = 0, voicedBlocks = 0, maxCents = 0;
  for (let k = 0; k < a.tele.length; k++) {
    if (a.tele[k][5] !== b.tele[k][5]) noteMismatch++;
    if (a.tele[k][4] >= 0 && b.tele[k][4] >= 0) { voicedBlocks++; maxCents = Math.max(maxCents, Math.abs(a.tele[k][4] - b.tele[k][4]) * 100); }
  }
  check(`[${name}] output JS vs C++`, snr > 60, `match SNR ${snr.toFixed(1)} dB, max |diff| ${maxd.toExponential(2)}`);
  check(`[${name}] telemetry JS vs C++`, noteMismatch === 0 && maxCents < 0.1, `target-note mismatches ${noteMismatch}/${a.tele.length}, max detected-pitch diff ${maxCents.toFixed(4)} c over ${voicedBlocks} voiced blocks`);
}
process.exit(fails ? 1 : 0);
