'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const HanoiCore = require('../core.js');

const {
  RING_TYPES,
  MODES,
  UPGRADES,
  MODIFIERS,
  QUESTS,
  createBallSort,
  createCipher,
  finishBonus,
  declineBonus,
  makeRng,
  createRun,
  sectorConfig,
  Board,
  finishSector,
  rewardOffer,
  rerollCost,
  reroll,
  takeCard,
  repairCost,
  buyRepair,
  parOf,
} = HanoiCore;

// ------------------------------------------------------------------ helpers

function ring(size, type) {
  return { id: size, size, type: type || 'standard' };
}

// Bottom to top, each tower must obey the stacking rule.
function legalTower(tower) {
  for (let i = 1; i < tower.length; i += 1) {
    const below = tower[i - 1];
    const above = tower[i];
    const ok = above.size < below.size || above.type === 'ghost' || below.type === 'ghost';
    if (!ok) return false;
  }
  return true;
}

function makeRings(n, typeOf) {
  const rings = [];
  for (let size = 1; size <= n; size += 1) {
    rings.push({ id: size, size, type: typeOf ? typeOf(size) : 'standard' });
  }
  return rings;
}

function allOnTower(rings, index) {
  const towers = [[], [], []];
  towers[index] = rings.slice().reverse();
  return towers;
}

// A board with an explicit layout. A real sector is generated first, then its
// layout is replaced, so every other field keeps its production shape.
function handBoard(towers, opts) {
  const o = opts || {};
  const run = createRun({ mode: o.mode || 'standard', seed: 1 });
  const sector = sectorConfig(run);
  const rings = [];
  towers.forEach((tower) => tower.forEach((r) => rings.push(r)));
  rings.sort((a, b) => a.size - b.size);
  const target = o.target === undefined ? 2 : o.target;
  Object.assign(sector, {
    rings,
    ringCount: rings.length,
    start: towers,
    target,
    par: parOf(towers, target, { reversed: Boolean(sector.reversed) }),
    no: o.no === undefined ? 1 : o.no,
    timeLimit: o.timeLimit === undefined ? null : o.timeLimit,
  });
  return { run, sector, board: new Board(run, sector) };
}

// Plays the board to solved using the free hint. Returns the last time used.
function playWithHints(board, startT) {
  let t = startT || 0;
  for (let guard = 0; !board.isSolved(); guard += 1) {
    assert.ok(guard < 5000, 'solver loop guard tripped');
    const step = board.hint();
    assert.ok(step, 'hint must exist while the board is unsolved');
    const res = board.tryMove(step.from, step.to, t);
    assert.equal(res.ok, true);
    t += 1;
  }
  return t;
}

function sectorsFor(mode, count, seed) {
  const run = createRun({ mode, seed });
  const sectors = [];
  for (let i = 0; i < count; i += 1) sectors.push(sectorConfig(run));
  return sectors;
}

function rarityOf(id) {
  return UPGRADES.find((card) => card.id === id).rarity;
}

// ------------------------------------------------------------------ RNG

test('RNG: same seed gives the same sequence, a different seed does not', () => {
  const a = makeRng(42);
  const b = makeRng(42);
  const c = makeRng(43);
  const seqA = [];
  const seqB = [];
  const seqC = [];
  for (let i = 0; i < 50; i += 1) {
    seqA.push(a.next());
    seqB.push(b.next());
    seqC.push(c.next());
  }
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  assert.ok(seqA.every((v) => v >= 0 && v < 1));
});

test('RNG: int is inclusive, pick returns a member, shuffle permutes without mutation', () => {
  const rng = makeRng(7);
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const v = rng.int(1, 3);
    assert.ok(v >= 1 && v <= 3 && Number.isInteger(v));
    seen.add(v);
  }
  assert.deepEqual([...seen].sort(), [1, 2, 3]);

  const list = ['a', 'b', 'c', 'd'];
  for (let i = 0; i < 20; i += 1) assert.ok(list.includes(rng.pick(list)));

  const input = [1, 2, 3, 4, 5];
  const shuffled = rng.shuffle(input);
  assert.deepEqual(input, [1, 2, 3, 4, 5]);
  assert.deepEqual([...shuffled].sort((x, y) => x - y), [1, 2, 3, 4, 5]);

  assert.equal(rng.chance(0), false);
  assert.equal(rng.chance(1), true);
});

// ------------------------------------------------------------------ run creation

test('createRun: standard defaults', () => {
  const run = createRun({ mode: 'standard', seed: 10 });
  assert.equal(run.sectorNo, 0);
  assert.equal(run.integrity, 3);
  assert.equal(run.maxIntegrity, 3);
  assert.equal(run.bits, 0);
  assert.equal(run.score, 0);
  assert.equal(run.undoCharges, 0);
  assert.equal(run.hintsLeft, 0);
  assert.equal(run.phoenixCharges, 0);
  assert.deepEqual(run.upgrades, {});
  assert.equal(run.mods.comboWindow, 4);
  assert.equal(run.mods.comboCap, 5);
  assert.equal(run.mods.gildedChance, 0.35);
  assert.equal(run.mods.ghostChance, 0.3);
  assert.equal(run.over, false);
  assert.equal(run.victory, false);
  assert.equal(run.endReason, null);
  assert.equal(run.sectorsCleared, 0);
  assert.deepEqual(run.stats.cardsTaken, []);
});

test('createRun: ascension starts at 2 integrity, unknown mode throws', () => {
  const run = createRun({ mode: 'standard', seed: 1, ascension: true });
  assert.equal(run.maxIntegrity, 2);
  assert.equal(run.integrity, 2);
  assert.throws(() => createRun({ mode: 'nope' }), RangeError);
});

test('createRun: daily without a seed uses today as YYYYMMDD (UTC)', () => {
  const now = new Date();
  const expected = now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  assert.equal(createRun({ mode: 'daily' }).seed, expected);
});

test('same seed reproduces the same sectors, different seeds differ', () => {
  const signature = (seed) => sectorsFor('standard', 12, seed).map((s) => JSON.stringify({
    start: s.start,
    mods: s.modifiers,
    target: s.target,
    quest: s.quest.id,
    par: s.par,
  }));
  assert.deepEqual(signature(77), signature(77));
  assert.notDeepEqual(signature(77), signature(78));
});

// ------------------------------------------------------------------ sectors

test('sectorConfig: standard ring counts and boss sizes', () => {
  const counts = sectorsFor('standard', 12, 9).map((s) => s.ringCount);
  assert.deepEqual(counts, [3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 7]);
});

test('sectorConfig: endless ring counts climb and cap at 9', () => {
  const sectors = sectorsFor('endless', 30, 5);
  const counts = sectors.map((s) => s.ringCount);
  assert.equal(counts[0], 3);
  assert.equal(counts[4], 5); // Sentinel (base 4, +1)
  assert.equal(counts[9], 6); // Mirror (base 5, +1)
  assert.equal(counts[14], 7); // Stack (base 6, +1 in endless)
  assert.equal(counts[19], 8); // Sentinel (base 7, +1)
  assert.equal(counts[24], 9); // Mirror (base 9, +1, capped)
  assert.equal(counts[29], 9); // Stack (capped)
  assert.ok(counts.every((c) => c <= 9));
  assert.equal(sectors[4].boss.id, 'sentinel');
  assert.equal(sectors[9].boss.id, 'mirror');
  assert.equal(sectors[14].boss.id, 'stack');
});

test('sectorConfig: boss rules (Sentinel, Mirror Core, The Stack)', () => {
  const sectors = sectorsFor('standard', 12, 9);

  const sentinel = sectors[3];
  assert.equal(sentinel.isBoss, true);
  assert.equal(sentinel.boss.id, 'sentinel');
  assert.equal(sentinel.rings[sentinel.rings.length - 1].type, 'heavy');

  const mirror = sectors[7];
  assert.equal(mirror.boss.id, 'mirror');
  assert.ok(mirror.modifiers.includes('scramble'));
  assert.ok(mirror.modifiers.includes('strict'));
  assert.equal(mirror.scramble, true);

  const stack = sectors[11];
  assert.equal(stack.boss.id, 'stack');
  assert.equal(stack.ringCount, 7);
  assert.ok(stack.modifiers.includes('gilded_rush'));
  assert.ok(stack.gildedCount >= 1);
  assert.ok(stack.bossQuest, 'bosses carry a second quest');
});

test('sectorConfig: modifier counts and eligibility', () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const sectors = sectorsFor('standard', 12, seed);
    assert.equal(sectors[0].modifiers.length, 0, 'no modifiers in sector 1');
    sectors.forEach((s) => {
      assert.ok(s.modifiers.length <= 2);
      if (s.no < 6 && !s.isBoss) assert.ok(s.modifiers.length <= 1);
      s.modifiers.forEach((id) => {
        const def = MODIFIERS.find((m) => m.id === id);
        assert.ok(def.minSector <= s.no, `${id} is not eligible in sector ${s.no}`);
      });
    });
  }
  const run = createRun({ mode: 'standard', seed: 3, ascension: true });
  assert.equal(sectorConfig(run).modifiers.length, 1, 'ascension starts modifiers one sector early');
});

test('sectorConfig: layouts are legal, not already solved, and tower 0 holds all rings unless scrambled', () => {
  for (let seed = 1; seed <= 15; seed += 1) {
    sectorsFor('standard', 12, seed).forEach((s) => {
      const total = s.rings.length;
      assert.ok(s.start.every(legalTower), 'every tower is a legal stack');
      assert.equal(s.start.reduce((n, tower) => n + tower.length, 0), total);
      assert.ok(s.start[s.target].length < total, 'start is not already solved');
      if (!s.scramble) assert.equal(s.start[0].length, total);
      assert.ok(s.rings.every((r) => Object.keys(RING_TYPES).includes(r.type)));
      assert.equal(new Set(s.rings.map((r) => r.id)).size, total, 'ring ids are unique');
    });
  }
});

test('sectorConfig: quest gilded only appears when a gilded ring exists', () => {
  for (let seed = 1; seed <= 15; seed += 1) {
    sectorsFor('standard', 12, seed).forEach((s) => {
      if (s.quest.id === 'gilded' || (s.bossQuest && s.bossQuest.id === 'gilded')) {
        assert.ok(s.gildedCount > 0);
      }
    });
  }
});

// ------------------------------------------------------------------ par solver

test('parOf: n rings from tower 0 to a target is 2^n - 1', () => {
  for (let n = 1; n <= 7; n += 1) {
    const rings = makeRings(n);
    assert.equal(parOf(allOnTower(rings, 0), 2), (2 ** n) - 1, `n=${n} to tower 2`);
    assert.equal(parOf(allOnTower(rings, 0), 1), (2 ** n) - 1, `n=${n} to tower 1`);
  }
});

test('parOf: heavy rings add their extra cost (largest heavy adds 1 move worth)', () => {
  const heavyAt = (size) => makeRings(3, (s) => (s === size ? 'heavy' : 'standard'));
  assert.equal(parOf(allOnTower(heavyAt(3), 0), 2), 8); // largest moves once: +1
  assert.equal(parOf(allOnTower(heavyAt(2), 0), 2), 9); // middle moves twice: +2
  assert.equal(parOf(allOnTower(heavyAt(1), 0), 2), 11); // smallest moves four times: +4
  const rings = heavyAt(3);
  assert.equal(parOf(allOnTower(rings, 0), 2, { heavyCost: 1 }), 7);
});

test('parOf: solved board costs 0, invalid target throws', () => {
  const rings = makeRings(4);
  assert.equal(parOf(allOnTower(rings, 2), 2), 0);
  assert.throws(() => parOf(allOnTower(rings, 0), 3), RangeError);
});

test('parOf: any legal scrambled start is at most 2^n - 1', () => {
  const rng = makeRng(5);
  for (let trial = 0; trial < 40; trial += 1) {
    const n = rng.int(3, 6);
    const rings = makeRings(n);
    const towers = [[], [], []];
    rings.forEach((r) => towers[rng.int(0, 2)].push(r));
    towers.forEach((tower) => tower.sort((a, b) => b.size - a.size));
    const target = rng.pick([1, 2]);
    assert.ok(parOf(towers, target) <= (2 ** n) - 1, `trial ${trial}`);
  }
});

test('parOf: a ghost ring never makes the puzzle harder', () => {
  const rings = makeRings(4, (s) => (s === 2 ? 'ghost' : 'standard'));
  assert.ok(parOf(allOnTower(rings, 0), 2) <= 15);
});

// ------------------------------------------------------------------ canMove

test('canMove: size rule, empty target, same-tower and empty-source rejects', () => {
  const r1 = ring(1);
  const r2 = ring(2);
  const r3 = ring(3);
  const { board } = handBoard([[r3], [r1], [r2]]);
  assert.deepEqual(board.canMove(1, 0), { ok: true }); // 1 onto 3
  assert.equal(board.canMove(0, 1).reason, 'size'); // 3 onto 1
  assert.equal(board.canMove(2, 1).reason, 'size'); // 2 onto 1
  assert.equal(board.canMove(1, 1).reason, 'same');

  const empty = handBoard([[ring(3), ring(2), ring(1)], [], []]).board;
  assert.deepEqual(empty.canMove(0, 1), { ok: true }); // empty target
  assert.equal(empty.canMove(1, 0).reason, 'empty');
});

test('canMove: ghost bypasses the size rule as mover or as target top', () => {
  const ghostTop = handBoard([[ring(3)], [ring(2)], [ring(1, 'ghost')]]).board;
  assert.deepEqual(ghostTop.canMove(0, 2), { ok: true });
  assert.deepEqual(ghostTop.canMove(1, 2), { ok: true });

  const ghostMover = handBoard([[ring(3, 'ghost')], [ring(2)], [ring(1)]]).board;
  assert.deepEqual(ghostMover.canMove(0, 1), { ok: true });
});

test('canMove: solved board rejects, bad indices are range errors', () => {
  const solved = handBoard([[], [], [ring(3), ring(2), ring(1)]]).board;
  assert.equal(solved.canMove(0, 1).reason, 'solved');
  const { board } = handBoard([[ring(3), ring(2), ring(1)], [], []]);
  assert.equal(board.canMove(-1, 0).reason, 'range');
  assert.equal(board.canMove(0, 3).reason, 'range');
  assert.equal(board.canMove(1.5, 0).reason, 'range');
  const res = board.tryMove(0, 3, 0);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'range');
});

// ------------------------------------------------------------------ tryMove penalties

test('tryMove: invalid attempt costs 2 integrity (3 under strict) and is recorded', () => {
  const { run, board } = handBoard([[ring(3)], [ring(1)], [ring(2)]]);
  const res = board.tryMove(0, 1, 0);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'size');
  assert.equal(res.integrityLost, 2);
  assert.equal(run.integrity, 1);
  assert.ok(res.events.includes('invalid'));
  assert.equal(board.stats.invalidMoves, 1);

  const strict = handBoard([[ring(3)], [ring(1)], [ring(2)]]);
  strict.sector.invalidCost = 3;
  assert.equal(strict.board.tryMove(0, 1, 0).integrityLost, 3);
  assert.equal(strict.run.integrity, 0);
});

test('tryMove: aegis forgives the first attempt involving it each sector', () => {
  const { run, board } = handBoard([[ring(3, 'aegis')], [ring(1)], [ring(2)]]);
  const first = board.tryMove(0, 1, 0);
  assert.equal(first.forgiven, true);
  assert.equal(first.integrityLost, 0);
  assert.equal(run.integrity, 3);
  assert.ok(first.events.includes('aegis-forgive'));
  const second = board.tryMove(0, 1, 1);
  assert.equal(second.forgiven, false);
  assert.equal(second.integrityLost, 2);
  assert.equal(run.integrity, 1);
});

test('tryMove: reinforced forgives the first invalid attempt each sector', () => {
  const { run, board } = handBoard([[ring(3)], [ring(1)], [ring(2)]]);
  run.mods.reinforced = 1;
  assert.equal(board.tryMove(0, 1, 0).forgiven, true);
  assert.equal(run.integrity, 3);
  assert.equal(board.tryMove(0, 1, 1).integrityLost, 2);
});

test('tryMove: no-op rejects (same tower, empty source) cost nothing', () => {
  const { run, board } = handBoard([[ring(3), ring(2), ring(1)], [], []]);
  assert.equal(board.tryMove(1, 1, 0).reason, 'same');
  assert.equal(board.tryMove(1, 0, 0).reason, 'empty');
  assert.equal(run.integrity, 3);
  assert.equal(board.stats.invalidMoves, 0);
});

// ------------------------------------------------------------------ combo

test('combo: moves inside the window build the chain, moves outside reset it', () => {
  const { board } = handBoard([[ring(3), ring(2), ring(1)], [], []]);
  const first = board.tryMove(0, 2, 0); // ring 1 to tower 2
  assert.equal(first.comboStacks, 0);
  assert.equal(first.comboMult, 1);

  const within = board.tryMove(0, 1, 3); // ring 2 to tower 1, 3 s later (window 4 s)
  assert.equal(within.comboStacks, 1);
  assert.ok(Math.abs(within.comboMult - 1.2) < 1e-9);

  const outside = board.tryMove(2, 1, 10); // ring 1 onto ring 2, 7 s later
  assert.equal(outside.comboStacks, 0);
  assert.equal(outside.comboMult, 1);
  assert.ok(outside.events.includes('combo-break'));
});

test('combo: the window never drops below 1.5 s', () => {
  const { board, sector } = handBoard([[ring(3), ring(2), ring(1)], [], []]);
  sector.comboWindowMod = -10;
  board.tryMove(0, 2, 0);
  const res = board.tryMove(0, 1, 1.4);
  assert.equal(res.comboStacks, 1);
  const late = board.tryMove(2, 1, 3.5);
  assert.equal(late.comboStacks, 0);
});

// ------------------------------------------------------------------ gilded

test('gilded landing on target pays (4 + sector) bits on top of the move', () => {
  const g = ring(1, 'gilded');
  const { board } = handBoard([[ring(2), g], [], []], { no: 3 });
  const res = board.tryMove(0, 2, 0);
  assert.equal(res.ok, true);
  assert.equal(res.bitsGained, 1 + 7); // base move bit + (4 + 3)
  assert.ok(res.events.includes('gilded'));
  assert.ok(res.events.includes('land-target'));
  assert.equal(board.stats.gildedOnTarget, 1);
});

// ------------------------------------------------------------------ undo

test('undo: restores positions, spends a charge, keeps bits and cost', () => {
  const { run, board } = handBoard([[ring(3), ring(2), ring(1)], [], []]);
  run.undoCharges = 1;
  board.tryMove(0, 2, 0);
  board.tryMove(0, 1, 3);
  const bits = run.bits;
  const cost = board.stats.cost;

  assert.equal(board.undo().ok, true);
  assert.deepEqual(board.towers.map((t) => t.map((r) => r.id)), [[3, 2], [], [1]]);
  assert.equal(run.undoCharges, 0);
  assert.equal(run.bits, bits);
  assert.equal(board.stats.cost, cost);
  assert.equal(board.stats.assists, 1);
  assert.equal(board.stacks, 0, 'combo state is restored');
  assert.equal(board.undo().reason, 'no-charges');
});

// ------------------------------------------------------------------ hints

test('hint: each step lies on an optimal path, so par falls by exactly its cost', () => {
  const run = createRun({ mode: 'standard', seed: 4 });
  for (let i = 0; i < 12; i += 1) {
    const sector = sectorConfig(run);
    const board = new Board(run, sector);
    let t = 0;
    while (!board.isSolved()) {
      const before = parOf(board.towers, sector.target);
      const step = board.hint();
      assert.ok(step, 'hint available while unsolved');
      const res = board.tryMove(step.from, step.to, t);
      assert.equal(res.ok, true);
      assert.equal(before - parOf(board.towers, sector.target), res.costUnits);
      t += 1;
    }
    assert.equal(board.hint(), null, 'no hint once solved');
    assert.equal(board.stats.cost, sector.par, 'hint-only play costs exactly par');
    assert.equal(board.stats.assists, 0, 'hint() marks no assist');
  }
});

// Index of one legal move that is not `avoid`, or null.
function legalMoveOtherThan(board, avoid) {
  for (let from = 0; from < 3; from += 1) {
    for (let to = 0; to < 3; to += 1) {
      const isAvoid = avoid && avoid.from === from && avoid.to === to;
      if (!isAvoid && board.canMove(from, to).ok) return { from, to };
    }
  }
  return null;
}

test('hint cache: steps follow one optimal path, total cost equals a fresh solve', () => {
  const run = createRun({ mode: 'standard', seed: 31 });
  let sector = null;
  for (let i = 0; i < 12; i += 1) sector = sectorConfig(run); // The Stack: 7 rings
  assert.equal(sector.ringCount, 7);
  const fresh = parOf(sector.start, sector.target, { heavyCost: 2 });
  const board = new Board(run, sector);

  let t = 0;
  let plan = null;
  while (!board.isSolved()) {
    const remainingBefore = parOf(board.towers, sector.target);
    const step = board.hint();
    assert.ok(step, 'hint available while unsolved');
    if (plan === null) {
      plan = board.hintPlan;
      assert.ok(plan, 'first hint caches the path');
    }
    assert.equal(board.hintPlan, plan, 'later hints are served from the same cached path');
    const res = board.tryMove(step.from, step.to, t);
    assert.equal(res.ok, true);
    assert.equal(remainingBefore - parOf(board.towers, sector.target), res.costUnits);
    t += 1;
  }
  assert.equal(board.stats.cost, fresh, 'total cost equals a fresh solve');
  assert.equal(board.stats.cost, sector.par);
});

test('hint cache: undo invalidates the cached path and the next hint is still optimal', () => {
  const run = createRun({ mode: 'standard', seed: 31 });
  run.undoCharges = 1;
  let sector = null;
  for (let i = 0; i < 12; i += 1) sector = sectorConfig(run);
  const board = new Board(run, sector);

  const first = board.hint();
  board.tryMove(first.from, first.to, 0);
  const hinted = board.hint();
  const plan = board.hintPlan;
  assert.ok(plan);
  board.tryMove(hinted.from, hinted.to, 1);

  assert.equal(board.undo().ok, true);
  assert.equal(board.hintPlan, null, 'undo drops the cached path');

  const remaining = parOf(board.towers, sector.target);
  const step = board.hint();
  assert.ok(step);
  assert.notEqual(board.hintPlan, plan, 'a fresh path was computed');
  const res = board.tryMove(step.from, step.to, 2);
  assert.equal(remaining - parOf(board.towers, sector.target), res.costUnits);
});

test('hint cache: timeout invalidates the cached path', () => {
  const run = createRun({ mode: 'blitz', seed: 4 });
  const sector = sectorConfig(run);
  const board = new Board(run, sector);
  const step = board.hint();
  board.tryMove(step.from, step.to, 1);
  assert.ok(board.hintPlan);
  board.timeout(5);
  assert.equal(board.hintPlan, null);
  // The board is back at the start, so the next hint must be optimal from there.
  const remaining = parOf(board.towers, sector.target);
  assert.equal(remaining, sector.par);
  const next = board.hint();
  assert.notEqual(board.hintPlan, null);
  const res = board.tryMove(next.from, next.to, 6);
  assert.equal(remaining - parOf(board.towers, sector.target), res.costUnits);
});

test('hint cache: a move off the cached path forces a fresh, still optimal solve', () => {
  const run = createRun({ mode: 'standard', seed: 8 });
  let sector = null;
  for (let i = 0; i < 6; i += 1) sector = sectorConfig(run);
  const board = new Board(run, sector);
  const step = board.hint();
  const plan = board.hintPlan;
  const off = legalMoveOtherThan(board, step);
  assert.ok(off);
  board.tryMove(off.from, off.to, 0);
  assert.equal(board.hintPlan, plan, 'the stale plan is not touched until the next hint');

  const remaining = parOf(board.towers, sector.target);
  const next = board.hint();
  assert.ok(next);
  assert.notEqual(board.hintPlan, plan, 'a fresh path replaced the stale one');
  const res = board.tryMove(next.from, next.to, 1);
  assert.equal(remaining - parOf(board.towers, sector.target), res.costUnits);
});

test('hint cache: exoskeleton makes heavy moves cost 1 along the cached path', () => {
  const heavyTop = ring(3, 'heavy');
  const solveTotal = (exo) => {
    const { run, board } = handBoard([[heavyTop, ring(2), ring(1)], [], []]);
    run.mods.heavyFreePar = exo;
    let t = 0;
    while (!board.isSolved()) {
      const step = board.hint();
      board.tryMove(step.from, step.to, t);
      t += 1;
    }
    return board.stats.cost;
  };
  assert.equal(solveTotal(false), 8); // heavy largest moves once at cost 2
  assert.equal(solveTotal(true), 7);
});

test('useHint: spends a hint charge and marks an assist; null when none left', () => {
  const { run, board } = handBoard([[ring(3), ring(2), ring(1)], [], []]);
  assert.equal(board.useHint(), null, 'no charges');
  run.hintsLeft = 2;
  assert.ok(board.useHint());
  assert.equal(run.hintsLeft, 1);
  assert.equal(board.stats.assists, 1);
});

// ------------------------------------------------------------------ timer

test('blitz timer: limit is (8 + 3.0 x par) seconds', () => {
  const run = createRun({ mode: 'blitz', seed: 2 });
  const sector = sectorConfig(run);
  assert.equal(sector.timeLimit, Math.round((8 + 3.0 * sector.par) * run.mods.timeMult));
  assert.equal(sectorConfig(createRun({ mode: 'standard', seed: 2 })).timeLimit, null);
});

test('timeout: costs 1 integrity, resets the board, keeps cost, restarts the timer', () => {
  const run = createRun({ mode: 'blitz', seed: 2 });
  const sector = sectorConfig(run);
  const board = new Board(run, sector);
  const step = board.hint();
  board.tryMove(step.from, step.to, 1);
  const cost = board.stats.cost;

  const res = board.timeout(10);
  assert.equal(res.ok, true);
  assert.equal(res.integrityLost, 1);
  assert.equal(run.integrity, 2);
  assert.deepEqual(board.towers.map((t) => t.map((r) => r.id)), sector.start.map((t) => t.map((r) => r.id)));
  assert.equal(board.stats.cost, cost);
  assert.equal(board.stacks, 0);
  assert.equal(board.timeLeft(10), sector.timeLimit);
  assert.equal(board.timeLeft(13), sector.timeLimit - 3);
});

test('timeout: untimed sectors refuse, and a timeout can end the run', () => {
  const standard = handBoard([[ring(3), ring(2), ring(1)], [], []]).board;
  assert.equal(standard.timeout(1).reason, 'untimed');
  assert.equal(standard.timeLeft(1), null);

  const { run, board } = handBoard([[ring(3), ring(2), ring(1)], [], []], { timeLimit: 20 });
  run.integrity = 1;
  const res = board.timeout(0);
  assert.equal(run.over, true);
  assert.equal(run.endReason, 'timeout');
  assert.ok(res.events.includes('dead'));
  assert.equal(board.tryMove(0, 2, 1).reason, 'over');
});

// ------------------------------------------------------------------ phoenix

test('phoenix core: revives at 2 integrity once, then death ends the run', () => {
  const { run, board } = handBoard([[ring(3)], [ring(1)], [ring(2)]]);
  run.integrity = 1;
  run.phoenixCharges = 1;
  const res = board.tryMove(0, 1, 0);
  assert.equal(run.over, false);
  assert.equal(run.integrity, 2);
  assert.equal(run.phoenixCharges, 0);
  assert.ok(res.events.includes('revive'));

  run.integrity = 1;
  const dead = board.tryMove(0, 1, 1);
  assert.equal(run.over, true);
  assert.equal(run.endReason, 'invalid');
  assert.equal(run.integrity, 0);
  assert.ok(dead.events.includes('dead'));
  assert.equal(dead.failed, true);
  assert.equal(board.tryMove(0, 2, 2).reason, 'over');
});

// ------------------------------------------------------------------ finishSector

function finishWithCost(cost, par) {
  const run = createRun({ mode: 'standard', seed: 3 });
  const sector = sectorConfig(run);
  const board = new Board(run, sector);
  const t = playWithHints(board, 0);
  sector.par = par;
  board.stats.cost = cost;
  return finishSector(run, board, t);
}

test('finishSector: rating thresholds S / A / B / C', () => {
  assert.equal(finishWithCost(10, 10).rating, 'S');
  assert.equal(finishWithCost(12, 10).rating, 'A');
  assert.equal(finishWithCost(13, 10).rating, 'A'); // ceil(10 x 1.25) = 13
  assert.equal(finishWithCost(14, 10).rating, 'B');
  assert.equal(finishWithCost(18, 10).rating, 'B'); // ceil(10 x 1.75) = 18
  assert.equal(finishWithCost(19, 10).rating, 'C');
});

test('finishSector: an unsolved or already finished board returns null', () => {
  const run = createRun({ mode: 'standard', seed: 3 });
  const sector = sectorConfig(run);
  const board = new Board(run, sector);
  assert.equal(finishSector(run, board, 0), null);
  playWithHints(board, 0);
  assert.ok(finishSector(run, board, 0));
  assert.equal(finishSector(run, board, 0), null);
  assert.equal(run.sectorsCleared, 1);
});

// ------------------------------------------------------------------ victory

test('victory: only a sector-12 boss clear in standard; a full hint-played run wins', () => {
  const run = createRun({ mode: 'standard', seed: 21 });
  for (let no = 1; no <= 12; no += 1) {
    const sector = sectorConfig(run);
    const board = new Board(run, sector);
    const t = playWithHints(board, 0);
    const result = finishSector(run, board, t);
    assert.equal(result.victory, no === 12, `victory flag on sector ${no}`);
    assert.equal(result.bossReward, sector.isBoss);
    if (no === 4) {
      // A boss clear must offer at least one rare-or-better card.
      const offer = rewardOffer(run);
      assert.ok(offer.some((id) => ['rare', 'epic'].includes(rarityOf(id))));
    }
    if (no < 12) {
      assert.equal(run.over, false);
      takeCard(run, rewardOffer(run)[0]);
    }
  }
  assert.equal(run.victory, true);
  assert.equal(run.over, true);
  assert.equal(run.endReason, 'victory');
  assert.equal(sectorConfig(run), null, 'no sector after victory');
});

test('endless never reports victory', () => {
  const run = createRun({ mode: 'endless', seed: 6 });
  for (let no = 1; no <= 5; no += 1) {
    const board = new Board(run, sectorConfig(run));
    const result = finishSector(run, board, playWithHints(board, 0));
    assert.equal(result.victory, false);
    takeCard(run, rewardOffer(run)[0]);
  }
  assert.equal(run.over, false);
});

// ------------------------------------------------------------------ rewards

test('rewardOffer: three distinct cards, stable until taken or rerolled', () => {
  const run = createRun({ mode: 'standard', seed: 8 });
  for (let i = 0; i < 50; i += 1) {
    run.offer = null;
    const offer = rewardOffer(run);
    assert.equal(offer.length, 3);
    assert.equal(new Set(offer).size, 3);
    assert.deepEqual(rewardOffer(run), offer);
  }
});

test('rewardOffer: boss offers always include at least one rare-or-better card', () => {
  const run = createRun({ mode: 'standard', seed: 12 });
  run.lastSectorBoss = true;
  for (let i = 0; i < 200; i += 1) {
    run.offer = null;
    const offer = rewardOffer(run);
    assert.equal(offer.length, 3);
    assert.ok(offer.some((id) => ['rare', 'epic'].includes(rarityOf(id))));
  }
});

test('shop: base costs, black_market discount, sector scaling, spending', () => {
  const run = createRun({ mode: 'standard', seed: 5 });
  run.bits = 1000;
  rewardOffer(run);
  assert.equal(rerollCost(run), 10);
  assert.equal(repairCost(run), 20);

  UPGRADES.find((card) => card.id === 'black_market').apply(run);
  assert.equal(rerollCost(run), 6);
  assert.equal(repairCost(run), 12);

  assert.equal(reroll(run).length, 3);
  assert.equal(run.bits, 994);

  run.integrity = 2;
  assert.equal(buyRepair(run), true);
  assert.equal(run.integrity, 3);
  assert.equal(run.bits, 982);
  assert.equal(buyRepair(run), false, 'no repair at max integrity');

  run.bits = 0;
  run.integrity = 1;
  assert.equal(reroll(run), null, 'unaffordable reroll');
  assert.equal(buyRepair(run), false, 'unaffordable repair');

  const scaled = createRun({ mode: 'standard', seed: 5 });
  scaled.sectorsCleared = 2;
  assert.equal(rerollCost(scaled), 18);
  assert.equal(repairCost(scaled), 28);
});

test('takeCard: only offered cards, applies one stack, clears the offer', () => {
  const run = createRun({ mode: 'standard', seed: 14 });
  const offer = rewardOffer(run);
  const notOffered = UPGRADES.find((card) => !offer.includes(card.id) && !card.requires);
  assert.equal(takeCard(run, notOffered.id), null);
  const card = takeCard(run, offer[0]);
  assert.equal(card.id, offer[0]);
  assert.equal(run.upgrades[card.id], 1);
  assert.equal(run.offer, null);
  assert.equal(run.stats.cardsTaken[0], card.id);
});

test('no card ever exceeds its max stacks, and no offer has two curses', () => {
  const run = createRun({ mode: 'blitz', seed: 9 });
  run.bits = 1e9;
  for (let i = 0; i < 200; i += 1) {
    const offer = rewardOffer(run);
    if (offer.length === 0) break;
    assert.ok(offer.length <= 3);
    assert.ok(offer.filter((id) => rarityOf(id) === 'curse').length <= 1);
    offer.forEach((id) => {
      const card = UPGRADES.find((c) => c.id === id);
      assert.ok((run.upgrades[id] || 0) < card.max, `${id} offered while maxed`);
    });
    if (i % 5 === 4) reroll(run);
    else takeCard(run, offer[0]);
    UPGRADES.forEach((card) => {
      assert.ok((run.upgrades[card.id] || 0) <= card.max, `${card.id} over max`);
    });
  }
});

// ------------------------------------------------------------------ smoke

test('full standard run, hint-played, never throws and reaches a terminal state', () => {
  for (const seed of [1, 2, 3]) {
    const run = createRun({ mode: 'standard', seed });
    let guard = 0;
    while (!run.over && guard < 20) {
      guard += 1;
      const sector = sectorConfig(run);
      if (!sector) break;
      const board = new Board(run, sector);
      const t = playWithHints(board, 0);
      const result = finishSector(run, board, t);
      assert.ok(result);
      const offer = rewardOffer(run);
      if (offer && offer.length > 0) takeCard(run, offer[0]);
    }
    assert.equal(run.over, true);
    assert.equal(run.victory, true);
  }
});

// ------------------------------------------------------------------ v2 helpers

// Every ring on `index` of a `count`-tower layout, largest at the bottom.
function allOnTowerOf(rings, index, count) {
  const towers = Array.from({ length: count }, () => []);
  towers[index] = rings.slice().reverse();
  return towers;
}

// Bottom to top, with the stacking rule of the given direction.
function legalTowerFor(tower, reversed) {
  for (let i = 1; i < tower.length; i += 1) {
    const below = tower[i - 1];
    const above = tower[i];
    const fits = reversed ? above.size > below.size : above.size < below.size;
    if (!(fits || above.type === 'ghost' || below.type === 'ghost')) return false;
  }
  return true;
}

// Plays a Ball Sort board to solved with its hints. Returns the move count.
function playBallSort(board) {
  let moves = 0;
  while (!board.isSolved()) {
    assert.ok(moves < 500, 'ball sort loop guard');
    const step = board.hint();
    assert.ok(step, 'hint exists while unsolved');
    assert.equal(board.tryMove(step.from, step.to).ok, true);
    moves += 1;
  }
  return moves;
}

// Smallest ring on each relay (the top of a standard stack), or null.
function relayTops(assign) {
  const tops = [null, null, null];
  assign.forEach((relay, i) => {
    const size = i + 1;
    if (tops[relay] === null || size < tops[relay]) tops[relay] = size;
  });
  return tops;
}

// Moves the rings of a cipher guess board until ring size i + 1 sits on relay
// target[i]. A plain BFS finds the path, and every move is then applied to the
// real board, so the real rules are what get checked. Returns the move count.
function buildGuess(game, target) {
  const current = [];
  game.board.towers.forEach((tower, relay) => tower.forEach((r) => { current[r.size - 1] = relay; }));
  const goalKey = target.join('');
  const prev = new Map([[current.join(''), null]]);
  const frontier = [current];
  while (frontier.length > 0 && !prev.has(goalKey)) {
    const state = frontier.shift();
    const key = state.join('');
    const tops = relayTops(state);
    for (let from = 0; from < 3; from += 1) {
      for (let to = 0; to < 3; to += 1) {
        if (from === to || tops[from] === null) continue;
        if (tops[to] !== null && tops[from] > tops[to]) continue;
        const next = state.map((relay, i) => (i + 1 === tops[from] ? to : relay));
        const nextKey = next.join('');
        if (prev.has(nextKey)) continue;
        prev.set(nextKey, { from: key, move: [from, to] });
        frontier.push(next);
      }
    }
  }
  assert.ok(prev.has(goalKey), 'guess is reachable');
  const moves = [];
  let key = goalKey;
  while (prev.get(key)) {
    const step = prev.get(key);
    moves.unshift(step.move);
    key = step.from;
  }
  moves.forEach(([from, to]) => {
    assert.equal(game.board.tryMove(from, to, 0).ok, true, 'guess move is legal');
  });
  return moves.length;
}

// Ball Sort runs keep the same run object shape; only sectorNo matters here.
function ballRun(sectorNo) {
  const run = createRun({ mode: 'standard', seed: 21 });
  run.sectorNo = sectorNo;
  return run;
}

// ------------------------------------------------------------------ v2: modes

test('v2 modes: peg4 and reverse are defined; the older modes keep three towers', () => {
  assert.equal(MODES.peg4.towerCount, 4);
  assert.equal(MODES.peg4.reversed, false);
  assert.equal(MODES.peg4.name, 'Quad Relay');
  assert.equal(MODES.reverse.towerCount, 3);
  assert.equal(MODES.reverse.reversed, true);
  assert.equal(MODES.reverse.name, 'Reverse Protocol');
  ['standard', 'blitz', 'endless', 'daily'].forEach((id) => {
    assert.equal(MODES[id].towerCount, 3, id);
    assert.equal(MODES[id].reversed, false, id);
  });
  assert.equal(createRun({ mode: 'peg4', seed: 2 }).mode, 'peg4');
  assert.equal(createRun({ mode: 'reverse', seed: 2 }).mode, 'reverse');
});

test('peg4 sectors: four towers, target 1 to 3, same ring counts as standard', () => {
  assert.deepEqual(sectorsFor('peg4', 12, 9).map((s) => s.ringCount), [3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 7]);
  const targets = new Set();
  for (let seed = 1; seed <= 12; seed += 1) {
    sectorsFor('peg4', 12, seed).forEach((s) => {
      assert.equal(s.towerCount, 4);
      assert.equal(s.start.length, 4);
      assert.equal(s.reversed, false);
      assert.ok([1, 2, 3].includes(s.target));
      targets.add(s.target);
      assert.ok(s.start.every((tower) => legalTowerFor(tower, false)));
      assert.equal(s.start.reduce((n, tower) => n + tower.length, 0), s.rings.length);
      assert.ok(s.start[s.target].length < s.rings.length, 'start is not solved');
      if (!s.scramble) assert.equal(s.start[0].length, s.rings.length);
    });
  }
  assert.deepEqual([...targets].sort(), [1, 2, 3], 'every target relay is used');
});

test('reverse sectors: tower 0 holds 1..n bottom to top, and every layout is reversed-legal', () => {
  const first = sectorConfig(createRun({ mode: 'reverse', seed: 9 }));
  assert.equal(first.reversed, true);
  assert.deepEqual(first.start[0].map((r) => r.size), first.rings.map((r) => r.size));
  for (let seed = 1; seed <= 12; seed += 1) {
    sectorsFor('reverse', 12, seed).forEach((s) => {
      assert.equal(s.towerCount, 3);
      assert.ok([1, 2].includes(s.target));
      assert.ok(s.start.every((tower) => legalTowerFor(tower, true)), `seed ${seed} sector ${s.no}`);
      assert.equal(s.start.reduce((n, tower) => n + tower.length, 0), s.rings.length);
      assert.ok(s.start[s.target].length < s.rings.length, 'start is not solved');
      if (!s.scramble) assert.deepEqual(s.start[0].map((r) => r.size), s.rings.map((r) => r.size));
    });
  }
});

// ------------------------------------------------------------------ v2: towers and par

test('Board range check: 3 and 4 tower boards reject bad indices with reason range', () => {
  const peg = handBoard([[ring(3), ring(2), ring(1)], [], [], []], { mode: 'peg4', target: 3 });
  assert.equal(peg.board.towers.length, 4);
  assert.deepEqual(peg.board.canMove(0, 3), { ok: true }, 'tower 3 exists on peg4');
  assert.equal(peg.board.canMove(0, 4).reason, 'range');
  assert.equal(peg.board.canMove(-1, 0).reason, 'range');
  assert.equal(peg.board.canMove(4, 0).reason, 'range');
  const res = peg.board.tryMove(0, 4, 0);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'range');
  assert.equal(peg.board.stats.invalidMoves, 0);
  assert.equal(peg.run.integrity, 3);

  const tri = handBoard([[ring(3), ring(2), ring(1)], [], []]).board;
  assert.equal(tri.canMove(0, 3).reason, 'range', 'tower 3 does not exist on a 3-tower board');
});

test('Board range check: junk indices are range errors and never throw', () => {
  const { run, board } = handBoard([[ring(3), ring(2), ring(1)], [], []]);
  [NaN, Infinity, -1, 1.5, '0', null, undefined, {}].forEach((v) => {
    assert.equal(board.canMove(v, 0).reason, 'range', String(v));
    assert.equal(board.canMove(0, v).reason, 'range', String(v));
    assert.equal(board.tryMove(0, v, 0).reason, 'range', String(v));
    assert.equal(board.tryMove(v, 0, 0).reason, 'range', String(v));
  });
  assert.equal(run.integrity, 3);
  assert.equal(board.stats.invalidMoves, 0);
});

test('parOf: the target must be a tower index for the tower count', () => {
  const rings = makeRings(3);
  assert.equal(parOf(allOnTowerOf(rings, 0, 4), 3), 5);
  assert.throws(() => parOf(allOnTowerOf(rings, 0, 4), 4), RangeError);
  assert.throws(() => parOf(allOnTowerOf(rings, 0, 3), 3), RangeError);
});

test('peg4 par: 3 rings from tower 0 to tower 3 is 5 (Frame-Stewart), not the 3-tower 7', () => {
  const rings = makeRings(3);
  assert.equal(parOf(allOnTowerOf(rings, 0, 4), 3), 5);
  assert.equal(parOf(allOnTowerOf(rings, 0, 4), 1), 5);
  assert.equal(parOf(allOnTowerOf(rings, 0, 4), 2), 5);
  assert.equal(parOf(allOnTowerOf(rings, 0, 3), 2), 7);
});

test('peg4 par for 1 to 4 rings to tower 3 follows 1, 3, 5, 9', () => {
  [1, 3, 5, 9].forEach((expected, i) => {
    const rings = makeRings(i + 1);
    assert.equal(parOf(allOnTowerOf(rings, 0, 4), 3), expected, `n=${i + 1}`);
  });
});

test('reversed par: plain rings cost 2^n - 1, the same as standard', () => {
  for (let n = 1; n <= 6; n += 1) {
    const rings = makeRings(n);
    const start = [rings.slice(), [], []]; // smallest at the bottom
    assert.equal(parOf(start, 2, { reversed: true }), (2 ** n) - 1, `n=${n}`);
    assert.equal(parOf(start, 1, { reversed: true }), (2 ** n) - 1, `n=${n} to tower 1`);
  }
});

// ------------------------------------------------------------------ v2: reversed rule

test('reversed legality: a ring rests only on a smaller ring; empty towers are always fine', () => {
  const { board } = handBoard([[ring(1), ring(2)], [ring(3)], []], { mode: 'reverse' });
  assert.deepEqual(board.canMove(1, 0), { ok: true }, '3 onto 2 is legal');
  assert.equal(board.canMove(0, 1).reason, 'size', '2 onto 3 is not');
  assert.deepEqual(board.canMove(0, 2), { ok: true }, 'empty tower is always legal');
  assert.equal(board.canMove(1, 1).reason, 'same');
});

test('reversed legality: ghosts bypass the size rule as mover or as target top', () => {
  const ghostOnto = handBoard([[ring(1), ring(2)], [ring(3, 'ghost')], []], { mode: 'reverse' }).board;
  assert.deepEqual(ghostOnto.canMove(0, 1), { ok: true }, 'anything may land on a ghost top');

  const ghostMover = handBoard([[ring(1, 'ghost')], [ring(2)], [ring(3)]], { mode: 'reverse' }).board;
  assert.deepEqual(ghostMover.canMove(0, 1), { ok: true }, 'a ghost may move anywhere');
  assert.equal(ghostMover.canMove(1, 2).reason, 'size', 'ordinary rings still obey the rule');
});

test('reverse: a hint-played run costs exactly par in every sector and stays reversed-legal', () => {
  const run = createRun({ mode: 'reverse', seed: 17 });
  for (let no = 1; no <= 6; no += 1) {
    const sector = sectorConfig(run);
    const board = new Board(run, sector);
    playWithHints(board, 0);
    assert.equal(board.stats.cost, sector.par, `sector ${no}`);
    assert.equal(board.stats.invalidMoves, 0);
    assert.ok(board.towers.every((tower) => legalTowerFor(tower, true)));
  }
});

// ------------------------------------------------------------------ v2: ball sort

test('ball sort: solved means every colour in one tube and no tube mixed', () => {
  const run = ballRun(3);
  assert.equal(createBallSort(run, { tubes: [[0, 0, 0, 0], [1, 1, 1, 1], [], []] }).isSolved(), true);
  assert.equal(createBallSort(run, { tubes: [[0, 0, 0], [1, 1, 1, 1], [0], []] }).isSolved(), false, 'colour 0 in two tubes');
  assert.equal(createBallSort(run, { tubes: [[0, 0, 0, 1], [1, 1, 1, 0], [], []] }).isSolved(), false, 'mixed tubes');
  assert.equal(createBallSort(run, { tubes: [[0, 0, 0, 0], [1, 1, 1, 1], [], []] }).finished, true);
});

test('ball sort: a legal move lands on a matching top or an empty tube, and reports tube-complete', () => {
  const board = createBallSort(ballRun(3), { tubes: [[0, 0, 0, 1], [1, 1, 1], [0], []] });
  assert.deepEqual(board.canMove(0, 1), { ok: true }, 'top 1 onto top 1');
  const first = board.tryMove(0, 1);
  assert.equal(first.ok, true);
  assert.equal(first.color, 1);
  assert.deepEqual(first.events, ['move', 'tube-complete']);
  assert.equal(first.solved, false);
  assert.deepEqual(board.tubes, [[0, 0, 0], [1, 1, 1, 1], [0], []]);
  assert.deepEqual(board.canMove(2, 0), { ok: true }, 'top 0 onto top 0');
  assert.deepEqual(board.canMove(0, 3), { ok: true }, 'top 0 onto an empty tube');
  const last = board.tryMove(2, 0);
  assert.deepEqual(last.events, ['move', 'tube-complete', 'solved']);
  assert.equal(last.solved, true);
  assert.equal(board.moves, 2);
});

test('ball sort: illegal moves change nothing, and only empty, full and mismatch count as invalid', () => {
  const board = createBallSort(ballRun(3), { tubes: [[1, 0], [0, 0, 0, 0], [], [1, 1]], colors: 2 });
  const before = JSON.stringify(board.tubes);
  assert.equal(board.canMove(0, 1).reason, 'full');
  assert.equal(board.canMove(0, 3).reason, 'mismatch');
  assert.equal(board.canMove(2, 0).reason, 'empty');
  assert.equal(board.canMove(0, 0).reason, 'same');
  assert.equal(board.canMove(0, 9).reason, 'range');

  assert.equal(board.tryMove(0, 3).events[0], 'invalid');
  assert.equal(board.invalidMoves, 1);
  assert.equal(board.tryMove(0, 0).events.length, 0, 'same tube is a free cancel');
  assert.equal(board.tryMove(0, 9).events.length, 0, 'range is a free no-op');
  assert.equal(board.invalidMoves, 1);
  assert.equal(board.tryMove(2, 0).reason, 'empty');
  assert.equal(board.invalidMoves, 2);
  assert.equal(JSON.stringify(board.tubes), before);
  assert.equal(board.moves, 0);
});

test('ball sort: colour and tube counts follow the sector, with colours capped at five', () => {
  const expected = { 1: [3, 5], 2: [3, 5], 3: [4, 6], 5: [4, 6], 6: [5, 7], 12: [5, 7] };
  Object.entries(expected).forEach(([no, [colors, tubes]]) => {
    const board = createBallSort(ballRun(Number(no)));
    assert.equal(board.colors, colors, `sector ${no} colours`);
    assert.equal(board.tubes.length, tubes, `sector ${no} tubes`);
    assert.equal(board.tubes.flat().length, colors * 4, 'four balls per colour');
    assert.ok(board.tubes.every((tube) => tube.length <= 4));
    assert.equal(board.isSolved(), false);
  });
});

test('ball sort: generated starts are solvable and hint() plays each one to completion', () => {
  for (const no of [3, 6]) {
    for (let seed = 1; seed <= 4; seed += 1) {
      const run = createRun({ mode: 'standard', seed });
      run.sectorNo = no;
      const board = createBallSort(run);
      assert.equal(board.isSolved(), false, 'a generated start is not solved');
      const moves = playBallSort(board);
      assert.ok(moves >= 8, `sector ${no} seed ${seed} needs ${moves} moves`);
      assert.equal(board.moves, moves);
      assert.equal(board.invalidMoves, 0);
      assert.equal(board.hint(), null, 'no hint once solved');
    }
  }
});

// ------------------------------------------------------------------ v2: cipher

test('cipher feedback: hand-computed black and white counts', () => {
  const cases = [
    { secret: [0, 1, 2, 2], guess: [0, 1, 2, 2], black: 4, white: 0 },
    { secret: [0, 1, 2, 2], guess: [1, 0, 2, 2], black: 2, white: 2 },
    { secret: [0, 0, 1, 2], guess: [1, 1, 1, 1], black: 1, white: 0 },
    { secret: [0, 0, 0, 1], guess: [1, 0, 0, 0], black: 2, white: 2 },
    { secret: [0, 1, 1, 2], guess: [0, 0, 0, 0], black: 1, white: 0 },
  ];
  cases.forEach(({ secret, guess, black, white }) => {
    const game = createCipher(createRun({ mode: 'standard', seed: 3 }), { secret });
    buildGuess(game, guess);
    const result = game.submit();
    assert.equal(result.black, black, `black for ${guess} against ${secret}`);
    assert.equal(result.white, white, `white for ${guess} against ${secret}`);
    assert.deepEqual(result.guess, guess);
  });
});

test('cipher: solving pays the formula, reveals the secret only after finishing, and then locks', () => {
  const run = createRun({ mode: 'standard', seed: 5 });
  run.sectorNo = 3;
  const game = createCipher(run, { secret: [2, 0, 1, 1] });
  assert.equal(game.secret, null);
  buildGuess(game, [0, 0, 0, 0]);
  game.submit();
  assert.equal(game.solved, false);
  assert.equal(game.secret, null, 'still hidden');

  const moves = buildGuess(game, [2, 0, 1, 1]);
  assert.ok(moves > 0);
  const won = game.submit();
  assert.equal(won.black, 4);
  assert.equal(game.solved, true);
  assert.equal(game.guessesUsed, 2);
  assert.deepEqual(game.secret, [2, 0, 1, 1]);
  assert.equal(game.guesses[1].moves, moves, 'moves are counted per guess');
  // (40 + 10 x 3) x (8 - 2 + 1) / 8 = 61.25
  assert.equal(game.reward(), 61);
  assert.equal(game.submit(), null, 'no guess after a solve');
  assert.equal(game.guessesUsed, 2);
});

test('cipher: a solve on the last guess pays the smallest share, and the first guess pays the full amount', () => {
  const run = createRun({ mode: 'standard', seed: 5 });
  run.sectorNo = 3;
  const first = createCipher(run, { secret: [0, 1, 2, 2] });
  buildGuess(first, [0, 1, 2, 2]);
  first.submit();
  assert.equal(first.reward(), 70, '(40 + 30) x 8 / 8');

  const last = createCipher(run, { secret: [0, 1, 2, 2] });
  for (let i = 0; i < 7; i += 1) {
    buildGuess(last, [0, 0, 0, 0]);
    last.submit();
  }
  buildGuess(last, [0, 1, 2, 2]);
  last.submit();
  assert.equal(last.guessesUsed, 8);
  assert.equal(last.reward(), 9, '70 x 1 / 8 = 8.75, rounded');
});

test('cipher: eight guesses without a solve fails, pays the consolation, and reveals the secret', () => {
  const run = createRun({ mode: 'standard', seed: 6 });
  run.sectorNo = 6;
  const game = createCipher(run, { secret: [0, 1, 2, 2] });
  for (let i = 0; i < 8; i += 1) {
    assert.equal(game.secret, null, 'hidden while playing');
    buildGuess(game, [0, 0, 0, 0]);
    game.submit();
  }
  assert.equal(game.failed, true);
  assert.equal(game.solved, false);
  assert.equal(game.reward(), 20, 'consolation');
  assert.deepEqual(game.secret, [0, 1, 2, 2]);
  assert.equal(game.submit(), null, 'no guess after a fail');
});

test('cipher board: illegal moves are no-ops and never touch the run', () => {
  const run = createRun({ mode: 'standard', seed: 7 });
  run.integrity = 2;
  const snapshot = JSON.stringify({ integrity: run.integrity, bits: run.bits, stats: run.stats, over: run.over });
  const game = createCipher(run, { secret: [0, 1, 2, 2] });
  const layout = JSON.stringify(game.board.towers);
  assert.equal(game.board.tryMove(0, 0).reason, 'same');
  assert.equal(game.board.tryMove(1, 2).reason, 'empty');
  assert.equal(game.board.tryMove(0, 5).reason, 'range');
  assert.equal(game.board.moves, 0);
  assert.equal(JSON.stringify(game.board.towers), layout);

  assert.equal(game.board.tryMove(0, 1).ok, true, 'ring 1 onto the empty relay');
  assert.equal(game.board.tryMove(0, 1).reason, 'size', 'ring 2 onto ring 1 is illegal');
  assert.equal(game.board.moves, 1);
  assert.equal(run.integrity, 2);
  assert.equal(JSON.stringify({ integrity: run.integrity, bits: run.bits, stats: run.stats, over: run.over }), snapshot);
});

// ------------------------------------------------------------------ v2: bonus settlement

test('finishBonus: a solved ball sort pays bits, offers a rare-or-better set, and never touches integrity', () => {
  const run = ballRun(3);
  run.integrity = 1;
  run.bits = 10;
  const board = createBallSort(run);
  playBallSort(board);
  const result = finishBonus(run, board);
  assert.equal(result.bits, 30 + 8 * 3, 'ball sort pays 30 + 8 x sector');
  assert.equal(run.bits, 10 + result.bits);
  assert.equal(run.integrity, 1, 'integrity untouched');
  assert.equal(result.offer.length, 3);
  assert.equal(new Set(result.offer).size, 3);
  assert.ok(result.offer.some((id) => ['rare', 'epic'].includes(rarityOf(id))));
  assert.deepEqual(run.offer, result.offer);
  assert.equal(finishBonus(run, board), null, 'a game pays once');
});

test('finishBonus: an unfinished ball sort pays nothing, a failed cipher pays the consolation', () => {
  const run = createRun({ mode: 'standard', seed: 12 });
  run.sectorNo = 6;
  run.bits = 0;
  const sortGame = createBallSort(run);
  assert.equal(finishBonus(run, sortGame), null, 'abandoned ball sort is not paid');

  const cipher = createCipher(run, { secret: [0, 1, 2, 2] });
  assert.equal(finishBonus(run, cipher), null, 'a game in progress is not paid');
  for (let i = 0; i < 8; i += 1) {
    buildGuess(cipher, [0, 0, 0, 0]);
    cipher.submit();
  }
  const result = finishBonus(run, cipher);
  assert.equal(result.bits, 20);
  assert.equal(run.bits, 20);
  assert.ok(result.offer.some((id) => ['rare', 'epic'].includes(rarityOf(id))));
});

test('finishBonus: the rare guarantee survives a reroll, and a finished bonus clears the pending offer', () => {
  const run = ballRun(6);
  run.bits = 1e6;
  run.bonusOffer = { kind: 'sort' };
  const game = createBallSort(run);
  playBallSort(game);
  assert.ok(finishBonus(run, game));
  assert.equal(run.bonusOffer, null, 'a finished bonus clears the pending offer');
  for (let i = 0; i < 30; i += 1) {
    const offer = reroll(run);
    assert.ok(offer, 'reroll affordable');
    assert.ok(offer.some((id) => ['rare', 'epic'].includes(rarityOf(id))), `reroll ${i} keeps a rare`);
  }
});

test('declineBonus: clears a pending offer and reports whether one existed; taking a card clears it too', () => {
  const run = createRun({ mode: 'standard', seed: 13 });
  run.bonusOffer = { kind: 'cipher' };
  assert.equal(declineBonus(run), true);
  assert.equal(run.bonusOffer, null);
  assert.equal(declineBonus(run), false);

  run.bonusOffer = { kind: 'sort' };
  assert.ok(takeCard(run, rewardOffer(run)[0]));
  assert.equal(run.bonusOffer, null, 'taking a card closes the bonus option');
});

test('bonus offer: none in sectors 1-2 or on boss sectors, about 30% elsewhere, reproducible by seed', () => {
  const offersFor = (seed) => {
    const run = createRun({ mode: 'standard', seed });
    const seen = [];
    for (let no = 1; no <= 8; no += 1) {
      const sector = sectorConfig(run);
      const board = new Board(run, sector);
      finishSector(run, board, playWithHints(board, 0));
      seen.push({ no, boss: sector.isBoss, kind: run.bonusOffer ? run.bonusOffer.kind : null });
    }
    return seen;
  };
  let eligible = 0;
  let offered = 0;
  const kinds = new Set();
  for (let seed = 1; seed <= 150; seed += 1) {
    offersFor(seed).forEach(({ no, boss, kind }) => {
      if (no < 3 || boss) {
        assert.equal(kind, null, `sector ${no} (boss ${boss}) never offers a bonus`);
        return;
      }
      eligible += 1;
      if (kind) {
        offered += 1;
        kinds.add(kind);
      }
    });
  }
  const rate = offered / eligible;
  assert.ok(rate > 0.25 && rate < 0.35, `bonus rate ${rate.toFixed(3)} is near 30%`);
  assert.deepEqual([...kinds].sort(), ['cipher', 'sort']);
  assert.deepEqual(offersFor(42), offersFor(42), 'same seed, same bonus offers');
});

// ------------------------------------------------------------------ v2: descriptions

test('descriptions: modifiers and quests have a one-sentence desc and a detail of at most two sentences', () => {
  const sentences = (text) => (text.match(/[.!?](\s|$)/g) || []).length;
  MODIFIERS.concat(QUESTS).forEach((entry) => {
    assert.equal(typeof entry.desc, 'string', `${entry.id} desc`);
    assert.equal(typeof entry.detail, 'string', `${entry.id} detail`);
    assert.equal(sentences(entry.desc), 1, `${entry.id} desc is one sentence`);
    assert.ok(sentences(entry.detail) >= 1 && sentences(entry.detail) <= 2, `${entry.id} detail is one or two sentences`);
  });
});

test('descriptions: every upgrade has a detail sentence that explains its effect', () => {
  UPGRADES.forEach((card) => {
    assert.equal(typeof card.detail, 'string', `${card.id} detail`);
    assert.ok(card.detail.length > card.desc.length / 2, `${card.id} detail is not a stub`);
    assert.ok(card.detail.endsWith('.'), `${card.id} detail ends with a full stop`);
    assert.ok((card.detail.match(/[.!?](\s|$)/g) || []).length <= 2, `${card.id} detail is short`);
  });
});

// ------------------------------------------------------------------ v2: smoke

function playRunToEnd(mode, seed) {
  const run = createRun({ mode, seed });
  let guard = 0;
  while (!run.over && guard < 20) {
    guard += 1;
    const sector = sectorConfig(run);
    if (!sector) break;
    const board = new Board(run, sector);
    const t = playWithHints(board, 0);
    assert.equal(board.stats.cost, sector.par, `${mode} seed ${seed} sector ${sector.no} costs par`);
    const result = finishSector(run, board, t);
    assert.ok(result);
    const offer = rewardOffer(run);
    if (offer && offer.length > 0) takeCard(run, offer[0]);
  }
  return run;
}

test('smoke: full peg4 run, hint-played, reaches victory with every sector at par', () => {
  for (const seed of [1, 2]) {
    const run = playRunToEnd('peg4', seed);
    assert.equal(run.victory, true, `seed ${seed}`);
    assert.equal(run.sectorsCleared, 12);
  }
});

test('smoke: full reverse run, hint-played, reaches victory with every sector at par', () => {
  for (const seed of [1, 2]) {
    const run = playRunToEnd('reverse', seed);
    assert.equal(run.victory, true, `seed ${seed}`);
    assert.equal(run.sectorsCleared, 12);
  }
});
