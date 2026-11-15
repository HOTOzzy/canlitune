// Backing track playback/seek/lag + recorder WAV integrity.
#include <cstdio>
#include <vector>
#include "../Karaoke.hpp"
using namespace canlitune;
static int fails = 0;
static void check(const char* n, bool ok, const char* info = "") { std::printf("%s  %s  %s\n", ok ? "PASS" : "FAIL", n, info); if (!ok) fails++; }
int main() {
  BackingTrack bt; const int N = 44100 * 2; std::vector<int16_t> src(N * 2);
  for (int i = 0; i < N; i++) { src[2 * i] = (int16_t)(i % 30000); src[2 * i + 1] = (int16_t)-(i % 30000); }
  bt.begin(N, 44100); bt.append(src.data(), N / 2); bt.append(src.data() + N, N / 2);
  check("track loaded in two chunks", bt.loaded.load() == N);
  bt.gain.store(1.f); bt.recLagSec.store(0.1); bt.playing.store(true);
  std::vector<float> l(480), r(480), rl(480), rr(480), allL, allRL;
  for (int b = 0; b < 250 && bt.playing.load(); b++) { bt.render(l.data(), r.data(), rl.data(), rr.data(), 480, 48000); allL.insert(allL.end(), l.begin(), l.end()); allRL.insert(allRL.end(), rl.begin(), rl.end()); }
  // output frame k at 48 kHz corresponds to source position k*44100/48000
  int k = 24000; double sp = k * 44100.0 / 48000.0; float expect = (float)(std::fmod(sp, 30000.0) / 32768.0);
  char buf[160]; std::snprintf(buf, sizeof buf, "got %.5f expected %.5f", allL[k], expect);
  check("resampled playback 44.1k -> 48k is sample-accurate", std::fabs(allL[k] - expect) < 2e-4, buf);
  int lagOut = (int)(0.1 * 48000);
  check("record copy is delayed by recLag (100 ms)", std::fabs(allRL[k + lagOut] - allL[k]) < 2e-4);
  check("stops at end (after lag tail)", !bt.playing.load() && allL.size() >= (size_t)(2.0 * 48000));
  bt.seek(1.0); bt.playing.store(true); bt.render(l.data(), r.data(), rl.data(), rr.data(), 480, 48000);
  check("seek to 1.0 s", std::fabs(l[0] - (float)((44100 % 30000) / 32768.0)) < 2e-4 && r[0] < 0);

  Recorder rec; const char* path = "/tmp/ct_rec_test.wav";
  check("recorder starts", rec.start(path, 48000));
  std::vector<float> L(256), R(256); int total = 0;
  for (int b = 0; b < 400; b++) { for (int i = 0; i < 256; i++) { L[i] = 0.5f * std::sin(0.05f * (total + i)); R[i] = -L[i]; } rec.push(L.data(), R.data(), 256); total += 256;
    if (b % 20 == 0) std::this_thread::sleep_for(std::chrono::milliseconds(5)); }
  int64_t fr = rec.stop();
  FILE* f = std::fopen(path, "rb"); unsigned char h[44]; size_t got = std::fread(h, 1, 44, f); std::fseek(f, 0, SEEK_END); long sz = std::ftell(f);
  std::fseek(f, 44 + 1000 * 4, SEEK_SET); int16_t s[2]; std::fread(s, 2, 2, f); std::fclose(f);
  uint32_t dataBytes; std::memcpy(&dataBytes, h + 40, 4);
  std::snprintf(buf, sizeof buf, "%lld frames, file %ld bytes, dropped %lld", (long long)fr, sz, (long long)rec.dropped.load());
  check("all frames written, none dropped", fr == total && rec.dropped.load() == 0 && got == 44, buf);
  check("valid WAV header", !std::memcmp(h, "RIFF", 4) && !std::memcmp(h + 8, "WAVEfmt ", 8) && dataBytes == (uint32_t)total * 4 && sz == 44 + total * 4);
  check("sample content correct", std::abs(s[0] - (int)std::lrint(0.5f * std::sin(0.05f * 1000) * 32767)) <= 1 && s[1] == -s[0]);
  std::printf("%d failed\n", fails); return fails ? 1 : 0;
}
