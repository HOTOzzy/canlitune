'use strict';
// "Do the presets actually sound different?"  Renders the same test vocal through every preset and compares
// the results: 1/3-octave spectrum, reverb/delay tail, and how tightly the pitch is pulled.
// Usage: node web/test/presets.test.js [old-artists.json old-presets.json]
const fs = require('fs'), path = require('path');
const { AutoTuneEngine } = require('../dsp-core.js');
const FS = 48000, SC = { chromatic: [0,1,2,3,4,5,6,7,8,9,10,11], major: [0,2,4,5,7,9,11], minor: [0,2,3,5,7,8,10] };
function load(af, pf) {
  const L = JSON.parse(fs.readFileSync(af, 'utf8')), P = JSON.parse(fs.readFileSync(pf, 'utf8')), out = [];
  for (const a of P.presets) out.push([a.name, a.params]);
  for (const a of L.artists) out.push([a.name, Object.assign({}, L.base, L.styles[a.s].o, a.o)]);
  return out;
}
function engineParams(p) {
  const q = Object.assign({}, p), mask = new Array(12).fill(0); for (const d of (SC[p.scale] || SC.chromatic)) mask[(9 + d) % 12] = 1;   // key A
  q.mask = mask; q.dlyMs = 60000 / (p.bpm || 120) * (p.dlyDiv || 1); q.howlGuard = false; q.gateDb = -70; q.minF0 = 60; q.maxF0 = 1000;
  return q;
}
// test vocal: a sung phrase gliding between slightly-off notes with vibrato, then silence (to hear tails)
const SIG = (() => { const n = FS * 5, s = new Float32Array(n); let ph = 0; const F = [[700, 80, 1], [1220, 90, .6], [2600, 120, .3], [3500, 200, .15]], env = f => F.reduce((a, [c, b, g]) => a + g / (1 + ((f - c) / b) ** 2), .01);
  const notes = [57.3, 60.25, 59.7, 64.35, 62.2, 57.4];
  for (let i = 0; i < FS * 3.2; i++) { const t = i / FS, k = Math.min(notes.length - 1, Math.floor(t / 0.53)), gl = Math.min(1, (t - k * 0.53) / 0.09), m = (k ? notes[k - 1] : notes[0]) * (1 - gl) + notes[k] * gl + 0.25 * Math.sin(2 * Math.PI * 5.5 * t);
    const f0 = 440 * Math.pow(2, (m - 69) / 12); ph += 2 * Math.PI * f0 / FS; let v = 0; for (let h = 1; h * f0 < 9000; h++) v += env(h * f0) / h * Math.sin(h * ph); s[i] = 0.07 * v * Math.min(1, (3.2 - t) * 20); }
  return s; })();
function features(p) {
  const e = new AutoTuneEngine(FS); e.setParams(engineParams(p));
  const L = new Float32Array(128), R = new Float32Array(128), out = new Float32Array(SIG.length), corr = [];
  for (let i = 0; i + 128 <= SIG.length; i += 128) { e.process(SIG.subarray(i, i + 128), L, R, 128); for (let k = 0; k < 128; k++) out[i + k] = (L[k] + R[k]) / 2; if (e.voiced) corr.push(Math.abs((e.inMidi + e.corr) - Math.round(e.inMidi + e.corr))); }
  // band energies via Goertzel-free approach: bank of 16 band-pass energy estimates from a coarse DFT on 8192-blocks
  const N = 8192, bands = new Float64Array(16), edges = []; for (let b = 0; b <= 16; b++) edges.push(100 * Math.pow(120, b / 16));
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let s0 = 0; s0 + N <= FS * 3.2; s0 += N) {
    for (let i = 0; i < N; i++) { re[i] = out[s0 + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); im[i] = 0; }
    for (let i = 1, j = 0; i < N; i++) { let b = N >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; } }
    for (let len = 2; len <= N; len <<= 1) { const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a); for (let i = 0; i < N; i += len) { let cr = 1, ci = 0; for (let j = 0; j < len / 2; j++) { const ur = re[i + j], ui = im[i + j], xr = re[i + j + len / 2], xi = im[i + j + len / 2], vr = xr * cr - xi * ci, vi = xr * ci + xi * cr; re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } }
    for (let k = 1; k < N / 2; k++) { const f = k * FS / N; for (let b = 0; b < 16; b++) if (f >= edges[b] && f < edges[b + 1]) { bands[b] += re[k] * re[k] + im[k] * im[k]; break; } }
  }
  let tot = 0; for (const v of bands) tot += v; const spec = Array.from(bands, v => 10 * Math.log10(v / tot + 1e-9));
  const en = (a, b) => { let s = 0; for (let i = Math.round(a * FS); i < Math.round(b * FS); i++) s += out[i] * out[i]; return 10 * Math.log10(s / (b - a) / FS + 1e-12); };
  const sig = en(1, 3), tail = [Math.max(-60, en(3.35, 3.8) - sig), Math.max(-60, en(4.2, 4.9) - sig)];
  const tight = corr.length ? corr.reduce((a, b) => a + b, 0) / corr.length * 100 : 50;   // mean cents away from a scale note after correction
  return { spec, tail, tight };
}
function dist(a, b) {
  let s = 0; for (let i = 0; i < 16; i++) { const d = Math.max(-45, a.spec[i]) - Math.max(-45, b.spec[i]); s += d * d; }
  const spec = Math.sqrt(s / 16);                                    // dB RMS difference of the spectrum
  const tail = Math.abs(a.tail[0] - b.tail[0]) / 4 + Math.abs(a.tail[1] - b.tail[1]) / 6;
  const tune = Math.abs(a.tight - b.tight) / 5;
  return spec + tail + tune;                                          // ~1.0 = a just-about audible difference on one axis
}
function report(label, list) {
  const F = list.map(([n, p]) => [n, features(p)]); let close = 0, pairs = 0; const nn = F.map(() => 1e9), twins = [];
  for (let i = 0; i < F.length; i++) for (let j = i + 1; j < F.length; j++) { const d = dist(F[i][1], F[j][1]); pairs++; if (d < 1.5) { close++; if (twins.length < 6) twins.push(`${F[i][0]} ≈ ${F[j][0]} (${d.toFixed(2)})`); } if (d < nn[i]) nn[i] = d; if (d < nn[j]) nn[j] = d; }
  nn.sort((a, b) => a - b); const med = nn[nn.length >> 1], twinless = nn.filter(v => v >= 1.5).length;
  console.log(`${label}: ${F.length} presets | near-identical pairs (distance < 1.5): ${close} of ${pairs} | presets with no near-twin: ${twinless} | median nearest-neighbour distance ${med.toFixed(2)}`);
  if (twins.length) console.log('   examples: ' + twins.join('; '));
  return { close, twinless, n: F.length, med };
}
module.exports = { load, features, dist, report };
if (require.main === module) {
const dir = path.join(__dirname, '..');
if (process.argv[3]) report('BEFORE', load(process.argv[2], process.argv[3]));
const r = report('NOW   ', load(path.join(dir, 'artists.json'), path.join(dir, 'presets.json')));
const ok = r.twinless >= r.n * 0.8;
console.log(`${ok ? 'PASS' : 'FAIL'}  at least 80% of presets have no near-identical twin  (${r.twinless}/${r.n})`);
process.exit(ok ? 0 : 1);
}
