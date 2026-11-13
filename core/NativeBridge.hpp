// Thread-safe glue between a UI thread and the real-time audio callback.
// - UI thread: pushParam()/requestMeasure()/readTelemetry() — never blocks the audio thread.
// - Audio thread: render() drains the lock-free SPSC queue, runs the engine, publishes telemetry.
#pragma once
#include <atomic>
#include <memory>
#include "CanliTuneEngine.hpp"

namespace canlitune {

class NativeBridge {
 public:
  static constexpr int kQ = 512;      // param queue capacity (power of two)
  static constexpr int kTele = 12;

  // Called (re)creating the engine when the device sample rate is known. Not real-time.
  void prepare(double sampleRate, int maxFrames) {
    engine.reset(new Engine(sampleRate));
    scratchR.assign((size_t)maxFrames * 2 + 4096, 0.f);
    // replay the latest value of every parameter so a restart keeps the user's settings
    for (int i = 0; i < P_COUNT; i++) if (hasLast[i]) engine->applyParam(i, last[i]);
    engine->commitParams();
    sr.store((float)sampleRate);
  }

  // UI thread. Returns false if the queue is full (caller may retry next frame).
  bool pushParam(int id, double v) {
    if (id < 0 || id >= P_COUNT) return false;
    last[id] = v; hasLast[id] = true;
    int w = wr.load(std::memory_order_relaxed), nx = (w + 1) & (kQ - 1);
    if (nx == rd.load(std::memory_order_acquire)) return false;
    q[w].id = id; q[w].v = v;
    wr.store(nx, std::memory_order_release);
    return true;
  }
  void requestMeasure() { measureReq.store(true, std::memory_order_release); }
  void readTelemetry(float* out) const { for (int i = 0; i < kTele; i++) out[i] = tele[i].load(std::memory_order_relaxed); }

  // Audio thread. outR may equal nullptr for mono output.
  void render(const float* in, float* outL, float* outR, int frames) {
    Engine* e = engine.get();
    if (!e) { for (int i = 0; i < frames; i++) { outL[i] = 0; if (outR) outR[i] = 0; } return; }
    int r = rd.load(std::memory_order_relaxed), w = wr.load(std::memory_order_acquire);
    while (r != w) { e->applyParam(q[r].id, q[r].v); r = (r + 1) & (kQ - 1); }
    rd.store(r, std::memory_order_release);
    e->commitParams();
    if (measureReq.exchange(false, std::memory_order_acq_rel)) e->measureStart();
    e->process(in, outL, outR, frames);
    framesSinceTele += frames;
    if (framesSinceTele >= (int)(e->fs * 0.03)) {  // ~33 Hz
      framesSinceTele = 0;
      float t[kTele]; e->telemetry(t);
      for (int i = 0; i < kTele; i++) tele[i].store(t[i], std::memory_order_relaxed);
    }
  }

  std::atomic<float> sr{0}, outLatencyMs{0}, inLatencyMs{0}, framesPerBurst{0}, xruns{0};

 private:
  struct Msg { int id; double v; };
  Msg q[kQ];
  std::atomic<int> wr{0}, rd{0};
  std::atomic<bool> measureReq{false};
  std::atomic<float> tele[kTele] = {};
  double last[P_COUNT] = {};
  bool hasLast[P_COUNT] = {};
  std::unique_ptr<Engine> engine;
  std::vector<float> scratchR;
  int framesSinceTele = 0;
};

}  // namespace canlitune
