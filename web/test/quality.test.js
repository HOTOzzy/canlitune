'use strict';
// Before/after distortion measurements: node web/test/quality.test.js [old-dsp-core.js]
const path = require('path');
const NEW = require(path.join(__dirname, '..', 'dsp-core.js')).AutoTuneEngine;
const OLD = process.argv[2] ? require(path.resolve(process.argv[2])).AutoTuneEngine : null;
const FS = 48000, N = 1 << 15;
function fft(re, im) { const n = re.length; for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let j = 0; j < len / 2; j++) { const ur = re[i + j], ui = im[i + j], vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
      re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } } }
function spectrum(E, params, f0, amp) {
  const e = new E(FS); e.setParams(Object.assign({ bypass: true, compRatio: 1, howlGuard: false, gateDb: -90, hpfHz: 20, revMix: 0, dlyMix: 0 }, params));
  const total = N + FS, x = new Float32Array(total); for (let i = 0; i < total; i++) x[i] = amp * Math.sin(2 * Math.PI * f0 * i / FS);
  const L = new Float32Array(128), R = new Float32Array(128), out = new Float32Array(total);
  for (let i = 0; i + 128 <= total; i += 128) { e.process(x.subarray(i, i + 128), L, R, 128); out.set(L, i); }
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = out[FS + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  fft(re, im); const p = new Float64Array(N / 2); for (let k = 0; k < N / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k]; return p;
}
// harmonic vs non-harmonic (aliased / inharmonic) energy
function analyse(p, f0) {
  const bin = f => Math.round(f / FS * N); let fund = 0, harm = 0, alias = 0;
  const isHarm = k => { const h = k * FS / N / f0; return Math.abs(h - Math.round(h)) * f0 < 40; };
  for (let k = 3; k < N / 2; k++) { if (Math.abs(k - bin(f0)) <= 3) fund += p[k]; else if (isHarm(k)) harm += p[k]; else alias += p[k]; }
  return { thd: 10 * Math.log10(harm / fund), alias: 10 * Math.log10(alias / fund) };
}
module.exports = { spectrum, analyse, NEW, FS, N };
if (require.main === module) {
const cases = [
  ['Saturasyon (Kanye preseti: drive 14 dB, %55), 3.1 kHz', { satDrive: 14, satMix: 0.55 }, 3100, 0.5],
  ['Saturasyon (Carti preseti: drive 10 dB, %40), 2.3 kHz', { satDrive: 10, satMix: 0.4 }, 2300, 0.5],
  ['Limiter, 1 kHz, +6 dB over ceiling', { outDb: 6 }, 1000, 0.8],
  ['Limiter, 220 Hz, +6 dB over ceiling', { outDb: 6 }, 220, 0.8],
];
let fails = 0;
for (const [name, p, f0, a] of cases) {
  const n = analyse(spectrum(NEW, p, f0, a), f0);
  let line = `${name}: new THD ${n.thd.toFixed(1)} dB, aliasing/inharmonic ${n.alias.toFixed(1)} dB`;
  if (OLD) { const o = analyse(spectrum(OLD, p, f0, a), f0); line += `  |  old THD ${o.thd.toFixed(1)} dB, aliasing ${o.alias.toFixed(1)} dB  →  aliasing ${(o.alias - n.alias).toFixed(1)} dB lower`; }
  console.log(line);
}
process.exit(fails ? 1 : 0);
}
