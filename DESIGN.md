# HANOI//PROTOCOL — Design & Contract

A roguelite built on the Tower of Hanoi. Each **sector** is a Hanoi puzzle with
a modifier, a quest and (every few sectors) a boss. Clearing sectors earns
**bits**; between sectors you pick **upgrades** that bend the rules. Lose all
**integrity** and the run ends.

Visual identity: **NEON RELAY** — black-indigo CRT, neon relays (towers) and
data rings, scanlines, glitch flashes on invalid moves, a synthwave floor on
menus.

Code conventions: follow `.trae/rules/rule.md` (camelCase, UPPER_SNAKE constants,
lowercase scenes, Kaplay `global: true`, hex colors, `anchor()` on everything,
`fixed()` for HUD, tweens use local vars, audio lazily initialised).

---

## 1. Files

| File | Owner | Purpose |
|---|---|---|
| `core.js` | core agent | Pure rules, data tables, RNG, par solver. No DOM, no Kaplay. Browser: global `HanoiCore`. Node: `module.exports`. |
| `test/core.test.js` | core agent | `node --test test/` unit tests for core. |
| `sim.js` | balance agent | Node simulator with bot players; prints balance report. Uses `core.js` only. |
| `game.js` | renderer agent | Kaplay scenes, rendering, input, audio. Uses `HanoiCore` only. |
| `style.css`, `index.html` | renderer agent | Page shell, responsive canvas. |
| `script.js` | — | **Deleted** (replaced by `core.js` + `game.js`). |

`index.html` loads, in order: kaplay `3001.0.19` from unpkg, `style.css`,
`core.js`, `game.js`. Kaplay must stay on `3001.0.19` (latest stable 3001 line).

---

## 2. Core contract (`HanoiCore`)

Everything below is the public API. Renderer and sim use only this.

### 2.1 RNG
`makeRng(seed) -> rng` with `rng.next()` (float in [0,1)), `rng.int(lo, hi)`
(inclusive), `rng.pick(arr)`, `rng.chance(p)`, `rng.shuffle(arr)`. Deterministic
(mulberry32 or similar). Same seed ⇒ identical runs.

### 2.2 Rings and towers
- A **ring** is `{ id, size, type }`. `size` 1 = smallest, `n` = largest. `id` is unique within a sector. `type` ∈ `RING_TYPES` keys.
- A **tower** is an array of rings, index 0 = bottom, last = top. There are always **3 towers** (indices 0, 1, 2).
- A legal stack is: a ring may sit on a ring of larger size, or on any ring if either is a `ghost` (see §3).

### 2.3 Modes
`MODES` (object keyed by id): `standard`, `blitz`, `endless`, `daily`.
- `standard`: 12 sectors, bosses at 4, 8, 12, victory after sector 12 boss clears.
- `blitz`: as standard, but every sector has a timer (`timeLimit`), bits ×1.25.
- `endless`: no victory; bosses every 5 sectors; ring count keeps climbing (capped); run ends only on death.
- `daily`: standard rules, `seed` = today's date as YYYYMMDD number (same for everyone that day).
- Each mode: `{ id, name, tagline, sectors (Infinity for endless), timed, bossEvery (array or number) }`.
- Ascension (`createRun({ascension:true})`, unlocked by the UI after one standard win): start `maxIntegrity` 2 and modifiers begin one sector earlier.

### 2.4 Run
```
createRun({ mode, seed?, ascension? }) -> run
```
`run` fields (plain object, serialisable except `rng`):
`mode, seed, rng, ascension, sectorNo (0 before first sector), integrity, maxIntegrity,
bits, score, upgrades: { [id]: stacks }, undoCharges, hintsLeft, phoenixCharges,
mods: {...} (see §4), nextPlan (pre-rolled next sector, for forecast),
offer (current reward cards), over (bool), victory (bool), endReason (string|null),
sectorsCleared, stats: { validMoves, invalidMoves, undos, hints, cardsTaken: [] }`.

### 2.5 Sectors
```
sectorConfig(run) -> sector        // increments run.sectorNo, applies run.nextPlan if present
```
`sector` fields:
`no, isBoss, boss (null | { id, name, rule }), ringCount, target (1|2), start: [[ring..],[..],[..]],
rings: [{id,size,type}], modifiers: [modifierId], quest: { id, name, desc, reward }, par (cost units),
timeLimit (seconds | null), fog (bool), gildedCount, ghostCount, heavyCount, aegisCount`.
- `start` is tower 0 full (standard) unless `scramble` applies (random valid distribution, never already solved).
- `par` = minimum cost to reach a solved target from `start` (see §6).
- Ring counts: `standard`/`blitz`: base `3 + floor((no-1)/4)` (3,3,3,3,4,4,4,4,5,5,5,5), bosses +1 except sector 12 (fixed 7). `endless`: `min(9, 3 + floor((no-1)/4))`. Capped at 9 always.

### 2.6 Board (the puzzle in play)
```
new Board(run, sector)
board.towers                // 3 arrays (bottom→top)
board.canMove(from, to)     // -> { ok: true } | { ok: false, reason }   reason: 'same'|'empty'|'size'|'solved'
board.tryMove(from, to, t)  // t = seconds since sector start (drives combo window)
   -> {
        ok, reason?, ring?, costUnits, bitsGained, scoreGained,
        comboStacks, comboMult,
        integrityLost, forgiven,     // invalid-move penalty info
        events: [ 'move','land-target','gilded','ghost','heavy','combo-break','invalid','aegis-forgive','solved','revive','dead' ],
        solved, failed                // failed = run.over now true
      }
board.isSolved()
board.hint()                // -> { from, to } | null  (does NOT spend a charge, does NOT mark assists)
board.useHint()             // spends run.hintsLeft; marks assist; returns hint or null if none left
board.undo()                // spends run.undoCharges; reverts last valid move (positions, stacks). Keeps bits/score. marks assist.
board.timeout()             // timed sectors: integrity -1, board resets to sector.start; failed if integrity 0
board.timeLeft(t)           // seconds or null
board.stats                 // { cost, validMoves, invalidMoves, maxComboMult, assists, elapsed, gildedOnTarget, ... }
```
Costs: a valid move costs `1` cost unit, or `2` for a `heavy` ring (unless `heavyFreePar` upgrade — then the cost is still counted for rating but par ignores it; see §5). Invalid attempts cost no cost units.

### 2.7 Sector end, rewards, upgrades
```
finishSector(run, board, t) -> {
   rating: 'S'|'A'|'B'|'C', cost, par,
   quests: [{ id, name, done, reward }],
   bitsEarned, scoreEarned, interest, healed, bossReward (bool), victory (bool)
}
```
- Rating from `cost` vs `par`: S ≤ par, A ≤ ceil(par×1.25), B ≤ ceil(par×1.75), else C.
- Sets `run.sectorsCleared++`; sets `run.victory` for standard/blitz/daily sector 12 boss clear.
- Pre-rolls `run.nextPlan` (so the forecast card is exact).

```
rewardOffer(run) -> [cardId, cardId, cardId]     // stored in run.offer; boss offers guarantee ≥1 rare+
rerollCost(run) -> int
reroll(run) -> offer | null                      // deducts bits; null if unaffordable
takeCard(run, cardId) -> cardDef | null          // applies upgrade, clears offer
repairCost(run) -> int
buyRepair(run) -> bool                           // +1 integrity (≤ max), deducts bits
```
Offer weights: common 60, rare 30, epic 10; curses 15% chance per slot (never more than one curse per offer). A card at max stacks is excluded.

### 2.8 Catalogues (data, exported)
- `RING_TYPES`: `{ standard, gilded, ghost, heavy, aegis }` each with `{ name, glyph, desc }`.
- `UPGRADES`: array of `{ id, name, rarity: 'common'|'rare'|'epic'|'curse', desc, max, weight?, requires?: 'blitz', apply(run) }`.
- `MODIFIERS`: array of `{ id, name, desc, minSector, weight, apply(sector, run) }`.
- `QUESTS`: array of `{ id, name, desc, reward (base bits), check(stats, sector, run) }`.
- `BOSSES`: `{ sentinel, mirror, stack }` each with `{ id, name, sector, rule, apply(sector) }`.
- `parOf(towers, target, opts)` — Dijkstra over full board states (exposed for tests and sim).

---

## 3. Ring types

| Type | Appears | Rule | Visual |
|---|---|---|---|
| `standard` | always | none | solid neon, number glyph |
| `gilded` | sector ≥ 3 (chance) | landing on the **target** tower pays a bonus `(4 + sector) × gildedMult` bits | gold, sparkle |
| `ghost` | sector ≥ 5 (chance) | size rule ignored when it is mover or target top | translucent, dashed outline |
| `heavy` | sector ≥ 4 (chance) | each move costs **2** cost units (par) | dark chrome, double band |
| `aegis` | sector ≥ 7 (chance) | first invalid attempt involving it each sector is forgiven (no integrity loss) | hazard stripes |

Gilded and ghost are the only ring types that change what is *legal*/*rewarded*; heavy changes par; aegis changes penalties.

---

## 4. Upgrades (picked between sectors)

Stacking is capped by `max`. Effects are applied to `run.mods` (defaults in parentheses).

**Common**
- `bit_miner` — +1 bits per valid move (`bitsPerMove` 0), max 3.
- `stability_patch` — +1 max integrity and +1 integrity, max 2.
- `neural_link` — combo window +1 s (`comboWindow` 4), max 3.
- `hint_pulse` — +1 hint per sector (`hintsPerSector` 0), max 2.
- `quest_broker` — quest rewards +30 % (`questBonus` 0), max 3.
- `forecast` — reveals the next sector's modifiers/quest on the reward screen, max 1.
- `reinforced` — first invalid attempt each sector is forgiven, max 1.

**Rare**
- `interest_engine` — at sector end gain 10 % of held bits (max 60) (`interestRate` 0), max 2.
- `field_repair` — +1 integrity at the start of every sector (`repairPerSector` 0), max 1.
- `undo_buffer` — +2 undo charges (`undoCharges` 0), max 2.
- `overclock` — combo cap +2 stacks (`comboCap` 5), max 2.
- `gilded_forge` — gilded chance +25 % and gilded payout ×1.5 (`gildedChance` 0.35, `gildedMult` 1), max 2.
- `exoskeleton` — heavy rings cost 1 cost unit (`heavyFreePar` false), max 1.
- `black_market` — rerolls and repairs cost ×0.6 (`shopDiscount` 1), max 1.
- `momentum` — +1 bit per combo stack on each move in a chain (`momentum` false), max 1.
- `time_dilation` — blitz timer ×1.4 (`timeMult` 1), blitz only, max 1.

**Epic**
- `recursion` — bits per move +(ring size − 1) (`sizeBits` false), max 1.
- `phoenix_core` — once per run, reviving at 2 integrity when integrity would hit 0 (`phoenixCharges` 0), max 2.
- `ghost_protocol` — ghost chance ×2 and +2 bits per ghost move (`ghostChance` 0.3, `ghostBits` 0), max 1.
- `perfect_protocol` — S rating: heal 1 and clear bonus ×2 (`sRankHeal` 0, `sRankMult` 1), max 1.

**Curses** (always in the pool, red border, big upside, real cost)
- `greed_protocol` — move bits ×1.6, max integrity −1 (min 1), max 1.
- `hair_trigger` — invalid attempts cost 2 integrity, combo window +2 s, max 1.
- `static_debt` — lose 10 % of bits at each sector start, quest rewards ×2 (`questBonus` +1), max 1.

---

## 5. Economy & scoring

- **Valid move**: bits = `round((1 + bitsPerMove + sizeBits?(size−1) + ghostBits?) × comboMult × bitMult)`, where `comboMult = 1 + 0.2 × min(stacks, comboCap)`. `bitMult` = 1 × sector modifiers × curse multiplier. Momentum adds `stacks`. Tax modifier subtracts 1 (min 0).
- **Combo**: a valid move increments `stacks` if the time since the previous valid move ≤ `comboWindow` (first move starts at 0); otherwise stacks reset to 0. An invalid attempt resets stacks.
- **Gilded landing** on the target: `(4 + sector) × gildedMult` bits.
- **Clear bonus**: `(20 + 8 × sector) × ratingMult` where `ratingMult` S 2.0, A 1.5, B 1.0, C 0.6, ×1.25 in blitz, ×1.5 if a `surge`/`strict`/`tax` modifier applied (use the largest single bonus, not stacking), and `sRankMult` on S.
- **Quest reward**: `quest.reward + 5 × sector`, × `(1 + questBonus)`.
- **Interest**: at sector end, `min(60, floor(bits × interestRate))`.
- **Boss clear**: +1 integrity and a rare-or-better reward offer.
- **Score**: valid move `10 × comboMult`; clear `100 × ringCount × ratingMult`; quest `150` each; boss `500`; end of run `integrity × 100`.

## 6. Par

`parOf` runs Dijkstra over board states (towers as arrays of ring ids) with edge cost 1 or 2 (heavy). Targets the single target tower. Solves ≤ 8 normal rings instantly; with ghosts it may explore more states — cap at 300 000 states and fall back to the closed form `2^n − 1` (adjusted for heavy count) if exceeded.

## 7. Modifiers (per sector, 0–2 per sector; second one from sector 6)

| Id | Min sector | Effect |
|---|---|---|
| `surge` | 2 | bit multiplier ×1.5 this sector; combo window −1 s (min 1.5 s) |
| `strict` | 2 | invalid attempts cost 2 integrity; clear bonus ×1.5 |
| `tax` | 3 | each valid move costs 1 bit (min 0); clear bonus ×1.5 |
| `scramble` | 3 | start layout is a random valid distribution across towers; par via solver |
| `fog` | 4 | visual only: non-top rings are dimmed (flag `sector.fog`) |
| `overclock` | 5 | combo cap +2 stacks; combo window −1 s |
| `gilded_rush` | 5 | guaranteed ≥ 1 gilded ring, gilded payout ×2 |

Boss rules (see `BOSSES`):
- **Sentinel** (sector 4): +1 ring; the largest ring is heavy.
- **Mirror Core** (sector 8): forced `scramble` and `strict`; +1 ring.
- **The Stack** (sector 12): 7 rings, forced `gilded_rush`.
- Endless bosses every 5 sectors cycle Sentinel → Mirror Core → The Stack.

## 8. Quests (objectives, one per sector; bosses add a second)

| Id | Done when | Available |
|---|---|---|
| `efficient` | cost ≤ par + 2 | always |
| `clean` | zero invalid attempts | always |
| `chain` | combo multiplier reached ≥ 2.0 | always |
| `swift` | elapsed ≤ 6 + 1.2 × par seconds | always |
| `gilded` | a gilded ring ends on target | only if sector has a gilded ring |
| `unassisted` | no undo or hint used | always |

## 9. Blitz timer
`timeLimit = (8 + 1.6 × par) × timeMult` seconds. Par-based, so a 7-ring boss gets ~210 s instead of a fixed count-based budget that no bot could meet. On timeout: `board.timeout()` — integrity −1, board resets to `sector.start`, combo reset, timer restarts; if integrity 0 the run ends.

## 10. Run flow (what the player sees)

1. **Title** (hook): NEON RELAY logotype assembles from falling rings; tagline *"Three relays. One signal. Every wrong move costs integrity."* Buttons: START, CODEX (upgrades/ring types seen, best scores), SETTINGS (sound on/off).
2. **Mode select**: Standard, Blitz, Endless, Daily; Ascension toggle appears after one standard win. Each shows its description and best record (localStorage, try/catch).
3. **Sector intro**: `SECTOR 04 · SENTINEL` (boss styling), ring count, target node, modifier chips, quest, forecast if owned. ENGAGE.
4. **Play**: board + HUD (integrity pips, bits, score, combo meter, moves/par, timer in blitz, quest tracker). Controls: click/tap a relay, or keys `1 2 3` (source then target). `U` undo, `H` hint, `Esc` abort to title (confirm).
5. **Sector clear**: rating stamp S/A/B/C, cost vs par, quests ✓/✗, bits and score, interest. CONTINUE.
6. **Reward**: three upgrade cards (rarity colour, stacks shown, curses red). Pick one, or REROLL (cost), or BUY REPAIR (+1 integrity). Current build listed on the side.
7. **Game over / Victory**: cause of death, sectors cleared, score, best, cards taken. RETRY / TITLE.

Keyboard and pointer both work. Canvas scales to the viewport (phone width OK, no horizontal scroll).

## 11. Balance targets (checked by `sim.js`)

Bots: **Optimal** (perfect solver, 0.9 s per move, no errors: this is the skill ceiling), **Human** (solver with a calibrated wrong-click rate, 2.5 s per move including planning time, buys/picks by a fixed priority list, uses hints/undo sensibly; the wrong-click rate is a stated calibration assumption and is printed in the report), **Random** (random picks, 10 % wrong clicks, 3.0 s per move).

Note: a perfect solver in standard mode has no integrity risk, so the Optimal row is a ceiling (must be high, ≥ 90 %), not a difficulty target. Difficulty comes from execution errors, modifiers, bosses and timers.

| Metric | Target |
|---|---|
| Standard, Human bot: win rate | 15–30 % |
| Standard, Human bot: median sector reached | 7–10 |
| Standard, Optimal bot: win rate (ceiling) | ≥ 90 % |
| Endless, Human bot: median sector reached | 9–13 |
| Blitz, Human bot: win rate | 12–25 % |
| Random bot: win rate | < 5 % |
| Any single upgrade: its pick-to-win lift | within ±15 % of the mean |
| Run length, Human bot, standard | 15–25 min (≈ 332 optimal moves × 2.5 s, plus sector intros and reward screens) |

## 12. Visual & audio direction (NEON RELAY)

- Background `#07060f`. Palette: cyan `#3cf2ff`, magenta `#ff2e88`, lime `#b6ff3b`, amber `#ffb020`, violet `#7b5cff`, gold `#ffd23f`, danger `#ff3b5c`, ink `#0b0a18`.
- Ring colours ramp by size: size 1 cyan → violet → magenta → amber at the largest (up to 9 steps, extra sizes repeat with a lighter tint).
- Towers are vertical neon relays with a glow halo, base plate labelled `NODE A/B/C`, target node pulsing with a `TARGET` tag.
- Scanline overlay and faint vignette on every screen; glitch flash and shake on invalid moves; sparks on landing; shockwave on sector clear.
- Menus: perspective synthwave floor with scrolling grid, drifting disks.
- Audio: procedural only (Web Audio), lazy-init on first gesture, a short sweep per move, arpeggio on clear, sting on invalid, low drone on game over.
- Text: kaplay default font with `outline()` for chunky legibility; no external fonts.
