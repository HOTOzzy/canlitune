// Elastic input buffer for full-duplex audio where mic and output run on different
// clocks (e.g. phone mic + Bluetooth headphones). The old approach (drop frames when
// the mic is ahead, zero-fill when it is behind) produces clicks every time the clocks
// slip. Here the FIFO is read through a Hermite resampler whose ratio tracks the true
// clock ratio: once per second the *minimum* fill seen in that second (the trough just
// before a mic burst arrives - a jitter-free measurement) is compared to a small safety
// target and a PI step updates the ratio; ratio changes are ramped across the next
// callback. Real-time safe: no allocation after construction.
#pragma once
#include <cmath>
#include <cstdint>
#include <vector>
#include <algorithm>

namespace canlitune {

class DriftFifo {
 public:
  explicit DriftFifo(int capacityPow2 = 1 << 15) : buf((size_t)capacityPow2, 0.f), mask(capacityPow2 - 1) {}

  // safetyFrames: minimum frames that should remain in the FIFO after each callback.
  void reset(double safetyFrames, double sampleRate) {
    std::fill(buf.begin(), buf.end(), 0.f);
    w = 0; rpos = 0; safety = safetyFrames; sr = sampleRate;
    integ = 0; ratio = ratioTarget = 1; buffering = true; fadeIn = 0; winFrames = 0; winMin = 1e18;
    underflows = overflows = 0;
  }
  void push(const float* x, int n) {
    for (int i = 0; i < n; i++) buf[(size_t)(w++ & mask)] = x[i];
    if (fill() > (double)mask - 8) { rpos = (double)w - safety; overflows++; }
  }
  double fill() const { return (double)w - rpos; }

  void pull(float* out, int n) {
    if (buffering) {  // (re)start: wait for one callback + safety, then fade in
      if (fill() < safety + n + 4) { for (int i = 0; i < n; i++) out[i] = 0.f; return; }
      rpos = (double)w - safety - n; buffering = false; fadeIn = 0; winFrames = 0; winMin = 1e18;
    }
    double r0 = ratio, dr = (ratioTarget - ratio) / n;
    double need = n * std::max(r0, ratioTarget) + 4;
    if (fill() < need) {  // genuine underflow (stall): fade out quickly, then rebuffer
      underflows++;
      double g = 1;
      for (int i = 0; i < n; i++) { if (fill() > 4) { out[i] = (float)(read() * g); rpos += r0; } else out[i] = 0.f; g *= 0.96; }
      buffering = true; return;
    }
    for (int i = 0; i < n; i++) {
      double y = read();
      if (fadeIn < 512) { y *= fadeIn / 512.0; fadeIn++; }
      out[i] = (float)y; r0 += dr; rpos += r0;
    }
    ratio = ratioTarget;
    if (fill() > safety * 8 + 8192) { rpos = (double)w - safety; overflows++; }  // after a long stall: resync
    // once-per-second PI update on the window minimum
    winMin = std::min(winMin, fill()); winFrames += n;
    if (winFrames >= sr) {
      double e = (winMin - safety) / sr;  // seconds of surplus (+) or deficit (-)
      integ = std::clamp(integ + e * 0.125, -0.003, 0.003);
      ratioTarget = 1.0 + std::clamp(0.25 * e + integ, -0.004, 0.004);
      winFrames = 0; winMin = 1e18;
    }
  }

  double ratio = 1, safety = 64, sr = 48000;
  long underflows = 0, overflows = 0;

 private:
  inline double read() const {
    double fl = std::floor(rpos); int64_t i = (int64_t)fl; double t = rpos - fl;
    double xm = buf[(size_t)((i - 1) & mask)], x0 = buf[(size_t)(i & mask)], x1 = buf[(size_t)((i + 1) & mask)], x2 = buf[(size_t)((i + 2) & mask)];
    double c1 = 0.5 * (x1 - xm), c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
    return ((c3 * t + c2) * t + c1) * t + x0;
  }
  std::vector<float> buf; int64_t mask, w = 0;
  double rpos = 0, integ = 0, ratioTarget = 1, winMin = 1e18, winFrames = 0; bool buffering = true; int fadeIn = 0;
};

}  // namespace canlitune
