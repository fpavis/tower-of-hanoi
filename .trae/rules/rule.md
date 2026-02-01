## 1. Stack
- **Engine**: Kaplay `v3001.0.12` (CDN).
- **Lang**: JS (ES6+).
- **Audio**: Web Audio API (Procedural only).

## 2. Naming
- **Vars/Funcs**: `camelCase`.
- **Constants**: `UPPER_SNAKE_CASE`.
- **Tags**: `kebab-case` or `camelCase`.
- **Scenes**: `lowercase`.
- **DOM**: `kebab-case` IDs -> `camelCase` JS refs.

## 3. Architecture
- **Global**: `global: true`. Use Hex colors (`#ff0055`) over `rgb()`.
- **State**: Centralize in `state`. Constants in `modifiers`. Reset via `initRun()` / `startLevel()`.
- **Scenes**: Use `"menu"` (init/cleanup) and `"game"` (loop). Transition: `go()`.
- **UI**: Pure Kaplay UI. Use `rect({ radius: 8 })` for rounded corners. Load custom fonts via `loadFont()`.

## 4. Best Practices
- **Components**: `add([ rect(), pos(), area(), "tag" ])`.
- **Anchors**: Always set `anchor()` (e.g., `"bot"`, `"center"`).
- **Input**: `area()` + `.onClick()`.
- **Tweens**: Capture vars locally before async calls (`const d = disk; tween(d.pos...)`).
- **Audio**: Lazy init `AudioContext` on user gesture.

## 5. Workflow
- **Debug**: `debug: true` for hitboxes.
- **Logs**: Log state changes.
- **Test**: Play full level transition.

## 6. Checklist
1. [ ] Pure Kaplay UI?
2. [ ] Objects tagged?
3. [ ] Tweens safe (local vars)?
4. [ ] Audio lazy loaded?
5. [ ] Custom fonts used?
