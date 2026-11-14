// Runs a scenario script through the native engine and writes the stereo result as raw float32 (interleaved).
#include "../app/src/main/cpp/engine/GrainEngine.h"
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <map>
using namespace nc;
static std::vector<float> readF32(const std::string& p) { std::ifstream f(p, std::ios::binary); f.seekg(0, std::ios::end); size_t n = f.tellg() / 4; f.seekg(0); std::vector<float> v(n); f.read((char*)v.data(), n * 4); return v; }
int main(int argc, char** argv) {
  if (argc < 4) return 2; const double sr = 48000;
  static const char* names[] = {"POSITION","LENGTH","SCAN","SIZE","DENSITY","PITCH","FINE","SPRAY","SHATTER","REV","SPREAD","ATTACK","SUSTAIN","MIX","ENV_A","ENV_R","TONE","RESO","DRIVE","CRUSH","CHORUS","DELAY","DTIME","DFEED","SPACE","DECAY","VOLUME","GAIN","PLAY","FREEZE","MONITOR","KEYLOCK","GRID","DSYNC","XPOSE","BEND"};
  std::map<std::string, int> idx; for (int i = 0; i < GP_COUNT; i++) idx[names[i]] = i;
  auto raw = readF32(argv[2]); auto smp = std::make_shared<Sample>(); smp->rate = sr; const int N = int(raw.size() / 2); smp->L.resize(N); smp->R.resize(N); for (int i = 0; i < N; i++) { smp->L[i] = raw[2 * i]; smp->R[i] = raw[2 * i + 1]; }
  std::ifstream sc(argv[1]); std::string line; std::unique_ptr<GrainEngine> e; std::vector<float> out; long long inPos = 0; bool feed = false;
  std::vector<float> oL(128), oR(128), iL(128), iR(128);
  while (std::getline(sc, line)) {
    std::istringstream ss(line); std::string op; ss >> op; if (op.empty() || op[0] == '#') continue;
    if (op == "engine") { int off, seed; ss >> off >> seed; e.reset(new GrainEngine(sr, off != 0)); e->seed(uint32_t(seed)); e->prepareLive(); }
    else if (op == "load") e->load(smp);
    else if (op == "set") { std::string k; double v; ss >> k >> v; e->setParam(idx.at(k), float(v)); }
    else if (op == "on") { int n; double v; ss >> n >> v; e->noteOn(n, float(v)); }
    else if (op == "off") { int n; ss >> n; e->noteOff(n); }
    else if (op == "alloff") e->allOff();
    else if (op == "clock") { double b; long long f; ss >> b >> f; e->setClock(b, f); }
    else if (op == "keylock") { int a, b; ss >> a >> b; e->setKeyLock(a, b); }
    else if (op == "lfo") { int i; LfoSpec o; int sync; ss >> i >> o.shape >> o.rate >> sync >> o.div >> o.depth >> o.nTargets; o.sync = sync; for (int k = 0; k < o.nTargets; k++) { std::string nm; ss >> nm >> o.amount[k]; o.target[k] = idx.at(nm); } e->setLfo(i, o); }
    else if (op == "live") { int a; ss >> a; e->goLive(a); }
    else if (op == "grab") e->grab();
    else if (op == "feed") { int a; ss >> a; feed = a; }
    else if (op == "run") { long long n; ss >> n; for (long long d = 0; d < n; d += 128) { const int m = int(std::min<long long>(128, n - d));
        if (feed) for (int i = 0; i < m; i++) { iL[i] = smp->L[(inPos + i) % N]; iR[i] = smp->R[(inPos + i) % N]; } inPos += feed ? m : 0;
        e->process(oL.data(), oR.data(), m, feed ? iL.data() : nullptr, feed ? iR.data() : nullptr); for (int i = 0; i < m; i++) { out.push_back(oL[i]); out.push_back(oR[i]); } } }
  }
  std::ofstream f(argv[3], std::ios::binary); f.write((char*)out.data(), out.size() * 4); printf("%zu frames\n", out.size() / 2); return 0;
}
