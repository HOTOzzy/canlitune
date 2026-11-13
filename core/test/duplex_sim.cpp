// Simulates Android full-duplex with independent mic / headphone clocks (Bluetooth case)
// and compares the old strategy (drop excess / zero-fill shortage) with DriftFifo.
// Metric: clicks = samples where the 2nd difference of a 440 Hz sine exceeds what a
// clean 440 Hz sine can produce (plus margin).
#include <cmath>
#include <cstdio>
#include <random>
#include <vector>
#include "../DriftFifo.hpp"
using namespace canlitune;

struct Result { int clicks; long under; double maxFillMs, ratioPpm, ratioSdPpm, minFillMs; };

// Mic produces bursts of `inBurst` at rate fs*(1+drift); headphone callback asks for `outN` (jittered)
static Result run(bool fifo, double drift, int inBurst, int outBase, int outJitter, double seconds) {
  const double fs = 48000; std::mt19937 rng(1);
  std::vector<float> micQ;  // what AAudio would hold for the input stream
  double micClock = 0, outClock = 0, ph = 0; long t = 0;
  DriftFifo df; df.reset(std::max(64, inBurst / 2), fs);
  std::vector<float> out, tmp(16384), blk(16384);
  int clicks = 0; double prev2 = 0, prev1 = 0, maxFill = 0, minFill = 1e9, rs = 0, rss = 0; long n = 0, rc = 0;
  const double maxD2 = std::pow(2 * M_PI * 440 / fs, 2) * 0.5 * 1.3 + 1e-4;
  while (outClock < seconds * fs) {
    int need = outBase + (outJitter ? (int)(rng() % (unsigned)outJitter) : 0);
    outClock += need;
    // mic delivers every burst whose time has come
    while (micClock + inBurst <= outClock * (1 + drift)) {
      for (int i = 0; i < inBurst; i++) { ph += 2 * M_PI * 440 / fs; micQ.push_back((float)(0.5 * std::sin(ph))); }
      micClock += inBurst;
    }
    if (fifo) {
      df.push(micQ.data(), (int)micQ.size()); micQ.clear();
      df.pull(blk.data(), need);
      maxFill = std::max(maxFill, df.fill());
      if (outClock > fs * 20) { double r = (df.ratio - 1) * 1e6; rs += r; rss += r * r; rc++; minFill = std::min(minFill, df.fill()); }
    } else {  // previous native-lib.cpp logic
      int avail = (int)micQ.size();
      if (avail > need + 2 * inBurst) { int drop = avail - need - inBurst; micQ.erase(micQ.begin(), micQ.begin() + drop); }
      int got = std::min(need, (int)micQ.size());
      for (int i = 0; i < got; i++) blk[i] = micQ[i];
      micQ.erase(micQ.begin(), micQ.begin() + got);
      for (int i = got; i < need; i++) blk[i] = 0;
      maxFill = std::max(maxFill, (double)micQ.size());
    }
    for (int i = 0; i < need; i++, n++) {
      double y = blk[i];
      if (n > fs * 0.5) { double d2 = y - 2 * prev1 + prev2; if (std::fabs(d2) > maxD2) clicks++; }
      prev2 = prev1; prev1 = y;
    }
    t++;
  }
  double m = rc ? rs / rc : 0; return {clicks, fifo ? df.underflows : 0, maxFill * 1000 / fs, m, rc ? std::sqrt(std::max(0.0, rss / rc - m * m)) : 0, minFill * 1000 / fs};
}

int main() {
  int fails = 0;
  struct Case { const char* name; double drift; int inB, outB, outJ; } cases[] = {
      {"same clock, low-latency path (burst 96/192)", 0.0, 96, 192, 0},
      {"Bluetooth: mic +300 ppm, out 1024 jittery", 300e-6, 192, 960, 128},
      {"Bluetooth: mic -300 ppm, out 1024 jittery", -300e-6, 192, 960, 128},
      {"wired USB-ish: mic +80 ppm", 80e-6, 96, 96, 0},
  };
  for (auto& c : cases) {
    Result o = run(false, c.drift, c.inB, c.outB, c.outJ, 60), f = run(true, c.drift, c.inB, c.outB, c.outJ, 60);
    bool ok = f.clicks == 0 && f.under == 0;
    bool steady = std::fabs(f.ratioPpm + c.drift * 1e6 * 0 - c.drift * 1e6) < 60 && f.ratioSdPpm < 350;  // tracks the clock; 350 ppm = 0.6 cent, far below the ~5 cent pitch JND
    ok = ok && steady;
    std::printf("%s  %-46s old: %4d clicks/min | new: %d clicks, %ld underflows, fill %.1f..%.1f ms, ratio %+.0f ppm (true %+.0f) sd %.0f ppm\n",
                ok ? "PASS" : "FAIL", c.name, o.clicks, f.clicks, f.under, f.minFillMs, f.maxFillMs, f.ratioPpm, c.drift * 1e6, f.ratioSdPpm);
    if (!ok) fails++;
  }
  return fails ? 1 : 0;
}
