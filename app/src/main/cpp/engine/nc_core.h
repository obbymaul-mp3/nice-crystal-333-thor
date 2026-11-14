// Nice Crystal 333 — native real-time engine. Shared DSP pieces (a line-for-line port of src/dsp/core.js).
#pragma once
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>
#include <algorithm>
#include <atomic>
#include <memory>

namespace nc {
constexpr double PI = 3.14159265358979323846, TAU = PI * 2;
inline double clampd(double x, double a, double b) { return x < a ? a : x > b ? b : x; }
inline double rc(double t) { return t <= 0 ? 0 : t >= 1 ? 1 : 0.5 - 0.5 * std::cos(PI * t); }
inline double tanhF(double x) { if (x > 3) return 1; if (x < -3) return -1; const double x2 = x * x; return x * (27 + x2) / (27 + 9 * x2); }
inline double softClip(double x) { const double a = std::fabs(x); if (a <= 0.75) return x; const double y = 0.75 + 0.25 * tanhF((a - 0.75) / 0.25); return x < 0 ? -y : y; }
inline double jsRound(double x) { return std::floor(x + 0.5); }

// the same generator the web engine uses, so both can be compared sample for sample
struct Mulberry {
  uint32_t seed = 1;
  double next() {
    seed += 0x6D2B79F5u; uint32_t t = seed;
    t = (t ^ (t >> 15)) * (1u | t);
    t = (t + ((t ^ (t >> 7)) * (61u | t))) ^ t;
    return double(t ^ (t >> 14)) / 4294967296.0;
  }
};

struct Svf {
  double a1 = 0, a2 = 0, a3 = 0, k = 1.414, i1 = 0, i2 = 0, lp = 0, bp = 0, hp = 0;
  void set(double fc, double q, double sr) { fc = clampd(fc, 10, sr * 0.49); const double g = std::tan(PI * fc / sr); k = 1 / std::max(0.05, q); a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2; }
  inline void tick(double v0) { const double v3 = v0 - i2, v1 = a1 * i1 + a2 * v3, v2 = i2 + a2 * i1 + a3 * v3; i1 = 2 * v1 - i1; i2 = 2 * v2 - i2; lp = v2; bp = v1; hp = v0 - k * v1 - v2; }
  void reset() { i1 = i2 = 0; }
};

// stereo feedback-delay-network reverb, 8 lines
struct Fdn {
  static constexpr int N = 16384, M = N - 1;
  double sr; int len[8]; std::vector<float> line[8]; float lp[8] = {}, g[8] = {}, o[8] = {}; int w = 0;
  int apL[4]; std::vector<float> ap[8]; int apW = 0; std::vector<float> pre[2]; int preL, preW = 0;
  double ph = 0, phInc, outL = 0, outR = 0, dc = 0.3;
  explicit Fdn(double sr_) : sr(sr_) {
    const int base[8] = {1031, 1327, 1523, 1801, 2063, 2357, 2593, 2939}; const double sc = 1.35 * sr / 44100;
    for (int i = 0; i < 8; i++) { len[i] = std::min(N - 64, int(std::floor(base[i] * sc))); line[i].assign(N, 0.f); ap[i].assign(2048, 0.f); }
    const int a[4] = {142, 107, 379, 277}; for (int i = 0; i < 4; i++) apL[i] = int(std::floor(a[i] * sr / 44100));
    pre[0].assign(N, 0.f); pre[1].assign(N, 0.f); preL = int(std::floor(0.022 * sr)); phInc = TAU * 0.31 / sr; setDecay(4, 0.35);
  }
  void setDecay(double rt, double damp) {
    rt = std::max(0.15, rt); for (int i = 0; i < 8; i++) g[i] = float(std::pow(10.0, -3.0 * len[i] / (rt * sr)));
    const double fc = 11000 * std::pow(1500.0 / 11000, clampd(damp, 0, 1)); dc = 1 - std::exp(-TAU * fc / sr);
  }
  inline void process(double inL, double inR) {
    const int pw = preW; pre[0][pw] = float(inL); pre[1][pw] = float(inR);
    double xl = pre[0][(pw - preL) & M], xr = pre[1][(pw - preL) & M]; preW = (pw + 1) & M;
    const int aw = apW;
    for (int i = 0; i < 4; i++) {
      const int dl = apL[i]; float* b = ap[i].data(); double d = b[(aw - dl) & 2047], v = xl + 0.6 * d; b[aw] = float(v); xl = d - 0.6 * v;
      b = ap[i + 4].data(); d = b[(aw - dl - 11) & 2047]; v = xr + 0.6 * d; b[aw] = float(v); xr = d - 0.6 * v;
    }
    apW = (aw + 1) & 2047;
    ph += phInc; if (ph > TAU) ph -= TAU;
    const double mod = std::sin(ph) * 6; double sum = 0;
    for (int i = 0; i < 8; i++) {
      const double rp = w - len[i] + ((i & 1) ? mod : -mod), fl = std::floor(rp), t = rp - fl; const int i0 = int(fl); const float* L = line[i].data();
      const double a = L[i0 & M], b = L[(i0 + 1) & M]; double v = a + (b - a) * t;
      lp[i] = float(lp[i] + (v - lp[i]) * dc); v = double(lp[i]) * g[i]; o[i] = float(v); sum += o[i];
    }
    sum *= 0.25;
    for (int i = 0; i < 8; i++) line[i][w] = float(((i & 1) ? xr : xl) * 0.5 + o[i] - sum);
    w = (w + 1) & M;
    outL = (double(o[0]) + o[2] - o[4] + o[6]) * 0.5; outR = (double(o[1]) - o[3] + o[5] + o[7]) * 0.5;
  }
};

// a sound held in memory. Shared so the audio thread never frees one.
struct Sample { std::vector<float> L, R; double rate = 48000; int n() const { return int(L.size()); } };

// single-producer / single-consumer queue: control thread → audio thread without locks
template <class T, int CAP> struct Spsc {
  T buf[CAP]; std::atomic<int> r{0}, w{0};
  bool push(const T& v) { const int wi = w.load(std::memory_order_relaxed), nx = (wi + 1) % CAP; if (nx == r.load(std::memory_order_acquire)) return false; buf[wi] = v; w.store(nx, std::memory_order_release); return true; }
  bool pop(T& v) { const int ri = r.load(std::memory_order_relaxed); if (ri == w.load(std::memory_order_acquire)) return false; v = buf[ri]; r.store((ri + 1) % CAP, std::memory_order_release); return true; }
};
}  // namespace nc
