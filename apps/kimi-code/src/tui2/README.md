# TUI2 (opentui + SolidJS) skeleton

This directory is the **structural skeleton** of the v2 TUI stack. It
mirrors `tui/` 1:1 in directory layout and file naming, and each file
currently re-exports the matching `tui/` module so the tree compiles
and resolves imports under the default v1 path.

## Why a parallel directory

`pi-tui` renders to `string[]`; `opentui` owns a real layout tree
backed by Yoga and dispatches mouse events to layout nodes directly.
A clean cut-over is impossible in place -- the rendering model is
different end to end. The parallel directory gives us a place to
land opentui-based rewrites without churning the v1 tree.

The migration plan is:

1. **Phase 0 (this skeleton)**: every `tui2/X.ts` re-exports
   `tui/X.ts`. The env switch (`KIMI_TUI=v2`) routes through `tui2/`
   but ends up at v1, so the build is unchanged.
2. **Phase 1 (theme + primitives)**: replace the stubs in
   `tui2/components/common/`, `tui2/theme/`, and `tui2/constant/`
   with real opentui + SolidJS implementations.
3. **Phase 2 (entry)**: replace `tui2/kimi-tui.ts` and
   `tui2/tui-state.ts` with a real opentui renderer wired to the
   existing controllers (which still live in `tui/controllers/`
   during the migration).
4. **Phase 3+ (component-by-component)**: replace the stubs in
   `tui2/components/dialogs/`, `tui2/components/messages/`, etc.,
   one at a time, keeping the same exported names so call sites
   never move.

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

- **Stub files** start with the banner `// TUI2 SKELETON --` and end
  with a single `export * from '../tui/<mirror-path>';` line. They
  have no logic of their own.
- **Real files** carry a normal `/** ... */` docblock describing
  what they do, and have no skeleton banner.
- **JSX** files end in `.tsx`. Everything else is `.ts`.
- **Imports** follow the existing `#/*` subpath convention for
  cross-module references; relative imports stay relative.

## What is NOT in this skeleton

These stay where they are in v1 until phase 5+ of the migration:

- `tui2/reverse-rpc/` -- reverse-rpc transport has its own protocol
  contract and only swaps the underlying channel.
- `tui2/controllers/` -- the streaming/event/replay controllers are
  the hardest to port because they assume a single-Component render
  loop. They keep depending on `pi-tui` until a SolidJS port exists.
- `tui2/commands/` -- slash commands are pure logic; their UI
  effects ride on whatever Component/dialog implementation is active.
- `tui2/utils/` -- most utility modules are framework-agnostic and
  their stubs just re-export v1 for now.

## How to verify the skeleton

```
pnpm --filter @moonshot-ai/kimi-code build:packages
pnpm --filter @moonshot-ai/kimi-code typecheck
pnpm --filter @moonshot-ai/kimi-code typecheck:tui2
pnpm --filter @moonshot-ai/kimi-code test test/tui2
KIMI_TUI=v2 pnpm --filter @moonshot-ai/kimi-code dev
```

With `KIMI_TUI=v2`, the CLI should start identically to the v1 path
because the v2 surface still re-exports v1. The smoke test
`test/tui2/skeleton.test.ts` asserts the structural invariants
(env switch, public surface, opentui install, real .tsx impls)
without booting a renderer.