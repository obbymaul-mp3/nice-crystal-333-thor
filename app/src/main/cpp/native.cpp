// Nice Crystal 333 on Android: the audio device (Oboe) around the engine, and the bridge to Kotlin.
#include <jni.h>
#include <cstring>
#include <cstdio>
#include <oboe/Oboe.h>
#include <android/log.h>
#include <mutex>
#include <thread>
#include <string>
#include <chrono>
#include <cmath>
#include "GrainEngine.h"

#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, "NiceCrystal", __VA_ARGS__)
using namespace nc;

namespace {
constexpr int CHUNK = 1024;

class Audio : public oboe::AudioStreamDataCallback, public oboe::AudioStreamErrorCallback {
 public:
  std::unique_ptr<GrainEngine> engine; std::unique_ptr<MasterBus> master;
  std::shared_ptr<oboe::AudioStream> out, in; std::atomic<oboe::AudioStream*> inLive{nullptr}; std::mutex ctl;   // ctl guards every call that is not the audio callback
  std::atomic<bool> wantInput{false}, running{false}; std::atomic<int> xruns{0}, inFrames{0};
  float oL[CHUNK], oR[CHUNK], mL[CHUNK], mR[CHUNK], iL[CHUNK], iR[CHUNK]; std::vector<float> inBuf; int inCh = 0, inRate = 0; std::atomic<int> inDevice{0};
  std::vector<float> recL, recR; std::atomic<int> recPos{0}; std::atomic<bool> recOn{false};   // RECORD: the raw input, up to a minute
  double sr = 48000; bool outI16 = false; const char* outName = "";

  // Three ways of asking for the output. The first that gives a small block wins; otherwise the smallest block does.
  bool openOut() {
    struct Try { oboe::AudioApi api; oboe::AudioFormat fmt; const char* name; };
    const Try tries[3] = {{oboe::AudioApi::AAudio, oboe::AudioFormat::Float, "AAudio float"}, {oboe::AudioApi::AAudio, oboe::AudioFormat::I16, "AAudio 16-bit"}, {oboe::AudioApi::OpenSLES, oboe::AudioFormat::I16, "OpenSL"}};
    int best = -1, bestBurst = 1 << 30;
    for (int pass = 0; pass < 2; pass++) {
      for (int k = 0; k < 3; k++) {
        if (pass == 1 && k != best) continue;
        oboe::AudioStreamBuilder b;
        b.setAudioApi(tries[k].api)->setDirection(oboe::Direction::Output)->setPerformanceMode(oboe::PerformanceMode::LowLatency)->setSharingMode(oboe::SharingMode::Exclusive)
            ->setFormat(tries[k].fmt)->setFormatConversionAllowed(false)->setChannelCount(2)->setUsage(oboe::Usage::Game)->setDataCallback(this)->setErrorCallback(this);
        std::shared_ptr<oboe::AudioStream> s;
        if (b.openStream(s) != oboe::Result::OK) continue;
        const int burst = s->getFramesPerBurst(); LOGI("output try %s: %d Hz, block %d", tries[k].name, s->getSampleRate(), burst);
        if (pass == 1 || burst <= 480) { out = s; outI16 = s->getFormat() == oboe::AudioFormat::I16; outName = tries[k].name; out->setBufferSizeInFrames(burst * 2); sr = out->getSampleRate(); return true; }
        if (burst < bestBurst) { bestBurst = burst; best = k; }
        s->close();
      }
      if (best < 0) break;
    }
    return false;
  }
  bool openIn() {
    closeIn();
    oboe::AudioStreamBuilder b;
    b.setDirection(oboe::Direction::Input)->setPerformanceMode(oboe::PerformanceMode::LowLatency)->setSharingMode(oboe::SharingMode::Shared)
        ->setFormat(oboe::AudioFormat::Float)->setChannelCount(2)->setSampleRate(int(sr))->setSampleRateConversionQuality(oboe::SampleRateConversionQuality::Medium)
        ->setChannelConversionAllowed(true)->setFormatConversionAllowed(true)->setInputPreset(oboe::InputPreset::Unprocessed);
    if (inDevice.load() > 0) b.setDeviceId(inDevice.load());   // a USB device chosen by the app, instead of whatever Android prefers
    std::shared_ptr<oboe::AudioStream> s; oboe::Result r = b.openStream(s);
    if (r != oboe::Result::OK) { b.setChannelCount(oboe::ChannelCount::Unspecified); r = b.openStream(s); }   // a multi-channel USB device: take it as it is and use its first two channels
    if (r != oboe::Result::OK) { LOGI("input failed: %s", oboe::convertToText(r)); return false; }
    inCh = s->getChannelCount(); inRate = s->getSampleRate(); inBuf.assign(size_t(CHUNK) * 4 * std::max(1, inCh), 0.f); s->requestStart(); in = s; inLive.store(s.get());
    LOGI("input %d Hz, %d ch, device %d", s->getSampleRate(), inCh, s->getDeviceId());
    return true;
  }
  // the callback may be reading from the input right now: hide it first, give the callback a moment, then close
  void closeIn() { if (!in) return; inLive.store(nullptr); std::this_thread::sleep_for(std::chrono::milliseconds(40)); in->stop(); in->close(); in.reset(); }
  bool start() {
    std::lock_guard<std::mutex> g(ctl);
    if (running) return true;
    if (!openOut()) return false;
    if (!engine || std::abs(sr - engineSr) > 1) { engine.reset(new GrainEngine(sr)); master.reset(new MasterBus(sr)); engineSr = sr; engine->prepareLive(); engine->seed(uint32_t(std::chrono::steady_clock::now().time_since_epoch().count())); }
    if (wantInput) openIn();
    running = out->requestStart() == oboe::Result::OK; return running;
  }
  void stop() {
    std::lock_guard<std::mutex> g(ctl); running = false;
    if (out) { out->stop(); out->close(); out.reset(); } closeIn();
  }

  oboe::DataCallbackResult onAudioReady(oboe::AudioStream*, void* data, int32_t frames) override {
    float* o = static_cast<float*>(data); int16_t* o16 = static_cast<int16_t*>(data); GrainEngine* e = engine.get();
    int done = 0;
    while (done < frames) {
      const int n = std::min(CHUNK, frames - done); bool haveIn = false;
      oboe::AudioStream* is = inLive.load(std::memory_order_acquire);
      if (is && inCh > 0) {
        auto r = is->read(inBuf.data(), n, 0);
        const int got = r ? r.value() : 0;
        if (got > 0) { haveIn = true; inFrames += got;
          for (int i = 0; i < n; i++) { if (i < got) { iL[i] = inBuf[size_t(i) * inCh]; iR[i] = inCh > 1 ? inBuf[size_t(i) * inCh + 1] : iL[i]; } else { iL[i] = iR[i] = 0; } }
          // if the input has piled up (clocks drift), drop the backlog so the delay never grows
          auto av = is->getAvailableFrames(); if (av && av.value() > 6 * frames) is->read(inBuf.data(), std::min<int>(av.value() - 2 * frames, CHUNK * 4), 0);
        }
      }
      if (haveIn && recOn.load(std::memory_order_relaxed)) { const int p = recPos.load(std::memory_order_relaxed), m = std::min(n, int(recL.size()) - p); if (m > 0) { std::memcpy(recL.data() + p, iL, m * sizeof(float)); std::memcpy(recR.data() + p, iR, m * sizeof(float)); recPos.store(p + m, std::memory_order_release); } }
      e->process(oL, oR, n, haveIn ? iL : nullptr, haveIn ? iR : nullptr);
      master->process(oL, oR, mL, mR, n);
      if (outI16) for (int i = 0; i < n; i++) { o16[2 * (done + i)] = int16_t(std::lrintf(std::fmax(-1.f, std::fmin(1.f, mL[i])) * 32767.f)); o16[2 * (done + i) + 1] = int16_t(std::lrintf(std::fmax(-1.f, std::fmin(1.f, mR[i])) * 32767.f)); }
      else for (int i = 0; i < n; i++) { o[2 * (done + i)] = mL[i]; o[2 * (done + i) + 1] = mR[i]; }
      done += n;
    }
    return oboe::DataCallbackResult::Continue;
  }
  // headphones or a USB device plugged or unplugged: the stream dies and we open a fresh one on the new route
  void onErrorAfterClose(oboe::AudioStream* s, oboe::Result r) override {
    LOGI("stream closed: %s", oboe::convertToText(r));
    if (s->getDirection() == oboe::Direction::Output && running) { running = false; std::thread([this] { { std::lock_guard<std::mutex> g(ctl); out.reset(); } start(); }).detach(); }
  }
  double engineSr = 0;
};
Audio A;
}  // namespace

#define JNI(ret, name) extern "C" JNIEXPORT ret JNICALL Java_com_nicecrystal_thor_Native_##name
#define ENG if (!A.engine) return

JNI(jboolean, start)(JNIEnv*, jobject) { return A.start(); }
JNI(void, stop)(JNIEnv*, jobject) { A.stop(); }
JNI(jboolean, openInput)(JNIEnv*, jobject, jint device) { A.wantInput = true; A.inDevice = device; std::lock_guard<std::mutex> g(A.ctl); return A.running ? A.openIn() : true; }
JNI(jboolean, recStart)(JNIEnv*, jobject) {
  std::lock_guard<std::mutex> g(A.ctl); if (A.recOn) return true; const size_t cap = size_t(A.sr * 60);
  if (A.recL.size() != cap) { A.recL.assign(cap, 0.f); A.recR.assign(cap, 0.f); } A.recPos = 0; A.recOn = true; return true;
}
JNI(jfloat, recSeconds)(JNIEnv*, jobject) { return A.recOn ? float(A.recPos.load() / A.sr) : 0.f; }
// what was recorded, left then right, or null if it was shorter than a quarter of a second
JNI(jfloatArray, recStop)(JNIEnv* env, jobject) {
  std::lock_guard<std::mutex> g(A.ctl); if (!A.recOn) return nullptr; A.recOn = false; std::this_thread::sleep_for(std::chrono::milliseconds(40));
  const int n = A.recPos.load(); if (n < A.sr / 4) return nullptr;
  jfloatArray a = env->NewFloatArray(n * 2); env->SetFloatArrayRegion(a, 0, n, A.recL.data()); env->SetFloatArrayRegion(a, n, n, A.recR.data()); return a;
}
JNI(void, setParam)(JNIEnv*, jobject, jint i, jfloat v) { ENG; A.engine->setParam(i, v); }
JNI(jfloatArray, getParams)(JNIEnv* env, jobject) { jfloatArray a = env->NewFloatArray(GP_COUNT); if (A.engine) { float v[GP_COUNT]; for (int i = 0; i < GP_COUNT; i++) v[i] = A.engine->param(i); env->SetFloatArrayRegion(a, 0, GP_COUNT, v); } return a; }
JNI(void, noteOn)(JNIEnv*, jobject, jint n, jfloat vel) { ENG; std::lock_guard<std::mutex> g(A.ctl); A.engine->noteOn(n, vel); }
JNI(void, noteOff)(JNIEnv*, jobject, jint n) { ENG; std::lock_guard<std::mutex> g(A.ctl); A.engine->noteOff(n); }
JNI(void, allOff)(JNIEnv*, jobject) { ENG; std::lock_guard<std::mutex> g(A.ctl); A.engine->allOff(); }
JNI(void, sustain)(JNIEnv*, jobject, jboolean on) { ENG; std::lock_guard<std::mutex> g(A.ctl); A.engine->sustainPedal(on); }
JNI(void, setLive)(JNIEnv*, jobject, jboolean on) { ENG; std::lock_guard<std::mutex> g(A.ctl); A.engine->goLive(on); }
JNI(void, grab)(JNIEnv*, jobject) { ENG; std::lock_guard<std::mutex> g(A.ctl); A.engine->grab(); }
JNI(void, setClock)(JNIEnv*, jobject, jdouble bpm) { ENG; A.engine->setClock(bpm, 0); }
JNI(void, setKeyLock)(JNIEnv*, jobject, jboolean on) { ENG; A.engine->setKeyLock(on, false); }
JNI(void, loadSample)(JNIEnv* env, jobject, jfloatArray l, jfloatArray r, jint rate) {
  ENG; const jsize n = env->GetArrayLength(l); auto s = std::make_shared<Sample>(); s->rate = rate; s->L.resize(n); s->R.resize(n);
  env->GetFloatArrayRegion(l, 0, n, s->L.data()); env->GetFloatArrayRegion(r, 0, std::min(n, env->GetArrayLength(r)), s->R.data());
  std::lock_guard<std::mutex> g(A.ctl); A.engine->load(s); A.engine->collect();
}
// the grabbed sound, left then right, or null if nothing new has been grabbed
JNI(jfloatArray, takeGrab)(JNIEnv* env, jobject) {
  if (!A.engine) return nullptr; std::vector<float> L, R; double rate; { std::lock_guard<std::mutex> g(A.ctl); if (!A.engine->takeGrab(L, R, rate)) return nullptr; }
  jfloatArray a = env->NewFloatArray(jsize(L.size() * 2)); env->SetFloatArrayRegion(a, 0, jsize(L.size()), L.data()); env->SetFloatArrayRegion(a, jsize(L.size()), jsize(R.size()), R.data()); return a;
}
// [live,total,ph,winS,winL,tape,nGrains,nVoices,inPk,outPk,filled,cap,lfo×3,masterL,masterR, e×28, nDots, dots×3…]
JNI(jfloatArray, snapshot)(JNIEnv* env, jobject) {
  Snapshot s; float v[18 + GP_KNOBS + 56 * 3] = {}; int n = 0;
  if (A.engine && A.engine->readSnapshot(s)) {
    v[n++] = s.live; v[n++] = s.total; v[n++] = s.ph; v[n++] = s.winS; v[n++] = s.winL; v[n++] = s.tape; v[n++] = float(s.nGrains); v[n++] = float(s.nVoices);
    v[n++] = s.inPk; v[n++] = s.outPk; v[n++] = s.filled; v[n++] = s.cap; for (int i = 0; i < 3; i++) v[n++] = s.lfo[i];
    v[n++] = A.master->pkL.exchange(0); v[n++] = A.master->pkR.exchange(0);
    for (int i = 0; i < GP_KNOBS; i++) v[n++] = s.e[i]; v[n++] = float(s.nDots); for (int i = 0; i < s.nDots * 3; i++) v[n++] = s.dots[i];
  }
  jfloatArray a = env->NewFloatArray(n); env->SetFloatArrayRegion(a, 0, n, v); return a;
}
JNI(jstring, info)(JNIEnv* env, jobject) {
  std::string t = "audio off";
  if (A.out) { char b[256]; const double ms = 1000.0 * A.out->getBufferSizeInFrames() / A.out->getSampleRate();
    snprintf(b, sizeof b, "%d Hz · block %d · buffer %.0f ms · %s · %s · input %s", A.out->getSampleRate(), A.out->getFramesPerBurst(), ms,
             A.out->getPerformanceMode() == oboe::PerformanceMode::LowLatency ? "fast" : "slow path", A.outName, A.in ? (A.inFrames.load() > 0 ? "running" : "open, silent") : "off"); t = b;
    if (A.in) { snprintf(b, sizeof b, " %d ch %d Hz", A.inCh, A.inRate); t += b; } }
  return env->NewStringUTF(t.c_str());
}
