# Stage 5 — Verify & submit

Run the guards, keep the dependency map in sync, and re-scan the red lines before submitting.

## Commands

Run from the package (or with `--filter @moonshot-ai/agent-core-v2`):

- `pnpm --filter @moonshot-ai/agent-core-v2 lint:domain` — domain-layer / dependency-direction guard (`scripts/check-domain-layers.mjs`). Catches a domain importing a layer it must not.
- `pnpm --filter @moonshot-ai/agent-core-v2 typecheck` — `tsc -p tsconfig.json --noEmit`.
- `pnpm --filter @moonshot-ai/agent-core-v2 test` — `vitest run`.

## Keep the DI × Scope dependency map in sync

The repo maintains a DI Scope × Domain dependency map. Node color = `LifecycleScope`; solid edges = constructor DI injection; dashed edges = `wireRecord` / event-driven.

- **When to update:** whenever you add a Service or change the dependency relationships between Services.
- **What to do:** edit `packages/agent-core-v2/docs/di-scope-domains.puml` and regenerate the rendered `di-scope-domains.svg`.

## Changesets (when the change ships through the CLI)

If the change is user-facing and ships through the CLI, generate a changeset with the repository's `gen-changesets` skill (root `AGENTS.md` workflow). `agent-core-v2` is an internal package; if its change enters the CLI bundle, the changeset lists `@moonshot-ai/kimi-code` and describes the real change — do not present an internal-only change as a user-facing feature. Never write a `major` bump without explicit user confirmation.

## Pre-submit checklist

Walk the stages you touched and confirm:

- **Design** — scope follows state identity; no `Map<sessionId, …>` at `App`; dependency arrows do not make a foundational layer know an upstream one; no cycle was routed around.
- **Implement** — no `new` on `@IService`-carrying classes; `@IX` on constructor params only (service params after static params); interface + impl carry `_serviceBrand`; decorator names unique; coded errors only; flags for unreleased behavior.
- **Test** — SUT resolved by interface; stubs under `test/`; scope tests re-register after `_clearScopedRegistryForTests()`; teardown through one `DisposableStore`.
- **Files** — header comments describe role + scope only; registration runs from the impl file's top level; the new domain is exported from `src/index.ts`.
- **Dependency map** — `.puml` updated and `.svg` regenerated if Services or their relationships changed.

Then re-read the [global red lines](SKILL.md#global-red-lines) once — they catch most cross-stage mistakes in a single scan.

## Red lines (this stage)

- Do not skip `lint:domain` — it is the only automated check for the dependency-direction rules.
- Do not forget to regenerate the dependency-map `.svg` after editing the `.puml`.
- Do not list internal packages in a changeset when the change enters the CLI bundle — list `@moonshot-ai/kimi-code` and describe the real change.
- Never write a `major` changeset without explicit user confirmation.
