// CanlıTune — native DSP core (C++17, header-only).
// Line-for-line port of web/dsp-core.js so web and native sound identical.
// Real-time rule: process() never allocates, locks or blocks. All memory is
// allocated in the constructor. Parameters arrive through applyParam(), which the
// bridge calls from the audio thread after draining a lock-free queue.
#pragma once
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>
#include <algorithm>

namespace canlitune {

static constexpr double kPi = 3.14159265358979323846;
static constexpr double kTwoPi = 2.0 * kPi;

struct Biquad {
  double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;
  void set(double B0, double B1, double B2, double A0, double A1, double A2) { b0 = B0 / A0; b1 = B1 / A0; b2 = B2 / A0; a1 = A1 / A0; a2 = A2 / A0; }
  void hp(double fc, double fs, double q) { double w = kTwoPi * fc / fs, c = std::cos(w), al = std::sin(w) / (2 * q); set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al); }
  void lp(double fc, double fs, double q) { double w = kTwoPi * fc / fs, c = std::cos(w), al = std::sin(w) / (2 * q); set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al); }
  inline double run(double x) { double y = b0 * x + z1; z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y; return y; }
};

static inline double lcosh(double z) { double a = std::fabs(z); return a + std::log1p(std::exp(-2 * a)) - 0.69314718055994530942; }
static inline double lin(const float* buf, int64_t mask, double pos) {
  double fl = std::floor(pos); int64_t i = (int64_t)fl; double fr = pos - fl;
  double a = buf[i & mask];
  return a + (buf[(i + 1) & mask] - a) * fr;
}
static inline double herm(const float* buf, int64_t mask, double pos) {
  double fl = std::floor(pos); int64_t i = (int64_t)fl; double t = pos - fl;
  double xm = buf[(i - 1) & mask], x0 = buf[i & mask], x1 = buf[(i + 1) & mask], x2 = buf[(i + 2) & mask];
  double c1 = 0.5 * (x1 - xm), c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
  return ((c3 * t + c2) * t + c1) * t + x0;
}

// Mode 0: period-synchronous splice (lowest latency; formants follow pitch)
struct SpliceVoice {
  double dMin, F, rp = 0, rpOld = 0, delay = 0; int fpos = -1;
  explicit SpliceVoice(double fs) : dMin(std::round(96 * fs / 48000)), F(std::round(64 * fs / 48000)) {}
  void reset(int64_t n) { rp = (double)n - dMin - 100; fpos = -1; }
  inline double step(int64_t n, double ratio, double T, const float* x, int64_t mask) {
    rp += ratio;
    double d = (double)n - rp;
    if (fpos < 0) {
      if (d < dMin) { rpOld = rp; rp -= T; fpos = 0; }
      else if (d > dMin + T + F) { rpOld = rp; rp += T; fpos = 0; }
    }
    double y = herm(x, mask, rp);
    if (fpos >= 0) {
      rpOld += ratio;
      double g = (fpos + 0.5) / F;
      y = y * g + herm(x, mask, rpOld) * (1 - g);
      if (++fpos >= F) fpos = -1;
    }
    delay = (double)n - rp;
    return y;
  }
};

// Mode 1: real-time TD-PSOLA with grain resampling for formant shift
struct PsolaVoice {
  int64_t N, mask; std::vector<float> acc, w; double sNext = 0, lat = 0, maxH;
  PsolaVoice(int64_t n, double fs) : N(n), mask(n - 1), acc((size_t)n, 0.f), w((size_t)n, 0.f), maxH(std::round(fs / 40)) {}
  void reset(int64_t n, double T) { std::fill(acc.begin(), acc.end(), 0.f); std::fill(w.begin(), w.end(), 0.f); sNext = (double)n + T; }
  void place(int64_t n, double ratio, double T, double f, double markPos, const float* x, int64_t xmask) {
    double S = T / ratio, H = std::max(T, S); if (H > maxH) H = maxH;
    int64_t Hi = std::max<int64_t>(8, (int64_t)std::llround(H));
    int64_t start = (int64_t)std::llround(sNext - (double)Hi);
    double reach = (double)Hi * f + 3, src = markPos;
    while (src + reach > (double)n) src -= T;
    lat = sNext - src;
    int64_t L = 2 * Hi; double k = kPi / (double)Hi;
    for (int64_t j = 0; j < L; j++) {
      int64_t o = start + j;
      if (o < n) continue;
      double win = 0.5 - 0.5 * std::cos(k * ((double)j + 0.5));
      int64_t idx = o & mask;
      acc[(size_t)idx] += (float)(win * lin(x, xmask, src + ((double)j + 0.5 - (double)Hi) * f));
      w[(size_t)idx] += (float)win;
    }
    sNext += S;
  }
  inline double step(int64_t n, double ratio, double T, double f, double markPos, const float* x, int64_t xmask) {
    double S = T / ratio;
    double Hi = std::round(std::min(std::max(T, S), maxH));
    int guard = 0;
    while (sNext - Hi <= (double)n && guard++ < 8) place(n, ratio, T, f, markPos, x, xmask);
    if (sNext < (double)n - maxH) sNext = (double)(n + 1);
    size_t i = (size_t)(n & mask);
    double ww = w[i];
    double y = acc[i] / (ww > 0.5 ? ww : 0.5);
    acc[i] = 0; w[i] = 0;
    return y;
  }
};

struct Comb {
  std::vector<float> buf; size_t i = 0; double fs = 0, g = 0.8, d = 0.3;
  explicit Comb(size_t len) : buf(len, 0.f) {}
  inline double run(double x) { double o = buf[i]; fs = o * (1 - d) + fs * d; buf[i] = (float)(x + fs * g); if (++i >= buf.size()) i = 0; return o; }
};
struct Allpass {
  std::vector<float> buf; size_t i = 0;
  explicit Allpass(size_t len) : buf(len, 0.f) {}
  inline double run(double x) { double b = buf[i]; buf[i] = (float)(x + b * 0.5); if (++i >= buf.size()) i = 0; return b - x; }
};

enum ParamId : int {
  P_BYPASS = 0, P_INGAIN, P_HPF, P_GATE, P_MINF0, P_MAXF0, P_YINTHRESH, P_MASKBITS,
  P_RETUNE, P_HUMANIZE, P_FLEX, P_VIBRATO, P_TRANSPOSE, P_MODE, P_FORMANT,
  P_V2LEVEL, P_V2INTERVAL, P_V2DETUNE, P_MIX,
  P_COMPTHR, P_COMPRATIO, P_COMPATK, P_COMPREL, P_COMPMAKEUP,
  P_SATDRIVE, P_SATMIX, P_DLYMS, P_DLYFB, P_DLYMIX, P_DLYDAMP,
  P_REVTIME, P_REVDAMP, P_REVPRE, P_REVMIX, P_OUTDB, P_HOWLGUARD, P_COUNT
};
// Same names as the JS params object (used by bridges to map JSON keys -> ids)
static const char* const kParamNames[P_COUNT] = {
  "bypass", "inGainDb", "hpfHz", "gateDb", "minF0", "maxF0", "yinThresh", "maskBits",
  "retuneMs", "humanize", "flex", "vibrato", "transpose", "mode", "formant",
  "v2Level", "v2Interval", "v2Detune", "mix",
  "compThr", "compRatio", "compAtk", "compRel", "compMakeup",
  "satDrive", "satMix", "dlyMs", "dlyFb", "dlyMix", "dlyDamp",
  "revTime", "revDamp", "revPre", "revMix", "outDb", "howlGuard"
};
static inline int paramIdFromName(const char* s) { for (int i = 0; i < P_COUNT; i++) if (std::strcmp(s, kParamNames[i]) == 0) return i; return -1; }

class Engine {
 public:
  explicit Engine(double sampleRate)
      : fs(sampleRate), N(1 << 15), mask(N - 1), x((size_t)N, 0.f),
        s1(sampleRate), s2(sampleRate), p1(N, sampleRate), p2(N, sampleRate) {
    dec = fs >= 88000 ? 8 : fs >= 40000 ? 4 : 2;
    dfs = fs / dec;
    double lpc = std::min(2600.0, 0.42 * dfs);
    lp1.lp(lpc, fs, 0.54); lp2.lp(lpc, fs, 1.31);
    dN = 4096; dmask = dN - 1; dx.assign((size_t)dN, 0.f);
    tauMaxAbs = (int)std::ceil(dfs / 45) + 2;
    Wd = (int)std::round(0.016 * dfs);
    frame.assign((size_t)(Wd + tauMaxAbs + 4), 0.f);
    cm.assign((size_t)(tauMaxAbs + 4), 0.0);
    hop = (int)std::round(256 * fs / 48000);
    Wf = (int)std::round(0.012 * fs);
    T = fs / 200; Tdef = std::round(0.006 * fs);
    s2.dMin += std::round(0.006 * fs);
    dly.assign((size_t)std::ceil(fs * 2.1), 0.f);
    double sc = fs / 44100; size_t sp = (size_t)std::round(23 * sc);
    const int cl[4] = {1116, 1188, 1277, 1356}, al[2] = {556, 441};
    for (int k = 0; k < 4; k++) { cL.emplace_back((size_t)std::round(cl[k] * sc)); cR.emplace_back((size_t)std::round(cl[k] * sc) + sp); }
    for (int k = 0; k < 2; k++) { aL.emplace_back((size_t)std::round(al[k] * sc)); aR.emplace_back((size_t)std::round(al[k] * sc) + sp); }
    pre.assign((size_t)std::ceil(fs * 0.25), 0.f);
    LA = (int)std::round(0.001 * fs); laL.assign((size_t)LA + 1, 0.f); laR.assign((size_t)LA + 1, 0.f);
    limAtk = 1 - std::exp(-1 / (LA / 4.0)); limRel = 1 - std::exp(-1 / (fs * 0.08));
    defaults();
    recompute();
    s1.reset(0); s2.reset(0);
  }

  // ---- parameters (call between process() calls, on the audio thread) ----
  void applyParam(int id, double v) {
    switch (id) {
      case P_BYPASS: bypass = v != 0; break; case P_INGAIN: inGainDb = v; break; case P_HPF: hpfHz = v; break;
      case P_GATE: gateDb = v; break; case P_MINF0: minF0 = v; break; case P_MAXF0: maxF0 = v; break;
      case P_YINTHRESH: yinThresh = v; break;
      case P_MASKBITS: { int b = (int)v; for (int i = 0; i < 12; i++) mask12[i] = (b >> i) & 1; break; }
      case P_RETUNE: retuneMs = v; break; case P_HUMANIZE: humanize = v; break; case P_FLEX: flex = v; break;
      case P_VIBRATO: vibrato = v; break; case P_TRANSPOSE: transpose = v; break; case P_MODE: mode = (int)v; break;
      case P_FORMANT: formant = v; break; case P_V2LEVEL: v2Level = v; break; case P_V2INTERVAL: v2Interval = v; break;
      case P_V2DETUNE: v2Detune = v; break; case P_MIX: mix = v; break;
      case P_COMPTHR: compThr = v; break; case P_COMPRATIO: compRatio = v; break; case P_COMPATK: compAtk = v; break;
      case P_COMPREL: compRel = v; break; case P_COMPMAKEUP: compMakeup = v; break;
      case P_SATDRIVE: satDrive = v; break; case P_SATMIX: satMix = v; break;
      case P_DLYMS: dlyMs = v; break; case P_DLYFB: dlyFb = v; break; case P_DLYMIX: dlyMix = v; break; case P_DLYDAMP: dlyDamp = v; break;
      case P_REVTIME: revTime = v; break; case P_REVDAMP: revDamp = v; break; case P_REVPRE: revPre = v; break; case P_REVMIX: revMix = v; break;
      case P_OUTDB: outDb = v; break; case P_HOWLGUARD: howlGuard = v != 0; break;
      default: return;
    }
    dirty = true;
  }
  void commitParams() { if (dirty) { recompute(); dirty = false; } }

  void measureStart() { meas.state = 1; meas.t = 0; meas.noise = 0; meas.tries = 0; meas.result = -1; measMs = -1; }

  // t: float[12] — same layout as JS telemetry()
  void telemetry(float* t) {
    t[0] = (float)inPk; t[1] = (float)outPk; inPk = 0; outPk = 0;
    t[2] = voiced ? (float)f0 : 0.f; t[3] = (float)conf;
    t[4] = voiced ? (float)inMidi : -1.f; t[5] = voiced ? (float)targetMidi : -1.f;
    t[6] = voiced ? (float)((semis - transpose) * 100) : 0.f;
    t[7] = (float)((latency + LA) * 1000 / fs); t[8] = gOpen ? 1.f : 0.f; t[9] = howl ? 1.f : 0.f;
    t[10] = (float)measMs; t[11] = (float)meas.state;
  }

  void process(const float* inp, float* outL, float* outR, int len) {
    const double gAt = std::exp(-1 / (fs * 0.002)), gRe = std::exp(-1 / (fs * 0.15));
    float* xb = x.data();
    for (int i = 0; i < len; i++) {
      double raw = inp ? inp[i] : 0.0;
      n++;
      if (meas.state) {
        xb[n & mask] = 0;
        double y = measureStep(raw);
        outL[i] = (float)y; if (outR) outR[i] = (float)y; continue;
      }
      double s = hpf.run(raw * inGain);
      double a = std::fabs(s);
      if (a > inPk) inPk = a;
      gEnv = a > gEnv ? a : gEnv * 0.9995;
      if (gEnv > gateThr * 2) { gOpen = true; gHold = fs * 0.2; }
      else if (gEnv < gateThr) { if (gHold > 0) gHold--; else gOpen = false; }
      double gt = gOpen ? 1 : 0;
      gGain = gt > gGain ? gt + (gGain - gt) * gAt : gt + (gGain - gt) * gRe;
      s *= gGain;
      xb[n & mask] = (float)s;
      double ls = lp2.run(lp1.run(s));
      if (++decPh >= dec) { decPh = 0; dx[(size_t)(dn & dmask)] = (float)ls; dn++; }
      if (++hopCnt >= hop) { hopCnt = 0; control(); }
      if (rampLeft > 0) { ratio += ratioInc; r2 += r2Inc; rampLeft--; }
      double Tc = T;
      while (markPos + Tc <= (double)n) markPos += Tc;
      if ((double)n - markPos > 4096) markPos = (double)n;

      double y;
      if (bypass) { y = s; latency = 0; }
      else {
        double w1, w2 = 0;
        if (mode == 0) {
          w1 = s1.step(n, ratio, Tc, xb, mask);
          if (v2Level > 0) w2 = s2.step(n, r2, Tc, xb, mask);
          latency = s1.delay;
        } else {
          w1 = p1.step(n, ratio, Tc, fmt, markPos, xb, mask);
          if (v2Level > 0) w2 = p2.step(n, r2, Tc, fmt, markPos, xb, mask);
          latency = p1.lat;
        }
        dryD += (latency - dryD) * 0.002;
        double dry = lin(xb, mask, (double)n - std::max(1.0, dryD));
        y = dry * (1 - mix) + (w1 + v2Level * w2) * mix;
      }
      if (compRatio > 1.01) {
        double ay = std::fabs(y);
        cEnv = ay > cEnv ? ay + (cEnv - ay) * cAtk : ay + (cEnv - ay) * cRel;
        double lvl = 20 * std::log10(cEnv + 1e-9), over = lvl - compThr, gr = 0;
        if (over > 3) gr = over * (1 - 1 / compRatio);
        else if (over > -3) { double o = over + 3; gr = (1 - 1 / compRatio) * o * o / 12; }
        y *= std::pow(10.0, -gr / 20) * cMake;
      }
      if (satMix > 0) {  // ADAA1 tanh (anti-aliased)
        double g = satG, k = satK, x1 = satX1, dxs = y - x1, ws;
        if (std::fabs(dxs) > 1e-5) ws = k * (lcosh(g * y) - lcosh(g * x1)) / (g * dxs);
        else ws = k * std::tanh(g * 0.5 * (y + x1));
        satX1 = y;
        y += satMix * (ws - y);
      }
      if (dlyMix > 0) {
        size_t L = dly.size(); int64_t ri = (int64_t)dI - dlyN; if (ri < 0) ri += (int64_t)L;
        double dv = dly[(size_t)ri];
        dLp = dv + (dLp - dv) * dlyDampC;
        dly[dI] = (float)(y + dLp * dlyFb);
        if (++dI >= L) dI = 0;
        y += dv * dlyMix;
      }
      double yl = y, yr = y;
      if (revMix > 0) {
        size_t PL = pre.size();
        pre[preI] = (float)y;
        int64_t pi = (int64_t)preI - preN; if (pi < 0) pi += (int64_t)PL;
        if (++preI >= PL) preI = 0;
        double rin = pre[(size_t)pi] * 0.17;
        double l = 0, r = 0;
        for (int k = 0; k < 4; k++) { l += cL[k].run(rin); r += cR[k].run(rin); }
        for (int k = 0; k < 2; k++) { l = aL[k].run(l); r = aR[k].run(r); }
        yl = y + l * revMix; yr = y + r * revMix;
      }
      yl *= outG; yr *= outG;
      double pk = std::max(std::fabs(yl), std::fabs(yr));
      if (pk > outPk) outPk = pk;
      if (howlGuard) {
        howlEnv += (pk - howlEnv) * 0.0005;
        if (howlEnv > 0.6) { if (++howlT > fs * 0.6) { duckT = fs * 2; howl = true; howlT = 0; } }
        else howlT = 0;
        if (duckT > 0) { duckT--; duck += (0.06 - duck) * 0.01; }
        else { duck += (1 - duck) * 0.0005; howl = false; }
        yl *= duck; yr *= duck;
      }
      double mx = std::max(std::fabs(yl), std::fabs(yr)), lgt = mx > 0.89 ? 0.89 / mx : 1;
      if (lgt <= limHold) { limHold = lgt; limHT = 4 * LA; }
      else if (limHT > 0) limHT--;
      else limHold = lgt;
      limG += (limHold - limG) * (limHold < limG ? limAtk : limRel);
      int LA1 = LA + 1, ri = (laI + 1) % LA1;
      laL[(size_t)laI] = (float)yl; laR[(size_t)laI] = (float)yr; laI = ri;
      double ol = laL[(size_t)ri] * limG, orr = laR[(size_t)ri] * limG;
      if (ol > 0.95 || ol < -0.95) ol = (ol > 0 ? 1 : -1) * (0.95 + 0.05 * std::tanh((std::fabs(ol) - 0.95) / 0.05));
      if (orr > 0.95 || orr < -0.95) orr = (orr > 0 ? 1 : -1) * (0.95 + 0.05 * std::tanh((std::fabs(orr) - 0.95) / 0.05));
      outL[i] = (float)ol;
      if (outR) outR[i] = (float)orr;
    }
  }

  // public read-only state for tests
  double fs; double f0 = 0, conf = 0, corr = 0, latency = 0; bool voiced = false; int64_t n = 0;

 private:
  void defaults() {
    bypass = false; inGainDb = 0; hpfHz = 90; gateDb = -55; minF0 = 70; maxF0 = 900; yinThresh = 0.15;
    const int m[12] = {1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1}; for (int i = 0; i < 12; i++) mask12[i] = m[i];
    retuneMs = 20; humanize = 0; flex = 0; vibrato = 0; transpose = 0; mode = 0; formant = 0;
    v2Level = 0; v2Interval = 0; v2Detune = 0; mix = 1;
    compThr = -18; compRatio = 3; compAtk = 5; compRel = 80; compMakeup = 3; satDrive = 0; satMix = 0;
    dlyMs = 375; dlyFb = 0.25; dlyMix = 0; dlyDamp = 0.4; revTime = 1.2; revDamp = 0.5; revPre = 15; revMix = 0;
    outDb = 0; howlGuard = true;
  }
  void recompute() {
    int any = 0; for (int i = 0; i < 12; i++) any += mask12[i];
    if (!any) for (int i = 0; i < 12; i++) mask12[i] = 1;
    inGain = std::pow(10.0, inGainDb / 20);
    hpf.hp(std::max(20.0, hpfHz), fs, 0.707);
    gateThr = std::pow(10.0, gateDb / 20);
    tauMinD = std::max(2, (int)std::floor(dfs / std::min(maxF0, dfs / 3)));
    tauMaxD = std::min(tauMaxAbs - 2, (int)std::ceil(dfs / std::max(45.0, minF0)));
    fmt = std::pow(2.0, formant / 12);
    cAtk = std::exp(-1 / (fs * std::max(0.1, compAtk) / 1000));
    cRel = std::exp(-1 / (fs * std::max(5.0, compRel) / 1000));
    cMake = std::pow(10.0, compMakeup / 20);
    double g = std::pow(10.0, satDrive / 20); satG = g; satK = 0.5 / std::tanh(0.5 * g);
    dlyN = std::max<int64_t>(1, std::min<int64_t>((int64_t)dly.size() - 2, (int64_t)std::llround(dlyMs * fs / 1000)));
    dlyDampC = std::min(0.95, std::max(0.0, dlyDamp));
    double rt = std::max(0.1, revTime);
    for (auto* v : {&cL, &cR}) for (auto& c : *v) { c.g = std::pow(10.0, -3.0 * (double)c.buf.size() / (fs * rt)); c.d = std::min(0.9, std::max(0.0, revDamp)) * 0.7; }
    preN = std::max<int64_t>(1, std::min<int64_t>((int64_t)pre.size() - 1, (int64_t)std::llround(revPre * fs / 1000)));
    outG = std::pow(10.0, outDb / 20);
    if (mode != lastMode) { lastMode = mode; s1.reset(n); s2.reset(n); p1.reset(n, T); p2.reset(n, T); }
  }
  int nearest(double m) const {
    int c = (int)std::lround(m), best = c; double bd = 1e9;
    for (int k = c - 7; k <= c + 7; k++) { if (!mask12[((k % 12) + 12) % 12]) continue; double d = std::fabs(m - k); if (d < bd) { bd = d; best = k; } }
    return best;
  }
  double detect() {
    int W = Wd, tmax = tauMaxD, tmin = tauMinD, len = W + tmax + 2;
    if (dn < len + 2) return 0;
    float* fr = frame.data(); int64_t base = dn - len; double e = 0;
    for (int j = 0; j < len; j++) fr[j] = dx[(size_t)((base + j) & dmask)];
    for (int j = len - W; j < len; j++) e += (double)fr[j] * fr[j];
    rms = std::sqrt(e / W);
    if (!gOpen || rms < 1e-4) return 0;
    double run = 0; cm[0] = 1;
    for (int tau = 1; tau <= tmax + 1; tau++) {
      double s = 0;
      for (int j = 0; j < W; j++) { double d = (double)fr[j] - fr[j + tau]; s += d * d; }
      run += s; cm[(size_t)tau] = run > 0 ? s * tau / run : 1;
    }
    int t = -1;
    for (int tau = tmin; tau < tmax; tau++) {
      if (cm[(size_t)tau] < yinThresh) { while (tau + 1 < tmax && cm[(size_t)tau + 1] < cm[(size_t)tau]) tau++; t = tau; break; }
    }
    if (t < 0) {
      double mi = 1e9;
      for (int tau = tmin; tau < tmax; tau++) if (cm[(size_t)tau] < mi) { mi = cm[(size_t)tau]; t = tau; }
      if (mi > 0.35) return 0;
    }
    if (t < 1) return 0;
    double a = cm[(size_t)t - 1], b = cm[(size_t)t], c = cm[(size_t)t + 1], den = a + c - 2 * b;
    double dl = den != 0 ? 0.5 * (a - c) / den : 0; if (dl > 1) dl = 1; if (dl < -1) dl = -1;
    conf = 1 - b;
    double tf = (t + dl) * dec; const float* xb = x.data();
    int lo = std::max(2, (int)std::floor(tf - dec - 1)), hi = (int)std::ceil(tf + dec + 1);
    int64_t st = n - Wf - hi - 1;
    int bt = lo; double bv = 1e18, pv = 0, nv = 0, prev = 0;
    for (int tau = lo; tau <= hi + 1; tau++) {
      double s = 0;
      for (int j = 0; j < Wf; j++) { double d = (double)xb[(st + j) & mask] - xb[(st + j + tau) & mask]; s += d * d; }
      if (tau <= hi && s < bv) { bv = s; bt = tau; pv = prev; }
      if (tau == bt + 1) nv = s;
      prev = s;
    }
    double tFull = bt;
    if (bt > lo && bt < hi) { double dd = pv + nv - 2 * bv; if (dd > 0) { double o = 0.5 * (pv - nv) / dd; if (o > 1) o = 1; if (o < -1) o = -1; tFull = bt + o; } }
    return fs / tFull;
  }
  void control() {
    double dt = hop / fs, f = detect();
    if (f > 0 && voiced && f0 > 0) {
      double r = f / f0;
      if ((std::fabs(r - 2) < 0.12 || std::fabs(r - 0.5) < 0.06) && octHold < 2) { octHold++; f = f0; }
      else octHold = 0;
    }
    if (f > 0) { vOn++; vOff = 0; } else { vOff++; vOn = 0; }
    bool wasVoiced = voiced;
    if (!voiced && vOn >= 2) voiced = true;
    if (voiced && vOff >= 3) { voiced = false; targetMidi = -1; }
    if (f > 0) f0 = f;
    if (voiced && f0 > 0) {
      T = fs / f0;
      double im = 69 + 12 * std::log2(f0 / 440);
      if (!wasVoiced) inSmooth = im;
      inMidi = im;
      inSmooth += (im - inSmooth) * (1 - std::exp(-dt / 0.12));
      double vib = im - inSmooth;
      int cand = nearest(im);
      if (targetMidi < 0 || !mask12[((targetMidi % 12) + 12) % 12]) { targetMidi = cand; held = 0; }
      else if (cand != targetMidi && std::fabs(im - cand) + 0.12 < std::fabs(im - targetMidi)) { targetMidi = cand; held = 0; }
      else held += dt;
      double dev = targetMidi - im, wgt = 1;
      if (flex > 0) {
        double z = 0.6 - 0.5 * (flex / 100), z0 = z * 0.5, ad = std::fabs(dev);
        wgt = ad <= z0 ? 1 : ad >= z ? 0 : 1 - (ad - z0) / (z - z0);
      }
      double ct = dev * wgt;
      double hs = (held - 0.08) / 0.27; hs = hs < 0 ? 0 : hs > 1 ? 1 : hs;
      double ret = retuneMs + (humanize / 100) * 300 * hs;
      double alpha = ret <= 0.5 ? 1 : 1 - std::exp(-dt / (ret / 1000 / 2.3));
      corr += (ct - corr) * alpha;
      semis = corr + (vibrato / 100) * vib + transpose;
    } else {
      corr *= std::exp(-dt / 0.03);
      semis = corr + transpose;
      if (vOff > 10) T += (Tdef - T) * 0.2;
    }
    double r = std::pow(2.0, semis / 12); r = r < 0.5 ? 0.5 : r > 2 ? 2 : r;
    double rr2 = r * std::pow(2.0, (v2Interval + v2Detune / 100) / 12); rr2 = rr2 < 0.45 ? 0.45 : rr2 > 2 ? 2 : rr2;
    ratioInc = (r - ratio) / hop; r2Inc = (rr2 - r2) / hop; rampLeft = hop;
  }
  double measureStep(double raw) {
    double a = std::fabs(raw);
    meas.t++;
    if (meas.state == 1) { if (a > meas.noise) meas.noise = a; if (meas.t > fs * 0.3) { meas.state = 2; meas.t = 0; meas.start = n; } return 0; }
    if (meas.state == 2) {
      int64_t ct = meas.t - 1, cl = (int64_t)std::llround(fs * 0.003); double y = 0;
      if (ct < cl) y = 0.8 * std::sin(kPi * ct / cl) * std::sin(kTwoPi * 2000 * ct / fs);
      double thr = std::max(meas.noise * 6, 0.02);
      if (ct > 2 && a > thr) { meas.r[meas.tries++] = (double)(n - meas.start); meas.state = 3; meas.t = 0; }
      else if (ct > fs * 0.8) { meas.state = 0; meas.result = -2; measMs = -2; }
      return y;
    }
    if (meas.state == 3) {
      if (meas.t > fs * 0.35) {
        if (meas.tries >= 3) {
          double a0 = meas.r[0], a1 = meas.r[1], a2 = meas.r[2];
          meas.result = std::max(std::min(a0, a1), std::min(std::max(a0, a1), a2));
          meas.state = 0; measMs = meas.result * 1000 / fs;
        } else { meas.state = 2; meas.t = 0; meas.start = n + 1; }
      }
    }
    return 0;
  }

  // buffers & sizes
  int64_t N, mask; std::vector<float> x;
  int dec; double dfs; Biquad lp1, lp2, hpf;
  int64_t dN, dmask, dn = 0; std::vector<float> dx; int decPh = 0;
  int tauMaxAbs, Wd, Wf, hop, hopCnt = 0, tauMinD = 2, tauMaxD = 100;
  std::vector<float> frame; std::vector<double> cm;
  // pitch state
  double rms = 0, T, Tdef, inMidi = 0, inSmooth = 0, held = 0, semis = 0;
  int targetMidi = -1, vOn = 0, vOff = 0, octHold = 0;
  double ratio = 1, ratioInc = 0, r2 = 1, r2Inc = 0, markPos = 0; int rampLeft = 0;
  SpliceVoice s1, s2; PsolaVoice p1, p2; double dryD = 0;
  // input
  double gEnv = 0, gGain = 0, gHold = 0, inPk = 0, outPk = 0; bool gOpen = false;
  double cEnv = 0, satX1 = 0;
  int LA = 48, laI = 0; std::vector<float> laL, laR; double limHold = 1, limHT = 0, limAtk = 0.1, limRel = 0.001;
  std::vector<float> dly; size_t dI = 0; double dLp = 0; int64_t dlyN = 1; double dlyDampC = 0.4;
  std::vector<Comb> cL, cR; std::vector<Allpass> aL, aR; std::vector<float> pre; size_t preI = 0; int64_t preN = 1;
  double limG = 1, howlEnv = 0, howlT = 0, duck = 1, duckT = 0; bool howl = false;
  struct { int state = 0; int64_t t = 0, start = 0; double noise = 0, result = -1; int tries = 0; double r[5] = {0, 0, 0, 0, 0}; } meas;
  double measMs = -1;
  // params
  bool bypass, howlGuard, dirty = false; int mask12[12]; int mode = 0, lastMode = -1;
  double inGainDb, hpfHz, gateDb, minF0, maxF0, yinThresh, retuneMs, humanize, flex, vibrato, transpose, formant,
      v2Level, v2Interval, v2Detune, mix, compThr, compRatio, compAtk, compRel, compMakeup, satDrive, satMix,
      dlyMs, dlyFb, dlyMix, dlyDamp, revTime, revDamp, revPre, revMix, outDb;
  // derived
  double inGain = 1, gateThr = 0, fmt = 1, cAtk = 0, cRel = 0, cMake = 1, satG = 1, satK = 1, outG = 1;
};

}  // namespace canlitune
