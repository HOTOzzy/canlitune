// Backing-track player + recorder for the native apps.
// Audio thread: BackingTrack::render() and Recorder::push() never allocate or block
// (render uses try_lock; if the UI thread is swapping the track it outputs silence).
#pragma once
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <chrono>
#include <vector>

namespace canlitune {

class BackingTrack {
 public:
  // ---- UI thread ----
  void begin(int64_t frames, double sampleRate) {
    std::lock_guard<std::mutex> lk(mtx);
    playing.store(false); pcm.assign((size_t)frames * 2, 0); len = frames; loaded.store(0); pos = 0; srcRate = sampleRate;
    posSec.store(0); lenSec.store((float)(frames / sampleRate));
  }
  void append(const int16_t* d, int64_t frames) {  // interleaved stereo; buffer is pre-sized so no reallocation
    int64_t l = loaded.load(); if (frames > len - l) frames = len - l; if (frames <= 0) return;
    std::memcpy(pcm.data() + l * 2, d, (size_t)frames * 4); loaded.store(l + frames);
  }
  void clear() { std::lock_guard<std::mutex> lk(mtx); playing.store(false); pcm.clear(); pcm.shrink_to_fit(); len = 0; loaded.store(0); pos = 0; posSec.store(0); lenSec.store(0); }
  void seek(double sec) { seekReq.store(sec); }
  std::atomic<bool> playing{false};
  std::atomic<float> gain{0.7f}, posSec{0}, lenSec{0};
  std::atomic<double> recLagSec{0};   // recording only: delay the beat by the round-trip latency so the voice lines up
  std::atomic<int64_t> loaded{0};

  // ---- audio thread ----
  // liveL/R: beat as heard now. recL/R: the same beat delayed by recLagSec (for the recording mix).
  void render(float* liveL, float* liveR, float* recL, float* recR, int n, double outRate) {
    for (int i = 0; i < n; i++) { liveL[i] = liveR[i] = recL[i] = recR[i] = 0.f; }
    if (!mtx.try_lock()) return;
    double sk = seekReq.exchange(-1.0);
    if (sk >= 0) pos = sk * srcRate;
    if (playing.load() && len > 1) {
      const double step = srcRate / outRate, lag = recLagSec.load() * srcRate; const float g = gain.load() / 32768.f;
      for (int i = 0; i < n; i++) {
        sample(pos, g, liveL[i], liveR[i]);
        sample(pos - lag, g, recL[i], recR[i]);
        pos += step;
      }
      if (pos >= (double)len + lag) { playing.store(false); pos = 0; }
      posSec.store((float)(pos / srcRate));
    } else if (sk >= 0) posSec.store((float)(pos / srcRate));
    mtx.unlock();
  }

 private:
  inline void sample(double p, float g, float& l, float& r) const {
    if (p < 0 || p >= (double)(len - 1)) { l = r = 0.f; return; }
    int64_t i = (int64_t)p; float f = (float)(p - (double)i); const int16_t* d = pcm.data() + i * 2;
    l = (d[0] + (d[2] - d[0]) * f) * g; r = (d[1] + (d[3] - d[1]) * f) * g;
  }
  std::vector<int16_t> pcm; int64_t len = 0; double pos = 0, srcRate = 48000;
  std::atomic<double> seekReq{-1.0};
  std::mutex mtx;
};

// Lock-free SPSC ring -> writer thread -> 16-bit stereo WAV.
class Recorder {
 public:
  ~Recorder() { stop(); }
  bool start(const std::string& path, int sampleRate) {
    stop();
    f = std::fopen(path.c_str(), "wb"); if (!f) return false;
    sr = sampleRate; ring.assign(kCap * 2, 0.f); wr.store(0); rd.store(0); frames.store(0); dropped.store(0);
    unsigned char hdr[44] = {0}; std::fwrite(hdr, 1, 44, f);
    run.store(true); active.store(true);
    th = std::thread([this] { writer(); });
    return true;
  }
  // returns frames written
  int64_t stop() {
    if (!run.load()) return frames.load();
    active.store(false); run.store(false);
    if (th.joinable()) th.join();
    drain();
    uint32_t dataBytes = (uint32_t)(frames.load() * 4), u32; uint16_t u16;
    std::fseek(f, 0, SEEK_SET);
    std::fwrite("RIFF", 1, 4, f); u32 = 36 + dataBytes; std::fwrite(&u32, 4, 1, f); std::fwrite("WAVEfmt ", 1, 8, f);
    u32 = 16; std::fwrite(&u32, 4, 1, f); u16 = 1; std::fwrite(&u16, 2, 1, f); u16 = 2; std::fwrite(&u16, 2, 1, f);
    u32 = (uint32_t)sr; std::fwrite(&u32, 4, 1, f); u32 = (uint32_t)sr * 4; std::fwrite(&u32, 4, 1, f);
    u16 = 4; std::fwrite(&u16, 2, 1, f); u16 = 16; std::fwrite(&u16, 2, 1, f);
    std::fwrite("data", 1, 4, f); std::fwrite(&dataBytes, 4, 1, f);
    std::fclose(f); f = nullptr;
    return frames.load();
  }
  // audio thread
  inline void push(const float* L, const float* R, int n) {
    if (!active.load(std::memory_order_relaxed)) return;
    int64_t w = wr.load(std::memory_order_relaxed), r = rd.load(std::memory_order_acquire);
    if (w - r + n > kCap) { dropped.fetch_add(n); return; }
    for (int i = 0; i < n; i++) { size_t k = (size_t)((w + i) & (kCap - 1)) * 2; ring[k] = L[i]; ring[k + 1] = R[i]; }
    wr.store(w + n, std::memory_order_release);
  }
  std::atomic<bool> active{false};
  std::atomic<int64_t> frames{0}, dropped{0};
  int sr = 48000;

 private:
  static constexpr int64_t kCap = 1 << 18;  // ~5.4 s at 48 kHz
  void drain() {
    int64_t r = rd.load(std::memory_order_relaxed), w = wr.load(std::memory_order_acquire);
    while (r < w) {
      int n = (int)std::min<int64_t>(w - r, 2048);
      for (int i = 0; i < n; i++) for (int c = 0; c < 2; c++) {
        float v = ring[(size_t)((r + i) & (kCap - 1)) * 2 + c];
        if (v > 0.95f || v < -0.95f) v = (v > 0 ? 1.f : -1.f) * (0.95f + 0.05f * std::tanh((std::fabs(v) - 0.95f) / 0.05f));
        tmp[i * 2 + c] = (int16_t)std::lrint(v * 32767.f);
      }
      std::fwrite(tmp, 4, (size_t)n, f); r += n; frames.fetch_add(n);
    }
    rd.store(r, std::memory_order_release);
  }
  void writer() { while (run.load()) { drain(); std::this_thread::sleep_for(std::chrono::milliseconds(40)); } }
  std::vector<float> ring; std::atomic<int64_t> wr{0}, rd{0}; std::atomic<bool> run{false};
  std::thread th; FILE* f = nullptr; int16_t tmp[4096];
};

static inline float softClip(float v) {
  if (v > 0.95f || v < -0.95f) return (v > 0 ? 1.f : -1.f) * (0.95f + 0.05f * std::tanh((std::fabs(v) - 0.95f) / 0.05f));
  return v;
}

}  // namespace canlitune
