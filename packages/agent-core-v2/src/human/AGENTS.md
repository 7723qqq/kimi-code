# `human/` — the pure kernel

Read this before adding a module under `packages/agent-core-v2/src/human/`. For the LLM
subtree specifically, `src/human/llm/AGENTS.md` and `docs/en/llm.md` carry the detailed
layering rules; this file covers the directory as a whole.

## What "human" means here

Despite the name, this directory is **not** the user-facing or "human interaction" layer. It
is the engine's **pure kernel**: messages, models, protocol shapes, requesters, and the
xstate-based actors the v2 domain composes. The name is historical. Do not put
human-facing presentation, UI concerns, or v2 domain wiring here.

The kernel must stay loadable without the engine's DI container, assets, or configuration.

## The `#human/*` path, and why it is needed

- Files **outside** `human/` reach into the kernel through `#human/...`.
- Files **inside** it use `#/...`, which resolves inside the kernel root.

That second rule hides a two-root resolution that differs by tool, and it is the main hazard
in this directory:

| Where | Mapping | Effect |
| --- | --- | --- |
| `package.json` → `"imports"` (runtime, Bun) | `#/*` → `./src/*.ts` | `#/xstate2` resolves to `src/xstate2.ts`. |
| `tsconfig.json` → `paths` (typecheck) | `#/*` → `["./src/*.ts", "./src/human/*.ts"]` | `#/xstate2` falls through to `src/human/xstate2.ts`. |

So a bare `#/...` specifier written inside `human/` frequently has **no file under `src/`** and
relies on the second `paths` root to typecheck. This is pervasive, not incidental: 109 distinct
specifiers rely on it across 99 non-test files, spanning nearly every kernel subdirectory —
among them `human/session/machine.ts` (imports `#/agent/machine`, `#/agent/turn`,
`#/llm/requester/requester`, `#/tool/executor`, `#/xstate2`) and `human/agent/`, `human/eventStore/`,
`human/store/`, the whole of `human/llm/`, and `human/persist/`.

Consequences to keep in mind:

- `src/session/machine.ts` does **not** exist — a specifier like `#/session/machine` written
  outside `human/` will not resolve to a kernel file, because only the first `paths` root and
  the single runtime mapping apply there.
- A bare `#/...` inside `human/` is not proof that the kernel owns a module of that name; it
  may be a kernel-internal file that simply has not been migrated to `#human/*`.
- It also means `tsc` and the runtime agree only because Bun resolves the `.ts` specifier
  inside the kernel directory when the first root misses. Do not "fix" one of these to
  `#human/*` piecemeal unless you are prepared to touch the whole subtree consistently.
- `scripts/check-import-boundaries.mjs` mirrors this two-root rule, so boundary violations and
  resolution surprises can disagree. Verify with the checker, not by eye.
- When you mean the kernel from outside `human/`, always write `#human/` explicitly.

## Boundaries enforced by tooling

`scripts/check-import-boundaries.mjs` fails the build on violations rather than leaving these
rules to review:

- `human/llm` never imports v2 domains (`app/`, `features/`, `state/`, `workspace/`, `_base/`,
  `llm-adapter`, …).
- Nothing in `agent-core-v2` may import `kosong`; provider and request code lives in
  `human/llm`, and the v2 compatibility boundary is `src/llm-adapter/`.
- Inside `human/llm/requester/bases/<protocol>/`, `format` and `trait` never import each
  other — both speak only the neutral types in that protocol's `contract.ts`.
- `format`, `lower`, `patterns`, and `reasoning-key` are internal to the requester pipeline.

Run `bun run check:boundaries` after touching this tree.

## `human/` versus same-named v2 directories

Several kernel directories share a name with a v2 domain directory. They are unrelated
modules, not duplicates:

| Kernel path | v2 counterpart | Relationship |
| --- | --- | --- |
| `human/agent/` — xstate actor machine, turn, slices, history schema | `agent/loop/`, `agent/contextMemory/` | The v2 loop drives the kernel machine through `agent/loop/machine/engine.ts`. |
| `human/session/` — session machine, stores, slices, events | `session/` (lifecycle, subagent, terminal, usage…) | The kernel owns the actor; the v2 layer owns lifecycle, persistence wiring, and services. |
| `human/compaction/` | `agent/fullCompaction/`, `agent/microCompaction/` | **Removed.** The kernel copy was orphaned by the loop refactor and had no importers. Compaction now lives only in the v2 domain; see below. |
| `human/store/`, `human/persist/`, `human/eventStore/` | `persistence/`, `state/` | Kernel storage primitives versus v2 persistence services. |
| `human/llm/` | `llm-adapter/` | The kernel is the implementation; `llm-adapter` is the v2 compatibility boundary. |

## Removed: `human/compaction/`

`human/compaction/` (controller, machine, summarize, shape, errors) was deleted because every
symbol it exported had zero references outside itself — its only consumers were an
unreferenced barrel export in `human/index.ts` and its own test. Compaction is implemented in
`agent/fullCompaction/` and `agent/microCompaction/`, with the shared prompt assets at
`agent/fullCompaction/compaction-instruction.md` and
`agent/contextMemory/compaction-summary-prefix.md`.

Two of its files had been byte-identical copies of those v2 assets
(`compaction-summary-prefix.md`, `compaction-instruction.md`); deleting the orphan collapsed
each to a single copy. If you find yourself adding a compaction module back under `human/`,
you are almost certainly looking for the v2 domain instead.

## Tests

`human/test/` is included by `vitest.config.ts` (`src/human/test/**/*.test.ts`) even though
`tsconfig.json` excludes it from typechecking. Colocating a test beside the kernel module is
the convention here; note that `check-no-comments.mjs` applies — no comments of any kind.
