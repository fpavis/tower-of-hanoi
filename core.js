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
 *  - Target tower (1..towerCount-1) is rolled in sectorConfig, not in the plan.
 *  - Reversed mode: DESIGN 13.1 says "rest only on a larger ring", but its start
 *    layout (tower 0 bottom->top = 1..n) and its "same puzzle with sizes flipped"
 *    claim both need the opposite. Implemented: a ring may rest only on a SMALLER
 *    ring (the inversion of standard). Flagged for the spec owner.
 *  - Bonus games: finishBonus pays only for a finished game (Ball Sort solved;
 *    Cipher solved or failed), so abandoning one cannot buy the rare guarantee.
 *    Bonus bits use the mode bitMult. A bonus offer always has a rare-or-better
 *    card (run.rareGuarantee), and reroll keeps that guarantee.
 *  - finishSector rolls run.bonusOffer after the nextPlan pre-roll, so the next
 *    sector's plan is unchanged for a seed. The bonus roll itself uses run.rng.
 *  - Ball Sort start: a random deal, kept only if the BFS solves it in at least
 *    8 moves. DESIGN 13.5 asks for random legal moves from solved, but measured
 *    solve lengths for that were 2 on average (max 4), too easy to play. Deals
 *    give 8 to 19 moves (3 colours 8-11, 4 colours 8-17, 5 colours 13-19).
 *    Unsolvable deals (about 1 in 120 with 5 colours) are redrawn.
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
  // v2 bonus games
  const BONUS_CHANCE = 0.3;
  const BONUS_FIRST_SECTOR = 3;
  const BALL_SORT_MIN_COLORS = 3;
  const BALL_SORT_COLOR_STEP = 3;
  const BALL_SORT_MAX_COLORS = 5;
  const BALL_SORT_CAPACITY = 4;
  const BALL_SORT_MIN_SOLVE = 8;
  const BALL_SORT_DEAL_ATTEMPTS = 200;
  const BALL_SORT_BITS = 30;
  const BALL_SORT_BITS_PER_SECTOR = 8;
  const CIPHER_PEGS = 4;
  const CIPHER_RELAYS = 3;
  const CIPHER_MAX_GUESSES = 8;
  const CIPHER_BASE_BITS = 40;
  const CIPHER_BITS_PER_SECTOR = 10;
  const CIPHER_CONSOLATION = 20;

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
      towerCount: 3,
      reversed: false,
    },
    blitz: {
      id: 'blitz',
      name: 'Blitz',
      tagline: 'Every sector is a race against the clock.',
      sectors: 12,
      timed: true,
      bossEvery: [4, 8, 12],
      bitMult: 1.25,
      towerCount: 3,
      reversed: false,
    },
    endless: {
      id: 'endless',
      name: 'Endless',
      tagline: 'No victory. A boss every five sectors.',
      sectors: Infinity,
      timed: false,
      bossEvery: 5,
      bitMult: 1,
      towerCount: 3,
      reversed: false,
    },
    daily: {
      id: 'daily',
      name: 'Daily',
      tagline: "Today's signal, identical for everyone.",
      sectors: 12,
      timed: false,
      bossEvery: [4, 8, 12],
      bitMult: 1,
      towerCount: 3,
      reversed: false,
    },
    peg4: {
      id: 'peg4',
      name: 'Quad Relay',
      tagline: 'Four relays. More routes, same signal.',
      sectors: 12,
      timed: false,
      bossEvery: [4, 8, 12],
      bitMult: 1,
      towerCount: 4,
      reversed: false,
    },
    reverse: {
      id: 'reverse',
      name: 'Reverse Protocol',
      tagline: 'Smallest rings at the base. The stacking rule is inverted.',
      sectors: 12,
      timed: false,
      bossEvery: [4, 8, 12],
      bitMult: 1,
      towerCount: 3,
      reversed: true,
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
      id: 'surge',
      name: 'Surge',
      desc: 'Move bits are multiplied by 1.5 and the combo window shrinks by 1 s.',
      detail: 'Every valid move earns 1.5 times its normal bits, and the combo window is 1 s shorter (never under 1.5 s). The clear bonus is also multiplied by 1.5 for this sector.',
      minSector: 2,
      weight: 3,
      apply(sector) {
        sector.bitMult *= 1.5;
        sector.comboWindowMod -= 1;
        raiseClearMult(sector, 1.5);
      },
    },
    {
      id: 'strict',
      name: 'Strict',
      desc: 'Invalid attempts cost 3 integrity and the clear bonus is multiplied by 1.5.',
      detail: 'Each invalid attempt costs 3 integrity instead of the base 2, unless Aegis or Reinforced forgives it. The clear bonus is multiplied by 1.5, and clear multipliers from other modifiers do not stack with it.',
      minSector: 2,
      weight: 3,
      apply(sector) {
        sector.invalidCost = 3;
        raiseClearMult(sector, 1.5);
      },
    },
    {
      id: 'tax',
      name: 'Tax',
      desc: 'Each valid move earns 1 bit less, never below zero, and the clear bonus is multiplied by 1.5.',
      detail: 'A valid move loses 1 from its bit income, so a plain move with no bit upgrades earns nothing. Gilded landings are not reduced, and the clear bonus is multiplied by 1.5.',
      minSector: 3,
      weight: 2,
      apply(sector) {
        sector.taxPerMove = 1;
        raiseClearMult(sector, 1.5);
      },
    },
    {
      id: 'scramble',
      name: 'Scramble',
      desc: 'The rings start spread across the towers instead of stacked on tower 0.',
      detail: 'Rings begin on random towers in a legal order, and the layout is never already solved. Par is recomputed by the solver for the layout you are given.',
      minSector: 3,
      weight: 2,
      apply(sector) {
        sector.scramble = true;
      },
    },
    {
      id: 'fog',
      name: 'Fog',
      desc: 'Non-top rings hide their size numbers.',
      detail: 'Every ring that is not the top ring of its tower is drawn without its size number, at the same width as the top ring and in a neutral colour. The rules are unchanged, so you must remember the sizes to stay safe.',
      minSector: 4,
      weight: 2,
      apply(sector) {
        sector.fog = true;
      },
    },
    {
      id: 'overclock',
      name: 'Overclock',
      desc: 'The combo cap rises by 2 stacks and the combo window shrinks by 1 s.',
      detail: 'The combo multiplier can climb two more steps, so the cap moves from x2.0 at five stacks to x2.4 at seven. The combo window is also 1 s shorter, so a move must follow the last one more quickly to extend the chain.',
      minSector: 5,
      weight: 2,
      apply(sector) {
        sector.comboCapMod += 2;
        sector.comboWindowMod -= 1;
      },
    },
    {
      id: 'gilded_rush',
      name: 'Gilded Rush',
      desc: 'A gilded ring is guaranteed and gilded payouts are doubled.',
      detail: 'The sector always contains at least one gilded ring, and each gilded ring that lands on the target pays twice the usual gilded bonus. The Stack boss always uses this modifier.',
      minSector: 5,
      weight: 1,
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
      detail: 'Every valid move earns one extra base bit before the combo and bit multipliers are applied.',
      apply(run) { run.mods.bitsPerMove += 1; },
    },
    {
      id: 'stability_patch', name: 'Stability Patch', rarity: 'common', max: 2,
      desc: '+1 max integrity and +1 integrity.',
      detail: 'Raises maximum integrity by 1 and adds 1 integrity straight away. It can be taken up to two times.',
      apply(run) {
        run.maxIntegrity += 1;
        run.integrity += 1;
      },
    },
    {
      id: 'neural_link', name: 'Neural Link', rarity: 'common', max: 3,
      desc: 'Combo window +1 s.',
      detail: 'Extends the combo window by 1 s, so moves can be spaced further apart without breaking a chain. It can be taken up to three times.',
      apply(run) { run.mods.comboWindow += 1; },
    },
    {
      id: 'hint_pulse', name: 'Hint Pulse', rarity: 'common', max: 2,
      desc: '+1 hint every sector.',
      detail: 'Each sector starts with this many hints, and unused hints do not carry over to the next sector.',
      apply(run) { run.mods.hintsPerSector += 1; },
    },
    {
      id: 'quest_broker', name: 'Quest Broker', rarity: 'common', max: 3,
      desc: 'Quest rewards +30%.',
      detail: 'Each stack raises quest rewards by 30%, so a boss sector with two quests pays more for each one completed.',
      apply(run) { run.mods.questBonus += 0.3; },
    },
    {
      id: 'forecast', name: 'Forecast', rarity: 'common', max: 1,
      desc: 'Reveals the next sector on the reward screen.',
      detail: 'The reward screen shows the modifiers and quest of the next sector before you start it.',
      apply(run) { run.mods.forecast = true; },
    },
    {
      id: 'reinforced', name: 'Reinforced', rarity: 'common', max: 1,
      desc: 'First invalid attempt each sector is forgiven.',
      detail: 'The first invalid attempt in each sector costs no integrity. If that attempt involves an Aegis ring whose forgiveness is unused, Aegis is spent first and this one is kept for the next attempt.',
      apply(run) { run.mods.reinforced += 1; },
    },
    // Rare
    {
      id: 'interest_engine', name: 'Interest Engine', rarity: 'rare', max: 2,
      desc: 'Gain 10% of held bits at sector end (max 60).',
      detail: 'Each stack adds 10% of your held bits at the end of a sector as bonus bits, capped at 60 bits per sector.',
      apply(run) { run.mods.interestRate += 0.1; },
    },
    {
      id: 'field_repair', name: 'Field Repair', rarity: 'rare', max: 1,
      desc: '+1 integrity at the start of every sector.',
      detail: 'Restores 1 integrity at the start of every sector, never above your maximum integrity.',
      apply(run) { run.mods.repairPerSector += 1; },
    },
    {
      id: 'undo_buffer', name: 'Undo Buffer', rarity: 'rare', max: 2,
      desc: '+2 undo charges.',
      detail: 'Adds 2 undo charges per stack. Each undo reverts your last valid move, but using one breaks the Unassisted quest.',
      apply(run) {
        run.mods.undoCharges += 2;
        run.undoCharges += 2;
      },
    },
    {
      id: 'overclock', name: 'Overclock', rarity: 'rare', max: 2,
      desc: 'Combo cap +2 stacks.',
      detail: 'Raises the combo cap by 2 stacks per copy, so the combo multiplier keeps climbing for longer before it reaches its ceiling.',
      apply(run) { run.mods.comboCap += 2; },
    },
    {
      id: 'gilded_forge', name: 'Gilded Forge', rarity: 'rare', max: 2,
      desc: 'Gilded chance +25%. Gilded payout x1.5.',
      detail: 'Each stack raises the chance that a sector contains a gilded ring by 25% and multiplies gilded payouts by 1.5.',
      apply(run) {
        run.mods.gildedChance *= 1.25;
        run.mods.gildedMult *= 1.5;
      },
    },
    {
      id: 'exoskeleton', name: 'Exoskeleton', rarity: 'rare', max: 1,
      desc: 'Heavy rings cost 1 unit.',
      detail: 'Heavy rings cost 1 cost unit per move instead of 2, in both your cost total and the par.',
      apply(run) { run.mods.heavyFreePar = true; },
    },
    {
      id: 'black_market', name: 'Black Market', rarity: 'rare', max: 1,
      desc: 'Rerolls and repairs cost 40% less.',
      detail: 'Reroll and repair prices are multiplied by 0.6, so they cost 40% less than normal.',
      apply(run) { run.mods.shopDiscount = 0.6; },
    },
    {
      id: 'momentum', name: 'Momentum', rarity: 'rare', max: 1,
      desc: '+1 bit per combo stack on each move.',
      detail: 'Each valid move in a combo chain earns extra bits equal to its current combo stack count.',
      apply(run) { run.mods.momentum = true; },
    },
    {
      id: 'time_dilation', name: 'Time Dilation', rarity: 'rare', max: 1, requires: 'blitz',
      desc: 'Blitz timer x1.4.',
      detail: 'Multiplies the blitz timer by 1.4, giving 40% more time in each sector. It can only be drawn in Blitz.',
      apply(run) { run.mods.timeMult *= 1.4; },
    },
    // Epic
    {
      id: 'recursion', name: 'Recursion', rarity: 'epic', max: 1,
      desc: 'Bits per move +(ring size - 1).',
      detail: 'Each valid move earns extra bits equal to the moving ring size minus one, so larger rings pay more.',
      apply(run) { run.mods.sizeBits = true; },
    },
    {
      id: 'phoenix_core', name: 'Phoenix Core', rarity: 'epic', max: 1,
      desc: 'Once per run, revive at 2 integrity instead of dying.',
      detail: 'Once per run, if integrity would drop to zero you survive at 2 integrity instead. A second death ends the run as normal.',
      apply(run) {
        run.phoenixCharges += 1;
        run.mods.phoenixCharges += 1;
      },
    },
    {
      id: 'ghost_protocol', name: 'Ghost Protocol', rarity: 'epic', max: 1,
      desc: 'Ghost chance x1.2. +1 bit per ghost move.',
      detail: 'Ghost rings become 20% more likely to appear, and each move of a ghost ring earns 1 extra bit.',
      apply(run) {
        run.mods.ghostChance *= 1.2;
        run.mods.ghostBits += 1;
      },
    },
    {
      id: 'perfect_protocol', name: 'Perfect Protocol', rarity: 'epic', max: 1,
      desc: 'S rating heals 1 and doubles the clear bonus.',
      detail: 'Finishing a sector with an S rating heals 1 integrity and doubles the clear bonus for that sector.',
      apply(run) {
        run.mods.sRankHeal += 1;
        run.mods.sRankMult = 2;
      },
    },
    // Curses
    {
      id: 'greed_protocol', name: 'Greed Protocol', rarity: 'curse', max: 1,
      desc: 'Move bits x2. Repairs cost half. Invalid attempts cost +1.',
      detail: 'Valid-move bits are doubled, repairs and rerolls cost half, and invalid attempts cost 3 integrity instead of 2.',
      apply(run) {
        run.mods.curseBitMult *= 2;
        run.mods.shopDiscount *= 0.5;
        run.mods.invalidCost = Math.max(run.mods.invalidCost, 3);
      },
    },
    {
      id: 'hair_trigger', name: 'Hair Trigger', rarity: 'curse', max: 1,
      desc: 'Invalid attempts cost 3 integrity. Max integrity +2.',
      detail: 'Invalid attempts cost 3 integrity. Taking this card also raises maximum integrity by 2 and gives 2 integrity at once.',
      apply(run) {
        run.mods.invalidCost = 3;
        run.maxIntegrity += 2;
        run.integrity += 2;
      },
    },
    {
      id: 'static_debt', name: 'Static Debt', rarity: 'curse', max: 1,
      desc: 'Lose 10% of bits each sector. Quest rewards x2.',
      detail: 'At the start of every sector you lose 10% of your bits, and every quest reward is doubled.',
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
      id: 'efficient',
      name: 'Efficient',
      desc: 'Finish with a cost no more than two units above par.',
      detail: 'Your total cost counts every valid move, with heavy rings costing double, and it must be no more than par plus 2. Hints and undos do not refund cost you have already spent.',
      reward: 25,
      check: (stats, sector) => stats.cost <= sector.par + 2,
    },
    {
      id: 'clean',
      name: 'Clean',
      desc: 'Make no invalid attempts during the sector.',
      detail: 'Any attempt that breaks the size rule counts, even one that Aegis or Reinforced forgives. Clicking the same relay twice or an empty relay does not count.',
      reward: 20,
      check: (stats) => stats.invalidMoves === 0,
    },
    {
      id: 'chain',
      name: 'Chain',
      desc: 'Reach a x2.0 combo multiplier at least once.',
      detail: 'Each valid move that lands inside the combo window adds 0.2 to the multiplier, so x2.0 needs five chained moves (more with Overclock). The quest passes if the multiplier reaches x2.0 at any point in the sector.',
      reward: 20,
      check: (stats) => stats.maxComboMult >= 2,
    },
    {
      id: 'swift',
      name: 'Swift',
      desc: 'Finish within 6 seconds plus 1.2 seconds per par unit.',
      detail: 'The time from the start of the sector to the moment it is cleared must be no more than 6 + 1.2 x par seconds. Time spent on the intro or reward screens is not counted.',
      reward: 20,
      check: (stats, sector) => stats.elapsed <= 6 + 1.2 * sector.par,
    },
    {
      id: 'gilded',
      name: 'Gilded',
      desc: 'A gilded ring lands on the target relay.',
      detail: 'Only offered in sectors that contain a gilded ring. It passes when a gilded ring lands on the target at least once, even if that ring is moved off again before the sector ends.',
      reward: 25,
      check: (stats) => stats.gildedOnTarget > 0,
    },
    {
      id: 'unassisted',
      name: 'Unassisted',
      desc: 'Finish the sector without using undo or hint.',
      detail: 'Using a hint or an undo in this sector fails the quest. A blitz timeout resets the board but is not an assist, so it does not fail this quest.',
      reward: 30,
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

  // Standard: a ring may sit on a larger ring. Reversed (13.1): on a smaller one.
  function sizeFits(mover, onto, reversed) {
    return reversed ? mover.size > onto.size : mover.size < onto.size;
  }

  // Shared legality rule: the size rule above, or anything when either side is
  // a ghost. An empty target is always legal.
  function stackLegal(mover, onto, reversed) {
    if (!onto) return true;
    return sizeFits(mover, onto, reversed) || mover.type === 'ghost' || onto.type === 'ghost';
  }

  function isTowerIndex(index, count) {
    return Number.isInteger(index) && index >= 0 && index < count;
  }

  function emptyTowers(count) {
    return Array.from({ length: count }, () => []);
  }

  // Works on ring objects and on ring ids alike. Returns null when empty.
  function topOf(tower) {
    return tower.length > 0 ? tower[tower.length - 1] : null;
  }

  function towerKey(idTowers) {
    return idTowers.map((tower) => tower.join(',')).join('|');
  }

  function memoKeyFor(towers, target, heavyCost, reversed) {
    const rings = [];
    towers.forEach((tower) => tower.forEach((ring) => rings.push(ring)));
    const ringSig = rings
      .slice()
      .sort((a, b) => a.size - b.size)
      .map((ring) => ring.id + ':' + ring.size + ':' + ring.type)
      .join(',');
    const idTowers = towers.map((tower) => tower.map((ring) => ring.id));
    return [towerKey(idTowers), target, heavyCost, reversed ? 'r' : 's', ringSig].join('#');
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
  function solveOptimal(towers, target, heavyCost, reversed) {
    const rings = [];
    towers.forEach((tower) => tower.forEach((ring) => rings.push(ring)));
    const byId = new Map();
    rings.forEach((ring) => byId.set(ring.id, ring));
    const ringCount = rings.length;
    const towerCount = towers.length;
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
        for (let from = 0; from < towerCount; from += 1) {
          for (let to = 0; to < towerCount; to += 1) {
            if (from === to || state[from].length === 0) continue;
            const mover = byId.get(topOf(state[from]));
            const ontoId = topOf(state[to]);
            const onto = ontoId === null ? null : byId.get(ontoId);
            if (!stackLegal(mover, onto, reversed)) continue;
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

  function solveCached(towers, target, heavyCost, reversed) {
    const key = memoKeyFor(towers, target, heavyCost, reversed);
    let result = parMemo.get(key);
    if (!result) {
      if (parMemo.size >= PAR_MEMO_LIMIT) parMemo.clear();
      result = solveOptimal(towers, target, heavyCost, reversed);
      parMemo.set(key, result);
    }
    return result;
  }

  // Minimum cost to put every ring on `target`. opts.heavyCost defaults to 2.
  // opts.reversed selects the reversed stacking rule. The tower count is the
  // length of `towers` (3 or 4).
  function parOf(towers, target, opts) {
    if (!isTowerIndex(target, towers.length)) {
      throw new RangeError('parOf: target must be a tower index 0 to ' + (towers.length - 1));
    }
    const heavyCost = opts && opts.heavyCost ? opts.heavyCost : HEAVY_COST;
    const reversed = Boolean(opts && opts.reversed);
    return solveCached(towers, target, heavyCost, reversed).cost;
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
      towerCount: mode.towerCount,
      reversed: mode.reversed,
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

  // Tower 0 holds every ring in legal order: largest at the bottom (standard),
  // smallest at the bottom (reversed). A scrambled start puts rings on random
  // towers in that same order, retrying until the target is not already full.
  function buildStart(run, rings, target, shell) {
    const count = shell.towerCount;
    const ordered = shell.reversed ? rings.slice() : rings.slice().reverse();
    if (shell.scramble) {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const towers = emptyTowers(count);
        ordered.forEach((ring) => towers[run.rng.int(0, count - 1)].push(ring));
        if (towers[target].length < rings.length) return towers;
      }
    }
    const towers = emptyTowers(count);
    towers[0] = ordered;
    return towers;
  }

  function questInstance(id, no, mods) {
    const def = QUESTS.find((q) => q.id === id);
    return {
      id: def.id,
      name: def.name,
      desc: def.desc,
      reward: Math.round((def.reward + 2 * no) * (1 + mods.questBonus)),
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
    const targets = [];
    for (let tower = 1; tower < shell.towerCount; tower += 1) targets.push(tower);
    const target = run.rng.pick(targets);
    const start = buildStart(run, rings, target, shell);
    const par = parOf(start, target, { heavyCost: heavyCostFor(run), reversed: shell.reversed });
    const questIds = plan.questIds;

    return Object.assign(shell, {
      rings,
      target,
      start,
      par,
      quest: questInstance(questIds[0], no, run.mods),
      bossQuest: questIds.length > 1 ? questInstance(questIds[1], no, run.mods) : null,
      // Blitz clock: (8 + 1.6 x par) seconds, scaled by time_dilation.
      timeLimit: mode.timed ? Math.round((8 + 3.0 * par) * run.mods.timeMult) : null,
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
      bonusOffer: null,
      rareGuarantee: false,
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
      const count = this.towers.length;
      if (!isTowerIndex(from, count) || !isTowerIndex(to, count)) return { ok: false, reason: 'range' };
      if (this.run.over) return { ok: false, reason: 'over' };
      if (this.isSolved()) return { ok: false, reason: 'solved' };
      if (from === to) return { ok: false, reason: 'same' };
      if (this.towers[from].length === 0) return { ok: false, reason: 'empty' };
      const mover = topOf(this.towers[from]);
      if (!stackLegal(mover, topOf(this.towers[to]), this.sector.reversed)) return { ok: false, reason: 'size' };
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
      const bypass = onto !== null && !sizeFits(ring, onto, sector.reversed); // legal only via ghost
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
        0.5 + mods.bitsPerMove
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
      const solved = solveCached(this.towers, this.sector.target, heavyCost, Boolean(this.sector.reversed));
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
    run.rareGuarantee = false;
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
      (6 + 2 * sector.no) * ratingMult * MODES[run.mode].bitMult * sector.clearMult * sMult,
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

    // Bonus games: 30% from sector 3 on, never on a boss sector.
    run.bonusOffer = null;
    if (!sector.isBoss && sector.no >= BONUS_FIRST_SECTOR && run.rng.chance(BONUS_CHANCE)) {
      run.bonusOffer = { kind: run.rng.pick(['sort', 'cipher']) };
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
    const rareGuarantee = (run.lastSectorBoss || run.rareGuarantee) && offer.length > 0
      && !offer.some((id) => rarityOf(id) === 'rare' || rarityOf(id) === 'epic');
    if (rareGuarantee) {
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
    run.bonusOffer = null; // taking a card closes the reward screen's bonus option
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

  // ------------------------------------------------------------------ bonus: ball sort
  // Tube rules shared by the board, the scrambler and the solver. Returns the
  // reason a move is illegal, or null when it is legal.
  function sortRejection(tubes, from, to, capacity) {
    if (from === to) return 'same';
    if (tubes[from].length === 0) return 'empty';
    if (tubes[to].length >= capacity) return 'full';
    if (tubes[to].length > 0 && topOf(tubes[to]) !== topOf(tubes[from])) return 'mismatch';
    return null;
  }

  function sortApply(tubes, from, to) {
    const next = tubes.map((tube) => tube.slice());
    next[to].push(next[from].pop());
    return next;
  }

  // Every colour sits in exactly one tube, and no tube mixes colours.
  function sortSolved(tubes, colors) {
    const holders = new Array(colors).fill(0);
    for (let i = 0; i < tubes.length; i += 1) {
      const tube = tubes[i];
      if (tube.length === 0) continue;
      if (tube.some((c) => c !== tube[0])) return false;
      holders[tube[0]] += 1;
    }
    return holders.every((n) => n === 1);
  }

  // Colours for a sector: 3 + floor(sector / 3), capped at 5.
  function ballSortColors(sectorNo) {
    const steps = Math.floor(sectorNo / BALL_SORT_COLOR_STEP);
    return Math.min(BALL_SORT_MAX_COLORS, BALL_SORT_MIN_COLORS + steps);
  }

  // A random deal: every ball goes to a random tube that still has room.
  function sortDeal(rng, colors, capacity) {
    const tubes = Array.from({ length: colors + 2 }, () => []);
    const balls = [];
    for (let c = 0; c < colors; c += 1) {
      for (let k = 0; k < capacity; k += 1) balls.push(c);
    }
    rng.shuffle(balls).forEach((colour) => {
      const open = [];
      tubes.forEach((tube, i) => { if (tube.length < capacity) open.push(i); });
      tubes[rng.pick(open)].push(colour);
    });
    return tubes;
  }

  // Draws deals from run.rng until one is solvable (checked by the BFS) and at
  // least BALL_SORT_MIN_SOLVE moves from solved. If no deal in the attempt budget
  // is deep enough, the deepest solvable one is used. Random legal play from the
  // solved state was measured to stay about two moves from solved, so it is not
  // used as the generator.
  function sortGenerate(rng, colors, capacity) {
    let best = null;
    for (let attempt = 0; attempt < BALL_SORT_DEAL_ATTEMPTS || best === null; attempt += 1) {
      const tubes = sortDeal(rng, colors, capacity);
      const path = sortSolve(tubes, colors, capacity);
      if (path === null) continue;
      if (path.length >= BALL_SORT_MIN_SOLVE) return tubes;
      if (best === null || path.length > best.length) best = { tubes, length: path.length };
    }
    return best.tubes;
  }

  // Colours are relabelled by first appearance, so layouts that differ only by a
  // colour permutation share one search node. Tube moves stay valid because
  // legality depends only on whether colours are equal.
  function sortCanonical(tubes) {
    const labels = new Map();
    return tubes.map((tube) => tube.map((c) => {
      if (!labels.has(c)) labels.set(c, labels.size);
      return labels.get(c);
    }));
  }

  function sortKey(tubes) {
    return tubes.map((tube) => tube.join('')).join('|');
  }

  function sortPath(parent, goalKey) {
    const path = [];
    let key = goalKey;
    while (parent.get(key)) {
      const step = parent.get(key);
      path.push({ from: step.from, to: step.to });
      key = step.prev;
    }
    return path.reverse();
  }

  // Breadth-first search for a shortest move list to a solved layout. Returns
  // [] when already solved, or null if none is found.
  function sortSolve(tubes, colors, capacity) {
    if (sortSolved(tubes, colors)) return [];
    const start = sortCanonical(tubes);
    const startKey = sortKey(start);
    const parent = new Map([[startKey, null]]);
    const queue = [start];
    for (let head = 0; head < queue.length; head += 1) {
      const state = queue[head];
      const key = sortKey(state);
      for (let from = 0; from < state.length; from += 1) {
        for (let to = 0; to < state.length; to += 1) {
          if (sortRejection(state, from, to, capacity) !== null) continue;
          const next = sortCanonical(sortApply(state, from, to));
          const nextKey = sortKey(next);
          if (parent.has(nextKey)) continue;
          parent.set(nextKey, { prev: key, from, to });
          if (sortSolved(next, colors)) return sortPath(parent, nextKey);
          queue.push(next);
        }
      }
    }
    return null;
  }

  class BallSortBoard {
    constructor(tubes, colors, capacity, sectorNo) {
      this.tubes = tubes;
      this.colors = colors;
      this.capacity = capacity;
      this.sectorNo = sectorNo;
      this.moves = 0;
      this.invalidMoves = 0;
      this.plan = null;
    }

    get finished() {
      return this.isSolved();
    }

    isSolved() {
      return sortSolved(this.tubes, this.colors);
    }

    canMove(from, to) {
      const count = this.tubes.length;
      if (!isTowerIndex(from, count) || !isTowerIndex(to, count)) return { ok: false, reason: 'range' };
      if (this.isSolved()) return { ok: false, reason: 'solved' };
      const reason = sortRejection(this.tubes, from, to, this.capacity);
      return reason === null ? { ok: true } : { ok: false, reason };
    }

    // Moves the top ball of `from` onto `to`. Rejected moves cost nothing and
    // never touch a run.
    tryMove(from, to) {
      const check = this.canMove(from, to);
      if (!check.ok) {
        const counted = check.reason === 'empty' || check.reason === 'full' || check.reason === 'mismatch';
        if (counted) this.invalidMoves += 1;
        return {
          ok: false,
          reason: check.reason,
          color: null,
          events: counted ? ['invalid'] : [],
          solved: this.isSolved(),
        };
      }
      const color = this.tubes[from].pop();
      this.tubes[to].push(color);
      this.moves += 1;
      const events = ['move'];
      const target = this.tubes[to];
      if (target.length === this.capacity && target.every((c) => c === color)) events.push('tube-complete');
      const solved = this.isSolved();
      if (solved) events.push('solved');
      return { ok: true, color, events, solved };
    }

    // First move of a shortest solution, or null when solved. The solution is
    // cached as exact layouts. While the board sits on it, later hints just
    // advance along it, and any other layout triggers a fresh search.
    hint() {
      if (this.isSolved()) return null;
      const here = sortKey(this.tubes);
      const plan = this.plan;
      if (plan) {
        const at = plan.keys.indexOf(here);
        if (at >= 0) {
          plan.keys.splice(0, at);
          plan.steps.splice(0, at);
          return { from: plan.steps[0].from, to: plan.steps[0].to };
        }
      }
      const path = sortSolve(this.tubes, this.colors, this.capacity);
      if (!path || path.length === 0) {
        this.plan = null;
        return null;
      }
      const keys = [];
      let layout = this.tubes;
      path.forEach((step) => {
        keys.push(sortKey(layout));
        layout = sortApply(layout, step.from, step.to);
      });
      this.plan = { keys, steps: path.map((step) => ({ from: step.from, to: step.to })) };
      return { from: path[0].from, to: path[0].to };
    }

    reward() {
      return this.isSolved() ? BALL_SORT_BITS + BALL_SORT_BITS_PER_SECTOR * this.sectorNo : 0;
    }
  }

  // opts.tubes: explicit layout, bottom to top, for tests and tools. opts.colors
  // defaults to one more than the largest colour id in that layout.
  function createBallSort(run, opts) {
    const o = opts || {};
    const capacity = BALL_SORT_CAPACITY;
    let tubes;
    let colors;
    if (o.tubes) {
      tubes = o.tubes.map((tube) => tube.slice());
      const ids = tubes.reduce((all, tube) => all.concat(tube), []);
      colors = o.colors !== undefined ? o.colors : ids.reduce((max, c) => Math.max(max, c + 1), 0);
      const valid = ids.every((c) => Number.isInteger(c) && c >= 0 && c < colors)
        && tubes.every((tube) => tube.length <= capacity);
      if (!valid) throw new RangeError('createBallSort: colour ids must be integers below colors, tubes at most 4 deep');
    } else {
      colors = ballSortColors(run.sectorNo);
      tubes = sortGenerate(run.rng, colors, capacity);
    }
    return new BallSortBoard(tubes, colors, capacity, run.sectorNo);
  }

  // ------------------------------------------------------------------ bonus: cipher
  const CIPHER_SECRETS = new WeakMap();

  function allEqual(list) {
    return list.every((v) => v === list[0]);
  }

  // Standard mastermind feedback. Black: right ring on the right relay. White:
  // right relay on a different ring, counted by the minimum-count rule.
  function cipherFeedback(guess, secret) {
    let black = 0;
    const guessLeft = new Array(CIPHER_RELAYS).fill(0);
    const secretLeft = new Array(CIPHER_RELAYS).fill(0);
    for (let i = 0; i < CIPHER_PEGS; i += 1) {
      if (guess[i] === secret[i]) {
        black += 1;
      } else {
        guessLeft[guess[i]] += 1;
        secretLeft[secret[i]] += 1;
      }
    }
    let white = 0;
    for (let relay = 0; relay < CIPHER_RELAYS; relay += 1) {
      white += Math.min(guessLeft[relay], secretLeft[relay]);
    }
    return { black, white };
  }

  // The guess builder: four standard rings on three relays. Same stacking rule
  // as standard, but illegal moves are plain no-ops and nothing touches a run.
  class GuessBoard {
    constructor() {
      const rings = buildRings(CIPHER_PEGS, new Array(CIPHER_PEGS).fill('standard'));
      this.towers = [rings.slice().reverse(), [], []];
      this.moves = 0;
    }

    canMove(from, to) {
      const count = this.towers.length;
      if (!isTowerIndex(from, count) || !isTowerIndex(to, count)) return { ok: false, reason: 'range' };
      if (from === to) return { ok: false, reason: 'same' };
      if (this.towers[from].length === 0) return { ok: false, reason: 'empty' };
      if (!stackLegal(topOf(this.towers[from]), topOf(this.towers[to]), false)) return { ok: false, reason: 'size' };
      return { ok: true };
    }

    tryMove(from, to) {
      const check = this.canMove(from, to);
      if (!check.ok) return { ok: false, reason: check.reason, ring: null };
      const ring = this.towers[from].pop();
      this.towers[to].push(ring);
      this.moves += 1;
      return { ok: true, ring };
    }
  }

  class CipherGame {
    constructor(sectorNo) {
      this.sectorNo = sectorNo;
      this.board = new GuessBoard();
      this.maxGuesses = CIPHER_MAX_GUESSES;
      this.guesses = [];
      this.solved = false;
      this.failed = false;
      this.movesAtSubmit = 0;
    }

    get guessesUsed() {
      return this.guesses.length;
    }

    get finished() {
      return this.solved || this.failed;
    }

    // Only revealed once the game is solved or failed.
    get secret() {
      return this.finished ? CIPHER_SECRETS.get(this).slice() : null;
    }

    // Reads each ring's relay into the guess, scores it and uses one guess.
    // Returns null once the game is finished.
    submit() {
      if (this.finished) return null;
      const guess = new Array(CIPHER_PEGS).fill(0);
      this.board.towers.forEach((tower, relay) => {
        tower.forEach((ring) => { guess[ring.size - 1] = relay; });
      });
      const { black, white } = cipherFeedback(guess, CIPHER_SECRETS.get(this));
      const moves = this.board.moves - this.movesAtSubmit;
      this.movesAtSubmit = this.board.moves;
      this.guesses.push({ guess: guess.slice(), black, white, moves });
      if (black === CIPHER_PEGS) {
        this.solved = true;
      } else if (this.guesses.length >= this.maxGuesses) {
        this.failed = true;
      }
      return { guess: guess.slice(), black, white, moves };
    }

    // Solved: (40 + 10 x sector) x (guesses left + 1) / max, rounded.
    // Failed: the 20 bit consolation. Unfinished: 0.
    reward() {
      if (this.solved) {
        const left = this.maxGuesses - this.guesses.length + 1;
        return Math.round((CIPHER_BASE_BITS + CIPHER_BITS_PER_SECTOR * this.sectorNo) * left / this.maxGuesses);
      }
      return this.failed ? CIPHER_CONSOLATION : 0;
    }
  }

  // opts.secret: four relay indices, not all equal, for tests and tools.
  function createCipher(run, opts) {
    const o = opts || {};
    let secret;
    if (o.secret) {
      const valid = o.secret.length === CIPHER_PEGS
        && o.secret.every((v) => Number.isInteger(v) && v >= 0 && v < CIPHER_RELAYS);
      if (!valid || allEqual(o.secret)) {
        throw new RangeError('createCipher: secret needs four relay indices, not all equal');
      }
      secret = o.secret.slice();
    } else {
      do {
        secret = [];
        for (let i = 0; i < CIPHER_PEGS; i += 1) secret.push(run.rng.int(0, CIPHER_RELAYS - 1));
      } while (allEqual(secret));
    }
    const game = new CipherGame(run.sectorNo);
    CIPHER_SECRETS.set(game, secret);
    return game;
  }

  // ------------------------------------------------------------------ bonus settlement
  // Pays a finished bonus game and replaces run.offer with a rare-or-better set.
  // Returns null if the game is unfinished, already settled, or the run is over.
  // Never touches run.integrity.
  function finishBonus(run, game) {
    if (!run || !game || run.over || game.settled || !game.finished) return null;
    game.settled = true;
    const bits = Math.round(game.reward() * MODES[run.mode].bitMult);
    run.bits += bits;
    run.bonusOffer = null;
    run.rareGuarantee = true;
    run.offer = buildOffer(run, []);
    return { bits, offer: run.offer.slice() };
  }

  // Drops the pending bonus offer. Returns true if there was one.
  function declineBonus(run) {
    const had = Boolean(run.bonusOffer);
    run.bonusOffer = null;
    return had;
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
    createBallSort,
    createCipher,
    finishBonus,
    declineBonus,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = HanoiCore;
else globalThis.HanoiCore = HanoiCore;
