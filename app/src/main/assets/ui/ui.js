// Shared by both screens. On the Thor, NC is the bridge into the app; in a desktop browser a stand-in lets the pages be previewed.
const P = { POSITION: 0, LENGTH: 1, SCAN: 2, SIZE: 3, DENSITY: 4, PITCH: 5, SPRAY: 7, SHATTER: 8, REV: 9, SPREAD: 10, ATTACK: 11, SUSTAIN: 12, MIX: 13, TONE: 16, RESO: 17, DRIVE: 18, CRUSH: 19, CHORUS: 20, DELAY: 21, DTIME: 22, DFEED: 23, SPACE: 24, DECAY: 25, PLAY: 28, FREEZE: 29 };
const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
// the key you hear: the sound's own key moved by the PITCH setting
const heardKey = st => { if (!st || st.keyRoot < 0) return null; const semis = Math.round((st.p[P.PITCH] - 0.5) * 48); return { root: (((st.keyRoot + semis) % 12) + 12) % 12, minor: st.keyMinor }; };
if (!window.NC) {
  const p = [0.31, 0.6, 0.85, 0.62, 0.55, 0.65, 0.5, 0.25, 0, 0, 0.5, 0.5, 0, 0.85, 0.3, 0.55, 0.36, 0.15, 0, 0, 0, 0, 0.5, 0.4, 0.7, 0.5, 0.8, 0.5, 1, 0, 0, 1, 0, 1, 0, 0];
  let live = false, t0 = performance.now(), fakeRoom = new URLSearchParams(location.search).get("room") || "grain";
  window.NC = {
    set: (i, v) => { p[i] = v; }, pad: (n, d) => { if (d && n === "PLAY") p[28] = 1 - p[28]; if (d && n === "FREEZE") p[29] = 1 - p[29]; if (d && n === "REVERSE") p[9] = 1 - p[9]; },
    note() {}, sound() {}, live: on => { live = on; }, grab() {}, rec() {}, add() {}, remove() {}, select() {}, room: r => { fakeRoom = r; }, bpm() {}, resBegin() {}, resChunk() {}, resEnd() {}, hear() {}, keep() {}, toDeck() {}, deckToggle() {}, deckRemove() {}, outRec() {}, say() {}, share() {},
    resultPeaks: () => NC.peaks(), phases: () => [((performance.now() - t0) / 4000) % 1, 0.3, 0.7, -1, -1, -1, -1, -1, -1].join(","),
    state: () => JSON.stringify({ sound: "GLASS BELLS", seconds: 9, live, mood: "DREAM", sel: 2, version: 1, bpm: 128, keyRoot: 4, keyMinor: true, usb: "FM-1 (audio, MIDI)", midi: "FM-1", mic: true, input: "Gart Stringer", rec: false, recSec: 0, notice: "", mine: false, room: fakeRoom, cur: 1, hear: true, deckOn: true, act: "", actSeq: 0, outRec: -1, result: "SHARDS × SNOWFALL", resultSec: 15, resultBars: 8, share: "E MINOR|grown from GLASS BELLS · depth 3", sounds: [{ id: 1, name: "GLASS BELLS", key: 4, minor: true }, { id: 2, name: "DUSTY BOOM-BAP", key: -1, minor: true }, { id: 3, name: "SNOW VOICE", key: 9, minor: true }], deck: [{ name: "BEAT BABY", bars: 2 }, { name: "VOICE CHOP", bars: 2 }], info: "48000 Hz · block 96 · buffer 4 ms · AAudio · input running", throws: "", p }),
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

// ---- the room rail, the deck strip and room changes: the same on every top screen
const ROOMS = [["grain", "GRAIN", "グレイン"], ["crystal", "CRYSTAL", "クリスタル"], ["hybrid", "HYBRID", "ハイブリッド"], ["vocal", "VOCAL", "ボーカル"]];
const mmss = t => Math.floor(t / 60) + ":" + String(Math.floor(t % 60)).padStart(2, "0");
function buildRail(host) {
  host.innerHTML = '<div style="font-size: 1.5rem; color: #9FB0FF; font-family: Michroma">333</div>' + ROOMS.map(([id, n, k]) => `<button class="tab" data-room="${id}">${n}<small>${k}</small></button>`).join("") + '<div style="flex: 1"></div><button class="tab" id="orec">REC</button>';
  host.querySelectorAll("[data-room]").forEach(b => b.addEventListener("pointerdown", () => NC.room(b.dataset.room)));
  host.querySelector("#orec").addEventListener("pointerdown", () => NC.outRec());
}
function paintRail(host, st) {
  host.querySelectorAll("[data-room]").forEach(b => { const on = b.dataset.room === st.room; b.classList.toggle("on", on); b.classList.toggle("dimmer", !on); });
  const o = host.querySelector("#orec"); o.textContent = st.outRec >= 0 ? mmss(st.outRec) : "REC"; o.classList.toggle("rec", st.outRec >= 0);
}
// the deck: tap the round button to play or stop, hold a loop to take it off
function buildDeck(host) { host.innerHTML = '<button id="dplay" aria-label="Play or stop the deck"></button><div id="lanes"></div>'; host.querySelector("#dplay").addEventListener("pointerdown", () => NC.deckToggle()); }
function paintDeck(host, st) {
  const L = host.querySelector("#lanes"), sig = JSON.stringify(st.deck);
  if (host._sig !== sig) {
    host._sig = sig; L.innerHTML = st.deck.length ? st.deck.map((d, i) => `<button class="cap lane" data-i="${i}"><b>${d.name}</b><span>${d.bars ? d.bars + " bars" : "loop"}</span><i></i></button>`).join("") : '<div class="cap lane empty">DECK EMPTY</div>';
    L.querySelectorAll("[data-i]").forEach(b => { let t = 0; b.addEventListener("pointerdown", () => { t = setTimeout(() => NC.deckRemove(+b.dataset.i), 800); }); for (const ev of ["pointerup", "pointercancel", "pointerleave"]) b.addEventListener(ev, () => clearTimeout(t)); });
  }
  host.querySelector("#dplay").classList.toggle("on", !!st.deckOn);
}
function paintDeckPhases(host, ph) { host.querySelectorAll(".lane i").forEach((el, i) => { const v = ph[i + 1]; el.style.width = v >= 0 ? v * 100 + "%" : "0"; }); }
// each screen has a GRAIN page and a page for the other rooms; swap when the room changes
function watchRoom(isGrainPage, which) { setInterval(() => { const st = getState(); if (!st || !st.room) return; const g = st.room === "grain"; if (g !== isGrainPage) location.replace((g ? "" : "m") + which + ".html" + location.search); }, 250); }
const statusLine = st => "IN " + (st.mic ? st.input : "not allowed") + "  ·  KEYS " + (st.midi ? st.midi + (st.midiCount ? " (" + st.midiCount + ")" : "") : "none") + "  ·  " + st.info.replace(/ · input.*/, "");
