#include "GrainEngine.h"

namespace nc {

const float GP_DEFAULTS[GP_COUNT] = {0.3f, 1, 0.8536f, 0.62f, 0.55f, 0.5f, 0.5f, 0.25f, 0, 0, 0.5f, 0.5f, 0, 0.85f, 0.3f, 0.55f,
                                     0.5f, 0.15f, 0, 0, 0, 0, 0.5f, 0.4f, 0.3f, 0.5f, 0.8f, 0.5f, 0, 0, 0, 0, 0, 1, 0, 0};
static const int GRID_DIVS[7] = {0, 1, 2, 3, 4, 6, 8};
static const double DELAY_DIVS[11] = {0.125, 1.0 / 6, 0.25, 1.0 / 3, 0.375, 0.5, 2.0 / 3, 0.75, 1, 1.5, 2};
static const double LFO_DIVS[8] = {32, 16, 8, 4, 2, 1, 0.5, 0.25};

namespace pm {
inline double size(double v) { return 0.004 * std::pow(500.0, v); }
inline double density(double v) { return 0.5 * std::pow(240.0, v); }
inline double pitch(double v) { return (v - 0.5) * 48; }
inline double fine(double v) { return (v - 0.5) * 2; }
inline double len(double v, double total) { return total <= 0.01 ? total : std::min(total, 0.01 * std::pow(total / 0.01, v)); }
inline double scan(double v) { const double x = (v - 0.5) * 2; return (x > 0 ? 1 : x < 0 ? -1 : 0) * x * x * 2; }
inline double envA(double v) { return 0.001 * std::pow(2000.0, v); }
inline double envR(double v) { return 0.01 * std::pow(800.0, v); }
inline double reso(double v) { return 0.707 + v * v * 13; }
inline double decay(double v) { return 0.3 * std::pow(66.0, v); }
inline double dfree(double v) { return 0.02 * std::pow(75.0, v); }
inline int ddiv(double v) { return std::min(10, int(std::floor(v * 11))); }
inline double vol(double v) { return v * v * 1.6; }
inline double gain(double v) { return std::pow(10.0, (v - 0.5) * 48 / 20); }
inline double lfoRate(double v) { return 0.02 * std::pow(1500.0, v); }
}  // namespace pm

GrainEngine::GrainEngine(double sampleRate, bool offline_) : sr(sampleRate), offline(offline_), rev(sampleRate) {
  for (int i = 0; i < GP_COUNT; i++) { p[i].store(GP_DEFAULTS[i]); e[i] = GP_DEFAULTS[i]; }
  silent = std::make_shared<Sample>(); silent->L.assign(1, 0.f); silent->R.assign(1, 0.f); silent->rate = sr;
  cur = silent.get(); sL = cur->L.data(); sR = cur->R.data(); sN = 0; sRate = sr;
  for (int i = 0; i < 1026; i++) rise[i] = i > 1024 ? 1.f : float(0.5 - 0.5 * std::cos(PI * i / 1024));
  auto k = [&](double t) { return 1 - std::exp(-1 / (t * sr / G_SUB)); };
  c = {k(0.03), k(0.03), k(0.03), k(0.08), k(0.02), k(0.03), k(0.004), k(0.03), k(0.03), k(0.05), k(0.05), k(0.05), k(0.12)};
  s = {GP_DEFAULTS[MIX], 0, pm::vol(GP_DEFAULTS[VOLUME]), GP_DEFAULTS[SPACE], 0.5, 0.15, offline ? 1.0 : 0.0, 1, 0, 0, 0, 0.4, 0.25 * sr};
  const int dn = 1 << int(std::ceil(std::log2(sr * 2.2))); dl[0].assign(dn, 0.f); dl[1].assign(dn, 0.f); dM = dn - 1;
  for (int i = 0; i < 3; i++) lfos[i].ph = i * 0.33;
  std::memset(inL_, 0, sizeof inL_); std::memset(inR_, 0, sizeof inR_);
}

// ---------------------------------------------------------------- control thread
void GrainEngine::load(std::shared_ptr<Sample> smp) {
  if (!smp || smp->L.empty()) return; if (smp->R.size() != smp->L.size()) smp->R = smp->L;
  keep.push_back(smp);
  const Sample* old = loadReq.exchange(smp.get());   // a request the audio thread never picked up can go straight away
  if (old) keep.erase(std::remove_if(keep.begin(), keep.end(), [&](const std::shared_ptr<Sample>& x) { return x.get() == old; }), keep.end());
  if (offline) { pendType = 0; structural(0, 0); pendType = -1; }
}
void GrainEngine::prepareLive() {
  if (hasRing) return; rL.assign(G_RING, 0.f); rR.assign(G_RING, 0.f); rpk.assign(G_RING >> 8, 0.f);
  const int cap = int(std::floor(G_LIVE_SEC * sr)); gL_.assign(cap, 0.f); gR_.assign(cap, 0.f); hasRing = true;
}
void GrainEngine::setLfo(int i, const LfoSpec& o) { if (i < 0 || i > 2) return; LfoSpec x = o; int n = 0; for (int k = 0; k < o.nTargets && n < 6; k++) if (o.target[k] >= 0 && o.target[k] < GP_KNOBS) { x.target[n] = o.target[k]; x.amount[n] = o.amount[k]; n++; } x.nTargets = n; if (offline) lfos[i].o = x; else lfoReq.push({i, x}); }
bool GrainEngine::takeGrab(std::vector<float>& L, std::vector<float>& R, double& rate) {
  const int n = grabLen.exchange(0); if (n <= 0) return false; L.assign(gL_.begin(), gL_.begin() + n); R.assign(gR_.begin(), gR_.begin() + n); rate = sr; return true;
}
void GrainEngine::collect() { const Sample* r; while (retired.pop(r)) keep.erase(std::remove_if(keep.begin(), keep.end(), [&](const std::shared_ptr<Sample>& x) { return x.get() == r; }), keep.end()); }
bool GrainEngine::readSnapshot(Snapshot& out) {
  for (int tries = 0; tries < 4; tries++) { const uint32_t a = snapSeq.load(std::memory_order_acquire); if (a & 1) continue; out = snap; if (snapSeq.load(std::memory_order_acquire) == a) return true; }
  return false;
}

// ---------------------------------------------------------------- audio thread
void GrainEngine::kill() { for (auto& g : grains) g.on = false; for (auto& v : voices) { v.cd = 0; v.tick = -1; } tapeX = 1; lastWinS = -1; }

void GrainEngine::structural(int type, int a) {
  kill();
  if (type == 0) {   // load
    const Sample* nx = loadReq.exchange(nullptr); if (!nx) return;
    if (cur && cur != silent.get() && !onGrabStore) retired.push(cur);
    cur = nx; onGrabStore = false; sL = nx->L.data(); sR = nx->R.data(); sN = nx->n(); sRate = nx->rate; live = false; scanOff = 0;
  } else if (type == 1) { live = a != 0 && hasRing; if (live) { filled = 0; std::fill(rpk.begin(), rpk.end(), 0.f); } }
  else if (type == 2) doGrab();
}
void GrainEngine::doGrab() {
  if (!hasRing) return; const int n = std::min(filled, int(std::floor(G_LIVE_SEC * sr))); if (n < sr * 0.2) return;
  const int st = wh - n; for (int i = 0; i < n; i++) { const int q = (st + i) & G_RMASK; gL_[i] = rL[q]; gR_[i] = rR[q]; }
  if (cur && cur != silent.get() && !onGrabStore) retired.push(cur);
  cur = silent.get(); onGrabStore = true; sL = gL_.data(); sR = gR_.data(); sN = n; sRate = sr; live = false; scanOff = 0; lastWinS = -1;
  grabLen.store(n);
}
void GrainEngine::handle() {
  if (pendType >= 0) return;
  Voice* V = voices; Cmd cm;
  while (queue.pop(cm)) {
    if (cm.type == C_LIVE || cm.type == C_GRAB) { if (cm.type == C_LIVE && ((cm.a != 0) == live)) continue; pendType = cm.type == C_LIVE ? 1 : 2; pendA = cm.a; return; }
    if (cm.type == C_ON) {
      int sl = -1; if (cm.a >= 0 && cm.a < 128) held[cm.a] = false;
      for (int i = 1; i < G_NV; i++) if (V[i].note == cm.a && V[i].gate) { sl = i; break; }
      if (sl < 0) for (int i = 1; i < G_NV; i++) if (!V[i].gate && V[i].env < 0.001) { sl = i; break; }
      if (sl < 0) { double best = 1e300; for (int i = 1; i < G_NV; i++) { const double stv = double(V[i].stamp) + (V[i].gate ? 1e9 : 0); if (stv < best) { best = stv; sl = i; } } }
      Voice& v = V[sl]; v.note = cm.a; v.ratio = std::pow(2.0, (cm.a - 60) / 12.0); v.vel = clampd(cm.b, 0.05, 1); v.gate = true; v.stamp = ++stamp; v.cd = 0; v.tick = -1;
    } else if (cm.type == C_OFF) { if (sustain) { if (cm.a >= 0 && cm.a < 128) held[cm.a] = true; } else for (int i = 1; i < G_NV; i++) if (V[i].note == cm.a) V[i].gate = false; }
    else if (cm.type == C_ALLOFF) { std::memset(held, 0, sizeof held); for (int i = 1; i < G_NV; i++) V[i].gate = false; }
    else if (cm.type == C_SUSTAIN) { sustain = cm.a != 0; if (!sustain) { for (int n = 0; n < 128; n++) if (held[n]) for (int i = 1; i < G_NV; i++) if (V[i].note == n) V[i].gate = false; std::memset(held, 0, sizeof held); } }
  }
}

void GrainEngine::runLfos(int n) {
  for (int i = 0; i < GP_COUNT; i++) e[i] = p[i].load(std::memory_order_relaxed);
  for (auto& l : lfos) {
    const double hz = l.o.sync ? bpm / 60 / LFO_DIVS[std::clamp(l.o.div, 0, 7)] : pm::lfoRate(l.o.rate);
    bool wrapped = false; const double before = l.ph;
    if (l.o.sync) { l.ph = std::fmod(std::fmod(double(frame - f0) / sr * hz, 1.0) + 1.0, 1.0); wrapped = l.ph < before; }
    else { l.ph += hz * n / sr; if (l.ph >= 1) { l.ph -= std::floor(l.ph); wrapped = true; } }
    const double ph = l.ph; double v;
    switch (l.o.shape) {
      case 0: v = std::sin(TAU * ph); break;
      case 1: v = ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph; break;
      case 2: v = 2 * ph - 1; break;
      case 3: v = ph < 0.5 ? 1 : -1; break;
      case 4: { const int st = int(std::floor(ph * 8)); if (st != l.lastSt || wrapped) { l.lastSt = st; l.hold = rng.next() * 2 - 1; } v = l.hold; break; }
      default: { if (wrapped) l.tgt = rng.next() * 2 - 1; l.hold += (l.tgt - l.hold) * std::min(1.0, hz * n / sr * 4); v = l.hold; }
    }
    l.val = v; if (l.o.depth <= 0) continue;
    for (int k = 0; k < l.o.nTargets; k++) { const int t = l.o.target[k]; e[t] = float(clampd(e[t] + v * l.o.depth * l.o.amount[k] * 0.5, 0, 1)); }
  }
}

void GrainEngine::rd(const float* L, const float* R, int n, int mask, double pos) {
  const double fl_ = std::floor(pos); long long i1 = (long long)fl_; const double t = pos - fl_; long long i0, i2, i3;
  if (mask) { i0 = (i1 - 1) & mask; i2 = (i1 + 1) & mask; i3 = (i1 + 2) & mask; i1 &= mask; }
  else { i1 %= n; if (i1 < 0) i1 += n; i0 = i1 == 0 ? n - 1 : i1 - 1; i2 = i1 + 1 >= n ? i1 + 1 - n : i1 + 1; i3 = i2 + 1 >= n ? i2 + 1 - n : i2 + 1; }
  double x0 = L[i0], x1 = L[i1], x2 = L[i2], x3 = L[i3];
  rl = (((0.5 * (x3 - x0) + 1.5 * (x1 - x2)) * t + (x0 - 2.5 * x1 + 2 * x2 - 0.5 * x3)) * t + 0.5 * (x2 - x0)) * t + x1;
  x0 = R[i0]; x1 = R[i1]; x2 = R[i2]; x3 = R[i3];
  rr_ = (((0.5 * (x3 - x0) + 1.5 * (x1 - x2)) * t + (x0 - 2.5 * x1 + 2 * x2 - 0.5 * x3)) * t + 0.5 * (x2 - x0)) * t + x1;
}
double GrainEngine::semis() const { return pm::pitch(e[PITCH]) + pm::fine(e[FINE]) + e[XPOSE] + e[BEND]; }

void GrainEngine::spawn(int vi, int offset) {
  int slot = -1; for (int k = 0; k < G_MAXG; k++) { const int i = (nextSlot + k) % G_MAXG; if (!grains[i].on) { slot = i; break; } }
  if (slot < 0) return; nextSlot = (slot + 1) % G_MAXG;
  const Voice& v = voices[vi]; const double sizeS = pm::size(e[SIZE]); const int len = std::max(32, int(sizeS * sr));
  double sm = semis(); const double sh = e[SHATTER];
  if (sh > 0.001) {
    if (keyLock.load(std::memory_order_relaxed) || e[KEYLOCK] > 0.5) { if (rng.next() < sh * 0.7) { const double u = rng.next(); sm += strictOct.load(std::memory_order_relaxed) ? (u < 0.4 ? 12 : u < 0.8 ? -12 : u < 0.9 ? 24 : -24) : (u < 0.3 ? 12 : u < 0.6 ? -12 : u < 0.75 ? 7 : u < 0.9 ? -5 : u < 0.95 ? 24 : -24); } }
    else sm += (rng.next() * 2 - 1) * sh * sh * 12;
  }
  const double ratio = v.ratio * std::pow(2.0, sm / 12); const bool rv = rng.next() < e[REV]; const double spray = e[SPRAY];
  Grain& g = grains[slot]; double start, inc;
  if (!live) {
    const double srcF = sRate / sr, span = len * ratio * srcF, wl = winL;
    const double s0 = phF + (rng.next() * 2 - 1) * spray * spray * wl, rel = std::fmod(std::fmod(s0 - winS, wl) + wl, wl);
    start = winS + rel + (rv ? span : 0); inc = ratio * srcF * (rv ? -1 : 1); g.ring = false;
  } else {
    const double W = std::min(filled, int(std::floor(G_LIVE_SEC * sr))); const bool frozen = e[FREEZE] > 0.5; const double margin = 4 * G_SUB + 16, span = len * ratio;
    const double r1 = rng.next(), r2 = rng.next();
    const double s0 = winS + r1 * winL + (r2 * 2 - 1) * spray * spray * winL * 0.5;
    double abs = wh - W + clampd(s0, 0, W);
    const double latest = wh - margin - (rv ? 0 : std::max(0.0, span - (frozen ? 0 : len)));
    if (abs > latest) abs = latest; if (rv) abs = std::min(wh - margin, abs + span);
    if (W < span + margin * 2) return;
    start = abs; inc = ratio * (rv ? -1 : 1); g.ring = true;
  }
  const double pan = clampd(e[SPREAD] * (rng.next() * 2 - 1), -1, 1), ang = (pan + 1) * PI / 4;
  const double shS = 0.95 * e[SUSTAIN], shA = (1 - shS) * clampd(e[ATTACK], 0.02, 0.98);
  const int aN = std::max(1, int(jsRound(shA * len))), sN_ = std::min(len - 1, aN + int(jsRound(shS * len))), rN = std::max(1, len - sN_);
  const double comp = std::sqrt(0.375 / (0.375 * (1 - shS) + shS)), rate = gridRate != 0 ? gridRate : pm::density(e[DENSITY]);
  const double norm = comp / std::sqrt(std::max(1.0, rate * sizeS));
  g.on = true; g.pos = start; g.inc = inc; g.len = len; g.age = 0; g.start = offset; g.gL = std::cos(ang); g.gR = std::sin(ang);
  g.amp = v.env * norm * (vi == 0 ? 1 : 0.8); g.aN = aN; g.sN = sN_; g.ra = 1024.0 / aN; g.rr = 1024.0 / rN; g.pan = pan;
}
inline double GrainEngine::genv(const Grain& g, int age) const {
  if (age < g.aN) { const double f = age * g.ra; const int i = int(f); return rise[i] + (double(rise[i + 1]) - rise[i]) * (f - i); }
  if (age < g.sN) return 1;
  const double f = (g.len - age) * g.rr; const int i = int(f); return rise[i] + (double(rise[i + 1]) - rise[i]) * (f - i);
}

void GrainEngine::process(float* oL, float* oR, int frames, const float* inL, const float* inR) {
  extL = inL; extR = inR ? inR : inL;
  bpm = bpmA.load(std::memory_order_relaxed); f0 = f0A.load(std::memory_order_relaxed);
  { std::pair<int, LfoSpec> lr; while (lfoReq.pop(lr)) lfos[lr.first].o = lr.second; }
  if (pendType < 0 && loadReq.load(std::memory_order_relaxed)) pendType = 0;
  if (!capture) capture = capReq.exchange(nullptr);
  if (pendType >= 0 && (s.gate < 0.002 || offline)) { const int t = pendType, a = pendA; pendType = -1; structural(t, a); }
  handle();
  for (int off = 0; off < frames; off += G_SUB) sub(oL, oR, off, std::min(G_SUB, frames - off));
  int n = 0; for (auto& g : grains) if (g.on) n++; activeGrains = n;
  snapTick += frames; if (snapTick >= sr / 30) { snapTick = 0; publish(); }
}

void GrainEngine::sub(float* oL, float* oR, int off, int n) {
  runLfos(n);
  const bool frozen = e[FREEZE] > 0.5; const double inv = 1.0 / n;
#define ST(K, T) ([&] { const double a_ = s.K; s.K += ((T) - s.K) * c.K; return a_; }())
  const double mix0 = ST(mix, e[MIX]), mix1 = s.mix, drv0 = ST(drv, e[DRIVE]), drv1 = s.drv, vol0 = ST(vol, pm::vol(e[VOLUME])), vol1 = s.vol;
  const double g0 = ST(gate, pendType >= 0 ? 0 : 1), g1 = s.gate, ig0 = ST(ig, pm::gain(e[GAIN])), ig1 = s.ig;
  ST(tone, e[TONE]); ST(reso, e[RESO]); ST(space, e[SPACE]); ST(crush, e[CRUSH]); ST(chorus, e[CHORUS]); ST(delay, e[DELAY]); ST(dfeed, e[DFEED]);
  const double dTarget = clampd((e[DSYNC] > 0.5 ? DELAY_DIVS[pm::ddiv(e[DTIME])] * 60 / bpm : pm::dfree(e[DTIME])) * sr, 32, dM - 64); ST(dtime, dTarget);
#undef ST
  if (std::fabs(s.tone - lastTone) > 1e-4 || std::fabs(s.reso - lastReso) > 1e-3) setFilter(s.tone, s.reso);
  if (std::fabs(e[DECAY] - lastDecay) > 0.002) { lastDecay = e[DECAY]; rev.setDecay(pm::decay(e[DECAY]), 0.3 + 0.3 * (1 - e[DECAY])); }

  // ---- input, written to the live tape
  const bool want = live || e[MONITOR] > 0.5;
  for (int i = 0; i < n; i++) {
    double l = 0, r = 0; if (want && extL) { l = extL[off + i]; r = extR[off + i]; }
    const double g = ig0 + (ig1 - ig0) * (i + 1) * inv; l *= g; r *= g; inL_[i] = float(l); inR_[i] = float(r);
    const double a = std::max(std::fabs(double(inL_[i])), std::fabs(double(inR_[i]))); if (a > inPk) inPk = a;
  }
  if (live && !frozen) {
    for (int i = 0; i < n; i++) { const int w = wh; rL[w] = inL_[i]; rR[w] = inR_[i]; const float m = (std::fabs(inL_[i]) + std::fabs(inR_[i])) * 0.5f; const int ci = w >> 8; if ((w & 255) == 0) rpk[ci] = m; else if (m > rpk[ci]) rpk[ci] = m; wh = (w + 1) & G_RMASK; }
    filled = std::min(G_RING - 4096, filled + n);
  }

  // ---- the slice
  const double tot = live ? std::min(filled, int(std::floor(G_LIVE_SEC * sr))) : sN, rate = live ? sr : sRate; const bool have = tot > 512;
  if (have) {
    const double lenF = clampd(pm::len(e[LENGTH], tot / rate) * rate, std::min(tot, 64.0), tot);
    winS = e[POSITION] * (tot - lenF); winL = lenF;
    if (!frozen && !live) { scanOff += pm::scan(e[SCAN]) * n * (rate / sr) / lenF; scanOff -= std::floor(scanOff); }
    phF = winS + (live ? 0.5 : scanOff) * lenF; total = tot;
  }

  // ---- dry side: the tape head loops the slice
  if (live) { std::memcpy(dL, inL_, n * sizeof(float)); std::memcpy(dR, inR_, n * sizeof(float)); }
  else if (have) {
    const int N = sN; const double ws = winS, wl = winL, tr = (rate / sr) * std::pow(2.0, semis() / 12) * (e[REV] > 0.5 ? -1 : 1);
    if (lastWinS < 0) { tapeAbs = tr < 0 ? ws + wl - 1 : ws; tapeX = 1; lastWinS = ws; }
    double abs = tapeAbs;
    for (int i = 0; i < n; i++) {
      if (tapeX >= 1 && (abs >= ws + wl || abs < ws)) {
        tapeOld = abs; tapeX = 0;
        abs = (abs >= ws + wl && abs < ws + 2 * wl) ? abs - wl : (abs < ws && abs >= ws - wl) ? abs + wl : ws + std::fmod(std::fmod(abs - ws, wl) + wl, wl);
      }
      rd(sL, sR, N, 0, abs); double l = rl, r = rr_;
      if (tapeX < 1) { rd(sL, sR, N, 0, tapeOld); const double x = rc(tapeX); l = rl + (l - rl) * x; r = rr_ + (r - rr_) * x; tapeX += 1.0 / 240; tapeOld += tr; }
      dL[i] = float(l); dR[i] = float(r); abs += tr;
    }
    tapeAbs = abs;
    if (e[MONITOR] > 0.5) for (int i = 0; i < n; i++) { dL[i] += inL_[i]; dR[i] += inR_[i]; }
  } else { std::memset(dL, 0, sizeof dL); std::memset(dR, 0, sizeof dR); }

  // ---- voices fire grains
  double wLd[G_SUB] = {}, wRd[G_SUB] = {};
  Voice* V = voices; V[0].gate = e[PLAY] > 0.5; V[0].ratio = 1; V[0].vel = 1;
  const double subR = sr / G_SUB, att = 1 - std::exp(-1 / (pm::envA(e[ENV_A]) * subR)), rel = 1 - std::exp(-1 / (pm::envR(e[ENV_R]) * subR));
  const int gi = int(jsRound(e[GRID])), div = (gi >= 0 && gi < 7) ? GRID_DIVS[gi] : 0; const double tickLen = div ? sr * 60 / bpm / div : 0;
  gridRate = div ? sr / tickLen : 0;
  const double interval = sr / pm::density(e[DENSITY]), chance = clampd(e[DENSITY] * 1.4, 0.08, 1), spray = e[SPRAY];
  int av = 0;
  for (int vi = 0; vi < G_NV; vi++) {
    Voice& v = V[vi]; v.env += ((v.gate ? v.vel : 0) - v.env) * (v.gate ? att : rel);
    if (!v.gate && v.env < 0.0005) { v.env = 0; v.cd = 0; v.tick = -1; continue; }
    av++; if (!have) continue;
    if (div) {
      const double rel0 = double(frame + off - f0); int64_t k = int64_t(std::ceil(rel0 / tickLen - 1e-9));
      for (; k * tickLen < rel0 + n; k++) { if (k == v.tick) continue; v.tick = k; if (rng.next() < chance) spawn(vi, int(clampd(std::floor(k * tickLen - rel0), 0, n - 1))); }
    } else {
      while (v.cd < n) { spawn(vi, std::max(0, int(v.cd))); v.cd += std::max(1.0, interval * (1 + (rng.next() * 2 - 1) * 0.9 * spray)); }
      v.cd -= n;
    }
  }
  activeVoices = av;
  if (have) {
    for (auto& g : grains) {
      if (!g.on) continue;
      const float* L = g.ring ? rL.data() : sL; const float* R = g.ring ? rR.data() : sR; const int N = g.ring ? G_RING : sN, mask = g.ring ? G_RMASK : 0;
      const double aL = g.amp * g.gL, aR = g.amp * g.gR, end = g.pos + g.inc * (n - g.start), lo = std::min(g.pos, end), hi = std::max(g.pos, end);
      if (!mask && lo >= 1 && hi < N - 3) {
        double pos = g.pos;
        for (int i = g.start; i < n; i++) {
          const double ev = genv(g, g.age); const int i1 = int(pos); const double t = pos - i1;
          double x0 = L[i1 - 1], x1 = L[i1], x2 = L[i1 + 1], x3 = L[i1 + 2];
          wLd[i] += ((((0.5 * (x3 - x0) + 1.5 * (x1 - x2)) * t + (x0 - 2.5 * x1 + 2 * x2 - 0.5 * x3)) * t + 0.5 * (x2 - x0)) * t + x1) * ev * aL;
          x0 = R[i1 - 1]; x1 = R[i1]; x2 = R[i1 + 1]; x3 = R[i1 + 2];
          wRd[i] += ((((0.5 * (x3 - x0) + 1.5 * (x1 - x2)) * t + (x0 - 2.5 * x1 + 2 * x2 - 0.5 * x3)) * t + 0.5 * (x2 - x0)) * t + x1) * ev * aR;
          pos += g.inc; if (++g.age >= g.len) { g.on = false; break; }
        }
        g.pos = pos; g.start = 0; continue;
      }
      for (int i = g.start; i < n; i++) {
        const double ev = genv(g, g.age); rd(L, R, N, mask, g.pos); wLd[i] += rl * ev * aL; wRd[i] += rr_ * ev * aR;
        g.pos += g.inc; if (!mask) { if (g.pos >= N) g.pos -= N; else if (g.pos < 0) g.pos += N; }
        if (++g.age >= g.len) { g.on = false; break; }
      }
      g.start = 0;
    }
  } else for (auto& g : grains) g.on = false;
  for (int i = 0; i < n; i++) { wL[i] = float(wLd[i]); wR[i] = float(wRd[i]); }

  // ---- effects: drive → crush → filter → chorus → delay → space → volume
  const double fc = fcomp, space = s.space, crush = s.crush, chor = s.chorus, dly = s.delay, fb = std::min(0.96, s.dfeed * 0.98);
  const int crN = 1 + int(std::floor(crush * crush * 40)); const double crQ = std::pow(2.0, 15 - crush * 12);
  float* d0 = dl[0].data(); float* d1b = dl[1].data(); float* chL = ch[0]; float* chR = ch[1];
  const double lpk = 1 - std::exp(-TAU * 4200 / sr), hpk = 1 - std::exp(-TAU * 140 / sr), dT = s.dtime;
  for (int i = 0; i < n; i++) {
    const double t = (i + 1) * inv, mx = mix0 + (mix1 - mix0) * t, dg = std::cos(mx * PI / 2), wg = std::sin(mx * PI / 2);
    double l = dL[i] * dg + wL[i] * wg, r = dR[i] * dg + wR[i] * wg;
    const double dv = drv0 + (drv1 - drv0) * t; if (dv > 0.001) { const double k = 1 + 24 * dv * dv; l = l + dv * (tanhF(l * k) * 0.8 - l); r = r + dv * (tanhF(r * k) * 0.8 - r); }
    if (crush > 0.002) { if (++crC >= crN) { crC = 0; crH[0] = jsRound(l * crQ) / crQ; crH[1] = jsRound(r * crQ) / crQ; } const double cm = std::min(1.0, crush * 6); l += (crH[0] - l) * cm; r += (crH[1] - r) * cm; }
    fl[0].tick(l); l = fl[0].lp; fl[1].tick(r); r = fl[1].lp; fl[2].tick(l); l = fl[2].hp; fl[3].tick(r); r = fl[3].hp; if (fc != 1) { l *= fc; r *= fc; }
    const int cw = chW; chL[cw] = float(l); chR[cw] = float(r);
    if (chor > 0.002) {
      chPh += TAU * 0.55 / sr; if (chPh > TAU) chPh -= TAU;
      const double dd1 = (0.011 + 0.004 * std::sin(chPh)) * sr, dd2 = (0.014 + 0.005 * std::sin(chPh * 0.62 + 1.7)) * sr;
      double pp = cw - dd1, f0_ = std::floor(pp), u = pp - f0_; int i0 = int(f0_); const double a1 = chL[i0 & 4095] + (double(chL[(i0 + 1) & 4095]) - chL[i0 & 4095]) * u;
      pp = cw - dd2; f0_ = std::floor(pp); u = pp - f0_; i0 = int(f0_); const double a2 = chR[i0 & 4095] + (double(chR[(i0 + 1) & 4095]) - chR[i0 & 4095]) * u;
      l = l * (1 - 0.3 * chor) + a2 * 0.75 * chor; r = r * (1 - 0.3 * chor) + a1 * 0.75 * chor;
    }
    chW = (cw + 1) & 4095;
    const int dw = dW; double el, er;
    { const double pp = dw - dT, f0_ = std::floor(pp), u = pp - f0_; const int i0 = int(f0_); el = d0[i0 & dM] + (double(d0[(i0 + 1) & dM]) - d0[i0 & dM]) * u; er = d1b[i0 & dM] + (double(d1b[(i0 + 1) & dM]) - d1b[i0 & dM]) * u; }
    dlp[0] += (er - dlp[0]) * lpk; dlp[1] += (el - dlp[1]) * lpk; dhp[0] += (dlp[0] - dhp[0]) * hpk; dhp[1] += (dlp[1] - dhp[1]) * hpk;
    const double send = dly > 0.002 ? std::min(1.0, dly * 1.5) : 0;
    d0[dw] = float((l + r) * 0.5 * send + tanhF((dlp[0] - dhp[0]) * fb)); d1b[dw] = float(tanhF((dlp[1] - dhp[1]) * fb)); dW = (dw + 1) & dM;
    l += el * dly; r += er * dly;
    rev.process(l, r); l = l * (1 - 0.35 * space) + rev.outL * space * 1.25; r = r * (1 - 0.35 * space) + rev.outR * space * 1.25;
    const double g = (vol0 + (vol1 - vol0) * t) * (g0 + (g1 - g0) * t); l *= g; r *= g;
    double y = l - dc[0] + 0.9975 * dc[1]; dc[0] = l; dc[1] = y; l = softClip(y);
    y = r - dc[2] + 0.9975 * dc[3]; dc[2] = r; dc[3] = y; r = softClip(y);
    oL[off + i] = float(l); oR[off + i] = float(r); const double a = std::max(std::fabs(l), std::fabs(r)); if (a > outPk) outPk = a;
  }
  // CAPTURE: exactly N frames of this output starting on a bar line (for the deck)
  if (Capture* cap = capture) {
    const int64_t a = std::max<int64_t>(0, cap->start - (frame + off)); const int take = int(std::min<int64_t>(n - a, cap->len - cap->got));
    if (a < n && take > 0) { for (int i = 0; i < take; i++) { cap->L[cap->got + i] = oL[off + a + i]; cap->R[cap->got + i] = oR[off + a + i]; } cap->got += take; }
    if (cap->got >= cap->len) { capture = nullptr; cap->done.store(true, std::memory_order_release); }
  }
  frame += n;
}

void GrainEngine::setFilter(double tone, double reso) {
  lastTone = tone; lastReso = reso; const double t = (tone - 0.5) * 2; double lpHz = 20000, hpHz = 15, lq = 0.707, hq = 0.707; fcomp = 1;
  const double q = pm::reso(reso);
  if (t < -0.02) { const double x = (-t - 0.02) / 0.98; lpHz = 20000 * std::pow(70.0 / 20000, x); lq = q; }
  else if (t > 0.02) { const double x = (t - 0.02) / 0.98; hpHz = 15 * std::pow(7000.0 / 15, x); hq = q; }
  if (std::fabs(t) > 0.02) fcomp = std::pow(0.707 / q, 0.45);
  const double sq = std::sqrt(std::max(0.5, lq) * 0.9), shq = std::sqrt(std::max(0.5, hq) * 0.9);
  fl[0].set(lpHz, lq > 0.71 ? sq : 0.707, sr); fl[1].set(lpHz, lq > 0.71 ? sq : 0.707, sr); fl[2].set(hpHz, hq > 0.71 ? shq : 0.707, sr); fl[3].set(hpHz, hq > 0.71 ? shq : 0.707, sr);
}

void GrainEngine::publish() {
  snapSeq.fetch_add(1, std::memory_order_acq_rel);
  const double tot = total > 0 ? total : 1; Snapshot& o = snap; o.nDots = 0;
  for (auto& g : grains) { if (!g.on || o.nDots >= 56) continue; const double base = g.ring ? wh - std::min(filled, int(std::floor(G_LIVE_SEC * sr))) : 0;
    double x = g.ring ? std::fmod(std::fmod(g.pos - base, double(G_RING)) + G_RING, double(G_RING)) / tot : g.pos / tot; if (!g.ring) x -= std::floor(x);
    float* d = o.dots + o.nDots * 3; d[0] = float(clampd(x, 0, 1)); d[1] = float(g.amp * genv(g, std::min(g.len - 1, g.age))); d[2] = float(g.pan); o.nDots++; }
  o.live = live; o.total = float(tot / (live ? sr : sRate)); o.ph = float(phF / tot); o.winS = float(winS / tot); o.winL = float(winL / tot);
  o.tape = live ? 1.f : float(std::fmod(std::fmod(tapeAbs / tot, 1.0) + 1.0, 1.0)); o.nGrains = activeGrains; o.nVoices = activeVoices;
  o.inPk = float(inPk); o.outPk = float(outPk); o.filled = float(filled / sr); o.cap = capture ? float(capture->got) / capture->len : -1.f;
  for (int i = 0; i < 3; i++) o.lfo[i] = float(lfos[i].val); for (int i = 0; i < GP_KNOBS; i++) o.e[i] = e[i];
  inPk = 0; outPk = 0;
  snapSeq.fetch_add(1, std::memory_order_acq_rel);
}

void MasterBus::process(const float* inL, const float* inR, float* oL, float* oR, int n) {
  const double k = 1 - std::exp(-1 / (0.02 * sr)), rel = 1 - std::exp(-1 / (0.25 * sr)), v = vol.load(std::memory_order_relaxed); double pl = pkL.load(), pr = pkR.load();
  for (int i = 0; i < n; i++) {
    sv += (v - sv) * k; double l = (inL ? inL[i] : 0) * sv, r = (inR ? inR[i] : 0) * sv;
    const double a = std::max(std::fabs(l), std::fabs(r)); env += (a - env) * (a > env ? 0.02 : rel);
    const double gr = env > 0.7 ? 0.7 / env * 0.6 + 0.4 : 1; l = softClip(l * gr); r = softClip(r * gr);
    oL[i] = float(l); oR[i] = float(r); pl = std::max(pl, std::fabs(l)); pr = std::max(pr, std::fabs(r));
  }
  pkL.store(float(pl)); pkR.store(float(pr));
}
}  // namespace nc
