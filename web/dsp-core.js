'use strict';
/*
 * Live Auto-Tune DSP core.
 * Runs inside an AudioWorkletProcessor (browser) and under Node (tests).
 * Rule: nothing inside process() allocates. All buffers are created in the
 * constructor; setParams() runs between render quanta (port message), not in process().
 *
 * Pipeline per sample:
 *   in -> input gain -> HPF -> noise gate -> ring buffer
 *      -> (LPF x2, decimate) -> YIN F0 (every HOP samples) + full-rate refinement
 *      -> scale quantizer (key/scale mask, hysteresis, Flex-Tune, Humanize, Retune)
 *      -> pitch shifter: mode 0 = period-synchronous splice (lowest latency, formants follow pitch)
 *                        mode 1 = TD-PSOLA (formant preserving, independent formant shift)
 *      -> 2nd voice (double / octave / harmony) -> dry/wet
 *      -> compressor -> saturation -> delay -> stereo reverb -> limiter / howl guard -> out
 */

const TWO_PI = 2 * Math.PI;

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  _set(b0, b1, b2, a0, a1, a2) { this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; }
  hp(fc, fs, q) { const w = TWO_PI * fc / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q); this._set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al); }
  lp(fc, fs, q) { const w = TWO_PI * fc / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q); this._set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al); }
  run(x) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
}

function lcosh(z) { const a = Math.abs(z); return a + Math.log1p(Math.exp(-2 * a)) - Math.LN2; } // log(cosh z), overflow-safe
function lin(buf, mask, pos) {
  const i = Math.floor(pos), fr = pos - i;
  const a = buf[i & mask];
  return a + (buf[(i + 1) & mask] - a) * fr;
}
function herm(buf, mask, pos) {
  const i = Math.floor(pos), t = pos - i;
  const xm = buf[(i - 1) & mask], x0 = buf[i & mask], x1 = buf[(i + 1) & mask], x2 = buf[(i + 2) & mask];
  const c1 = 0.5 * (x1 - xm), c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
  return ((c3 * t + c2) * t + c1) * t + x0;
}

/* Mode 0: resampling read head inside a delay line; when the head drifts out of its
 * window it jumps by exactly one detected period and crossfades, so the splice is
 * waveform-aligned. Latency = dMin .. dMin+T (+fade). Formants scale with the ratio. */
class SpliceVoice {
  constructor(fs) {
    this.dMin = Math.round(96 * fs / 48000);
    this.F = Math.round(64 * fs / 48000);
    this.rp = 0; this.rpOld = 0; this.fpos = -1; this.delay = 0;
  }
  reset(n) { this.rp = n - this.dMin - 100; this.fpos = -1; }
  step(n, ratio, T, x, mask) {
    this.rp += ratio;
    const d = n - this.rp;
    if (this.fpos < 0) {
      if (d < this.dMin) { this.rpOld = this.rp; this.rp -= T; this.fpos = 0; }
      else if (d > this.dMin + T + this.F) { this.rpOld = this.rp; this.rp += T; this.fpos = 0; }
    }
    let y = herm(x, mask, this.rp);
    if (this.fpos >= 0) {
      this.rpOld += ratio;
      const g = (this.fpos + 0.5) / this.F;
      y = y * g + herm(x, mask, this.rpOld) * (1 - g);
      if (++this.fpos >= this.F) this.fpos = -1;
    }
    this.delay = n - this.rp;
    return y;
  }
}

/* Mode 1: real-time TD-PSOLA. Grains of length 2H (Hann) taken around analysis marks
 * spaced by the detected period T, overlap-added at synthesis marks spaced T/ratio.
 * Formant factor f resamples each grain (f>1 raises formants). */
class PsolaVoice {
  constructor(N, fs) {
    this.N = N; this.mask = N - 1;
    this.acc = new Float32Array(N); this.w = new Float32Array(N);
    this.sNext = 0; this.lat = 0; this.maxH = Math.round(fs / 40);
  }
  reset(n, T) { this.acc.fill(0); this.w.fill(0); this.sNext = n + T; }
  place(n, ratio, T, f, markPos, x, xmask) {
    const S = T / ratio;
    let H = Math.max(T, S); if (H > this.maxH) H = this.maxH;
    const Hi = Math.max(8, Math.round(H));
    const start = Math.round(this.sNext - Hi);
    const reach = Hi * f + 3;
    let src = markPos;
    while (src + reach > n) src -= T;
    this.lat = this.sNext - src;
    const acc = this.acc, w = this.w, m = this.mask, L = 2 * Hi, k = Math.PI / Hi;
    for (let j = 0; j < L; j++) {
      const o = start + j;
      if (o < n) continue;
      const win = 0.5 - 0.5 * Math.cos(k * (j + 0.5));
      const idx = o & m;
      acc[idx] += win * lin(x, xmask, src + (j + 0.5 - Hi) * f);
      w[idx] += win;
    }
    this.sNext += S;
    return Hi;
  }
  step(n, ratio, T, f, markPos, x, xmask) {
    const S = T / ratio;
    const Hi = Math.round(Math.min(Math.max(T, S), this.maxH));
    let guard = 0;
    while (this.sNext - Hi <= n && guard++ < 8) this.place(n, ratio, T, f, markPos, x, xmask);
    if (this.sNext < n - this.maxH) this.sNext = n + 1; // resync after a stall
    const i = n & this.mask;
    const ww = this.w[i];
    const y = this.acc[i] / (ww > 0.5 ? ww : 0.5);
    this.acc[i] = 0; this.w[i] = 0;
    return y;
  }
}

class Comb {
  constructor(len) { this.buf = new Float32Array(len); this.i = 0; this.fs = 0; this.g = 0.8; this.d = 0.3; }
  run(x) {
    const o = this.buf[this.i];
    this.fs = o * (1 - this.d) + this.fs * this.d;
    this.buf[this.i] = x + this.fs * this.g;
    if (++this.i >= this.buf.length) this.i = 0;
    return o;
  }
}
class Allpass {
  constructor(len) { this.buf = new Float32Array(len); this.i = 0; }
  run(x) {
    const b = this.buf[this.i];
    this.buf[this.i] = x + b * 0.5;
    if (++this.i >= this.buf.length) this.i = 0;
    return b - x;
  }
}

const DEFAULT_PARAMS = {
  bypass: false,
  inGainDb: 0, hpfHz: 90, gateDb: -55,
  minF0: 70, maxF0: 900, yinThresh: 0.15,
  mask: [1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1], // absolute pitch classes C..B
  retuneMs: 20, humanize: 0, flex: 0, vibrato: 0, transpose: 0,
  mode: 0, formant: 0,
  v2Level: 0, v2Interval: 0, v2Detune: 0,
  mix: 1,
  compThr: -18, compRatio: 3, compAtk: 5, compRel: 80, compMakeup: 3,
  satDrive: 0, satMix: 0,
  dlyMs: 375, dlyFb: 0.25, dlyMix: 0, dlyDamp: 0.4,
  revTime: 1.2, revDamp: 0.5, revPre: 15, revMix: 0,
  outDb: 0, howlGuard: true, speaker: 0,
};

class AutoTuneEngine {
  constructor(fs) {
    this.fs = fs;
    const N = 1 << 15; this.N = N; this.mask = N - 1;
    this.x = new Float32Array(N);
    this.n = 0;
    // detection (decimated)
    this.dec = fs >= 88000 ? 8 : fs >= 40000 ? 4 : 2;
    this.dfs = fs / this.dec;
    this.lp1 = new Biquad(); this.lp2 = new Biquad();
    const lpc = Math.min(2600, 0.42 * this.dfs);
    this.lp1.lp(lpc, fs, 0.54); this.lp2.lp(lpc, fs, 1.31);
    this.dN = 4096; this.dmask = this.dN - 1; this.dx = new Float32Array(this.dN); this.dn = 0; this.decPh = 0;
    this.tauMaxAbs = Math.ceil(this.dfs / 45) + 2;
    this.Wd = Math.round(0.016 * this.dfs);
    this.frame = new Float32Array(this.Wd + this.tauMaxAbs + 4);
    this.cm = new Float64Array(this.tauMaxAbs + 4);
    this.hop = Math.round(256 * fs / 48000);
    this.hopCnt = 0;
    this.Wf = Math.round(0.012 * fs);
    // pitch state
    this.f0 = 0; this.conf = 0; this.voiced = false; this.vOn = 0; this.vOff = 0; this.rms = 0;
    this.T = fs / 200; this.Tdef = Math.round(0.006 * fs);
    this.inMidi = 0; this.inSmooth = 0; this.targetMidi = -1; this.held = 0; this.corr = 0; this.semis = 0;
    this.ratio = 1; this.ratioInc = 0; this.r2 = 1; this.r2Inc = 0; this.rampLeft = 0;
    this.octHold = 0; this.markPos = 0;
    // voices
    this.s1 = new SpliceVoice(fs); this.s2 = new SpliceVoice(fs); this.s2.dMin += Math.round(0.006 * fs);
    this.p1 = new PsolaVoice(N, fs); this.p2 = new PsolaVoice(N, fs);
    this.latency = 0; this.dryD = 0;
    // input conditioning
    this.hpf = new Biquad(); this.gEnv = 0; this.gGain = 0; this.gOpen = false; this.gHold = 0;
    this.inPk = 0; this.outPk = 0;
    // comp
    this.cEnv = 0; this.cGr = 0; this.satX1 = 0;
    // delay
    this.dly = new Float32Array(Math.ceil(fs * 2.1)); this.dI = 0; this.dLp = 0;
    // reverb
    const sc = fs / 44100, sp = Math.round(23 * sc);
    const cl = [1116, 1188, 1277, 1356], al = [556, 441];
    this.cL = cl.map(v => new Comb(Math.round(v * sc))); this.cR = cl.map(v => new Comb(Math.round(v * sc) + sp));
    this.aL = al.map(v => new Allpass(Math.round(v * sc))); this.aR = al.map(v => new Allpass(Math.round(v * sc) + sp));
    this.pre = new Float32Array(Math.ceil(fs * 0.25)); this.preI = 0;
    // limiter / howl guard
    this.LA = Math.round(0.001 * fs); this.laL = new Float32Array(this.LA + 1); this.laR = new Float32Array(this.LA + 1); this.laI = 0;
    this.limG = 1; this.limHold = 1; this.limHT = 0;
    this.limAtk = 1 - Math.exp(-1 / (this.LA / 4)); this.limRel = 1 - Math.exp(-1 / (fs * 0.08));
    this.stabRef = 0; this.stabT = 0;
    this.howlEnv = 0; this.howlT = 0; this.duck = 1; this.duckT = 0; this.howl = false;
    // loopback measurement
    this.meas = { state: 0, t: 0, noise: 0, start: 0, result: -1, tries: 0, r: new Float64Array(5), env: 0 };
    this.measDone = false; this.measMs = -1;
    this.p = Object.assign({}, DEFAULT_PARAMS);
    this.mask12 = new Int8Array(12);
    this.setParams(this.p);
    this.s1.reset(0); this.s2.reset(0);
  }

  setParams(q) {
    const p = this.p, fs = this.fs;
    for (const k in q) if (k in p) p[k] = q[k];
    for (let i = 0; i < 12; i++) this.mask12[i] = p.mask[i] ? 1 : 0;
    let any = 0; for (let i = 0; i < 12; i++) any += this.mask12[i];
    if (!any) this.mask12.fill(1);
    this.inGain = Math.pow(10, p.inGainDb / 20);
    this.hpf.hp(Math.max(20, p.hpfHz), fs, 0.707);
    this.gateThr = Math.pow(10, p.gateDb / 20);
    this.tauMinD = Math.max(2, Math.floor(this.dfs / Math.min(p.maxF0, this.dfs / 3)));
    this.tauMaxD = Math.min(this.tauMaxAbs - 2, Math.ceil(this.dfs / Math.max(45, p.minF0)));
    this.fmt = Math.pow(2, p.formant / 12);
    this.cAtk = Math.exp(-1 / (fs * Math.max(0.1, p.compAtk) / 1000));
    this.cRel = Math.exp(-1 / (fs * Math.max(5, p.compRel) / 1000));
    this.cMake = Math.pow(10, p.compMakeup / 20);
    const g = Math.pow(10, p.satDrive / 20); this.satG = g; this.satK = 0.5 / Math.tanh(0.5 * g);
    this.dlyN = Math.max(1, Math.min(this.dly.length - 2, Math.round(p.dlyMs * fs / 1000)));
    this.dlyDampC = Math.min(0.95, Math.max(0, p.dlyDamp));
    const rt = Math.max(0.1, p.revTime);
    const setC = (c) => { c.g = Math.pow(10, -3 * c.buf.length / (fs * rt)); c.d = Math.min(0.9, Math.max(0, p.revDamp)) * 0.7; };
    this.cL.forEach(setC); this.cR.forEach(setC);
    this.preN = Math.max(1, Math.min(this.pre.length - 1, Math.round(p.revPre * fs / 1000)));
    this.outG = Math.pow(10, p.outDb / 20);
    if (p.mode !== this._mode) {
      this._mode = p.mode;
      this.s1.reset(this.n); this.s2.reset(this.n); this.p1.reset(this.n, this.T); this.p2.reset(this.n, this.T);
    }
  }

  nearest(m) {
    const c = Math.round(m);
    let best = c, bd = 1e9;
    for (let k = c - 7; k <= c + 7; k++) {
      if (!this.mask12[((k % 12) + 12) % 12]) continue;
      const d = Math.abs(m - k);
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }

  detect() {
    const W = this.Wd, tmax = this.tauMaxD, tmin = this.tauMinD;
    const len = W + tmax + 2;
    if (this.dn < len + 2) return 0;
    const fr = this.frame, dx = this.dx, dm = this.dmask, base = this.dn - len;
    let e = 0;
    for (let j = 0; j < len; j++) { const v = dx[(base + j) & dm]; fr[j] = v; }
    for (let j = len - W; j < len; j++) e += fr[j] * fr[j];
    this.rms = Math.sqrt(e / W);
    if (!this.gOpen || this.rms < 1e-4) return 0;
    const cm = this.cm; let run = 0; cm[0] = 1;
    for (let tau = 1; tau <= tmax + 1; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) { const d = fr[j] - fr[j + tau]; s += d * d; }
      run += s; cm[tau] = run > 0 ? s * tau / run : 1;
    }
    let t = -1;
    const thr = this.p.yinThresh;
    for (let tau = tmin; tau < tmax; tau++) {
      if (cm[tau] < thr) { while (tau + 1 < tmax && cm[tau + 1] < cm[tau]) tau++; t = tau; break; }
    }
    if (t < 0) {
      let mi = 1e9;
      for (let tau = tmin; tau < tmax; tau++) if (cm[tau] < mi) { mi = cm[tau]; t = tau; }
      if (mi > 0.35) return 0;
    }
    if (t < 1) return 0;
    const a = cm[t - 1], b = cm[t], c = cm[t + 1], den = a + c - 2 * b;
    let dl = den !== 0 ? 0.5 * (a - c) / den : 0; if (dl > 1) dl = 1; if (dl < -1) dl = -1;
    this.conf = 1 - b;
    // full-rate refinement around dec * tau
    const tf = (t + dl) * this.dec, x = this.x, m = this.mask, Wf = this.Wf;
    const lo = Math.max(2, Math.floor(tf - this.dec - 1)), hi = Math.ceil(tf + this.dec + 1);
    const st = this.n - Wf - hi - 1;
    let bt = lo, bv = 1e18, pv = 0, nv = 0, prev = 0;
    for (let tau = lo; tau <= hi + 1; tau++) {
      let s = 0;
      for (let j = 0; j < Wf; j++) { const d = x[(st + j) & m] - x[(st + j + tau) & m]; s += d * d; }
      if (tau <= hi && s < bv) { bv = s; bt = tau; pv = prev; }
      if (tau === bt + 1) nv = s;
      prev = s;
    }
    let tFull = bt;
    if (bt > lo && bt < hi) { const dd = pv + nv - 2 * bv; if (dd > 0) { let o = 0.5 * (pv - nv) / dd; if (o > 1) o = 1; if (o < -1) o = -1; tFull = bt + o; } }
    return this.fs / tFull;
  }

  control() {
    const p = this.p, dt = this.hop / this.fs;
    let f = this.detect();
    // octave-jump guard
    if (f > 0 && this.voiced && this.f0 > 0) {
      const r = f / this.f0;
      if ((Math.abs(r - 2) < 0.12 || Math.abs(r - 0.5) < 0.06) && this.octHold < 2) { this.octHold++; f = this.f0; }
      else this.octHold = 0;
    }
    if (f > 0) { this.vOn++; this.vOff = 0; } else { this.vOff++; this.vOn = 0; }
    const wasVoiced = this.voiced;
    if (!this.voiced && this.vOn >= 2) this.voiced = true;
    if (this.voiced && this.vOff >= 3) { this.voiced = false; this.targetMidi = -1; }
    if (f > 0) this.f0 = f;
    if (this.voiced && this.f0 > 0) {
      this.T = this.fs / this.f0;
      const im = 69 + 12 * Math.log2(this.f0 / 440);
      if (!wasVoiced) this.inSmooth = im;
      this.inMidi = im;
      this.inSmooth += (im - this.inSmooth) * (1 - Math.exp(-dt / 0.12));
      const vib = im - this.inSmooth;
      const cand = this.nearest(im);
      if (this.targetMidi < 0 || !this.mask12[((this.targetMidi % 12) + 12) % 12]) { this.targetMidi = cand; this.held = 0; }
      else if (cand !== this.targetMidi && Math.abs(im - cand) + 0.12 < Math.abs(im - this.targetMidi)) { this.targetMidi = cand; this.held = 0; }
      else this.held += dt;
      const dev = this.targetMidi - im;
      let wgt = 1;
      if (p.flex > 0) {
        const z = 0.6 - 0.5 * (p.flex / 100), z0 = z * 0.5, ad = Math.abs(dev);
        wgt = ad <= z0 ? 1 : ad >= z ? 0 : 1 - (ad - z0) / (z - z0);
      }
      const ct = dev * wgt;
      let hs = (this.held - 0.08) / 0.27; hs = hs < 0 ? 0 : hs > 1 ? 1 : hs;
      const ret = p.retuneMs + (p.humanize / 100) * 300 * hs;
      const alpha = ret <= 0.5 ? 1 : 1 - Math.exp(-dt / (ret / 1000 / 2.3));
      this.corr += (ct - this.corr) * alpha;
      this.semis = this.corr + (p.vibrato / 100) * vib + p.transpose;
      // speaker mode: acoustic feedback is far steadier in pitch than any voice (humans drift > 3 cents)
      if (p.speaker) {
        if (Math.abs(im - this.stabRef) < 0.03) this.stabT += dt; else { this.stabRef = im; this.stabT = 0; }
        if (this.stabT > 1.2 && this.conf > 0.9) { this.duckT = this.fs * 1.5; this.howl = true; this.stabT = 0; }
      }
    } else {
      this.corr *= Math.exp(-dt / 0.03);
      this.semis = this.corr + p.transpose;
      if (this.vOff > 10) this.T += (this.Tdef - this.T) * 0.2;
    }
    let r = Math.pow(2, this.semis / 12); r = r < 0.5 ? 0.5 : r > 2 ? 2 : r;
    let r2 = r * Math.pow(2, (p.v2Interval + p.v2Detune / 100) / 12); r2 = r2 < 0.45 ? 0.45 : r2 > 2 ? 2 : r2;
    this.ratioInc = (r - this.ratio) / this.hop; this.r2Inc = (r2 - this.r2) / this.hop; this.rampLeft = this.hop;
  }

  measureStart() { const M = this.meas; M.state = 1; M.t = 0; M.noise = 0; M.tries = 0; M.result = -1; this.measDone = false; this.measMs = -1; }

  _measure(raw) {
    // returns sample to emit; state 1 = noise floor, 2 = click+listen, 3 = gap
    const M = this.meas, fs = this.fs, a = Math.abs(raw);
    M.t++;
    if (M.state === 1) { if (a > M.noise) M.noise = a; if (M.t > fs * 0.3) { M.state = 2; M.t = 0; M.start = this.n; } return 0; }
    if (M.state === 2) {
      const ct = M.t - 1, cl = Math.round(fs * 0.003);
      let y = 0;
      if (ct < cl) y = 0.8 * Math.sin(Math.PI * ct / cl) * Math.sin(TWO_PI * 2000 * ct / fs);
      const thr = Math.max(M.noise * 6, 0.02);
      if (ct > 2 && a > thr) { M.r[M.tries++] = this.n - M.start; M.state = 3; M.t = 0; }
      else if (ct > fs * 0.8) { M.state = 0; M.result = -2; this.measDone = true; this.measMs = -2; }
      return y;
    }
    if (M.state === 3) {
      if (M.t > fs * 0.35) {
        if (M.tries >= 3) {
          const r = M.r, a0 = r[0], a1 = r[1], a2 = r[2];
          M.result = Math.max(Math.min(a0, a1), Math.min(Math.max(a0, a1), a2)); // median of 3, no allocation
          M.state = 0; this.measDone = true; this.measMs = M.result * 1000 / fs;
        } else { M.state = 2; M.t = 0; M.start = this.n + 1; }
      }
      return 0;
    }
    return 0;
  }

  process(inp, outL, outR, len) {
    const p = this.p, fs = this.fs, x = this.x, m = this.mask;
    const gAt = Math.exp(-1 / (fs * 0.002)), gRe = Math.exp(-1 / (fs * 0.15));
    for (let i = 0; i < len; i++) {
      const raw = inp ? inp[i] : 0;
      this.n++;
      const n = this.n;
      if (this.meas.state) {
        x[n & m] = 0;
        const y = this._measure(raw);
        outL[i] = y; outR[i] = y; continue;
      }
      let s = this.hpf.run(raw * this.inGain);
      const a = Math.abs(s);
      if (a > this.inPk) this.inPk = a;
      this.gEnv = a > this.gEnv ? a : this.gEnv * 0.9995;
      if (this.gEnv > this.gateThr * 2) { this.gOpen = true; this.gHold = fs * 0.2; } // 6 dB hysteresis, 200 ms hold
      else if (this.gEnv < this.gateThr) { if (this.gHold > 0) this.gHold--; else this.gOpen = false; }
      const gt = this.gOpen ? 1 : 0;
      this.gGain = gt > this.gGain ? gt + (this.gGain - gt) * gAt : gt + (this.gGain - gt) * gRe;
      s *= this.gGain;
      x[n & m] = s;
      const ls = this.lp2.run(this.lp1.run(s));
      if (++this.decPh >= this.dec) { this.decPh = 0; this.dx[this.dn & this.dmask] = ls; this.dn++; }
      if (++this.hopCnt >= this.hop) { this.hopCnt = 0; this.control(); }
      if (this.rampLeft > 0) { this.ratio += this.ratioInc; this.r2 += this.r2Inc; this.rampLeft--; }
      const T = this.T;
      while (this.markPos + T <= n) this.markPos += T;
      if (n - this.markPos > 4096) this.markPos = n;

      let y;
      if (p.bypass) { y = s; this.latency = 0; }
      else {
        let w1, w2 = 0;
        if (p.mode === 0) {
          w1 = this.s1.step(n, this.ratio, T, x, m);
          if (p.v2Level > 0) w2 = this.s2.step(n, this.r2, T, x, m);
          this.latency = this.s1.delay;
        } else {
          w1 = this.p1.step(n, this.ratio, T, this.fmt, this.markPos, x, m);
          if (p.v2Level > 0) w2 = this.p2.step(n, this.r2, T, this.fmt, this.markPos, x, m);
          this.latency = this.p1.lat;
        }
        this.dryD += (this.latency - this.dryD) * 0.002;
        const dry = lin(x, m, n - Math.max(1, this.dryD));
        y = dry * (1 - p.mix) + (w1 + p.v2Level * w2) * p.mix;
      }
      // compressor (soft knee 6 dB)
      if (p.compRatio > 1.01) {
        const ay = Math.abs(y);
        this.cEnv = ay > this.cEnv ? ay + (this.cEnv - ay) * this.cAtk : ay + (this.cEnv - ay) * this.cRel;
        const lvl = 20 * Math.log10(this.cEnv + 1e-9), over = lvl - p.compThr;
        let gr = 0;
        if (over > 3) gr = over * (1 - 1 / p.compRatio);
        else if (over > -3) { const o = over + 3; gr = (1 - 1 / p.compRatio) * o * o / 12; }
        y *= Math.pow(10, -gr / 20) * this.cMake;
      }
      if (p.satMix > 0) {
        // ADAA1: y = (F(x) - F(x1)) / (x - x1), F = antiderivative of k*tanh(g x) → far less aliasing ("fizz")
        const g = this.satG, k = this.satK, x1 = this.satX1, dxs = y - x1;
        let ws;
        if (Math.abs(dxs) > 1e-5) ws = k * (lcosh(g * y) - lcosh(g * x1)) / (g * dxs);
        else ws = k * Math.tanh(g * 0.5 * (y + x1));
        this.satX1 = y;
        y += p.satMix * (ws - y);
      }
      // delay
      if (p.dlyMix > 0) {
        const L = this.dly.length;
        let ri = this.dI - this.dlyN; if (ri < 0) ri += L;
        const dv = this.dly[ri];
        this.dLp = dv + (this.dLp - dv) * this.dlyDampC;
        this.dly[this.dI] = y + this.dLp * p.dlyFb;
        if (++this.dI >= L) this.dI = 0;
        y += dv * p.dlyMix;
      }
      // reverb
      let yl = y, yr = y;
      if (p.revMix > 0) {
        const PL = this.pre.length;
        this.pre[this.preI] = y;
        let pi = this.preI - this.preN; if (pi < 0) pi += PL;
        if (++this.preI >= PL) this.preI = 0;
        const rin = this.pre[pi] * 0.17; // calibrated: revMix 1.0 ~ wet at dry level (0 dB)
        let l = 0, r = 0;
        for (let k = 0; k < 4; k++) { l += this.cL[k].run(rin); r += this.cR[k].run(rin); }
        for (let k = 0; k < 2; k++) { l = this.aL[k].run(l); r = this.aR[k].run(r); }
        yl = y + l * p.revMix; yr = y + r * p.revMix;
      }
      // howl guard + limiter
      const g = this.outG;
      yl *= g; yr *= g;
      const pk = Math.max(Math.abs(yl), Math.abs(yr));
      if (pk > this.outPk) this.outPk = pk;
      if (p.howlGuard) {
        this.howlEnv += (pk - this.howlEnv) * 0.0005;
        if (this.howlEnv > 0.6) { if (++this.howlT > fs * 0.6) { this.duckT = fs * 2; this.howl = true; this.howlT = 0; } }
        else this.howlT = 0;
        if (this.duckT > 0) { this.duckT--; this.duck += (0.06 - this.duck) * 0.01; }
        else { this.duck += (1 - this.duck) * 0.0005; this.howl = false; }
        yl *= this.duck; yr *= this.duck;
      }
      // look-ahead peak limiter: gain reaches its target before the delayed peak arrives
      const mx = Math.max(Math.abs(yl), Math.abs(yr)), lgt = mx > 0.89 ? 0.89 / mx : 1;
      if (lgt <= this.limHold) { this.limHold = lgt; this.limHT = 4 * this.LA; } // hold 4 ms > look-ahead: no period-2 limit cycle
      else if (this.limHT > 0) this.limHT--;
      else this.limHold = lgt;
      this.limG += (this.limHold - this.limG) * (this.limHold < this.limG ? this.limAtk : this.limRel);
      const LA1 = this.LA + 1, ri = (this.laI + 1) % LA1;
      this.laL[this.laI] = yl; this.laR[this.laI] = yr; this.laI = ri;
      let ol = this.laL[ri] * this.limG, or = this.laR[ri] * this.limG;
      if (ol > 0.95 || ol < -0.95) ol = Math.sign(ol) * (0.95 + 0.05 * Math.tanh((Math.abs(ol) - 0.95) / 0.05));
      if (or > 0.95 || or < -0.95) or = Math.sign(or) * (0.95 + 0.05 * Math.tanh((Math.abs(or) - 0.95) / 0.05));
      outL[i] = ol; outR[i] = or;
    }
  }

  telemetry(t) { // t: Float32Array(12), filled in place
    t[0] = this.inPk; t[1] = this.outPk; this.inPk = 0; this.outPk = 0;
    t[2] = this.voiced ? this.f0 : 0; t[3] = this.conf;
    t[4] = this.voiced ? this.inMidi : -1; t[5] = this.voiced ? this.targetMidi : -1;
    t[6] = this.voiced ? (this.semis - this.p.transpose) * 100 : 0;
    t[7] = (this.latency + this.LA) * 1000 / this.fs; t[8] = this.gOpen ? 1 : 0; t[9] = this.howl ? 1 : 0;
    t[10] = this.measMs; // latched: -1 none, -2 failed, else ms
    t[11] = this.meas.state;
  }
}

if (typeof module !== 'undefined') module.exports = { AutoTuneEngine, DEFAULT_PARAMS };
