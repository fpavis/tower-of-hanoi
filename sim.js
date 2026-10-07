#!/usr/bin/env node
'use strict';
/**
 * HANOI//PROTOCOL balance simulator.
 *
 *   node sim.js [--runs N] [--seed S] [--lift-runs L] [--daily YYYYMMDD]
 *
 * Plays full headless runs through core.js (HanoiCore) with three bots
 * (Optimal, Human, Random) in all four modes, prints a balance report and
 * writes the same text to sim-report.txt beside this file.
 *
 * Determinism: every seed derives from --seed and the report holds no
 * wall-clock data, so identical arguments always produce an identical report.
 * Depends on core.js only (no DOM, no Kaplay).
 */

const fs = require('fs');
const path = require('path');
const HanoiCore = require(path.join(__dirname, 'core.js'));

const REQUIRED_API = [
  'makeRng', 'createRun', 'sectorConfig', 'Board', 'finishSector', 'rewardOffer',
  'reroll', 'rerollCost', 'takeCard', 'repairCost', 'buyRepair', 'UPGRADES', 'MODES',
];
const missingApi = REQUIRED_API.filter((name) => !(name in HanoiCore));
if (missingApi.length) {
  console.error(`core.js does not export: ${missingApi.join(', ')}`);
  process.exit(2);
}
const {
  makeRng, createRun, sectorConfig, Board, finishSector, rewardOffer, reroll,
  rerollCost, takeCard, repairCost, buyRepair, UPGRADES,
} = HanoiCore;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MODE_IDS = ['standard', 'blitz', 'endless', 'daily'];
const BOT_IDS = ['optimal', 'human', 'random'];

/** moveSec: simulated seconds per click. A wrong click, undo or hint press
 *  also costs moveSec. misRate: chance that an attempt is a wrong click first. */
const BOT_SPEC = {
  optimal: { name: 'Optimal', moveSec: 0.9, misRate: 0 },
  human: { name: 'Human', moveSec: 1.4, misRate: 0.04 },
  random: { name: 'Random', moveSec: 1.6, misRate: 0.1 },
};

const DAILY_SEED = 20261007;      // YYYYMMDD; fixed so the report is reproducible
const ENDLESS_CAP = 25;           // endless has no victory; a perfect bot would never die
const CLICK_BUDGET = 4000;        // clicks per sector before the run counts as stuck
const TIMEOUT_BUDGET = 200;       // blitz timeouts per sector before the run counts as stuck
const MAX_MISCLICK_STREAK = 6;    // safety cap on consecutive wrong clicks
const ECON_SECTORS = [4, 8, 12];  // sectors where bits on entry are sampled
const EARLY_PICK_LAST = 4;        // human picks survival/economy cards through this sector
const REROLL_RANK = 5;            // human rerolls when nothing in its top 5 is offered
const HUMAN_REPAIR_AT = 2;        // human buys a repair at integrity <= 2
const RANDOM_REPAIR_AT = 1;       // random bot buys a repair only at integrity <= 1
const LIFT_MIN_N = 30;            // min runs on each side of a card before its lift counts
const LIFT_TOLERANCE = 0.15;      // +-15 % of the mean lift (DESIGN section 11)

/** Human pick order. Survival and economy first while the run is young, then
 *  combo and economy power. Curses sit below the good cards and are only
 *  considered while integrity >= 3 (see cardRank). */
const HUMAN_EARLY = [
  'stability_patch', 'reinforced', 'field_repair', 'bit_miner', 'interest_engine',
  'quest_broker', 'neural_link', 'phoenix_core', 'undo_buffer', 'overclock',
  'gilded_forge', 'momentum', 'recursion', 'perfect_protocol', 'black_market',
  'hint_pulse', 'forecast', 'exoskeleton', 'ghost_protocol', 'time_dilation',
  'greed_protocol', 'static_debt', 'hair_trigger',
];
const HUMAN_LATE = [
  'neural_link', 'overclock', 'interest_engine', 'gilded_forge', 'momentum',
  'bit_miner', 'stability_patch', 'field_repair', 'perfect_protocol', 'phoenix_core',
  'quest_broker', 'recursion', 'reinforced', 'undo_buffer', 'black_market',
  'ghost_protocol', 'exoskeleton', 'hint_pulse', 'time_dilation', 'forecast',
  'greed_protocol', 'static_debt', 'hair_trigger',
];
/** Optimal pick order: strongest value first, never curses. */
const OPTIMAL_ORDER = [
  'phoenix_core', 'stability_patch', 'field_repair', 'interest_engine', 'neural_link',
  'overclock', 'bit_miner', 'gilded_forge', 'perfect_protocol', 'reinforced',
  'momentum', 'recursion', 'quest_broker', 'undo_buffer', 'black_market',
  'hint_pulse', 'exoskeleton', 'ghost_protocol', 'time_dilation', 'forecast',
];

const CARD_BY_ID = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));
const isCurse = (id) => Boolean(CARD_BY_ID[id]) && CARD_BY_ID[id].rarity === 'curse';

/** Notes about core.js mismatches, reported at the end (deterministic text). */
const apiNotes = [];
const runtimeNotes = new Map();   // message -> count
function noteRuntime(message) {
  runtimeNotes.set(message, (runtimeNotes.get(message) || 0) + 1);
}

function checkPriorityLists() {
  const ids = UPGRADES.map((u) => u.id);
  const nonCurse = UPGRADES.filter((u) => u.rarity !== 'curse').map((u) => u.id);
  const check = (label, list, expected) => {
    const missing = expected.filter((id) => !list.includes(id));
    const unknown = list.filter((id) => !ids.includes(id));
    if (missing.length) apiNotes.push(`${label} priority list lacks: ${missing.join(', ')}`);
    if (unknown.length) apiNotes.push(`${label} priority list names unknown cards: ${unknown.join(', ')}`);
  };
  check('human early', HUMAN_EARLY, ids);
  check('human late', HUMAN_LATE, ids);
  check('optimal', OPTIMAL_ORDER, nonCurse);
  if (HanoiCore.MODES) {
    const absent = MODE_IDS.filter((m) => !(m in HanoiCore.MODES) && m !== 'daily');
    if (absent.length) apiNotes.push(`MODES lacks: ${absent.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Seeds and small helpers
// ---------------------------------------------------------------------------

/** Deterministic 32-bit seed from integer parts. */
function mixSeed(...parts) {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h = Math.imul(h ^ (p >>> 0), 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
  }
  return (h >>> 0) || 1;
}

const cardIdOf = (c) => (typeof c === 'string' ? c : c && c.id);

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const pct = (x, d = 1) => (Number.isFinite(x) ? `${(100 * x).toFixed(d)}%` : '-');
const num = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const inRange = (x, lo, hi) => Number.isFinite(x) && x >= lo && x <= hi;

// ---------------------------------------------------------------------------
// Board driving. Every bot moves through these helpers, so the sector clock,
// the blitz timer and the bookkeeping behave identically for all bots.
//
// Clock: ctx.t is seconds since sector start and is passed to tryMove. Each
// click advances it by moveSec (wrong clicks too). In blitz, board.timeLeft(t)
// tells us when the timer would run out; the clock stops at expiry and
// board.timeout() resets the board, after which the bot re-plans from start.
// ---------------------------------------------------------------------------

function newPlayCtx(board, run, spec) {
  return {
    board, run, spec,
    t: 0,
    clicks: 0, valid: 0, invalid: 0, timeouts: 0, undos: 0, hints: 0,
    bits: 0,
    streak: 0, usedUndo: false, usedHint: false,
    result: null, why: null,
  };
}

/** Advance the clock by one click's time. Returns 'ok' | 'timeout' | 'failed' | 'budget'. */
function tick(ctx) {
  const dt = ctx.spec.moveSec;
  const left = ctx.board.timeLeft(ctx.t); // seconds left on the blitz timer, null if untimed
  if (left !== null && left !== undefined && dt > left) {
    ctx.timeouts++;
    if (ctx.timeouts > TIMEOUT_BUDGET) return 'budget';
    ctx.t += Math.max(0, left);           // the clock stops at expiry
    ctx.board.timeout();                  // integrity -1, board back to start, timer restarts
    return ctx.run.over ? 'failed' : 'timeout';
  }
  ctx.t += dt;
  return 'ok';
}

/** One click: tick the clock, then tryMove. Returns { kind, r? }. */
function click(ctx, from, to) {
  const st = tick(ctx);
  if (st !== 'ok') return { kind: st };
  if (++ctx.clicks > CLICK_BUDGET) return { kind: 'budget' };
  const r = ctx.board.tryMove(from, to, ctx.t);
  ctx.bits += r.bitsGained || 0;
  if (r.ok) ctx.valid++;
  else ctx.invalid++;
  if (r.solved) return { kind: 'solved', r };
  if (r.failed || ctx.run.over) return { kind: 'failed', r };
  return { kind: r.ok ? 'move' : 'invalid', r };
}

/** Map a non-move click outcome to the bot loop's next step. */
function settle(ctx, kind) {
  if (kind === 'timeout') return 'restart';
  if (kind === 'solved') ctx.result = 'solved';
  else if (kind === 'failed') ctx.result = 'failed';
  else {
    ctx.result = 'stuck';
    ctx.why = kind === 'budget' ? 'click or timer budget exceeded' : kind;
  }
  return 'done';
}

/** Click an intended (hinted or legal) move. Returns 'ok' | 'restart' | 'done'. */
function step(ctx, from, to) {
  const k = click(ctx, from, to);
  if (k.kind === 'move') return 'ok';
  if (k.kind === 'invalid') throw new Error(`core rejected ${from}->${to}: ${k.r.reason}`);
  return settle(ctx, k.kind);
}

/** Spend an undo or hint press (costs one move-time). */
function actOn(ctx, fn) {
  const st = tick(ctx);
  if (st !== 'ok') return settle(ctx, st);
  fn();
  return 'ok';
}

/** Board pairs (from, to) with from !== to, filtered by legality. */
function pairs(board, wantLegal) {
  const list = [];
  for (let from = 0; from < 3; from++) {
    for (let to = 0; to < 3; to++) {
      if (from !== to && Boolean(board.canMove(from, to).ok) === wantLegal) list.push({ from, to });
    }
  }
  return list;
}

/** Wrong-click phase before an intended move (Human and Random). Each attempt
 *  is a wrong click with probability misRate. afterMisclick may spend undo or
 *  hint. Returns 'ok' | 'restart' | 'done'. */
function misclicks(ctx, rng, afterMisclick) {
  ctx.streak = 0;
  while (ctx.streak < MAX_MISCLICK_STREAK && rng.next() < ctx.spec.misRate) {
    const bad = pairs(ctx.board, false);
    if (!bad.length) break;
    const pair = bad[Math.floor(rng.next() * bad.length)];
    const k = click(ctx, pair.from, pair.to);
    if (k.kind === 'invalid') {
      ctx.streak++;
      if (afterMisclick) {
        const s = afterMisclick(ctx);
        if (s !== 'ok') return s;
      }
    } else if (k.kind === 'move') {
      throw new Error(`wrong click ${pair.from}->${pair.to} was accepted`);
    } else {
      return settle(ctx, k.kind);
    }
  }
  return 'ok';
}

/** Human reaction to misclicks: undo once per sector after a streak of 2 (if it
 *  has charges); one hint only when stuck at 3 consecutive misclicks. */
function humanAfterMisclick(ctx) {
  if (ctx.streak === 2 && !ctx.usedUndo && ctx.run.undoCharges > 0 && ctx.valid > 0) {
    ctx.usedUndo = true;
    ctx.undos++;
    ctx.streak = 0;
    return actOn(ctx, () => ctx.board.undo());
  }
  if (ctx.streak === 3 && !ctx.usedHint && ctx.run.hintsLeft > 0) {
    ctx.usedHint = true;
    ctx.hints++;
    return actOn(ctx, () => ctx.board.useHint());
  }
  return 'ok';
}

function finish(ctx) {
  return {
    outcome: ctx.result, why: ctx.why, t: ctx.t,
    valid: ctx.valid, invalid: ctx.invalid, timeouts: ctx.timeouts,
    undos: ctx.undos, hints: ctx.hints, bits: ctx.bits,
  };
}

/** Optimal: follows board.hint() every move, never misclicks. */
function playOptimal(ctx) {
  for (;;) {
    if (ctx.board.isSolved()) { ctx.result = 'solved'; return finish(ctx); }
    const h = ctx.board.hint();
    if (!h) { ctx.result = 'stuck'; ctx.why = 'no hint while unsolved'; return finish(ctx); }
    if (step(ctx, h.from, h.to) === 'done') return finish(ctx);
  }
}

/** Human: follows the hint path with 4 % misclicks before each move. */
function playHuman(ctx, rng) {
  for (;;) {
    if (ctx.board.isSolved()) { ctx.result = 'solved'; return finish(ctx); }
    const pre = misclicks(ctx, rng, humanAfterMisclick);
    if (pre === 'restart') continue;
    if (pre === 'done') return finish(ctx);
    const h = ctx.board.hint();
    if (!h) { ctx.result = 'stuck'; ctx.why = 'no hint while unsolved'; return finish(ctx); }
    if (step(ctx, h.from, h.to) === 'done') return finish(ctx);
  }
}

/** Random: uniformly random legal moves, 10 % misclicks before each move. */
function playRandom(ctx, rng) {
  for (;;) {
    if (ctx.board.isSolved()) { ctx.result = 'solved'; return finish(ctx); }
    const pre = misclicks(ctx, rng, null);
    if (pre === 'restart') continue;
    if (pre === 'done') return finish(ctx);
    const legal = pairs(ctx.board, true);
    if (!legal.length) { ctx.result = 'stuck'; ctx.why = 'no legal move'; return finish(ctx); }
    const m = legal[Math.floor(rng.next() * legal.length)];
    if (step(ctx, m.from, m.to) === 'done') return finish(ctx);
  }
}

// ---------------------------------------------------------------------------
// Bots: strategy objects with play(), pickCard() and shop().
// ---------------------------------------------------------------------------

function humanOrder(run) {
  return run.sectorNo <= EARLY_PICK_LAST ? HUMAN_EARLY : HUMAN_LATE;
}

/** Lower is better. Curses only count while integrity >= 3; unlisted = Infinity. */
function cardRank(order, id, integrity) {
  if (isCurse(id) && integrity < 3) return Infinity;
  const r = order.indexOf(id);
  return r < 0 ? Infinity : r;
}

/** Best card by rank; if nothing is listed, the first non-curse (or the first card). */
function bestOf(ids, order, integrity) {
  let best = null;
  let bestRank = Infinity;
  for (const id of ids) {
    const r = cardRank(order, id, integrity);
    if (r < bestRank) { best = id; bestRank = r; }
  }
  if (best !== null) return best;
  return ids.find((id) => !isCurse(id)) || ids[0];
}

class Bot {
  constructor(id, rng) {
    this.id = id;
    this.spec = BOT_SPEC[id];
    this.rng = rng;
  }

  /** Drive one sector to 'solved' | 'failed' | 'stuck'. Returns the outcome. */
  play(board, sector, run) {
    const ctx = newPlayCtx(board, run, this.spec);
    if (this.id === 'optimal') return playOptimal(ctx);
    if (this.id === 'human') return playHuman(ctx, this.rng);
    return playRandom(ctx, this.rng);
  }

  /** Choose one card id from the offer. */
  pickCard(offer, run) {
    const ids = offer.map(cardIdOf);
    if (this.id === 'random') return ids[Math.floor(this.rng.next() * ids.length)];
    const order = this.id === 'optimal' ? OPTIMAL_ORDER : humanOrder(run);
    return bestOf(ids, order, run.integrity);
  }

  /** Spend bits on a repair or a reroll before the pick. Returns the final offer. */
  shop(run, offer, rec) {
    const repairAt = this.id === 'random' ? RANDOM_REPAIR_AT : HUMAN_REPAIR_AT;
    if (this.id !== 'optimal' && run.integrity <= repairAt
        && run.bits >= repairCost(run) && buyRepair(run)) {
      rec.repairs++;
    }
    if (this.id === 'human') {
      const order = humanOrder(run);
      const best = Math.min(...offer.map((c) => cardRank(order, cardIdOf(c), run.integrity)));
      // Reroll once if nothing good is offered, keeping enough bits for a repair.
      if (best >= REROLL_RANK && run.bits >= rerollCost(run) + repairCost(run)) {
        const next = reroll(run);
        if (next) {
          rec.rerolls++;
          return Array.isArray(next) ? next : run.offer;
        }
      }
    }
    return offer;
  }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function newRecord(modeId, botId, idx) {
  return {
    modeId, botId, idx,
    reached: 0, win: false, capped: false, stuck: null, exception: null, endReason: null,
    sectorsCleared: 0, score: 0, seconds: 0,
    moves: 0, invalid: 0, timeouts: 0, undos: 0, hints: 0,
    moveBits: 0, bitsEarned: 0, interest: 0, bosses: 0,
    ratings: { S: 0, A: 0, B: 0, C: 0 },
    quests: [],           // { id, done } per evaluated quest
    taken: [],            // card ids picked, in order
    offered: [],          // card ids on the final offer screen of each sector
    rerolls: 0, repairs: 0,
    bitsAt: {},           // sector -> bits on entry (ECON_SECTORS)
    sectorMods: {},       // sector -> { mods, boss }
    sectorInfo: {},       // sector -> { rings, limit }
    sectorTimeouts: {},   // sector -> blitz timeouts
  };
}

function enterSector(rec, sector, run) {
  rec.reached = sector.no;
  rec.sectorInfo[sector.no] = { rings: sector.ringCount, limit: sector.timeLimit ?? null };
  rec.sectorMods[sector.no] = {
    mods: [...(sector.modifiers || [])],
    boss: sector.boss ? sector.boss.id : null,
  };
  if (ECON_SECTORS.includes(sector.no)) rec.bitsAt[sector.no] = run.bits;
}

function accountPlay(rec, sector, out) {
  rec.moves += out.valid;
  rec.invalid += out.invalid;
  rec.timeouts += out.timeouts;
  rec.undos += out.undos;
  rec.hints += out.hints;
  rec.seconds += out.t;
  rec.moveBits += out.bits;
  rec.sectorTimeouts[sector.no] = (rec.sectorTimeouts[sector.no] || 0) + out.timeouts;
}

function accountClear(rec, sector, fin) {
  rec.bitsEarned += fin.bitsEarned || 0;
  rec.interest += fin.interest || 0;
  rec.ratings[fin.rating] = (rec.ratings[fin.rating] || 0) + 1;
  if (sector.isBoss) rec.bosses++;
  for (const q of fin.quests || []) rec.quests.push({ id: q.id, done: Boolean(q.done) });
}

/** Reward screen: offer, optional shop actions, pick, take. */
function rewardScreen(run, bot, rec) {
  const shown = rewardOffer(run);
  const offer = Array.isArray(shown) ? shown : run.offer;
  const finalOffer = bot.shop(run, offer, rec);
  const pick = bot.pickCard(finalOffer, run);
  rec.offered.push(...finalOffer.map(cardIdOf));
  if (!takeCard(run, pick)) throw new Error(`takeCard refused ${pick}`);
  rec.taken.push(pick);
}

function finishRecord(rec, run) {
  rec.sectorsCleared = run.sectorsCleared || 0;
  rec.score = run.score || 0;
  rec.endReason = rec.win ? 'victory'
    : rec.stuck ? 'stuck'
      : rec.exception ? 'exception'
        : rec.capped ? 'cap'
          : (run.endReason || 'unknown');
  const coreTaken = run.stats && run.stats.cardsTaken;
  if (Array.isArray(coreTaken) && coreTaken.length !== rec.taken.length) {
    noteRuntime('run.stats.cardsTaken length differs from the picks made');
  }
}

/** Play one full run. Never throws: exceptions are recorded on the run. */
function playRun(modeId, botId, runSeed, botSeed, idx) {
  const run = createRun({ mode: modeId, seed: runSeed });
  const bot = new Bot(botId, makeRng(botSeed));
  const rec = newRecord(modeId, botId, idx);
  try {
    for (;;) {
      const sector = sectorConfig(run);
      enterSector(rec, sector, run);
      const board = new Board(run, sector);
      const out = bot.play(board, sector, run);
      accountPlay(rec, sector, out);
      if (out.outcome === 'stuck') { rec.stuck = out.why || 'stuck'; break; }
      if (out.outcome === 'failed') break;
      const fin = finishSector(run, board, out.t);
      accountClear(rec, sector, fin);
      if (fin.victory || run.victory) { rec.win = true; break; }
      if (modeId === 'endless' && sector.no >= ENDLESS_CAP) { rec.capped = true; break; }
      rewardScreen(run, bot, rec);
    }
  } catch (err) {
    rec.exception = String((err && err.message) || err);
  }
  finishRecord(rec, run);
  return rec;
}

function runCombo(modeId, botId, count, seed, dailySeed) {
  const recs = [];
  const m = MODE_IDS.indexOf(modeId);
  const b = BOT_IDS.indexOf(botId);
  for (let i = 0; i < count; i++) {
    // Daily: every player gets the same dungeon; only the player's luck varies.
    const runSeed = modeId === 'daily' ? dailySeed : mixSeed(seed, m, i);
    const botSeed = mixSeed(seed, 1000 + b, m, i);
    recs.push(playRun(modeId, botId, runSeed, botSeed, i));
  }
  return recs;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function summarize(recs) {
  const n = recs.length;
  const wins = recs.filter((r) => r.win).length;
  const p = wins / n;
  const ratings = { S: 0, A: 0, B: 0, C: 0 };
  const ends = {};
  let quests = 0;
  let questsDone = 0;
  let bosses = 0;
  let moves = 0;
  let cards = 0;
  let timeouts = 0;
  let stuck = 0;
  let exc = 0;
  for (const r of recs) {
    for (const k of Object.keys(ratings)) ratings[k] += r.ratings[k] || 0;
    for (const q of r.quests) {
      quests++;
      if (q.done) questsDone++;
    }
    bosses += r.bosses;
    moves += r.moves;
    cards += r.taken.length;
    timeouts += r.timeouts;
    if (r.stuck) stuck++;
    if (r.exception) exc++;
    ends[r.endReason] = (ends[r.endReason] || 0) + 1;
  }
  const clears = Object.values(ratings).reduce((a, b) => a + b, 0);
  const minutes = recs.map((r) => r.seconds / 60);
  return {
    n, wins, winRate: p, winCI: 1.96 * Math.sqrt((p * (1 - p)) / n),
    medSector: median(recs.map((r) => r.reached)),
    meanSector: mean(recs.map((r) => r.reached)),
    medMin: median(minutes),
    meanMin: mean(minutes),
    stuck, exc,
    moves: moves / n, cards: cards / n, bosses: bosses / n, timeouts: timeouts / n,
    quests, questsDone,
    questRate: quests ? questsDone / quests : NaN,
    rating: (k) => (clears ? ratings[k] / clears : NaN),
    ends,
  };
}

/** Fraction of runs that entered sector k (reached >= k). */
const fractionReached = (recs, k) => recs.filter((r) => r.reached >= k).length / recs.length;

function bitsOnEntry(recs, k) {
  const xs = recs.filter((r) => r.bitsAt[k] !== undefined).map((r) => r.bitsAt[k]);
  return { avg: mean(xs), n: xs.length };
}

/** Pick rate and win-rate lift per upgrade card. Lift = smoothed win rate of runs
 *  that took the card / smoothed win rate of runs that did not. Flags follow
 *  DESIGN section 11: lift within +-15 % of the mean lift across sampled cards. */
function cardLift(recs) {
  const n = recs.length;
  const wins = recs.filter((r) => r.win).length;
  const rows = [];
  for (const card of UPGRADES) {
    if (card.requires === 'blitz') continue; // blitz-only: never offered in standard
    let shown = 0;
    let picks = 0;
    let withN = 0;
    let withWins = 0;
    for (const r of recs) {
      shown += r.offered.filter((id) => id === card.id).length;
      const k = r.taken.filter((id) => id === card.id).length;
      picks += k;
      if (k > 0) {
        withN++;
        if (r.win) withWins++;
      }
    }
    const withoutN = n - withN;
    const withoutWins = wins - withWins;
    const pt = (withWins + 1) / (withN + 2);
    const pn = (withoutWins + 1) / (withoutN + 2);
    const lift = pt / pn;
    const seRel = Math.sqrt((1 - pt) / ((withN + 2) * pt) + (1 - pn) / ((withoutN + 2) * pn));
    rows.push({
      id: card.id, rarity: card.rarity, shown, picks,
      pickRate: shown ? picks / shown : NaN,
      runsPct: withN / n,
      winTook: withN ? withWins / withN : NaN,
      winNot: withoutN ? withoutWins / withoutN : NaN,
      lift: picks ? lift : NaN,
      seRel,
      sampled: picks > 0 && withN >= LIFT_MIN_N && withoutN >= LIFT_MIN_N,
      dev: NaN,
      flag: '',
    });
  }
  const sampled = rows.filter((r) => r.sampled);
  const meanLift = mean(sampled.map((r) => r.lift));
  for (const r of rows) {
    if (r.sampled) r.dev = r.lift / meanLift - 1;
    if (!r.shown) r.flag = 'never offered';
    else if (!r.picks) r.flag = 'NEVER TAKEN';
    else if (!r.sampled) r.flag = 'low n';
    else if (Math.abs(r.dev) > LIFT_TOLERANCE) r.flag = 'OUT';
  }
  return { rows, meanLift };
}

/** Blitz pace per sector for one bot: minimal solve time (2^rings - 1 moves,
 *  ignoring scramble) against the timer limit. */
function blitzPace(recs, spec) {
  const out = [];
  for (let k = 1; k <= 12; k++) {
    const reach = recs.filter((r) => r.sectorInfo[k]);
    const rings = mean(reach.map((r) => r.sectorInfo[k].rings));
    const limits = reach.map((r) => r.sectorInfo[k].limit).filter((x) => x !== null);
    const limit = mean(limits);
    const pace = Number.isFinite(rings) ? ((2 ** Math.round(rings)) - 1) * spec.moveSec : NaN;
    const timeouts = reach.length
      ? recs.reduce((s, r) => s + (r.sectorTimeouts[k] || 0), 0) / recs.length : NaN;
    out.push({
      sector: k, rings, limit, pace, ratio: pace / limit,
      timeouts, reachPct: reach.length / recs.length,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Fixed-width table. Columns from index `leftCols` on are right-aligned. */
function table(headers, rows, leftCols = 1) {
  const all = [headers, ...rows].map((r) => r.map((c) => String(c)));
  const widths = headers.map((_, c) => Math.max(...all.map((r) => r[c].length)));
  const line = (cells) => cells
    .map((cell, c) => (c < leftCols ? cell.padEnd(widths[c]) : cell.padStart(widths[c])))
    .join('  ')
    .trimEnd();
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(all[0]), sep, ...all.slice(1).map(line)].join('\n');
}

function section(title) {
  return `\n${title}\n${'='.repeat(title.length)}\n`;
}

function check(name, target, value, pass) {
  return { name, target, value, result: pass ? 'PASS' : 'FAIL' };
}

function buildReport(R, opts) {
  const S = {};
  for (const m of MODE_IDS) {
    S[m] = {};
    for (const b of BOT_IDS) S[m][b] = summarize(R[m][b]);
  }
  const std = R.standard.human;
  const lines = [];
  const add = (s = '') => lines.push(s);

  add('HANOI//PROTOCOL balance report');
  add(`seed ${opts.seed} | runs per combo ${opts.runs} | human/standard ${R.standard.human.length} runs`
    + ` (lift power) | daily date ${opts.daily}`);
  add('Bots: ' + BOT_IDS.map((b) => `${BOT_SPEC[b].name} ${BOT_SPEC[b].moveSec} s/move`
    + ` ${(100 * BOT_SPEC[b].misRate).toFixed(0)}% misclicks`).join(' | '));
  add(`Endless stops at sector ${ENDLESS_CAP} (counted as reached). Sector = last sector entered.`);
  add('Wrong clicks, undo and hint presses cost one move-time. Daily uses one dungeon for all runs.');

  // Outcomes
  add(section('1. Outcomes per mode and bot'));
  const outRows = [];
  for (const m of MODE_IDS) {
    for (const b of BOT_IDS) {
      const s = S[m][b];
      outRows.push([m, BOT_SPEC[b].name, s.n, pct(s.winRate), `+-${pct(s.winCI)}`,
        num(s.medSector), num(s.meanSector), num(s.medMin), num(s.meanMin), s.stuck, s.exc]);
    }
  }
  add(table(['Mode', 'Bot', 'Runs', 'Win', '95CI', 'MedSect', 'MeanSect',
    'MedMin', 'MeanMin', 'Stuck', 'Exc'], outRows, 2));

  // Play and ratings
  add(section('2. Play, ratings and quests per mode and bot'));
  const playRows = [];
  for (const m of MODE_IDS) {
    for (const b of BOT_IDS) {
      const s = S[m][b];
      playRows.push([m, BOT_SPEC[b].name, num(s.moves, 0), num(s.cards, 1), num(s.bosses, 2),
        num(s.timeouts, 1), pct(s.questRate, 0), pct(s.rating('S'), 0),
        pct(s.rating('A'), 0), pct(s.rating('B'), 0), pct(s.rating('C'), 0)]);
    }
  }
  add(table(['Mode', 'Bot', 'Moves', 'Cards', 'Bosses', 'Timeouts', 'Quest%',
    'S', 'A', 'B', 'C'], playRows, 2));
  add('Moves = valid moves per run. Bosses = boss sectors cleared per run. Ratings = share of sector clears.');

  // End reasons
  add(section('3. End reasons (run counts)'));
  for (const m of MODE_IDS) {
    for (const b of BOT_IDS) {
      const ends = Object.entries(S[m][b].ends).sort((a, c) => (c[1] - a[1]) || a[0].localeCompare(c[0]));
      add(`${m.padEnd(9)} ${BOT_SPEC[b].name.padEnd(8)} ${ends.map(([k, v]) => `${k} ${v}`).join(', ')}`);
    }
  }

  // Survival
  add(section('4. Survival curve, standard (fraction entering each sector)'));
  const survRows = [];
  for (let k = 1; k <= 12; k++) {
    survRows.push([k, pct(fractionReached(R.standard.human, k), 0),
      pct(fractionReached(R.standard.optimal, k), 0), pct(fractionReached(R.standard.random, k), 0)]);
  }
  add(table(['Sector', 'Human', 'Optimal', 'Random'], survRows, 1));

  // Cards
  add(section('5. Upgrade pick rate and win-rate lift, standard, Human bot'));
  const { rows: cardRows, meanLift } = cardLift(R.standard.human);
  const cardTable = cardRows.map((r) => [
    r.id, r.rarity, r.shown, r.picks, pct(r.pickRate, 0), pct(r.runsPct, 0),
    pct(r.winTook, 1), pct(r.winNot, 1), num(r.lift, 2),
    Number.isFinite(r.dev) ? `${r.dev >= 0 ? '+' : ''}${(100 * r.dev).toFixed(0)}%` : '-',
    `+-${(100 * r.seRel).toFixed(0)}%`, r.flag,
  ]);
  add(table(['Card', 'Rarity', 'Shown', 'Picks', 'Pick%', 'Runs%', 'WinTook', 'WinNot',
    'Lift', 'vsMean', 'SE', 'Flag'], cardTable, 2));
  add(`Mean lift over sampled cards: ${num(meanLift, 3)}. Lift = smoothed win rate with card`
    + ' / without. Pick% = picks / times on the final offer. SE is the one-sigma noise on the lift.');
  add(`Selection bias: runs that survive longer see and take more cards, so survival cards lift most.`);

  // Economy
  add(section('6. Economy, standard'));
  const econ = (b) => {
    const recs = R.standard[b];
    const at = (k) => bitsOnEntry(recs, k);
    return {
      b4: at(4), b8: at(8), b12: at(12),
      rerolls: mean(recs.map((r) => r.rerolls)),
      repairs: mean(recs.map((r) => r.repairs)),
      earned: mean(recs.map((r) => r.moveBits + r.bitsEarned)),
    };
  };
  const eH = econ('human');
  const eO = econ('optimal');
  const eR = econ('random');
  const econRows = [
    ['Avg bits entering sector 4', num(eH.b4.avg, 0), num(eO.b4.avg, 0), num(eR.b4.avg, 0)],
    ['Avg bits entering sector 8', num(eH.b8.avg, 0), num(eO.b8.avg, 0), num(eR.b8.avg, 0)],
    ['Avg bits entering sector 12', num(eH.b12.avg, 0), num(eO.b12.avg, 0), num(eR.b12.avg, 0)],
    ['Runs reaching sector 12', String(eH.b12.n), String(eO.b12.n), String(eR.b12.n)],
    ['Avg rerolls per run', num(eH.rerolls, 2), num(eO.rerolls, 2), num(eR.rerolls, 2)],
    ['Avg repairs per run', num(eH.repairs, 2), num(eO.repairs, 2), num(eR.repairs, 2)],
    ['Avg bits earned per run', num(eH.earned, 0), num(eO.earned, 0), num(eR.earned, 0)],
  ];
  add(table(['Metric', 'Human', 'Optimal', 'Random'], econRows, 1));
  add('Bits earned = move bits + sector-clear bits (interest excluded: see API notes).');

  // Quests
  add(section('7. Quest completion per quest id, standard'));
  const questIds = Array.isArray(HanoiCore.QUESTS)
    ? HanoiCore.QUESTS.map((q) => q.id)
    : [...new Set(R.standard.human.flatMap((r) => r.quests.map((q) => q.id)))].sort();
  const questRate = (recs, id) => {
    const qs = recs.flatMap((r) => r.quests.filter((q) => q.id === id));
    return { rate: qs.length ? qs.filter((q) => q.done).length / qs.length : NaN, n: qs.length };
  };
  const questRows = questIds.map((id) => {
    const h = questRate(R.standard.human, id);
    const o = questRate(R.standard.optimal, id);
    const rnd = questRate(R.standard.random, id);
    return [id, pct(h.rate, 1), pct(o.rate, 1), pct(rnd.rate, 1), h.n];
  });
  add(table(['Quest', 'Human', 'Optimal', 'Random', 'Human n'], questRows, 1));

  // Modifiers
  add(section('8. Modifier and boss frequency by sector, standard, Human bot'));
  const modIds = Array.isArray(HanoiCore.MODIFIERS)
    ? HanoiCore.MODIFIERS.map((m) => m.id)
    : [...new Set(R.standard.human.flatMap((r) => Object.values(r.sectorMods).flatMap((s) => s.mods)))].sort();
  const modRows = [];
  for (let k = 1; k <= 12; k++) {
    const reach = R.standard.human.filter((r) => r.sectorMods[k]);
    const cells = modIds.map((id) => {
      const c = reach.filter((r) => r.sectorMods[k].mods.includes(id)).length;
      return reach.length ? pct(c / reach.length, 0) : '-';
    });
    const bossRec = reach.find((r) => r.sectorMods[k].boss);
    modRows.push([k, ...cells, bossRec ? bossRec.sectorMods[k].boss : '']);
  }
  add(table(['Sector', ...modIds, 'Boss'], modRows, 1));
  add('Percent of Human standard runs entering the sector that have the modifier.');

  // Blitz pace
  add(section('9. Blitz pace: minimal solve time vs timer, per sector'));
  for (const b of ['optimal', 'human']) {
    const pace = blitzPace(R.blitz[b], BOT_SPEC[b]);
    const rows = pace.map((p) => [p.sector, num(p.rings, 0), num(p.limit, 0), num(p.pace, 0),
      num(p.ratio, 2), num(p.timeouts, 2), pct(p.reachPct, 0)]);
    add(`${BOT_SPEC[b].name} bot, blitz`);
    add(table(['Sector', 'Rings', 'Limit s', 'Pace s', 'Pace/Lim', 'Timeouts', 'Reached'], rows, 1));
  }
  add('Pace = (2^rings - 1) moves x bot move time, a lower bound (scramble can shorten it).');

  // Targets
  add(section('10. Balance targets (DESIGN section 11)'));
  const maxRandomWin = Math.max(...MODE_IDS.map((m) => S[m].random.winRate));
  const liftBad = cardRows.filter((r) => r.flag === 'OUT' || r.flag === 'NEVER TAKEN');
  const stuckTotal = MODE_IDS.reduce((s, m) => s + BOT_IDS.reduce((t, b) => t + S[m][b].stuck, 0), 0);
  const excTotal = MODE_IDS.reduce((s, m) => s + BOT_IDS.reduce((t, b) => t + S[m][b].exc, 0), 0);
  const checks = [
    check('Standard, Human: win rate', '15-30%', pct(S.standard.human.winRate),
      inRange(S.standard.human.winRate, 0.15, 0.30)),
    check('Standard, Human: median sector reached', '7-10', num(S.standard.human.medSector),
      inRange(S.standard.human.medSector, 7, 10)),
    check('Standard, Optimal: win rate', '60-85%', pct(S.standard.optimal.winRate),
      inRange(S.standard.optimal.winRate, 0.60, 0.85)),
    check('Endless, Human: median sector reached', '9-13', num(S.endless.human.medSector),
      inRange(S.endless.human.medSector, 9, 13)),
    check('Blitz, Human: win rate', '12-25%', pct(S.blitz.human.winRate),
      inRange(S.blitz.human.winRate, 0.12, 0.25)),
    check('Random: win rate (worst mode)', '< 5%', pct(maxRandomWin), maxRandomWin < 0.05),
    check('Upgrade lift within +-15% of mean', 'every card', `${liftBad.length} flagged`, liftBad.length === 0),
    check('Run length, Human standard (median)', '25-45 min', `${num(S.standard.human.medMin)} min`,
      inRange(S.standard.human.medMin, 25, 45)),
    check('Stuck and exception runs, all combos', '0 / 0', `${stuckTotal} / ${excTotal}`,
      stuckTotal === 0 && excTotal === 0),
  ];
  add(table(['Check', 'Target', 'Value', 'Result'],
    checks.map((c) => [c.name, c.target, c.value, c.result]), 1));

  // Findings
  add(section('11. Findings'));
  const findings = [];
  for (const c of checks) {
    if (c.result === 'FAIL') findings.push(`FAIL ${c.name}: ${c.value} (target ${c.target}).`);
  }
  const hMoves = S.standard.human.moves;
  const winMins = R.standard.human.filter((r) => r.win).map((r) => r.seconds / 60);
  findings.push(`Human standard run length: median ${num(S.standard.human.medMin)} min over all runs,`
    + ` ${num(median(winMins))} min for winners. Mean valid moves per run ${num(hMoves, 0)}`
    + ` (about ${num(hMoves * BOT_SPEC.human.moveSec / 60)} min of clicks). 25 min needs`
    + ` about ${Math.round(25 * 60 / BOT_SPEC.human.moveSec)} moves.`);
  for (const r of liftBad) {
    findings.push(`Card ${r.id}: ${r.flag}, lift ${num(r.lift, 2)} (${Number.isFinite(r.dev)
      ? `${(100 * r.dev).toFixed(0)}% vs mean` : 'unsampled'}), picked in ${pct(r.pickRate, 0)} of offers.`);
  }
  const firstWeak = [...Array(12)].map((_, i) => i + 1)
    .find((k) => fractionReached(R.standard.human, k) < 0.5);
  if (firstWeak) {
    findings.push(`Human standard: fewer than half of the runs enter sector ${firstWeak}`
      + ` (${pct(fractionReached(R.standard.human, firstWeak), 0)}).`);
  }
  for (const b of ['human']) {
    const pace = blitzPace(R.blitz[b], BOT_SPEC[b]);
    const bad = pace.filter((p) => p.reachPct >= 0.1 && p.ratio > 1);
    if (bad.length) {
      findings.push(`Blitz ${BOT_SPEC[b].name}: minimal pace exceeds the timer in sectors `
        + `${bad.map((p) => p.sector).join(', ')}.`);
    }
  }
  if (stuckTotal || excTotal) findings.push(`Stuck ${stuckTotal}, exceptions ${excTotal}: see API notes.`);
  if (!findings.length) findings.push('No target failures.');
  findings.forEach((f) => add(`- ${f}`));

  add(section('12. API notes and runtime messages'));
  const notes = [...apiNotes];
  for (const [msg, count] of runtimeNotes) notes.push(`${msg} (x${count})`);
  const excSamples = new Map();
  for (const m of MODE_IDS) for (const b of BOT_IDS) for (const r of R[m][b]) {
    if (r.exception) excSamples.set(r.exception, (excSamples.get(r.exception) || 0) + 1);
  }
  for (const [msg, count] of [...excSamples].slice(0, 5)) notes.push(`exception: ${msg} (x${count})`);
  const stuckSamples = new Map();
  for (const m of MODE_IDS) for (const b of BOT_IDS) for (const r of R[m][b]) {
    if (r.stuck) stuckSamples.set(`${m}/${b}: ${r.stuck}`, (stuckSamples.get(`${m}/${b}: ${r.stuck}`) || 0) + 1);
  }
  for (const [msg, count] of [...stuckSamples].slice(0, 5)) notes.push(`stuck: ${msg} (x${count})`);
  if (!notes.length) add('None.');
  notes.forEach((n) => add(`- ${n}`));

  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const USAGE = 'usage: node sim.js [--runs N] [--seed S] [--lift-runs L] [--daily YYYYMMDD]';

function parseArgs(argv) {
  const opts = { runs: 300, seed: 1, liftRuns: 3000, daily: DAILY_SEED };
  const toInt = (flag, v, min) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) throw new Error(`${flag} expects an integer >= ${min}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      i++;
      return argv[i];
    };
    if (flag === '--runs') opts.runs = toInt(flag, next(), 1);
    else if (flag === '--seed') opts.seed = toInt(flag, next(), 0);
    else if (flag === '--lift-runs') opts.liftRuns = toInt(flag, next(), 1);
    else if (flag === '--daily') opts.daily = toInt(flag, next(), 1);
    else if (flag === '--help' || flag === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown argument ${flag}\n${USAGE}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  checkPriorityLists();
  const started = Date.now();
  const R = {};
  for (const m of MODE_IDS) {
    R[m] = {};
    for (const b of BOT_IDS) {
      // Human/standard drives the lift analysis, so it gets more runs for power.
      const count = (m === 'standard' && b === 'human') ? Math.max(opts.runs, opts.liftRuns) : opts.runs;
      R[m][b] = runCombo(m, b, count, opts.seed, opts.daily);
    }
  }
  const text = buildReport(R, opts);
  fs.writeFileSync(path.join(__dirname, 'sim-report.txt'), text);
  process.stdout.write(text);
  process.stderr.write(`wall time ${((Date.now() - started) / 1000).toFixed(1)} s (not in report)\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

module.exports = { mixSeed, playRun, Bot, BOT_SPEC };
