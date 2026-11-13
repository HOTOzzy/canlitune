// Real-time safety + performance test for the native core.
// - counts heap allocations made on the audio thread while rendering (must be 0)
// - a UI thread hammers parameter changes concurrently through NativeBridge
// - checks the result is finite, voiced, corrected, and measures CPU per block
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <thread>
#include <vector>
#include "../NativeBridge.hpp"
using namespace canlitune;

static std::atomic<long> gAllocs{0};
static thread_local bool tCount = false;
void* operator new(std::size_t n) { if (tCount) gAllocs++; void* p = std::malloc(n ? n : 1); if (!p) throw std::bad_alloc(); return p; }
void* operator new[](std::size_t n) { if (tCount) gAllocs++; void* p = std::malloc(n ? n : 1); if (!p) throw std::bad_alloc(); return p; }
void operator delete(void* p) noexcept { if (tCount && p) gAllocs++; std::free(p); }
void operator delete[](void* p) noexcept { if (tCount && p) gAllocs++; std::free(p); }
void operator delete(void* p, std::size_t) noexcept { if (tCount && p) gAllocs++; std::free(p); }
void operator delete[](void* p, std::size_t) noexcept { if (tCount && p) gAllocs++; std::free(p); }

static int fails = 0;
static void check(const char* name, bool ok, const char* info) { std::printf("%s  %s  %s\n", ok ? "PASS" : "FAIL", name, info); if (!ok) fails++; }

int main() {
  const double FS = 48000; const int BLK = 192;  // odd Oboe-like burst size on purpose
  NativeBridge br; br.prepare(FS, 4096);
  br.pushParam(P_MASKBITS, 0xFFF); br.pushParam(P_RETUNE, 0); br.pushParam(P_COMPRATIO, 1); br.pushParam(P_HOWLGUARD, 0);
  // input: vowel-like harmonic tone at 446 Hz (+23 cents above A4)
  const double f0 = 446; const int total = (int)FS * 6;
  std::vector<float> in(total);
  for (int i = 0; i < total; i++) { double ph = 2 * kPi * f0 * i / FS, v = 0; for (int k = 1; k < 10; k++) v += std::sin(k * ph) / k; in[i] = (float)(0.2 * v); }
  std::vector<float> L(BLK), R(BLK), out(total);
  std::atomic<bool> stop{false};
  std::thread ui([&] {  // UI thread: sweep params continuously
    int k = 0;
    while (!stop.load()) {
      br.pushParam(P_REVMIX, (k % 50) / 100.0); br.pushParam(P_DLYMIX, (k % 30) / 100.0); br.pushParam(P_SATMIX, (k % 20) / 40.0);
      br.pushParam(P_V2LEVEL, (k % 2) * 0.4); br.pushParam(P_FORMANT, (k % 5) - 2.0); br.pushParam(P_DLYMS, 100 + (k % 7) * 50);
      float t[12]; br.readTelemetry(t); k++;
      std::this_thread::sleep_for(std::chrono::milliseconds(3));
    }
  });
  double worstUs = 0, sumUs = 0; int blocks = 0;
  // warm-up 1 s without counting
  for (int i = 0; i + BLK <= (int)FS; i += BLK) br.render(in.data() + i, out.data() + i, R.data(), BLK);
  for (int mode = 0; mode < 2; mode++) {
    br.pushParam(P_MODE, mode);
    for (int i = (int)FS * (1 + 2 * mode) ; i + BLK <= (int)FS * (3 + 2 * mode); i += BLK) {
      auto t0 = std::chrono::steady_clock::now();
      tCount = true; br.render(in.data() + i, out.data() + i, R.data(), BLK); tCount = false;
      double us = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count();
      worstUs = std::max(worstUs, us); sumUs += us; blocks++;
    }
  }
  stop = true; ui.join();
  char buf[256];
  std::snprintf(buf, sizeof buf, "%ld allocations/frees on the audio thread over %d blocks", gAllocs.load(), blocks);
  check("zero heap activity in render()", gAllocs.load() == 0, buf);
  bool finite = true; double pk = 0; for (float v : out) { if (!std::isfinite(v)) finite = false; pk = std::max(pk, (double)std::fabs(v)); }
  std::snprintf(buf, sizeof buf, "peak %.3f", pk); check("output finite and limited", finite && pk <= 1.0, buf);
  float t[12]; br.readTelemetry(t);
  std::snprintf(buf, sizeof buf, "detected %.2f Hz, target midi %.0f, correction %.1f cents", t[2], t[5], t[6]);
  check("telemetry: 446 Hz detected, snapped to A4 (-23 c)", std::fabs(t[2] - 446) < 0.5 && t[5] == 69 && std::fabs(t[6] + 23.3) < 1.5, buf);
  double budget = BLK / FS * 1e6, avg = sumUs / blocks;
  std::snprintf(buf, sizeof buf, "avg %.1f us / %.0f us block (%.2f%% of a core), worst %.1f us", avg, budget, 100 * avg / budget, worstUs);
  check("CPU (x86 here; phones ~3-6x slower)", avg < budget * 0.1, buf);
  std::printf("\n%d failed\n", fails);
  return fails ? 1 : 0;
}
