// Android audio engine: Oboe full-duplex (mic -> CanlıTune DSP -> output) + JNI bridge.
// The output stream's data callback drives everything. Each callback drains every
// frame the mic has produced into an elastic FIFO, which is read through a resampler
// whose ratio tracks the real mic/output clock ratio (DriftFifo). Mic and headphones
// on different clocks (Bluetooth, USB) therefore never cause dropped or zero-filled
// frames — previously the source of periodic clicks/crackle.
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
#include "DriftFifo.hpp"
#include "Karaoke.hpp"

#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, "CanliTune", __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, "CanliTune", __VA_ARGS__)

using namespace oboe;

class Duplex : public AudioStreamDataCallback, public AudioStreamErrorCallback {
 public:
  canlitune::NativeBridge bridge;
  canlitune::BackingTrack beat;
  canlitune::Recorder rec;
  int sampleRate() const { return sr; }

  std::string start(int sdkInt, int micId, int outId) {
    std::lock_guard<std::mutex> lk(mtx);
    sdk = sdkInt; micDevice = micId; outDevice = outId;
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
    if (out) {
      auto x = out->getXRunCount(); if (x) outXruns.store(x.value());
      outBufFrames.store(out->getBufferSizeInFrames());
      mmap.store(OboeExtensions::isMMapUsed(out.get()) ? 1 : 0);
    }
  }
  std::atomic<int> outXruns{0}, outBufFrames{0}, mmap{0};
  std::atomic<long> fifoUnder{0};
  std::atomic<float> fifoMs{0};

  // ---- real-time callback ----
  DataCallbackResult onAudioReady(AudioStream*, void* audioData, int32_t numFrames) override {
    if (tuner) tuner->tune();  // grows the output buffer only if the device underruns
    float* o = static_cast<float*>(audioData);
    if (in) {  // drain everything the mic has produced since the last callback (non-blocking)
      for (int k = 0; k < 16; k++) {
        auto rr = in->read(rdBuf.data(), (int32_t)rdBuf.size(), 0);
        if (!rr || rr.value() <= 0) break;
        fifo.push(rdBuf.data(), rr.value());
        if (rr.value() < (int32_t)rdBuf.size()) break;
      }
    }
    int done = 0;
    while (done < numFrames) {
      int n = std::min(numFrames - done, chunk);
      fifo.pull(inBuf.data(), n);
      bridge.render(inBuf.data(), L.data(), R.data(), n);
      beat.render(bL.data(), bR.data(), rL.data(), rR.data(), n, sr);
      // recording mix: voice + beat delayed by the round-trip latency (so the take is in time)
      for (int i = 0; i < n; i++) { rL[i] += L[i]; rR[i] += R[i]; }
      rec.push(rL.data(), rR.data(), n);
      for (int i = 0; i < n; i++) {
        o[2 * (done + i)] = canlitune::softClip(L[i] + bL[i]);
        o[2 * (done + i) + 1] = canlitune::softClip(R[i] + bR[i]);
      }
      done += n;
    }
    fifoMs.store((float)(fifo.fill() * 1000.0 / sr));
    fifoUnder.store(fifo.underflows);
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
    if (outDevice > 0) ob.setDeviceId(outDevice);  // user-chosen speaker / soundbar / headphones
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
    // always the phone's own mic: a Bluetooth headset mic would be narrow-band (8-16 kHz SCO) and laggy
    if (micDevice > 0) ib.setDeviceId(micDevice);
    r = ib.openStream(in);
    if (r != Result::OK) return r;

    chunk = std::max(4096, out->getBufferCapacityInFrames());
    inBuf.assign((size_t)chunk, 0.f); L.assign((size_t)chunk, 0.f); R.assign((size_t)chunk, 0.f); rdBuf.assign(4096, 0.f);
    bL.assign((size_t)chunk, 0.f); bR.assign((size_t)chunk, 0.f); rL.assign((size_t)chunk, 0.f); rR.assign((size_t)chunk, 0.f);
    fifo.reset(std::max(128, in->getFramesPerBurst()), sr);
    tuner = std::make_unique<LatencyTuner>(*out);
    bridge.prepare(sr, chunk);
    bridge.framesPerBurst.store((float)burst);

    r = in->requestStart();
    if (r != Result::OK) return r;
    r = out->requestStart();
    if (r != Result::OK) return r;
    wantRunning = true;
    return Result::OK;
  }
  void closeLocked() {
    if (out) { out->stop(); out->close(); out.reset(); }
    tuner.reset();
    if (in) { in->stop(); in->close(); in.reset(); }
  }
  static std::string err(const char* e) { return std::string("{\"ok\":false,\"err\":\"") + e + "\"}"; }

  std::mutex mtx;
  std::shared_ptr<AudioStream> in, out;
  std::vector<float> inBuf, L, R, rdBuf, bL, bR, rL, rR;
  canlitune::DriftFifo fifo;
  std::unique_ptr<LatencyTuner> tuner;
  int sr = 48000, burst = 192, chunk = 4096, sdk = 24, micDevice = 0, outDevice = 0;
  std::atomic<bool> wantRunning{false};
};

static Duplex* gDuplex() { static Duplex d; return &d; }

extern "C" {

JNIEXPORT jstring JNICALL Java_com_canlitune_app_NativeAudio_nStart(JNIEnv* env, jclass, jint sdk, jint micId, jint outId) {
  return env->NewStringUTF(gDuplex()->start(sdk, micId, outId).c_str());
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

// 26 floats (21..25: beatPosSec, beatLenSec, beatPlaying, recSeconds(-1 = off), recDropped);
// first 21: 12 engine telemetry + sampleRate, framesPerBurst, outLatencyMs, inLatencyMs,
// outXruns, outBufferFrames, mmap(0/1), micFifoUnderflows, micFifoMs
JNIEXPORT jfloatArray JNICALL Java_com_canlitune_app_NativeAudio_nTelemetry(JNIEnv* env, jclass) {
  Duplex* d = gDuplex();
  d->refreshLatency();
  float t[26];
  d->bridge.readTelemetry(t);
  t[12] = d->bridge.sr.load(); t[13] = d->bridge.framesPerBurst.load();
  t[14] = d->bridge.outLatencyMs.load(); t[15] = d->bridge.inLatencyMs.load();
  t[16] = (float)d->outXruns.load(); t[17] = (float)d->outBufFrames.load(); t[18] = (float)d->mmap.load();
  t[19] = (float)d->fifoUnder.load(); t[20] = d->fifoMs.load();
  t[21] = d->beat.posSec.load(); t[22] = d->beat.lenSec.load(); t[23] = d->beat.playing.load() ? 1.f : 0.f;
  t[24] = d->rec.active.load() ? (float)((double)d->rec.frames.load() / d->rec.sr) : -1.f; t[25] = (float)d->rec.dropped.load();
  jfloatArray a = env->NewFloatArray(26);
  env->SetFloatArrayRegion(a, 0, 26, t);
  return a;
}

// ---- backing track ----
JNIEXPORT void JNICALL Java_com_canlitune_app_NativeAudio_nBeatBegin(JNIEnv*, jclass, jlong frames, jdouble rate) { gDuplex()->beat.begin(frames, rate); }
JNIEXPORT void JNICALL Java_com_canlitune_app_NativeAudio_nBeatChunk(JNIEnv* env, jclass, jbyteArray data) {
  jsize n = env->GetArrayLength(data);
  jbyte* b = env->GetByteArrayElements(data, nullptr);
  gDuplex()->beat.append(reinterpret_cast<const int16_t*>(b), n / 4);  // little-endian int16 stereo
  env->ReleaseByteArrayElements(data, b, JNI_ABORT);
}
// cmd: 0 pause, 1 play, 2 seek(sec), 3 gain, 4 clear, 5 record lag (sec)
JNIEXPORT void JNICALL Java_com_canlitune_app_NativeAudio_nBeatCtl(JNIEnv*, jclass, jint cmd, jdouble v) {
  auto& b = gDuplex()->beat;
  switch (cmd) {
    case 0: b.playing.store(false); break;
    case 1: b.playing.store(true); break;
    case 2: b.seek(v); break;
    case 3: b.gain.store((float)v); break;
    case 4: b.clear(); break;
    case 5: b.recLagSec.store(v); break;
    default: break;
  }
}
// ---- recorder ----
JNIEXPORT jboolean JNICALL Java_com_canlitune_app_NativeAudio_nRecStart(JNIEnv* env, jclass, jstring path) {
  const char* p = env->GetStringUTFChars(path, nullptr);
  bool ok = gDuplex()->rec.start(p, gDuplex()->sampleRate());
  env->ReleaseStringUTFChars(path, p);
  return ok ? JNI_TRUE : JNI_FALSE;
}
JNIEXPORT jlong JNICALL Java_com_canlitune_app_NativeAudio_nRecStop(JNIEnv*, jclass) { return (jlong)gDuplex()->rec.stop(); }

}  // extern "C"
