# TUI2 (opentui + SolidJS)

The v2 terminal UI. `tui2/` is a full opentui + SolidJS implementation
that runs alongside the v1 pi-tui tree (`tui/`); `KIMI_TUI=v2` selects
it. The migration is complete — every module in this directory is a
real implementation, and nothing re-exports v1 anymore.

## Why a parallel directory

`pi-tui` renders to `string[]`; `opentui` owns a real layout tree
backed by Yoga and dispatches mouse events to layout nodes directly.
A clean cut-over was impossible in place — the rendering model is
different end to end. The parallel directory is where the opentui
rewrites landed without churning the v1 tree.

## Env switch

`KIMI_TUI` selects the variant:

| value | stack |
|-------|-------|
| unset / `v1` | `tui/` (pi-tui, default) |
| `v2` | `tui2/` (opentui + SolidJS) |

`src/tui2/env.ts` exports `isTuiV2Enabled()` and
`resolveTuiVariant()`. Callers that want to dispatch on the env var
should use those helpers. The CLI entry points
(`apps/kimi-code/src/cli/run-shell.ts` and friends) are the right
place to do the dispatch; the rest of the tree should keep importing
from the path that matches the variant it was written for.

## File conventions

- **UI files come in `.ts` / `.tsx` pairs.** The `.ts` is a thin
  forwarding layer (docblock + `export * from './xxx.tsx'`); the
  implementation lives in the `.tsx`. Pure-logic modules (controllers,
  utils, commands) are single `.ts` files.
- **JSX** files end in `.tsx`. Everything else is `.ts`.
- **Imports** follow the existing `#/*` subpath convention for
  cross-module references; relative imports stay relative.
- Every real file carries a `/** ... */` docblock describing what it
  does and which v1 module it replaces.

## Layout

- `run.tsx` / `entry.tsx` — renderer bootstrap and the editor-scoped
  key interceptor (autocomplete, history recall, transcript
  navigation).
- `controllers/` — the heavy, independently-testable slices:
  `kimi-tui.ts` (host), `session-event-handler.ts` (event routing),
  `streaming-ui.ts` (streaming render), `editor-keyboard.ts` (key
  handling), `transcript-navigation.ts`, `tasks-browser.ts`,
  `auth-flow.ts`, `staging-leases.ts` (staged prompt media lifecycle).
- `components/` — opentui SolidJS components by UI type: `chrome/`
  (footer, banner, todo, welcome), `dialogs/` (selectors, approval /
  question panels, settings), `editor/` (input box + paste markers),
  `messages/` (transcript blocks + tool renderers), `panes/` (queue,
  btw, agent, activity, diff review).
- `theme/` — color tokens, styles, markdown theme, terminal-background
  detection. Single source of truth for color.
- `commands/` — slash-command declaration, parsing and dispatch.
- `utils/` — framework-agnostic helpers (width, printable-key, fuzzy,
  paging, media placeholders, …).
- `constant/` — non-copy constants (streaming knobs, symbols, tips).

## How to verify

```
cd apps/kimi-code
bun run typecheck:tui2
bun --bun run vitest run test/tui2
KIMI_TUI=v2 bun run dev:tui2
```

The smoke test `test/tui2/skeleton.test.ts` asserts the structural
invariants (env switch, public surface, opentui install, real .tsx
impls) without booting a renderer.
