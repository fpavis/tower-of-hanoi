/* HANOI//PROTOCOL — Kaplay front end, NEON RELAY direction (DESIGN.md §10, §12).
 * Renders and routes input only. Every rule comes from the HanoiCore global (core.js).
 * Kaplay 3001 with global: true, so kaplay functions are globals; top-level names avoid them. */

const LOGIC_W = 900;
const LOGIC_H = 500;
const STORE_KEY = "hanoi-protocol.v2";
const HORIZON_Y = 318;
const TAU = Math.PI * 2;

const PAL = {
  bg: "#07060f",
  ink: "#0b0a18",
  tube: "#0d0c22",
  plate: "#16142f",
  cyan: "#3cf2ff",
  magenta: "#ff2e88",
  lime: "#b6ff3b",
  amber: "#ffb020",
  violet: "#7b5cff",
  gold: "#ffd23f",
  danger: "#ff3b5c",
  white: "#f4f7ff",
  dim: "#6b6a86",
  chrome: "#c8d0e0",
  steel: "#2a2f3f",
};

const RARITY = {
  common: { hex: PAL.cyan, label: "COMMON" },
  rare: { hex: PAL.amber, label: "RARE" },
  epic: { hex: PAL.magenta, label: "EPIC" },
  curse: { hex: PAL.danger, label: "CURSE" },
};

const Z = {
  bg: -100, disks: -50, board: 10, relay: 12, ring: 20, fx: 40,
  ui: 60, hud: 70, pop: 80, tip: 945, glitch: 940, flash: 950, cover: 960, scan: 1000,
};

const RELAY_TOP = 150;
const BASE_Y = 402;
const RING_H = 22;
const STACK_STEP = 25;
const LIFT = 20;
const MOVE_DUR = 0.36;
const HUD_BAND = 64;
const NODE_LETTERS = "ABCD";
const FOG_HEX = "#8a8fa3";
const BALL_HEX = [PAL.cyan, PAL.magenta, PAL.lime, PAL.amber, PAL.violet, PAL.gold];

// Relay x positions, spaced evenly across the canvas: 3 relays give 225/450/675 (the original layout).
function relayX(i, n = 3) {
  return Math.round(((i + 1) * LOGIC_W) / (n + 1));
}

const MODE_INFO = {
  standard: { name: "STANDARD", neon: PAL.cyan, blurb: "Twelve sectors. Bosses at 4, 8 and 12. Clear the Stack to win." },
  blitz: { name: "BLITZ", neon: PAL.amber, blurb: "Standard rules on a clock. Bits x1.25. Stalling costs integrity." },
  endless: { name: "ENDLESS", neon: PAL.magenta, blurb: "No victory. Bosses every five sectors. Run until integrity fails." },
  daily: { name: "DAILY", neon: PAL.lime, blurb: "Standard rules on today's shared seed. Same board for everyone." },
  peg4: { name: "QUAD RELAY", neon: PAL.violet, blurb: "Four relays. The target relay moves between sectors." },
  reverse: { name: "REVERSE", neon: PAL.gold, blurb: "Stacking is inverted. Rings may only rest on smaller rings." },
};
const MODE_ORDER = ["standard", "blitz", "endless", "daily", "peg4", "reverse"];

const MODIFIER_HEX = {
  surge: PAL.amber, strict: PAL.danger, tax: PAL.magenta, scramble: PAL.violet,
  fog: PAL.chrome, overclock: PAL.cyan, gilded_rush: PAL.gold,
};

// ---------- small helpers ----------
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pad2 = (n) => String(n).padStart(2, "0");
const fmt = (n) => Math.round(n || 0).toLocaleString("en-US");
const titleOf = (id) => String(id || "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const hexC = (hex) => Color.fromHex(hex);

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(rgb) {
  return "#" + rgb.map((v) => clampN(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
}
function mixHex(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex(A.map((v, i) => v + (B[i] - v) * t));
}
function rampHex(stops, t) {
  const k = clampN(t, 0, 1) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(k));
  return mixHex(stops[i], stops[i + 1], k - i);
}
function lumOf(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Ring colour ramp (DESIGN §12): size 1 cyan, through violet and magenta, largest amber.
const RING_STOPS = [PAL.cyan, PAL.violet, PAL.magenta, PAL.amber];
function ringHex(size, n) {
  const t = n <= 1 ? 1 : (size - 1) / (n - 1);
  return rampHex(RING_STOPS, t);
}
function ringWidth(size) {
  return 46 + size * 15;
}

// ---------- persistent store (localStorage, every access guarded) ----------
function defaultStore() {
  return { best: {}, seen: {}, standardWon: false, sound: true };
}
function loadStore() {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object") return Object.assign(defaultStore(), obj);
    }
  } catch (e) {
    /* storage blocked or corrupt: play on with defaults */
  }
  return defaultStore();
}
function saveStore() {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(STORE));
  } catch (e) {
    /* storage unavailable: the run still works, records just stay in memory */
  }
}
const STORE = loadStore();

// UTC calendar date, so every player gets the same daily board (matches core's todaySeed).
function todaySeed() {
  const d = new Date();
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}
function recordKey(modeId, asc, seed) {
  if (modeId === "daily") return "daily:" + seed + (asc ? "+asc" : "");
  return modeId + (asc ? "+asc" : "");
}
function bestOf(key) {
  return STORE.best[key] || null;
}
function bestScoreAll() {
  let top = 0;
  Object.keys(STORE.best).forEach((k) => {
    const e = STORE.best[k];
    if (e && e.score > top) top = e.score;
  });
  return top;
}

// ---------- shared session state ----------
const SESSION = {
  run: null, mode: "standard", asc: false, seed: null,
  sector: null, board: null, t0: 0, recorded: false, newBest: false, bonus: null,
};
const UI = { asc: false };
const ESC = { until: -1 };
let PLAY = null;
let navBusy = false;

// ---------- audio: procedural Web Audio, created on the first user gesture ----------
const AUDIO = { ctx: null, master: null, failed: false, unlocked: false, on: STORE.sound !== false };

// The context is only ever created after a real user gesture (see the listeners below).
function getAudioCtx() {
  if (AUDIO.failed || !AUDIO.unlocked) return null;
  try {
    if (!AUDIO.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) {
        AUDIO.failed = true;
        return null;
      }
      AUDIO.ctx = new Ctor();
      AUDIO.master = AUDIO.ctx.createGain();
      AUDIO.master.gain.value = 0.55;
      AUDIO.master.connect(AUDIO.ctx.destination);
    }
    if (AUDIO.ctx.state === "suspended") AUDIO.ctx.resume();
    return AUDIO.ctx;
  } catch (e) {
    AUDIO.failed = true;
    AUDIO.ctx = null;
    return null;
  }
}
["pointerdown", "keydown", "touchstart"].forEach((ev) => {
  window.addEventListener(ev, () => {
    AUDIO.unlocked = true;
    getAudioCtx();
  }, { passive: true });
});

function tone({ type = "sine", f0 = 440, f1 = null, dur = 0.12, vol = 0.1, delay = 0 }) {
  if (!AUDIO.on) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    if (f1 !== null) osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(AUDIO.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
    osc.onended = () => {
      try {
        osc.disconnect();
        g.disconnect();
      } catch (e) { /* already gone */ }
    };
  } catch (e) {
    /* audio is decoration: never let it break a move */
  }
}

function noiseBurst({ dur = 0.1, vol = 0.08, delay = 0, freq = 1800 }) {
  if (!AUDIO.on) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(bp);
    bp.connect(g);
    g.connect(AUDIO.master);
    src.start(ctx.currentTime + delay);
  } catch (e) {
    /* ignore */
  }
}

const sfxMove = () => tone({ type: "triangle", f0: 220, f1: 660, dur: 0.14, vol: 0.09 });
const sfxLand = () => {
  tone({ type: "sine", f0: 880, dur: 0.12, vol: 0.12 });
  tone({ type: "sine", f0: 1320, dur: 0.16, vol: 0.1, delay: 0.07 });
};
const sfxHeavy = () => tone({ type: "square", f0: 110, f1: 55, dur: 0.18, vol: 0.07 });
const sfxGilded = () => [1046, 1318, 1568].forEach((f, i) => tone({ type: "triangle", f0: f, dur: 0.22, vol: 0.08, delay: i * 0.05 }));
const sfxInvalid = () => {
  tone({ type: "sawtooth", f0: 180, f1: 70, dur: 0.28, vol: 0.09 });
  noiseBurst({ dur: 0.12, vol: 0.07 });
};
const sfxComboBreak = () => tone({ type: "square", f0: 520, f1: 260, dur: 0.16, vol: 0.05 });
const sfxSelect = () => tone({ type: "sine", f0: 660, f1: 880, dur: 0.06, vol: 0.06 });
const sfxSoft = () => tone({ type: "sine", f0: 300, dur: 0.05, vol: 0.03 });
const sfxTick = () => tone({ type: "sine", f0: 1500, dur: 0.025, vol: 0.02 });
const sfxClick = () => tone({ type: "sine", f0: 900, f1: 1200, dur: 0.05, vol: 0.06 });
const sfxHint = () => tone({ type: "triangle", f0: 660, f1: 990, dur: 0.16, vol: 0.08 });
const sfxReroll = () => tone({ type: "sawtooth", f0: 300, f1: 600, dur: 0.12, vol: 0.05 });
const sfxStamp = () => {
  tone({ type: "sine", f0: 120, f1: 45, dur: 0.35, vol: 0.18 });
  noiseBurst({ dur: 0.08, vol: 0.05, freq: 900 });
};
const sfxRevive = () => [660, 880, 1100, 1320].forEach((f, i) => tone({ type: "sine", f0: f, dur: 0.22, vol: 0.08, delay: i * 0.06 }));
const sfxUpgrade = () => [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) =>
  tone({ type: "sine", f0: f, dur: 0.34, vol: 0.09, delay: i * 0.055 })
);
function sfxArpeggio(victory) {
  const notes = victory ? [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568] : [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((f, i) => tone({ type: "triangle", f0: f, dur: 0.22, vol: 0.09, delay: i * 0.09 }));
}
function sfxGameOver() {
  if (!AUDIO.on) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime;
    const a = ctx.createOscillator();
    const b = ctx.createOscillator();
    a.type = "sawtooth";
    a.frequency.value = 55;
    b.type = "sine";
    b.frequency.value = 41.2;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 260;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.2, t0 + 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.8);
    a.connect(lp);
    b.connect(lp);
    lp.connect(g);
    g.connect(AUDIO.master);
    a.start(t0);
    b.start(t0);
    a.stop(t0 + 2.9);
    b.stop(t0 + 2.9);
  } catch (e) {
    /* ignore */
  }
}

function toggleSound() {
  STORE.sound = !(STORE.sound !== false);
  AUDIO.on = STORE.sound;
  saveStore();
  if (AUDIO.on) sfxClick();
}
const soundLabel = () => "SOUND: " + (STORE.sound !== false ? "ON" : "OFF");

// ---------- drawing primitives (absolute coordinates; objects that draw use pos(0,0)) ----------
function strokeEllipse(cx, cy, rx, ry, width, hex, op) {
  const pts = [];
  for (let k = 0; k <= 40; k++) {
    const a = (k / 40) * TAU;
    pts.push(vec2(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry));
  }
  drawLines({ pts, width, color: hexC(hex), opacity: op });
}

function dashedRect(x, y, w, h, dash, gap, hex, op) {
  const edges = [[x, y, x + w, y], [x + w, y, x + w, y + h], [x + w, y + h, x, y + h], [x, y + h, x, y]];
  for (const [ax, ay, bx, by] of edges) {
    const len = Math.hypot(bx - ax, by - ay);
    if (len <= 0) continue;
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    for (let s = 0; s < len; s += dash + gap) {
      const e = Math.min(len, s + dash);
      drawLine({
        p1: vec2(ax + ux * s, ay + uy * s),
        p2: vec2(ax + ux * e, ay + uy * e),
        width: 1.6, color: hexC(hex), opacity: op,
      });
    }
  }
}

function drawSparkle(x, y, r, a) {
  if (a <= 0.02) return;
  drawLine({ p1: vec2(x - r, y), p2: vec2(x + r, y), width: 1.5, color: hexC(PAL.white), opacity: a });
  drawLine({ p1: vec2(x, y - r), p2: vec2(x, y + r), width: 1.5, color: hexC(PAL.white), opacity: a });
}

// Diagonal hazard stripes clipped to a rectangle with drawMasked.
function drawHazard(x0, y0, w, h, hex, bgHex, op) {
  const sp = 12;
  const bw = 5;
  drawMasked(
    () => {
      for (let c = -h; c < w; c += sp) {
        drawPolygon({
          pts: [
            vec2(x0 + c, y0),
            vec2(x0 + c + bw, y0),
            vec2(x0 + c + bw + h, y0 + h),
            vec2(x0 + c + h, y0 + h),
          ],
          color: hexC(bgHex),
          opacity: op,
        });
      }
    },
    () => {
      drawRect({ pos: vec2(x0, y0), width: w, height: h, color: hexC(hex), opacity: 1 });
    }
  );
}

function drawPill(cx, cy, label, hex, w = 92) {
  drawRect({ pos: vec2(cx, cy), width: w, height: 20, anchor: "center", radius: 10, color: hexC(hex), opacity: 1 });
  drawText({ text: label, size: 16, pos: vec2(cx, cy), anchor: "center", color: hexC(PAL.ink) });
}

// Fog (DESIGN 13.4): a buried ring is a neutral slab with no size number. Special types keep a small marker.
function drawFogRing(cx, cy, w, h, type, op) {
  const center = vec2(cx, cy);
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  drawRect({ pos: center, width: w + 2, height: h + 2, anchor: "center", radius: 7, color: hexC(PAL.chrome), opacity: 0.3 * op });
  drawRect({ pos: center, width: w, height: h, anchor: "center", radius: 6, color: hexC(FOG_HEX), opacity: op });
  drawRect({ pos: vec2(cx, y0 + 3), width: w - 10, height: 2, anchor: "center", color: hexC(PAL.white), opacity: 0.18 * op });
  if (type === "gilded") drawCircle({ pos: vec2(x0 + 9, cy), radius: 3.5, color: hexC(PAL.gold), opacity: op });
  else if (type === "ghost") dashedRect(x0, y0, w, h, 6, 4, PAL.white, 0.8 * op);
  else if (type === "heavy") {
    drawRect({ pos: vec2(cx, cy - h * 0.27), width: w - 12, height: 2, anchor: "center", color: hexC(PAL.chrome), opacity: 0.9 * op });
    drawRect({ pos: vec2(cx, cy + h * 0.27), width: w - 12, height: 2, anchor: "center", color: hexC(PAL.chrome), opacity: 0.9 * op });
  } else if (type === "aegis") drawCircle({ pos: vec2(x0 + w - 9, cy), radius: 3.5, color: hexC(PAL.amber), opacity: op });
}

// One ring, drawn in its own colour, type treatment and size chip.
function drawRingAt(cx, cy, size, n, type, o = {}) {
  const op = o.opacity ?? 1;
  const h = o.h ?? RING_H;
  const w = o.w ?? ringWidth(size);
  if (o.fog) {
    drawFogRing(cx, cy, w, h, type, op);
    return;
  }
  const hex = ringHex(size, n);
  const tt = time();
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  const center = vec2(cx, cy);

  drawRect({ pos: center, width: w + 10, height: h + 8, anchor: "center", radius: 9, color: hexC(hex), opacity: 0.1 * op });

  if (type === "gilded") {
    const pulse = 0.5 + 0.5 * Math.sin(tt * 3 + size);
    drawRect({ pos: center, width: w + 8, height: h + 8, anchor: "center", radius: 9, color: hexC(PAL.gold), opacity: (0.16 + 0.14 * pulse) * op });
    drawRect({ pos: center, width: w, height: h, anchor: "center", radius: 6, color: hexC(PAL.gold), opacity: op });
    drawRect({ pos: vec2(cx, y0 + h * 0.27), width: w - 8, height: h * 0.36, anchor: "center", radius: 4, color: hexC("#fff4bf"), opacity: 0.42 * op });
    const phase = (tt * 0.55 + size * 0.31) % 1;
    drawSparkle(x0 + 8 + phase * (w - 16), cy, 5 + 2 * pulse, Math.sin(phase * Math.PI) * op);
  } else if (type === "ghost") {
    drawRect({ pos: center, width: w, height: h, anchor: "center", radius: 6, color: hexC(hex), opacity: 0.2 * op });
    dashedRect(x0, y0, w, h, 6, 4, PAL.white, 0.85 * op);
  } else if (type === "heavy") {
    drawRect({ pos: center, width: w, height: h, anchor: "center", radius: 5, color: hexC(PAL.steel), opacity: op, outline: { width: 2, color: hexC(PAL.chrome) } });
    drawRect({ pos: vec2(cx, cy - h * 0.27), width: w - 12, height: 2, anchor: "center", color: hexC(PAL.chrome), opacity: 0.9 * op });
    drawRect({ pos: vec2(cx, cy + h * 0.27), width: w - 12, height: 2, anchor: "center", color: hexC(PAL.chrome), opacity: 0.9 * op });
  } else if (type === "aegis") {
    drawRect({ pos: center, width: w, height: h, anchor: "center", radius: 5, color: hexC(PAL.amber), opacity: op });
    drawHazard(x0, y0, w, h, PAL.amber, PAL.ink, 0.85 * op);
  } else {
    drawRect({ pos: center, width: w, height: h, anchor: "center", radius: 6, color: hexC(hex), opacity: op });
    drawRect({ pos: vec2(cx, y0 + 3), width: w - 10, height: 2, anchor: "center", color: hexC(PAL.white), opacity: 0.4 * op });
    drawRect({ pos: vec2(cx, y0 + h - 3), width: w - 10, height: 2, anchor: "center", color: hexC(PAL.ink), opacity: 0.35 * op });
  }

  if (o.chip === false) return;
  drawRect({ pos: center, width: 24, height: 15, anchor: "center", radius: 4, color: hexC(PAL.ink), opacity: 0.8 * op });
  drawText({ text: String(size), size: 16, pos: center, anchor: "center", color: hexC(PAL.white), opacity: op });
}

// ---------- kaplay objects: text, items, particles, overlays ----------
function txt(str, x, y, o = {}) {
  const opts = { size: o.size ?? 18, align: o.align ?? "center" };
  if (o.width !== undefined) opts.width = o.width;
  const comps = [
    text(str, opts),
    pos(x, y),
    anchor(o.anchor ?? "center"),
    color(hexC(o.hex ?? PAL.white)),
    opacity(o.opacity ?? 1),
    z(o.z ?? Z.ui),
  ];
  if ((o.stroke ?? 3) > 0) comps.push(outline(o.stroke ?? 3, hexC(o.ink ?? PAL.ink)));
  if (o.fixed) comps.push(fixed());
  if (o.tag) comps.push(o.tag);
  return add(comps);
}

function tw(from, to, dur, set, ease, done) {
  const c = tween(from, to, dur, set, ease ?? easings.easeOutCubic);
  if (done) c.onEnd(done);
  return c;
}

function screenFlash(hex, peak = 0.35, dur = 0.4) {
  const f = add([rect(LOGIC_W, LOGIC_H), pos(0, 0), color(hexC(hex)), opacity(peak), fixed(), z(Z.flash)]);
  tw(peak, 0, dur, (v) => { if (f.exists()) f.opacity = v; }, easings.easeOutQuad, () => { if (f.exists()) destroy(f); });
}

function pop(str, x, y, hex, size = 20) {
  add([
    text(str, { size }),
    pos(x, y),
    anchor("center"),
    color(hexC(hex)),
    outline(3, hexC(PAL.ink)),
    opacity(1),
    z(Z.pop),
    {
      life: 0.95,
      vy: -34,
      update() {
        this.pos.y += this.vy * dt();
        this.vy *= 0.93;
        this.life -= dt();
        this.opacity = clampN(this.life * 2, 0, 1);
        if (this.life <= 0) destroy(this);
      },
    },
  ]);
}

function sparks(x, y, hex, n = 12, power = 150) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, TAU);
    const s = rand(power * 0.3, power);
    const life = rand(0.35, 0.7);
    add([
      circle(rand(1.5, 3.2)),
      pos(x, y),
      anchor("center"),
      color(hexC(hex)),
      opacity(1),
      z(Z.fx),
      {
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 60,
        life,
        maxLife: life,
        update() {
          this.vy += 340 * dt();
          this.pos.x += this.vx * dt();
          this.pos.y += this.vy * dt();
          this.life -= dt();
          this.opacity = Math.max(0, this.life / this.maxLife);
          if (this.life <= 0) destroy(this);
        },
      },
    ]);
  }
}

function shockwave(cx, cy, hex, maxR = 320, dur = 0.8) {
  const s = { r: 8, a: 1 };
  const obj = add([
    pos(0, 0),
    z(Z.fx),
    {
      draw() {
        strokeEllipse(cx, cy, s.r, s.r, 3, hex, s.a);
        strokeEllipse(cx, cy, s.r * 0.97, s.r * 0.97, 1.5, PAL.white, s.a * 0.6);
      },
    },
  ]);
  tw(8, maxR, dur, (v) => { s.r = v; }, easings.easeOutCubic);
  tw(1, 0, dur, (v) => { s.a = v; }, easings.linear, () => { if (obj.exists()) destroy(obj); });
}

const GLITCH = { level: 0 };
function addOverlay() {
  // Scanlines plus vignette: one fixed object on top of every scene.
  add([
    pos(0, 0),
    z(Z.scan),
    fixed(),
    {
      draw() {
        for (let y = 0; y < LOGIC_H; y += 3) {
          drawRect({ pos: vec2(0, y + 2), width: LOGIC_W, height: 1, color: hexC("#000000"), opacity: 0.22 });
        }
        if (vignetteReady) drawSprite({ sprite: "vignette", pos: vec2(0, 0), width: LOGIC_W, height: LOGIC_H, opacity: 1 });
      },
    },
  ]);
  // Glitch strips: drawn only while GLITCH.level is above zero.
  add([
    pos(0, 0),
    z(Z.glitch),
    fixed(),
    {
      draw() {
        if (GLITCH.level <= 0.01) return;
        const g = GLITCH.level;
        const n = 5 + Math.floor(g * 10);
        for (let i = 0; i < n; i++) {
          const y = rand(0, LOGIC_H);
          const h = rand(2, 14) * (0.5 + g);
          const dx = rand(-36, 36) * g;
          drawRect({ pos: vec2(dx, y), width: LOGIC_W, height: h, color: hexC(i % 2 ? PAL.magenta : PAL.cyan), opacity: 0.2 * g });
        }
        drawRect({ pos: vec2(0, 0), width: LOGIC_W, height: LOGIC_H, color: hexC(PAL.danger), opacity: 0.08 * g });
      },
      update() {
        GLITCH.level = Math.max(0, GLITCH.level - dt() * 2.2);
      },
    },
  ]);
}

// Built after kaplay() has defined loadSprite (see the Kaplay setup below).
let vignetteReady = false;
function buildVignette() {
  try {
    const cv = document.createElement("canvas");
    cv.width = 256;
    cv.height = 144;
    const g = cv.getContext("2d");
    const grad = g.createRadialGradient(128, 72, 70, 128, 72, 190);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, "rgba(0,0,0,0.62)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 144);
    loadSprite("vignette", cv.toDataURL("image/png"))
      .then(() => { vignetteReady = true; })
      .catch(() => { vignetteReady = false; });
  } catch (e) {
    vignetteReady = false;
  }
}

// Synthwave floor with a scrolling perspective grid, a striped sun and drifting neon disks.
function drawSun(cx, H, R) {
  const N = 26;
  for (let i = 0; i < N; i++) {
    const y0 = H - R + (R * i) / N;
    const y1 = H - R + (R * (i + 1)) / N;
    const dy = (y0 + y1) / 2 - H;
    const half = Math.sqrt(Math.max(0, R * R - dy * dy));
    drawRect({ pos: vec2(cx - half, y0), width: half * 2, height: y1 - y0 + 0.6, color: hexC(mixHex(PAL.amber, PAL.magenta, i / (N - 1))), opacity: 1 });
    if (i > N * 0.5 && i % 2 === 0) {
      drawRect({ pos: vec2(cx - half - 2, y0), width: half * 2 + 4, height: (y1 - y0) * 0.8, color: hexC(PAL.bg), opacity: 1 });
    }
  }
}

function drawSynth(t, sun) {
  const H = HORIZON_Y;
  drawRect({ pos: vec2(0, H), width: LOGIC_W, height: LOGIC_H - H, color: hexC("#120a26"), opacity: 1 });
  if (sun) drawSun(450, H, 92);
  drawRect({ pos: vec2(0, H - 14), width: LOGIC_W, height: 14, color: hexC(PAL.magenta), opacity: 0.07 });
  drawRect({ pos: vec2(0, H - 1), width: LOGIC_W, height: 2, color: hexC(PAL.magenta), opacity: 0.95 });
  const f = (t * 0.55) % 1;
  for (let k = 0; k < 12; k++) {
    const u = k + 1 - f;
    const y = H + 170 / (u + 0.9);
    if (y > LOGIC_H + 2) continue;
    drawLine({
      p1: vec2(0, y), p2: vec2(LOGIC_W, y),
      width: 1 + (y - H) / 260,
      color: hexC(PAL.violet),
      opacity: clampN(0.15 + (y - H) / 140, 0.15, 0.6),
    });
  }
  for (let d = -8; d <= 8; d++) {
    drawLine({ p1: vec2(450, H), p2: vec2(450 + d * 150, LOGIC_H), width: 1.2, color: hexC(PAL.violet), opacity: 0.35 });
  }
}

function addDisk() {
  const d = {
    x: rand(0, LOGIC_W), y: rand(0, LOGIC_H), r: rand(22, 60), v: rand(8, 22),
    hex: [PAL.cyan, PAL.magenta, PAL.violet, PAL.amber, PAL.lime][Math.floor(rand(0, 5))],
    ph: rand(0, TAU), op: rand(0.14, 0.28),
  };
  add([
    pos(0, 0),
    z(Z.disks),
    {
      update() {
        d.y -= d.v * dt();
        d.ph += dt();
        if (d.y < -d.r * 1.5) {
          d.y = LOGIC_H + d.r;
          d.x = rand(0, LOGIC_W);
        }
      },
      draw() {
        const wob = Math.sin(d.ph) * 6;
        drawEllipse({ pos: vec2(d.x + wob, d.y), radiusX: d.r, radiusY: d.r * 0.32, color: hexC(d.hex), opacity: 0.06 });
        strokeEllipse(d.x + wob, d.y, d.r, d.r * 0.32, 2, d.hex, d.op);
      },
    },
  ]);
}

// opts.sun: only the title carries the striped sun; text-heavy screens keep the grid alone.
function addSynth(opts = {}) {
  const sky = { t: rand(0, 4) };
  const sun = !!opts.sun;
  add([
    pos(0, 0),
    z(Z.bg),
    {
      update() { sky.t += dt(); },
      draw() { drawSynth(sky.t, sun); },
    },
  ]);
  for (let i = 0; i < (opts.disks ?? 0); i++) addDisk();
}

// A short row of rings used as a mode icon: sizes step up left to right.
// maxW shrinks the whole row (rings and gaps) when a card is too narrow for the full icon.
function drawRingRow(cx, cy, count, maxW = Infinity) {
  let gap = 5;
  let total = 0;
  const widths = [];
  for (let s = 1; s <= count; s++) {
    const w = 12 + s * 5;
    widths.push(w);
    total += w;
  }
  total += gap * (count - 1);
  const k = Math.min(1, maxW / total);
  if (k < 1) {
    widths.forEach((w, i) => { widths[i] = w * k; });
    gap *= k;
    total *= k;
  }
  let x = cx - total / 2;
  for (let s = 1; s <= count; s++) {
    const w = widths[s - 1];
    drawRingAt(x + w / 2, cy, s, count, "standard", { w, h: 12 * k, chip: false, opacity: 0.95 });
    x += w + gap;
  }
}

// Quiet dot-grid backdrop for the play, reward and clear screens.
function addDotGrid(hex = PAL.cyan) {
  add([
    pos(0, 0),
    z(Z.bg),
    {
      draw() {
        for (let x = 20; x < LOGIC_W; x += 40) {
          drawLine({ p1: vec2(x, 0), p2: vec2(x, LOGIC_H), width: 1, color: hexC(hex), opacity: 0.045 });
        }
        for (let y = 20; y < LOGIC_H; y += 40) {
          drawLine({ p1: vec2(0, y), p2: vec2(LOGIC_W, y), width: 1, color: hexC(hex), opacity: 0.045 });
        }
      },
    },
  ]);
}

// Menu items: a dark panel with a neon outline; focus fills it (buttons) or lifts it (cards).
// makeItem wraps an already-created panel object so callers can attach children to it.
function makeItem(body, { neon = PAL.cyan, enabled = true, onPick, onStyle }) {
  body.isEnabled = enabled;
  body.onPick = onPick || (() => {});
  const item = {
    body,
    neon,
    focused: false,
    lbl: null,
    setFocus(on) {
      if (!body.exists()) return;
      item.focused = on;
      if (onStyle) onStyle(on);
    },
  };
  return item;
}

function addItem({ x, y, w, h, neon = PAL.cyan, enabled = true, radius = 10, onPick, onStyle }) {
  const body = add([
    rect(w, h, { radius }),
    pos(x, y),
    anchor("center"),
    color(hexC(PAL.ink)),
    opacity(enabled ? 0.94 : 0.4),
    outline(2, hexC(enabled ? neon : PAL.dim)),
    area(),
    z(Z.ui),
    "menu-item",
  ]);
  return makeItem(body, { neon, enabled, onPick, onStyle });
}

// Enables or disables a menu button. The label keeps its focus colour (ink on a lit fill) while focused.
function setItemEnabled(item, on, neon) {
  if (!item.body.exists()) return;
  if (neon) item.neon = neon;
  if (!on && item.focused) item.setFocus(false);
  item.body.isEnabled = on;
  item.body.opacity = on ? 0.94 : 0.4;
  if (item.lbl) item.lbl.color = hexC(!on ? PAL.dim : item.focused ? PAL.ink : item.neon);
}

function menuButton({ x, y, w = 260, h = 44, label, neon = PAL.cyan, size = 22, enabled = true, onPick }) {
  const lbl = txt(label, x, y, { size, hex: enabled ? neon : PAL.dim, stroke: 3, z: Z.ui + 2 });
  const item = addItem({
    x, y, w, h, neon, enabled, onPick,
    onStyle(on) {
      item.body.color = hexC(on ? neon : PAL.ink);
      lbl.color = hexC(on ? PAL.ink : (item.body.isEnabled ? neon : PAL.dim));
    },
  });
  item.lbl = lbl;
  return item;
}

// Keyboard and pointer focus across one list. Up/Left and Down/Right move, Enter/Space picks.
function bindMenu(items) {
  let idx = -1;
  const isOn = (i) => i >= 0 && i < items.length && items[i].body.isEnabled && items[i].body.exists();
  const focusAt = (i) => {
    if (!isOn(i) || i === idx) return;
    if (idx >= 0 && items[idx].body.exists()) items[idx].setFocus(false);
    idx = i;
    items[i].setFocus(true);
    sfxTick();
  };
  const step = (d) => {
    if (!items.length) return;
    let i = idx;
    for (let k = 0; k < items.length; k++) {
      i = (i + d + items.length) % items.length;
      if (items[i].body.isEnabled) break;
    }
    focusAt(i);
  };
  const activate = () => {
    if (isOn(idx)) items[idx].body.onPick();
  };
  items.forEach((it, i) => {
    it.body.onHover(() => focusAt(i));
    it.body.onClick(() => {
      if (!it.body.isEnabled) return;
      focusAt(i);
      activate();
    });
  });
  onKeyPress("up", () => step(-1));
  onKeyPress("left", () => step(-1));
  onKeyPress("down", () => step(1));
  onKeyPress("right", () => step(1));
  onKeyPress("enter", activate);
  onKeyPress("space", activate);
  focusAt(items.findIndex((it) => it.body.isEnabled));
  return {
    activate,
    focus: focusAt,
    get index() { return idx; },
  };
}

// ---------- tooltip: one reusable card for every hover target (DESIGN 13.8) ----------
// tipZone() adds an invisible hit area; hovering it shows TIP's card next to the pointer.
const TIP = { obj: null, owner: null, card: null };
const TIP_W = 300;
const TIP_PAD = 14;
const TIP_GAP = 6;

function tipMeasure(info) {
  const inner = TIP_W - TIP_PAD * 2;
  const c = { hex: info.hex || PAL.cyan, title: info.title, desc: info.desc || "", detail: info.detail || "", foot: info.foot || "" };
  c.hT = formatText({ text: c.title, size: 18, width: inner }).height;
  c.hD = c.desc ? formatText({ text: c.desc, size: 16, width: inner }).height : 0;
  c.hX = c.detail ? formatText({ text: c.detail, size: 16, width: inner }).height : 0;
  c.hF = c.foot ? formatText({ text: c.foot, size: 16, width: inner }).height : 0;
  c.w = TIP_W;
  c.h = TIP_PAD * 2 + c.hT + (c.hD ? TIP_GAP + c.hD : 0) + (c.hX ? TIP_GAP + c.hX : 0) + (c.hF ? TIP_GAP + c.hF : 0);
  c.x = 0;
  c.y = 0;
  return c;
}

function tipPlace() {
  const c = TIP.card;
  if (!c) return;
  const m = mousePos();
  const off = 18;
  let x = m.x + off;
  let y = m.y + off;
  if (x + c.w > LOGIC_W - 8) x = m.x - off - c.w;
  if (y + c.h > LOGIC_H - 8) y = m.y - off - c.h;
  c.x = clampN(x, 8, LOGIC_W - 8 - c.w);
  c.y = clampN(y, 8, LOGIC_H - 8 - c.h);
}

function tipDraw(c) {
  const inner = TIP_W - TIP_PAD * 2;
  drawRect({
    pos: vec2(c.x, c.y), width: c.w, height: c.h, anchor: "topleft", radius: 10,
    color: hexC(PAL.ink), opacity: 0.96, outline: { width: 2, color: hexC(c.hex) },
  });
  let y = c.y + TIP_PAD;
  drawText({ text: c.title, size: 18, pos: vec2(c.x + TIP_PAD, y), anchor: "topleft", width: inner, color: hexC(c.hex) });
  y += c.hT;
  if (c.hD) {
    y += TIP_GAP;
    drawText({ text: c.desc, size: 16, pos: vec2(c.x + TIP_PAD, y), anchor: "topleft", width: inner, color: hexC(PAL.white) });
    y += c.hD;
  }
  if (c.hX) {
    y += TIP_GAP;
    drawText({ text: c.detail, size: 16, pos: vec2(c.x + TIP_PAD, y), anchor: "topleft", width: inner, color: hexC(PAL.chrome) });
    y += c.hX;
  }
  if (c.hF) {
    y += TIP_GAP;
    drawText({ text: c.foot, size: 16, pos: vec2(c.x + TIP_PAD, y), anchor: "topleft", width: inner, color: hexC(PAL.gold) });
  }
}

function tipEnsure() {
  if (TIP.obj && TIP.obj.exists()) return;
  TIP.obj = add([
    pos(0, 0), z(Z.tip), fixed(), "tooltip",
    {
      update() {
        if (!TIP.card) return;
        if (TIP.owner && !TIP.owner.exists()) {
          TIP.owner = null;
          TIP.card = null;
          return;
        }
        tipPlace();
      },
      draw() {
        if (TIP.card) tipDraw(TIP.card);
      },
    },
  ]);
}

function tipShow(owner, info) {
  if (!info || !info.title) return;
  tipEnsure();
  TIP.owner = owner;
  TIP.card = tipMeasure(info);
  tipPlace();
}

function tipHide(owner) {
  if (owner && TIP.owner !== owner) return;
  TIP.owner = null;
  TIP.card = null;
}

// Invisible hit area with a tooltip. info is an object, or a function read on hover.
function tipZone(x, y, w, h, info, o = {}) {
  const comps = [rect(w, h), pos(x, y), anchor(o.anchor ?? "topleft"), opacity(0), area(), z(Z.ui + 3)];
  if (o.fixed) comps.push(fixed());
  if (o.tag) comps.push(o.tag);
  const zone = add(comps);
  zone.onHover(() => tipShow(zone, typeof info === "function" ? info() : info));
  zone.onHoverEnd(() => tipHide(zone));
  return zone;
}

// Catalogue lookups: core supplies name, desc and detail. detail may be missing, so it falls back to desc alone.
function modTip(id) {
  const d = (HanoiCore.MODIFIERS || []).find((m) => m.id === id) || null;
  return {
    hex: MODIFIER_HEX[id] || PAL.cyan,
    title: String(d ? d.name : titleOf(id)).toUpperCase(),
    desc: d ? d.desc || "" : "",
    detail: d ? d.detail || "" : "",
  };
}
function questTip(q, hex = PAL.lime) {
  const d = (HanoiCore.QUESTS || []).find((x) => x.id === q.id) || {};
  return {
    hex,
    title: String(q.name || d.name || "QUEST").toUpperCase(),
    desc: d.desc || q.desc || "",
    detail: d.detail || "",
    foot: q.reward ? "REWARD +" + q.reward + " BITS" : "",
  };
}

// Scene change: fade to black, then go(). navBusy blocks double navigation.
function navigate(sceneName, args) {
  if (navBusy) return;
  tipHide();
  navBusy = true;
  const cover = add([rect(LOGIC_W, LOGIC_H), pos(0, 0), color(hexC(PAL.bg)), opacity(0), fixed(), z(Z.cover)]);
  tw(0, 1, 0.16, (v) => { if (cover.exists()) cover.opacity = v; }, easings.easeInOutSine);
  wait(0.17, () => {
    navBusy = false;
    go(sceneName, args);
  });
}

function startRun(modeId, asc) {
  const seed = modeId === "daily" ? todaySeed() : null;
  const opts = { mode: modeId };
  if (seed !== null) opts.seed = seed;
  if (asc) opts.ascension = true;
  SESSION.mode = modeId;
  SESSION.asc = !!asc;
  SESSION.seed = seed;
  SESSION.run = HanoiCore.createRun(opts);
  SESSION.sector = null;
  SESSION.board = null;
  SESSION.recorded = false;
  SESSION.newBest = false;
  navigate("intro");
}

function abortRun() {
  SESSION.run = null;
  SESSION.sector = null;
  SESSION.board = null;
  navigate("title");
}

function recordRun() {
  if (SESSION.recorded || !SESSION.run) return;
  SESSION.recorded = true;
  const run = SESSION.run;
  const key = recordKey(SESSION.mode, SESSION.asc, SESSION.seed);
  const entry = {
    score: Math.round(run.score || 0),
    sectors: run.sectorsCleared || 0,
    win: !!run.victory,
  };
  const prev = bestOf(key);
  if (!prev || entry.score > prev.score || (entry.score === prev.score && entry.sectors > prev.sectors)) {
    STORE.best[key] = entry;
    SESSION.newBest = true;
  }
  if (run.victory && SESSION.mode === "standard") STORE.standardWon = true;
  saveStore();
}

function addEscBanner(y, label = "PRESS ESC AGAIN TO ABORT RUN") {
  add([
    pos(0, 0),
    z(Z.pop + 5),
    {
      draw() {
        if (time() >= ESC.until) return;
        drawRect({ pos: vec2(450, y), width: 420, height: 30, anchor: "center", radius: 6, color: hexC(PAL.ink), opacity: 0.9 });
        drawText({ text: label, size: 18, pos: vec2(450, y), anchor: "center", color: hexC(PAL.danger) });
      },
    },
  ]);
}

function escPress() {
  if (time() < ESC.until) {
    abortRun();
    return;
  }
  ESC.until = time() + 2.5;
  sfxSoft();
}

// Bonus games: the same double-ESC rule, but it forfeits the bonus instead of the run.
function bonusEscPress(onForfeit) {
  if (time() < ESC.until) {
    onForfeit();
    return;
  }
  ESC.until = time() + 2.5;
  sfxSoft();
}

// =====================================================================
// Kaplay setup
// =====================================================================
kaplay({
  global: true,
  width: LOGIC_W,
  height: LOGIC_H,
  letterbox: true,
  canvas: document.getElementById("game-canvas"),
  background: [7, 6, 15],
  touchToMouse: true,
  debug: false,
});
buildVignette();

// ---------- title ----------
scene("title", () => {
  navBusy = false;
  ESC.until = -1;
  addSynth({ disks: 8, sun: true });
  addOverlay();

  txt("NEON RELAY", 450, 40, { size: 18, hex: PAL.magenta, stroke: 3 });
  buildLogotype(124);
  const tagline = txt("Three relays. One signal. Every wrong move costs integrity.", 450, 214, { size: 18, hex: PAL.white, stroke: 3, opacity: 0 });
  tw(0, 1, 0.8, (v) => { if (tagline.exists()) tagline.opacity = v; }, easings.linear);

  const soundItem = menuButton({
    x: 450, y: 404, w: 280, label: soundLabel(), neon: PAL.lime,
    onPick: () => {
      toggleSound();
      soundItem.lbl.text = soundLabel();
    },
  });
  const items = [
    menuButton({ x: 450, y: 296, w: 280, label: "START", neon: PAL.cyan, onPick: () => navigate("modes") }),
    menuButton({ x: 450, y: 350, w: 280, label: "CODEX", neon: PAL.violet, onPick: () => navigate("codex") }),
    soundItem,
  ];
  bindMenu(items);
  onKeyPress("m", () => {
    toggleSound();
    soundItem.lbl.text = soundLabel();
  });

  const top = bestScoreAll();
  txt(
    top > 0 ? "BEST SCORE " + fmt(top) : "NO RECORD YET",
    450, 470, { size: 16, hex: PAL.chrome, stroke: 2 }
  );
  txt("ARROWS / ENTER / CLICK     M = SOUND", 450, 490, { size: 16, hex: PAL.dim, stroke: 2 });
});

// Letter tiles fall in one by one and settle as the logotype; a light sweep follows.
function buildLogotype(cy) {
  const WORD = "HANOI//PROTOCOL";
  const tileW = 44;
  const gap = 6;
  const n = WORD.length;
  const totalW = n * tileW + (n - 1) * gap;
  const x0 = (LOGIC_W - totalW) / 2 + tileW / 2;
  const sweep = { x: -120, on: false };
  add([
    pos(0, 0),
    z(Z.ui + 1),
    {
      draw() {
        if (!sweep.on) return;
        drawRect({ pos: vec2(sweep.x, cy - 44), width: 70, height: 88, color: hexC(PAL.white), opacity: 0.12 });
      },
    },
  ]);
  for (let i = 0; i < n; i++) {
    const ch = WORD[i];
    const hex = ch === "/" ? PAL.lime : rampHex([PAL.cyan, PAL.violet, PAL.magenta], i / (n - 1));
    const tile = add([
      rect(tileW, 60, { radius: 10 }),
      pos(x0 + i * (tileW + gap), -90),
      anchor("center"),
      color(hexC(PAL.ink)),
      opacity(0.95),
      outline(4, hexC(hex)),
      z(Z.ui),
    ]);
    tile.add([
      text(ch, { size: 40 }),
      anchor("center"),
      color(hexC(hex)),
      outline(3, hexC(PAL.ink)),
      z(Z.ui + 1),
    ]);
    wait(0.12 * i, () => {
      tw(-90, cy, 0.7, (v) => { if (tile.exists()) tile.pos.y = v; }, easings.easeOutBounce, () => {
        if (tile.exists()) sparks(tile.pos.x, cy + 30, hex, 6, 90);
      });
    });
  }
  wait(0.12 * n + 0.8, () => {
    tw(-120, LOGIC_W + 120, 1.1, (v) => { sweep.x = v; sweep.on = true; }, easings.easeInOutSine);
  });
}

// ---------- mode select ----------
scene("modes", () => {
  navBusy = false;
  ESC.until = -1;
  addSynth({ disks: 6 });
  addOverlay();
  txt("SELECT PROTOCOL", 450, 44, { size: 32, hex: PAL.cyan, stroke: 4 });

  const cardW = 136;
  const cardH = 268;
  const cardY = 206;
  const gap = 10;
  const x0 = (LOGIC_W - (MODE_ORDER.length * cardW + (MODE_ORDER.length - 1) * gap)) / 2 + cardW / 2;
  const items = [];
  const bestLabels = {};

  const bestText = (id) => {
    const seedKey = id === "daily" ? todaySeed() : null;
    const e = bestOf(recordKey(id, UI.asc, seedKey));
    if (!e) return { a: "NO RECORD", b: "" };
    return { a: "BEST " + fmt(e.score), b: "SECTOR " + e.sectors + (e.win ? " WON" : "") };
  };

  MODE_ORDER.forEach((id, i) => {
    const info = MODE_INFO[id];
    const cx = x0 + i * (cardW + gap);
    const baseY = cardY;
    const body = add([
      rect(cardW, cardH, { radius: 12 }),
      pos(cx, baseY),
      anchor("center"),
      color(hexC(PAL.ink)),
      opacity(0.94),
      outline(2, hexC(info.neon)),
      area(),
      z(Z.ui),
      "menu-item",
    ]);
    body.add([text(info.name, { size: 20 }), pos(0, -cardH / 2 + 36), anchor("center"), color(hexC(info.neon)), outline(3, hexC(PAL.ink)), z(Z.ui + 1)]);
    body.add([text(info.blurb, { size: 16, width: cardW - 18, align: "center" }), pos(0, 2), anchor("center"), color(hexC(PAL.chrome)), outline(2, hexC(PAL.ink)), z(Z.ui + 1)]);
    const iconCount = { standard: 3, blitz: 3, endless: 5, daily: 4, peg4: 4, reverse: 3 }[id] || 3;
    add([
      pos(0, 0), z(Z.ui + 1),
      { draw() { drawRingRow(body.pos.x, body.pos.y - cardH / 2 + 72, iconCount, cardW - 28); } },
    ]);
    body.add([rect(cardW - 24, 1), pos(0, cardH / 2 - 70), anchor("center"), color(hexC(info.neon)), opacity(0.5), z(Z.ui + 1)]);
    const bestA = body.add([text("", { size: 18 }), pos(0, cardH / 2 - 50), anchor("center"), color(hexC(PAL.white)), outline(2, hexC(PAL.ink)), z(Z.ui + 1)]);
    const bestB = body.add([text("", { size: 16 }), pos(0, cardH / 2 - 24), anchor("center"), color(hexC(PAL.chrome)), outline(2, hexC(PAL.ink)), z(Z.ui + 1)]);
    bestLabels[id] = { bestA, bestB };
    const item = makeItem(body, {
      neon: info.neon,
      onPick: () => startRun(id, UI.asc),
      onStyle(on) {
        if (!body.exists()) return;
        tw(body.pos.y, baseY - (on ? 8 : 0), 0.14, (v) => { if (body.exists()) body.pos.y = v; }, easings.easeOutCubic);
        body.outline.width = on ? 4 : 2;
        body.color = hexC(on ? "#141233" : PAL.ink);
      },
    });
    items.push(item);
  });

  const refreshBests = () => {
    MODE_ORDER.forEach((id) => {
      const t = bestText(id);
      bestLabels[id].bestA.text = t.a;
      bestLabels[id].bestB.text = t.b;
    });
  };
  refreshBests();

  let ascItem = null;
  const ascLabel = () => "ASCENSION: " + (UI.asc ? "ON" : "OFF");
  if (STORE.standardWon) {
    ascItem = menuButton({
      x: 450, y: 428, w: 320, h: 34, label: ascLabel(), neon: PAL.amber, size: 18,
      onPick: () => {
        UI.asc = !UI.asc;
        ascItem.lbl.text = ascLabel();
        refreshBests();
        sfxClick();
      },
    });
    items.push(ascItem);
  }
  items.push(menuButton({ x: 110, y: 478, w: 150, h: 34, label: "< BACK", neon: PAL.chrome, size: 18, onPick: () => navigate("title") }));
  bindMenu(items);
  onKeyPress("escape", () => navigate("title"));
  txt("ENTER SELECTS    ESC BACK", 690, 478, { size: 16, hex: PAL.dim, stroke: 2 });
});

// ---------- codex: rings, upgrades, quests, modifiers, records. PREV and NEXT page every tab. ----------
scene("codex", () => {
  navBusy = false;
  ESC.until = -1;
  tipHide();
  addSynth({ disks: 4 });
  addOverlay();
  txt("CODEX", 450, 40, { size: 32, hex: PAL.violet, stroke: 4 });

  const PER_PAGE = 4;
  const ROW_Y = (i) => 160 + i * 74;
  const TABS = [
    { name: "RINGS", hex: PAL.cyan },
    { name: "UPGRADES", hex: PAL.amber },
    { name: "QUESTS", hex: PAL.lime },
    { name: "MODIFIERS", hex: PAL.magenta },
    { name: "RECORDS", hex: PAL.gold },
  ];
  const upgrades = HanoiCore.UPGRADES || [];
  const quests = HanoiCore.QUESTS || [];
  const modifiers = HanoiCore.MODIFIERS || [];
  const ringTypes = Object.keys(HanoiCore.RING_TYPES || {});
  const recordRows = () => {
    const seed = todaySeed();
    return [
      ["STANDARD", bestOf(recordKey("standard", false, null))],
      ["BLITZ", bestOf(recordKey("blitz", false, null))],
      ["ENDLESS", bestOf(recordKey("endless", false, null))],
      ["DAILY  " + seed, bestOf(recordKey("daily", false, seed))],
      ["QUAD RELAY", bestOf(recordKey("peg4", false, null))],
      ["REVERSE", bestOf(recordKey("reverse", false, null))],
      ["STANDARD ASCENSION", bestOf(recordKey("standard", true, null))],
    ];
  };
  const countOf = (t) => [ringTypes.length, upgrades.length, quests.length, modifiers.length, recordRows().length][t];

  let tab = 0;
  let page = 0;
  const maxPage = () => Math.max(1, Math.ceil(countOf(tab) / PER_PAGE)) - 1;

  const tabItems = TABS.map((t, i) => menuButton({
    x: 450 + (i - 2) * 166, y: 84, w: 160, h: 34, label: t.name, neon: t.hex, size: 18,
    onPick: () => { tab = i; page = 0; render(); },
  }));
  // PREV, the page count and NEXT sit in the centre; BACK stays clear of them.
  const prevItem = menuButton({
    x: 330, y: 470, w: 130, h: 34, label: "< PREV", neon: PAL.amber, size: 18,
    onPick: () => { if (page > 0) { page -= 1; render(); } },
  });
  const nextItem = menuButton({
    x: 570, y: 470, w: 130, h: 34, label: "NEXT >", neon: PAL.amber, size: 18,
    onPick: () => { if (page < maxPage()) { page += 1; render(); } },
  });
  const backItem = menuButton({ x: 110, y: 470, w: 150, h: 34, label: "< BACK", neon: PAL.chrome, size: 18, onPick: () => navigate("title") });
  const pageLbl = txt("", 450, 470, { size: 16, hex: PAL.chrome, stroke: 2 });
  bindMenu([...tabItems, prevItem, nextItem, backItem]);
  onKeyPress("escape", () => navigate("title"));

  function clearContent() {
    get("codex-content").forEach((o) => { if (o.exists()) destroy(o); });
  }

  function render() {
    tipHide();
    clearContent();
    page = clampN(page, 0, maxPage());
    tabItems.forEach((it, i) => {
      it.lbl.text = (i === tab ? "> " : "") + TABS[i].name + (i === tab ? " <" : "");
    });
    setItemEnabled(prevItem, page > 0, PAL.amber);
    setItemEnabled(nextItem, page < maxPage(), PAL.amber);
    pageLbl.text = "PAGE " + (page + 1) + " / " + (maxPage() + 1);

    const T = { tag: "codex-content" };
    const from = page * PER_PAGE;
    if (tab === 0) {
      ringTypes.slice(from, from + PER_PAGE).forEach((k, i) => {
        const def = HanoiCore.RING_TYPES[k];
        const y = ROW_Y(i);
        const hex = k === "gilded" ? PAL.gold : k === "aegis" ? PAL.amber : k === "heavy" ? PAL.chrome : k === "ghost" ? PAL.white : PAL.cyan;
        add([
          pos(0, 0), z(Z.ui), "codex-content",
          { draw() { drawRingAt(170, y + 14, 3, 3, k, { w: 118, h: 22 }); } },
        ]);
        txt(String(def.name || k).toUpperCase(), 268, y, { anchor: "left", align: "left", size: 20, hex, stroke: 3, ...T });
        txt(def.desc || "", 268, y + 22, { anchor: "topleft", align: "left", size: 16, width: 580, hex: PAL.chrome, stroke: 2, ...T });
      });
    } else if (tab === 1) {
      const seen = upgrades.filter((u) => STORE.seen[u.id]).length;
      txt("SEEN " + seen + " / " + upgrades.length, 884, 136, { anchor: "right", align: "right", size: 16, hex: PAL.chrome, stroke: 2, ...T });
      upgrades.slice(from, from + PER_PAGE).forEach((u, i) => {
        const y = ROW_Y(i);
        const known = !!STORE.seen[u.id];
        const rar = RARITY[u.rarity] || RARITY.common;
        const pillX = 112;
        add([
          pos(pillX, y), anchor("center"), z(Z.ui), "codex-content",
          rect(110, 20, { radius: 10 }), color(hexC(rar.hex)),
        ]);
        txt(rar.label, pillX, y, { size: 16, hex: PAL.ink, stroke: 0, z: Z.ui + 1, ...T });
        txt(known ? u.name : "???", 200, y - 12, { anchor: "left", align: "left", size: 18, hex: known ? rar.hex : PAL.chrome, stroke: 2, ...T });
        txt(known ? (u.desc || "") : "Unseen protocol. Take it to reveal.", 200, y + 12, { anchor: "left", align: "left", size: 16, width: 660, hex: PAL.chrome, stroke: 2, ...T });
      });
    } else if (tab === 2) {
      quests.slice(from, from + PER_PAGE).forEach((q, i) => {
        const y = ROW_Y(i);
        const hex = PAL.lime;
        txt(String(q.name || q.id).toUpperCase(), 130, y - 12, { anchor: "left", align: "left", size: 20, hex, stroke: 3, ...T });
        txt(q.desc || "", 130, y + 14, { anchor: "left", align: "left", size: 16, width: 600, hex: PAL.chrome, stroke: 2, ...T });
        txt("BASE +" + (q.reward || 0) + " BITS", 870, y - 12, { anchor: "right", align: "right", size: 16, hex: PAL.gold, stroke: 2, ...T });
        tipZone(110, y - 32, 760, 62, () => questTip(q, hex), T);
      });
    } else if (tab === 3) {
      modifiers.slice(from, from + PER_PAGE).forEach((m, i) => {
        const y = ROW_Y(i);
        const hex = MODIFIER_HEX[m.id] || PAL.cyan;
        add([
          pos(112, y), anchor("center"), z(Z.ui), "codex-content",
          rect(120, 20, { radius: 10 }), color(hexC(hex)),
        ]);
        txt("SECTOR " + (m.minSector || 1) + "+", 112, y, { size: 16, hex: PAL.ink, stroke: 0, z: Z.ui + 1, ...T });
        txt(String(m.name || m.id).toUpperCase(), 200, y - 12, { anchor: "left", align: "left", size: 20, hex, stroke: 3, ...T });
        txt(m.desc || "", 200, y + 14, { anchor: "left", align: "left", size: 16, width: 660, hex: PAL.chrome, stroke: 2, ...T });
        tipZone(110, y - 32, 760, 62, () => modTip(m.id), T);
      });
    } else {
      recordRows().slice(from, from + PER_PAGE).forEach(([name, e], i) => {
        const y = ROW_Y(i);
        txt(name, 130, y, { anchor: "left", align: "left", size: 20, hex: PAL.lime, stroke: 2, ...T });
        const val = e ? fmt(e.score) + "   SECTOR " + e.sectors + (e.win ? "   CLEARED" : "") : "NO RECORD";
        txt(val, 884, y, { anchor: "right", align: "right", size: 18, hex: e ? PAL.white : PAL.dim, stroke: 2, ...T });
      });
      txt("Records are kept on this device only.", 450, 440, { size: 16, hex: PAL.dim, stroke: 2, ...T });
    }
  }
  render();
});

// ---------- sector intro ----------
scene("intro", () => {
  navBusy = false;
  ESC.until = -1;
  tipHide();
  const run = SESSION.run;
  if (!run) { go("title"); return; }
  const sector = HanoiCore.sectorConfig(run);
  if (!sector) {
    // Past the last sector (or the run is over): nothing left to play.
    navigate("end", { victory: !!run.victory });
    return;
  }
  SESSION.sector = sector;
  const boss = !!sector.isBoss;
  const accent = boss ? PAL.magenta : PAL.cyan;
  const towers = sector.towerCount || 3;

  addDotGrid(accent);
  addOverlay();
  if (boss) {
    drawHazardBand(0, 0, LOGIC_W, 10, accent);
    drawHazardBand(0, LOGIC_H - 10, LOGIC_W, 10, accent);
  }

  const header = txt("SECTOR " + pad2(sector.no), 450, 44, { size: 46, hex: accent, stroke: 5, opacity: 0 });
  const sub = boss
    ? txt("BOSS // " + String(sector.boss.name || "").toUpperCase() + "   " + (sector.boss.rule || ""), 450, 82, { size: 16, hex: PAL.white, stroke: 2, width: 820, opacity: 0 })
    : txt("CLEAR THE TOWER. KEEP YOUR INTEGRITY.", 450, 82, { size: 16, hex: PAL.chrome, stroke: 2, opacity: 0 });
  tw(0, 1, 0.4, (v) => { if (header.exists()) header.opacity = v; sub.opacity = v; }, easings.easeOutCubic);
  if (sector.reversed) drawReverseBanner(104);

  // LEFT: the numbers, then the start layout with the target node marked
  const leftX = 60;
  const rows = [["RINGS", String(sector.rings.length)], ["TARGET", "NODE " + NODE_LETTERS[sector.target]], ["PAR", (sector.par ?? "?") + " MOVES"]];
  if (towers !== 3) rows.push(["RELAYS", String(towers)]);
  if (sector.timeLimit) rows.push(["TIME", Math.round(sector.timeLimit) + " S"]);
  rows.forEach(([k, v], i) => {
    const y = 128 + i * 30;
    txt(k, leftX, y, { anchor: "left", align: "left", size: 18, hex: PAL.dim, stroke: 2 });
    txt(v, leftX + 130, y, { anchor: "left", align: "left", size: 22, hex: PAL.white, stroke: 3 });
  });
  addSectorPreview(sector, leftX, 282, 370, 116);

  // RIGHT: quest card. Hovering it (or a boss quest row) shows that quest's tooltip.
  const qx = 470;
  const quests = [sector.quest, sector.bossQuest].filter(Boolean);
  add([rect(370, 136, { radius: 12 }), pos(qx, 128), anchor("topleft"), color(hexC(PAL.ink)), opacity(0.92), outline(2, hexC(accent)), z(Z.ui)]);
  txt("QUEST", qx + 22, 146, { anchor: "left", align: "left", size: 18, hex: PAL.dim, stroke: 2 });
  const rewardSum = quests.reduce((a, q) => a + (q.reward || 0), 0);
  if (quests.length <= 1) {
    const quest = quests[0] || { id: "", name: "Clear the tower", desc: "", reward: 0 };
    txt(quest.name, qx + 22, 170, { anchor: "left", align: "left", size: 24, hex: accent, stroke: 3, width: 330 });
    txt(quest.desc || "", qx + 22, 198, { anchor: "topleft", align: "left", size: 16, width: 330, hex: PAL.white, stroke: 2 });
    txt("REWARD  +" + rewardSum + " BITS", qx + 22, 240, { anchor: "left", align: "left", size: 18, hex: PAL.lime, stroke: 2 });
    tipZone(qx, 128, 370, 136, () => questTip(quest, accent), {});
  } else {
    quests.forEach((q, i) => {
      const y = 172 + i * 30;
      txt(q.name, qx + 22, y, { anchor: "left", align: "left", size: 20, hex: accent, stroke: 3, width: 260 });
      txt("+" + q.reward, qx + 348, y, { anchor: "right", align: "right", size: 18, hex: PAL.lime, stroke: 2 });
      tipZone(qx + 12, y - 14, 346, 28, () => questTip(q, accent), {});
    });
    txt("BOSS REWARD  +" + rewardSum + " BITS", qx + 22, 240, { anchor: "left", align: "left", size: 18, hex: PAL.lime, stroke: 2 });
  }
  if ((run.upgrades && run.upgrades.forecast) > 0) {
    txt("FORECAST MATCHED", qx + 348, 146, { anchor: "right", align: "right", size: 16, hex: PAL.amber, stroke: 2 });
  }

  // RIGHT: modifier chips (hover for the tooltip) and the special ring legend
  const modY = 286;
  const mods = sector.modifiers || [];
  mods.forEach((id, i) => {
    const def = (HanoiCore.MODIFIERS || []).find((m) => m.id === id);
    const hex = MODIFIER_HEX[id] || PAL.cyan;
    const chipW = 150;
    const cx = qx + chipW / 2 + i * (chipW + 12);
    add([rect(chipW, 24, { radius: 12 }), pos(cx, modY), anchor("center"), color(hexC(PAL.ink)), outline(2, hexC(hex)), z(Z.ui)]);
    txt((def ? def.name : titleOf(id)).toUpperCase(), cx, modY, { size: 16, hex, stroke: 2 });
    tipZone(cx, modY, chipW, 24, () => modTip(id), { anchor: "center" });
  });
  if (!mods.length) txt("NO MODIFIERS", qx, modY, { anchor: "left", align: "left", size: 16, hex: PAL.dim, stroke: 2 });
  if (sector.fog) txt("FOG: BURIED RINGS HIDE THEIR SIZE", qx, modY + 26, { anchor: "left", align: "left", size: 16, hex: PAL.chrome, stroke: 2 });

  const legend = [];
  ["gilded", "ghost", "heavy", "aegis"].forEach((k) => {
    const count = sector[k + "Count"] || 0;
    if (count > 0) legend.push([k, count]);
  });
  if (!legend.length) txt("STANDARD RINGS ONLY", qx, 336, { anchor: "left", align: "left", size: 16, hex: PAL.dim, stroke: 2 });
  legend.forEach(([k, count], i) => {
    const y = 338 + i * 22;
    const hex = k === "gilded" ? PAL.gold : k === "aegis" ? PAL.amber : k === "heavy" ? PAL.chrome : PAL.white;
    add([pos(0, 0), z(Z.ui), { draw() { drawRingAt(qx + 30, y, 4, 9, k, { w: 58, h: 16, chip: false }); } }]);
    const name = (HanoiCore.RING_TYPES[k] && HanoiCore.RING_TYPES[k].name) || titleOf(k);
    txt(name.toUpperCase() + "  x" + count, qx + 66, y, { anchor: "left", align: "left", size: 18, hex, stroke: 2 });
  });

  const engage = menuButton({
    x: 450, y: 444, w: 280, h: 42, label: boss ? "ENGAGE BOSS" : "ENGAGE", neon: accent, size: 22,
    onPick: () => { sfxClick(); navigate("play"); },
  });
  bindMenu([engage]);
  onKeyPress("escape", escPress);
  addEscBanner(112);
  txt("ENTER ENGAGE    ESC TWICE TO ABORT", 450, 480, { size: 16, hex: PAL.dim, stroke: 2 });
});

// REVERSE banner (DESIGN 13.1): shown on the intro of every reversed sector.
function drawReverseBanner(y) {
  add([
    pos(0, 0), z(Z.ui),
    {
      draw() {
        drawRect({
          pos: vec2(450, y), width: 820, height: 24, anchor: "center", radius: 8,
          color: hexC(PAL.ink), opacity: 0.92, outline: { width: 2, color: hexC(PAL.gold) },
        });
        drawText({
          text: "REVERSE PROTOCOL  //  RINGS MAY ONLY REST ON SMALLER RINGS",
          size: 16, pos: vec2(450, y), anchor: "center", color: hexC(PAL.gold),
        });
      },
    },
  ]);
}

// Mini view of the start layout: one tube per relay, rings at their real sizes, the target tagged.
function addSectorPreview(sector, x0, top, w, h) {
  const bottom = top + h;
  const towers = sector.towerCount || sector.start.length || 3;
  const spacing = w / towers;
  const plateW = Math.min(96, spacing - 12);
  const n = sector.rings.length;
  add([
    pos(0, 0),
    z(Z.ui),
    {
      draw() {
        for (let t = 0; t < towers; t++) {
          const cx = x0 + spacing * (t + 0.5);
          const isTarget = t === sector.target;
          const hex = isTarget ? PAL.magenta : PAL.cyan;
          drawRect({ pos: vec2(cx, (top + bottom - 22) / 2), width: 4, height: bottom - top - 22, anchor: "center", color: hexC(hex), opacity: isTarget ? 0.9 : 0.5 });
          drawRect({ pos: vec2(cx, bottom - 8), width: plateW, height: 8, anchor: "center", radius: 3, color: hexC(PAL.plate), opacity: 1, outline: { width: 2, color: hexC(hex) } });
          drawText({ text: "NODE " + NODE_LETTERS[t], size: 16, pos: vec2(cx, bottom + 10), anchor: "center", color: hexC(isTarget ? PAL.magenta : PAL.chrome) });
          if (isTarget) drawPill(cx, top - 4, "TARGET", PAL.magenta, towers > 3 ? 74 : 92);
          const tower = sector.start[t] || [];
          tower.forEach((r, i) => {
            drawRingAt(cx, bottom - 18 - i * 12, r.size, n, r.type, { w: ringWidth(r.size) * 0.55, h: 10, chip: false });
          });
        }
      },
    },
  ]);
}

function drawHazardBand(x, y, w, h, hex) {
  add([
    pos(0, 0), z(Z.ui),
    { draw() { drawHazard(x, y, w, h, hex, PAL.ink, 0.7); } },
  ]);
}

// ---------- play ----------
scene("play", () => {
  navBusy = false;
  ESC.until = -1;
  tipHide();
  const run = SESSION.run;
  const sector = SESSION.sector;
  if (!run || !sector) { go("title"); return; }

  const board = new HanoiCore.Board(run, sector);
  SESSION.board = board;
  SESSION.t0 = time();
  const nowT = () => time() - SESSION.t0;
  const towers = sector.towerCount || board.towers.length || 3;
  const target = clampN(sector.target | 0, 0, towers - 1);
  const RELAY_X = Array.from({ length: towers }, (_, i) => relayX(i, towers));
  const plateW = Math.min(176, LOGIC_W / (towers + 1) - 8);
  const boss = !!sector.isBoss;
  const total = sector.rings.length;
  const timed = sector.timeLimit != null;

  const ps = {
    board, sector, run, target, total,
    sourceIdx: board.towers.reduce((best, tw2, i) => (tw2.length > board.towers[best].length ? i : best), 0),
    busy: false, done: false, sel: -1, hover: -1,
    views: new Map(), hint: null, banner: null,
    pipFlash: 0, lastInt: run.integrity, combo: 1, timeoutCool: 0, timeLeft: null,
  };
  PLAY = ps;

  addDotGrid(boss ? PAL.magenta : PAL.cyan);
  addOverlay();

  const slotOf = (t, i) => ({ x: RELAY_X[t], y: BASE_Y - 4 - RING_H / 2 - i * STACK_STEP });
  const topOf = (t) => board.towers[t].length - 1;

  function syncViews() {
    board.towers.forEach((tower, ti) => {
      tower.forEach((r, i) => {
        let v = ps.views.get(r.id);
        if (!v) {
          const s = slotOf(ti, i);
          v = { id: r.id, size: r.size, type: r.type, t: ti, i, x: s.x, y: s.y, anim: false };
          ps.views.set(r.id, v);
        }
        v.t = ti;
        v.i = i;
        v.size = r.size;
        v.type = r.type;
      });
    });
  }
  function snapLocs() {
    const m = new Map();
    board.towers.forEach((tower, ti) => tower.forEach((r, i) => m.set(r.id, { t: ti, i })));
    return m;
  }
  syncViews();

  // Arc a ring from where it is now to its new slot: lift, travel, drop.
  function animateRing(id, onDone) {
    const v = ps.views.get(id);
    if (!v) {
      if (onDone) onDone();
      return;
    }
    const dest = slotOf(v.t, v.i);
    const sx = v.x;
    const sy = v.y;
    v.anim = true;
    const arc = 34 + Math.abs(dest.x - sx) * 0.16;
    tw(0, 1, MOVE_DUR, (p) => {
      const e = p * p * (3 - 2 * p);
      v.x = sx + (dest.x - sx) * e;
      v.y = sy + (dest.y - sy) * e - Math.sin(Math.PI * p) * arc;
    }, easings.linear, () => {
      v.anim = false;
      v.x = dest.x;
      v.y = dest.y;
      if (onDone) onDone();
    });
  }

  // ----- relay hit areas (pointer) -----
  for (let i = 0; i < towers; i++) {
    const hit = add([
      rect(120, BASE_Y - RELAY_TOP + 60),
      pos(RELAY_X[i], (RELAY_TOP - 20 + BASE_Y + 40) / 2),
      anchor("center"),
      opacity(0),
      area(),
      z(Z.relay),
      "relay-hit",
    ]);
    hit.onClick(() => pickRelay(i));
    hit.onHover(() => { ps.hover = i; });
    hit.onHoverEnd(() => { if (ps.hover === i) ps.hover = -1; });
  }

  // ----- actions -----
  function pickRelay(i) {
    if (ps.busy || ps.done || i < 0 || i >= towers) return;
    if (ps.sel < 0) {
      if (board.towers[i].length === 0) {
        sfxSoft();
        pop("EMPTY", RELAY_X[i], RELAY_TOP + 40, PAL.chrome, 16);
        return;
      }
      ps.sel = i;
      sfxSelect();
      return;
    }
    if (ps.sel === i) {
      ps.sel = -1;
      sfxSoft();
      return;
    }
    const from = ps.sel;
    ps.sel = -1;
    tryPlay(from, i);
  }

  function tryPlay(from, to) {
    const before = run.integrity;
    const res = board.tryMove(from, to, nowT());
    if (!res || !res.ok) {
      onInvalid(res || { events: ["invalid"], reason: "size" }, to, before);
      return;
    }
    const ring = board.towers[to][board.towers[to].length - 1];
    ps.busy = true;
    syncViews();
    animateRing(ring.id, () => {
      ps.busy = false;
      afterValid(res, to);
    });
  }

  function afterValid(res, to) {
    handleEvents(res, to);
    const ev = res.events || [];
    if (res.solved || ev.indexOf("solved") >= 0) {
      onSolved();
      return;
    }
    if (res.failed || run.over) onFailed();
  }

  function onInvalid(res, to, before) {
    const ev = res.events || [];
    const forgiven = ev.indexOf("aegis-forgive") >= 0;
    const rx = RELAY_X[to];
    const reason = res.reason;
    if (!forgiven) {
      sfxInvalid();
      GLITCH.level = 1;
      shake(7);
    } else {
      sfxSoft();
      GLITCH.level = 0.5;
      pop("FORGIVEN", rx, RELAY_TOP - 58, PAL.lime, 20);
    }
    const reasonText = reason === "size" ? "TOO LARGE" : reason === "same" ? "SAME RELAY" : reason === "empty" ? "EMPTY" : reason === "solved" ? "SOLVED" : "REJECTED";
    if (!forgiven) pop(reasonText, rx, RELAY_TOP - 40, PAL.danger, 20);
    const lost = before - run.integrity;
    if (lost > 0) {
      ps.pipFlash = 1;
      pop("-" + lost + " INTEGRITY", rx, RELAY_TOP - 74, PAL.danger, 18);
    }
    if (ev.indexOf("combo-break") >= 0) {
      sfxComboBreak();
      pop("CHAIN BROKEN", rx, RELAY_TOP + 100, PAL.danger, 18);
    }
    ps.combo = 1;
    ps.sel = -1;
    if (ev.indexOf("revive") >= 0) revivePop();
    if (run.over) onFailed();
  }

  function revivePop() {
    sfxRevive();
    screenFlash(PAL.lime, 0.4, 0.6);
    pop("PHOENIX REVIVE", 450, 300, PAL.lime, 28);
  }

  function handleEvents(res, to) {
    const ev = res.events || [];
    const has = (k) => ev.indexOf(k) >= 0;
    const rx = RELAY_X[to];
    let k = 0;
    const slotY = () => RELAY_TOP - 42 - (k++) * 24;
    if (has("move")) sfxMove();
    if (has("land-target")) {
      sfxLand();
      sparks(rx, RELAY_TOP + 40, PAL.lime, 14, 160);
    }
    if (has("gilded")) {
      sfxGilded();
      sparks(rx, RELAY_TOP + 40, PAL.gold, 18, 200);
      pop("GILDED", rx, slotY(), PAL.gold, 22);
    }
    if (has("ghost")) pop("GHOST", rx, slotY(), PAL.cyan, 18);
    if (has("heavy")) {
      sfxHeavy();
      pop("HEAVY x2", rx, slotY(), PAL.amber, 18);
    }
    if (res.bitsGained > 0) pop("+" + res.bitsGained + " BITS", rx, slotY(), PAL.gold, 18);
    if (has("aegis-forgive")) pop("FORGIVEN", rx, slotY(), PAL.lime, 18);
    if (has("combo-break")) {
      sfxComboBreak();
      pop("CHAIN BROKEN", rx, slotY(), PAL.danger, 18);
    }
    if (typeof res.comboMult === "number") {
      if (res.comboMult >= 1.4 && res.comboMult > ps.combo + 0.01) {
        pop("CHAIN x" + res.comboMult.toFixed(1), rx, slotY(), PAL.cyan, 18);
      }
      ps.combo = res.comboMult;
    }
    if (has("revive")) revivePop();
    if (has("dead")) {
      screenFlash(PAL.danger, 0.45, 0.7);
      shake(16);
      GLITCH.level = 1;
    }
  }

  function doUndo() {
    if (ps.busy || ps.done) return;
    const before = snapLocs();
    const res = board.undo();
    if (!res || !res.ok) {
      sfxSoft();
      pop(res && res.reason === "nothing" ? "NOTHING TO UNDO" : "NO UNDO LEFT", 450, 300, PAL.chrome, 20);
      return;
    }
    const after = snapLocs();
    const moved = [];
    after.forEach((loc, id) => {
      const old = before.get(id);
      if (!old || old.t !== loc.t || old.i !== loc.i) moved.push(id);
    });
    if (!moved.length) {
      sfxSoft();
      pop("NO UNDO LEFT", 450, 300, PAL.chrome, 20);
      return;
    }
    ps.sel = -1;
    sfxSelect();
    syncViews();
    if (moved.length === 1) {
      ps.busy = true;
      animateRing(moved[0], () => { ps.busy = false; });
    }
  }

  function doHint() {
    if (ps.busy || ps.done) return;
    const h = board.useHint();
    if (!h) {
      sfxSoft();
      pop("NO HINT CHARGES", 450, 300, PAL.chrome, 20);
      return;
    }
    ps.hint = { from: h.from, to: h.to, until: time() + 3 };
    sfxHint();
  }

  function checkTimer() {
    if (ps.busy || ps.done || time() < ps.timeoutCool) return;
    const left = board.timeLeft(nowT());
    ps.timeLeft = left;
    if (left !== null && left !== undefined && left <= 0) doTimeout();
  }

  function doTimeout() {
    const before = run.integrity;
    const res = board.timeout(nowT());
    ps.sel = -1;
    ps.timeoutCool = time() + 0.6;
    syncViews();
    sfxInvalid();
    GLITCH.level = 0.9;
    shake(10);
    pop("TIME OUT  -1 INTEGRITY", 450, 300, PAL.danger, 24);
    if (run.integrity < before) ps.pipFlash = 1;
    if (((res && res.events) || []).indexOf("revive") >= 0) revivePop();
    if (run.over) onFailed();
  }

  function onSolved() {
    if (ps.done) return;
    ps.done = true;
    ps.sel = -1;
    const fin = HanoiCore.finishSector(run, board, nowT());
    ps.banner = { text: "SIGNAL LOCKED", hex: PAL.lime, until: time() + 1.3 };
    shockwave(RELAY_X[target], BASE_Y - 60, PAL.lime, 420, 0.9);
    for (let i = 0; i < 3; i++) sparks(RELAY_X[target], RELAY_TOP + 60, PAL.lime, 12, 220);
    wait(1.25, () => navigate("clear", { fin, victory: !!fin.victory }));
  }

  function onFailed() {
    if (ps.done) return;
    ps.done = true;
    ps.sel = -1;
    screenFlash(PAL.danger, 0.5, 0.9);
    shake(18);
    GLITCH.level = 1;
    ps.banner = { text: "INTEGRITY DEPLETED", hex: PAL.danger, until: time() + 2 };
    wait(1.9, () => navigate("end", { victory: false }));
  }

  // ----- drawing -----
  function drawRelay(i) {
    const x = RELAY_X[i];
    const isTarget = i === target;
    const isSource = i === ps.sourceIdx;
    const isHover = ps.hover === i;
    const isSel = ps.sel === i;
    const hinted = ps.hint && (ps.hint.from === i || ps.hint.to === i) && time() < ps.hint.until;
    const pulse = 0.5 + 0.5 * Math.sin(time() * 3.2);
    let hex = PAL.cyan;
    if (isTarget) hex = PAL.magenta;
    if (isSel) hex = PAL.lime;
    if (hinted) hex = PAL.amber;
    const glow = (isHover ? 1.7 : 1) * (isTarget ? 0.8 + 0.4 * pulse : 1);
    drawRelayTube(x, hex, {
      glow,
      plateW,
      label: "NODE " + NODE_LETTERS[i],
      labelHex: isTarget ? PAL.magenta : PAL.chrome,
      halo: isTarget ? { r: 58 + pulse * 6, op: 0.03 + 0.03 * pulse, hex: PAL.magenta } : null,
    });
    const tagW = towers > 3 ? 78 : 92;
    if (isTarget) drawPill(x, RELAY_TOP - 18, "TARGET", PAL.magenta, tagW);
    else if (isSource) drawPill(x, RELAY_TOP - 18, "SOURCE", PAL.cyan, tagW);
    if (sector.reversed) drawPill(x, RELAY_TOP + 26, "REVERSE", PAL.gold, tagW);
  }

  function drawHintArrow(from, to) {
    const y = RELAY_TOP - 40;
    const x1 = RELAY_X[from];
    const x2 = RELAY_X[to];
    const a = 0.55 + 0.35 * Math.sin(time() * 6);
    drawLine({ p1: vec2(x1, y), p2: vec2(x2, y), width: 3, color: hexC(PAL.amber), opacity: a });
    const dir = Math.sign(x2 - x1) || 1;
    drawPolygon({
      pts: [vec2(x2, y), vec2(x2 - dir * 12, y - 7), vec2(x2 - dir * 12, y + 7)],
      color: hexC(PAL.amber), opacity: a,
    });
    drawPill((x1 + x2) / 2, y - 16, "HINT", PAL.amber, 70);
  }

  add([
    pos(0, 0),
    z(Z.board),
    {
      draw() {
        for (let i = 0; i < towers; i++) drawRelay(i);
        if (ps.hint && time() < ps.hint.until) drawHintArrow(ps.hint.from, ps.hint.to);
        for (const v of ps.views.values()) {
          const isTop = v.i === topOf(v.t);
          if (sector.fog && !isTop) {
            // Fog (DESIGN 13.4): a buried ring is as wide as its tower's top ring and shows no number.
            const topRing = board.towers[v.t][topOf(v.t)];
            drawRingAt(v.x, v.y, v.size, total, v.type, { fog: true, w: topRing ? ringWidth(topRing.size) : undefined });
          } else {
            drawRingAt(v.x, v.y, v.size, total, v.type);
          }
        }
      },
    },
  ]);

  // ----- HUD (fixed to the screen) -----
  add([
    pos(0, 0),
    z(Z.hud),
    fixed(),
    {
      draw() {
        drawRect({ pos: vec2(0, 0), width: LOGIC_W, height: HUD_BAND, color: hexC(PAL.ink), opacity: 0.86 });
        drawRect({ pos: vec2(0, HUD_BAND), width: LOGIC_W, height: 1, color: hexC(boss ? PAL.magenta : PAL.cyan), opacity: 0.6 });

        // row 1
        drawText({
          text: "SECTOR " + pad2(sector.no), size: 20, pos: vec2(16, 8), anchor: "topleft",
          color: hexC(boss ? PAL.magenta : PAL.cyan), outline: { width: 3, color: hexC(PAL.ink) },
        });
        if (boss && sector.boss) {
          drawText({
            text: String(sector.boss.name || "").toUpperCase(), size: 16, pos: vec2(132, 12), anchor: "topleft",
            color: hexC(PAL.magenta), outline: { width: 2, color: hexC(PAL.ink) },
          });
        }
        if (timed) {
          const left = ps.timeLeft ?? sector.timeLimit;
          const warn = left < 10;
          const flash = warn && Math.sin(time() * 10) > 0;
          drawText({
            text: "TIME " + Math.max(0, left).toFixed(1), size: 22, pos: vec2(450, 8), anchor: "top",
            color: hexC(warn ? (flash ? PAL.white : PAL.danger) : PAL.amber), outline: { width: 3, color: hexC(PAL.ink) },
          });
        }
        drawText({
          text: "BITS " + fmt(run.bits) + "    SCORE " + fmt(run.score), size: 18, pos: vec2(884, 9), anchor: "topright",
          color: hexC(PAL.gold), outline: { width: 3, color: hexC(PAL.ink) },
        });

        // row 2: integrity pips, chain meter, moves
        const pipY = 40;
        drawText({ text: "INTEGRITY", size: 16, pos: vec2(16, pipY - 9), anchor: "topleft", color: hexC(PAL.chrome) });
        const maxI = Math.max(run.maxIntegrity || 1, run.integrity || 0);
        for (let p = 0; p < maxI; p++) {
          const on = p < run.integrity;
          const px = 118 + p * 20;
          const flashing = ps.pipFlash > 0 && p === run.integrity;
          drawRect({
            pos: vec2(px, pipY), width: 14, height: 14, anchor: "center", radius: 3,
            color: hexC(on ? (flashing ? PAL.white : PAL.lime) : PAL.steel), opacity: 1,
          });
        }
        const mult = ps.combo || 1;
        const frac = clampN((mult - 1) / 1.0, 0, 1);
        drawText({
          text: "CHAIN x" + mult.toFixed(1), size: 16, pos: vec2(450, 34), anchor: "top",
          color: hexC(frac > 0.6 ? PAL.cyan : PAL.chrome), outline: { width: 2, color: hexC(PAL.ink) },
        });
        drawRect({ pos: vec2(360, 52), width: 180, height: 6, radius: 3, color: hexC(PAL.steel), opacity: 1 });
        if (frac > 0) drawRect({ pos: vec2(360, 52), width: 180 * frac, height: 6, radius: 3, color: hexC(PAL.cyan), opacity: 1 });
        const mv = board.stats ? board.stats.validMoves || 0 : 0;
        drawText({
          text: "MOVES " + mv + "   PAR " + sector.par, size: 16, pos: vec2(884, 36), anchor: "topright",
          color: hexC(PAL.chrome), outline: { width: 2, color: hexC(PAL.ink) },
        });

        // bottom strip: quest status (one per quest; bosses carry two) and controls
        const questList = [sector.quest, sector.bossQuest].filter(Boolean);
        const parts = questList.map((q) => {
          let done = null;
          try {
            const def = (HanoiCore.QUESTS || []).find((d) => d.id === q.id);
            if (def) done = !!def.check(board.stats, sector, run);
          } catch (e) {
            done = null;
          }
          // Kaplay reads square brackets as style tags, so the status uses plain words.
          return q.name + (done === null ? "" : done ? " - DONE" : " - OPEN");
        });
        const allDone = questList.length > 0 && questList.every((q, i) => parts[i].endsWith("DONE"));
        drawText({
          text: "QUEST  " + parts.join("   /   "), size: 16, pos: vec2(16, LOGIC_H - 22), anchor: "topleft",
          color: hexC(allDone ? PAL.lime : PAL.white), outline: { width: 2, color: hexC(PAL.ink) },
        });
        drawText({
          text: (towers > 3 ? "1 2 3 4" : "1 2 3") + " RELAY   U UNDO x" + (run.undoCharges || 0) + "   H HINT x" + (run.hintsLeft || 0) + "   ESC ABORT",
          size: 16, pos: vec2(884, LOGIC_H - 22), anchor: "topright", color: hexC(PAL.chrome), outline: { width: 2, color: hexC(PAL.ink) },
        });

        // banners
        if (ps.banner && time() < ps.banner.until) {
          drawRect({ pos: vec2(450, 104), width: 360, height: 32, anchor: "center", radius: 8, color: hexC(PAL.ink), opacity: 0.92 });
          drawText({ text: ps.banner.text, size: 22, pos: vec2(450, 104), anchor: "center", color: hexC(ps.banner.hex), outline: { width: 3, color: hexC(PAL.ink) } });
        }
        if (time() < ESC.until) {
          drawRect({ pos: vec2(450, 104), width: 420, height: 32, anchor: "center", radius: 8, color: hexC(PAL.ink), opacity: 0.92 });
          drawText({ text: "PRESS ESC AGAIN TO ABORT RUN", size: 18, pos: vec2(450, 104), anchor: "center", color: hexC(PAL.danger) });
        }
      },
      update() {
        ps.pipFlash = Math.max(0, ps.pipFlash - dt() * 2);
        const k = Math.min(1, dt() * 14);
        for (const v of ps.views.values()) {
          if (v.anim) continue;
          const s = slotOf(v.t, v.i);
          const lift = ps.sel === v.t && v.i === topOf(v.t) ? LIFT : 0;
          v.x += (s.x - v.x) * k;
          v.y += (s.y - lift - v.y) * k;
        }
        if (ps.hint && time() > ps.hint.until) ps.hint = null;
        if (timed) checkTimer();
      },
    },
  ]);

  // ----- in-play modifier chips (fixed, bottom left). Hovering one shows its tooltip. -----
  (sector.modifiers || []).forEach((id, k) => {
    const hex = MODIFIER_HEX[id] || PAL.cyan;
    const def = (HanoiCore.MODIFIERS || []).find((m) => m.id === id);
    const cx = 92 + k * 160;
    const cy = 456;
    add([
      rect(150, 20, { radius: 10 }), pos(cx, cy), anchor("center"), fixed(),
      color(hexC(PAL.ink)), opacity(0.92), outline(2, hexC(hex)), z(Z.hud),
    ]);
    txt((def ? def.name : titleOf(id)).toUpperCase(), cx, cy, { size: 16, hex, stroke: 2, z: Z.hud + 1, fixed: true });
    tipZone(cx, cy, 150, 22, () => modTip(id), { anchor: "center", fixed: true });
  });

  // ----- keys -----
  onKeyPress("1", () => pickRelay(0));
  onKeyPress("2", () => pickRelay(1));
  onKeyPress("3", () => pickRelay(2));
  onKeyPress("4", () => pickRelay(3));
  onKeyPress("u", doUndo);
  onKeyPress("h", doHint);
  onKeyPress("escape", () => {
    if (ps.done) return;
    escPress();
  });
});

// ---------- shared drawing: relay tube and ball ----------
// One relay in NEON RELAY style: glow halo, dark tube, neon core, cap and base plate.
function drawRelayTube(x, hex, o = {}) {
  const glow = o.glow ?? 1;
  const h = BASE_Y - RELAY_TOP;
  const cy = RELAY_TOP + h / 2;
  [[54, 0.04], [34, 0.06], [20, 0.09]].forEach(([w, a]) => {
    drawRect({ pos: vec2(x, cy), width: w, height: h + 6, anchor: "center", radius: w / 2, color: hexC(hex), opacity: a * glow });
  });
  drawRect({ pos: vec2(x, cy), width: 12, height: h, anchor: "center", radius: 6, color: hexC(PAL.tube), opacity: 1 });
  drawRect({ pos: vec2(x, cy), width: 3, height: h - 6, anchor: "center", radius: 2, color: hexC(hex), opacity: 0.95 });
  drawCircle({ pos: vec2(x, RELAY_TOP - 3), radius: 6, color: hexC(hex), opacity: 0.6 * glow });
  if (o.halo) drawCircle({ pos: vec2(x, BASE_Y + 7), radius: o.halo.r, color: hexC(o.halo.hex), opacity: o.halo.op });
  drawRect({ pos: vec2(x, BASE_Y + 7), width: o.plateW ?? 176, height: 14, anchor: "center", radius: 4, color: hexC(PAL.plate), opacity: 1, outline: { width: 2, color: hexC(hex) } });
  drawText({ text: o.label || "", size: 16, pos: vec2(x, BASE_Y + 28), anchor: "center", color: hexC(o.labelHex ?? PAL.chrome) });
}

// A ball in a Ball Sort tube: dark rim, coloured body, small glint.
function drawBall(x, y, hex, op = 1) {
  drawCircle({ pos: vec2(x, y), radius: 21, color: hexC(PAL.ink), opacity: 0.55 * op });
  drawCircle({ pos: vec2(x, y), radius: 19, color: hexC(hex), opacity: op });
  drawCircle({ pos: vec2(x - 6, y - 6), radius: 5, color: hexC(PAL.white), opacity: 0.45 * op });
}

// Result card for a finished bonus game: the bits paid, a summary and CONTINUE to the reward screen.
function showBonusResult({ title, hex, bits, lines = [] }) {
  const cx = 450;
  const cy = 262;
  add([rect(LOGIC_W, LOGIC_H), pos(0, 0), fixed(), color(hexC(PAL.bg)), opacity(0.6), z(Z.pop)]);
  add([
    rect(440, 236, { radius: 14 }), pos(cx, cy), anchor("center"), color(hexC(PAL.ink)), opacity(0.96),
    outline(3, hexC(hex)), z(Z.pop + 1), fixed(),
  ]);
  txt(title, cx, cy - 86, { size: 28, hex, stroke: 4, z: Z.pop + 2, fixed: true });
  txt("+" + fmt(bits) + " BITS", cx, cy - 38, { size: 40, hex: PAL.gold, stroke: 5, z: Z.pop + 2, fixed: true });
  lines.forEach((line, i) => txt(line, cx, cy + 6 + i * 22, { size: 16, hex: PAL.chrome, stroke: 2, width: 400, z: Z.pop + 2, fixed: true }));
  const btn = add([
    rect(240, 40, { radius: 10 }), pos(cx, cy + 90), anchor("center"), color(hexC(PAL.ink)), opacity(0.96),
    outline(2, hexC(hex)), area(), z(Z.pop + 2), fixed(),
  ]);
  txt("CONTINUE", cx, cy + 90, { size: 20, hex, stroke: 3, z: Z.pop + 3, fixed: true });
  let leaving = false;
  const toReward = () => {
    if (leaving) return;
    leaving = true;
    sfxClick();
    navigate("reward");
  };
  btn.onHover(() => { btn.color = hexC("#15122e"); });
  btn.onHoverEnd(() => { btn.color = hexC(PAL.ink); });
  btn.onClick(toReward);
  onKeyPress("enter", toReward);
  onKeyPress("space", toReward);
  sfxArpeggio(true);
}

// Ball Sort rejection reasons, as the player reads them.
const SORT_REASON = {
  full: "TUBE FULL", mismatch: "COLOUR MISMATCH", empty: "EMPTY TUBE", same: "SAME TUBE", range: "NO SUCH TUBE", solved: "ALREADY SORTED",
};

// ---------- bonus: ball sort (DESIGN 13.5) ----------
// Click a tube to lift its top ball, then click the tube to pour it in. Keys 1-7 pick tubes, H hints.
scene("sort", () => {
  navBusy = false;
  ESC.until = -1;
  tipHide();
  const run = SESSION.run;
  if (!run) { go("title"); return; }
  const board = HanoiCore.createBallSort(run);
  SESSION.bonus = board;
  const tubeN = board.tubes.length;
  const CAP = board.capacity;

  addDotGrid(PAL.violet);
  addOverlay();

  const TUBE_W = 58;
  const TUBE_H = 8 + CAP * 46 + 8;
  const TUBE_BOT = 380;
  const TUBE_TOP = TUBE_BOT - TUBE_H;
  const SPACING = Math.min(118, 800 / tubeN);
  const tubeX = (t) => 450 + (t - (tubeN - 1) / 2) * SPACING;
  const slotY = (i) => TUBE_BOT - 28 - i * 46;
  const LIFT_Y = TUBE_TOP - 26;
  const ballHex = (c) => BALL_HEX[c % BALL_HEX.length];

  const ps = { sel: -1, busy: false, done: false, anim: null, hint: null, flash: -1, flashUntil: 0 };

  add([
    pos(0, 0), z(Z.board),
    {
      draw() {
        for (let t = 0; t < tubeN; t++) {
          const cx = tubeX(t);
          const tube = board.tubes[t];
          const picked = ps.sel === t;
          const hinted = ps.hint && time() < ps.hint.until && (ps.hint.from === t || ps.hint.to === t);
          const bad = ps.flash === t && time() < ps.flashUntil;
          const edge = bad ? PAL.danger : picked ? PAL.lime : hinted ? PAL.amber : PAL.chrome;
          drawRect({
            pos: vec2(cx, TUBE_TOP + TUBE_H / 2), width: TUBE_W, height: TUBE_H, anchor: "center", radius: 14,
            color: hexC(PAL.tube), opacity: 0.9, outline: { width: picked ? 3 : 2, color: hexC(edge) },
          });
          drawRect({ pos: vec2(cx - TUBE_W / 2 + 9, TUBE_TOP + TUBE_H / 2), width: 3, height: TUBE_H - 30, anchor: "center", radius: 2, color: hexC(PAL.white), opacity: 0.12 });
          drawRect({ pos: vec2(cx, TUBE_BOT - 4), width: TUBE_W - 16, height: 3, anchor: "center", color: hexC(PAL.violet), opacity: 0.7 });
          tube.forEach((c, i) => {
            if (ps.anim && ps.anim.tube === t && ps.anim.idx === i) return;
            const lifted = picked && i === tube.length - 1;
            const y = lifted ? LIFT_Y : slotY(i);
            if (lifted) drawCircle({ pos: vec2(cx, y), radius: 29, color: hexC(ballHex(c)), opacity: 0.22 });
            drawBall(cx, y, ballHex(c));
          });
          drawText({ text: String(t + 1), size: 16, pos: vec2(cx, TUBE_BOT + 14), anchor: "center", color: hexC(picked ? PAL.lime : PAL.chrome) });
        }
        if (ps.anim) {
          const a = ps.anim;
          const e = a.p * a.p * (3 - 2 * a.p);
          drawBall(a.x0 + (a.x1 - a.x0) * e, a.y0 + (a.y1 - a.y0) * e - Math.sin(Math.PI * a.p) * 36, ballHex(a.color));
        }
        if (ps.hint && time() < ps.hint.until) {
          const x1 = tubeX(ps.hint.from);
          const x2 = tubeX(ps.hint.to);
          const y = 128;
          const alpha = 0.55 + 0.35 * Math.sin(time() * 6);
          drawLine({ p1: vec2(x1, y), p2: vec2(x2, y), width: 3, color: hexC(PAL.amber), opacity: alpha });
          const dir = Math.sign(x2 - x1) || 1;
          drawPolygon({ pts: [vec2(x2, y), vec2(x2 - dir * 12, y - 7), vec2(x2 - dir * 12, y + 7)], color: hexC(PAL.amber), opacity: alpha });
          drawPill((x1 + x2) / 2, y - 16, "HINT", PAL.amber, 70);
        }
      },
    },
  ]);

  // HUD band
  add([
    pos(0, 0), z(Z.hud), fixed(),
    {
      draw() {
        drawRect({ pos: vec2(0, 0), width: LOGIC_W, height: HUD_BAND, color: hexC(PAL.ink), opacity: 0.86 });
        drawRect({ pos: vec2(0, HUD_BAND), width: LOGIC_W, height: 1, color: hexC(PAL.violet), opacity: 0.6 });
        drawText({ text: "BONUS // BALL SORT", size: 20, pos: vec2(16, 8), anchor: "topleft", color: hexC(PAL.violet), outline: { width: 3, color: hexC(PAL.ink) } });
        drawText({ text: "BITS " + fmt(run.bits), size: 18, pos: vec2(884, 9), anchor: "topright", color: hexC(PAL.gold), outline: { width: 3, color: hexC(PAL.ink) } });
        drawText({ text: "MOVES " + board.moves + "   INVALID " + board.invalidMoves, size: 16, pos: vec2(16, 38), anchor: "topleft", color: hexC(PAL.chrome), outline: { width: 2, color: hexC(PAL.ink) } });
        drawText({ text: "POUR EACH COLOUR INTO ONE TUBE. NO PENALTY.", size: 16, pos: vec2(884, 38), anchor: "topright", color: hexC(PAL.dim), outline: { width: 2, color: hexC(PAL.ink) } });
      },
    },
  ]);

  // Tube hit areas: a click picks a tube, or pours the lifted ball into it.
  for (let t = 0; t < tubeN; t++) {
    const hit = add([rect(TUBE_W + 26, TUBE_H + 40), pos(tubeX(t), TUBE_TOP + TUBE_H / 2 - 16), anchor("center"), opacity(0), area(), z(Z.relay)]);
    hit.onClick(() => pickTube(t));
  }

  const hintBtn = menuButton({ x: 450, y: 446, w: 160, h: 34, label: "HINT", neon: PAL.amber, size: 18, onPick: () => doHint() });
  hintBtn.body.onHover(() => hintBtn.setFocus(true));
  hintBtn.body.onHoverEnd(() => hintBtn.setFocus(false));
  hintBtn.body.onClick(() => { if (hintBtn.body.isEnabled) doHint(); });
  txt("1-" + tubeN + " PICK TUBE    H HINT    ESC TWICE FORFEIT", 16, 478, { anchor: "left", align: "left", size: 16, hex: PAL.dim, stroke: 2 });
  addEscBanner(112, "PRESS ESC AGAIN TO FORFEIT THE BONUS");

  function pickTube(t) {
    if (ps.busy || ps.done || t < 0 || t >= tubeN) return;
    if (ps.sel < 0) {
      if (board.tubes[t].length === 0) {
        sfxSoft();
        pop("EMPTY", tubeX(t), TUBE_TOP - 16, PAL.chrome, 16);
        return;
      }
      ps.sel = t;
      sfxSelect();
      return;
    }
    if (ps.sel === t) {
      ps.sel = -1;
      sfxSoft();
      return;
    }
    const from = ps.sel;
    const res = board.tryMove(from, t);
    if (!res.ok) {
      // A refused pour keeps the lifted ball, so the player can pick another tube.
      sfxInvalid();
      GLITCH.level = 0.5;
      ps.flash = t;
      ps.flashUntil = time() + 0.4;
      pop(SORT_REASON[res.reason] || "NOT ALLOWED", tubeX(t), TUBE_TOP - 16, PAL.danger, 18);
      return;
    }
    ps.sel = -1;
    ps.hint = null;
    const idx = board.tubes[t].length - 1;
    ps.busy = true;
    ps.anim = { tube: t, idx, color: res.color, x0: tubeX(from), y0: LIFT_Y, x1: tubeX(t), y1: slotY(idx), p: 0 };
    tw(0, 1, 0.26, (p) => { if (ps.anim) ps.anim.p = p; }, easings.linear, () => {
      ps.anim = null;
      ps.busy = false;
      sfxMove();
      if (res.events.indexOf("tube-complete") >= 0) {
        sfxLand();
        sparks(tubeX(t), slotY(CAP - 1), ballHex(res.color), 12, 150);
      }
      if (res.solved) finishSort();
    });
  }

  function doHint() {
    if (ps.busy || ps.done) return;
    const h = board.hint();
    if (!h) {
      sfxSoft();
      pop("NOTHING TO SORT", 450, 300, PAL.chrome, 20);
      return;
    }
    ps.hint = { from: h.from, to: h.to, until: time() + 3 };
    sfxHint();
  }

  function finishSort() {
    if (ps.done) return;
    ps.done = true;
    ps.sel = -1;
    const res = HanoiCore.finishBonus(run, board);
    shockwave(450, 280, PAL.lime, 420, 0.9);
    sparks(450, 260, PAL.lime, 16, 220);
    sfxUpgrade();
    wait(1.1, () => showBonusResult({
      title: "BALL SORT SOLVED", hex: PAL.lime, bits: res ? res.bits : 0,
      lines: ["MOVES " + board.moves + "   INVALID " + board.invalidMoves, "NEW UPGRADE OFFER  //  AT LEAST ONE RARE"],
    }));
  }

  function forfeit() {
    if (ps.done) return;
    ps.done = true;
    HanoiCore.declineBonus(run);
    sfxSoft();
    navigate("reward");
  }

  for (let t = 0; t < Math.min(tubeN, 7); t++) onKeyPress(String(t + 1), () => pickTube(t));
  onKeyPress("h", doHint);
  onKeyPress("escape", () => { if (!ps.done) bonusEscPress(forfeit); });
});

// ---------- bonus: cipher (DESIGN 13.5) ----------
// Mastermind with the rings: each ring's relay is its peg. SUBMIT scores the guess; 8 guesses to break the code.
const CIPHER_RX = [130, 290, 450];
const CIPHER_HEX = [PAL.cyan, PAL.lime, PAL.magenta];

scene("cipher", () => {
  navBusy = false;
  ESC.until = -1;
  tipHide();
  const run = SESSION.run;
  if (!run) { go("title"); return; }
  const game = HanoiCore.createCipher(run);
  SESSION.bonus = game;
  const board = game.board;
  const RX = CIPHER_RX;
  const RINGS = 4;

  addDotGrid(PAL.violet);
  addOverlay();

  const slotY = (i) => BASE_Y - 4 - RING_H / 2 - i * STACK_STEP;
  const ps = { sel: -1, busy: false, done: false, anim: null };

  add([
    pos(0, 0), z(Z.board),
    {
      draw() {
        for (let t = 0; t < 3; t++) {
          const sel = ps.sel === t;
          drawRelayTube(RX[t], sel ? PAL.lime : CIPHER_HEX[t], {
            glow: sel ? 1.5 : 1, plateW: 120, label: "NODE " + NODE_LETTERS[t], labelHex: CIPHER_HEX[t],
          });
        }
        board.towers.forEach((tower, t) => tower.forEach((r, i) => {
          if (ps.anim && ps.anim.size === r.size) return;
          const lifted = ps.sel === t && i === tower.length - 1;
          drawRingAt(RX[t], slotY(i) - (lifted ? LIFT : 0), r.size, RINGS, r.type);
        }));
        if (ps.anim) {
          const a = ps.anim;
          const e = a.p * a.p * (3 - 2 * a.p);
          drawRingAt(a.x0 + (a.x1 - a.x0) * e, a.y0 + (a.y1 - a.y0) * e - Math.sin(Math.PI * a.p) * 30, a.size, RINGS, a.type);
        }
      },
    },
  ]);

  // HUD band: title and guess count, then the secret (hidden until the game ends)
  const secret = () => (game.finished ? game.secret : null);
  add([
    pos(0, 0), z(Z.hud), fixed(),
    {
      draw() {
        drawRect({ pos: vec2(0, 0), width: LOGIC_W, height: HUD_BAND, color: hexC(PAL.ink), opacity: 0.86 });
        drawRect({ pos: vec2(0, HUD_BAND), width: LOGIC_W, height: 1, color: hexC(PAL.violet), opacity: 0.6 });
        drawText({ text: "BONUS // CIPHER", size: 20, pos: vec2(16, 8), anchor: "topleft", color: hexC(PAL.violet), outline: { width: 3, color: hexC(PAL.ink) } });
        drawText({ text: "GUESS " + game.guesses.length + " / " + game.maxGuesses, size: 18, pos: vec2(884, 9), anchor: "topright", color: hexC(PAL.gold), outline: { width: 3, color: hexC(PAL.ink) } });
        drawText({ text: "SECRET", size: 16, pos: vec2(16, 42), anchor: "topleft", color: hexC(PAL.chrome), outline: { width: 2, color: hexC(PAL.ink) } });
        const s = secret();
        for (let k = 0; k < RINGS; k++) {
          const x = 116 + k * 40;
          if (s) drawCircle({ pos: vec2(x, 48), radius: 11, color: hexC(CIPHER_HEX[s[k]]), opacity: 1 });
          else {
            drawCircle({ pos: vec2(x, 48), radius: 11, color: hexC(PAL.steel), opacity: 1 });
            drawText({ text: "?", size: 16, pos: vec2(x, 48), anchor: "center", color: hexC(PAL.dim) });
          }
        }
        drawText({ text: "SUBMIT WHEN READY. EIGHT GUESSES.", size: 16, pos: vec2(884, 42), anchor: "topright", color: hexC(PAL.dim), outline: { width: 2, color: hexC(PAL.ink) } });
      },
    },
  ]);

  // Guess history: one row per guess, pegs in ring order (smallest first), feedback on the right.
  const HX = 520;
  const HY = 84;
  const HW = 364;
  const HH = 346;
  const ROW0 = HY + 34;
  const ROW_STEP = 34;
  add([
    pos(0, 0), z(Z.ui),
    {
      draw() {
        drawRect({ pos: vec2(HX, HY), width: HW, height: HH, anchor: "topleft", radius: 10, color: hexC(PAL.ink), opacity: 0.9, outline: { width: 2, color: hexC(PAL.violet) } });
        drawText({ text: "#", size: 16, pos: vec2(HX + 14, HY + 9), anchor: "topleft", color: hexC(PAL.violet) });
        drawText({ text: "PEGS RINGS 1-4", size: 16, pos: vec2(HX + 44, HY + 9), anchor: "topleft", color: hexC(PAL.violet) });
        drawText({ text: "FEEDBACK", size: 16, pos: vec2(HX + 214, HY + 9), anchor: "topleft", color: hexC(PAL.violet) });
        for (let r = 0; r < game.maxGuesses; r++) {
          const y = ROW0 + r * ROW_STEP;
          const row = game.guesses[r];
          drawText({ text: String(r + 1).padStart(2, "0"), size: 16, pos: vec2(HX + 14, y), anchor: "left", color: hexC(row ? PAL.white : PAL.steel) });
          for (let k = 0; k < RINGS; k++) {
            const x = HX + 50 + k * 26;
            if (row) drawCircle({ pos: vec2(x, y), radius: 9, color: hexC(CIPHER_HEX[row.guess[k]]), opacity: 1 });
            else drawCircle({ pos: vec2(x, y), radius: 9, color: hexC(PAL.steel), opacity: 0.6 });
          }
          if (row) {
            // Feedback: black pegs first, then white, in a 2 x 2 grid.
            for (let k = 0; k < RINGS; k++) {
              const col = k % 2;
              const rowIdx = Math.floor(k / 2);
              const x = HX + 222 + col * 22;
              const yy = y - 8 + rowIdx * 16;
              if (k < row.black) drawCircle({ pos: vec2(x, yy), radius: 6, color: hexC(PAL.white), opacity: 1 });
              else if (k < row.black + row.white) {
                drawCircle({ pos: vec2(x, yy), radius: 6, color: hexC(PAL.chrome), opacity: 1 });
                drawCircle({ pos: vec2(x, yy), radius: 3.5, color: hexC(PAL.ink), opacity: 1 });
              } else drawCircle({ pos: vec2(x, yy), radius: 2.5, color: hexC(PAL.steel), opacity: 1 });
            }
          }
        }
        drawText({ text: "BLACK    ring on its secret relay", size: 16, pos: vec2(HX + 14, HY + HH - 46), anchor: "topleft", color: hexC(PAL.white) });
        drawText({ text: "HOLLOW   secret relay, another ring", size: 16, pos: vec2(HX + 14, HY + HH - 24), anchor: "topleft", color: hexC(PAL.chrome) });
      },
    },
  ]);

  function pickRelay(t) {
    if (ps.busy || ps.done || t < 0 || t > 2) return;
    if (ps.sel < 0) {
      if (board.towers[t].length === 0) {
        sfxSoft();
        pop("EMPTY", RX[t], BASE_Y - 60, PAL.chrome, 16);
        return;
      }
      ps.sel = t;
      sfxSelect();
      return;
    }
    if (ps.sel === t) {
      ps.sel = -1;
      sfxSoft();
      return;
    }
    const from = ps.sel;
    const res = board.tryMove(from, t);
    if (!res.ok) {
      // Cipher moves have no penalty: a refused move only says why.
      sfxSoft();
      pop(res.reason === "size" ? "TOO LARGE" : "NOT ALLOWED", RX[t], RELAY_TOP + 40, PAL.chrome, 16);
      return;
    }
    ps.sel = -1;
    const lift = board.towers[from].length;
    ps.busy = true;
    ps.anim = { size: res.ring.size, type: res.ring.type, x0: RX[from], y0: slotY(lift) - LIFT, x1: RX[t], y1: slotY(board.towers[t].length - 1), p: 0 };
    tw(0, 1, 0.24, (p) => { if (ps.anim) ps.anim.p = p; }, easings.linear, () => {
      ps.anim = null;
      ps.busy = false;
      sfxMove();
    });
  }

  function doSubmit() {
    if (ps.busy || ps.done || game.finished) return;
    const res = game.submit();
    if (!res) return;
    sfxTick();
    const rowY = ROW0 + (game.guesses.length - 1) * ROW_STEP;
    pop("BLACK " + res.black + "  WHITE " + res.white, HX + 160, rowY - 22, PAL.white, 16);
    if (game.finished) finishCipher();
  }

  function finishCipher() {
    if (ps.done) return;
    ps.done = true;
    ps.sel = -1;
    setItemEnabled(submitBtn, false, PAL.lime);
    const res = HanoiCore.finishBonus(run, game);
    if (game.solved) {
      shockwave(450, 280, PAL.lime, 420, 0.9);
      sparks(450, 250, PAL.lime, 16, 220);
      sfxUpgrade();
    } else {
      screenFlash(PAL.danger, 0.4, 0.8);
      GLITCH.level = 0.9;
      sfxGameOver();
    }
    const code = game.secret.map((v) => NODE_LETTERS[v]).join(" ");
    wait(1.1, () => showBonusResult({
      title: game.solved ? "SIGNAL DECODED" : "CIPHER LOCKED",
      hex: game.solved ? PAL.lime : PAL.danger,
      bits: res ? res.bits : 0,
      lines: [
        "SECRET  " + code + "   (RING 1 TO RING 4)",
        game.solved ? "SOLVED IN " + game.guesses.length + " OF " + game.maxGuesses + " GUESSES" : "NO GUESSES LEFT. CONSOLATION PAID.",
        "NEW UPGRADE OFFER  //  AT LEAST ONE RARE",
      ],
    }));
  }

  function forfeit() {
    if (ps.done) return;
    ps.done = true;
    HanoiCore.declineBonus(run);
    sfxSoft();
    navigate("reward");
  }

  // Relay hit areas, same shape as the main board's.
  for (let t = 0; t < 3; t++) {
    const hit = add([rect(120, BASE_Y - RELAY_TOP + 60), pos(RX[t], (RELAY_TOP - 20 + BASE_Y + 40) / 2), anchor("center"), opacity(0), area(), z(Z.relay)]);
    hit.onClick(() => pickRelay(t));
  }

  const submitBtn = menuButton({ x: 760, y: 458, w: 220, h: 34, label: "SUBMIT GUESS", neon: PAL.lime, size: 18, onPick: () => doSubmit() });
  submitBtn.body.onHover(() => submitBtn.setFocus(true));
  submitBtn.body.onHoverEnd(() => submitBtn.setFocus(false));
  submitBtn.body.onClick(() => { if (submitBtn.body.isEnabled) doSubmit(); });
  txt("1 2 3 RELAY    ENTER SUBMIT    ESC TWICE FORFEIT", 16, 478, { anchor: "left", align: "left", size: 16, hex: PAL.dim, stroke: 2 });
  addEscBanner(112, "PRESS ESC AGAIN TO FORFEIT THE BONUS");

  onKeyPress("1", () => pickRelay(0));
  onKeyPress("2", () => pickRelay(1));
  onKeyPress("3", () => pickRelay(2));
  onKeyPress("enter", () => doSubmit());
  onKeyPress("escape", () => { if (!ps.done) bonusEscPress(forfeit); });
});

// ---------- sector clear ----------
scene("clear", (args) => {
  navBusy = false;
  ESC.until = -1;
  const fin = args && args.fin;
  const sector = SESSION.sector;
  if (!fin || !SESSION.run || !sector) { go("title"); return; }
  const victory = !!fin.victory;
  const boss = !!sector.isBoss;
  const rateHex = { S: PAL.gold, A: PAL.lime, B: PAL.cyan, C: PAL.magenta }[fin.rating] || PAL.white;

  addDotGrid(boss ? PAL.magenta : PAL.cyan);
  addOverlay();

  txt(victory ? "THE TOWER IS SILENT" : boss ? "BOSS NEUTRALISED" : "SECTOR CLEARED", 450, 46, {
    size: 32, hex: victory ? PAL.gold : boss ? PAL.magenta : PAL.cyan, stroke: 4,
  });
  txt("SECTOR " + pad2(sector.no) + (boss ? " // " + String(sector.boss.name || "").toUpperCase() : ""), 450, 84, {
    size: 16, hex: PAL.chrome, stroke: 2,
  });

  // Rating stamp: slams in, then a shockwave and shake.
  const sx = 210;
  const sy = 258;
  const stamp = add([
    rect(176, 176, { radius: 16 }),
    pos(sx, sy),
    anchor("center"),
    color(hexC(PAL.ink)),
    opacity(0),
    outline(7, hexC(rateHex)),
    rotate(-6),
    scale(2.8),
    z(Z.ui),
  ]);
  stamp.add([
    text(fin.rating, { size: 132 }),
    anchor("center"),
    color(hexC(rateHex)),
    outline(6, hexC(PAL.ink)),
    z(Z.ui + 1),
  ]);
  tw(2.8, 1, 0.34, (v) => {
    if (!stamp.exists()) return;
    stamp.scale = vec2(v);
    stamp.opacity = clampN((2.8 - v) / 1.2, 0, 0.95);
  }, easings.easeOutBack, () => {
    if (!stamp.exists()) return;
    sfxStamp();
    shake(6);
    sparks(sx, sy, rateHex, 18, 220);
    shockwave(sx, sy, rateHex, 340, 0.8);
    sfxArpeggio(victory);
  });

  // Summary column
  const rx = 430;
  let y = 130;
  const row = (label, value, hex = PAL.white) => {
    txt(label, rx, y, { anchor: "left", align: "left", size: 18, hex: PAL.dim, stroke: 2 });
    txt(value, 860, y, { anchor: "right", align: "right", size: 22, hex, stroke: 3 });
    y += 34;
  };
  row("COST", fin.cost + " / PAR " + fin.par, fin.cost <= fin.par ? PAL.lime : PAL.white);
  row("RATING", fin.rating, rateHex);
  row("BITS EARNED", "+" + fmt(fin.bitsEarned), PAL.gold);
  if (fin.interest > 0) row("INTEREST", "+" + fmt(fin.interest), PAL.gold);
  if (fin.healed > 0) row("REPAIRED", "+" + fin.healed + " INTEGRITY", PAL.lime);
  row("SCORE", "+" + fmt(fin.scoreEarned), PAL.white);

  y += 6;
  txt("QUESTS", rx, y, { anchor: "left", align: "left", size: 16, hex: PAL.dim, stroke: 2 });
  y += 26;
  (fin.quests || []).forEach((q) => {
    const hex = q.done ? PAL.lime : PAL.danger;
    txt(q.done ? "DONE" : "MISSED", rx, y, { anchor: "left", align: "left", size: 16, hex, stroke: 2 });
    txt(q.name, rx + 74, y, { anchor: "left", align: "left", size: 18, hex: PAL.white, stroke: 2 });
    txt((q.done ? "+" : "") + (q.done ? fmt(q.reward) : "0") + " BITS", 860, y, { anchor: "right", align: "right", size: 16, hex: q.done ? PAL.gold : PAL.dim, stroke: 2 });
    y += 26;
  });

  const cont = menuButton({
    x: 450, y: 452, w: 300, h: 44, label: victory ? "SEE RESULT" : "CONTINUE", neon: rateHex, size: 22,
    onPick: () => {
      sfxClick();
      if (victory) navigate("end", { victory: true });
      else navigate("reward");
    },
  });
  bindMenu([cont]);
});

// ---------- reward: upgrade cards, reroll, repair, bonus, build ----------
scene("reward", () => {
  navBusy = false;
  ESC.until = -1;
  tipHide();
  const run = SESSION.run;
  if (!run) { go("title"); return; }
  const sector = SESSION.sector;

  addDotGrid(PAL.amber);
  addOverlay();

  const offered = run.offer && run.offer.length ? run.offer.slice() : (HanoiCore.rewardOffer(run) || []);
  const ids = run.offer && run.offer.length ? run.offer : offered;
  ids.forEach((id) => { STORE.seen[id] = true; });
  saveStore();

  txt("CHOOSE AN UPGRADE", 330, 42, { size: 30, hex: PAL.amber, stroke: 4 });
  txt("SECTOR " + pad2(sector ? sector.no : 0) + " CLEARED   NEXT SECTOR " + pad2((run.sectorNo || 0) + 1), 330, 74, { size: 16, hex: PAL.chrome, stroke: 2 });

  const cardW = 180;
  const cardH = 262;
  const cardY = 262;
  const centers = [138, 338, 538];
  const cardItems = [];

  ids.slice(0, 3).forEach((id, i) => {
    const def = (HanoiCore.UPGRADES || []).find((u) => u.id === id) || { name: titleOf(id), rarity: "common", desc: "", max: 1 };
    const rar = RARITY[def.rarity] || RARITY.common;
    const cx = centers[i];
    const stacks = (run.upgrades && run.upgrades[id]) || 0;
    const curse = def.rarity === "curse";
    const card = add([
      rect(cardW, cardH, { radius: 12 }),
      pos(cx, cardY),
      anchor("center"),
      color(hexC(PAL.ink)),
      opacity(0.95),
      outline(curse ? 4 : 3, hexC(rar.hex)),
      area(),
      z(Z.ui),
      "menu-item",
    ]);
    if (curse) {
      add([
        pos(0, 0), z(Z.ui + 1),
        { draw() { drawHazard(cx - cardW / 2, cardY - cardH / 2, cardW, 10, PAL.danger, PAL.ink, 0.95); drawHazard(cx - cardW / 2, cardY + cardH / 2 - 10, cardW, 10, PAL.danger, PAL.ink, 0.95); } },
      ]);
    }
    card.add([text(rar.label, { size: 16 }), pos(0, -cardH / 2 + 34), anchor("center"), color(hexC(rar.hex)), outline(2, hexC(PAL.ink)), z(Z.ui + 1)]);
    card.add([text(def.name, { size: 20, width: cardW - 22, align: "center" }), pos(0, -58), anchor("center"), color(hexC(PAL.white)), outline(3, hexC(PAL.ink)), z(Z.ui + 1)]);
    card.add([text(def.desc || "", { size: 16, width: cardW - 26, align: "center" }), pos(0, 18), anchor("center"), color(hexC(PAL.chrome)), outline(2, hexC(PAL.ink)), z(Z.ui + 1)]);
    card.add([text("STACK " + stacks + " / " + (def.max || 1), { size: 16 }), pos(0, cardH / 2 - 26), anchor("center"), color(hexC(stacks > 0 ? rar.hex : PAL.dim)), outline(2, hexC(PAL.ink)), z(Z.ui + 1)]);
    const item = makeItem(card, {
      neon: rar.hex,
      onPick: () => takeOffer(id, cx, cardY),
      onStyle(on) {
        if (!card.exists()) return;
        tw(card.pos.y, cardY - (on ? 10 : 0), 0.14, (v) => { if (card.exists()) card.pos.y = v; }, easings.easeOutCubic);
        card.outline.width = on ? (curse ? 6 : 5) : (curse ? 4 : 3);
        card.color = hexC(on ? "#15122e" : PAL.ink);
      },
    });
    cardItems.push(item);
  });

  // Bottom row: REROLL, BONUS (only when run.bonusOffer is set, DESIGN 13.6) and REPAIR.
  const bonus = run.bonusOffer && run.bonusOffer.kind ? run.bonusOffer : null;
  const btnW = bonus ? 180 : 200;
  const rerollItem = menuButton({
    x: bonus ? 130 : 250, y: 440, w: btnW, h: 40, label: "", neon: PAL.amber, size: 18,
    onPick: () => doReroll(),
  });
  const bonusItem = bonus ? menuButton({
    x: 330, y: 440, w: 180, h: 40, label: "BONUS: " + (bonus.kind === "cipher" ? "CIPHER" : "SORT"), neon: PAL.violet, size: 18,
    onPick: () => startBonus(bonus.kind),
  }) : null;
  const repairItem = menuButton({
    x: bonus ? 530 : 490, y: 440, w: btnW, h: 40, label: "", neon: PAL.lime, size: 18,
    onPick: () => doRepair(),
  });
  const refreshButtons = () => {
    const rc = HanoiCore.rerollCost(run);
    const pc = HanoiCore.repairCost(run);
    rerollItem.lbl.text = "REROLL  " + rc + " BITS";
    repairItem.lbl.text = run.integrity >= run.maxIntegrity ? "REPAIR  FULL" : "REPAIR  " + pc + " BITS";
    setItemEnabled(rerollItem, run.bits >= rc, PAL.amber);
    setItemEnabled(repairItem, run.integrity < run.maxIntegrity && run.bits >= pc, PAL.lime);
    wallet.text = "BITS " + fmt(run.bits) + "   INTEGRITY " + run.integrity + " / " + run.maxIntegrity;
  };
  const wallet = txt("", 40, 478, { anchor: "left", align: "left", size: 18, hex: PAL.gold, stroke: 3 });
  const bindItems = [...cardItems, rerollItem, ...(bonusItem ? [bonusItem] : []), repairItem];
  bindMenu(bindItems);
  refreshButtons();

  // Build panel
  const bx = 660;
  txt("BUILD", bx, 136, { anchor: "left", align: "left", size: 20, hex: PAL.cyan, stroke: 3 });
  const owned = Object.keys(run.upgrades || {}).filter((k) => (run.upgrades[k] || 0) > 0);
  const buildLines = owned.slice(0, 9);
  if (!owned.length) txt("NO UPGRADES YET", bx, 166, { anchor: "left", align: "left", size: 16, hex: PAL.dim, stroke: 2 });
  buildLines.forEach((k, i) => {
    const def = (HanoiCore.UPGRADES || []).find((u) => u.id === k);
    const rar = def ? RARITY[def.rarity] || RARITY.common : RARITY.common;
    txt((def ? def.name : titleOf(k)) + "  x" + run.upgrades[k], bx, 166 + i * 22, { anchor: "left", align: "left", size: 16, hex: rar.hex, stroke: 2 });
  });
  if (owned.length > 9) txt("+" + (owned.length - 9) + " MORE", bx, 166 + 9 * 22, { anchor: "left", align: "left", size: 16, hex: PAL.chrome, stroke: 2 });

  // Forecast (upgrade 'forecast'): each modifier and the quest is a hover target with its tooltip.
  if ((run.upgrades && run.upgrades.forecast) > 0 && run.nextPlan) {
    const plan = run.nextPlan;
    const fy = 370;
    add([rect(220, 104, { radius: 10 }), pos(bx, fy), anchor("topleft"), color(hexC(PAL.ink)), opacity(0.9), outline(2, hexC(PAL.amber)), z(Z.ui)]);
    txt("FORECAST  SECTOR " + pad2((run.sectorNo || 0) + 1), bx + 12, fy + 12, { anchor: "left", align: "left", size: 16, hex: PAL.amber, stroke: 2 });
    // Core plan shape: { no, modifierIds, ringTypes, questIds }
    const mods = plan.modifierIds || [];
    if (!mods.length) txt("No modifiers", bx + 12, fy + 34, { anchor: "left", align: "left", size: 16, hex: PAL.dim, stroke: 2 });
    mods.forEach((id, k) => {
      const y = fy + 34 + k * 18;
      const def = (HanoiCore.MODIFIERS || []).find((m) => m.id === id);
      txt(def ? def.name : titleOf(id), bx + 12, y, { anchor: "left", align: "left", size: 16, hex: MODIFIER_HEX[id] || PAL.white, stroke: 2, width: 200 });
      tipZone(bx + 6, y - 9, 208, 18, () => modTip(id), {});
    });
    const qid = (plan.questIds || [])[0];
    const qDef = qid ? (HanoiCore.QUESTS || []).find((q) => q.id === qid) : null;
    if (qDef) {
      const y = fy + 34 + Math.max(1, mods.length) * 18 + 6;
      txt("Quest: " + qDef.name, bx + 12, y, { anchor: "left", align: "left", size: 16, hex: PAL.chrome, stroke: 2, width: 200 });
      tipZone(bx + 6, y - 9, 208, 18, () => questTip({ id: qDef.id, name: qDef.name }, PAL.amber), {});
    }
  }

  txt((bonus ? "1 2 3 PICK    R REROLL    B BONUS    P REPAIR    ESC ABORT" : "1 2 3 PICK    R REROLL    P REPAIR    ESC ABORT"), 884, 22, { anchor: "right", align: "right", size: 16, hex: PAL.dim, stroke: 2 });
  onKeyPress("1", () => takeOffer(ids[0]));
  onKeyPress("2", () => takeOffer(ids[1]));
  onKeyPress("3", () => takeOffer(ids[2]));
  onKeyPress("r", () => doReroll());
  onKeyPress("p", () => doRepair());
  onKeyPress("b", () => { if (bonus) startBonus(bonus.kind); });
  onKeyPress("escape", escPress);
  addEscBanner(112);

  function takeOffer(id, cx, cy) {
    if (navBusy || !id) return;
    const def = HanoiCore.takeCard(run, id);
    if (!def) {
      sfxInvalid();
      return;
    }
    STORE.seen[id] = true;
    saveStore();
    sfxUpgrade();
    if (cx !== undefined) sparks(cx, cy, (RARITY[(def && def.rarity) || "common"] || RARITY.common).hex, 16, 180);
    navigate("intro");
  }

  // Bonus games reuse the run's bits and integrity rules; they never touch integrity (DESIGN 13.5).
  function startBonus(kind) {
    if (navBusy) return;
    navigate(kind === "cipher" ? "cipher" : "sort");
  }

  function doReroll() {
    if (navBusy) return;
    const cost = HanoiCore.rerollCost(run);
    if (run.bits < cost) {
      sfxInvalid();
      return;
    }
    const next = HanoiCore.reroll(run);
    if (!next) {
      sfxInvalid();
      return;
    }
    sfxReroll();
    navigate("reward");
  }

  function doRepair() {
    if (navBusy) return;
    if (run.integrity >= run.maxIntegrity || run.bits < HanoiCore.repairCost(run)) {
      sfxInvalid();
      return;
    }
    if (HanoiCore.buyRepair(run)) {
      sfxUpgrade();
      refreshButtons();
    } else {
      sfxInvalid();
    }
  }
});

// ---------- end: victory or signal lost ----------
scene("end", (args) => {
  navBusy = false;
  ESC.until = -1;
  const run = SESSION.run;
  if (!run) { go("title"); return; }
  const victory = !!(args && args.victory) || !!run.victory;
  recordRun();
  const mode = MODE_INFO[SESSION.mode] ? SESSION.mode : "standard";
  const modeInfo = MODE_INFO[mode];
  const key = recordKey(SESSION.mode, SESSION.asc, SESSION.seed);
  const best = bestOf(key) || { score: 0, sectors: 0 };

  addSynth({ disks: 5, sun: victory });
  addOverlay();
  if (!victory) GLITCH.level = 0.8;
  if (victory) sfxArpeggio(true);
  else sfxGameOver();

  txt(victory ? "SIGNAL RESTORED" : "SIGNAL LOST", 450, 52, {
    size: 44, hex: victory ? PAL.gold : PAL.danger, stroke: 5,
  });
  const clearedWord = run.sectorsCleared === 1 ? " SECTOR CLEARED" : " SECTORS CLEARED";
  txt(modeInfo.name + (SESSION.asc ? "  //  ASCENSION" : "") + "  //  " + run.sectorsCleared + clearedWord, 450, 96, {
    size: 18, hex: PAL.chrome, stroke: 3,
  });

  txt("SCORE", 230, 146, { size: 18, hex: PAL.dim, stroke: 2 });
  txt(fmt(run.score), 230, 196, { size: 60, hex: PAL.white, stroke: 5 });
  txt(SESSION.newBest ? "NEW BEST" : "BEST " + fmt(best.score), 230, 246, {
    size: 18, hex: SESSION.newBest ? PAL.lime : PAL.chrome, stroke: 3,
  });

  const rx = 470;
  let y = 150;
  const row = (label, value, hex = PAL.white) => {
    txt(label, rx, y, { anchor: "left", align: "left", size: 18, hex: PAL.dim, stroke: 2 });
    txt(value, 860, y, { anchor: "right", align: "right", size: 22, hex, stroke: 3 });
    y += 34;
  };
  row("CAUSE", victory ? "THE STACK FELL" : humanReason(run.endReason), victory ? PAL.gold : PAL.danger);
  row("BITS HELD", fmt(run.bits), PAL.gold);
  row("CARDS TAKEN", String((run.stats && run.stats.cardsTaken ? run.stats.cardsTaken.length : 0)), PAL.cyan);
  const taken = (run.stats && run.stats.cardsTaken) || [];
  const names = taken.map((id) => {
    const def = (HanoiCore.UPGRADES || []).find((u) => u.id === id);
    return def ? def.name : titleOf(id);
  });
  txt(names.slice(0, 8).join("  /  ") || "No upgrades taken", rx, y + 6, { anchor: "left", align: "left", size: 16, hex: PAL.chrome, stroke: 2, width: 390 });

  const retry = menuButton({
    x: 340, y: 440, w: 220, h: 46, label: "RETRY", neon: PAL.cyan, size: 22,
    onPick: () => startRun(SESSION.mode, SESSION.asc),
  });
  const title = menuButton({
    x: 580, y: 440, w: 220, h: 46, label: "TITLE", neon: PAL.violet, size: 22,
    onPick: () => navigate("title"),
  });
  bindMenu([retry, title]);
  onKeyPress("r", () => startRun(SESSION.mode, SESSION.asc));
  onKeyPress("t", () => navigate("title"));
  onKeyPress("escape", () => navigate("title"));
});

// Core causes: 'invalid' (rejected moves) and 'timeout' (blitz clock).
function humanReason(reason) {
  const r = String(reason || "").toLowerCase();
  if (r.indexOf("time") >= 0) return "TIMED OUT";
  if (r.indexOf("invalid") >= 0) return "REJECTED MOVES";
  return "INTEGRITY DEPLETED";
}

go("title");
