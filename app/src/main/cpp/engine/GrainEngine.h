// Nice Crystal 333 — the granular instrument, native. A port of GrainEngine in src/dsp/grain.js:
// same parameters, same order of operations, same random source, so the two can be compared sample for sample.
// Threading: process() runs on the audio thread and never allocates, locks or frees.
// Everything else is called from one control thread.
#pragma once
#include "nc_core.h"

namespace nc {

enum GP { POSITION, LENGTH, SCAN, SIZE, DENSITY, PITCH, FINE, SPRAY, SHATTER, REV, SPREAD, ATTACK, SUSTAIN, MIX, ENV_A, ENV_R,
          TONE, RESO, DRIVE, CRUSH, CHORUS, DELAY, DTIME, DFEED, SPACE, DECAY, VOLUME, GAIN,
          PLAY, FREEZE, MONITOR, KEYLOCK, GRID, DSYNC, XPOSE, BEND, GP_COUNT };
constexpr int GP_KNOBS = GAIN + 1;
extern const float GP_DEFAULTS[GP_COUNT];

constexpr int G_SUB = 64, G_RING = 1 << 21, G_RMASK = G_RING - 1, G_MAXG = 160, G_NV = 9;
constexpr double G_LIVE_SEC = 20;

struct LfoSpec { int shape = 0; float rate = 0.35f; bool sync = false; int div = 3; float depth = 0; int nTargets = 0; int target[6] = {}; float amount[6] = {}; };

struct Capture { int64_t start = 0; int len = 0, got = 0, tag = 0; std::vector<float> L, R; std::atomic<bool> done{false}; };

struct Snapshot {
  bool live = false; float total = 0, ph = 0, winS = 0, winL = 0, tape = 0; int nGrains = 0, nVoices = 0;
  float inPk = 0, outPk = 0, filled = 0, cap = -1, lfo[3] = {}, e[GP_KNOBS] = {};
  int nDots = 0; float dots[56 * 3] = {};   // x, level, pan for up to 56 grains
};

class GrainEngine {
 public:
  explicit GrainEngine(double sampleRate, bool offline = false);

  // ---- control thread
  void setParam(int i, float v) { if (i >= 0 && i < GP_COUNT) p[i].store(v, std::memory_order_relaxed); }
  float param(int i) const { return p[i].load(std::memory_order_relaxed); }
  void load(std::shared_ptr<Sample> s);            // swap the sound (4 ms fade, never clicks)
  void prepareLive();                              // allocates the 43 s input tape; call once before goLive(true)
  void goLive(bool on) { cmd(C_LIVE, on ? 1 : 0, 0); }
  void grab() { cmd(C_GRAB, 0, 0); }               // keep the last 20 s of input as the sound
  void noteOn(int note, float vel = 0.8f) { cmd(C_ON, note, vel); }
  void noteOff(int note) { cmd(C_OFF, note, 0); }
  void allOff() { cmd(C_ALLOFF, 0, 0); }
  void sustainPedal(bool on) { cmd(C_SUSTAIN, on ? 1 : 0, 0); }
  void setLfo(int i, const LfoSpec& o);
  void setClock(double bpm_, int64_t f0_) { bpmA.store(bpm_); f0A.store(f0_); }
  void setKeyLock(bool on, bool strictOctaves) { keyLock.store(on); strictOct.store(strictOctaves); }
  void startCapture(Capture* c) { capReq.store(c); }      // caller owns c and keeps it alive until c->done
  bool takeGrab(std::vector<float>& L, std::vector<float>& R, double& rate);   // true once after a grab landed
  void collect();                                  // frees sounds the audio thread has let go of; call now and then
  bool readSnapshot(Snapshot& out);                // latest picture for the display
  void seed(uint32_t s) { rng.seed = s; }

  // ---- audio thread
  void process(float* oL, float* oR, int frames, const float* inL, const float* inR);
  int64_t frame = 0;                               // set by the host before each process() when it owns the clock

 private:
  enum CmdType { C_ON, C_OFF, C_ALLOFF, C_SUSTAIN, C_LIVE, C_GRAB };
  struct Cmd { int type; int a; float b; };
  struct Grain { bool on = false, ring = false; double pos = 0, inc = 0; int len = 0, age = 0, start = 0, aN = 1, sN = 1; double gL = 0, gR = 0, amp = 0, ra = 1, rr = 1, pan = 0; };
  struct Voice { bool gate = false; int note = -1; double ratio = 1, vel = 1, env = 0, cd = 0; int64_t stamp = 0, tick = -1; };
  struct Lfo { LfoSpec o; double ph = 0, val = 0, hold = 0, tgt = 0; int lastSt = -1; };

  void cmd(int type, int a, float b) { queue.push(Cmd{type, a, b}); }
  void kill();
  void structural(int type, int a);
  void doGrab();
  void handle();
  void runLfos(int n);
  void rd(const float* L, const float* R, int n, int mask, double pos);
  double semis() const;
  void spawn(int vi, int offset);
  inline double genv(const Grain& g, int age) const;
  void sub(float* oL, float* oR, int off, int n);
  void setFilter(double tone, double reso);
  void publish();

  double sr; bool offline; Mulberry rng;
  std::atomic<float> p[GP_COUNT]; float e[GP_COUNT];
  // the sound in memory
  std::shared_ptr<Sample> silent; const Sample* cur = nullptr; const float* sL; const float* sR; int sN = 0; double sRate;
  std::vector<std::shared_ptr<Sample>> keep; std::atomic<const Sample*> loadReq{nullptr}; Spsc<const Sample*, 32> retired;
  // live tape
  std::vector<float> rL, rR, rpk; int wh = 0, filled = 0; bool hasRing = false; bool live = false;
  std::vector<float> gL_, gR_; std::atomic<int> grabLen{0}; bool onGrabStore = false;
  double bpm = 120; int64_t f0 = 0; std::atomic<double> bpmA{120}; std::atomic<int64_t> f0A{0};
  Grain grains[G_MAXG]; Voice voices[G_NV]; int64_t stamp = 0; int nextSlot = 0; bool sustain = false; bool held[128] = {};
  float rise[1026];
  struct { double mix, drv, vol, space, tone, reso, gate, ig, crush, chorus, delay, dfeed, dtime; } c, s;
  Svf fl[4]; double lastTone = -1, lastReso = -1, fcomp = 1; Fdn rev; double lastDecay = -1;
  std::vector<float> dl[2]; int dM, dW = 0; double dlp[2] = {}, dhp[2] = {};
  float ch[2][4096] = {}; int chW = 0; double chPh = 0, crH[2] = {}; int crC = 0; double dc[4] = {};
  float inL_[G_SUB], inR_[G_SUB], dL[G_SUB], dR[G_SUB], wL[G_SUB], wR[G_SUB];
  int pendType = -1, pendA = 0; Spsc<Cmd, 256> queue;
  double winS = 0, winL = 1, scanOff = 0, phF = 0, tapeAbs = 0, tapeOld = 0, tapeX = 1, lastWinS = -1, total = 1, gridRate = 0;
  Lfo lfos[3]; Spsc<std::pair<int, LfoSpec>, 16> lfoReq;
  double inPk = 0, outPk = 0; int activeGrains = 0, activeVoices = 0; const float* extL = nullptr; const float* extR = nullptr;
  std::atomic<bool> keyLock{false}, strictOct{false}; std::atomic<Capture*> capReq{nullptr}; Capture* capture = nullptr;
  double rl = 0, rr_ = 0;
  Snapshot snap; std::atomic<uint32_t> snapSeq{0}; int snapTick = 0;
};

// Everything passes through here on its way out: gentle leveller, soft clip, meters.
class MasterBus {
 public:
  explicit MasterBus(double sr_) : sr(sr_) {}
  std::atomic<float> vol{1}; std::atomic<float> pkL{0}, pkR{0};
  void process(const float* inL, const float* inR, float* oL, float* oR, int n);
 private:
  double sr, sv = 1, env = 0;
};
}  // namespace nc
