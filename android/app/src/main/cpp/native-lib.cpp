// Android audio engine: Oboe full-duplex (mic -> CanlıTune DSP -> output) + JNI bridge.
// The output stream's data callback drives everything; the input stream is read
// non-blocking inside it (the pattern used by Oboe's LiveEffect sample), so input
// and output stay in lock-step with one burst of latency each way.
#include <jni.h>
#include <android/log.h>
#include <cstring>  // Oboe 1.9 FullDuplexStream.h uses memset without including it
#include <oboe/Oboe.h>
#include <atomic>
#include <cstdio>
#include <mutex>
#include <string>
#include <vector>
#include "NativeBridge.hpp"

#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, "CanliTune", __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, "CanliTune", __VA_ARGS__)

using namespace oboe;

class Duplex : public AudioStreamDataCallback, public AudioStreamErrorCallback {
 public:
  canlitune::NativeBridge bridge;

  std::string start(int sdkInt) {
    std::lock_guard<std::mutex> lk(mtx);
    sdk = sdkInt;
    closeLocked();
    Result r = openLocked();
    if (r != Result::OK) { closeLocked(); return err(convertToText(r)); }
    char buf[256];
    std::snprintf(buf, sizeof buf, "{\"ok\":true,\"sr\":%d,\"burst\":%d,\"api\":\"%s\",\"exclusive\":%s}", sr, burst,
                  out->getAudioApi() == AudioApi::AAudio ? "AAudio" : "OpenSL ES",
                  out->getSharingMode() == SharingMode::Exclusive ? "true" : "false");
    LOGI("started %s", buf);
    return buf;
  }
  void stop() { std::lock_guard<std::mutex> lk(mtx); wantRunning = false; closeLocked(); }

  // UI thread: refresh driver latency figures (not real-time safe, so not done in the callback)
  void refreshLatency() {
    std::lock_guard<std::mutex> lk(mtx);
    if (out) { auto l = out->calculateLatencyMillis(); if (l) bridge.outLatencyMs.store((float)l.value()); }
    if (in) { auto l = in->calculateLatencyMillis(); if (l) bridge.inLatencyMs.store((float)l.value()); }
  }

  // ---- real-time callback ----
  DataCallbackResult onAudioReady(AudioStream*, void* audioData, int32_t numFrames) override {
    float* o = static_cast<float*>(audioData);
    int done = 0;
    while (done < numFrames) {
      int n = std::min(numFrames - done, chunk);
      int got = 0;
      if (in) {
        // keep input latency bounded: if the mic stream has piled up, skip the excess
        auto avail = in->getAvailableFrames();
        if (avail && avail.value() > n + 2 * burst) {
          int drop = std::min(avail.value() - n - burst, chunk);
          in->read(inBuf.data(), drop, 0);
        }
        auto rr = in->read(inBuf.data(), n, 0);
        if (rr) got = rr.value();
      }
      for (int i = got; i < n; i++) inBuf[i] = 0.f;
      if (got < n && primed) bridge.xruns.store(bridge.xruns.load() + 1);
      if (got > 0) primed = true;
      bridge.render(inBuf.data(), L.data(), R.data(), n);
      for (int i = 0; i < n; i++) { o[2 * (done + i)] = L[i]; o[2 * (done + i) + 1] = R[i]; }
      done += n;
    }
    return DataCallbackResult::Continue;
  }

  // Device change (headphones plugged/unplugged, Bluetooth, ...): reopen on Oboe's error thread.
  void onErrorAfterClose(AudioStream*, Result error) override {
    LOGE("stream error %s, restarting", convertToText(error));
    std::lock_guard<std::mutex> lk(mtx);
    if (!wantRunning) return;
    closeLocked();
    if (openLocked() != Result::OK) LOGE("restart failed");
  }

 private:
  Result openLocked() {
    AudioStreamBuilder ob;
    ob.setDirection(Direction::Output)
        ->setPerformanceMode(PerformanceMode::LowLatency)
        ->setSharingMode(SharingMode::Exclusive)
        ->setFormat(AudioFormat::Float)
        ->setChannelCount(ChannelCount::Stereo)
        ->setDataCallback(this)
        ->setErrorCallback(this);
    Result r = ob.openStream(out);
    if (r != Result::OK) return r;
    sr = out->getSampleRate();
    burst = std::max(1, out->getFramesPerBurst());
    out->setBufferSizeInFrames(burst * 2);  // double buffering: lowest glitch-free setting on most devices

    AudioStreamBuilder ib;
    ib.setDirection(Direction::Input)
        ->setPerformanceMode(PerformanceMode::LowLatency)
        ->setSharingMode(SharingMode::Exclusive)
        ->setFormat(AudioFormat::Float)
        ->setChannelCount(ChannelCount::Mono)
        ->setSampleRate(sr)
        ->setSampleRateConversionQuality(SampleRateConversionQuality::Medium)
        // VoicePerformance (API 29+) = low-latency, no AGC/NS/AEC; Unprocessed (API 24+) otherwise
        ->setInputPreset(sdk >= 29 ? InputPreset::VoicePerformance : InputPreset::Unprocessed);
    r = ib.openStream(in);
    if (r != Result::OK) return r;

    chunk = std::max(4096, out->getBufferCapacityInFrames());
    inBuf.assign((size_t)chunk, 0.f); L.assign((size_t)chunk, 0.f); R.assign((size_t)chunk, 0.f);
    bridge.prepare(sr, chunk);
    bridge.framesPerBurst.store((float)burst);
    primed = false;

    r = in->requestStart();
    if (r != Result::OK) return r;
    r = out->requestStart();
    if (r != Result::OK) return r;
    wantRunning = true;
    return Result::OK;
  }
  void closeLocked() {
    if (out) { out->stop(); out->close(); out.reset(); }
    if (in) { in->stop(); in->close(); in.reset(); }
  }
  static std::string err(const char* e) { return std::string("{\"ok\":false,\"err\":\"") + e + "\"}"; }

  std::mutex mtx;
  std::shared_ptr<AudioStream> in, out;
  std::vector<float> inBuf, L, R;
  int sr = 48000, burst = 192, chunk = 4096, sdk = 24;
  bool primed = false;
  std::atomic<bool> wantRunning{false};
};

static Duplex* gDuplex() { static Duplex d; return &d; }

extern "C" {

JNIEXPORT jstring JNICALL Java_com_canlitune_app_NativeAudio_nStart(JNIEnv* env, jclass, jint sdk) {
  return env->NewStringUTF(gDuplex()->start(sdk).c_str());
}
JNIEXPORT void JNICALL Java_com_canlitune_app_NativeAudio_nStop(JNIEnv*, jclass) { gDuplex()->stop(); }

JNIEXPORT void JNICALL Java_com_canlitune_app_NativeAudio_nSetParams(JNIEnv* env, jclass, jobjectArray keys, jdoubleArray vals) {
  jsize n = env->GetArrayLength(keys);
  jdouble* v = env->GetDoubleArrayElements(vals, nullptr);
  for (jsize i = 0; i < n; i++) {
    auto js = (jstring)env->GetObjectArrayElement(keys, i);
    const char* k = env->GetStringUTFChars(js, nullptr);
    int id = canlitune::paramIdFromName(k);
    if (id >= 0) gDuplex()->bridge.pushParam(id, v[i]);
    env->ReleaseStringUTFChars(js, k);
    env->DeleteLocalRef(js);
  }
  env->ReleaseDoubleArrayElements(vals, v, JNI_ABORT);
}
JNIEXPORT void JNICALL Java_com_canlitune_app_NativeAudio_nMeasure(JNIEnv*, jclass) { gDuplex()->bridge.requestMeasure(); }

// 16 floats: 12 engine telemetry + sampleRate, framesPerBurst, outLatencyMs, inLatencyMs
JNIEXPORT jfloatArray JNICALL Java_com_canlitune_app_NativeAudio_nTelemetry(JNIEnv* env, jclass) {
  Duplex* d = gDuplex();
  d->refreshLatency();
  float t[16];
  d->bridge.readTelemetry(t);
  t[12] = d->bridge.sr.load(); t[13] = d->bridge.framesPerBurst.load();
  t[14] = d->bridge.outLatencyMs.load(); t[15] = d->bridge.inLatencyMs.load();
  jfloatArray a = env->NewFloatArray(16);
  env->SetFloatArrayRegion(a, 0, 16, t);
  return a;
}

}  // extern "C"
