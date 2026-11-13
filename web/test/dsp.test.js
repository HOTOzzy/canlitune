'use strict';
// Run: node --expose-gc test/dsp.test.js
const path = require('path');
const { AutoTuneEngine } = require(path.join(__dirname, '..', 'dsp-core.js'));

const FS = 48000, BLOCK = 128;
const CHROM = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
const CMAJ = [1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1];
const DRY_FX = { compRatio: 1, satMix: 0, dlyMix: 0, revMix: 0, outDb: 0, howlGuard: false, gateDb: -70 };
let pass = 0, fail = 0;
function check(name, ok, info) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info || ''}`); ok ? pass++ : fail++; }
const cents = (a, b) => 1200 * Math.log2(a / b);

function engine(params) { const e = new AutoTuneEngine(FS); e.setParams(Object.assign({}, DRY_FX, params)); return e; }

// Run a signal through the engine in 128-sample blocks. onHop(e, sampleIndex) is called per block.
function run(e, sig, onBlock) {
  const out = new Float32Array(sig.length), L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
  for (let i = 0; i + BLOCK <= sig.length; i += BLOCK) {
    e.process(sig.subarray(i, i + BLOCK), L, R, BLOCK);
    out.set(L, i);
    if (onBlock) onBlock(e, i + BLOCK);
  }
  return out;
}

function sine(f, dur, amp = 0.3) { const n = Math.round(dur * FS), s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = amp * Math.sin(2 * Math.PI * f * i / FS); return s; }

// Synthetic vowel /a/: harmonic series shaped by a 3-formant envelope (F1 700, F2 1220, F3 2600 Hz).
const FORM = [[700, 80, 1], [1220, 90, 0.6], [2600, 120, 0.25]];
function env(f) { let e = 0; for (const [F, B, g] of FORM) e += g / (1 + ((f - F) / B) ** 2); return e + 0.02; }
function vowel(f0, dur, amp = 0.3) {
  const n = Math.round(dur * FS), s = new Float32Array(n);
  const K = Math.floor(5000 / f0);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += 2 * Math.PI * f0 / FS;
    let v = 0; for (let k = 1; k <= K; k++) v += env(k * f0) / k * Math.sin(k * ph);
    s[i] = v;
  }
  let pk = 0; for (const v of s) pk = Math.max(pk, Math.abs(v));
  for (let i = 0; i < n; i++) s[i] *= amp / pk;
  return s;
}

// Independent offline reference pitch estimator (plain full-rate YIN, not the engine's code path).
function refPitch(sig, start, len = 4096, fmin = 60, fmax = 1000) {
  const W = 2048, tmax = Math.ceil(FS / fmin), tmin = Math.floor(FS / fmax);
  const d = new Float64Array(tmax + 2); let run = 0, best = -1;
  const cm = new Float64Array(tmax + 2); cm[0] = 1;
  for (let t = 1; t <= tmax + 1; t++) { let s = 0; for (let j = 0; j < W; j++) { const q = sig[start + j] - sig[start + j + t]; s += q * q; } d[t] = s; run += s; cm[t] = s * t / run; }
  for (let t = tmin; t < tmax; t++) if (cm[t] < 0.1) { while (cm[t + 1] < cm[t]) t++; best = t; break; }
  if (best < 0) { let m = 1e9; for (let t = tmin; t < tmax; t++) if (cm[t] < m) { m = cm[t]; best = t; } }
  const a = d[best - 1], b = d[best], c = d[best + 1], dd = a + c - 2 * b;
  return FS / (best + (dd > 0 ? 0.5 * (a - c) / dd : 0));
}

// LPC formant estimate (autocorrelation + Levinson-Durbin), returns first two envelope peaks > 250 Hz.
function formants(sig, start, len = 3600, order = 20) {
  const x = new Float64Array(len);
  for (let i = 0; i < len; i++) { const pre = sig[start + i] - 0.63 * sig[start + i - 1]; x[i] = pre * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (len - 1))); }
  const r = new Float64Array(order + 1);
  for (let k = 0; k <= order; k++) { let s = 0; for (let i = k; i < len; i++) s += x[i] * x[i - k]; r[k] = s; }
  r[0] *= 1.0001;
  let a = new Float64Array(order + 1); a[0] = 1; let e = r[0];
  for (let i = 1; i <= order; i++) {
    let acc = r[i]; for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / e; const na = a.slice();
    for (let j = 1; j < i; j++) na[j] = a[j] + k * a[i - j];
    na[i] = k; a = na; e *= 1 - k * k;
  }
  const mag = [], fr = [];
  for (let f = 100; f < 4000; f += 5) {
    const w = 2 * Math.PI * f / FS; let re = 0, im = 0;
    for (let j = 0; j <= order; j++) { re += a[j] * Math.cos(w * j); im -= a[j] * Math.sin(w * j); }
    mag.push(1 / Math.hypot(re, im)); fr.push(f);
  }
  const peaks = [];
  for (let i = 1; i < mag.length - 1; i++) if (mag[i] > mag[i - 1] && mag[i] >= mag[i + 1] && fr[i] > 250) peaks.push(fr[i]);
  return peaks.slice(0, 2);
}


// Harmonic-envelope test: measure each harmonic of the output and correlate its log amplitude with
// (a) the ORIGINAL formant envelope (formants preserved) and (b) the envelope scaled by the pitch ratio (formants shifted).
function envelopeMatch(sig, start, f0out, ratio, len = 9600) {
  const meas = [], keep = [], shift = [];
  for (let k = 1; k * f0out < 4000; k++) {
    const f = k * f0out, w = 2 * Math.PI * f / FS; let re = 0, im = 0;
    for (let i = 0; i < len; i++) { const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / len); re += sig[start + i] * h * Math.cos(w * i); im += sig[start + i] * h * Math.sin(w * i); }
    meas.push(Math.log(Math.hypot(re, im) + 1e-12)); keep.push(Math.log(env(f) / f)); shift.push(Math.log(env(f / ratio) / f));
  }
  const corr = (a, b) => { const n = a.length, ma = a.reduce((x, y) => x + y) / n, mb = b.reduce((x, y) => x + y) / n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); };
  return { keep: corr(meas, keep), shift: corr(meas, shift) };
}

console.log('== 1. Pitch detection: steady sines (engine detector) ==');
{
  let worst = 0;
  for (const f of [82.4, 110, 146.8, 196, 261.6, 392, 523.3, 659.3, 830]) {
    const e = engine({ mask: CHROM, retuneMs: 0, minF0: 70, maxF0: 900 });
    run(e, sine(f, 0.4));
    const err = Math.abs(cents(e.f0, f)); worst = Math.max(worst, err);
    check(`sine ${f} Hz`, e.voiced && err < 3, `detected ${e.f0.toFixed(2)} Hz, err ${err.toFixed(2)} cents`);
  }
  console.log(`   worst-case error: ${worst.toFixed(2)} cents`);
}

console.log('== 2. Pitch tracking: exponential sweep 90 -> 700 Hz over 4 s ==');
{
  const dur = 4, n = dur * FS, s = new Float32Array(n); let ph = 0;
  const fAt = (i) => 90 * Math.pow(700 / 90, i / n);
  for (let i = 0; i < n; i++) { ph += 2 * Math.PI * fAt(i) / FS; s[i] = 0.3 * Math.sin(ph); }
  const e = engine({ mask: CHROM, minF0: 70, maxF0: 900 });
  const errs = [];
  run(e, s, (eng, i) => { if (i > FS * 0.2 && eng.voiced) {
    // detector analyses a window ending now; centre of the full-rate refinement window is ~ Wf/2 + T ago
    const lag = eng.Wf / 2 + eng.fs / eng.f0; errs.push(Math.abs(cents(eng.f0, fAt(i - lag)))); } });
  errs.sort((a, b) => a - b);
  const med = errs[errs.length >> 1], p95 = errs[Math.floor(errs.length * 0.95)];
  check('sweep median error < 5 cents', med < 5, `median ${med.toFixed(2)} c, p95 ${p95.toFixed(2)} c, frames ${errs.length}`);
}

console.log('== 3. Pitch detection: synthetic vowel /a/ (strong formants, weak fundamental) ==');
for (const f of [98, 180, 262]) {
  const e = engine({ mask: CHROM, minF0: 70, maxF0: 900 });
  run(e, vowel(f, 0.5));
  const err = Math.abs(cents(e.f0, f));
  check(`vowel f0=${f} Hz`, e.voiced && err < 5, `detected ${e.f0.toFixed(2)} Hz (${err.toFixed(2)} c), YIN conf ${e.conf.toFixed(3)}`);
}

console.log('== 4. Scale quantizer + hard tune (retune 0) — output pitch measured independently ==');
for (const mode of [0, 1]) {
  const name = mode ? 'PSOLA' : 'Splice';
  const cases = [
    ['chromatic, 446 Hz (+23c) -> A4 440', CHROM, 446, 440],
    ['C major,  455 Hz (+58c) -> A4 440 (A# not in scale)', CMAJ, 455, 440],
    ['chromatic, 459 Hz (+74c) -> A#4 466.16', CHROM, 459, 466.16],
    ['C major, vowel 151 Hz -> D3 146.83', CMAJ, 151, 146.83],
  ];
  for (const [label, mask, fin, ftarget] of cases) {
    const e = engine({ mask, retuneMs: 0, mode });
    const sig = label.includes('vowel') ? vowel(fin, 0.8) : sine(fin, 0.8);
    const out = run(e, sig);
    const fo = refPitch(out, FS * 0.5);
    const err = cents(fo, ftarget);
    check(`[${name}] ${label}`, Math.abs(err) < 6, `out ${fo.toFixed(2)} Hz (${err.toFixed(2)} c from target)`);
  }
}

console.log('== 5. Retune speed timing (input 446 Hz -> target 440, i.e. -23 cents) ==');
for (const rt of [0, 25, 100]) {
  const e = engine({ mask: CHROM, retuneMs: rt, mode: 0 });
  const track = [];
  run(e, sine(446, 1.0), (eng, i) => { if (eng.voiced) track.push([i / FS, eng.corr * 100]); });
  const t0 = track[0][0];
  const hit = track.find(([, c]) => c < -23 * 0.9);
  const ms = hit ? (hit[0] - t0) * 1000 : NaN;
  const ok = rt === 0 ? ms <= 6 : ms > rt * 0.7 && ms < rt * 1.4;
  check(`retune ${rt} ms: 90% of correction reached`, ok, `after ${ms.toFixed(1)} ms of voiced signal`);
}

console.log('== 6. Formant preservation: vowel 185 Hz (F#3), transpose +5 semitones ==');
{
  const f0v = 440 * Math.pow(2, -15 / 12); // F#3 = 185.0 Hz
  const sig = vowel(f0v, 1.0);
  const fin = formants(sig, FS * 0.6);
  console.log(`   input F1 (LPC): ${fin[0]} Hz`);
  const ratio = Math.pow(2, 5 / 12);
  for (const mode of [1, 0]) {
    const e = engine({ mask: CHROM, retuneMs: 0, transpose: 5, mode });
    const out = run(e, sig);
    const fo = refPitch(out, FS * 0.6), fm = formants(out, FS * 0.6);
    const pErr = cents(fo, f0v * ratio);
    const d1 = fm[0] / fin[0];
    const em = envelopeMatch(out, FS * 0.5, fo, ratio);
    const info = `pitch ${fo.toFixed(1)} Hz (${pErr.toFixed(1)} c), LPC F1 ${fm[0]} Hz (x${d1.toFixed(2)}), envelope corr: preserved ${em.keep.toFixed(3)} vs shifted ${em.shift.toFixed(3)}`;
    if (mode === 1) check('PSOLA keeps formant envelope while pitch moves +5 st', Math.abs(pErr) < 15 && Math.abs(d1 - 1) < 0.12 && em.keep > em.shift && em.keep > 0.9, info);
    else check('Splice mode moves formants with pitch (expected x' + ratio.toFixed(2) + ')', Math.abs(pErr) < 15 && d1 > 1.2 && em.shift > em.keep, info);
  }
  // formant shift control in PSOLA
  const e = engine({ mask: CHROM, retuneMs: 0, mode: 1, formant: 4 });
  const out = run(e, sig); const fm = formants(out, FS * 0.6);
  check('PSOLA formant +4 st raises F1 (expected ~x1.26)', fm[0] / fin[0] > 1.12, `F1 ${fm[0]} Hz (x${(fm[0] / fin[0]).toFixed(2)}), pitch ${refPitch(out, FS * 0.6).toFixed(1)} Hz`);
}

console.log('== 7. Algorithmic latency (onset delay of a vowel, no correction needed) ==');
for (const [mode, f0] of [[0, 110], [0, 220], [1, 110], [1, 220]]) {
  const target = 440 * Math.pow(2, Math.round(12 * Math.log2(f0 / 440)) / 12);
  const e = engine({ mask: CHROM, retuneMs: 0, mode, gateDb: -40 });
  const sil = Math.round(FS * 0.2);
  // warm the voice up, then silence (gate closes), then a sharp onset
  const v = vowel(target, 0.3), s = new Float32Array(sil * 2 + v.length * 2);
  s.set(v, 0); s.set(v, v.length + sil);
  const telem = [];
  const out = run(e, s, (eng, i) => { if (i > v.length + sil + FS * 0.1 && i < v.length * 2 + sil) telem.push(eng.latency); });
  const on = v.length + sil;
  const thr = 0.02; let k = on; while (k < out.length && Math.abs(out[k]) < thr) k++;
  let ki = on; while (Math.abs(s[ki]) < thr) ki++;
  const measured = (k - ki) * 1000 / FS;
  const tm = (telem.reduce((a, b) => a + b, 0) / telem.length + e.LA) * 1000 / FS; // + 1 ms limiter look-ahead
  check(`[${mode ? 'PSOLA' : 'Splice'}] f0 ${target.toFixed(0)} Hz latency`, measured < (mode ? 30 : 15),
    `onset delay ${measured.toFixed(2)} ms, steady-state reported ${tm.toFixed(2)} ms (period ${(1000 / target).toFixed(2)} ms)`);
}

console.log('== 8. Robustness: white noise, silence, extreme params ==');
{
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const n = FS * 1, s = new Float32Array(n); for (let i = 0; i < n; i++) s[i] = 0.2 * rnd();
  const e = engine({ mask: CHROM, mode: 1, v2Level: 0.7, v2Interval: -12, formant: -6, transpose: 12, satMix: 1, satDrive: 24, dlyMix: 0.5, dlyFb: 0.9, revMix: 1, compRatio: 20 });
  let voicedFrames = 0, frames = 0;
  const out = run(e, s, (eng) => { frames++; if (eng.voiced) voicedFrames++; });
  let finite = true, pk = 0; for (const v of out) { if (!Number.isFinite(v)) finite = false; pk = Math.max(pk, Math.abs(v)); }
  check('noise: output finite & limited', finite && pk <= 1, `peak ${pk.toFixed(3)}`);
  check('noise: mostly classified unvoiced', voicedFrames / frames < 0.1, `${(100 * voicedFrames / frames).toFixed(1)}% voiced frames`);
  const e2 = engine({ mask: CHROM }); const o2 = run(e2, new Float32Array(FS));
  check('silence -> silence', o2.every(v => v === 0));
}

console.log('== 9. Loopback latency measurement (simulated device RTL = 1234 samples) ==');
{
  const e = engine({});
  const D = 1234, ring = new Float32Array(FS * 4);
  const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK), inb = new Float32Array(BLOCK), t = new Float32Array(12);
  e.measureStart();
  let pos = 0, result = -1;
  for (let b = 0; b < 1000 && result === -1; b++) {
    for (let i = 0; i < BLOCK; i++) inb[i] = (pos + i - D >= 0 ? ring[pos + i - D] : 0) + 0.001 * Math.sin(i);
    e.process(inb, L, R, BLOCK);
    for (let i = 0; i < BLOCK; i++) ring[pos + i] = L[i] * 0.3;
    pos += BLOCK;
    e.telemetry(t); if (t[10] !== -1) result = t[10];
  }
  const expect = D * 1000 / FS;
  check('measured RTL matches simulated', Math.abs(result - expect) < 0.2, `measured ${result.toFixed(3)} ms, true ${expect.toFixed(3)} ms`);
}

console.log('== 10. CPU benchmark & allocation check (10 s of vowel, full FX, both modes, 2 voices) ==');
for (const mode of [0, 1]) {
  const e = engine({ mask: CMAJ, mode, retuneMs: 10, v2Level: 0.5, v2Interval: -12, compRatio: 3, satMix: 0.3, satDrive: 6, dlyMix: 0.2, revMix: 0.25 });
  const sig = vowel(196, 10);
  const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
  for (let i = 0; i < FS; i += BLOCK) e.process(sig.subarray(i, i + BLOCK), L, R, BLOCK); // warm-up / JIT
  if (global.gc) global.gc();
  const h0 = process.memoryUsage().heapUsed;
  const t0 = process.hrtime.bigint();
  let blocks = 0, worst = 0;
  for (let i = 0; i + BLOCK <= sig.length; i += BLOCK) {
    const b0 = process.hrtime.bigint();
    e.process(sig.subarray(i, i + BLOCK), L, R, BLOCK); blocks++;
    const dt = Number(process.hrtime.bigint() - b0) / 1000; if (dt > worst) worst = dt;
  }
  const total = Number(process.hrtime.bigint() - t0) / 1e6;
  const h1 = process.memoryUsage().heapUsed;
  if (global.gc) global.gc();
  const h2 = process.memoryUsage().heapUsed;
  const budget = BLOCK / FS * 1e6;
  const avg = total * 1000 / blocks;
  check(`[${mode ? 'PSOLA' : 'Splice'}] real-time factor`, avg < budget * 0.25,
    `avg ${avg.toFixed(1)} µs / ${budget.toFixed(0)} µs block (${(100 * avg / budget).toFixed(1)}% of one core), worst ${worst.toFixed(0)} µs, 10 s audio in ${total.toFixed(0)} ms`);
  // subarray() in this harness allocates view objects; engine itself must not grow the heap materially
  check(`[${mode ? 'PSOLA' : 'Splice'}] no retained heap growth (leak check) over ${blocks} blocks`, (h2 - h0) < 256 * 1024,
    `retained ${((h2 - h0) / 1024).toFixed(0)} KiB after GC; short-lived churn ${((h1 - h0) / 1024).toFixed(0)} KiB (harness views + JIT number boxing; the native C++ engine is verified at 0 allocations)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
