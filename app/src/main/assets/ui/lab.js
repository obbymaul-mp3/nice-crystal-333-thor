// Nice Crystal 333 — the rooms' engine (Crystallise, Hybrid, Vocal Shard). Generated from the web project's src/dsp and src/lab; runs in a worker.
// ============================================================ NICE CRYSTAL 333 · shared DSP core
// Plain functions and classes with no DOM use: this file runs on the page, in the audio worklet and in the lab worker.
const TAU = Math.PI * 2;
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const lerp = (a, b, t) => a + (b - a) * t;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const SCALES = {
  min: [0, 2, 3, 5, 7, 8, 10], maj: [0, 2, 4, 5, 7, 9, 11], dor: [0, 2, 3, 5, 7, 9, 10], phr: [0, 1, 3, 5, 7, 8, 10],
  minp: [0, 3, 5, 7, 10], majp: [0, 2, 4, 7, 9], chr: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const SCALE_NAMES = { min: "minor", maj: "major", dor: "dorian", phr: "phrygian", minp: "minor pentatonic", majp: "major pentatonic", chr: "chromatic" };
const scaleIsMinor = s => s === "min" || s === "dor" || s === "phr" || s === "minp";
// the 7-note scale used wherever chords and scale steps are needed (pentatonics and chromatic borrow their parent)
const scale7 = s => SCALES[s] && SCALES[s].length === 7 ? SCALES[s] : scaleIsMinor(s) ? SCALES.min : SCALES.maj;
const scalePcs = (root, scale) => (SCALES[scale] || SCALES.min).map(x => (x + root) % 12);
const pcOf = m => ((Math.round(m) % 12) + 12) % 12;
function nearestInScale(m, pcs) {
  let best = Math.round(m), bd = 99;
  for (let k = Math.floor(m) - 6; k <= Math.ceil(m) + 6; k++) if (pcs.includes(((k % 12) + 12) % 12) && Math.abs(k - m) < bd) { bd = Math.abs(k - m); best = k; }
  return best;
}
const midiHz = m => 440 * Math.pow(2, (m - 69) / 12);
const hzMidi = f => 69 + 12 * Math.log2(f / 440);
const keyName = (root, scale) => NOTE_NAMES[root] + " " + (SCALE_NAMES[scale] || scale);
// smallest transposition (−6…+5 semitones) that moves pitch class `from` onto `to`
const shiftTo = (from, to) => ((to - from + 18) % 12) - 6;

function mulberry(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const hashSeed = (a, b) => { let h = (a | 0) ^ 0x9E3779B9; h = Math.imul(h ^ (b | 0), 0x85EBCA6B); h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35); return (h ^ h >>> 16) | 0; };

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -TAU / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2, vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
// raised-cosine ramp 0→1: fades shaped like this have no corner at either end, so they never click
const rc = t => t <= 0 ? 0 : t >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * t);
function tanhF(x) { if (x > 3) return 1; if (x < -3) return -1; const x2 = x * x; return x * (27 + x2) / (27 + 9 * x2); }
// transparent below 0.75, rounds off into 1.0 above: the last safety net on every output
function softClip(x) { const a = Math.abs(x); if (a <= 0.75) return x; const y = 0.75 + 0.25 * tanhF((a - 0.75) / 0.25); return x < 0 ? -y : y; }

// state-variable filter (TPT): lp / bp / hp from one tick, stable under fast modulation
class Svf {
  constructor() { this.a1 = this.a2 = this.a3 = 0; this.k = 1.414; this.i1 = this.i2 = 0; this.lp = 0; this.bp = 0; this.hp = 0; }
  set(fc, q, sr) { fc = clamp(fc, 10, sr * 0.49); const g = Math.tan(Math.PI * fc / sr); this.k = 1 / Math.max(0.05, q); this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2; }
  tick(v0) {
    const v3 = v0 - this.i2, v1 = this.a1 * this.i1 + this.a2 * v3, v2 = this.i2 + this.a2 * this.i1 + this.a3 * v3;
    this.i1 = 2 * v1 - this.i1; this.i2 = 2 * v2 - this.i2; this.lp = v2; this.bp = v1; this.hp = v0 - this.k * v1 - v2;
  }
  reset() { this.i1 = this.i2 = 0; }
}
// RBJ biquad, two channels of state
class Biquad {
  constructor() { this.b0 = 1; this.b1 = this.b2 = this.a1 = this.a2 = 0; this.z = new Float64Array(8); }
  set(type, f, q, db, sr) {
    const A = Math.pow(10, db / 40), w = TAU * Math.min(f, sr * 0.45) / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (type === "hp") { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === "lp") { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
    else if (type === "peak") { b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; }
    else if (type === "hishelf") { const sq = 2 * Math.sqrt(A) * al;
      b0 = A * ((A + 1) + (A - 1) * c + sq); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - sq); a0 = (A + 1) - (A - 1) * c + sq; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - sq; }
    else { const sq = 2 * Math.sqrt(A) * al;   // low shelf
      b0 = A * ((A + 1) - (A - 1) * c + sq); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - sq); a0 = (A + 1) + (A - 1) * c + sq; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - sq; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; return this;
  }
  tick(x, ch) {
    const z = this.z, o = ch * 4, y = this.b0 * x + this.b1 * z[o] + this.b2 * z[o + 1] - this.a1 * z[o + 2] - this.a2 * z[o + 3];
    z[o + 1] = z[o]; z[o] = x; z[o + 3] = z[o + 2]; z[o + 2] = y; return y;
  }
}
// SPACE: stereo-in 8-line feedback delay network. Diffused input, Householder mixing, damped and gently modulated lines.
class Fdn {
  constructor(sr) {
    this.sr = sr; const base = [1031, 1327, 1523, 1801, 2063, 2357, 2593, 2939], sc = 1.35 * sr / 44100;
    this.N = 16384; this.M = this.N - 1;
    this.len = base.map(b => Math.min(this.N - 64, Math.floor(b * sc))); this.line = base.map(() => new Float32Array(this.N));
    this.lp = new Float32Array(8); this.g = new Float32Array(8); this.o = new Float32Array(8); this.w = 0;
    this.apL = [142, 107, 379, 277].map(a => Math.floor(a * sr / 44100)); this.ap = [0, 1, 2, 3, 4, 5, 6, 7].map(() => new Float32Array(2048)); this.apW = 0;
    this.pre = [new Float32Array(this.N), new Float32Array(this.N)]; this.preL = Math.floor(0.022 * sr); this.preW = 0;
    this.ph = 0; this.phInc = TAU * 0.31 / sr; this.outL = 0; this.outR = 0; this.dc = 0.3; this.setDecay(4, 0.35);
  }
  setDecay(rt, damp) {
    rt = Math.max(0.15, rt); for (let i = 0; i < 8; i++) this.g[i] = Math.pow(10, -3 * this.len[i] / (rt * this.sr));
    const fc = 11000 * Math.pow(1500 / 11000, clamp(damp, 0, 1)); this.dc = 1 - Math.exp(-TAU * fc / this.sr);
  }
  clear() { for (const l of this.line) l.fill(0); for (const a of this.ap) a.fill(0); this.pre[0].fill(0); this.pre[1].fill(0); this.lp.fill(0); }
  process(inL, inR) {
    const M = this.M, pw = this.preW; this.pre[0][pw] = inL; this.pre[1][pw] = inR;
    let xl = this.pre[0][(pw - this.preL) & M], xr = this.pre[1][(pw - this.preL) & M]; this.preW = (pw + 1) & M;
    const aw = this.apW;
    for (let i = 0; i < 4; i++) {
      const dl = this.apL[i]; let b = this.ap[i], d = b[(aw - dl) & 2047], v = xl + 0.6 * d; b[aw] = v; xl = d - 0.6 * v;
      b = this.ap[i + 4]; d = b[(aw - dl - 11) & 2047]; v = xr + 0.6 * d; b[aw] = v; xr = d - 0.6 * v;
    }
    this.apW = (aw + 1) & 2047;
    this.ph += this.phInc; if (this.ph > TAU) this.ph -= TAU;
    const mod = Math.sin(this.ph) * 6, w = this.w, o = this.o; let sum = 0;
    for (let i = 0; i < 8; i++) {
      const rp = w - this.len[i] + (i & 1 ? mod : -mod), i0 = Math.floor(rp), t = rp - i0, L = this.line[i];
      const a = L[i0 & M], b = L[(i0 + 1) & M]; let v = a + (b - a) * t;
      this.lp[i] += (v - this.lp[i]) * this.dc; v = this.lp[i] * this.g[i]; o[i] = v; sum += v;
    }
    sum *= 0.25;   // Householder: I − (2/N)·ones
    for (let i = 0; i < 8; i++) this.line[i][w] = (i & 1 ? xr : xl) * 0.5 + o[i] - sum;
    this.w = (w + 1) & M;
    this.outL = (o[0] + o[2] - o[4] + o[6]) * 0.5; this.outR = (o[1] - o[3] + o[5] + o[7]) * 0.5;
  }
}
function peakOf(L, R) { let p = 0; for (let i = 0; i < L.length; i++) { const a = Math.abs(L[i]); if (a > p) p = a; } if (R) for (let i = 0; i < R.length; i++) { const a = Math.abs(R[i]); if (a > p) p = a; } return p; }
function normalize(L, R, target) { const pk = peakOf(L, R), g = pk > 1e-5 ? (target || 0.89) / pk : 1; for (let i = 0; i < L.length; i++) { L[i] *= g; R[i] *= g; } return g; }
function monoOf(L, R, start, n) { start = start || 0; n = n === undefined ? L.length - start : n; const m = new Float32Array(n); for (let i = 0; i < n; i++) m[i] = 0.5 * (L[start + i] + R[start + i]); return m; }
// linear resampling of a stereo pair to a new rate
function resample(L, R, from, to) {
  if (from === to) return [L, R]; const ratio = from / to, n = Math.floor(L.length / ratio), a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = i * ratio, i0 = p | 0, t = p - i0, i1 = Math.min(L.length - 1, i0 + 1); a[i] = L[i0] + (L[i1] - L[i0]) * t; b[i] = R[i0] + (R[i1] - R[i0]) * t; }
  return [a, b];
}
// display peaks: `bins` max-abs values across the sound
function peakBins(L, R, bins) {
  const out = new Float32Array(bins), n = L.length; if (!n) return out;
  for (let b = 0; b < bins; b++) { const a = Math.floor(b * n / bins), e = Math.max(a + 1, Math.floor((b + 1) * n / bins)), st = Math.max(1, Math.floor((e - a) / 64)); let m = 0;
    for (let i = a; i < e; i += st) { const v = Math.abs(L[i]) + Math.abs(R[i]); if (v > m) m = v; } out[b] = m * 0.5; }
  return out;
}
// WAV file bytes: bits = 16, 24 or 32 (float)
function encodeWav(L, R, rate, bits) {
  bits = bits || 24; const n = L.length, bps = bits / 8, buf = new ArrayBuffer(44 + n * 2 * bps), v = new DataView(buf), W = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  W(0, "RIFF"); v.setUint32(4, 36 + n * 2 * bps, true); W(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, bits === 32 ? 3 : 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2 * bps, true); v.setUint16(32, 2 * bps, true); v.setUint16(34, bits, true); W(36, "data"); v.setUint32(40, n * 2 * bps, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (const s of [L[i], R[i]]) {
    if (bits === 32) { v.setFloat32(o, s, true); o += 4; }
    else if (bits === 16) { v.setInt16(o, Math.round(clamp(s, -1, 1) * 32767), true); o += 2; }
    else { const x = Math.round(clamp(s, -1, 1) * 8388607); v.setUint8(o, x & 255); v.setUint8(o + 1, (x >> 8) & 255); v.setUint8(o + 2, (x >> 16) & 255); o += 3; }
  }
  return buf;
}

// ============================================================ the granular engine
// One class, three homes: the live instrument (audio worklet), the compatibility engine (page thread) and,
// offline, every layer of a Crystallise loop. All randomness comes from this.rnd so offline renders repeat exactly.
const GP_DEF = [
  // source
  ["POSITION", 0.3], ["LENGTH", 1], ["SCAN", 0.8536],
  // grains
  ["SIZE", 0.62], ["DENSITY", 0.55], ["PITCH", 0.5], ["FINE", 0.5], ["SPRAY", 0.25], ["SHATTER", 0], ["REV", 0], ["SPREAD", 0.5],
  ["ATTACK", 0.5], ["SUSTAIN", 0], ["MIX", 0.85], ["ENV_A", 0.3], ["ENV_R", 0.55],
  // effects
  ["TONE", 0.5], ["RESO", 0.15], ["DRIVE", 0], ["CRUSH", 0], ["CHORUS", 0], ["DELAY", 0], ["DTIME", 0.5], ["DFEED", 0.4], ["SPACE", 0.3], ["DECAY", 0.5],
  ["VOLUME", 0.8], ["GAIN", 0.5],
  // switches and raw values (not knobs)
  ["PLAY", 0], ["FREEZE", 0], ["MONITOR", 0], ["KEYLOCK", 0], ["GRID", 0], ["DSYNC", 1], ["XPOSE", 0], ["BEND", 0],
];
const GP = {}; GP_DEF.forEach((d, i) => { GP[d[0]] = i; });
const GP_COUNT = GP_DEF.length, GP_KNOBS = GP.GAIN + 1;   // indices below GP_KNOBS are continuous 0..1 and can be modulated
const GP_DEFAULTS = Float32Array.from(GP_DEF.map(d => d[1]));
// GRID: grains per beat when grain timing is locked to the tempo (index 0 = free-running)
const GRID_DIVS = [0, 1, 2, 3, 4, 6, 8], GRID_NAMES = ["FREE", "1/4", "1/8", "1/8T", "1/16", "1/16T", "1/32"];
// delay times in beats when DSYNC is on
const DELAY_DIVS = [0.125, 1 / 6, 0.25, 1 / 3, 0.375, 0.5, 2 / 3, 0.75, 1, 1.5, 2], DELAY_NAMES = ["1/32", "1/16T", "1/16", "1/8T", "1/16.", "1/8", "1/4T", "1/8.", "1/4", "1/4.", "1/2"];
// LFO rates in beats per cycle when synced
const LFO_DIVS = [32, 16, 8, 4, 2, 1, 0.5, 0.25], LFO_DIV_NAMES = ["8 BARS", "4 BARS", "2 BARS", "1 BAR", "1/2", "1/4", "1/8", "1/16"];
const LFO_SHAPES = ["SINE", "TRI", "RAMP", "SQUARE", "STEPS", "DRIFT"];

// knob value (0..1) ↔ real units
const PM = {
  size: v => 0.004 * Math.pow(500, v), sizeInv: s => clamp(Math.log(Math.max(0.004, s) / 0.004) / Math.log(500), 0, 1),
  density: v => 0.5 * Math.pow(240, v), densityInv: g => clamp(Math.log(Math.max(0.5, g) / 0.5) / Math.log(240), 0, 1),
  pitch: v => (v - 0.5) * 48, pitchInv: st => clamp(0.5 + clamp(st, -24, 24) / 48, 0, 1),
  fine: v => (v - 0.5) * 2,   // semitones
  // LENGTH: 10 ms up to the whole sound
  len: (v, total) => total <= 0.01 ? total : Math.min(total, 0.01 * Math.pow(total / 0.01, v)),
  lenInv: (sec, total) => total <= 0.01 ? 1 : clamp(Math.log(clamp(sec, 0.01, total) / 0.01) / Math.log(total / 0.01), 0, 1),
  // SCAN: how fast the playhead moves through the slice, −2× … 0 … +2× (0.5 = parked)
  scan: v => { const x = (v - 0.5) * 2; return Math.sign(x) * x * x * 2; }, scanInv: sp => 0.5 + Math.sign(sp) * Math.sqrt(Math.min(2, Math.abs(sp)) / 2) / 2,
  shape: (av, sv) => { const s = 0.95 * sv; return { a: (1 - s) * clamp(av, 0.02, 0.98), s }; },
  envA: v => 0.001 * Math.pow(2000, v), envR: v => 0.01 * Math.pow(800, v),
  reso: v => 0.707 + v * v * 13, decay: v => 0.3 * Math.pow(66, v), decayInv: s => clamp(Math.log(s / 0.3) / Math.log(66), 0, 1),
  dfree: v => 0.02 * Math.pow(75, v), ddiv: v => Math.min(DELAY_DIVS.length - 1, Math.floor(v * DELAY_DIVS.length)),
  vol: v => v * v * 1.6, volInv: g => Math.sqrt(Math.max(0, g) / 1.6), gain: v => Math.pow(10, (v - 0.5) * 48 / 20),
  lfoRate: v => 0.02 * Math.pow(1500, v),
};

const G_SUB = 64, G_RING = 1 << 21, G_RMASK = G_RING - 1, G_MAXG = 160, G_NV = 9, G_LIVE_SEC = 20;

class GrainEngine {
  constructor(sr, opts) {
    this.sr = sr; this.offline = !!(opts && opts.offline); this.rnd = Math.random;
    this.p = Float32Array.from(GP_DEFAULTS); this.e = Float32Array.from(GP_DEFAULTS);
    // sample memory and (live only) the 43-second tape the input is written to
    this.sL = new Float32Array(1); this.sR = new Float32Array(1); this.sN = 0; this.sRate = sr;
    this.rL = null; this.rR = null; this.wh = 0; this.filled = 0; this.rpk = null;
    this.live = false; this.frame = 0; this.bpm = 120; this.f0 = 0;
    this.grains = Array.from({ length: G_MAXG }, () => ({ on: false, pos: 0, inc: 0, len: 0, age: 0, start: 0, gL: 0, gR: 0, amp: 0, aN: 1, sN: 1, ra: 1, rr: 1, ring: false }));
    this.voices = Array.from({ length: G_NV }, () => ({ gate: false, note: -1, ratio: 1, vel: 1, env: 0, cd: 0, stamp: 0, tick: -1 }));
    this.stamp = 0; this.nextSlot = 0; this.sustain = false; this.held = new Set();
    this.rise = new Float32Array(1026).map((_, i) => i > 1024 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * i / 1024));
    const k = t => 1 - Math.exp(-1 / (t * sr / G_SUB));
    this.c = { mix: k(0.03), drv: k(0.03), vol: k(0.03), space: k(0.08), tone: k(0.02), reso: k(0.03), gate: k(0.004), ig: k(0.03), crush: k(0.03), chorus: k(0.05), delay: k(0.05), dfeed: k(0.05), dtime: k(0.12) };
    this.s = { mix: GP_DEFAULTS[GP.MIX], drv: 0, vol: PM.vol(GP_DEFAULTS[GP.VOLUME]), space: GP_DEFAULTS[GP.SPACE], tone: 0.5, reso: 0.15, gate: this.offline ? 1 : 0, ig: 1, crush: 0, chorus: 0, delay: 0, dfeed: 0.4, dtime: 0.25 * sr };
    // filters: low-pass pair then high-pass pair (TONE picks which one closes), key-snap hook for tuned resonance
    this.fl = [new Svf(), new Svf(), new Svf(), new Svf()]; this.lastTone = -1; this.lastReso = -1; this.fcomp = 1; this.snap = null;
    this.rev = new Fdn(sr); this.lastDecay = -1;
    const dn = 1 << Math.ceil(Math.log2(sr * 2.2)); this.dl = [new Float32Array(dn), new Float32Array(dn)]; this.dM = dn - 1; this.dW = 0; this.dlp = [0, 0]; this.dhp = [0, 0];
    this.ch = [new Float32Array(4096), new Float32Array(4096)]; this.chW = 0; this.chPh = 0;
    this.crH = [0, 0]; this.crC = 0;
    this.dc = [0, 0, 0, 0];
    this.inL = new Float32Array(G_SUB); this.inR = new Float32Array(G_SUB); this.dL = new Float32Array(G_SUB); this.dR = new Float32Array(G_SUB); this.wL = new Float32Array(G_SUB); this.wR = new Float32Array(G_SUB);
    this.pending = null; this.queue = [];
    // slice + playhead + the tape head that plays the slice as a loop (the dry side of MIX)
    this.winS = 0; this.winL = 1; this.scanOff = 0; this.phF = 0; this.tapeAbs = 0; this.tapeOld = 0; this.tapeX = 1; this.lastWinS = -1;
    this.lfos = [0, 1, 2].map(i => ({ shape: 0, rate: 0.35, sync: false, div: 3, depth: 0, targets: [], ph: i * 0.33, val: 0, hold: 0, tgt: 0 }));
    this.inPk = 0; this.outPk = 0; this.activeGrains = 0; this.activeVoices = 0; this.extL = null; this.extR = null;
    this.keyLock = false; this.strictOct = false; this.capture = null; this.onGrab = null; this.onCapture = null;
  }
  ensureRing() { if (!this.rL) { this.rL = new Float32Array(G_RING); this.rR = new Float32Array(G_RING); this.rpk = new Float32Array(G_RING >> 8); } }
  setClock(bpm, f0) { this.bpm = bpm; this.f0 = f0; }
  setLfo(i, o) { const l = this.lfos[i]; if (!l) return; Object.assign(l, o); l.targets = (o.targets || l.targets).filter(t => t[0] < GP_KNOBS).slice(0, 6); }
  // ---- commands (queued; anything that swaps the sound waits for a 4 ms fade so it never clicks)
  cmd(type, a, b) { this.queue.push({ type, a, b }); }
  load(L, R, rate) { const c = { type: "load", L, R: R || L, rate }; if (this.offline) this.structural(c); else this.pending = c; }
  noteOn(n, vel) { this.cmd("on", n, vel === undefined ? 0.8 : vel); }
  noteOff(n) { this.cmd("off", n); }
  kill() { for (const g of this.grains) g.on = false; for (const v of this.voices) { v.cd = 0; v.tick = -1; } this.tapeX = 1; this.lastWinS = -1; }
  structural(c) {
    this.kill();
    if (c.type === "load") { this.sL = c.L; this.sR = c.R; this.sN = c.L.length; this.sRate = c.rate; this.live = false; this.scanOff = 0; }
    else if (c.type === "live") { this.live = !!c.a; if (this.live) { this.ensureRing(); this.filled = 0; this.rpk.fill(0); } }
    else if (c.type === "grab") this.grab();
  }
  // GRAB: keep the last (up to) 20 s of the live tape as a sample, and hand a copy to the page for the crate
  grab() {
    if (!this.rL) return; const n = Math.min(this.filled, Math.floor(G_LIVE_SEC * this.sr)); if (n < this.sr * 0.2) return;
    const L = new Float32Array(n), R = new Float32Array(n), st = this.wh - n;
    for (let i = 0; i < n; i++) { const q = (st + i) & G_RMASK; L[i] = this.rL[q]; R[i] = this.rR[q]; }
    this.sL = L; this.sR = R; this.sN = n; this.sRate = this.sr; this.live = false; this.scanOff = 0; this.lastWinS = -1;
    if (this.onGrab) this.onGrab(L, R, this.sr);
  }
  handle() {
    if (this.pending) return;
    const V = this.voices;
    while (this.queue.length) {
      const c = this.queue.shift();
      if (c.type === "live" || c.type === "grab") { if (c.type === "live" && !!c.a === this.live) continue; this.pending = c; return; }
      if (c.type === "on") {
        let s = -1; this.held.delete(c.a);
        for (let i = 1; i < G_NV; i++) if (V[i].note === c.a && V[i].gate) { s = i; break; }
        if (s < 0) for (let i = 1; i < G_NV; i++) if (!V[i].gate && V[i].env < 0.001) { s = i; break; }
        if (s < 0) { let best = Infinity; for (let i = 1; i < G_NV; i++) { const st = V[i].stamp + (V[i].gate ? 1e9 : 0); if (st < best) { best = st; s = i; } } }
        Object.assign(V[s], { note: c.a, ratio: Math.pow(2, (c.a - 60) / 12), vel: clamp(c.b, 0.05, 1), gate: true, stamp: ++this.stamp, cd: 0, tick: -1 });
      } else if (c.type === "off") { if (this.sustain) this.held.add(c.a); else for (let i = 1; i < G_NV; i++) if (V[i].note === c.a) V[i].gate = false; }
      else if (c.type === "alloff") { this.held.clear(); for (let i = 1; i < G_NV; i++) V[i].gate = false; }
      else if (c.type === "sustain") { this.sustain = !!c.a; if (!this.sustain) { for (const n of this.held) for (let i = 1; i < G_NV; i++) if (V[i].note === n) V[i].gate = false; this.held.clear(); } }
    }
  }
  // ---- modulation: three LFOs, each pushing up to six knobs
  runLfos(n) {
    const e = this.e, p = this.p; for (let i = 0; i < GP_COUNT; i++) e[i] = p[i];
    for (const l of this.lfos) {
      const hz = l.sync ? this.bpm / 60 / LFO_DIVS[l.div] : PM.lfoRate(l.rate);
      let wrapped = false; const before = l.ph;
      if (l.sync) { l.ph = (((this.frame - this.f0) / this.sr * hz) % 1 + 1) % 1; wrapped = l.ph < before; }
      else { l.ph += hz * n / this.sr; if (l.ph >= 1) { l.ph -= Math.floor(l.ph); wrapped = true; } }
      const ph = l.ph; let v;
      switch (l.shape) {
        case 0: v = Math.sin(TAU * ph); break;
        case 1: v = ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph; break;
        case 2: v = 2 * ph - 1; break;
        case 3: v = ph < 0.5 ? 1 : -1; break;
        case 4: { const st = Math.floor(ph * 8); if (st !== l.lastSt || wrapped) { l.lastSt = st; l.hold = this.rnd() * 2 - 1; } v = l.hold; break; }
        default: { if (wrapped || l.tgt === undefined) l.tgt = this.rnd() * 2 - 1; l.hold += (l.tgt - l.hold) * Math.min(1, hz * n / this.sr * 4); v = l.hold; }
      }
      l.val = v; if (l.depth <= 0) continue;
      for (const t of l.targets) e[t[0]] = clamp(e[t[0]] + v * l.depth * t[1] * 0.5, 0, 1);
    }
  }
  // ---- reading the sound: 4-point interpolation with wrap-around
  rd(L, R, n, mask, pos) {
    let i1 = Math.floor(pos); const t = pos - i1; let i0, i2, i3;
    if (mask) { i0 = (i1 - 1) & mask; i2 = (i1 + 1) & mask; i3 = (i1 + 2) & mask; i1 &= mask; }
    else { i1 %= n; if (i1 < 0) i1 += n; i0 = i1 === 0 ? n - 1 : i1 - 1; i2 = i1 + 1 >= n ? i1 + 1 - n : i1 + 1; i3 = i2 + 1 >= n ? i2 + 1 - n : i2 + 1; }
    let x0 = L[i0], x1 = L[i1], x2 = L[i2], x3 = L[i3];
    this.rl = (((0.5 * (x3 - x0) + 1.5 * (x1 - x2)) * t + (x0 - 2.5 * x1 + 2 * x2 - 0.5 * x3)) * t + 0.5 * (x2 - x0)) * t + x1;
    x0 = R[i0]; x1 = R[i1]; x2 = R[i2]; x3 = R[i3];
    this.rr = (((0.5 * (x3 - x0) + 1.5 * (x1 - x2)) * t + (x0 - 2.5 * x1 + 2 * x2 - 0.5 * x3)) * t + 0.5 * (x2 - x0)) * t + x1;
  }
  semis() { const e = this.e; return PM.pitch(e[GP.PITCH]) + PM.fine(e[GP.FINE]) + e[GP.XPOSE] + e[GP.BEND]; }
  spawn(vi, offset) {
    let slot = -1; for (let k = 0; k < G_MAXG; k++) { const i = (this.nextSlot + k) % G_MAXG; if (!this.grains[i].on) { slot = i; break; } }
    if (slot < 0) return; this.nextSlot = (slot + 1) % G_MAXG;
    const e = this.e, v = this.voices[vi], rnd = this.rnd, sizeS = PM.size(e[GP.SIZE]), len = Math.max(32, (sizeS * this.sr) | 0);
    let semis = this.semis(); const sh = e[GP.SHATTER];
    if (sh > 0.001) {
      // SHATTER: random pitch. With KEY LOCK it only ever throws octaves (and, live, fifths); free, it smears up to an octave
      if (this.keyLock || e[GP.KEYLOCK] > 0.5) { if (rnd() < sh * 0.7) { const u = rnd(); semis += this.strictOct ? (u < 0.4 ? 12 : u < 0.8 ? -12 : u < 0.9 ? 24 : -24) : (u < 0.3 ? 12 : u < 0.6 ? -12 : u < 0.75 ? 7 : u < 0.9 ? -5 : u < 0.95 ? 24 : -24); } }
      else semis += (rnd() * 2 - 1) * sh * sh * 12;
    }
    const ratio = v.ratio * Math.pow(2, semis / 12), rev = rnd() < e[GP.REV], spray = e[GP.SPRAY];
    const g = this.grains[slot]; let start, inc;
    if (!this.live) {
      const srcF = this.sRate / this.sr, span = len * ratio * srcF, wl = this.winL;
      // born at the playhead, scattered by SPRAY, folded back inside the slice
      const s0 = this.phF + (rnd() * 2 - 1) * spray * spray * wl, rel = (((s0 - this.winS) % wl) + wl) % wl;
      start = this.winS + rel + (rev ? span : 0); inc = ratio * srcF * (rev ? -1 : 1); g.ring = false;
    } else {
      // live: anywhere in the slice of the last 20 s, but never so close to "now" that a pitched-up grain overtakes the input
      const W = Math.min(this.filled, Math.floor(G_LIVE_SEC * this.sr)), frozen = e[GP.FREEZE] > 0.5, margin = 4 * G_SUB + 16, span = len * ratio;
      const s0 = this.winS + rnd() * this.winL + (rnd() * 2 - 1) * spray * spray * this.winL * 0.5;
      let abs = this.wh - W + clamp(s0, 0, W);
      const latest = this.wh - margin - (rev ? 0 : Math.max(0, span - (frozen ? 0 : len)));
      if (abs > latest) abs = latest; if (rev) abs = Math.min(this.wh - margin, abs + span);
      if (W < span + margin * 2) return;
      start = abs; inc = ratio * (rev ? -1 : 1); g.ring = true;
    }
    const pan = clamp(e[GP.SPREAD] * (rnd() * 2 - 1), -1, 1), ang = (pan + 1) * Math.PI / 4, shp = PM.shape(e[GP.ATTACK], e[GP.SUSTAIN]);
    const aN = Math.max(1, Math.round(shp.a * len)), sN = Math.min(len - 1, aN + Math.round(shp.s * len)), rN = Math.max(1, len - sN);
    // a flat-topped grain carries more energy than a bell-shaped one: scale so SUSTAIN doesn't simply mean "louder"
    const comp = Math.sqrt(0.375 / (0.375 * (1 - shp.s) + shp.s)), rate = this.gridRate || PM.density(e[GP.DENSITY]);
    const norm = comp / Math.sqrt(Math.max(1, rate * sizeS));
    g.on = true; g.pos = start; g.inc = inc; g.len = len; g.age = 0; g.start = offset; g.gL = Math.cos(ang); g.gR = Math.sin(ang);
    g.amp = v.env * norm * (vi === 0 ? 1 : 0.8); g.aN = aN; g.sN = sN; g.ra = 1024 / aN; g.rr = 1024 / rN; g.pan = pan;
  }
  genv(g, age) {
    const t = this.rise;
    if (age < g.aN) { const f = age * g.ra, i = f | 0; return t[i] + (t[i + 1] - t[i]) * (f - i); }
    if (age < g.sN) return 1;
    const f = (g.len - age) * g.rr, i = f | 0; return t[i] + (t[i + 1] - t[i]) * (f - i);
  }
  process(oL, oR, frames, inL, inR) {
    this.extL = inL || null; this.extR = inR || inL || null;
    if (this.pending && (this.s.gate < 0.002 || this.offline)) { const c = this.pending; this.pending = null; this.structural(c); }
    this.handle();
    for (let off = 0; off < frames; off += G_SUB) this.sub(oL, oR, off, Math.min(G_SUB, frames - off));
    let n = 0; for (const g of this.grains) if (g.on) n++; this.activeGrains = n;
  }
  sub(oL, oR, off, n) {
    this.runLfos(n);
    const e = this.e, s = this.s, c = this.c, sr = this.sr, live = this.live, frozen = e[GP.FREEZE] > 0.5, inv = 1 / n;
    const st = (k, t) => { const a = s[k]; s[k] += (t - s[k]) * c[k]; return a; };
    const mix0 = st("mix", e[GP.MIX]), mix1 = s.mix, drv0 = st("drv", e[GP.DRIVE]), drv1 = s.drv, vol0 = st("vol", PM.vol(e[GP.VOLUME])), vol1 = s.vol;
    const g0 = st("gate", this.pending ? 0 : 1), g1 = s.gate, ig0 = st("ig", PM.gain(e[GP.GAIN])), ig1 = s.ig;
    st("tone", e[GP.TONE]); st("reso", e[GP.RESO]); st("space", e[GP.SPACE]); st("crush", e[GP.CRUSH]); st("chorus", e[GP.CHORUS]); st("delay", e[GP.DELAY]); st("dfeed", e[GP.DFEED]);
    const dTarget = clamp((e[GP.DSYNC] > 0.5 ? DELAY_DIVS[PM.ddiv(e[GP.DTIME])] * 60 / this.bpm : PM.dfree(e[GP.DTIME])) * sr, 32, this.dM - 64); st("dtime", dTarget);
    if (Math.abs(s.tone - this.lastTone) > 1e-4 || Math.abs(s.reso - this.lastReso) > 1e-3) this.setFilter(s.tone, s.reso);
    if (Math.abs(e[GP.DECAY] - this.lastDecay) > 0.002) { this.lastDecay = e[GP.DECAY]; this.rev.setDecay(PM.decay(e[GP.DECAY]), 0.3 + 0.3 * (1 - e[GP.DECAY])); }

    // ---- input (mic / interface), written to the live tape
    const ext = this.extL, want = live || e[GP.MONITOR] > 0.5;
    for (let i = 0; i < n; i++) {
      let l = 0, r = 0; if (want && ext) { l = ext[off + i]; r = this.extR[off + i]; }
      const g = ig0 + (ig1 - ig0) * (i + 1) * inv; l *= g; r *= g; this.inL[i] = l; this.inR[i] = r;
      const a = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r); if (a > this.inPk) this.inPk = a;
    }
    if (live && !frozen) {
      const rL = this.rL, rR = this.rR, pk = this.rpk;
      for (let i = 0; i < n; i++) { const w = this.wh; rL[w] = this.inL[i]; rR[w] = this.inR[i]; const m = Math.abs(this.inL[i]) + Math.abs(this.inR[i]), ci = w >> 8; if ((w & 255) === 0) pk[ci] = m * 0.5; else if (m * 0.5 > pk[ci]) pk[ci] = m * 0.5; this.wh = (w + 1) & G_RMASK; }
      this.filled = Math.min(G_RING - 4096, this.filled + n);
    }

    // ---- the slice: POSITION slides it, LENGTH sizes it, SCAN moves the playhead through it
    const total = live ? Math.min(this.filled, Math.floor(G_LIVE_SEC * sr)) : this.sN, rate = live ? sr : this.sRate, have = total > 512;
    if (have) {
      const lenF = clamp(PM.len(e[GP.LENGTH], total / rate) * rate, Math.min(total, 64), total);
      this.winS = e[GP.POSITION] * (total - lenF); this.winL = lenF;
      if (!frozen && !live) { this.scanOff += PM.scan(e[GP.SCAN]) * n * (rate / sr) / lenF; this.scanOff -= Math.floor(this.scanOff); }
      this.phF = this.winS + (live ? 0.5 : this.scanOff) * lenF; this.total = total;
    }

    // ---- dry side: the tape head loops the slice at the current pitch (a micro-loop when the slice is short)
    const dL = this.dL, dR = this.dR;
    if (live) { dL.set(this.inL.subarray(0, n)); dR.set(this.inR.subarray(0, n)); }
    else if (have) {
      const N = this.sN, ws = this.winS, wl = this.winL, tr = (rate / sr) * Math.pow(2, this.semis() / 12) * (e[GP.REV] > 0.5 ? -1 : 1), sL = this.sL, sR = this.sR;
      // the head keeps its own place; it only jumps (with a 5 ms crossfade) when it runs off either end of the slice,
      // so sliding or resizing the slice never disturbs it mid-flight
      if (this.lastWinS < 0) { this.tapeAbs = tr < 0 ? ws + wl - 1 : ws; this.tapeX = 1; this.lastWinS = ws; }
      let abs = this.tapeAbs;
      for (let i = 0; i < n; i++) {
        if (this.tapeX >= 1 && (abs >= ws + wl || abs < ws)) {
          this.tapeOld = abs; this.tapeX = 0;
          abs = abs >= ws + wl && abs < ws + 2 * wl ? abs - wl : abs < ws && abs >= ws - wl ? abs + wl : ws + ((((abs - ws) % wl) + wl) % wl);
        }
        this.rd(sL, sR, N, 0, abs); let l = this.rl, r = this.rr;
        if (this.tapeX < 1) { this.rd(sL, sR, N, 0, this.tapeOld); const x = rc(this.tapeX); l = this.rl + (l - this.rl) * x; r = this.rr + (r - this.rr) * x; this.tapeX += 1 / 240; this.tapeOld += tr; }
        dL[i] = l; dR[i] = r; abs += tr;
      }
      this.tapeAbs = abs;
      if (e[GP.MONITOR] > 0.5) for (let i = 0; i < n; i++) { dL[i] += this.inL[i]; dR[i] += this.inR[i]; }
    } else { dL.fill(0); dR.fill(0); }

    // ---- voices fire grains: free-running at DENSITY, or locked to the tempo grid
    const wL = this.wL, wR = this.wR; wL.fill(0); wR.fill(0);
    const V = this.voices; V[0].gate = e[GP.PLAY] > 0.5; V[0].ratio = 1; V[0].vel = 1;
    const subR = sr / G_SUB, att = 1 - Math.exp(-1 / (PM.envA(e[GP.ENV_A]) * subR)), rel = 1 - Math.exp(-1 / (PM.envR(e[GP.ENV_R]) * subR));
    const gi = Math.round(e[GP.GRID]), div = GRID_DIVS[gi] || 0, tickLen = div ? sr * 60 / this.bpm / div : 0;
    this.gridRate = div ? sr / tickLen : 0;
    const interval = sr / PM.density(e[GP.DENSITY]), chance = clamp(e[GP.DENSITY] * 1.4, 0.08, 1), spray = e[GP.SPRAY];
    let av = 0;
    for (let vi = 0; vi < G_NV; vi++) {
      const v = V[vi]; v.env += ((v.gate ? v.vel : 0) - v.env) * (v.gate ? att : rel);
      if (!v.gate && v.env < 0.0005) { v.env = 0; v.cd = 0; v.tick = -1; continue; }
      av++; if (!have) continue;
      if (div) {
        const rel0 = this.frame + off - this.f0; let k = Math.ceil(rel0 / tickLen - 1e-9);
        for (; k * tickLen < rel0 + n; k++) { if (k === v.tick) continue; v.tick = k; if (this.rnd() < chance) this.spawn(vi, clamp(Math.floor(k * tickLen - rel0), 0, n - 1)); }
      } else {
        while (v.cd < n) { this.spawn(vi, Math.max(0, v.cd | 0)); v.cd += Math.max(1, interval * (1 + (this.rnd() * 2 - 1) * 0.9 * spray)); }
        v.cd -= n;
      }
    }
    this.activeVoices = av;
    if (have) {
      for (const g of this.grains) {
        if (!g.on) continue;
        const L = g.ring ? this.rL : this.sL, R = g.ring ? this.rR : this.sR, N = g.ring ? G_RING : this.sN, mask = g.ring ? G_RMASK : 0;
        const aL = g.amp * g.gL, aR = g.amp * g.gR, end = g.pos + g.inc * (n - g.start), lo = Math.min(g.pos, end), hi = Math.max(g.pos, end);
        if (!mask && lo >= 1 && hi < N - 3) {   // fast path: nowhere near an edge
          let pos = g.pos;
          for (let i = g.start; i < n; i++) {
            const ev = this.genv(g, g.age), i1 = pos | 0, t = pos - i1;
            let x0 = L[i1 - 1], x1 = L[i1], x2 = L[i1 + 1], x3 = L[i1 + 2];
            wL[i] += ((((0.5 * (x3 - x0) + 1.5 * (x1 - x2)) * t + (x0 - 2.5 * x1 + 2 * x2 - 0.5 * x3)) * t + 0.5 * (x2 - x0)) * t + x1) * ev * aL;
            x0 = R[i1 - 1]; x1 = R[i1]; x2 = R[i1 + 1]; x3 = R[i1 + 2];
            wR[i] += ((((0.5 * (x3 - x0) + 1.5 * (x1 - x2)) * t + (x0 - 2.5 * x1 + 2 * x2 - 0.5 * x3)) * t + 0.5 * (x2 - x0)) * t + x1) * ev * aR;
            pos += g.inc; if (++g.age >= g.len) { g.on = false; break; }
          }
          g.pos = pos; g.start = 0; continue;
        }
        for (let i = g.start; i < n; i++) {
          const ev = this.genv(g, g.age); this.rd(L, R, N, mask, g.pos); wL[i] += this.rl * ev * aL; wR[i] += this.rr * ev * aR;
          g.pos += g.inc; if (!mask) { if (g.pos >= N) g.pos -= N; else if (g.pos < 0) g.pos += N; }
          if (++g.age >= g.len) { g.on = false; break; }
        }
        g.start = 0;
      }
    } else for (const g of this.grains) g.on = false;

    // ---- effects: drive → crush → filter → chorus → delay → space → volume
    const f = this.fl, rv = this.rev, dc = this.dc, fc = this.fcomp, space = s.space, crush = s.crush, chor = s.chorus, dly = s.delay, fb = Math.min(0.96, s.dfeed * 0.98);
    const crN = 1 + Math.floor(crush * crush * 40), crQ = Math.pow(2, 15 - crush * 12), dl = this.dl, dM = this.dM, chL = this.ch[0], chR = this.ch[1];
    const lpk = 1 - Math.exp(-TAU * 4200 / sr), hpk = 1 - Math.exp(-TAU * 140 / sr), dT = s.dtime;
    for (let i = 0; i < n; i++) {
      const t = (i + 1) * inv, mx = mix0 + (mix1 - mix0) * t, dg = Math.cos(mx * Math.PI / 2), wg = Math.sin(mx * Math.PI / 2);
      let l = dL[i] * dg + wL[i] * wg, r = dR[i] * dg + wR[i] * wg;
      const dv = drv0 + (drv1 - drv0) * t; if (dv > 0.001) { const k = 1 + 24 * dv * dv; l = l + dv * (tanhF(l * k) * 0.8 - l); r = r + dv * (tanhF(r * k) * 0.8 - r); }
      if (crush > 0.002) { if (++this.crC >= crN) { this.crC = 0; this.crH[0] = Math.round(l * crQ) / crQ; this.crH[1] = Math.round(r * crQ) / crQ; } const cm = Math.min(1, crush * 6); l += (this.crH[0] - l) * cm; r += (this.crH[1] - r) * cm; }
      f[0].tick(l); l = f[0].lp; f[1].tick(r); r = f[1].lp; f[2].tick(l); l = f[2].hp; f[3].tick(r); r = f[3].hp; if (fc !== 1) { l *= fc; r *= fc; }
      // chorus: two slow, wide, slightly different delays
      const cw = this.chW; chL[cw] = l; chR[cw] = r;
      if (chor > 0.002) {
        this.chPh += TAU * 0.55 / sr; if (this.chPh > TAU) this.chPh -= TAU;
        const d1 = (0.011 + 0.004 * Math.sin(this.chPh)) * sr, d2 = (0.014 + 0.005 * Math.sin(this.chPh * 0.62 + 1.7)) * sr;
        let pp = cw - d1, i0 = Math.floor(pp), u = pp - i0; const a1 = chL[i0 & 4095] + (chL[(i0 + 1) & 4095] - chL[i0 & 4095]) * u;
        pp = cw - d2; i0 = Math.floor(pp); u = pp - i0; const a2 = chR[i0 & 4095] + (chR[(i0 + 1) & 4095] - chR[i0 & 4095]) * u;
        l = l * (1 - 0.3 * chor) + a2 * 0.75 * chor; r = r * (1 - 0.3 * chor) + a1 * 0.75 * chor;
      }
      this.chW = (cw + 1) & 4095;
      // delay: ping-pong, each repeat darker and thinner; the time glides like tape when it changes
      const dw = this.dW; let el = 0, er = 0;
      { const pp = dw - dT, i0 = Math.floor(pp), u = pp - i0; el = dl[0][i0 & dM] + (dl[0][(i0 + 1) & dM] - dl[0][i0 & dM]) * u; er = dl[1][i0 & dM] + (dl[1][(i0 + 1) & dM] - dl[1][i0 & dM]) * u; }
      this.dlp[0] += (er - this.dlp[0]) * lpk; this.dlp[1] += (el - this.dlp[1]) * lpk; this.dhp[0] += (this.dlp[0] - this.dhp[0]) * hpk; this.dhp[1] += (this.dlp[1] - this.dhp[1]) * hpk;
      const send = dly > 0.002 ? Math.min(1, dly * 1.5) : 0;
      dl[0][dw] = (l + r) * 0.5 * send + tanhF((this.dlp[0] - this.dhp[0]) * fb); dl[1][dw] = tanhF((this.dlp[1] - this.dhp[1]) * fb); this.dW = (dw + 1) & dM;
      l += el * dly; r += er * dly;
      rv.process(l, r); l = l * (1 - 0.35 * space) + rv.outL * space * 1.25; r = r * (1 - 0.35 * space) + rv.outR * space * 1.25;
      const g = (vol0 + (vol1 - vol0) * t) * (g0 + (g1 - g0) * t); l *= g; r *= g;
      let y = l - dc[0] + 0.9975 * dc[1]; dc[0] = l; dc[1] = y; l = softClip(y);
      y = r - dc[2] + 0.9975 * dc[3]; dc[2] = r; dc[3] = y; r = softClip(y);
      oL[off + i] = l; oR[off + i] = r; const a = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r); if (a > this.outPk) this.outPk = a;
    }
    // CAPTURE: copy exactly N frames of this output starting on a bar line (for the deck)
    const cap = this.capture;
    if (cap) {
      const a = Math.max(0, cap.start - (this.frame + off)), take = Math.min(n - a, cap.len - cap.got);
      if (a < n && take > 0) { for (let i = 0; i < take; i++) { cap.L[cap.got + i] = oL[off + a + i]; cap.R[cap.got + i] = oR[off + a + i]; } cap.got += take; }
      if (cap.got >= cap.len) { this.capture = null; if (this.onCapture) this.onCapture(cap); }
    }
    this.frame += n;
  }
  startCapture(start, len, tag) { this.capture = { start, len, got: 0, L: new Float32Array(len), R: new Float32Array(len), tag }; }
  // TONE: below centre a low-pass closes, above centre a high-pass opens; RESO adds a peak at the cutoff
  setFilter(tone, reso) {
    this.lastTone = tone; this.lastReso = reso; const t = (tone - 0.5) * 2, sr = this.sr; let lpHz = 20000, hpHz = 15, lq = 0.707, hq = 0.707; this.fcomp = 1;
    const q = PM.reso(reso);
    if (t < -0.02) { const x = (-t - 0.02) / 0.98; lpHz = 20000 * Math.pow(70 / 20000, x); if (this.snap && reso > 0.25) lpHz = this.snap(lpHz); lq = q; }
    else if (t > 0.02) { const x = (t - 0.02) / 0.98; hpHz = 15 * Math.pow(7000 / 15, x); if (this.snap && reso > 0.25) hpHz = this.snap(hpHz); hq = q; }
    if (Math.abs(t) > 0.02) this.fcomp = Math.pow(0.707 / q, 0.45);
    // two cascaded stages each: share the resonance between them so the peak isn't squared
    const sq = Math.sqrt(Math.max(0.5, lq) * 0.9), sh = Math.sqrt(Math.max(0.5, hq) * 0.9);
    this.fl[0].set(lpHz, lq > 0.71 ? sq : 0.707, sr); this.fl[1].set(lpHz, lq > 0.71 ? sq : 0.707, sr); this.fl[2].set(hpHz, hq > 0.71 ? sh : 0.707, sr); this.fl[3].set(hpHz, hq > 0.71 ? sh : 0.707, sr);
  }
  // display peaks of the live tape (the last 20 s)
  livePeaks(out) {
    const W = Math.min(this.filled, Math.floor(G_LIVE_SEC * this.sr)), bins = out.length; if (!this.rpk || W <= 0) { out.fill(0); return; }
    const st = this.wh - W;
    for (let b = 0; b < bins; b++) { const a = st + Math.floor(W * b / bins), e = Math.max(a + 1, st + Math.floor(W * (b + 1) / bins)); let pk = 0; for (let ci = a >> 8; ci <= (e - 1) >> 8; ci++) { const v = this.rpk[ci & ((G_RING >> 8) - 1)]; if (v > pk) pk = v; } out[b] = pk; }
  }
  // a compact picture of what the engine is doing, for the display (~30 times a second)
  snapshot(wantPeaks) {
    const total = this.total || 1, gr = [];
    let c = 0; for (const g of this.grains) { if (!g.on || c >= 56) continue; c++; const base = g.ring ? this.wh - Math.min(this.filled, Math.floor(G_LIVE_SEC * this.sr)) : 0; let x = g.ring ? (((g.pos - base) % G_RING) + G_RING) % G_RING / total : g.pos / total; if (!g.ring) x -= Math.floor(x); gr.push(clamp(x, 0, 1), g.amp * this.genv(g, Math.min(g.len - 1, g.age)), g.pan || 0); }
    const snap = { live: this.live, total: total / (this.live ? this.sr : this.sRate), ph: this.phF / total, winS: this.winS / total, winL: this.winL / total, tape: this.live ? 1 : (((this.tapeAbs / total) % 1) + 1) % 1,
      grains: gr, nG: this.activeGrains, nV: this.activeVoices, inPk: this.inPk, outPk: this.outPk, e: Float32Array.from(this.e.subarray(0, GP_KNOBS)), lfo: this.lfos.map(l => l.val), filled: this.filled / this.sr,
      cap: this.capture ? this.capture.got / this.capture.len : -1 };
    this.inPk = 0; this.outPk = 0;
    if (wantPeaks && this.live) { snap.peaks = new Float32Array(wantPeaks); this.livePeaks(snap.peaks); }
    return snap;
  }
}

// ============================================================ master bus: everything passes through here on its way out
// Soft safety limiter, meters, and the tap that REC records from.
class MasterBus {
  constructor(sr) { this.sr = sr; this.vol = 1; this.sv = 1; this.pk = [0, 0]; this.rec = false; this.chunk = null; this.cn = 0; this.onChunk = null; this.env = 0; }
  process(inL, inR, oL, oR, n) {
    const k = 1 - Math.exp(-1 / (0.02 * this.sr)), rel = 1 - Math.exp(-1 / (0.25 * this.sr));
    for (let i = 0; i < n; i++) {
      this.sv += (this.vol - this.sv) * k; let l = (inL ? inL[i] : 0) * this.sv, r = (inR ? inR[i] : 0) * this.sv;
      // gentle levelling above −3 dB so stacked loops don't crunch, then the soft clip as the last net
      const a = Math.max(Math.abs(l), Math.abs(r)); this.env += (a - this.env) * (a > this.env ? 0.02 : rel);
      const gr = this.env > 0.7 ? 0.7 / this.env * 0.6 + 0.4 : 1; l = softClip(l * gr); r = softClip(r * gr);
      oL[i] = l; oR[i] = r; if (Math.abs(l) > this.pk[0]) this.pk[0] = Math.abs(l); if (Math.abs(r) > this.pk[1]) this.pk[1] = Math.abs(r);
      if (this.rec) { if (!this.chunk) { this.chunk = [new Float32Array(16384), new Float32Array(16384)]; this.cn = 0; } this.chunk[0][this.cn] = l; this.chunk[1][this.cn] = r; if (++this.cn >= 16384) this.flush(); }
    }
  }
  flush() { if (this.chunk && this.cn > 0 && this.onChunk) this.onChunk(this.chunk[0].subarray(0, this.cn), this.chunk[1].subarray(0, this.cn)); this.chunk = null; this.cn = 0; }
  setRec(on) { if (this.rec && !on) { this.rec = false; this.flush(); } else this.rec = on; }
  meter() { const p = this.pk; this.pk = [0, 0]; return p; }
}

// ============================================================ listening: key, tempo, hits, pitch
const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
function pearson12(x, y) {
  let mx = 0, my = 0; for (let i = 0; i < 12; i++) { mx += x[i]; my += y[i]; } mx /= 12; my /= 12; let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < 12; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; } return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}
// best of the 24 major / minor keys for a 12-bin pitch-class histogram
function keyFromChroma(chroma) {
  let best = -2, second = -2, key = -1;
  for (let k = 0; k < 24; k++) {
    const prof = k < 12 ? KK_MAJ : KK_MIN, rot = new Array(12); for (let i = 0; i < 12; i++) rot[i] = prof[((i - k % 12) + 12) % 12];
    const r = pearson12(chroma, rot); if (r > best) { second = best; best = r; key = k; } else if (r > second) second = r;
  }
  return key < 0 ? { root: -1, minor: false, confidence: 0, margin: 0 } : { root: key % 12, minor: key >= 12, confidence: best, margin: best - second };
}
// chroma of a sound: spectral peaks folded onto the 12 notes, loud frames counting more
function chromaOf(mono, sr, maxSec) {
  const N = sr > 30000 ? 16384 : 8192, n = Math.min(mono.length, Math.floor((maxSec || 30) * sr)), chroma = new Float32Array(12); if (n < N / 2) return null;
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(TAU * i / (N - 1));
  const re = new Float32Array(N), im = new Float32Array(N), mag = new Float32Array(N / 2);
  const span = Math.max(0, n - N), frames = Math.min(32, Math.max(1, Math.floor(span / (N / 2)) + 1)), binHz = sr / N;
  const kLo = Math.max(2, Math.floor(60 / binHz)), kHi = Math.min(N / 2 - 2, Math.floor(4200 / binHz)); let tot = 0;
  for (let f = 0; f < frames; f++) {
    const off = frames > 1 ? Math.floor(span * f / (frames - 1)) : 0; let en = 0;
    for (let i = 0; i < N; i++) { const s = off + i < n ? mono[off + i] : 0; re[i] = s * win[i]; im[i] = 0; en += s * s; }
    if (en < 1e-6 * N) continue; fft(re, im); let mx = 0;
    for (let k = 0; k < N / 2; k++) { mag[k] = Math.hypot(re[k], im[k]); if (mag[k] > mx) mx = mag[k]; }
    const fc = new Float32Array(12);
    for (let k = kLo; k <= kHi; k++) {
      const m = mag[k]; if (m < 0.03 * mx || m <= mag[k - 1] || m < mag[k + 1]) continue;
      const a = mag[k - 1], c = mag[k + 1], den = a - 2 * m + c, d = den !== 0 ? 0.5 * (a - c) / den : 0, hz = (k + d) * binHz;
      fc[pcOf(hzMidi(hz))] += Math.sqrt(m);
    }
    let sum = 0; for (const v of fc) sum += v; if (sum <= 0) continue; const w = Math.sqrt(en / N);
    for (let i = 0; i < 12; i++) chroma[i] += fc[i] / sum * w; tot += w;
  }
  return tot > 0 ? chroma : null;
}
function detectKey(mono, sr) { const c = chromaOf(mono, sr); return c ? keyFromChroma(c) : { root: -1, minor: false, confidence: 0, margin: 0 }; }
// share of a sound's pitched energy that sits on the notes of a scale (random material scores about 58% for 7-note scales)
function inScaleShare(mono, sr, pcs) { const c = chromaOf(mono, sr, 60); if (!c) return 0; let a = 0, t = 0; for (let i = 0; i < 12; i++) { t += c[i]; if (pcs.includes(i)) a += c[i]; } return t > 0 ? a / t : 0; }

function firstSound(L, R, pk, sr) { const th = 0.03 * pk; for (let i = 0; i < L.length; i++) if (Math.abs(L[i]) > th || Math.abs(R[i]) > th) return Math.max(0, i - Math.round(0.002 * sr)); return 0; }
// onset strength (spectral flux) plus, per frame, how much NEW energy arrived below 150 Hz and above 5 kHz:
// new energy rather than total, so a kick's tail doesn't make the hat that follows read as a kick
function spectra(x, sr) {
  const N = sr > 60000 ? 2048 : 1024, hop = N / 4, frames = Math.max(1, Math.floor((x.length - N) / hop) + 1);
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(TAU * i / (N - 1));
  const re = new Float32Array(N), im = new Float32Array(N), prev = new Float32Array(N / 2), prevP = new Float32Array(N / 2);
  const flux = new Float32Array(frames), low = new Float32Array(frames), high = new Float32Array(frames), tot = new Float32Array(frames);
  const kLow = Math.ceil(150 * N / sr), kHigh = Math.floor(5000 * N / sr);
  for (let f = 0; f < frames; f++) {
    const o = f * hop; for (let i = 0; i < N; i++) { re[i] = (o + i < x.length ? x[o + i] : 0) * win[i]; im[i] = 0; }
    fft(re, im); let fl = 0, lo = 0, hi = 0, t = 0;
    for (let k = 1; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k], m = Math.log1p(1000 * Math.sqrt(p)), d = m - prev[k]; if (d > 0) fl += d; prev[k] = m;
      const dp = p - prevP[k]; prevP[k] = p; if (dp > 0) { t += dp; if (k < kLow) lo += dp; else if (k > kHigh) hi += dp; }
    }
    flux[f] = fl; low[f] = lo; high[f] = hi; tot[f] = t;
  }
  return { N, hop, flux, low, high, tot, frames };
}
function pickOnsets(S, sr, sens) {   // sens 0..1: more cuts as it rises
  const { flux, hop, N } = S, n = flux.length, out = [], minGap = Math.max(1, Math.round(0.055 * sr / hop));
  let mean = 0; for (const v of flux) mean += v; mean /= Math.max(1, n);
  const k = 1.9 - 1.3 * sens, w = Math.max(3, Math.round(0.12 * sr / hop)); let last = -1e9;
  for (let i = 1; i < n - 1; i++) {
    if (flux[i] <= 1e-6 || flux[i] < flux[i - 1] || flux[i] < flux[i + 1]) continue;
    let loc = 0, c = 0; for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) { loc += flux[j]; c++; } loc /= c;
    if (flux[i] < loc * 1.25 + mean * k * 0.5 || flux[i] < mean * (0.6 + k * 0.5)) continue;
    if (i - last < minGap) { if (out.length && flux[i] > flux[out[out.length - 1]]) { out[out.length - 1] = i; last = i; } continue; }
    out.push(i); last = i;
  }
  return out.map(f => f * hop + N / 2);
}
// slide an onset onto the attack itself: the steepest rise of the waveform near the flux peak
function refineOnset(x, c, N) {
  const a = Math.max(0, c - (N >> 1)), b = Math.min(x.length, c + N), H = 16, env = [];
  for (let i = a; i < b; i += H) { let m = 0; for (let j = i; j < Math.min(x.length, i + 32); j++) { const v = Math.abs(x[j]); if (v > m) m = v; } env.push(m); }
  let best = -1, bk = 0; for (let k = 4; k < env.length; k++) { const lo = Math.min(env[k - 4], env[k - 3], env[k - 2], env[k - 1]), d = env[k] - lo * 1.3; if (d > best) { best = d; bk = k; } }
  let k = bk; while (k > 0 && env[k - 1] < env[k] && k > bk - 6) k--;
  return Math.max(0, a + k * H);
}
// tempo from the rhythm of the onsets; when the file is a tight loop its length settles the exact value
function findTempo(S, sr, durSec) {
  const { flux, hop } = S, n = flux.length, x = new Float32Array(n); let m = 0; for (const v of flux) m += v; m /= Math.max(1, n);
  let en = 0; for (let i = 0; i < n; i++) { x[i] = Math.max(0, flux[i] - m); en += x[i] * x[i]; }
  const fps = sr / hop, acf = lag => { const l0 = Math.floor(lag), t = lag - l0; let s0 = 0, s1 = 0; for (let i = 0; i + l0 + 1 < n; i++) { s0 += x[i] * x[i + l0]; s1 += x[i] * x[i + l0 + 1]; } return (s0 * (1 - t) + s1 * t) / Math.max(1, n - l0); };
  const score = bpm => { const lag = 60 / bpm * fps; return (acf(lag) + 0.5 * acf(lag * 2) + 0.25 * acf(lag * 4)) * Math.exp(-0.5 * Math.pow(Math.log2(bpm / 112) / 0.9, 2)); };
  let best = 120, bs = -1; for (let b = 60; b <= 200; b += 0.5) { const s = score(b); if (s > bs) { bs = s; best = b; } }
  for (let b = best - 0.5; b <= best + 0.5; b += 0.05) { const s = score(b); if (s > bs) { bs = s; best = b; } }
  const strength = en > 0 ? clamp(acf(60 / best * fps) / (en / n), 0, 1) : 0;
  let bars = 0, pick = null, pd = 0.05; const cands = [];
  for (const nb of [1, 2, 4, 8, 16]) { const b = nb * 4 * 60 / durSec; if (b >= 60 && b <= 200) cands.push([b, nb]); }
  // prefer the reading that matches the beat itself; only then its double or half
  for (const mul of [1, 2, 0.5]) { for (const [b, nb] of cands) { const d = Math.abs(b / (best * mul) - 1); if (d < pd) { pd = d; pick = [b, nb]; } } if (pick) break; }
  if (pick) { best = pick[0]; bars = pick[1]; }
  else { if (Math.abs(best - Math.round(best)) < 0.2) best = Math.round(best); const b = durSec / (240 / best); bars = Math.abs(b - Math.round(b)) < 0.3 && b >= 0.7 ? Math.max(1, Math.round(b)) : Math.max(0.25, Math.round(b * 4) / 4); }
  return { bpm: Math.round(best * 100) / 100, bars, exact: !!pick, strength };
}

// ---------- pitch of a single voice: YIN on a 16 kHz copy, one value every 5 ms (0 = unvoiced)
function pitchTrack(x, sr) {
  const D = Math.max(1, Math.round(sr / 16000)), fs = sr / D, a = new Svf(), b = new Svf(); a.set(fs * 0.42, 0.707, sr); b.set(fs * 0.42, 0.707, sr);
  const y = new Float32Array(Math.floor(x.length / D)); for (let i = 0, j = 0; i < x.length; i++) { a.tick(x[i]); b.tick(a.lp); if (i % D === 0 && j < y.length) y[j++] = b.lp; }
  const hop = Math.round(0.005 * fs), W = Math.round(0.03 * fs), minLag = Math.floor(fs / 1100), maxLag = Math.ceil(fs / 65);
  const frames = Math.max(1, Math.floor((y.length - W - maxLag) / hop)), f0 = new Float32Array(frames), ap = new Float32Array(frames), rms = new Float32Array(frames), d = new Float32Array(maxLag + 2);
  let pkR = 0; for (let f = 0; f < frames; f++) { const o = f * hop; let e = 0; for (let j = 0; j < W; j++) e += y[o + j] * y[o + j]; rms[f] = Math.sqrt(e / W); if (rms[f] > pkR) pkR = rms[f]; }
  for (let f = 0; f < frames; f++) {
    const o = f * hop; if (rms[f] < 0.015 * pkR) { ap[f] = 1; continue; }
    let run = 0; d[0] = 1;
    for (let t = 1; t <= maxLag; t++) { let s = 0; for (let j = 0; j < W; j++) { const q = y[o + j] - y[o + j + t]; s += q * q; } run += s; d[t] = run > 0 ? s * t / run : 1; }
    let tau = -1; for (let t = minLag; t < maxLag; t++) if (d[t] < 0.15) { while (t + 1 < maxLag && d[t + 1] < d[t]) t++; tau = t; break; }
    if (tau < 0) { let mn = 1e9; for (let t = minLag; t < maxLag; t++) if (d[t] < mn) { mn = d[t]; tau = t; } }
    const p0 = d[tau - 1], p1 = d[tau], p2 = d[tau + 1], den = p0 - 2 * p1 + p2, sh = den !== 0 ? 0.5 * (p0 - p2) / den : 0;
    ap[f] = p1; f0[f] = fs / (tau + clamp(sh, -0.5, 0.5));
  }
  // voiced = periodic and loud enough; then undo octave slips and drop blips shorter than 30 ms
  const voiced = new Uint8Array(frames); for (let f = 0; f < frames; f++) voiced[f] = ap[f] < 0.28 && rms[f] > 0.03 * pkR ? 1 : 0;
  const lm = new Float32Array(frames); for (let f = 0; f < frames; f++) lm[f] = voiced[f] ? Math.log2(f0[f]) : NaN;
  for (let f = 0; f < frames; f++) {
    if (!voiced[f]) continue; const w = []; for (let k = Math.max(0, f - 12); k <= Math.min(frames - 1, f + 12); k++) if (voiced[k]) w.push(lm[k]); w.sort((p, q) => p - q);
    const med = w[w.length >> 1]; let v = lm[f]; while (v - med > 0.6) v -= 1; while (med - v > 0.6) v += 1; lm[f] = v;
  }
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) { if (!voiced[f]) continue; const w = []; for (let k = Math.max(0, f - 2); k <= Math.min(frames - 1, f + 2); k++) if (voiced[k]) w.push(lm[k]); w.sort((p, q) => p - q); out[f] = Math.pow(2, w[w.length >> 1]); }
  for (let f = 0; f < frames;) { if (!out[f]) { f++; continue; } let g = f; while (g < frames && out[g]) g++; if (g - f < 6) for (let k = f; k < g; k++) out[k] = 0; f = g; }
  return { f0: out, rms, hop: hop * D, frames };
}
// dominant note of a short piece of any sound + how clearly pitched it is + its register
function chunkPitch(x, sr, s) {
  const N = sr > 30000 ? 8192 : 4096, re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) { const v = s + i < x.length ? x[s + i] : 0; re[i] = v * (0.5 - 0.5 * Math.cos(TAU * i / (N - 1))); im[i] = 0; }
  fft(re, im); const binHz = sr / N, mag = new Float32Array(N / 2); let mx = 0;
  for (let k = 1; k < N / 2; k++) { mag[k] = Math.hypot(re[k], im[k]); if (mag[k] > mx) mx = mag[k]; }
  const ch = new Float32Array(12), lowest = new Array(12).fill(0), kHi = Math.min(N / 2 - 2, Math.floor(4200 / binHz));
  for (let k = Math.max(2, Math.floor(55 / binHz)); k <= kHi; k++) {
    const m = mag[k]; if (m < 0.05 * mx || m <= mag[k - 1] || m < mag[k + 1]) continue;
    const a = mag[k - 1], c = mag[k + 1], den = a - 2 * m + c, d = den !== 0 ? 0.5 * (a - c) / den : 0, midi = hzMidi((k + d) * binHz), pc = pcOf(midi);
    ch[pc] += m; if (!lowest[pc] && m > 0.2 * mx) lowest[pc] = Math.round(midi);
  }
  let sum = 0, best = 0; for (let i = 0; i < 12; i++) { sum += ch[i]; if (ch[i] > ch[best]) best = i; }
  return { pc: best, tonal: sum > 0 ? ch[best] / sum : 0, midi: lowest[best] || (60 + best) };
}
// first look at any sound entering the crate: length, level, key, and tempo when it has a steady beat
function analyzeSound(L, R, rate) {
  const pk = peakOf(L, R), dur = L.length / rate, info = { dur, peak: pk, key: null, bpm: null, bars: null, kind: "tone" };
  if (pk < 1e-4 || dur < 0.05) { info.kind = "silent"; return info; }
  const n = Math.min(L.length, Math.floor(60 * rate)), x = monoOf(L, R, 0, n);
  const k = detectKey(x, rate); if (k.root >= 0) info.key = { root: k.root, minor: k.minor, confidence: k.confidence };
  if (dur > 0.9) {
    const trim = firstSound(L, R, pk, rate), y = trim > 0 ? x.subarray(trim) : x, S = spectra(y, rate), on = pickOnsets(S, rate, 0.5), t = findTempo(S, rate, y.length / rate);
    const perSec = on.length / (y.length / rate); let hi = 0, tot = 0; for (let f = 0; f < S.frames; f++) { hi += S.high[f] + S.low[f]; tot += S.tot[f]; }
    info.onsets = on.length; info.rhythm = t.strength;
    if (on.length >= 4 && perSec > 1.2 && (t.exact || t.strength > 0.25)) { info.bpm = t.bpm; info.bars = t.bars; info.tight = t.exact; }
    // drums: a tight loop with a steady beat, or bursts in the lows and highs with no confident key (only a label: every room takes any sound)
    const weakKey = !info.key || info.key.confidence < 0.6;
    if (info.bpm && perSec > 1.5 && (t.exact && (weakKey || tot > 0 && hi / tot > 0.5) || weakKey && tot > 0 && hi / tot > 0.45)) info.kind = "beat";
  }
  return info;
}

// ============================================================ built-in sounds (all original synthesis)
// So every room works before anything is loaded: an icy bell-and-choir texture, two drum loops, a bell phrase and a sung voice.
function makeCrystal(sr){
  const T=8, n=Math.floor(sr*T), L=new Float32Array(n), R=new Float32Array(n);
  let seed=333; const rnd=()=>{ seed=(seed*1664525+1013904223)>>>0; return seed/4294967296; };
  const scale=[0,3,5,7,10,12,15,17,19,22], base=440*Math.pow(2,(62-69)/12);
  for (let k=0;k<22;k++){ const st=scale[Math.floor(rnd()*scale.length)], f=base*Math.pow(2,st/12)*(rnd()<0.3?2:1), pan=0.2+rnd()*0.6, i0=Math.floor(k*0.3*sr), m=Math.min(n-i0,Math.floor(2.5*sr));
    for (let i=0;i<m;i++){ const t=i/sr, env=Math.exp(-t*2.2)*(1-Math.exp(-t*400)), idx=3*Math.exp(-t*4);
      const s=(Math.sin(TAU*f*t+idx*Math.sin(TAU*f*3.5*t))*env+0.3*Math.sin(TAU*f*2.76*t)*Math.exp(-t*5))*0.22;
      L[i0+i]+=s*(1-pan); R[i0+i]+=s*pan; } }
  const form=fr=>Math.exp(-(((fr-700)/350)**2))+0.7*Math.exp(-(((fr-1150)/300)**2))+0.4*Math.exp(-(((fr-2600)/500)**2));
  const pad=new Float32Array(n);
  for (const f of [146.83,220,261.63,349.23]) for (const d of [-0.3,0,0.31]){ const ff=f+d;
    for (let h=1;h*ff<4000;h++){ const a=form(h*ff)/h; if (a<0.004) continue; const w=TAU*h*ff/sr, ph0=rnd()*TAU;
      const cr=Math.cos(w), sn=Math.sin(w); let x=Math.cos(ph0), y=Math.sin(ph0);
      for (let i=0;i<n;i++){ pad[i]+=a*y; const nx=x*cr-y*sn; y=x*sn+y*cr; x=nx; } } }
  let mx=0; for (let i=0;i<n;i++){ const t=i/sr; pad[i]*=Math.min(1,t/2.5)*Math.min(1,(T-t)/1.5)*(0.7+0.3*Math.sin(TAU*0.25*t)); mx=Math.max(mx,Math.abs(pad[i])); }
  const sh=Math.floor(0.005*sr); let nz=0;
  for (let i=0;i<n;i++){ const t=i/sr; L[i]+=0.22*pad[i]/mx; R[i]+=0.22*pad[(i-sh+n)%n]/mx; nz+=0.04*((rnd()*2-1)*1.7-nz); const b=0.05*nz*Math.min(1,t/T*1.5); L[i]+=b; R[i]-=b; }
  for (let k=0;k<14;k++){ const i0=Math.floor((5.6+k*0.13)*sr), m=Math.floor(0.012*sr);
    for (let i=0;i<m;i++){ const v=Math.round((rnd()*2-1)*4)/4*Math.exp(-i/(m/4))*0.25; L[i0+i]+=v; R[i0+m-1-i]+=v; } }
  let pk=0; for (let i=0;i<n;i++) pk=Math.max(pk,Math.abs(L[i]),Math.abs(R[i]));
  for (let i=0;i<n;i++){ L[i]*=0.89/pk; R[i]*=0.89/pk; }
  return {L,R,rate:sr,name:"CRYSTAL"};
}

function demoBeat(which,sr){
  const bpm=which===0?92:126, bars=2, step=60/bpm/4, n=Math.round(bars*16*step*sr), L=new Float32Array(n), R=new Float32Array(n);
  let seed=which?77:33; const rnd=()=>{ seed=(seed*1664525+1013904223)>>>0; return seed/4294967296*2-1; };
  const add=(t,fn,len,pan=0)=>{ const i0=Math.round(t*sr), m=Math.min(n-i0,Math.round(len*sr)); for (let i=0;i<m;i++){ const v=fn(i/sr); L[i0+i]+=v*(1-pan); R[i0+i]+=v*(1+pan); } };
  const kick=a=>{ let ph=0; return t=>{ ph+=2*Math.PI*(48+110*Math.exp(-t*28))/sr; return a*(Math.sin(ph)*Math.exp(-t*7)+0.3*Math.exp(-t*300)*rnd()*0.5); }; };
  const hp=()=>{ const f=new Svf(); f.set(7500,0.8,sr); return x=>{ f.tick(x); return f.hp; }; }, bp=fc=>{ const f=new Svf(); f.set(fc,1.2,sr); return x=>{ f.tick(x); return x-f.hp-f.lp; }; };
  const snare=a=>{ const f=bp(2200); return t=>a*(0.55*f(rnd())*Math.exp(-t*16)+0.4*Math.sin(2*Math.PI*190*t)*Math.exp(-t*22)); };
  const clap=a=>{ const f=bp(1300); return t=>{ const b=(t<0.01||(t>0.012&&t<0.022)||(t>0.024&&t<0.034))?1:0.0; return a*f(rnd())*(b*0.9+Math.exp(-(Math.max(0,t-0.034))*14)*(t>0.034?1:0))*1.6; }; };
  const hat=(a,open)=>{ const f=hp(); return t=>a*f(rnd())*Math.exp(-t*(open?9:55)); };
  const rim=a=>t=>a*(Math.sin(2*Math.PI*820*t)+0.5*Math.sin(2*Math.PI*1640*t))*Math.exp(-t*60);
  for (let b=0;b<bars;b++){ const o=b*16*step;
    if (which===0){   // dusty boom-bap, swung 16ths
      const sw=s=>(o+s*step+(s%2?step*0.28:0));
      for (const s of (b===0?[0,7,10]:[0,3,10,11])) add(sw(s),kick(0.95),0.5);
      for (const s of [4,12]) add(sw(s),snare(0.8),0.3,-0.05);
      for (let s=0;s<16;s+=2) add(sw(s),hat(0.32+0.12*((s/2)%2===0),false),0.12,0.2);
      if (b===1) add(sw(15),snare(0.25),0.2);
      add(sw(b?13:6),rim(0.25),0.06,-0.3);
    } else {           // house: four to the floor, claps, offbeat open hats, 16th shaker
      for (const s of [0,4,8,12]) add(o+s*step,kick(1),0.4);
      for (const s of [4,12]) add(o+s*step,clap(0.7),0.35,0.05);
      for (const s of [2,6,10,14]) add(o+s*step,hat(0.4,true),0.3,-0.15);
      for (let s=0;s<16;s++) if (s%2) add(o+s*step+0.004,hat(0.16,false),0.05,0.3);
      if (b===1) add(o+15*step,rim(0.22),0.06,0.3);
    } }
  const pk=peakOf(L,R); for (let i=0;i<n;i++){ L[i]*=0.89/pk; R[i]*=0.89/pk; }
  return {L,R,rate:sr,name:which===0?"DUSTY BOOM-BAP":"GLASS HOUSE"};
}
function demoBells(sr){   // E minor bell phrase with a soft low drone
  const T=9, n=Math.round(T*sr), L=new Float32Array(n), R=new Float32Array(n);
  let seed=909; const rnd=()=>{ seed=(seed*1664525+1013904223)>>>0; return seed/4294967296; };
  const sc=[0,3,5,7,10,12,15,19]; let t=0;
  while (t<T-1.2){ const midi=64+sc[Math.floor(rnd()*sc.length)], f=440*Math.pow(2,(midi-69)/12), pan=rnd()*0.8-0.4, i0=Math.round(t*sr), m=Math.min(n-i0,Math.round(1.6*sr));
    for (let i=0;i<m;i++){ const tt=i/sr, env=Math.exp(-tt*3)*(1-Math.exp(-tt*600)), v=(Math.sin(2*Math.PI*f*tt+1.4*Math.exp(-tt*5)*Math.sin(2*Math.PI*f*2*tt))+0.25*Math.sin(2*Math.PI*f*4.02*tt)*Math.exp(-tt*8))*env*0.3;
      L[i0+i]+=v*(1-pan); R[i0+i]+=v*(1+pan); }
    t+=[0.25,0.5,0.5,0.75,1][Math.floor(rnd()*5)]; }
  for (const f of [82.41,123.47]) for (let i=0;i<n;i++){ const v=0.08*Math.sin(2*Math.PI*f*i/sr)*Math.min(1,i/sr,(n-i)/sr); L[i]+=v; R[i]+=v; }
  const pk=peakOf(L,R); for (let i=0;i<n;i++){ L[i]*=0.89/pk; R[i]*=0.89/pk; }
  return {L,R,rate:sr,name:"GLASS BELLS"};
}

function demoVoice(sr){
  const T=7.2, n=Math.round(T*sr), out=new Float32Array(n);
  let seed=4242; const rnd=()=>{ seed=(seed*1664525+1013904223)>>>0; return seed/4294967296; };
  const V={a:[800,1150,2900],e:[480,1700,2600],i:[300,2200,3000],o:[480,820,2800],u:[340,760,2500]};
  // a little line around A minor, each note sung a bit flat or sharp
  const line=[[0.15,0.55,69.35,"a"],[0.78,0.4,72.3,"e"],[1.25,0.6,71.7,"i"],[1.95,0.9,67.4,"o"],[3.0,0.45,69.6,"a"],[3.55,0.5,76.35,"e"],[4.15,0.55,74.3,"i"],[4.8,1.3,72.4,"a"],[6.2,0.8,64.35,"u"]];
  let ph=0;
  const res=[0,1,2].map(()=>({y1:0,y2:0}));
  for (const [t0,dur,midi,vw] of line){ const i0=Math.round(t0*sr), m=Math.round(dur*sr), F=V[vw];
    if (rnd()<0.6){ const c=Math.round(0.06*sr); for (let i=0;i<c&&i0-c+i>=0;i++){ const hpn=(rnd()*2-1); out[i0-c+i]+=hpn*0.05*Math.sin(Math.PI*i/c)*(vw==="i"?1.3:1); } }
    for (let i=0;i<m;i++){ const t=i/sr, vib=0.35*Math.sin(2*Math.PI*5.3*t)*Math.min(1,t/0.25), f=440*Math.pow(2,(midi+vib-69+(t<0.05?-0.6*(1-t/0.05):0))/12);
      ph+=f/sr; if (ph>=1) ph-=1;
      const g=ph<0.6?0.5-0.5*Math.cos(Math.PI*ph/0.6):Math.cos(Math.PI*(ph-0.6)/0.8);   // glottal pulse
      let src=(g-0.4)+0.04*(rnd()*2-1), y=0;
      F.forEach((fc,k)=>{ const bw=[90,110,150][k], rr=Math.exp(-Math.PI*bw/sr), w=2*Math.PI*fc/sr, s=res[k];
        const v=(1-rr)*src*[1,0.6,0.3][k]+2*rr*Math.cos(w)*s.y1-rr*rr*s.y2; s.y2=s.y1; s.y1=v; y+=v; });
      const env=Math.min(1,t/0.04)*Math.min(1,(dur-t)/0.08); out[i0+i]+=y*env*6; } }
  let pk=0; for (const v of out) pk=Math.max(pk,Math.abs(v)); const L=new Float32Array(n), R=new Float32Array(n); for (let i=0;i<n;i++){ L[i]=R[i]=out[i]/pk*0.85; }
  return {L,R,rate:sr,name:"SNOW VOICE"};
}

// ============================================================ shared by every generator
// Each room ends with the same finishing chain (LOW END + DEFINITION) and the same step-gate envelope.
const FINISH_DEF = { lowcut: 20, bass: 0, sub: 0, mono: false, presence: 0, air: 0, punch: 0, width: 1 };
const ENV_DEF = { rate: 0, a: 0.004, d: 0.18, s: 0 };
// envelope gate: retriggers on every step of the grid and cuts a loop into defined notes (adds src into dst)
function gateInto(src, dst, N, sr, beatSec, env, level) {
  if (!env || !(env.rate > 0)) { for (let i = 0; i < N; i++) dst[i] += src[i] * level; return; }
  const stepLen = beatSec * sr / env.rate, ka = 1 - Math.exp(-1 / (Math.max(0.0005, env.a) * sr)), kd = 1 - Math.exp(-1 / (Math.max(0.005, env.d) * sr * 0.5)), sus = clamp(env.s, 0, 1);
  const warm = Math.min(N, Math.round(stepLen * 2)); let g = 0, rising = true, lastStep = -1;
  for (let j = -warm; j < N; j++) {
    const i = j < 0 ? j + N : j, step = Math.floor(i / stepLen);
    if (step !== lastStep) { lastStep = step; rising = true; }
    if (rising) { g += (1.25 - g) * ka; if (g >= 1) { g = 1; rising = false; } } else g += (sus - g) * kd;
    if (j >= 0) dst[i] += src[i] * g * level;
  }
}
// the finishing chain, in place. loop=true runs the tail of the loop through first so filters and followers wrap seamlessly.
function finishMix(L, R, sr, opts, root, loop) {
  const N = L.length, m = Object.assign({}, FINISH_DEF, opts);
  const lowcut = m.lowcut > 21, hp1 = new Biquad().set("hp", m.lowcut, 0.5412, 0, sr), hp2 = new Biquad().set("hp", m.lowcut, 1.3066, 0, sr);
  const shelf = Math.abs(m.bass) > 0.05 ? new Biquad().set("shelf", 110, 0.707, m.bass, sr) : null;
  const pres = Math.abs(m.presence) > 0.05 ? new Biquad().set("peak", 3200, 0.9, m.presence, sr) : null;
  const air = Math.abs(m.air) > 0.05 ? new Biquad().set("hishelf", 9000, 0.707, m.air, sr) : null;
  const monoLp = m.mono ? new Biquad().set("lp", 150, 0.707, 0, sr) : null;
  const subLp = m.sub > 0.001 ? [new Biquad().set("lp", 220, 0.707, 0, sr), new Biquad().set("lp", 220, 0.707, 0, sr)] : null;
  // SUB: a sine on the key's root (41–82 Hz) that follows the loop's own low end; a whole number of cycles per loop so it wraps cleanly
  let subF = midiHz(root === undefined ? 9 : root); while (subF < 41) subF *= 2; while (subF >= 82) subF /= 2;
  if (loop) subF = Math.max(1, Math.round(subF * N / sr)) * sr / N;
  const subW = TAU * subF / sr, sa = 1 - Math.exp(-1 / (0.004 * sr)), srl = 1 - Math.exp(-1 / (0.12 * sr));
  const pk = m.punch, fA = 1 - Math.exp(-1 / (0.0008 * sr)), fR = 1 - Math.exp(-1 / (0.03 * sr)), sA = 1 - Math.exp(-1 / (0.025 * sr)), sR = 1 - Math.exp(-1 / (0.25 * sr)), gS = 1 - Math.exp(-1 / (0.002 * sr));
  let subEnv = 0, ef = 0, es = 0, pg = 1; const wd = m.width === undefined ? 1 : m.width;
  const warm = loop ? Math.min(N, Math.round(2 * sr)) : 0, active = lowcut || shelf || pres || air || monoLp || subLp || Math.abs(pk) > 0.01 || Math.abs(wd - 1) > 0.01;
  if (active) for (let j = -warm; j < N; j++) {
    const i = j < 0 ? j + N : j; let l = L[i], r = R[i];
    if (lowcut) { l = hp2.tick(hp1.tick(l, 0), 0); r = hp2.tick(hp1.tick(r, 1), 1); }
    if (shelf) { l = shelf.tick(l, 0); r = shelf.tick(r, 1); }
    if (wd !== 1) { const mid = (l + r) * 0.5, side = (l - r) * 0.5 * wd; l = mid + side; r = mid - side; }
    if (monoLp) { const side = monoLp.tick((l - r) * 0.5, 0); l -= side; r += side; }
    if (subLp) { const lo = Math.abs(subLp[1].tick(subLp[0].tick((l + r) * 0.5, 0), 0)); subEnv += (lo - subEnv) * (lo > subEnv ? sa : srl); const sv = Math.sin(subW * i) * subEnv * m.sub * 2.2; l += sv; r += sv; }
    if (pres) { l = pres.tick(l, 0); r = pres.tick(r, 1); }
    if (air) { l = air.tick(l, 0); r = air.tick(r, 1); }
    if (Math.abs(pk) > 0.01) { const a = Math.abs(l) + Math.abs(r); ef += (a - ef) * (a > ef ? fA : fR); es += (a - es) * (a > es ? sA : sR); const want = clamp(Math.pow((ef + 1e-5) / (es + 1e-5), pk * 1.6), 0.25, 4); pg += (want - pg) * gS; l *= pg; r *= pg; }
    if (j >= 0) { L[i] = l; R[i] = r; }
  }
  normalize(L, R, 0.89);
}
// TUNE: a feedback comb at a note's own pitch makes whatever passes through it ring on that note
class Comb {
  constructor(sr, hz, amt) { this.d = sr / Math.max(30, hz); this.n = Math.ceil(this.d) + 2; this.b = [new Float32Array(this.n), new Float32Array(this.n)]; this.w = 0; this.g = 0.55 + 0.4 * amt; this.amt = amt; this.k = (1 - this.g) * 2.2; }
  tick(x, c) {
    const buf = this.b[c], rp = this.w - this.d, i0 = Math.floor(rp), t = rp - i0, n = this.n, a = buf[((i0 % n) + n) % n], z = buf[(((i0 + 1) % n) + n) % n];
    const y = x + this.g * (a + (z - a) * t); buf[this.w % n] = y; if (c) this.w++; return x * (1 - this.amt) + y * this.k * this.amt;
  }
}
// how long a comb keeps ringing after its input stops (to about −50 dB), capped
const ringSec = (hz, g) => Math.min(0.35, Math.log(0.003) / Math.log(g) / Math.max(30, hz));
// energy-weighted random positions (0..1), so things land on sound rather than silence
function makePosPicker(L, rate) {
  const win = Math.max(1, Math.floor(rate * 0.25)), n = Math.max(1, Math.floor(L.length / win)), w = new Float32Array(n); let tot = 0;
  for (let i = 0; i < n; i++) { let s = 0; for (let j = i * win; j < Math.min(L.length, (i + 1) * win); j += 8) s += L[j] * L[j]; w[i] = Math.sqrt(s) + 1e-6; tot += w[i]; }
  return r => { let x = r() * tot; for (let i = 0; i < n; i++) { x -= w[i]; if (x <= 0) return Math.min(0.98, (i + r()) / n); } return r(); };
}
// which way (and how far) to transpose a sound so its key lands on the session key; 0 when its key is unclear
function keyShift(srcKey, root, scale) {
  if (!srcKey || srcKey.root < 0 || srcKey.confidence < 0.45) return 0;
  const srcRel = srcKey.minor ? srcKey.root : (srcKey.root + 9) % 12;   // compare relative-minor tonics: C major and A minor share their notes
  const tgtRel = scale === "dor" ? (root + 7) % 12 : scale === "phr" ? (root + 5) % 12 : scaleIsMinor(scale) ? root : (root + 9) % 12;
  return shiftTo(srcRel, tgtRel);
}
// trim or pad a stereo pair to exactly `want` frames (after resampling a loop, so it still fills its bars to the sample)
function exactLen(L, R, want) { if (L.length === want) return [L, R]; const a = new Float32Array(want), b = new Float32Array(want), n = Math.min(want, L.length); a.set(L.subarray(0, n)); b.set(R.subarray(0, n)); return [a, b]; }

// ============================================================ CRYSTALLISE
// One sound + the session key and tempo → a seamless loop grown from granular layers. Each layer is the live engine,
// rendered offline, driven by a little sequencer: a scene per bar, parameter locks on the grid, a fill in the last beat.
// Everything pitched moves by whole octaves (or is tuned to notes of the key), so a loop never drifts out of key.
const CRYS_ARCHS = ["GLACIER", "SHARDS", "FROST_PULSE", "SNOWFALL", "BLACK_ICE", "PRISM", "AURORA", "HAIL"];
const CRYS_AMBIENT = ["GLACIER", "SNOWFALL", "PRISM", "AURORA"], CRYS_RHYTHMIC = ["SHARDS", "FROST_PULSE", "BLACK_ICE", "HAIL"];
const OCT_MOVES = [0, 0, 0, 12, -12, 12, -12, 24, -24];
const CV = { size: PM.sizeInv, dens: PM.densityInv, pitch: PM.pitchInv, vol: PM.volInv, scan: PM.scanInv, decay: PM.decayInv, grid: n => GRID_NAMES.indexOf(n), dtime: n => (DELAY_NAMES.indexOf(n) + 0.5) / DELAY_NAMES.length };
// tone bands: dark low-pass, open, thin high-pass (0.5 = flat)
function crTone(r) { const u = r(); return u < 0.42 ? 0.1 + r() * 0.3 : u < 0.72 ? 0.42 + r() * 0.16 : 0.6 + r() * 0.26; }
function crScan(r, rhythmic) { const set = rhythmic ? [1, 1, -1, 2, 0.5, -2, 0] : [0, 0.05, -0.05, 0.15, -0.15, 0.5, -0.5, 1, -1, 2]; return CV.scan(set[Math.floor(r() * set.length)]); }
function euclid(k, n, rot) { const out = []; for (let i = 0; i < n; i++) out.push(((i * k) % n) < k); return out.map((_, i) => out[(i + rot) % n]); }

// Each archetype: fixed settings, whether the drone voice plays, note events (in beats) and automation over the loop
const CRYS_ARCH = {
  GLACIER: (r, c) => { const pick = a => a[Math.floor(r() * a.length)], base = c.pos(r), sweep = 0.06 + 0.04 * c.depth * r(), ph = r() * TAU;
    return { name: "GLACIER", kana: "氷河", desc: "slow frozen pad", gain: 0.9, play: true, notes: [],
      p: { SIZE: CV.size(0.6 + r() * 1.0), DENSITY: CV.dens(12 + r() * 18), SPRAY: 0.3 + r() * 0.3, SPREAD: 0.8 + r() * 0.2, MIX: 1, TONE: 0.3 + r() * 0.14, SPACE: 0.6 + r() * 0.3, DECAY: 0.6 + r() * 0.25,
        SCAN: CV.scan(0.05 + r() * 0.1), PITCH: CV.pitch(c.shift + pick([0, 0, -12, 12])), LENGTH: c.len(pick([4, 8])), ATTACK: 0.5 + r() * 0.3, SUSTAIN: r() * 0.3, POSITION: base, CHORUS: r() * 0.5 },
      auto: (b, p) => ({ POSITION: clamp(base + sweep * Math.sin(TAU * b / c.beats + ph), 0, 1), TONE: Math.min(0.95, p.TONE + 0.1 * (0.5 - 0.5 * Math.cos(TAU * b / c.beats))) }) }; },
  SHARDS: (r, c) => { const pick = a => a[Math.floor(r() * a.length)], grid = pick(["1/16", "1/16", "1/8T", "1/8"]), pat = euclid(pick([5, 7, 9, 11]), 16, Math.floor(r() * 16)), poss = [0, 1, 2, 3].map(() => c.pos(r));
    return { name: "SHARDS", kana: "破片", desc: grid + " grain trains", gain: 0.66, play: true, notes: [], rhythmic: true,
      p: { SIZE: CV.size(0.04 + r() * 0.11), DENSITY: 1, GRID: CV.grid(grid), SPRAY: 0.05 + 0.03 * c.depth, SPREAD: 0.3 + r() * 0.6, MIX: 1, TONE: 0.5 + r() * 0.2, SPACE: 0.15 + r() * 0.25, DECAY: 0.35 + r() * 0.2,
        DRIVE: 0.1 + r() * 0.3, SCAN: CV.scan(1), PITCH: CV.pitch(c.shift + pick([0, 0, 12])), LENGTH: c.len(pick([0.5, 1])), ATTACK: 0.03 + r() * 0.12, SUSTAIN: 0.3 + r() * 0.4, POSITION: poss[0], DELAY: r() < 0.5 ? 0.2 + r() * 0.3 : 0, DTIME: CV.dtime(pick(["1/8.", "1/8", "1/4"])), DFEED: 0.3 + r() * 0.3 },
      auto: b => ({ POSITION: poss[Math.floor(b / 4) % 4], VOLUME: CV.vol(pat[Math.floor(b * 4) % 16] ? 1 : 0.2) }) }; },
  FROST_PULSE: (r, c) => { const pick = a => a[Math.floor(r() * a.length)], every = pick([1, 1, 2]), seq = Array.from({ length: 8 }, () => c.pos(r)), gate = euclid(pick([3, 5, 6]), 8, Math.floor(r() * 8));
    return { name: "FROST PULSE", kana: "霜拍", desc: "tape-sliced stutter", gain: 0.78, play: true, notes: [], rhythmic: true,
      p: { SIZE: CV.size(0.08 + r() * 0.2), DENSITY: 1, GRID: CV.grid("1/8"), SPRAY: 0.15, SPREAD: 0.4, MIX: 0.25 + r() * 0.25, TONE: 0.45 + r() * 0.15, SPACE: 0.2 + r() * 0.2, DECAY: 0.35,
        DRIVE: 0.15 + r() * 0.25, SCAN: CV.scan(1), PITCH: CV.pitch(c.shift + pick([0, 0, -12])), LENGTH: c.len(pick([0.25, 0.5, 1])), ATTACK: 0.1, SUSTAIN: 0.6, POSITION: seq[0] },
      auto: b => ({ POSITION: seq[Math.floor(b / every) % 8], VOLUME: CV.vol(gate[Math.floor(b * 2) % 8] ? 1 : 0.3) }) }; },
  SNOWFALL: (r, c) => { const pick = a => a[Math.floor(r() * a.length)], p = 0.14 + r() * 0.18, notes = [], set = [72, 84, 96, 84, 72];
    for (let s = 0; s < c.beats * 4; s++) if (r() < p) notes.push({ at: s / 4, len: 0.12 + r() * 0.3, note: pick(set), vel: 0.4 + r() * 0.5 });
    return { name: "SNOWFALL", kana: "降雪", desc: "high glints on the 16ths", gain: 0.45, play: false, notes,
      p: { SIZE: CV.size(0.03 + r() * 0.09), DENSITY: CV.dens(40 + r() * 40), SPRAY: 0.5, SPREAD: 1, MIX: 1, TONE: 0.55 + r() * 0.1, SPACE: 0.7 + r() * 0.25, DECAY: 0.7, SCAN: 0.5, PITCH: CV.pitch(c.shift),
        LENGTH: c.len(1), ATTACK: 0.05, SUSTAIN: 0.2, POSITION: c.pos(r), ENV_A: 0.1, ENV_R: 0.45, DELAY: 0.25, DTIME: CV.dtime("1/8."), DFEED: 0.45 }, auto: null }; },
  BLACK_ICE: (r, c) => { const pick = a => a[Math.floor(r() * a.length)];
    return { name: "BLACK ICE", kana: "黒氷", desc: "sub-zero low end, pumping", gain: 0.6, play: true, notes: [], rhythmic: true,
      p: { SIZE: CV.size(0.3 + r() * 0.5), DENSITY: CV.dens(8 + r() * 8), SPRAY: 0.3, SPREAD: 0.15, MIX: 1, TONE: 0.17 + r() * 0.12, RESO: 0.2 + r() * 0.3, SPACE: 0.15 + r() * 0.15, DECAY: 0.4, DRIVE: 0.3 + r() * 0.3,
        SCAN: CV.scan(0.02), PITCH: CV.pitch(c.shift + pick([-12, -24])), LENGTH: c.len(pick([2, 4])), ATTACK: 0.4, SUSTAIN: 0.4, POSITION: c.pos(r) },
      auto: b => ({ VOLUME: CV.vol(0.25 + 0.75 * Math.sqrt(b % 1)) }) }; },
  PRISM: (r, c) => { const pick = a => a[Math.floor(r() * a.length)], arp = pick([[0, 12, 24, 12], [0, 12, 0, 24], [12, 0, 12, 24, 0, 12], [0, 24, 12, 24], [-12, 0, 12, 0]]), step = pick([0.5, 0.25, 0.25]), notes = [];
    for (let i = 0; i * step < c.beats; i++) notes.push({ at: i * step, len: step * 0.85, note: 60 + arp[i % arp.length], vel: 0.7 });
    return { name: "PRISM", kana: "分光", desc: "octave-leaping arpeggio", gain: 0.52, play: false, notes,
      p: { SIZE: CV.size(0.08 + r() * 0.17), DENSITY: CV.dens(30 + r() * 30), SPRAY: 0.25, SPREAD: 0.9, MIX: 1, TONE: 0.45 + r() * 0.15, SPACE: 0.4 + r() * 0.25, DECAY: 0.55, DRIVE: 0.05, SCAN: CV.scan(0.1),
        PITCH: CV.pitch(c.shift), LENGTH: c.len(1), ATTACK: 0.2, SUSTAIN: 0.5, POSITION: c.pos(r), ENV_A: 0.15, ENV_R: 0.4, CHORUS: r() * 0.4 }, auto: null }; },
  AURORA: (r, c) => { const pick = a => a[Math.floor(r() * a.length)], base = c.pos(r), ph = r() * TAU, cyc = pick([1, 2]);
    return { name: "AURORA", kana: "極光", desc: "shimmering octaves, slow sweep", gain: 0.7, play: true, notes: [],
      p: { SIZE: CV.size(0.25 + r() * 0.4), DENSITY: CV.dens(18 + r() * 16), SPRAY: 0.55, SHATTER: 0.5 + r() * 0.4, SPREAD: 1, MIX: 1, TONE: 0.45, RESO: 0.3 + r() * 0.3, SPACE: 0.5 + r() * 0.3, DECAY: 0.7,
        CHORUS: 0.5 + r() * 0.4, DELAY: 0.3 + r() * 0.2, DTIME: CV.dtime(pick(["1/4.", "1/4", "1/8."])), DFEED: 0.5, SCAN: CV.scan(0.08), PITCH: CV.pitch(c.shift + pick([0, 12])), LENGTH: c.len(pick([2, 4, 8])),
        ATTACK: 0.6, SUSTAIN: 0.2, POSITION: base },
      auto: b => ({ TONE: 0.44 - 0.2 * (0.5 - 0.5 * Math.cos(TAU * cyc * b / c.beats + ph)) }) }; },
  HAIL: (r, c) => { const pick = a => a[Math.floor(r() * a.length)], grid = pick(["1/16T", "1/32", "1/16"]), poss = [0, 1].map(() => c.pos(r)), burst = euclid(pick([3, 4, 5]), 8, Math.floor(r() * 8));
    return { name: "HAIL", kana: "霰", desc: "scattered " + grid + " bursts", gain: 0.55, play: true, notes: [], rhythmic: true,
      p: { SIZE: CV.size(0.012 + r() * 0.03), DENSITY: 0.3 + r() * 0.25, GRID: CV.grid(grid), SPRAY: 0.9, SHATTER: 0.5 + r() * 0.4, SPREAD: 1, MIX: 1, TONE: 0.55 + r() * 0.15, SPACE: 0.2 + r() * 0.2, DECAY: 0.4,
        DELAY: 0.3 + r() * 0.25, DTIME: CV.dtime(pick(["1/8.", "1/16.", "1/8T"])), DFEED: 0.45 + r() * 0.2, SCAN: CV.scan(0.5), PITCH: CV.pitch(c.shift + pick([0, 12])), LENGTH: c.len(pick([1, 2])), ATTACK: 0.05, SUSTAIN: 0.5, POSITION: poss[0] },
      auto: b => ({ POSITION: poss[Math.floor(b / 8) % 2], VOLUME: CV.vol(burst[Math.floor(b * 2) % 8] ? 1 : 0.12) }) }; },
};
// broad per-layer starting values: every layer gets its own filter, space, playhead, drive, width and grain shape
function crBroaden(ly, r, depth) {
  const keep = k => ly.fixed && ly.fixed.includes(k), set = (k, v) => { if (!keep(k)) ly.p[k] = v; };
  if (!["AURORA", "BLACK_ICE"].includes(ly.arch)) set("TONE", crTone(r)); else r();
  set("RESO", r() < 0.6 ? 0.1 + r() * 0.2 : 0.3 + r() * 0.45);
  if (ly.p.SPACE === undefined || r() < 0.6) set("SPACE", 0.05 + r() * 0.8);
  if (!ly.rhythmic && ly.arch !== "SNOWFALL") set("SCAN", crScan(r, false));
  set("DRIVE", r() < 0.5 ? r() * 0.2 : 0.2 + r() * 0.5); set("SPREAD", r());
  if (!["SHARDS", "HAIL", "SNOWFALL"].includes(ly.arch)) { set("ATTACK", r() < 0.5 ? 0.02 + r() * 0.2 : 0.3 + r() * 0.6); set("SUSTAIN", r() * 0.85); }
  if (r() < 0.2 + 0.06 * depth) set("CRUSH", 0.15 + r() * 0.4);
  if (!ly.rhythmic) ly.p.SPRAY = Math.min(0.95, (ly.p.SPRAY || 0.3) + r() * 0.25 + 0.03 * depth);
}
// SCENES: a setting per bar (cycling every 2 or 4 bars). STEPS: locks that jump a few parameters for one step, then snap back.
function crSequence(ly, r, depth, c) {
  const pick = a => a[Math.floor(r() * a.length)], rhythmic = !!ly.rhythmic;
  const sceneLen = pick([2, 4, 4]), scenes = [];
  for (let i = 0; i < sceneLen; i++) scenes.push(i === 0 ? {} : {
    TONE: r() < 0.8 ? crTone(r) : undefined, SPACE: r() < 0.6 ? 0.05 + r() * 0.85 : undefined, SCAN: !rhythmic && r() < 0.7 ? crScan(r, false) : undefined,
    DRIVE: r() < 0.4 ? r() * 0.8 : undefined, SIZE: r() < 0.4 ? clamp(ly.p.SIZE + (r() - 0.5) * 0.4, 0, 1) : undefined, RESO: r() < 0.3 ? r() * 0.8 : undefined });
  const spb = pick(rhythmic ? [4, 4, 4, 3, 8] : [4, 4, 2, 3]), patBeats = pick([4, 8, 8, 16]), patSteps = patBeats * spb, steps = new Array(patSteps).fill(null);
  const pLock = Math.min(0.8, 0.3 + 0.07 * depth);
  const vocab = [
    () => ({ TONE: crTone(r) }),
    () => ({ SPACE: r() < 0.5 ? 0.9 + r() * 0.1 : r() * 0.1 }),                                   // reverb throw / dry cut
    () => ({ SCAN: crScan(r, true) }),
    () => ({ REV: 1 }),
    () => ({ PITCH: CV.pitch(c.shift + pick(OCT_MOVES)) }),                                        // octave flip: same notes, new register
    () => ({ POSITION: c.pos(r) }),                                                                // jump somewhere else in the sound
    () => ({ LENGTH: c.lenSec(c.tunedPeriod(r)), SCAN: CV.scan(1), MIX: 0.2 }),                    // micro-loop buzz tuned to a note of the key
    () => ({ SIZE: CV.size(0.008 + r() * 0.03), GRID: 0, DENSITY: CV.dens(c.tunedRate(r)) }),      // grain roll at a rate that is a note of the key
    () => ({ SIZE: CV.size(0.5 + r() * 1.2) }),                                                    // smear
    () => ({ DRIVE: 0.7 + r() * 0.3, TONE: 0.62 + r() * 0.25 }),                                   // bitter crunch
    () => ({ FREEZE: 1 }),
    () => ({ SPREAD: r() < 0.5 ? 0 : 1, ATTACK: 0.02, SUSTAIN: 0.9 }),                             // hard square chops
    () => ({ VOLUME: CV.vol(0.03) }), () => ({ VOLUME: CV.vol(0.03) }),                            // a hole
    () => ({ TONE: crTone(r), RESO: 0.5 + r() * 0.45 }),                                           // resonant ping (tuned to the key)
    () => ({ DELAY: 0.6 + r() * 0.3, DFEED: 0.5 + r() * 0.35 }),                                   // echo throw
    () => ({ CRUSH: 0.4 + r() * 0.5 }),                                                            // bit-crushed step
    () => ({ SHATTER: 0.9 }),                                                                      // octave shatter
  ];
  let locks = 0;
  for (let st = 0; st < patSteps; st++) {
    if (r() > pLock) continue; const o = {}, n = 1 + Math.floor(r() * Math.min(3, 1 + depth / 2));
    for (let k = 0; k < n; k++) Object.assign(o, pick(vocab)()); o.hold = r() < 0.25 ? 2 : 1; steps[st] = o; locks++;
  }
  const fill = []; for (let i = 0; i < 8; i++) fill.push(r() < 0.6 ? Object.assign({}, pick(vocab)(), pick(vocab)()) : null);   // last beat: a 32nd-note fill
  return { scenes, sceneLen, spb, patSteps, steps, fill, locks };
}
// which layers a fresh crystal gets: rhythmic first, pads and glints arrive as it goes deeper. keep = layers to carry over.
function crystalPlan(seed, depth, keep) {
  const r = mulberry(seed), pick = a => a[Math.floor(r() * a.length)], layers = (keep || []).map(k => Object.assign({}, k));
  const want = depth >= 6 ? 4 : depth >= 4 ? 3 : depth >= 2 ? 2 : 1, have = () => layers.map(l => l.arch);
  let guard = 0;
  while (layers.length < want && guard++ < 12) {
    const rhy = have().filter(a => CRYS_RHYTHMIC.includes(a)).length, amb = have().length - rhy;
    const pool = (layers.length === 0 ? ["SHARDS", "FROST_PULSE", "SHARDS", "FROST_PULSE", "BLACK_ICE", "PRISM", "GLACIER", "SNOWFALL", "AURORA", "HAIL"] : rhy > amb ? CRYS_AMBIENT : amb > rhy ? CRYS_RHYTHMIC : CRYS_ARCHS).filter(a => !have().includes(a));
    layers.push({ arch: pick(pool.length ? pool : CRYS_ARCHS), seed: (r() * 4294967296) | 0, depth });
  }
  return layers;
}
function crBuildLayer(spec, c) {
  const r = mulberry(spec.seed), ly = CRYS_ARCH[spec.arch](r, Object.assign({}, c, { depth: spec.depth }));
  ly.arch = spec.arch; crBroaden(ly, r, spec.depth); ly.seq = crSequence(ly, r, spec.depth, c);
  if (spec.depth >= 3 && r() < 0.5) ly.reverseBars = [3, 7].filter(() => r() < 0.7).map(b => b % c.bars);
  if (spec.depth >= 5 && r() < 0.4) ly.freezeBar = Math.floor(r() * c.bars);
  return ly;
}
// ---- SCULPT: per-layer sound tweaks (re-render that layer) and mix tweaks (applied to the cached layer audio)
const CR_LAYER_DEF = { cut: 0, res: 0, size: 0, gatk: 0, gbody: 0, space: 1, drive: 1, level: 1, mute: false, env: { rate: -1, a: 0.004, d: 0.18, s: 0 } };
function crTweak(sc, li) {
  const a = Object.assign({}, CR_LAYER_DEF, sc && sc.all), l = Object.assign({}, CR_LAYER_DEF, sc && sc.layers && sc.layers[li]);
  return { cut: clamp(a.cut + l.cut, -1, 1), res: clamp(a.res + l.res, 0, 1), size: clamp(a.size + l.size, -1, 1), gatk: clamp(a.gatk + l.gatk, -1, 1), gbody: clamp(a.gbody + l.gbody, -1, 1),
    space: a.space * l.space, drive: a.drive * l.drive, level: l.mute ? 0 : a.level * l.level, env: (l.env && l.env.rate >= 0) ? l.env : (a.env && a.env.rate > 0 ? a.env : { rate: 0 }) };
}
const crSoundKey = t => [t.cut, t.res, t.size, t.gatk, t.gbody, t.space, t.drive].map(x => x.toFixed(4)).join();

function crRenderLayer(S, ly, t, onProg) {
  const { L, R, sr, beat, loopFrames, xf, total } = S, e = new GrainEngine(sr, { offline: true });
  e.rnd = mulberry(hashSeed(ly.seedV, 77)); e.keyLock = true; e.strictOct = true; e.snap = S.snap; e.setClock(S.bpm, 0); e.load(L, R, S.rate);
  const base = Object.assign({ REV: 0, FREEZE: 0, VOLUME: CV.vol(1), GRID: 0, SHATTER: 0, CRUSH: 0, CHORUS: 0, DELAY: 0, DFEED: 0.4, RESO: 0.15, DECAY: 0.5, DSYNC: 1, FINE: 0.5, ENV_A: 0.3, ENV_R: 0.55 }, ly.p);
  for (const k in base) e.p[GP[k]] = base[k]; e.p[GP.PLAY] = ly.play ? 1 : 0;
  const outL = new Float32Array(total), outR = new Float32Array(total), bl = new Float32Array(64), br = new Float32Array(64), q = ly.seq, beats = S.beats;
  for (let pos = 0; pos < total; pos += 64) {
    const n = Math.min(64, total - pos), b0 = pos / sr / beat, b1 = (pos + n) / sr / beat, bl32 = b0 % beats, cur = Object.assign({}, base);
    if (ly.auto) Object.assign(cur, ly.auto(bl32, ly.p));
    const sc = q.scenes[Math.floor(bl32 / 4) % q.sceneLen]; for (const k in sc) if (sc[k] !== undefined) cur[k] = sc[k];
    let lock = null;
    if (bl32 >= beats - 1) lock = q.fill[Math.floor((bl32 - (beats - 1)) * 8) % 8];
    else { const st = Math.floor(bl32 * q.spb) % q.patSteps; lock = q.steps[st]; if (!lock && st > 0) { const pr = q.steps[st - 1]; if (pr && pr.hold > 1) lock = pr; } }
    if (lock) for (const k in lock) if (k !== "hold") cur[k] = lock[k];
    // sculpt on top of every scene and lock
    if (t.cut) cur.TONE = clamp(cur.TONE + t.cut * 0.45, 0.02, 0.98);
    if (t.res) cur.RESO = clamp(cur.RESO + t.res * 0.85, 0, 1);
    if (t.size) cur.SIZE = clamp(cur.SIZE + t.size * 0.25, 0, 1);
    if (t.gatk) cur.ATTACK = clamp(cur.ATTACK + t.gatk * 0.6, 0.02, 0.98);
    if (t.gbody) cur.SUSTAIN = clamp(cur.SUSTAIN + t.gbody * 0.6, 0, 1);
    if (t.space !== 1) cur.SPACE = clamp(cur.SPACE * t.space, 0, 1);
    if (t.drive !== 1) cur.DRIVE = clamp(cur.DRIVE * t.drive, 0, 1);
    for (const k in cur) e.p[GP[k]] = cur[k];
    if (ly.reverseBars && ly.reverseBars.some(bar => bl32 >= bar * 4 + 2 && bl32 < bar * 4 + 4)) e.p[GP.REV] = 1;
    if (ly.freezeBar !== undefined && bl32 >= ly.freezeBar * 4 && bl32 < ly.freezeBar * 4 + 4) e.p[GP.FREEZE] = 1;
    for (const ev of ly.notes) for (let k = Math.floor(b0 / beats); k <= Math.floor(b1 / beats); k++) {
      const on = k * beats + ev.at, off = on + ev.len;
      if (on >= b0 && on < b1) e.noteOn(ev.note, ev.vel);
      if (off >= b0 && off < b1) e.noteOff(ev.note);
    }
    e.process(bl, br, n);
    const g = ly.gain; for (let i = 0; i < n; i++) { outL[pos + i] = bl[i] * g; outR[pos + i] = br[i] * g; }
    if ((pos & 16383) === 0 && onProg) onProg(pos / total);
  }
  // the second pass is the loop (its start already carries the first pass's tails); its first 40 ms are blended
  // with the start of a third pass, so the end flows back into the beginning
  const FL = new Float32Array(loopFrames), FR = new Float32Array(loopFrames);
  for (let i = 0; i < loopFrames; i++) { FL[i] = outL[loopFrames + i]; FR[i] = outR[loopFrames + i]; }
  for (let i = 0; i < xf; i++) { const x = i / xf, a = Math.cos(x * Math.PI / 2), c = Math.sin(x * Math.PI / 2); FL[i] = outL[2 * loopFrames + i] * a + FL[i] * c; FR[i] = outR[2 * loopFrames + i] * a + FR[i] * c; }
  return { L: FL, R: FR };
}
const CRYS_CACHE = new Map();   // rendered layer audio, so mix moves and pinned layers cost nothing
// job: { src:{L,R,rate,key}, bpm, bars, root, scale, layers:[{arch,seed,depth}], sculpt:{all,layers[],master}, outRate }
function crystalRender(job, onProg) {
  const src = job.src, sr = job.outRate, beat = 60 / job.bpm, bars = job.bars || 8, beats = bars * 4, loopFrames = Math.round(beats * beat * sr), xf = Math.round(0.04 * sr), total = 2 * loopFrames + xf;
  const cap = Math.min(src.L.length, Math.floor(120 * src.rate)), L = cap < src.L.length ? src.L.subarray(0, cap) : src.L, R = cap < src.R.length ? src.R.subarray(0, cap) : src.R;
  const sampleSec = L.length / src.rate, shift = job.shift === undefined ? keyShift(src.key, job.root, job.scale) : job.shift;
  const pcs = scalePcs(job.root, job.scale), third = scale7(job.scale)[2];
  const keyFreq = (r, lo, hi) => { let f = midiHz(job.root + [0, 0, third, 7][Math.floor(r() * 4)]); while (f > hi) f /= 2; while (f < lo) f *= 2; return f; };
  const c = { shift, bps: job.bpm / 60, bars, beats, depth: 1, pos: makePosPicker(L, src.rate),
    len: b => PM.lenInv(Math.min(sampleSec, b * beat), sampleSec), lenSec: s => PM.lenInv(Math.min(sampleSec, s), sampleSec),
    tunedPeriod: r => { const f = keyFreq(r, 55, 220); return Math.max(64 / sr, (1 + Math.floor(r() * 3)) / f); }, tunedRate: r => keyFreq(r, 30, 120) };
  // resonance rings on notes of the key: cutoffs are pulled onto the nearest scale note
  const snap = hz => midiHz(nearestInScale(hzMidi(Math.max(10, hz)), pcs));
  const S = { L, R, rate: src.rate, sr, bpm: job.bpm, beat, beats, bars, loopFrames, xf, total, snap };
  const baseSig = [job.srcId, job.bpm, bars, job.root, job.scale, shift, sr].join("|"), layers = job.layers.map(sp => { const ly = crBuildLayer(sp, c); ly.seedV = sp.seed; ly.spec = sp; return ly; });
  const todo = [], stems = [], used = new Set();
  layers.forEach((ly, li) => { const t = crTweak(job.sculpt, li), key = baseSig + "#" + ly.arch + ":" + ly.seedV + ":" + ly.spec.depth + "#" + crSoundKey(t); used.add(key); if (CRYS_CACHE.has(key)) stems[li] = CRYS_CACHE.get(key); else todo.push([li, key, t]); });
  todo.forEach(([li, key, t], j) => { stems[li] = crRenderLayer(S, layers[li], t, p => onProg && onProg((j + p) / todo.length)); CRYS_CACHE.set(key, stems[li]); });
  for (const k of [...CRYS_CACHE.keys()]) if (!used.has(k) && CRYS_CACHE.size > 12) CRYS_CACHE.delete(k);
  const oL = new Float32Array(loopFrames), oR = new Float32Array(loopFrames);
  layers.forEach((ly, li) => { const t = crTweak(job.sculpt, li); if (t.level <= 0) return; gateInto(stems[li].L, oL, loopFrames, sr, beat, t.env, t.level); gateInto(stems[li].R, oR, loopFrames, sr, beat, t.env, t.level); });
  finishMix(oL, oR, sr, job.sculpt && job.sculpt.master, job.root, true);
  return { L: oL, R: oR, rate: sr, bars, bpm: job.bpm, redone: todo.length, shift,
    recipe: layers.map(ly => ({ arch: ly.arch, seed: ly.seedV, depth: ly.spec.depth, name: ly.name, kana: ly.kana, desc: ly.desc, locks: ly.seq.locks, grid: ({ 2: "8th", 3: "triplet", 4: "16th", 8: "32nd" })[ly.seq.spb], scenes: ly.seq.sceneLen, reverse: !!(ly.reverseBars && ly.reverseBars.length), freeze: ly.freezeBar !== undefined })) };
}

// ============================================================ BEAT BABY
// Two drum loops at any tempo → one new beat at the session tempo. Each loop is cut into hits, every hit is tagged
// kick / snare-clap / hat / perc and placed on a 16th grid with its own push or pull (the groove). The baby takes the
// rhythm and the sound of each lane from parent A or B in the BLEND ratio. Hits are one-shots, so nothing is stretched.
const LANES = ["K", "S", "H", "P"], LANE_NAMES = { K: "KICK", S: "SNARE / CLAP", H: "HATS", P: "PERC" };
const DRUM_CACHE = new WeakMap();
function drumBase(src) {
  let c = DRUM_CACHE.get(src); if (c) return c;
  const pk = peakOf(src.L, src.R); if (pk < 1e-4) throw new Error("that sound is silent"); if (src.L.length < 0.25 * src.rate) throw new Error("that's too short for a loop");
  const trim = firstSound(src.L, src.R, pk, src.rate), n = Math.min(src.L.length - trim, Math.floor(60 * src.rate)), x = monoOf(src.L, src.R, trim, n), spec = spectra(x, src.rate);
  c = { pk, trim, n, x, spec, tempo: findTempo(spec, src.rate, n / src.rate), auto: {} }; DRUM_CACHE.set(src, c); return c;
}
function drumClassify(src, B, s, e) {   // what's NEW in the lows and highs around the attack
  const S = B.spec, c = Math.round((s - B.trim - S.N / 2) / S.hop), f0 = clamp(c - 1, 0, S.frames - 1), f1 = clamp(Math.min(c + 3, Math.floor((e - B.trim - S.N / 2) / S.hop)), f0, S.frames - 1);
  let lo = 0, hi = 0, t = 0; for (let f = f0; f <= f1; f++) { lo += S.low[f]; hi += S.high[f]; t += S.tot[f]; }
  let pk = 0; const L = src.L, R = src.R; for (let i = s; i < Math.min(e, s + Math.round(0.08 * src.rate)); i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > pk) pk = a; if (b > pk) pk = b; }
  return { lowR: t > 0 ? lo / t : 0, highR: t > 0 ? hi / t : 0, vel: pk / B.pk };
}
const drumRule = f => f.lowR > 0.42 ? "K" : f.highR > 0.42 ? "H" : f.vel > 0.45 ? "S" : f.highR > 0.22 ? "H" : "P";
// edit: { sens, bpm, slices:[{s,cls}] } — anything left out is found automatically
function drumAnalyse(src, edit) {
  edit = edit || {}; const B = drumBase(src), rate = src.rate, len = src.L.length, sens = edit.sens === undefined ? 0.5 : edit.sens;
  const bpm = clamp(edit.bpm || B.tempo.bpm, 40, 240), stepSec = 60 / bpm / 4, raw = (len - B.trim) / rate / stepSec, barsF = raw / 16;
  const steps = Math.max(4, Math.abs(barsF - Math.round(barsF)) < 0.3 && barsF >= 0.7 ? Math.round(barsF) * 16 : Math.round(raw / 4) * 4);
  let cuts;
  if (edit.slices && edit.slices.length) cuts = edit.slices.map(s => ({ s: clamp(Math.round(s.s), 0, len - 1), cls: LANES.includes(s.cls) ? s.cls : null }));
  else {
    const key = sens.toFixed(2); let on = B.auto[key];
    if (!on) { on = pickOnsets(B.spec, rate, sens).map(c => refineOnset(B.x, c, B.spec.N) + B.trim); if (!on.length || on[0] - B.trim > 0.03 * rate) on.unshift(B.trim); on = on.filter((v, i) => i === 0 || v - on[i - 1] > 0.03 * rate); B.auto[key] = on; }
    cuts = on.map(s => ({ s, cls: null }));
  }
  cuts.sort((a, b) => a.s - b.s);
  const slices = cuts.map((c, i) => { const e = Math.min(len, i + 1 < cuts.length ? cuts[i + 1].s : len, c.s + Math.round(1.6 * rate)), f = drumClassify(src, B, c.s, e); return { s: c.s, e, f, cls: c.cls, auto: !c.cls }; });
  for (const s of slices) if (!s.cls) s.cls = drumRule(s.f);
  // a loop with no kick or no snare by the rules: promote the most kick-like / the loudest mid hits (automatic tags only)
  const autos = slices.filter(s => s.auto);
  if (!slices.some(s => s.cls === "K")) { const c = autos.filter(s => s.f.lowR > 0.15).sort((a, b) => b.f.lowR - a.f.lowR), top = c.length ? c[0].f.lowR : 0; for (const s of c) if (s.f.lowR > 0.7 * top) s.cls = "K"; }
  if (!slices.some(s => s.cls === "S")) { const c = autos.filter(s => s.cls === "P" || s.cls === "H").sort((a, b) => b.f.vel - a.f.vel); if (c.length && c[0].f.vel > 0.3) { const v = c[0].f.vel; for (const s of c) if (s.f.vel > 0.8 * v && s.f.highR < 0.6) s.cls = "S"; } }
  const lanes = { K: new Array(steps).fill(-1), S: new Array(steps).fill(-1), H: new Array(steps).fill(-1), P: new Array(steps).fill(-1) }, implied = { K: new Array(steps).fill(-1), S: new Array(steps).fill(-1), H: new Array(steps).fill(-1), P: new Array(steps).fill(-1) };
  slices.forEach((s, i) => {
    const t = (s.s - B.trim) / rate / stepSec, st = Math.round(t); s.step = ((st % steps) + steps) % steps; s.off = clamp(t - st, -0.5, 0.5);
    s.hat = s.cls !== "H" && s.f.highR > 0.2;                                     // a hat riding on a kick or snare still counts for the hat rhythm
    s.snr = s.cls === "K" && 1 - s.f.lowR - s.f.highR > 0.3 && s.f.vel > 0.4;     // and a clap stacked on a kick for the snare rhythm
    const Ln = lanes[s.cls], o = Ln[s.step]; if (o < 0 || slices[o].f.vel < s.f.vel) Ln[s.step] = i;
    if (s.hat && implied.H[s.step] < 0) implied.H[s.step] = i; if (s.snr && implied.S[s.step] < 0) implied.S[s.step] = i;
  });
  return { src, rate, len, peak: B.pk, trim: B.trim, bpm, bars: steps / 16, steps, stepSec, exact: B.tempo.exact && !edit.bpm, detected: B.tempo.bpm, slices, lanes, implied };
}
function drumInfo(P) {
  return { bpm: P.bpm, detected: P.detected, bars: P.bars, steps: P.steps, exact: P.exact, trim: P.trim, len: P.len, rate: P.rate,
    slices: P.slices.map(s => ({ s: s.s, e: s.e, cls: s.cls, step: s.step, off: s.off, vel: s.f.vel, hat: s.hat, snr: s.snr })),
    counts: Object.fromEntries(LANES.map(l => [l, P.slices.filter(s => s.cls === l).length])) };
}
function placeHit(oL, oR, P, s0, lenSec, atSec, sr, gain, pan) {
  const src = P.src, ratio = P.rate / sr, n = Math.min(Math.floor(lenSec * sr), Math.floor((P.len - 2 - s0) / ratio)); if (n < 8) return;
  const fade = Math.min(n >> 1, Math.round(0.008 * sr)), N = oL.length, k0 = Math.round(atSec * sr), sc = gain / P.peak * 0.9, gl = pan > 0 ? 1 - pan : 1, gr = pan < 0 ? 1 + pan : 1;
  for (let i = 0; i < n; i++) {
    const pos = s0 + i * ratio, i0 = pos | 0, t = pos - i0, e = i < n - fade ? 1 : rc((n - i) / fade), j = (((k0 + i) % N) + N) % N;
    oL[j] += (src.L[i0] + (src.L[i0 + 1] - src.L[i0]) * t) * e * sc * gl; oR[j] += (src.R[i0] + (src.R[i0 + 1] - src.R[i0]) * t) * e * sc * gr;
  }
}
// job: { a:{src,edit}, b:{src,edit}, bpm, bars, blend, wild, swing, tight, seed, overrides, lanes:{K:{level,mute,sound}}, finish, glue, outRate }
// blend: 0 = all A, 1 = all B. Every random number is drawn whatever the blend, so moving it morphs the same baby.
function beatRender(job) {
  const par = [job.a && job.a.src ? drumAnalyse(job.a.src, job.a.edit) : null, job.b && job.b.src ? drumAnalyse(job.b.src, job.b.edit) : null];
  if (!par[0] && !par[1]) throw new Error("load two drum loops first");
  const r = mulberry(job.seed), w = job.blend, wild = job.wild || 0, bars = job.bars || 2, steps = bars * 16, sr = job.outRate, stepSec = 60 / job.bpm / 4, frames = Math.round(steps * stepSec * sr);
  const LS = l => Object.assign({ level: 1, mute: false, sound: "auto" }, job.lanes && job.lanes[l]);
  const has = (P, l) => !!P && (P.lanes[l].some(i => i >= 0) || P.implied[l].some(i => i >= 0));
  const pickP = (u, l) => { let p = u < w ? 1 : 0; if (!has(par[p], l)) p = 1 - p; return has(par[p], l) ? p : -1; };
  const grid = {}, hits = [], soundOf = {};
  for (const l of LANES) {
    const cells = new Array(steps).fill(null), ls = LS(l); grid[l] = cells;
    let soundP = pickP(r(), l); if (ls.sound === "A" && has(par[0], l)) soundP = 0; else if (ls.sound === "B" && has(par[1], l)) soundP = 1; soundOf[l] = soundP;
    const seg = (l === "K" || l === "S") ? 8 : 4, segP = []; for (let sg = 0; sg < steps / seg; sg++) segP.push(pickP(r(), l));
    for (let st = 0; st < steps; st++) {
      const u1 = r(), u2 = r(), u3 = r(), u4 = r(), rp = segP[Math.floor(st / seg)]; let cell = null;
      if (rp >= 0) { const P = par[rp], ps = st % P.steps; let si = P.lanes[l][ps], implied = false; if (si < 0 && P.implied[l][ps] >= 0) { si = P.implied[l][ps]; implied = true; } if (si >= 0) cell = { p: rp, src: si, srcStep: ps, off: P.slices[si].off, vel: 0.55 + 0.45 * Math.min(1, P.slices[si].f.vel * 1.3), implied }; }
      // WILD: drop hits, add ghost notes, hat rolls, kick doubles
      if (cell && u1 < wild * 0.14 && !(l === "K" && st % 16 === 0)) cell = null;
      else if (!cell && l !== "K" && u2 < wild * (l === "H" ? 0.16 : 0.08) && soundP >= 0) cell = { p: soundP, src: -1, srcStep: st, off: 0, vel: l === "S" ? 0.35 : 0.5, ghost: true };
      else if (!cell && l === "K" && u2 < wild * 0.05 && soundP >= 0) cell = { p: soundP, src: -1, srcStep: st, off: 0, vel: 0.75, ghost: true };
      if (cell && l === "H" && u3 < wild * 0.12) cell.roll = true;
      if (cell && u4 < wild * 0.2) cell.vel *= 0.7 + 0.3 * u4 / Math.max(1e-3, wild * 0.2);
      const ov = job.overrides && job.overrides[l + ":" + st];
      if (ov === "off") cell = null;
      else if (ov === "A" || ov === "B") { const p = ov === "A" ? 0 : 1, P = par[p]; if (P) { const ps = st % P.steps; let si = P.lanes[l][ps]; if (si < 0 && P.implied[l][ps] >= 0) si = P.implied[l][ps]; cell = { p, src: si, srcStep: ps, off: si >= 0 ? P.slices[si].off : 0, vel: 1, forced: true }; } }
      cells[st] = cell;
      if (cell) { cell.sound = cell.forced || soundP < 0 ? cell.p : soundP; cell.lane = l; cell.step = st; if (!ls.mute) hits.push(cell); }
    }
  }
  const laneSlices = (P, l) => { const a = []; P.slices.forEach((s, i) => { if (s.cls === l) a.push(i); }); return a; };
  const outL = new Float32Array(frames), outR = new Float32Array(frames), sw = (job.swing || 0) * 0.42, tight = job.tight || 0, pans = { K: 0, S: 0, H: 0.12, P: -0.15 };
  for (const h of hits) {
    let P = par[h.sound] || par[h.p], si = -1;
    if (h.sound === h.p && h.src >= 0 && !h.implied) si = h.src;
    else { if (!P) continue; const ps = h.srcStep % P.steps; si = P.lanes[h.lane][ps]; if (si < 0) { const ls = laneSlices(P, h.lane); if (ls.length) si = ls[(h.srcStep * 7 + 3) % ls.length]; } }
    if (si < 0) { const Q = par[1 - h.sound]; if (Q) { const ls = laneSlices(Q, h.lane); if (ls.length) { P = Q; si = ls[(h.srcStep * 5 + 1) % ls.length]; } } }
    if (si < 0 && h.src >= 0) { P = par[h.p]; si = h.src; }   // a hidden hit (a hat under a kick) with no clean sound anywhere: use it as it is
    if (si < 0) continue;
    const s = P.slices[si], ls = LS(h.lane);
    // the next hit in the same lane chokes this one: hats close, kicks don't smear
    let nxt = steps; for (let k = 1; k < steps; k++) if (grid[h.lane][(h.step + k) % steps]) { nxt = k; break; }
    const at = (h.step + h.off * 0.85 + (h.step % 2 === 1 ? sw : 0)) * stepSec;
    const natural = (s.e - s.s) / P.rate, room = (h.lane === "S" || h.lane === "P" ? Math.max(nxt, 4) : nxt) * stepSec + 0.004;
    const maxLen = Math.min(natural, room, 1.4) * (1 - 0.75 * tight) + 0.02 * tight, g = h.vel * (h.ghost ? 0.85 : 1) * ls.level;
    placeHit(outL, outR, P, s.s, maxLen, at, sr, g, pans[h.lane]);
    if (h.roll) placeHit(outL, outR, P, s.s, Math.min(maxLen, stepSec * 0.5), at + stepSec * 0.5, sr, g * 0.6, pans[h.lane]);
  }
  // GLUE: the whole kit pushed into gentle saturation, like a bus compressor that never lets go
  const glue = job.glue || 0; if (glue > 0.01) { const pk = peakOf(outL, outR) || 1, k = 1 + glue * 5, nrm = 1 / tanhF(k); for (let i = 0; i < frames; i++) { outL[i] = tanhF(outL[i] / pk * k) * nrm; outR[i] = tanhF(outR[i] / pk * k) * nrm; } }
  finishMix(outL, outR, sr, job.finish, job.root, true);
  const g = {}; for (const l of LANES) g[l] = grid[l].map(c => c ? { p: c.p, sound: c.sound, ghost: !!c.ghost, roll: !!c.roll, forced: !!c.forced, implied: !!c.implied, vel: c.vel } : null);
  const share = [0, 0]; for (const h of hits) share[h.p]++;
  return { L: outL, R: outR, rate: sr, grid: g, steps, bars, bpm: job.bpm, share, soundOf, parents: par.map(P => P ? drumInfo(P) : null) };
}

// ============================================================ SAMPLE MASH
// Two sounds → a new melody in the session key. Each sound is cut into pieces and the clearly pitched ones are found.
// A chord progression and a melody are written (or the chords are arpeggiated); every note is sung by a piece of A or B,
// re-pitched onto the note. Under it: a bass line on the chord roots and a pad stretched from the most tonal piece.
const MASH_CACHE = new WeakMap();
function mashAnalyse(src) {
  let P = MASH_CACHE.get(src); if (P) return P;
  const { L, R, rate } = src, pk = peakOf(L, R); if (pk < 1e-4) throw new Error("that sound is silent");
  const trim = firstSound(L, R, pk, rate), n = Math.min(L.length - trim, Math.floor(90 * rate)), x = monoOf(L, R, trim, n);
  const S = spectra(x, rate), on = pickOnsets(S, rate, 0.45).map(c => refineOnset(x, c, S.N)); if (!on.length || on[0] > 0.05 * rate) on.unshift(0);
  // pieces run onset to onset; long ones are split so a sustained sound still gives several
  const cuts = []; for (let i = 0; i < on.length; i++) { const a = on[i], b = i + 1 < on.length ? on[i + 1] : n; if (b - a < 0.09 * rate) continue; const parts = Math.max(1, Math.floor((b - a) / (0.9 * rate))); for (let k = 0; k < parts; k++) cuts.push([a + Math.floor((b - a) * k / parts), a + Math.floor((b - a) * (k + 1) / parts)]); }
  const chunks = [];
  for (const [a, b] of cuts.slice(0, 420)) {
    let e2 = 0; const m = Math.min(b, a + Math.round(0.2 * rate)); for (let i = a; i < m; i += 4) e2 += x[i] * x[i];
    const rms = Math.sqrt(e2 / Math.max(1, (m - a) / 4)); if (rms < 0.01 * pk) continue;
    const p = chunkPitch(x, rate, a + Math.round(0.015 * rate)); chunks.push({ s: a + trim, e: b + trim, pc: p.pc, midi: p.midi, tonal: p.tonal, rms });
  }
  const k = detectKey(x, rate);
  P = { src, rate, len: L.length, peak: pk, chunks, key: k }; MASH_CACHE.set(src, P); return P;
}
function mashInfo(P) { return { key: P.key, chunks: P.chunks.length, tonal: P.chunks.filter(c => c.tonal > 0.3).length, pieces: P.chunks.map(c => ({ s: c.s, e: c.e, pc: c.pc, tonal: c.tonal })) }; }
// chord progressions as scale steps (0 = the key's home chord)
const MASH_PROGS = { min: [[0, 5, 2, 6], [0, 3, 4, 0], [0, 6, 5, 6], [0, 2, 6, 3], [0, 5, 3, 4], [0, 3, 6, 2], [0, 0, 5, 6], [0, 6, 3, 4]], maj: [[0, 4, 5, 3], [0, 5, 3, 4], [0, 3, 0, 4], [5, 3, 0, 4], [0, 2, 3, 4], [0, 4, 3, 3], [0, 3, 5, 4], [0, 5, 1, 4]] };
const CHORD_NAMES = { min: ["i", "ii°", "III", "iv", "v", "VI", "VII"], maj: ["I", "ii", "iii", "IV", "V", "vi", "vii°"], dor: ["i", "ii", "III", "IV", "v", "vi°", "VII"], phr: ["i", "II", "III", "iv", "v°", "VI", "vii"] };

// one note: a piece re-pitched by resampling. The input is faded in and out, then the comb / filter run, and the
// output gets a tail that fades to silence, so ringing is never cut off mid-wave. Wraps round the loop.
function mashVoice(oL, oR, send, P, ch, semis, atSec, lenSec, sr, gain, pan, sendAmt, filt, tuneHz, tune) {
  const S = P.src, ratio = Math.pow(2, semis / 12) * P.rate / sr, avail = Math.floor((ch.e - ch.s) / ratio), room = Math.floor((P.len - 2 - ch.s) / ratio);
  const n = Math.max(0, Math.min(Math.floor(lenSec * sr), avail + Math.floor(0.25 * sr / ratio), room)); if (n < 32) return;
  const cb = tune > 0 ? new Comb(sr, tuneHz, tune) : null, att = Math.min(Math.round(0.006 * sr), n >> 2), rel = Math.min(Math.round(0.06 * sr), n >> 1);
  const tail = cb ? Math.round(ringSec(tuneHz, cb.g) * sr) : filt ? Math.round(0.04 * sr) : 0, tot = n + tail, N = oL.length, k0 = Math.round(atSec * sr), sc = gain / P.peak;
  const gl = Math.cos((pan + 1) * Math.PI / 4) * 1.41, gr = Math.sin((pan + 1) * Math.PI / 4) * 1.41;
  for (let i = 0; i < tot; i++) {
    let l = 0, r = 0;
    if (i < n) { const pos = ch.s + i * ratio, i0 = pos | 0, t = pos - i0, e = rc(i / att) * rc((n - i) / rel) * sc; l = (S.L[i0] + (S.L[i0 + 1] - S.L[i0]) * t) * e; r = (S.R[i0] + (S.R[i0 + 1] - S.R[i0]) * t) * e; }
    if (cb) { l = cb.tick(l, 0); r = cb.tick(r, 1); }
    if (filt) { const m = 0.5 * (l + r); filt.tick(m); l = r = filt.lp; }
    if (i >= n) { const f = rc((tot - i) / tail); l *= f; r *= f; }
    const j = (((k0 + i) % N) + N) % N; oL[j] += l * gl; oR[j] += r * gr; if (send) { send[0][j] += l * sendAmt; send[1][j] += r * sendAmt; }
  }
}
// a held chord tone: overlapping grains read slowly through a piece, then the comb, with smooth ends and a ring-out tail
function mashStretch(oL, oR, send, P, ch, semis, atSec, lenSec, sr, gain, r, tuneHz, tune, pan) {
  const S = P.src, ratio = Math.pow(2, semis / 12) * P.rate / sr, g = Math.round(0.09 * sr), hop = g >> 2, n = Math.floor(lenSec * sr), N = oL.length, k0 = Math.round(atSec * sr);
  const span = Math.min((ch.e - ch.s) - g * ratio - 2, P.len - 3 - ch.s - g * ratio), sc = gain / P.peak;
  const amt = Math.min(1, tune * 1.2), cb = tune > 0 ? new Comb(sr, tuneHz, amt) : null, tail = cb ? Math.round(ringSec(tuneHz, cb.g) * sr) : 0, tmp = new Float32Array(n + tail), fd = Math.round(0.08 * sr);
  if (span >= 0) for (let o = -g; o < n; o += hop) {
    const rp = ch.s + Math.max(0, (0.15 + 0.7 * r()) * span);
    for (let i = 0; i < g; i++) { const at = o + i; if (at < 0 || at >= n) continue; const pos = rp + i * ratio, i0 = pos | 0, t = pos - i0, w = (0.5 - 0.5 * Math.cos(TAU * i / g)) * sc * rc(at / fd) * rc((n - at) / fd) * 0.5;
      tmp[at] += (S.L[i0] + S.R[i0] + ((S.L[i0 + 1] + S.R[i0 + 1]) - (S.L[i0] + S.R[i0])) * t) * 0.5 * w; }
  }
  const gl = 0.9 * (1 - 0.5 * pan), gr = 0.9 * (1 + 0.5 * pan);
  for (let at = 0; at < n + tail; at++) { let v = cb ? cb.tick(tmp[at], 1) : tmp[at]; if (at >= n) v *= rc((n + tail - at) / tail); const j = (k0 + at) % N; oL[j] += v * gl; oR[j] += v * gr; send[0][j] += v * 0.9; send[1][j] += v * 0.9; }
}
// ARP: the chords played as arpeggios. rate is in 16th steps: 2 = 1/8, 1 = 1/16, 2/3 = 1/16 triplets, 0.5 = 1/32. Degrees are steps of the 7-note scale.
function mashArp(arp, seed, chords, bars, leg) {
  const ra = mulberry(seed + 303), rate = arp.rate || 1, oct = arp.oct || 2, out = [], per = bars * 16; let j = 0, lastBar = -1;
  for (let i = 0; i * rate < per - 1e-6; i++) {
    const s = i * rate, b = Math.floor(s / 16 + 1e-9), c = chords[b], base = c + (c >= 4 ? 0 : 7); if (b !== lastBar) { j = 0; lastBar = b; }
    const tones = []; for (let o = 0; o < oct; o++) for (const t of [0, 2, 4]) tones.push(base + t + 7 * o); if (oct > 1) tones.push(base + 7 * oct);
    const n = tones.length, u = ra(); let d;
    if (arp.pattern === "down") d = tones[n - 1 - (j % n)];
    else if (arp.pattern === "updown") { const k = j % (2 * n - 2 || 1); d = tones[k < n ? k : 2 * n - 2 - k]; }
    else if (arp.pattern === "random") d = tones[Math.floor(u * n)];
    else if (arp.pattern === "thumb") d = j % 2 === 0 ? tones[0] : tones[1 + ((j >> 1) % (n - 1))];
    else d = tones[j % n];
    out.push({ s, len: Math.max(0.25, rate * (0.3 + 0.7 * leg)), d7: d, vel: Math.abs(s % 4) < 1e-6 ? 1 : 0.78 }); j++;
  }
  return out;
}
// the written line: a 2-bar rhythm motif and a stepwise contour that lands on chord tones on strong beats, returning with variations
function mashMelody(r, chords, bars, dens, leg) {
  const wts = [1, .15, .45, .2, .8, .15, .5, .3, .9, .15, .45, .2, .75, .3, .5, .35], ct = c => [c, c + 2, c + 4], motif = [], notes = [], plan = [];
  for (let b = 0; b < 2; b++) { const row = []; for (let s = 0; s < 16; s++) { const u = r(); row.push(s === 0 && b === 0 || u < wts[s] * (0.12 + 0.7 * dens)); } motif.push(row); }
  let deg = 7 + ct(chords[0])[Math.floor(r() * 3)];
  for (let b = 0; b < bars; b++) {
    const varyP = b < 2 ? 0 : (b >= 4 ? 0.4 : 0.28), row = motif[b % 2].slice();
    if (b >= 2) for (let s = 0; s < 16; s++) { const u = r(); if (u < 0.12 * dens) row[s] = !row[s]; }
    for (let s = 0; s < 16; s++) {
      const u1 = r(), u2 = r(), u3 = r(); if (!row[s]) continue; const strong = s % 8 === 0;
      if (b >= 2 && plan[(b - 2) * 16 + s] !== undefined && u3 > varyP) deg = plan[(b - 2) * 16 + s]; else deg += [-2, -1, -1, 0, 1, 1, 2, 3, -3, 4][Math.floor(u1 * 10)];
      if (strong || u2 < 0.3) { let bestD = deg, bd = 99; for (const t of ct(chords[b])) for (const o of [0, 7, 14]) { const d = t + o; if (Math.abs(d - deg) < bd) { bd = Math.abs(d - deg); bestD = d; } } deg = bestD; }
      deg = clamp(deg, 2, 15); plan[b * 16 + s] = deg; notes.push({ s: b * 16 + s, d7: deg, vel: strong ? 1 : (s % 4 === 0 ? 0.85 : 0.7) });
    }
  }
  if (notes.length) { const last = notes[notes.length - 1]; last.d7 = Math.round(last.d7 / 7) * 7 || 7; }
  for (let i = 0; i < notes.length; i++) { const nx = i + 1 < notes.length ? notes[i + 1].s : bars * 16 + notes[0].s; notes[i].len = Math.max(0.5, (nx - notes[i].s) * (0.3 + 0.7 * leg)); }
  return notes;
}
// job: { a:{src}, b:{src}, bpm, bars, root, scale, seed, blend, density, legato, tune, bass, pad, space, octave, arp:{on,pattern,rate,oct}, notes:[{s,len,deg,vel}]|null, chords:[deg…]|null, finish, outRate }
// Notes are steps of the session scale (deg 0 = the root, one octave below middle C's octave), so edits always stay in key.
function mashRender(job) {
  const par = [job.a && job.a.src ? mashAnalyse(job.a.src) : null, job.b && job.b.src ? mashAnalyse(job.b.src) : null]; if (!par[0] && !par[1]) throw new Error("load two sounds first");
  const r = mulberry(job.seed), w = job.blend, minor = scaleIsMinor(job.scale), s7 = scale7(job.scale), sN = SCALES[job.scale] || s7, nN = sN.length, root = job.root, sr = job.outRate, pcs = scalePcs(root, job.scale);
  const bars = job.bars || 4, beat = 60 / job.bpm, step = beat / 4, frames = Math.round(bars * 4 * beat * sr), dens = job.density === undefined ? 0.5 : job.density, leg = job.legato === undefined ? 0.55 : job.legato, tune = job.tune === undefined ? 0.5 : job.tune;
  const base = 48 + root + 12 * (job.octave || 0), semi7 = d => s7[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7), midiN = d => base + sN[((d % nN) + nN) % nN] + 12 * Math.floor(d / nN);
  // a note of the 7-step scale → the nearest note of the session scale, as a step of that scale
  const toN = d7 => { const m = nearestInScale(base + semi7(d7), pcs), rel = m - base, o = Math.floor(rel / 12), idx = sN.indexOf(((rel % 12) + 12) % 12); return o * nN + Math.max(0, idx); };
  const progs = MASH_PROGS[minor ? "min" : "maj"], prog = progs[Math.floor(r() * progs.length)], chords = []; for (let b = 0; b < bars; b++) chords.push(job.chords && job.chords[b] !== undefined && job.chords[b] !== null ? job.chords[b] : prog[b % 4]);
  const written = mashMelody(r, chords, bars, dens, leg);
  let notes = (job.arp && job.arp.on ? mashArp(job.arp, job.seed, chords, bars, leg) : written).map(n => ({ s: n.s, len: n.len, deg: toN(n.d7), vel: n.vel }));
  if (job.notes && job.notes.length) notes = job.notes.filter(n => n.s < bars * 16).map(n => ({ s: n.s, len: n.len, deg: n.deg, vel: n.vel || 0.85 }));
  // which pieces can sing: the clearly pitched, louder ones
  const tonalOf = P => !P ? [] : P.chunks.filter(c => c.tonal > 0.22).sort((a, b) => b.tonal * Math.sqrt(b.rms) - a.tonal * Math.sqrt(a.rms));
  const pools = [tonalOf(par[0]), tonalOf(par[1])].map((t, i) => t.length ? t.slice(0, Math.max(6, Math.ceil(t.length * 0.6))) : (par[i] ? par[i].chunks.slice(0, 24) : []));
  const choose = u => { let p = u < w ? 1 : 0; if (!pools[p].length) p = 1 - p; return p; };
  const degMap = [{}, {}], outL = new Float32Array(frames), outR = new Float32Array(frames), send = [new Float32Array(frames), new Float32Array(frames)];
  for (const nt of notes) {
    // each note has its own randomness (by its position), so editing one note doesn't reshuffle who sings the others
    const rn = mulberry(hashSeed(job.seed, Math.round(nt.s * 48))), u = rn(), u2 = rn(), u3 = rn(), p = choose(u); if (!pools[p].length) continue;
    const target = midiN(nt.deg), fit = pools[p].filter(c => target - c.midi <= 12 && target - c.midi >= -24);   // a low drone isn't asked to sing high
    const pool = fit.length ? fit : pools[p].slice().sort((x, y) => Math.abs(target - x.midi) - Math.abs(target - y.midi)).slice(0, 3);
    const k = ((nt.deg % nN) + nN) % nN; if (degMap[p][k] === undefined) degMap[p][k] = u2;
    const ch = u3 < 0.25 ? pool[Math.floor(u3 * 4 * pool.length) % pool.length] : pool[Math.floor(degMap[p][k] * pool.length)];
    let semis = target - ch.midi; while (semis > 12) semis -= 12; while (semis < -24) semis += 12;
    nt.p = p; nt.midi = ch.midi + semis;
    mashVoice(outL, outR, send, par[p], ch, semis, nt.s * step, nt.len * step, sr, 0.8 * nt.vel, p === 0 ? -0.25 : 0.25, 0.6, null, midiHz(nt.midi), tune);
  }
  // bass: the chord roots from a low piece, low-passed
  const bassPat = dens > 0.6 ? [0, 6, 8, 14] : dens > 0.3 ? [0, 8] : [0], bassNotes = [], rb = mulberry(job.seed + 101);
  if (job.bass > 0) for (let b = 0; b < bars; b++) {
    const u = rb(), p = choose(1 - u), pool = pools[p]; if (!pool.length) continue;
    const ch = pool.slice().sort((x, y) => x.midi - y.midi)[Math.floor(u * Math.min(3, pool.length))], target = 36 + root + semi7(chords[b]); let semis = target - ch.midi; while (semis > 12) semis -= 12; while (semis < -30) semis += 12;
    for (let i = 0; i < bassPat.length; i++) { const s = b * 16 + bassPat[i], nx = i + 1 < bassPat.length ? b * 16 + bassPat[i + 1] : (b + 1) * 16; bassNotes.push({ s, len: (nx - s) * 0.9, midi: target, p });
      const lp = new Svf(); lp.set(260, 0.9, sr); mashVoice(outL, outR, null, par[p], ch, semis, s * step, (nx - s) * 0.92 * step, sr, 1.1 * job.bass, 0, 0, lp); }
  }
  // pad: the chord, stretched out of the most tonal long piece of the quieter parent
  const rp = mulberry(job.seed + 202);
  if (job.pad > 0) {
    const p = choose(rp() < 0.5 ? 0 : 0.99), srcI = pools[1 - p].length ? 1 - p : p, ch = pools[srcI].slice().sort((x, y) => (y.e - y.s) * y.tonal - (x.e - x.s) * x.tonal)[0];
    if (ch) for (let b = 0; b < bars; b++) [chords[b], chords[b] + 2, chords[b] + 4].forEach((t, ti) => { const target = 48 + root + semi7(t); let semis = target - ch.midi; while (semis > 7) semis -= 12; while (semis < -17) semis += 12;
      mashStretch(outL, outR, send, par[srcI], ch, semis, b * 16 * step, 16 * step, sr, 0.22 * job.pad, rp, midiHz(target), tune, [0, -0.7, 0.7][ti]); });
  }
  // space: the send goes round the loop twice through the reverb, so the tail wraps into the start
  if (job.space > 0) { const rv = new Fdn(sr); rv.setDecay(1.5 + 5 * job.space, 0.45); const g = job.space * 1.1; for (let pass = 0; pass < 2; pass++) for (let i = 0; i < frames; i++) { rv.process(send[0][i], send[1][i]); if (pass) { outL[i] += rv.outL * g; outR[i] += rv.outR * g; } } }
  finishMix(outL, outR, sr, job.finish, root, true);
  const names = CHORD_NAMES[job.scale] || CHORD_NAMES[minor ? "min" : "maj"];
  return { L: outL, R: outR, rate: sr, bars, bpm: job.bpm, base, notes: notes.map(n => ({ s: n.s, len: n.len, deg: n.deg, vel: n.vel, midi: n.midi === undefined ? midiN(n.deg) : n.midi, p: n.p === undefined ? 0 : n.p })), bass: bassNotes,
    chords: chords.map(c => ({ deg: c, name: names[((c % 7) + 7) % 7], root: (root + s7[((c % 7) + 7) % 7]) % 12 })), parents: par.map(P => P ? mashInfo(P) : null) };
}

// ============================================================ VOCAL SHARD
// TUNE: the voice's pitch is tracked, every sung moment is snapped to the nearest note of the session scale and
// re-pitched one glottal period at a time (PSOLA), so it keeps its own character unless FORMANT moves it. The same
// engine can stretch or squeeze the take to fill a whole number of bars. CHOP: syllables re-sequenced as a tuned hook.
const VOX_CACHE = new WeakMap();
// pitch marks: one per period where the voice is voiced, every 5 ms elsewhere
function voxMarks(x, sr, P) {
  const n = x.length, lp = new Float32Array(n); let s = 0; const k = 1 - Math.exp(-TAU * 900 / sr); for (let i = 0; i < n; i++) { s += (x[i] - s) * k; lp[i] = s; }
  const f0At = t => P.f0[Math.min(P.frames - 1, Math.floor(t / P.hop))], uT = Math.round(sr / 200), marks = []; let t = 0, prevV = false;
  while (t < n) {
    const f = f0At(t);
    if (f > 0) { const T = sr / f; let best = t, bv = -1e9; const a = prevV ? Math.round(t - 0.2 * T) : Math.round(t), b = Math.round(t + (prevV ? 0.2 : 1) * T);
      for (let i = Math.max(0, a); i < Math.min(n, b); i++) if (lp[i] > bv) { bv = lp[i]; best = i; }
      if (marks.length && best <= marks[marks.length - 1].pos + 0.5 * T) best = Math.round(marks[marks.length - 1].pos + T);
      marks.push({ pos: best, T, v: 1 }); t = best + T; prevV = true; }
    else { marks.push({ pos: Math.round(t), T: uT, v: 0 }); t += uT; prevV = false; }
  }
  return marks;
}
function voxAnalyse(src, sens) {
  sens = sens === undefined ? 0.55 : sens; let V = VOX_CACHE.get(src);
  if (!V) {
    const { L, R, rate } = src, pk = peakOf(L, R); if (pk < 1e-4) throw new Error("that sound is silent");
    const n = Math.min(L.length, Math.floor(60 * rate)), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = 0.5 * (L[i] + R[i]) / pk * 0.9;
    const P = pitchTrack(x, rate), marks = voxMarks(x, rate, P), h = new Float64Array(12), vm = []; let pkR = 0;
    for (let f = 0; f < P.frames; f++) { if (P.rms[f] > pkR) pkR = P.rms[f]; if (P.f0[f] > 0) { const m = hzMidi(P.f0[f]); h[pcOf(m)] += P.rms[f]; vm.push(m); } }
    vm.sort((a, b) => a - b);
    // where the singing starts and stops (for fitting it to bars)
    let f0i = 0, f1i = P.frames - 1; while (f0i < P.frames && P.rms[f0i] < 0.05 * pkR) f0i++; while (f1i > f0i && P.rms[f1i] < 0.05 * pkR) f1i--;
    V = { src, x, rate, n, P, marks, pkR, key: vm.length > 20 ? keyFromChroma(h) : { root: -1, minor: false, confidence: 0 }, lo: vm.length ? vm[Math.floor(vm.length * 0.05)] : 60, hi: vm.length ? vm[Math.floor(vm.length * 0.95)] : 72, med: vm.length ? vm[vm.length >> 1] : 64,
      voiced: vm.length / P.frames, t0: Math.max(0, f0i * P.hop - Math.round(0.02 * rate)), t1: Math.min(n, (f1i + 1) * P.hop + Math.round(0.08 * rate)), S: spectra(x, rate), slices: {} };
    VOX_CACHE.set(src, V);
  }
  const key = sens.toFixed(2);
  if (!V.slices[key]) {   // syllables: onset to onset, kept between 70 ms and 0.7 s
    const { x, rate, n, P, S } = V, on = pickOnsets(S, rate, sens).map(c => refineOnset(x, c, S.N)); if (!on.length || on[0] > 0.05 * rate) on.unshift(0);
    const sl = [];
    for (let i = 0; i < on.length; i++) {
      const a = on[i], b = i + 1 < on.length ? on[i + 1] : n; if (b - a < 0.07 * rate) continue; const parts = Math.max(1, Math.ceil((b - a) / (0.7 * rate)));
      for (let q = 0; q < parts; q++) {
        const s = a + Math.floor((b - a) * q / parts), e = a + Math.floor((b - a) * (q + 1) / parts), ms = []; let en = 0;
        for (let f = Math.floor(s / P.hop); f < Math.min(P.frames, Math.floor(e / P.hop)); f++) { en += P.rms[f]; if (P.f0[f] > 0) ms.push(hzMidi(P.f0[f])); }
        const fr = Math.max(1, Math.floor(e / P.hop) - Math.floor(s / P.hop)); ms.sort((p, q2) => p - q2); if (en / fr < 0.04 * V.pkR) continue;
        sl.push({ s, e, midi: ms.length ? ms[ms.length >> 1] : NaN, voiced: ms.length / fr, level: en / fr });
      }
    }
    V.slices[key] = sl;
  }
  V.cur = V.slices[key]; return V;
}
function voxInfo(V) {
  const P = V.P, step = Math.max(1, Math.ceil(P.frames / 1600)), curve = []; for (let f = 0; f < P.frames; f += step) curve.push(P.f0[f] > 0 ? Math.round(hzMidi(P.f0[f]) * 100) / 100 : null);
  return { dur: V.n / V.rate, key: V.key, lo: V.lo, hi: V.hi, voiced: V.voiced, slices: V.cur.map(s => ({ s: s.s, e: s.e, midi: s.midi, voiced: s.voiced })), curve, curveStep: step * P.hop / V.rate, t0: V.t0 / V.rate, t1: V.t1 / V.rate };
}
// PSOLA. Output sample j shows source time t0 + j·speed: speed 1 = same length, <1 = stretched, >1 = squeezed.
// Each grain is two periods wide around its mark and lands at the new period; formant > 1 squeezes the grain itself.
function voxPsola(x, marks, ratioAt, formant, t0, outLen, speed, unvFormant) {
  const out = new Float32Array(outLen), ws = new Float32Array(outLen); if (outLen <= 0 || !marks.length) return out;
  let k = 0; while (k + 1 < marks.length && marks[k + 1].pos < t0) k++;
  let ts = 0, lastK = -1, flip = false;
  while (ts < outLen) {
    const sp = t0 + ts * speed; while (k + 1 < marks.length && Math.abs(marks[k + 1].pos - sp) <= Math.abs(marks[k].pos - sp)) k++;
    const m = marks[k], r = m.v ? ratioAt(m.pos) : 1, f = m.v ? formant : (unvFormant || 1), half = Math.max(8, Math.round(m.T / f)), c = Math.round(ts);
    // a breath or consonant repeated while stretching is read backwards every other time, so it stays noise instead of buzzing
    if (!m.v && k === lastK) flip = !flip; else flip = false; lastK = k; const dir = flip ? -f : f;
    for (let u = -half; u <= half; u++) { const j = c + u; if (j < 0 || j >= outLen) continue; const srcP = m.pos + u * dir, i0 = Math.floor(srcP); if (i0 < 0 || i0 + 1 >= x.length) continue;
      const w = 0.5 + 0.5 * Math.cos(Math.PI * u / half); out[j] += (x[i0] + (x[i0 + 1] - x[i0]) * (srcP - i0)) * w; ws[j] += w; }
    ts += m.v ? m.T / clamp(r, 0.25, 4) : m.T;
  }
  for (let i = 0; i < outLen; i++) if (ws[i] > 1) out[i] /= ws[i];
  return out;
}
function voxShiftNote(note, pcs, how) {   // harmony: steps of the scale (3rd = 2 steps, 5th = 4) or whole octaves
  if (how === "oct+") return note + 12; if (how === "oct-") return note - 12;
  const steps = how === "3rd" ? 2 : how === "5th" ? 4 : how === "6th" ? 5 : how === "4th-" ? -3 : 0; let m = note, c = 0, dir = steps < 0 ? -1 : 1; while (c < Math.abs(steps)) { m += dir; if (pcs.includes(pcOf(m))) c++; } return m;
}
// the tuning curve: nearest scale note (a new note has to be meant for 25 ms before it takes over), glide (RETUNE), kept wobble (HUMANIZE)
function voxCurve(V, o, pcs, harm) {
  const P = V.P, fr = P.frames, ratio = new Float32Array(fr).fill(1), outM = new Float32Array(fr).fill(NaN), inM = new Float32Array(fr).fill(NaN), hopSec = P.hop / V.rate;
  const a = o.retune <= 0.001 ? 1 : 1 - Math.exp(-hopSec / (o.retune * 0.2)); let cur = null, tgt = null, cand = null, candN = 0;
  for (let f = 0; f < fr; f++) {
    const f0 = P.f0[f]; if (!(f0 > 0)) { cur = null; tgt = null; continue; }
    const mi = hzMidi(f0), near = nearestInScale(mi, pcs); inM[f] = mi;
    if (cur === null) cur = near;
    else if (near !== cur && Math.abs(mi - cur) > 0.75) { if (cand === near) candN++; else { cand = near; candN = 1; } if (candN >= 5) { cur = near; cand = null; } }
    const note = harm ? voxShiftNote(cur, pcs, harm) : cur; if (tgt === null) tgt = note; else tgt += (note - tgt) * a;
    const corr = tgt + (o.humanize || 0) * (mi - cur) + (o.pitch || 0); outM[f] = corr; ratio[f] = clamp(Math.pow(2, (corr - mi) / 12), 0.25, 4);
  }
  return { ratio, outM, inM };
}
const voxRatioAt = (P, ratio) => t => { const f = t / P.hop, i = Math.min(P.frames - 1, Math.floor(f)), j = Math.min(P.frames - 1, i + 1), u = f - Math.floor(f); return ratio[i] + (ratio[j] - ratio[i]) * u; };
// effects: low cut → AIR → GRIT → DOUBLE (two short wobbling delays, left and right) → ECHO (ping-pong on the tempo) → SPACE
function voxFx(L, R, sr, o, loop) {
  const n = L.length, hp = [new Svf(), new Svf()], air = [new Svf(), new Svf()]; hp.forEach(f => f.set(95, 0.707, sr)); air.forEach(f => f.set(6500, 0.707, sr));
  const airG = Math.pow(10, ((o.air || 0) * 10) / 20) - 1, grit = o.grit || 0, dbl = o.double || 0, echo = o.echo || 0, space = o.space || 0;
  const DL = 8192, db = [new Float32Array(DL), new Float32Array(DL)]; let dw = 0;
  const eT = Math.max(64, Math.round((60 / o.bpm) * (o.echoDiv || 0.75) * sr)), EN = 1 << Math.ceil(Math.log2(eT + 8)), eb = [new Float32Array(EN), new Float32Array(EN)]; let ew = 0; const elp = [0, 0], ek = 1 - Math.exp(-TAU * 3200 / sr), fb = 0.32 + 0.3 * echo;
  const rv = new Fdn(sr); rv.setDecay(1.8 + 5 * space, 0.35); const passes = loop ? 2 : 1, tk = Math.tanh(1 + 8 * grit);
  for (let pass = 0; pass < passes; pass++) for (let i = 0; i < n; i++) {
    let l = L[i], r = R[i]; hp[0].tick(l); l = hp[0].hp; hp[1].tick(r); r = hp[1].hp;
    if (airG) { air[0].tick(l); air[1].tick(r); l += air[0].hp * airG; r += air[1].hp * airG; }
    if (grit > 0.001) { const k = 1 + 8 * grit; l = Math.tanh(l * k) / tk * (1 + grit * 0.3); r = Math.tanh(r * k) / tk * (1 + grit * 0.3); }
    db[0][dw] = l; db[1][dw] = r;
    if (dbl > 0.001) { const t = (pass * n + i) / sr, d1 = (0.017 + 0.0025 * Math.sin(TAU * 0.63 * t)) * sr, d2 = (0.026 + 0.003 * Math.sin(TAU * 0.47 * t + 1.3)) * sr;
      let p = dw - d1, i0 = Math.floor(p), u = p - i0; const x1 = db[0][(i0 + DL) & (DL - 1)] + (db[0][(i0 + 1 + DL) & (DL - 1)] - db[0][(i0 + DL) & (DL - 1)]) * u;
      p = dw - d2; i0 = Math.floor(p); u = p - i0; const x2 = db[1][(i0 + DL) & (DL - 1)] + (db[1][(i0 + 1 + DL) & (DL - 1)] - db[1][(i0 + DL) & (DL - 1)]) * u;
      l = l * (1 - 0.25 * dbl) + x1 * 0.85 * dbl - x2 * 0.15 * dbl; r = r * (1 - 0.25 * dbl) + x2 * 0.85 * dbl - x1 * 0.15 * dbl; }
    dw = (dw + 1) & (DL - 1);
    if (echo > 0.001) { const rpos = (ew - eT + EN) & (EN - 1), el = eb[0][rpos], er = eb[1][rpos]; elp[0] += (er - elp[0]) * ek; elp[1] += (el - elp[1]) * ek; eb[0][ew] = l * 0.7 + elp[0] * fb; eb[1][ew] = r * 0.3 + elp[1] * fb; ew = (ew + 1) & (EN - 1); l += el * echo * 0.75; r += er * echo * 0.75; }
    let ol = l, or = r; if (space > 0.001) { rv.process(l, r); ol += rv.outL * space * 1.3; or += rv.outR * space * 1.3; }
    if (pass === passes - 1) { L[i] = ol; R[i] = or; }
  }
}
// bars a take should fill at this tempo: the nearest power of two, without stretching by more than 2× either way
function voxFitBars(durSec, bpm) { const bar = 240 / bpm; let best = 1, bd = 99; for (const b of [1, 2, 4, 8, 16]) { const d = Math.abs(Math.log2(durSec / (b * bar))); if (d < bd) { bd = d; best = b; } } return best; }
// job: { src, bpm, root, scale, mode:"tune", fit:0(free)|-1(auto)|bars, retune, humanize, pitch, formant, harmony, harmLevel, double, air, grit, echo, echoDiv, space, finish, outRate }
function voxTune(job) {
  const V = voxAnalyse(job.src, job.sens), P = V.P, sr = V.rate, pcs = scalePcs(job.root, job.scale), form = Math.pow(2, (job.formant || 0) / 12), o = Object.assign({ bpm: job.bpm }, job);
  const main = voxCurve(V, o, pcs, null), fit = job.fit || 0; let t0 = 0, srcLen = V.n, outLen, speed = 1, bars = 0, loop = false;
  if (fit) { t0 = V.t0; srcLen = V.t1 - V.t0; bars = fit < 0 ? voxFitBars(srcLen / sr, job.bpm) : fit; outLen = Math.round(bars * 240 / job.bpm * sr); speed = srcLen / outLen; loop = true; }
  else outLen = srcLen;
  const tail = loop ? 0 : Math.round(Math.min(6, (o.space > 0 ? 1.5 + 4 * o.space : 0) + (o.echo > 0 ? 60 / job.bpm * (o.echoDiv || 0.75) * 6 : 0)) * sr), n = outLen + tail, L = new Float32Array(n), R = new Float32Array(n);
  const y = voxPsola(V.x, V.marks, voxRatioAt(P, main.ratio), form, t0, outLen, speed, Math.pow(2, (job.formant || 0) / 24));
  const fd = Math.round(0.01 * sr); for (let i = 0; i < outLen; i++) { const e = loop ? rc(i / fd) * rc((outLen - i) / fd) : 1; L[i] = y[i] * e; R[i] = y[i] * e; }
  let harm = null;
  if (job.harmony && job.harmony !== "none" && job.harmLevel > 0.001) {
    harm = voxCurve(V, o, pcs, job.harmony);
    const h = voxPsola(V.x, V.marks, voxRatioAt(P, harm.ratio), form * (job.harmony === "oct+" ? 1.06 : job.harmony === "oct-" ? 0.94 : 1), t0, outLen, speed, 1), g = job.harmLevel * 0.8;
    for (let i = 0; i < outLen; i++) { const e = loop ? rc(i / fd) * rc((outLen - i) / fd) : 1; L[i] += h[i] * g * 0.8 * e; R[i] += h[i] * g * 1.2 * e; }
  }
  voxFx(L, R, sr, o, loop); finishMix(L, R, sr, job.finish, job.root, loop);
  let oL = L, oR = R; if (sr !== job.outRate) { [oL, oR] = resample(L, R, sr, job.outRate); if (loop) [oL, oR] = exactLen(oL, oR, Math.round(bars * 240 / job.bpm * job.outRate)); }
  const st = Math.max(1, Math.ceil(P.frames / 1600)), pick = a => { const c = []; for (let f = 0; f < P.frames; f += st) c.push(Number.isFinite(a[f]) ? Math.round(a[f] * 100) / 100 : null); return c; };
  return { L: oL, R: oR, rate: job.outRate, bars, bpm: job.bpm, loop, speed, curveIn: pick(main.inM), curveOut: pick(main.outM), curveHarm: harm ? pick(harm.outM) : null, curveStep: st * P.hop / sr, t0: t0 / sr, srcLen: srcLen / sr, info: voxInfo(V) };
}
// job: { src, bpm, root, scale, mode:"chop", bars, seed, density, stutter, reverse, melody, gate, exclude:[slice…], mutes:[step…], pitch, formant, …fx, sens }
// rhythm shapes for the chop: how likely each 16th is to get a syllable
const VOX_STYLES = {
  hook: [1, .25, .55, .3, .85, .25, .6, .35, .95, .25, .55, .3, .8, .35, .6, .4],
  house: [.3, .1, 1, .3, .2, .1, .95, .5, .3, .1, 1, .3, .2, .15, .95, .6],            // lives on the off-beats
  techno: [.9, .5, .7, .5, .85, .5, .7, .55, .9, .5, .7, .5, .85, .5, .75, .6],        // a driving 16th line
  brat: [1, .8, .7, .85, .6, .15, .1, .05, .95, .7, .8, .3, .1, .05, .6, .75],         // a shouted phrase, a gap, an answer
  glitch: null,                                                                          // a different broken grid every time
};
// the club underneath: pump (sidechain), a four-on-the-floor kit, a bass on the key's root, and the tape stop
function voxFloor(L, R, sr, N, stepN, job) {
  const kind = job.floor === "house" || job.floor === "techno" ? job.floor : null, beatN = stepN * 4, steps = Math.round(N / stepN), r = mulberry((job.seed ^ 0x5f3759df) >>> 0);
  const add = (buf, at, pl, pr) => { for (let i = 0; i < buf.length; i++) { const j = (at + i) % N; L[j] += buf[i] * pl; R[j] += buf[i] * pr; } };
  const bassLv = kind ? (job.bassLevel === undefined ? 0.6 : job.bassLevel) : 0, kitLv = kind ? (job.floorLevel === undefined ? 0.8 : job.floorLevel) : 0;
  if (bassLv > 0.001) {
    const f = midiHz(33 + ((job.root - 9 + 12) % 12)), mk = (len, donk) => { const n = Math.round(len), b = new Float32Array(n), lp = new Svf(); let ph = 0;
      for (let i = 0; i < n; i++) { const t = i / sr, u = i / n; ph += f / sr; const sub = Math.sin(TAU * ph), sq = donk ? ((ph % 1) < 0.5 ? 1 : -1) * 0.5 + (2 * (ph * 2 % 1) - 1) * 0.3 : 0; lp.set(140 + 1500 * Math.exp(-t / 0.05), 1.6, sr); lp.tick(sq);
        b[i] = Math.tanh((sub * 0.9 + lp.lp * 0.8) * 1.5) * 0.55 * rc(i / (0.004 * sr)) * rc((n - i) / (0.02 * sr)) * (donk ? 1 : 1 - 0.3 * u); } return b; };
    if (kind === "house") { const b = mk(stepN * 1.9, true); for (let s = 2; s < steps; s += 4) add(b, Math.round(s * stepN), bassLv, bassLv); }
    else { const b = mk(stepN * 0.92, false); for (let s = 0; s < steps; s++) if (s % 4) add(b, Math.round(s * stepN), bassLv * (s % 4 === 2 ? 1 : 0.8), bassLv * (s % 4 === 2 ? 1 : 0.8)); }
  }
  const pump = job.pump || 0;
  if (pump > 0.001) { const rel = beatN * 0.6, pre = 0.004 * sr; for (let i = 0; i < N; i++) { const ph = i % beatN, x = Math.min(1, ph / rel), x2 = Math.min(1, (beatN - ph) / pre), g = Math.min(1 - pump * (1 - x) * (1 - x), 1 - pump * (1 - x2)); L[i] *= g; R[i] *= g; } }
  if (kitLv > 0.001) {
    const kn = Math.round(0.3 * sr), kick = new Float32Array(kn); let ph = 0; for (let i = 0; i < kn; i++) { const t = i / sr; ph += (kind === "techno" ? 44 : 50) / sr + 130 * Math.exp(-t / 0.021) / sr; kick[i] = Math.tanh(2.4 * Math.sin(TAU * ph)) * Math.exp(-t / (kind === "techno" ? 0.14 : 0.1)) * 0.85 * rc((kn - i) / 200) + (i < 90 ? (r() * 2 - 1) * 0.25 * (1 - i / 90) : 0); }
    const noise = (len, dec, fc, q) => { const n = Math.round(len * sr), b = new Float32Array(n), f = new Svf(); f.set(fc, q, sr); for (let i = 0; i < n; i++) { f.tick(r() * 2 - 1); b[i] = (q > 1 ? f.bp : f.hp) * Math.exp(-i / sr / dec) * rc((n - i) / 64); } return b; };
    const hatC = noise(0.05, 0.012, 7500, 0.7), hatO = noise(0.16, 0.05, 6800, 0.7), clap = noise(0.2, 0.06, 1500, 2.2); for (let i = 0; i < clap.length; i++) { const t = i / sr; if (t < 0.028) clap[i] *= 0.35 + 0.65 * Math.abs(Math.sin(TAU * 55 * t)); }
    for (let s = 0; s < steps; s++) { const at = Math.round(s * stepN), q = s % 16;
      if (s % 4 === 0) add(kick, at, kitLv, kitLv);
      if (kind === "house") { if (s % 4 === 2) add(hatO, at, kitLv * 0.34, kitLv * 0.3); if (q === 4 || q === 12) add(clap, at, kitLv * 0.5, kitLv * 0.55); if (s % 2 === 1 && r() < 0.35) add(hatC, at, kitLv * 0.16, kitLv * 0.2); }
      else { add(hatC, at, kitLv * (s % 4 === 2 ? 0.3 : 0.14), kitLv * (s % 4 === 2 ? 0.26 : 0.17)); if (s % 4 === 2) add(hatO, at, kitLv * 0.2, kitLv * 0.22); if (q === 4 || q === 12) add(clap, at, kitLv * 0.28, kitLv * 0.28); } }
  }
  if (job.stop) { const T = Math.min(N, Math.round(beatN)), a = N - T; for (const ch of [L, R]) { const src = ch.slice(a); let p = 0; for (let i = 0; i < T; i++) { const u = i / T, i0 = Math.floor(p), fr = p - i0; ch[a + i] = (src[Math.min(T - 1, i0)] * (1 - fr) + src[Math.min(T - 1, i0 + 1)] * fr) * rc((1 - u) * 3); p += Math.pow(1 - u, 1.4); } } }
}
function voxChop(job) {
  const V = voxAnalyse(job.src, job.sens), P = V.P, sr = V.rate, pcs = scalePcs(job.root, job.scale), form = Math.pow(2, (job.formant || 0) / 12), o = Object.assign({ bpm: job.bpm }, job), slices = V.cur;
  const r = mulberry(job.seed), bars = job.bars || 2, stepN = 60 / job.bpm / 4 * sr, steps = bars * 16, N = Math.round(steps * stepN), dens = job.density === undefined ? 0.6 : job.density, mel = job.melody || 0;
  let pool = slices.map((s, i) => i).filter(i => !(job.exclude && job.exclude.includes(i))); if (!pool.length) throw new Error(slices.length ? "every slice is switched off" : "no syllables found in this sound");
  const weight = i => 0.2 + slices[i].voiced + 0.5 * Math.min(1, slices[i].level * 10), pickSlice = u => { let tot = 0; for (const i of pool) tot += weight(i); let x = u * tot; for (const i of pool) { x -= weight(i); if (x <= 0) return i; } return pool[pool.length - 1]; };
  // a one- or two-bar motif that comes back with variations, like a vocal-chop hook
  const style = Object.prototype.hasOwnProperty.call(VOX_STYLES, job.style) ? job.style : "hook", tuned = job.tuned !== false, glitchy = style === "glitch" ? 1.7 : style === "brat" ? 1.2 : 1;
  const wts = VOX_STYLES[style] || Array.from({ length: 16 }, (_, k) => k === 0 ? 0.8 : 0.2 + 0.8 * r());
  if (style === "techno" && pool.length > 3) { const keep = []; while (keep.length < (dens > 0.6 ? 3 : 2)) { const c = pickSlice(r()); if (!keep.includes(c)) keep.push(c); } pool = keep; }   // techno: two or three syllables, hammered
  const motifLen = style === "techno" ? 16 : bars >= 2 ? 32 : 16, motif = [], home = nearestInScale(V.med, pcs), scaleNotes = [];
  for (let m = home - 14; m <= home + 14; m++) if (pcs.includes(pcOf(m))) scaleNotes.push(m); const hi0 = scaleNotes.indexOf(home);
  let deg = 0, last = -1; const span = Math.round(2 + 5 * mel);
  for (let s = 0; s < motifLen; s++) {
    const u = r(), u2 = r(), u3 = r(), u4 = r(), u5 = r(), u6 = r(), u7 = r(), u8 = r(), u9 = r(), u10 = r(), u11 = r(); if (!((s === 0 && style !== "house") || u < wts[s % 16] * (0.15 + 0.75 * dens))) { motif.push(null); continue; }
    deg = clamp(deg + [-2, -1, -1, 0, 0, 1, 1, 2, 3, -3][Math.floor(u3 * 10)], -span, span); if (Math.abs(deg) >= 3 && u7 < 0.5) deg -= Math.sign(deg);   // the line keeps coming home
    let sl = pickSlice(u2); if (sl === last && pool.length > 1 && u7 > 0.3) sl = pool[(pool.indexOf(sl) + 1) % pool.length]; last = sl;
    const roll = u10 < (job.ratchet || 0) * 0.4 * glitchy ? [2, 4, 4, 3][Math.floor(u11 * 4)] : 0;
    motif.push({ slice: sl, deg: mel > 0.001 ? deg : null, rev: u4 < (job.reverse || 0) * 0.45 * glitchy, stut: !roll && u5 < (job.stutter || 0) * 0.4 * glitchy ? [2, 3, 4, 2][Math.floor(u6 * 4)] : 0, roll, rise: u9 < 0.6, oct: u8 < (job.octave || 0) * 0.5 ? (u9 < 0.72 ? 12 : -12) : 0 });
  }
  const ev = [];
  for (let s = 0; s < steps; s++) { const m = motif[s % motifLen], u = r(), u2 = r(); let e = m ? Object.assign({}, m) : null; if (s >= motifLen && u < 0.18 * dens) e = e ? null : { slice: pickSlice(u2), deg: mel > 0.001 ? deg : null, rev: false, stut: 0, roll: 0, rise: false, oct: 0 }; if (job.mutes && job.mutes.includes(s)) e = null; if (e) { e.step = s; ev.push(e); } }
  for (let k = 0; k < ev.length; k++) { const nx = k + 1 < ev.length ? ev[k + 1].step : steps + ev[0].step; ev[k].len = Math.max(0.5, (nx - ev[k].step) * (0.25 + 0.75 * (job.gate === undefined ? 0.8 : job.gate))); if (ev[k].roll) ev[k].len = clamp(nx - ev[k].step, 1, 2); }
  const L = new Float32Array(N), R = new Float32Array(N), pitch = job.pitch || 0;
  const upScale = (m, q) => { for (let k = 0; k < q; k++) { do m++; while (!pcs.includes(pcOf(m))); } return m; };
  for (const e of ev) {
    const sl = slices[e.slice]; let note = !tuned ? null : e.deg !== null ? scaleNotes[clamp(hi0 + e.deg, 0, scaleNotes.length - 1)] : (Number.isFinite(sl.midi) ? nearestInScale(sl.midi, pcs) : null); if (note !== null) note += e.oct || 0; e.note = note;
    const want = Math.round(e.len * stepN), reps = e.roll ? Math.max(2, Math.round(e.len * e.roll)) : e.stut || 1, gap = reps > 1 ? Math.round(want / reps) : 0, srcN = Math.min(sl.e - sl.s, want);
    const segLen = e.roll ? Math.min(gap, srcN) : e.stut ? Math.max(64, Math.min(Math.round(stepN / (e.stut > 2 ? 2 : 1) / (e.stut === 3 ? 1.5 : 1)), srcN)) : srcN; if (segLen < 64) continue;
    const att = Math.min(Math.round(0.003 * sr), segLen >> 2), rel = Math.min(Math.round(e.roll ? 0.006 * sr : 0.018 * sr), segLen >> 1);
    // every voiced period of this syllable goes to its one note (or, AS SUNG, keeps its own melody)
    const mk = (nt, semis) => { const flat = Math.pow(2, (pitch + semis + (nt === null ? e.oct || 0 : 0)) / 12), ratioAt = t => { const f0 = P.f0[Math.min(P.frames - 1, Math.floor(t / P.hop))]; if (!(f0 > 0) || nt === null) return flat; return clamp(Math.pow(2, (nt + pitch - hzMidi(f0)) / 12), 0.25, 4); };
      const seg = voxPsola(V.x, V.marks, ratioAt, form, sl.s, segLen, 1, Math.pow(2, (job.formant || 0) / 24)); if (e.rev) seg.reverse(); for (let i = 0; i < segLen; i++) seg[i] *= rc(i / att) * rc((segLen - i) / rel); return seg; };
    let seg = mk(note, 0); const k0 = Math.round(e.step * stepN), pan = ((e.slice * 37) % 7 - 3) / 12;
    for (let q = 0; q < reps; q++) { if (e.roll && e.rise && q) seg = note !== null ? mk(upScale(note, q), 0) : mk(null, q * 12 / reps);
      const g = e.roll ? 0.65 + 0.35 * q / (reps - 1) : e.stut ? 1 - 0.12 * q : 1, at = k0 + q * gap; for (let i = 0; i < segLen && (reps === 1 || i < gap); i++) { const j = (at + i) % N, f = reps > 1 && i > gap - rel ? rc((gap - i) / rel) : 1; L[j] += seg[i] * g * f * (1 - pan); R[j] += seg[i] * g * f * (1 + pan); } }
  }
  voxFx(L, R, sr, o, true);
  voxFloor(L, R, sr, N, stepN, job);
  finishMix(L, R, sr, job.finish, job.root, true);
  let oL = L, oR = R; if (sr !== job.outRate) { [oL, oR] = resample(L, R, sr, job.outRate); [oL, oR] = exactLen(oL, oR, Math.round(steps * 60 / job.bpm / 4 * job.outRate)); }
  return { L: oL, R: oR, rate: job.outRate, steps, bars, bpm: job.bpm, loop: true, style, floor: job.floor || "off", events: ev.map(e => ({ step: e.step, len: e.len, slice: e.slice, note: e.note, rev: e.rev, stut: e.stut, roll: e.roll || 0, oct: e.oct || 0 })), info: voxInfo(V) };
}

// ============================================================ the lab: analysis and rendering, off the audio and page threads
// The page registers every sound in the crate here once (put). After that a job only names sounds by id, so re-rendering
// a loop at a new tempo or key is just the same job posted again.
const LAB_POOL = new Map();
function labSound(id) { const s = LAB_POOL.get(id); if (!s) throw new Error("that sound is no longer in the crate"); return s; }
function labPut(id, L, R, rate, name) {
  const s = { id, L, R, rate, name, key: null }; LAB_POOL.set(id, s);
  const info = analyzeSound(L, R, rate); s.key = info.key; return { info, peaks: peakBins(L, R, 600) };
}
function labDemo(kind, rate) { return kind === "beatA" ? demoBeat(0, rate) : kind === "beatB" ? demoBeat(1, rate) : kind === "bells" ? demoBells(rate) : kind === "voice" ? demoVoice(rate) : makeCrystal(rate); }
// run one job; the result's L/R are transferable, everything else is plain data
function labRender(job, onProg) {
  const k = job.kind;
  if (k === "crystal") { const src = labSound(job.srcId); return crystalRender(Object.assign({}, job, { src }), onProg); }
  if (k === "beat") return beatRender(Object.assign({}, job, { a: job.a && job.a.id ? { src: labSound(job.a.id), edit: job.a.edit } : null, b: job.b && job.b.id ? { src: labSound(job.b.id), edit: job.b.edit } : null }));
  if (k === "mash") return mashRender(Object.assign({}, job, { a: job.a && job.a.id ? { src: labSound(job.a.id) } : null, b: job.b && job.b.id ? { src: labSound(job.b.id) } : null }));
  if (k === "voxtune") return voxTune(Object.assign({}, job, { src: labSound(job.srcId) }));
  if (k === "voxchop") return voxChop(Object.assign({}, job, { src: labSound(job.srcId) }));
  throw new Error("unknown job " + k);
}
function labHandle(m, post) {
  const reply = (data, xfer) => post(Object.assign({ t: "reply", req: m.req }, data), xfer || []);
  try {
    if (m.t === "put") reply(labPut(m.id, m.L, m.R, m.rate, m.name));
    else if (m.t === "drop") { LAB_POOL.delete(m.id); reply({}); }
    else if (m.t === "demo") { const d = labDemo(m.kind, m.rate), L = d.L.slice(), R = d.R.slice(), a = labPut(m.id, d.L, d.R, d.rate, d.name); reply(Object.assign({ name: d.name, L, R, rate: d.rate }, a), [L.buffer, R.buffer]); }
    else if (m.t === "drum") reply({ data: drumInfo(drumAnalyse(labSound(m.id), m.edit)) });
    else if (m.t === "mashinfo") reply({ data: mashInfo(mashAnalyse(labSound(m.id))) });
    else if (m.t === "voxinfo") reply({ data: voxInfo(voxAnalyse(labSound(m.id), m.sens)) });
    else if (m.t === "render") { const res = labRender(m.job, p => post({ t: "progress", req: m.req, p })), L = res.L, R = res.R; delete res.L; delete res.R; reply({ data: res, L, R }, [L.buffer, R.buffer]); }
    else reply({ error: "unknown request " + m.t });
  } catch (err) { reply({ error: String(err && err.message || err) }); }
}

// ---- worker glue
self.onmessage = e => {
  const m = e.data;
  if (m.t === "plan") { try { self.postMessage({ t: "reply", req: m.req, layers: crystalPlan(m.seed, m.depth, m.keep || []) }); } catch (err) { self.postMessage({ t: "reply", req: m.req, error: String(err && err.message || err) }); } return; }
  labHandle(m, (msg, xfer) => self.postMessage(msg, xfer || []));
};
