# Stage 1 — Orient

Understand the DI × Scope black box and the file conventions before touching business code.

## The DI black box

When writing business code you declare three things; the container handles the rest (when to construct, whether it is the same instance, ordering, disposal):

- **Who am I** — an identity that is both a runtime key and a compile-time type.
- **Whom do I need** — the dependencies that provide my capabilities.
- **How long do I live** — which lifetime tier I belong to.

Classes talk only to interfaces and never care how an implementation is constructed.

## The three `LifecycleScope` tiers

Lifetimes form a tree, from longest to shortest:

```text
App (0)         process-wide, single global instance
 └── Session (1)    one session
      └── Agent (2)    one agent
```

```ts
export enum LifecycleScope {
  App = 0,
  Session = 1,
  Agent = 2,
}
```

- A larger number = shorter life = closer to a leaf.
- "Singleton" means **one per scope**: `ILogService` is global once; each `Session` scope has its own `ISessionService`.
- `kind` strictly increases along the parent→child direction.

### Visibility rule

A child scope sees its ancestors; a parent never sees its children. Resolution walks *up* the tree:

- ✅ An `Agent` service injects a `Session` or `App` service (found upward).
- ❌ An `App` service injects a `Session` service (the parent does not look down, and the child may not exist yet).

> **Short-lived may inject long-lived; never the reverse.** The tree structure enforces this — it is not a matter of discipline.

### Disposal order

Deterministic: **child scopes die first; within one scope, instances dispose in reverse construction order** (last constructed, first disposed). Business code declares which tier it lives in and never disposes by hand.

## File-header comment convention

`packages/agent-core-v2/AGENTS.md` mandates a header-only comment style:

- **Header only.** Comments live solely in the top-of-file `/** */` block — never beside functions, methods, or statements. The code is the source of truth for *how*; the header states *what the module exposes and the responsibility it owns*.
- **Identity line first.** Start with `` `<domain>` domain (Ln) — <one-line role>. `` Keep an existing `(cross-cutting)` label as-is; barrels omit the layer (`` `<domain>` domain barrel — … ``). Write the role as a responsibility ("drives the turn lifecycle"), not a symbol list.
- **Scope is in the filename.** `session*.ts` = Session, `agent*.ts` = Agent, no prefix = App (see service-authoring.md). State the same scope in the header so the two never drift.
- **Interface files** (`<name>.ts`) state the public contract + scope: which `IXxx` they define and what it is for.
- **Impl files** (`<name>Service.ts`) add collaborators + scope: list every imported cross-domain collaborator as a role ("persists records through `records`"); read scope from `registerScopedService(LifecycleScope.X, …)`.
- **Contribution files** (`<targetDomain>.ts` / `<what>.contrib.ts`) state what they register into the target domain (e.g. "registers the `log` config section into `config`").
- **Pure-function / `.types` / `.errors` files** state the responsibility only — they own no scoped state, so no scope line.

Impl file example (`sessionService.ts`):

```ts
/**
 * `session` domain (L6) — `ISessionService` implementation.
 *
 * Owns the session's child-agent set and session-level operations; drives
 * agent lifecycle through `agentLifecycle`, broadcasts through `event`,
 * persists session metadata through `records`, and records activity through
 * `sessionActivity`. Bound at Session scope.
 */
```

Contribution file example (`config.ts` inside `log/`):

```ts
/**
 * `log` domain — registers the `log` config section into `config`.
 *
 * Owns the `log` section schema and its env overlay; imported for the
 * registration side effect. Bound at App scope.
 */
```

Barrel example:

```ts
/**
 * `session` domain barrel — re-exports the session contract (`session`),
 * its scoped service (`sessionService`), and its contribution files. Importing
 * this barrel registers the `ISessionService` binding into the scope registry.
 */
```

## Red lines (this stage)

- Import via the `#/...` alias (mapped to `src/`); never reach into another domain's internals by relative path.
- Short-lived may inject long-lived; never the reverse.
- File-header comments describe role and scope only; never narrate implementation beside statements.
