/*
 * HanoiCore: pure rules engine for HANOI//PROTOCOL.
 * No DOM, no Kaplay, no modules. Browser: global HanoiCore. Node: module.exports.
 *
 * Decisions where DESIGN.md left room:
 *  - Ring id = size. Sizes are unique per sector, so size doubles as id.
 *  - One type per ring. Special types are rolled per sector, one ring each:
 *    gilded (sector >= 3, mods.gildedChance), ghost (>= 5, mods.ghostChance),
 *    heavy (>= 4, HEAVY_CHANCE), aegis (>= 7, AEGIS_CHANCE). gilded_rush forces
 *    a gilded ring; the Sentinel forces the largest ring to be heavy.
 *  - Target tower (1 or 2) is rolled in sectorConfig, not in the plan.
 *  - Modifier count: none in sector 1, one from sector 2, two from sector 6.
 *    Ascension moves every eligibility check one sector earlier.
 *  - Quest "gilded" counts landings on target. A solved board always has every
 *    ring on target, so "ends on target" would always pass.
 *  - Heavy move costs 2. Exoskeleton (heavyFreePar) makes it cost 1 in both
 *    player cost and par.
 *  - Only "size" rejections cost integrity. "range", "same", "empty", "solved"
 *    and "over" are no-ops with no penalty.
 *  - Undo and timeout do not refund cost units already spent.
 *  - hint() is the first step of an optimal path. It returns null if the
 *    solver hits its state cap (a single ghost stays far below the cap).
 *  - finishSector pre-rolls run.nextPlan = { no, modifierIds, ringTypes, questIds }.
 *    sectorConfig consumes it, so the forecast is exact.
 *  - An upgrade's apply(run) adds ONE stack. takeCard bumps run.upgrades first.
 *  - Blitz bitMult (1.25) multiplies every bit source: moves, gilded, quests, clear.
 *  - Shop: reroll = round((10 + 4 * sectorsCleared) * shopDiscount),
 *    repair = round((20 + 4 * sectorsCleared) * shopDiscount).
 *  - Fallback par (state cap exceeded) is the sum of 2^(n - rank) * edgeCost.
 *    It is exact when every ring starts on one tower and an estimate otherwise.
 *  - Ring count: standard 3 + floor((n-1)/4), boss +1, The Stack fixed at 7.
 *    Endless: base (capped at 9), boss +1, always capped at 9.
 *  - Boss offers swap their last slot for a rare-or-better card unless one is present.
 */

const HanoiCore = (function () {
  'use strict';

  // ------------------------------------------------------------------ constants
  const MAX_RINGS = 9;
  const STACK_RING_COUNT = 7;
  const BASE_INTEGRITY = 3;
  const ASCENSION_INTEGRITY = 2;
  const PHOENIX_REVIVE_INTEGRITY = 2;
  const HEAVY_COST = 2;
  const HEAVY_CHANCE = 0.4;
  const AEGIS_CHANCE = 0.4;
  const CURSE_CHANCE = 0.15;
  const OFFER_SIZE = 3;
  const MIN_COMBO_WINDOW = 1.5;
  const COMBO_STEP = 0.2;
  const INTEREST_CAP = 60;
  const STATIC_DEBT_RATE = 0.1;
  const REROLL_BASE = 10;
  const REPAIR_BASE = 20;
  const SHOP_STEP = 4;
  const QUEST_SCORE = 150;
  const BOSS_SCORE = 500;
  const PAR_STATE_CAP = 300000;
  const PAR_MEMO_LIMIT = 2000;
  const RATING_MULT = { S: 2, A: 1.5, B: 1, C: 0.6 };
  const RARITY_WEIGHTS = { common: 60, rare: 30, epic: 10 };
  const RARE_PLUS_WEIGHTS = { rare: 30, epic: 10 };
  const CURSE_WEIGHTS = { curse: 1 };

  const RING_TYPES = {
    standard: { name: 'Standard', glyph: '●', desc: 'No special rule.' },
    gilded: { name: 'Gilded', glyph: '◆', desc: 'Landing on the target pays a bonus.' },
    ghost: { name: 'Ghost', glyph: '◌', desc: 'Ignores the size rule as mover or target top.' },
    heavy: { name: 'Heavy', glyph: '■', desc: 'Each move costs 2 cost units.' },
    aegis: { name: 'Aegis', glyph: '▲', desc: 'First invalid attempt involving it each sector is forgiven.' },
  };

  const MODES = {
    standard: {
      id: 'standard',
      name: 'Standard',
      tagline: 'Twelve sectors. Four bosses. One signal.',
      sectors: 12,
      timed: false,
      bossEvery: [4, 8, 12],
      bitMult: 1,
    },
    blitz: {
      id: 'blitz',
      name: 'Blitz',
      tagline: 'Every sector is a race against the clock.',
      sectors: 12,
      timed: true,
      bossEvery: [4, 8, 12],
      bitMult: 1.25,
    },
    endless: {
      id: 'endless',
      name: 'Endless',
      tagline: 'No victory. A boss every five sectors.',
      sectors: Infinity,
      timed: false,
      bossEvery: 5,
      bitMult: 1,
    },
    daily: {
      id: 'daily',
      name: 'Daily',
      tagline: "Today's signal, identical for everyone.",
      sectors: 12,
      timed: false,
      bossEvery: [4, 8, 12],
      bitMult: 1,
    },
  };

  // ------------------------------------------------------------------ RNG
  // All run randomness flows through run.rng so a seed reproduces a run.
  function hashString(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function normaliseSeed(seed) {
    if (typeof seed === 'string') return hashString(seed);
    return Number(seed) >>> 0;
  }

  // mulberry32. pick() needs a non-empty array.
  function makeRng(seed) {
    let state = normaliseSeed(seed);
    const rng = {
      next() {
        state = (state + 0x6d2b79f5) | 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      int(lo, hi) {
        return lo + Math.floor(rng.next() * (hi - lo + 1));
      },
      pick(list) {
        return list[Math.floor(rng.next() * list.length)];
      },
      chance(p) {
        return rng.next() < p;
      },
      // Returns a shuffled copy; the input is not mutated.
      shuffle(list) {
        const out = list.slice();
        for (let i = out.length - 1; i > 0; i -= 1) {
          const j = rng.int(0, i);
          const tmp = out[i];
          out[i] = out[j];
          out[j] = tmp;
        }
        return out;
      },
    };
    return rng;
  }

  // ------------------------------------------------------------------ modifiers
  // apply(sector) only writes sector fields. It never draws randomness, so it
  // is safe to run during a pre-roll.
  function raiseClearMult(sector, value) {
    sector.clearMult = Math.max(sector.clearMult, value);
  }

  const MODIFIERS = [
    {
      id: 'surge', name: 'Surge', desc: 'Bits x1.5. Combo window -1 s.', minSector: 2, weight: 3,
      apply(sector) {
        sector.bitMult *= 1.5;
        sector.comboWindowMod -= 1;
        raiseClearMult(sector, 1.5);
      },
    },
    {
      id: 'strict', name: 'Strict', desc: 'Invalid attempts cost 2 integrity. Clear bonus x1.5.', minSector: 2, weight: 3,
      apply(sector) {
        sector.invalidCost = 3;
        raiseClearMult(sector, 1.5);
      },
    },
    {
      id: 'tax', name: 'Tax', desc: 'Each valid move costs 1 bit. Clear bonus x1.5.', minSector: 3, weight: 2,
      apply(sector) {
        sector.taxPerMove = 1;
        raiseClearMult(sector, 1.5);
      },
    },
    {
      id: 'scramble', name: 'Scramble', desc: 'The start layout is randomly distributed.', minSector: 3, weight: 2,
      apply(sector) {
        sector.scramble = true;
      },
    },
    {
      id: 'fog', name: 'Fog', desc: 'Non-top rings are dimmed.', minSector: 4, weight: 2,
      apply(sector) {
        sector.fog = true;
      },
    },
    {
      id: 'overclock', name: 'Overclock', desc: 'Combo cap +2. Combo window -1 s.', minSector: 5, weight: 2,
      apply(sector) {
        sector.comboCapMod += 2;
        sector.comboWindowMod -= 1;
      },
    },
    {
      id: 'gilded_rush', name: 'Gilded Rush', desc: 'A gilded ring is guaranteed. Gilded payout x2.', minSector: 5, weight: 1,
      apply(sector) {
        sector.gildedMult *= 2;
      },
    },
  ];

  // ------------------------------------------------------------------ bosses
  // `sector` is the standard-mode sector where the boss first appears.
  // apply(sector) adjusts ring count; largestType and forcedModifiers feed the
  // pre-roll.
  const BOSSES = {
    sentinel: {
      id: 'sentinel', name: 'Sentinel', sector: 4, rule: '+1 ring. The largest ring is heavy.',
      largestType: 'heavy', forcedModifiers: [],
      apply(sector) {
        sector.ringCount += 1;
      },
    },
    mirror: {
      id: 'mirror', name: 'Mirror Core', sector: 8, rule: 'Forced scramble and strict. +1 ring.',
      largestType: null, forcedModifiers: ['scramble', 'strict'],
      apply(sector) {
        sector.ringCount += 1;
      },
    },
    stack: {
      id: 'stack', name: 'The Stack', sector: 12, rule: '7 rings. Forced gilded rush.',
      largestType: null, forcedModifiers: ['gilded_rush'],
      apply(sector) {
        sector.ringCount = sector.endless ? sector.ringCount + 1 : STACK_RING_COUNT;
      },
    },
  };
  const BOSS_CYCLE = [BOSSES.sentinel, BOSSES.mirror, BOSSES.stack];

  // ------------------------------------------------------------------ upgrades
  // apply(run) adds ONE stack. Stack counts live in run.upgrades.
  const UPGRADES = [
    // Common
    {
      id: 'bit_miner', name: 'Bit Miner', rarity: 'common', max: 3,
      desc: '+1 bit per valid move.',
      apply(run) { run.mods.bitsPerMove += 1; },
    },
    {
      id: 'stability_patch', name: 'Stability Patch', rarity: 'common', max: 2,
      desc: '+1 max integrity and +1 integrity.',
      apply(run) {
        run.maxIntegrity += 1;
        run.integrity += 1;
      },
    },
    {
      id: 'neural_link', name: 'Neural Link', rarity: 'common', max: 3,
      desc: 'Combo window +1 s.',
      apply(run) { run.mods.comboWindow += 1; },
    },
    {
      id: 'hint_pulse', name: 'Hint Pulse', rarity: 'common', max: 2,
      desc: '+1 hint every sector.',
      apply(run) { run.mods.hintsPerSector += 1; },
    },
    {
      id: 'quest_broker', name: 'Quest Broker', rarity: 'common', max: 3,
      desc: 'Quest rewards +30%.',
      apply(run) { run.mods.questBonus += 0.3; },
    },
    {
      id: 'forecast', name: 'Forecast', rarity: 'common', max: 1,
      desc: 'Reveals the next sector on the reward screen.',
      apply(run) { run.mods.forecast = true; },
    },
    {
      id: 'reinforced', name: 'Reinforced', rarity: 'common', max: 1,
      desc: 'First invalid attempt each sector is forgiven.',
      apply(run) { run.mods.reinforced += 1; },
    },
    // Rare
    {
      id: 'interest_engine', name: 'Interest Engine', rarity: 'rare', max: 2,
      desc: 'Gain 10% of held bits at sector end (max 60).',
      apply(run) { run.mods.interestRate += 0.1; },
    },
    {
      id: 'field_repair', name: 'Field Repair', rarity: 'rare', max: 1,
      desc: '+1 integrity at the start of every sector.',
      apply(run) { run.mods.repairPerSector += 1; },
    },
    {
      id: 'undo_buffer', name: 'Undo Buffer', rarity: 'rare', max: 2,
      desc: '+2 undo charges.',
      apply(run) {
        run.mods.undoCharges += 2;
        run.undoCharges += 2;
      },
    },
    {
      id: 'overclock', name: 'Overclock', rarity: 'rare', max: 2,
      desc: 'Combo cap +2 stacks.',
      apply(run) { run.mods.comboCap += 2; },
    },
    {
      id: 'gilded_forge', name: 'Gilded Forge', rarity: 'rare', max: 2,
      desc: 'Gilded chance +25%. Gilded payout x1.5.',
      apply(run) {
        run.mods.gildedChance *= 1.25;
        run.mods.gildedMult *= 1.5;
      },
    },
    {
      id: 'exoskeleton', name: 'Exoskeleton', rarity: 'rare', max: 1,
      desc: 'Heavy rings cost 1 unit.',
      apply(run) { run.mods.heavyFreePar = true; },
    },
    {
      id: 'black_market', name: 'Black Market', rarity: 'rare', max: 1,
      desc: 'Rerolls and repairs cost 40% less.',
      apply(run) { run.mods.shopDiscount = 0.6; },
    },
    {
      id: 'momentum', name: 'Momentum', rarity: 'rare', max: 1,
      desc: '+1 bit per combo stack on each move.',
      apply(run) { run.mods.momentum = true; },
    },
    {
      id: 'time_dilation', name: 'Time Dilation', rarity: 'rare', max: 1, requires: 'blitz',
      desc: 'Blitz timer x1.4.',
      apply(run) { run.mods.timeMult *= 1.4; },
    },
    // Epic
    {
      id: 'recursion', name: 'Recursion', rarity: 'epic', max: 1,
      desc: 'Bits per move +(ring size - 1).',
      apply(run) { run.mods.sizeBits = true; },
    },
    {
      id: 'phoenix_core', name: 'Phoenix Core', rarity: 'epic', max: 2,
      desc: 'Once per run, revive at 2 integrity instead of dying.',
      apply(run) {
        run.phoenixCharges += 1;
        run.mods.phoenixCharges += 1;
      },
    },
    {
      id: 'ghost_protocol', name: 'Ghost Protocol', rarity: 'epic', max: 1,
      desc: 'Ghost chance x2. +2 bits per ghost move.',
      apply(run) {
        run.mods.ghostChance *= 2;
        run.mods.ghostBits += 2;
      },
    },
    {
      id: 'perfect_protocol', name: 'Perfect Protocol', rarity: 'epic', max: 1,
      desc: 'S rating heals 1 and doubles the clear bonus.',
      apply(run) {
        run.mods.sRankHeal += 1;
        run.mods.sRankMult = 2;
      },
    },
    // Curses
    {
      id: 'greed_protocol', name: 'Greed Protocol', rarity: 'curse', max: 1,
      desc: 'Move bits x1.6. Max integrity -1.',
      apply(run) {
        run.mods.curseBitMult *= 1.6;
        run.maxIntegrity = Math.max(1, run.maxIntegrity - 1);
        run.integrity = Math.min(run.integrity, run.maxIntegrity);
      },
    },
    {
      id: 'hair_trigger', name: 'Hair Trigger', rarity: 'curse', max: 1,
      desc: 'Invalid attempts cost 2 integrity. Combo window +2 s.',
      apply(run) {
        run.mods.invalidCost = 3;
        run.mods.comboWindow += 2;
      },
    },
    {
      id: 'static_debt', name: 'Static Debt', rarity: 'curse', max: 1,
      desc: 'Lose 10% of bits each sector. Quest rewards x2.',
      apply(run) {
        run.mods.staticDebt = true;
        run.mods.questBonus += 1;
      },
    },
  ];

  // ------------------------------------------------------------------ quests
  // check(stats, sector) reads board.stats and the sector. A quest pays its
  // reward only when check returns true.
  const QUESTS = [
    {
      id: 'efficient', name: 'Efficient', desc: 'Cost within par + 2.', reward: 25,
      check: (stats, sector) => stats.cost <= sector.par + 2,
    },
    {
      id: 'clean', name: 'Clean', desc: 'Zero invalid attempts.', reward: 20,
      check: (stats) => stats.invalidMoves === 0,
    },
    {
      id: 'chain', name: 'Chain', desc: 'Reach a x2.0 combo multiplier.', reward: 20,
      check: (stats) => stats.maxComboMult >= 2,
    },
    {
      id: 'swift', name: 'Swift', desc: 'Finish within 6 + 1.2 x par seconds.', reward: 20,
      check: (stats, sector) => stats.elapsed <= 6 + 1.2 * sector.par,
    },
    {
      id: 'gilded', name: 'Gilded', desc: 'A gilded ring lands on target.', reward: 25,
      check: (stats) => stats.gildedOnTarget > 0,
    },
    {
      id: 'unassisted', name: 'Unassisted', desc: 'No undo or hint.', reward: 30,
      check: (stats) => stats.assists === 0,
    },
  ];

  // ------------------------------------------------------------------ par solver
  const parMemo = new Map();

  function costOf(ring, heavyCost) {
    return ring.type === 'heavy' ? heavyCost : 1;
  }

  function heavyCostFor(run) {
    return run.mods.heavyFreePar ? 1 : HEAVY_COST;
  }

  // Shared legality rule: a ring may sit on a larger ring, or on anything when
  // either side is a ghost. An empty target is always legal.
  function stackLegal(mover, onto) {
    if (!onto) return true;
    return mover.size < onto.size || mover.type === 'ghost' || onto.type === 'ghost';
  }

  // Works on ring objects and on ring ids alike. Returns null when empty.
  function topOf(tower) {
    return tower.length > 0 ? tower[tower.length - 1] : null;
  }

  function towerKey(idTowers) {
    return idTowers.map((tower) => tower.join(',')).join('|');
  }

  function memoKeyFor(towers, target, heavyCost) {
    const rings = [];
    towers.forEach((tower) => tower.forEach((ring) => rings.push(ring)));
    const ringSig = rings
      .slice()
      .sort((a, b) => a.size - b.size)
      .map((ring) => ring.id + ':' + ring.size + ':' + ring.type)
      .join(',');
    const idTowers = towers.map((tower) => tower.map((ring) => ring.id));
    return [towerKey(idTowers), target, heavyCost, ringSig].join('#');
  }

  // Fallback: n rings moving between two towers. The ring of rank k (1 =
  // smallest) moves 2^(n-k) times.
  function closedFormPar(rings, heavyCost) {
    const sorted = rings.slice().sort((a, b) => a.size - b.size);
    const n = sorted.length;
    let total = 0;
    for (let i = 0; i < n; i += 1) {
      total += Math.pow(2, n - 1 - i) * costOf(sorted[i], heavyCost);
    }
    return total;
  }

  function moveIds(idTowers, from, to) {
    const next = idTowers.slice();
    const moving = topOf(idTowers[from]);
    next[from] = idTowers[from].slice(0, -1);
    next[to] = idTowers[to].concat([moving]);
    return next;
  }

  function rebuildPath(parent, goalKey) {
    const path = [];
    let key = goalKey;
    while (parent.get(key)) {
      const step = parent.get(key);
      path.push({ from: step.from, to: step.to });
      key = step.prev;
    }
    return path.reverse();
  }

  // Dial's algorithm over board states. Edge costs are small integers, so a
  // bucket queue indexed by distance replaces a heap.
  // Returns { cost, path, exact }. path is null when the cap was hit.
  function solveOptimal(towers, target, heavyCost) {
    const rings = [];
    towers.forEach((tower) => tower.forEach((ring) => rings.push(ring)));
    const byId = new Map();
    rings.forEach((ring) => byId.set(ring.id, ring));
    const ringCount = rings.length;
    const startIds = towers.map((tower) => tower.map((ring) => ring.id));
    const startKey = towerKey(startIds);
    const dist = new Map([[startKey, 0]]);
    const parent = new Map([[startKey, null]]);
    const states = new Map([[startKey, startIds]]);
    const buckets = [[startKey]];
    let pending = 1;

    for (let d = 0; pending > 0; d += 1) {
      const bucket = buckets[d] || [];
      buckets[d] = null;
      for (let i = 0; i < bucket.length; i += 1) {
        const key = bucket[i];
        pending -= 1;
        if (dist.get(key) !== d) continue; // stale entry
        const state = states.get(key);
        if (state[target].length === ringCount) {
          return { cost: d, path: rebuildPath(parent, key), exact: true };
        }
        for (let from = 0; from < 3; from += 1) {
          for (let to = 0; to < 3; to += 1) {
            if (from === to || state[from].length === 0) continue;
            const mover = byId.get(topOf(state[from]));
            const ontoId = topOf(state[to]);
            const onto = ontoId === null ? null : byId.get(ontoId);
            if (!stackLegal(mover, onto)) continue;
            const next = moveIds(state, from, to);
            const nextKey = towerKey(next);
            const nextDist = d + costOf(mover, heavyCost);
            const known = dist.get(nextKey);
            if (known !== undefined && known <= nextDist) continue;
            if (known === undefined && dist.size >= PAR_STATE_CAP) {
              return { cost: closedFormPar(rings, heavyCost), path: null, exact: false };
            }
            dist.set(nextKey, nextDist);
            parent.set(nextKey, { prev: key, from, to });
            states.set(nextKey, next);
            if (!buckets[nextDist]) buckets[nextDist] = [];
            buckets[nextDist].push(nextKey);
            pending += 1;
          }
        }
      }
    }
    return { cost: closedFormPar(rings, heavyCost), path: null, exact: false };
  }

  function solveCached(towers, target, heavyCost) {
    const key = memoKeyFor(towers, target, heavyCost);
    let result = parMemo.get(key);
    if (!result) {
      if (parMemo.size >= PAR_MEMO_LIMIT) parMemo.clear();
      result = solveOptimal(towers, target, heavyCost);
      parMemo.set(key, result);
    }
    return result;
  }

  // Minimum cost to put every ring on `target`. opts.heavyCost defaults to 2.
  function parOf(towers, target, opts) {
    if (!Number.isInteger(target) || target < 0 || target > 2) {
      throw new RangeError('parOf: target must be tower 0, 1 or 2');
    }
    const heavyCost = opts && opts.heavyCost ? opts.heavyCost : HEAVY_COST;
    return solveCached(towers, target, heavyCost).cost;
  }

  // ------------------------------------------------------------------ sector generation
  function bossFor(modeId, no) {
    const mode = MODES[modeId];
    if (Array.isArray(mode.bossEvery)) {
      const index = mode.bossEvery.indexOf(no);
      return index < 0 ? null : BOSS_CYCLE[index];
    }
    if (no % mode.bossEvery !== 0) return null;
    return BOSS_CYCLE[(no / mode.bossEvery - 1) % BOSS_CYCLE.length];
  }

  function baseRingCount(no) {
    return 3 + Math.floor((no - 1) / 4);
  }

  function pickWeightedIndex(rng, items) {
    let total = 0;
    items.forEach((item) => { total += item.weight; });
    let roll = rng.next() * total;
    for (let i = 0; i < items.length; i += 1) {
      roll -= items[i].weight;
      if (roll < 0) return i;
    }
    return items.length - 1;
  }

  // 0 modifiers in sector 1, 1 from sector 2, 2 from sector 6 (effective
  // sector number, so ascension shifts it one earlier). Boss forced ones come
  // first and count toward the total.
  function rollModifierIds(run, no, boss) {
    const effective = no + (run.ascension ? 1 : 0);
    let count = 0;
    if (effective >= 2) count = effective >= 6 ? 2 : 1;
    const ids = boss ? boss.forcedModifiers.slice() : [];
    const pool = MODIFIERS.filter((m) => effective >= m.minSector && ids.indexOf(m.id) < 0);
    while (ids.length < count && pool.length > 0) {
      const index = pickWeightedIndex(run.rng, pool);
      ids.push(pool[index].id);
      pool.splice(index, 1);
    }
    return ids;
  }

  // Puts `type` on a random ring that is still standard. No-op if none is left.
  function placeRandomType(run, types, type) {
    const open = [];
    types.forEach((t, i) => {
      if (t === 'standard') open.push(i);
    });
    if (open.length > 0) types[run.rng.pick(open)] = type;
  }

  // types[i] is the type of the ring of size i + 1.
  function rollRingTypes(run, shell, boss) {
    const types = [];
    for (let i = 0; i < shell.ringCount; i += 1) types.push('standard');
    const rng = run.rng;
    const no = shell.no;
    const mods = run.mods;
    if (boss && boss.largestType) types[types.length - 1] = boss.largestType;
    if (shell.modifiers.indexOf('gilded_rush') >= 0) {
      placeRandomType(run, types, 'gilded');
    } else if (no >= 3 && rng.chance(mods.gildedChance)) {
      placeRandomType(run, types, 'gilded');
    }
    if (no >= 5 && rng.chance(mods.ghostChance)) placeRandomType(run, types, 'ghost');
    if (no >= 4 && rng.chance(HEAVY_CHANCE)) placeRandomType(run, types, 'heavy');
    if (no >= 7 && rng.chance(AEGIS_CHANCE)) placeRandomType(run, types, 'aegis');
    return types;
  }

  // One quest per sector; bosses add a second, different one.
  function rollQuestIds(run, ringTypes, isBoss) {
    const hasGilded = ringTypes.indexOf('gilded') >= 0;
    const pool = QUESTS.filter((q) => q.id !== 'gilded' || hasGilded);
    const first = run.rng.pick(pool);
    const ids = [first.id];
    if (isBoss) {
      const rest = pool.filter((q) => q.id !== first.id);
      ids.push(run.rng.pick(rest).id);
    }
    return ids;
  }

  // Everything about a sector except rings, layout and quests. Pure: it draws
  // no randomness, so it can run during a pre-roll.
  function sectorShell(run, no, modifierIds) {
    const mode = MODES[run.mode];
    const boss = bossFor(run.mode, no);
    const sector = {
      no,
      mode: run.mode,
      endless: mode.sectors === Infinity,
      isBoss: boss !== null,
      boss: boss ? { id: boss.id, name: boss.name, rule: boss.rule } : null,
      ringCount: baseRingCount(no),
      modifiers: modifierIds.slice(),
      bitMult: 1,
      clearMult: 1,
      comboWindowMod: 0,
      comboCapMod: 0,
      invalidCost: 2,
      taxPerMove: 0,
      fog: false,
      scramble: false,
      gildedMult: 1,
    };
    modifierIds.forEach((id) => MODIFIERS.find((m) => m.id === id).apply(sector));
    if (boss) boss.apply(sector);
    sector.ringCount = Math.min(MAX_RINGS, sector.ringCount);
    return sector;
  }

  // Pre-rolls a sector's modifiers, ring types and quests. Used for the
  // forecast (finishSector) and as the fallback in sectorConfig.
  function planSector(run, no) {
    const boss = bossFor(run.mode, no);
    const modifierIds = rollModifierIds(run, no, boss);
    const shell = sectorShell(run, no, modifierIds);
    const ringTypes = rollRingTypes(run, shell, boss);
    const questIds = rollQuestIds(run, ringTypes, boss !== null);
    return { no, modifierIds, ringTypes, questIds };
  }

  function buildRings(ringCount, ringTypes) {
    const rings = [];
    for (let size = 1; size <= ringCount; size += 1) {
      rings.push({ id: size, size, type: ringTypes[size - 1] });
    }
    return rings;
  }

  // Tower 0 holds every ring (largest at the bottom). A scrambled start puts
  // rings on random towers, retrying until the target is not already full.
  function buildStart(run, rings, target, scramble) {
    const byDesc = rings.slice().reverse();
    if (scramble) {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const towers = [[], [], []];
        byDesc.forEach((ring) => towers[run.rng.int(0, 2)].push(ring));
        if (towers[target].length < rings.length) return towers;
      }
    }
    return [byDesc, [], []];
  }

  function questInstance(id, no, mods) {
    const def = QUESTS.find((q) => q.id === id);
    return {
      id: def.id,
      name: def.name,
      desc: def.desc,
      reward: Math.round((def.reward + 5 * no) * (1 + mods.questBonus)),
    };
  }

  function countType(rings, type) {
    return rings.filter((ring) => ring.type === type).length;
  }

  // Sector-start effects: static debt, field repair, hint refill.
  function startSectorEffects(run) {
    const mods = run.mods;
    if (mods.staticDebt) run.bits -= Math.floor(run.bits * STATIC_DEBT_RATE);
    if (mods.repairPerSector > 0) {
      run.integrity = Math.min(run.maxIntegrity, run.integrity + mods.repairPerSector);
    }
    run.hintsLeft = mods.hintsPerSector;
  }

  // Advances the run to its next sector. Returns null if the run is over or
  // the mode has no further sectors.
  function sectorConfig(run) {
    const mode = MODES[run.mode];
    const no = run.sectorNo + 1;
    if (run.over || no > mode.sectors) return null;
    const plan = run.nextPlan && run.nextPlan.no === no ? run.nextPlan : planSector(run, no);
    run.nextPlan = null;
    run.sectorNo = no;
    startSectorEffects(run);

    const shell = sectorShell(run, no, plan.modifierIds);
    const rings = buildRings(shell.ringCount, plan.ringTypes);
    const target = run.rng.pick([1, 2]);
    const start = buildStart(run, rings, target, shell.scramble);
    const par = parOf(start, target, { heavyCost: heavyCostFor(run) });
    const questIds = plan.questIds;

    return Object.assign(shell, {
      rings,
      target,
      start,
      par,
      quest: questInstance(questIds[0], no, run.mods),
      bossQuest: questIds.length > 1 ? questInstance(questIds[1], no, run.mods) : null,
      // Blitz clock: (8 + 1.6 x par) seconds, scaled by time_dilation.
      timeLimit: mode.timed ? Math.round((8 + 1.2 * par) * run.mods.timeMult) : null,
      gildedCount: countType(rings, 'gilded'),
      ghostCount: countType(rings, 'ghost'),
      heavyCount: countType(rings, 'heavy'),
      aegisCount: countType(rings, 'aegis'),
    });
  }

  // ------------------------------------------------------------------ run
  function todaySeed() {
    const now = new Date();
    return now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  }

  function defaultMods() {
    return {
      bitsPerMove: 0,
      comboWindow: 4,
      comboCap: 5,
      hintsPerSector: 0,
      questBonus: 0,
      forecast: false,
      reinforced: 0,
      interestRate: 0,
      repairPerSector: 0,
      undoCharges: 0,
      gildedChance: 0.35,
      gildedMult: 1,
      ghostChance: 0.3,
      ghostBits: 0,
      heavyFreePar: false,
      shopDiscount: 1,
      momentum: false,
      timeMult: 1,
      sizeBits: false,
      phoenixCharges: 0,
      sRankHeal: 0,
      sRankMult: 1,
      curseBitMult: 1,
      invalidCost: 2,
      staticDebt: false,
    };
  }

  // options: { mode, seed?, ascension? }. Daily mode without a seed uses
  // today's UTC date as YYYYMMDD.
  function createRun(options) {
    const opts = options || {};
    const modeId = opts.mode || 'standard';
    if (!MODES[modeId]) throw new RangeError('Unknown mode: ' + modeId);
    let seed = opts.seed;
    if (seed === undefined || seed === null) {
      seed = modeId === 'daily' ? todaySeed() : Math.floor(Math.random() * 4294967296);
    }
    const ascension = Boolean(opts.ascension);
    const maxIntegrity = ascension ? ASCENSION_INTEGRITY : BASE_INTEGRITY;
    return {
      mode: modeId,
      seed,
      rng: makeRng(seed),
      ascension,
      sectorNo: 0,
      integrity: maxIntegrity,
      maxIntegrity,
      bits: 0,
      score: 0,
      upgrades: {},
      undoCharges: 0,
      hintsLeft: 0,
      phoenixCharges: 0,
      mods: defaultMods(),
      nextPlan: null,
      offer: null,
      over: false,
      victory: false,
      endReason: null,
      sectorsCleared: 0,
      lastSectorBoss: false,
      stats: { validMoves: 0, invalidMoves: 0, undos: 0, hints: 0, cardsTaken: [] },
    };
  }

  function endRun(run, reason) {
    if (run.over) return;
    run.over = true;
    run.endReason = reason;
    run.score += run.integrity * 100;
  }

  // Returns 'ok', 'revived' or 'dead'. Phoenix Core revives at 2 integrity.
  function loseIntegrity(run, amount, cause) {
    run.integrity -= amount;
    if (run.integrity > 0) return 'ok';
    if (run.phoenixCharges > 0) {
      run.phoenixCharges -= 1;
      run.integrity = Math.min(PHOENIX_REVIVE_INTEGRITY, run.maxIntegrity);
      return 'revived';
    }
    run.integrity = 0;
    endRun(run, cause);
    return 'dead';
  }

  function recordLoss(run, amount, cause, events) {
    const outcome = loseIntegrity(run, amount, cause);
    if (outcome === 'revived') events.push('revive');
    if (outcome === 'dead') events.push('dead');
  }

  // ------------------------------------------------------------------ board
  function isTowerIndex(index) {
    return Number.isInteger(index) && index >= 0 && index <= 2;
  }

  class Board {
    constructor(run, sector) {
      this.run = run;
      this.sector = sector;
      this.towers = sector.start.map((tower) => tower.slice());
      this.history = [];
      this.stacks = 0;
      this.lastMoveT = null;
      this.clock = 0;
      this.timerStart = 0;
      this.aegisForgiven = false;
      this.reinforcedUsed = false;
      this.finished = false;
      // Cached optimal path for hint(): { heavyCost, keys, steps }, where keys[i]
      // is the state before steps[i]. Null until the first hint is computed.
      this.hintPlan = null;
      this.stats = {
        cost: 0,
        validMoves: 0,
        invalidMoves: 0,
        maxComboMult: 1,
        assists: 0,
        elapsed: 0,
        gildedOnTarget: 0,
        undos: 0,
        hints: 0,
        timeouts: 0,
        bitsEarned: 0,
        scoreEarned: 0,
      };
    }

    isSolved() {
      return this.towers[this.sector.target].length === this.sector.rings.length;
    }

    comboWindow() {
      return Math.max(MIN_COMBO_WINDOW, this.run.mods.comboWindow + this.sector.comboWindowMod);
    }

    comboCap() {
      return this.run.mods.comboCap + this.sector.comboCapMod;
    }

    comboMultFor(stacks) {
      return 1 + COMBO_STEP * Math.min(stacks, this.comboCap());
    }

    invalidCost() {
      return Math.max(this.sector.invalidCost, this.run.mods.invalidCost);
    }

    // Every tryMove/timeout result has the same shape; `fields` overrides.
    outcome(fields) {
      return Object.assign({
        ok: false,
        ring: null,
        costUnits: 0,
        bitsGained: 0,
        scoreGained: 0,
        comboStacks: this.stacks,
        comboMult: this.comboMultFor(this.stacks),
        integrityLost: 0,
        forgiven: false,
        events: [],
        solved: this.isSolved(),
        failed: this.run.over,
      }, fields);
    }

    canMove(from, to) {
      if (!isTowerIndex(from) || !isTowerIndex(to)) return { ok: false, reason: 'range' };
      if (this.run.over) return { ok: false, reason: 'over' };
      if (this.isSolved()) return { ok: false, reason: 'solved' };
      if (from === to) return { ok: false, reason: 'same' };
      if (this.towers[from].length === 0) return { ok: false, reason: 'empty' };
      const mover = topOf(this.towers[from]);
      if (!stackLegal(mover, topOf(this.towers[to]))) return { ok: false, reason: 'size' };
      return { ok: true };
    }

    // t = seconds since sector start. Drives the combo window.
    tryMove(from, to, t) {
      const now = Number.isFinite(t) ? t : this.clock;
      this.clock = Math.max(this.clock, now);
      const check = this.canMove(from, to);
      if (check.reason === 'size') return this.rejectSize(from, to);
      if (!check.ok) return this.outcome({ reason: check.reason });
      return this.applyValidMove(from, to, now);
    }

    rejectSize(from, to) {
      const run = this.run;
      const mover = topOf(this.towers[from]);
      const onto = topOf(this.towers[to]);
      const events = ['invalid'];
      this.stats.invalidMoves += 1;
      run.stats.invalidMoves += 1;
      if (this.stacks > 0) events.push('combo-break');
      this.stacks = 0;
      this.lastMoveT = null;
      const forgiven = this.forgive(mover, onto, events);
      let integrityLost = 0;
      if (!forgiven) {
        integrityLost = this.invalidCost();
        recordLoss(run, integrityLost, 'invalid', events);
      }
      return this.outcome({
        reason: 'size',
        ring: mover,
        integrityLost,
        forgiven,
        events,
        failed: run.over,
      });
    }

    // Aegis (first attempt involving one per sector) takes priority over
    // Reinforced (first attempt per sector). Each consumes one forgiveness.
    forgive(mover, onto, events) {
      const aegisInvolved = mover.type === 'aegis' || (onto !== null && onto.type === 'aegis');
      if (!this.aegisForgiven && aegisInvolved) {
        this.aegisForgiven = true;
        events.push('aegis-forgive');
        return true;
      }
      if (!this.reinforcedUsed && this.run.mods.reinforced > 0) {
        this.reinforcedUsed = true;
        events.push('aegis-forgive');
        return true;
      }
      return false;
    }

    applyValidMove(from, to, now) {
      const run = this.run;
      const mods = run.mods;
      const sector = this.sector;
      const modeBit = MODES[run.mode].bitMult;
      const events = ['move'];
      const beforeStacks = this.stacks;
      const beforeLast = this.lastMoveT;

      const ring = this.towers[from].pop();
      const onto = topOf(this.towers[to]);
      const bypass = onto !== null && ring.size > onto.size; // legal only via ghost
      this.towers[to].push(ring);

      // Combo: the first move starts at 0. Later moves extend the chain when
      // they arrive within the window; otherwise the chain resets.
      if (this.lastMoveT === null) {
        this.stacks = 0;
      } else if (now - this.lastMoveT <= this.comboWindow()) {
        this.stacks += 1;
      } else {
        if (this.stacks > 0) events.push('combo-break');
        this.stacks = 0;
      }
      this.lastMoveT = now;
      this.stats.elapsed = now;
      const comboMult = this.comboMultFor(this.stacks);
      this.stats.maxComboMult = Math.max(this.stats.maxComboMult, comboMult);

      const raw = Math.max(0,
        1 + mods.bitsPerMove
        + (mods.sizeBits ? ring.size - 1 : 0)
        + (ring.type === 'ghost' ? mods.ghostBits : 0)
        + (mods.momentum ? this.stacks : 0)
        - sector.taxPerMove);
      const bitMult = modeBit * sector.bitMult * mods.curseBitMult;
      const bits = Math.round(raw * comboMult * bitMult);
      const scoreGained = Math.round(10 * comboMult);

      const costUnits = costOf(ring, heavyCostFor(run));
      this.stats.cost += costUnits;
      if (bypass) events.push('ghost');
      if (ring.type === 'heavy') events.push('heavy');

      let gildedBonus = 0;
      if (to === sector.target) {
        events.push('land-target');
        if (ring.type === 'gilded') {
          gildedBonus = Math.round((4 + sector.no) * mods.gildedMult * sector.gildedMult * modeBit);
          this.stats.gildedOnTarget += 1;
          events.push('gilded');
        }
      }
      const bitsGained = bits + gildedBonus;

      this.history.push({ from, to, ring, beforeStacks, beforeLast });
      this.stats.validMoves += 1;
      run.stats.validMoves += 1;
      this.stats.bitsEarned += bitsGained;
      this.stats.scoreEarned += scoreGained;
      run.bits += bitsGained;
      run.score += scoreGained;
      if (this.isSolved()) events.push('solved');

      return this.outcome({
        ok: true,
        ring,
        costUnits,
        bitsGained,
        scoreGained,
        comboStacks: this.stacks,
        comboMult,
        events,
      });
    }

    // Reverts the last valid move (positions and combo state). Bits, score
    // and cost stay. Spends one undo charge.
    undo() {
      if (this.run.over) return { ok: false, reason: 'over' };
      if (this.isSolved()) return { ok: false, reason: 'solved' };
      if (this.history.length === 0) return { ok: false, reason: 'nothing' };
      if (this.run.undoCharges <= 0) return { ok: false, reason: 'no-charges' };
      const last = this.history.pop();
      this.towers[last.to].pop();
      this.towers[last.from].push(last.ring);
      this.stacks = last.beforeStacks;
      this.lastMoveT = last.beforeLast;
      this.hintPlan = null;
      this.run.undoCharges -= 1;
      this.run.stats.undos += 1;
      this.stats.undos += 1;
      this.stats.assists += 1;
      return { ok: true, ring: last.ring };
    }

    idTowers() {
      return this.towers.map((tower) => tower.map((ring) => ring.id));
    }

    // First step of an optimal path from the current state, or null.
    // Spends nothing and marks nothing. The full path is solved once and kept
    // in hintPlan. While the board sits on that path, each call pops the steps
    // before the current state and returns the next one. Any other state
    // (an off-path move, undo, timeout) triggers a fresh solve.
    hint() {
      if (this.run.over || this.isSolved()) return null;
      const heavyCost = heavyCostFor(this.run);
      const here = towerKey(this.idTowers());
      const plan = this.hintPlan;
      if (plan && plan.heavyCost === heavyCost) {
        const at = plan.keys.indexOf(here);
        if (at >= 0) {
          plan.keys.splice(0, at);
          plan.steps.splice(0, at);
          return { from: plan.steps[0].from, to: plan.steps[0].to };
        }
      }
      const solved = solveCached(this.towers, this.sector.target, heavyCost);
      if (!solved.exact || solved.path.length === 0) {
        this.hintPlan = null;
        return null;
      }
      const steps = solved.path.map((step) => ({ from: step.from, to: step.to }));
      const keys = [];
      let ids = this.idTowers();
      steps.forEach((step) => {
        keys.push(towerKey(ids));
        ids = moveIds(ids, step.from, step.to);
      });
      this.hintPlan = { heavyCost, keys, steps };
      return { from: steps[0].from, to: steps[0].to };
    }

    // Spends a hint charge and marks an assist. Returns null when no charge
    // is left or no hint is available.
    useHint() {
      if (this.run.hintsLeft <= 0) return null;
      const step = this.hint();
      if (!step) return null;
      this.run.hintsLeft -= 1;
      this.run.stats.hints += 1;
      this.stats.hints += 1;
      this.stats.assists += 1;
      return step;
    }

    // Timed sectors only. Costs 1 integrity and resets the board to
    // sector.start. The timer restarts at t (or the last known time).
    timeout(t) {
      if (this.run.over) return { ok: false, reason: 'over' };
      if (this.sector.timeLimit === null) return { ok: false, reason: 'untimed' };
      if (this.isSolved()) return { ok: false, reason: 'solved' };
      const now = Number.isFinite(t) ? t : this.clock;
      this.clock = Math.max(this.clock, now);
      this.timerStart = now;
      this.towers = this.sector.start.map((tower) => tower.slice());
      this.history = [];
      this.stacks = 0;
      this.lastMoveT = null;
      this.hintPlan = null;
      this.stats.timeouts += 1;
      const events = [];
      recordLoss(this.run, 1, 'timeout', events);
      return this.outcome({ ok: true, integrityLost: 1, events });
    }

    // Seconds left on the blitz clock at time t, or null when untimed.
    timeLeft(t) {
      if (this.sector.timeLimit === null) return null;
      const now = Number.isFinite(t) ? t : this.clock;
      return Math.max(0, this.sector.timeLimit - (now - this.timerStart));
    }
  }

  // ------------------------------------------------------------------ sector end
  function ratingFor(cost, par) {
    if (cost <= par) return 'S';
    if (cost <= Math.ceil(par * 1.25)) return 'A';
    if (cost <= Math.ceil(par * 1.75)) return 'B';
    return 'C';
  }

  function gainIntegrity(run, amount) {
    const before = run.integrity;
    run.integrity = Math.min(run.maxIntegrity, run.integrity + amount);
    return run.integrity - before;
  }

  function isVictorySector(run, sector) {
    return sector.isBoss && sector.no === MODES[run.mode].sectors;
  }

  // Closes a solved sector. Returns null if the board is unsolved, already
  // finished, or the run is over. quests[].reward is the offered amount and is
  // paid only when done.
  function finishSector(run, board, t) {
    const sector = board.sector;
    if (board.finished || run.over || !board.isSolved()) return null;
    board.finished = true;
    if (Number.isFinite(t)) board.stats.elapsed = t;
    const stats = board.stats;
    const rating = ratingFor(stats.cost, sector.par);
    run.offer = null;
    run.sectorsCleared += 1;
    run.lastSectorBoss = sector.isBoss;

    let extraBits = 0;
    let extraScore = 0;
    const questList = sector.bossQuest ? [sector.quest, sector.bossQuest] : [sector.quest];
    const quests = questList.map((quest) => {
      const def = QUESTS.find((q) => q.id === quest.id);
      const done = def.check(stats, sector);
      if (done) {
        extraBits += quest.reward;
        extraScore += QUEST_SCORE;
      }
      return { id: quest.id, name: quest.name, done, reward: quest.reward };
    });

    // Clear bonus: the largest single multiplier applies, not a product.
    const ratingMult = RATING_MULT[rating];
    const sMult = rating === 'S' ? run.mods.sRankMult : 1;
    extraBits += Math.round(
      (20 + 8 * sector.no) * ratingMult * MODES[run.mode].bitMult * sector.clearMult * sMult,
    );
    extraScore += Math.round(100 * sector.ringCount * ratingMult);
    if (sector.isBoss) extraScore += BOSS_SCORE;
    run.bits += extraBits;
    run.score += extraScore;

    let healed = 0;
    if (rating === 'S') healed += gainIntegrity(run, run.mods.sRankHeal);
    if (sector.isBoss) healed += gainIntegrity(run, 1);

    const interest = Math.min(INTEREST_CAP, Math.floor(run.bits * run.mods.interestRate));
    run.bits += interest;

    const victory = isVictorySector(run, sector);
    if (victory) {
      run.victory = true;
      endRun(run, 'victory');
    } else if (sector.no < MODES[run.mode].sectors) {
      run.nextPlan = planSector(run, sector.no + 1);
    }

    return {
      rating,
      cost: stats.cost,
      par: sector.par,
      quests,
      bitsEarned: stats.bitsEarned + extraBits,
      scoreEarned: stats.scoreEarned + extraScore,
      interest,
      healed,
      bossReward: sector.isBoss,
      victory,
    };
  }

  // ------------------------------------------------------------------ rewards
  function cardAvailable(run, card) {
    if (card.requires && run.mode !== card.requires) return false;
    return (run.upgrades[card.id] || 0) < card.max;
  }

  function cardPool(run, rarity, taken) {
    return UPGRADES.filter((card) =>
      card.rarity === rarity && cardAvailable(run, card) && taken.indexOf(card.id) < 0);
  }

  function rarityOf(id) {
    return UPGRADES.find((card) => card.id === id).rarity;
  }

  // Picks a rarity by weight, then a card of that rarity. Returns an id or null.
  function rollCard(run, taken, weights) {
    const options = Object.keys(weights)
      .map((rarity) => ({ rarity, weight: weights[rarity] }))
      .filter((option) => cardPool(run, option.rarity, taken).length > 0);
    if (options.length === 0) return null;
    const rarity = options[pickWeightedIndex(run.rng, options)].rarity;
    return run.rng.pick(cardPool(run, rarity, taken)).id;
  }

  function buildOffer(run, excluded) {
    const offer = [];
    let curseDrawn = false;
    for (let slot = 0; slot < OFFER_SIZE; slot += 1) {
      const taken = excluded.concat(offer);
      let id = null;
      if (!curseDrawn && run.rng.chance(CURSE_CHANCE)) {
        id = rollCard(run, taken, CURSE_WEIGHTS);
        if (id !== null) curseDrawn = true;
      }
      if (id === null) id = rollCard(run, taken, RARITY_WEIGHTS);
      if (id === null) break;
      offer.push(id);
    }
    const bossGuarantee = run.lastSectorBoss && offer.length > 0
      && !offer.some((id) => rarityOf(id) === 'rare' || rarityOf(id) === 'epic');
    if (bossGuarantee) {
      const rest = excluded.concat(offer.slice(0, -1));
      const id = rollCard(run, rest, RARE_PLUS_WEIGHTS);
      if (id !== null) offer[offer.length - 1] = id;
    }
    return offer;
  }

  // Returns the three offered card ids. Idempotent until a card is taken or
  // the offer is rerolled.
  function rewardOffer(run) {
    if (run.over) return null;
    if (!run.offer) run.offer = buildOffer(run, []);
    return run.offer.slice();
  }

  function shopCost(base, run) {
    return Math.round((base + SHOP_STEP * run.sectorsCleared) * run.mods.shopDiscount);
  }

  function rerollCost(run) {
    return shopCost(REROLL_BASE, run);
  }

  function repairCost(run) {
    return shopCost(REPAIR_BASE, run);
  }

  // Replaces the offer with a fresh one that avoids the current cards.
  function reroll(run) {
    if (run.over || !run.offer) return null;
    const cost = rerollCost(run);
    if (run.bits < cost) return null;
    run.bits -= cost;
    run.offer = buildOffer(run, run.offer);
    return run.offer.slice();
  }

  // Applies one stack of an offered card and clears the offer.
  function takeCard(run, cardId) {
    if (run.over || !run.offer || run.offer.indexOf(cardId) < 0) return null;
    const card = UPGRADES.find((c) => c.id === cardId);
    if (!card || !cardAvailable(run, card)) return null;
    run.upgrades[cardId] = (run.upgrades[cardId] || 0) + 1;
    card.apply(run);
    run.stats.cardsTaken.push(cardId);
    run.offer = null;
    return card;
  }

  function buyRepair(run) {
    if (run.over || run.integrity >= run.maxIntegrity) return false;
    const cost = repairCost(run);
    if (run.bits < cost) return false;
    run.bits -= cost;
    run.integrity += 1;
    return true;
  }

  // ------------------------------------------------------------------ exports
  return {
    RING_TYPES,
    MODES,
    UPGRADES,
    MODIFIERS,
    QUESTS,
    BOSSES,
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
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = HanoiCore;
else globalThis.HanoiCore = HanoiCore;
