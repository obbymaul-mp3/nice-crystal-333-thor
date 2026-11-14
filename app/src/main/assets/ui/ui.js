// Shared by both screens. On the Thor, NC is the bridge into the app; in a desktop browser a stand-in lets the pages be previewed.
const P = { POSITION: 0, LENGTH: 1, SCAN: 2, SIZE: 3, DENSITY: 4, PITCH: 5, SPRAY: 7, SHATTER: 8, REV: 9, SPREAD: 10, ATTACK: 11, SUSTAIN: 12, MIX: 13, TONE: 16, RESO: 17, DRIVE: 18, CRUSH: 19, CHORUS: 20, DELAY: 21, DTIME: 22, DFEED: 23, SPACE: 24, DECAY: 25, PLAY: 28, FREEZE: 29 };
const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// the key you hear: the sound's own key moved by the PITCH setting
const heardKey = st => { if (!st || st.keyRoot < 0) return null; const semis = Math.round((st.p[P.PITCH] - 0.5) * 48); return { root: (((st.keyRoot + semis) % 12) + 12) % 12, minor: st.keyMinor }; };
if (!window.NC) {
  const p = [0.31, 0.6, 0.85, 0.62, 0.55, 0.65, 0.5, 0.25, 0, 0, 0.5, 0.5, 0, 0.85, 0.3, 0.55, 0.36, 0.15, 0, 0, 0, 0, 0.5, 0.4, 0.7, 0.5, 0.8, 0.5, 1, 0, 0, 1, 0, 1, 0, 0];
  let live = false, t0 = performance.now();
  window.NC = {
    set: (i, v) => { p[i] = v; }, pad: (n, d) => { if (d && n === "PLAY") p[28] = 1 - p[28]; if (d && n === "FREEZE") p[29] = 1 - p[29]; if (d && n === "REVERSE") p[9] = 1 - p[9]; },
    note() {}, sound() {}, live: on => { live = on; }, grab() {}, select() {},
    state: () => JSON.stringify({ sound: "GLASS BELLS", seconds: 9, live, mood: "DREAM", sel: 2, version: 1, bpm: 128, keyRoot: 4, keyMinor: true, usb: "FM-1 (audio, MIDI)", midi: "FM-1", mic: true, info: "48000 Hz · block 96 · buffer 4 ms · AAudio · input running", throws: "", p }),
    peaks: () => Array.from({ length: 480 }, (_, i) => (Math.exp(-((i % 120) / 40)) * (0.5 + 0.5 * Math.abs(Math.sin(i * 0.9)))).toFixed(3)).join(","),
    snap: () => { const t = (performance.now() - t0) / 1000, len = 0.34, ws = p[0] * (1 - len), a = [live ? 1 : 0, 9, ws + ((t * 0.2) % 1) * len, ws, len, 0, 6, 1, 0.2, 0.5, 4, -1, 0, 0, 0, 0.5 + 0.2 * Math.sin(t * 3), 0.45, ...p.slice(0, 28), 6]; for (let k = 0; k < 6; k++) a.push(ws + len * ((k * 0.17 + t * 0.3) % 1), 0.3 + 0.1 * k, Math.sin(k * 2.1)); return a.join(","); },
  };
}
const $ = id => document.getElementById(id);
const getState = () => { try { return JSON.parse(NC.state()); } catch (e) { return null; } };
const fmt = {
  pitch: v => { const st = Math.round((v - 0.5) * 48); return (st > 0 ? "+" : st < 0 ? "−" : "") + Math.abs(st) + " st"; },
  density: v => { const g = 0.5 * Math.pow(240, v); return (g < 10 ? g.toFixed(1) : Math.round(g)) + "/s"; },
  tone: v => { const t = (v - 0.5) * 2; if (Math.abs(t) <= 0.02) return "OPEN"; const hz = t < 0 ? 20000 * Math.pow(70 / 20000, (-t - 0.02) / 0.98) : 15 * Math.pow(7000 / 15, (t - 0.02) / 0.98); return (t < 0 ? "LP " : "HP ") + (hz >= 1000 ? (hz / 1000).toFixed(1) + "k" : Math.round(hz)); },
  pct: v => Math.round(v * 100) + "%",
  len: (v, total) => { const s = total <= 0.01 ? total : Math.min(total, 0.01 * Math.pow(total / 0.01, v)); return s < 1 ? Math.round(s * 1000) + " ms" : s.toFixed(2) + " s"; },
  scan: v => { const x = (v - 0.5) * 2, sp = Math.sign(x) * x * x * 2; return Math.abs(sp) < 0.005 ? "PARKED" : "×" + sp.toFixed(2); },
  time: v => ["1/32", "1/16T", "1/16", "1/8T", "1/16.", "1/8", "1/4T", "1/8.", "1/4", "1/4.", "1/2"][Math.min(10, Math.floor(v * 11))],
  decay: v => (0.3 * Math.pow(66, v)).toFixed(1) + " s",
  off: v => v < 0.005 ? "OFF" : Math.round(v * 100) + "%",
  blend: v => v < 0.03 ? "TAPE" : v > 0.97 ? "GRAINS" : Math.round(v * 100) + "%",
  size: v => { const s = 0.004 * Math.pow(500, v); return s < 1 ? Math.round(s * 1000) + " ms" : s.toFixed(2) + " s"; },
};
