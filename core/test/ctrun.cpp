// CLI used by equivalence tests: ctrun <sr> <in.f32> <out.f32> [key=value ...]
// Reads mono float32 input, runs the C++ engine in 128-frame blocks, writes interleaved float32 (L) output
// followed by a sidecar <out.f32>.tele with 12 telemetry floats per block.
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#include "../CanliTuneEngine.hpp"
using namespace canlitune;

int main(int argc, char** argv) {
  if (argc < 4) { std::fprintf(stderr, "usage: ctrun sr in.f32 out.f32 [k=v...]\n"); return 2; }
  double sr = std::atof(argv[1]);
  FILE* f = std::fopen(argv[2], "rb"); if (!f) return 3;
  std::vector<float> in; float b[4096]; size_t r;
  while ((r = std::fread(b, 4, 4096, f)) > 0) in.insert(in.end(), b, b + r);
  std::fclose(f);
  Engine e(sr);
  for (int i = 4; i < argc; i++) {
    std::string kv = argv[i]; size_t p = kv.find('=');
    if (p == std::string::npos) continue;
    int id = paramIdFromName(kv.substr(0, p).c_str());
    if (id < 0) { std::fprintf(stderr, "unknown param %s\n", kv.c_str()); return 4; }
    e.applyParam(id, std::atof(kv.c_str() + p + 1));
  }
  e.commitParams();
  std::vector<float> out(in.size(), 0.f), R(128), tele;
  float t[12];
  for (size_t i = 0; i + 128 <= in.size(); i += 128) {
    e.process(in.data() + i, out.data() + i, R.data(), 128);
    e.telemetry(t); tele.insert(tele.end(), t, t + 12);
  }
  FILE* o = std::fopen(argv[3], "wb"); std::fwrite(out.data(), 4, out.size(), o); std::fclose(o);
  std::string tn = std::string(argv[3]) + ".tele";
  o = std::fopen(tn.c_str(), "wb"); std::fwrite(tele.data(), 4, tele.size(), o); std::fclose(o);
  return 0;
}
