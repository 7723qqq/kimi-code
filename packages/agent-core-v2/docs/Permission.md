# Permission System Design

This document systematically lays out the target design for the agent-core permission system and compares it with the current state of `packages/agent-core` (v1). Conclusions first:

> **Status (2026-08-15)**: The v1 package (`packages/agent-core`) has been removed from the repository; §2 "Current state (v1)" is a historical snapshot. Evolution status: step1 (veto listeners + `IAgentToolApprovalService`) is implemented; step2 (`permissionMode` domain + `session/approval` broker) is implemented; step3 (`IPermissionPolicyRegistry` registry) is **not implemented** — `permissionPolicyService.ts` still holds a hardcoded policy array, and a `GuardianReviewPermissionPolicyService` dimension not covered by this document has been added. The current code is the reference implementation.

> **The permission system should be a "composable, registerable chain of responsibility (microkernel)"**: the kernel only runs the chain in order, first hit wins; specific permission dimensions (policies) are inserted by their owning Domain Services through the registry; tools only declare standardized resource accesses (`accesses`) in `resolveExecution`, and generic dimensions consume this metadata centrally.
>
> **The chain only adjudicates danger level.** A policy node answers "how dangerous is this call, and can the user exempt this judgment per call" — the `ask`/`deny` it produces can always be exempted by the user. **Harness constraints are not permissions**: restrictions the runtime imposes for its own correctness (plan mode write prohibition, AgentSwarm batch exclusivity, btw side-question fork tool prohibition, goal budget rejection) produce hard denies with no ask channel that the user cannot exempt per call; they hang on their respective domains as `onBeforeExecuteTool` veto listeners and speak via `event.veto(...)` (precedent: `goalService.ts`'s budget/expiry rejection). Artifact approvals (plan review, goal-start review) are likewise not permissions: the owning domain intercepts its own tools with a cold `event.waitUntil(factory)` and directly drives the shared `IAgentToolApprovalService` approval round-trip — approval can only start after no listener has vetoed the call.
>
> **No Casbin** — because here "the hard part is decision behavior" (continuations, side effects, RPC, state machines), not "matching + scalar decisions".

---

## 1. Background and problem definition

The permission system answers one question: **for each tool call, under the current agent and mode, allow / deny / ask the user?**

This decision has three characteristics that determine its architectural orientation:

1. **The decision carries behavior.** Returning `ask` is not an enum value but a workflow containing RPC round-trips, hooks, telemetry, state writes, and continuations; returning `deny` may be the result of running an external hook.
2. **Policies are heterogeneous.** Some check tool-name sets, some count AgentSwarm instances in a batch, some run hooks, some inspect the plan state machine — there is no uniform `(sub, obj, act)` shape.
3. **Multiple agents × multiple modes × external extension.** Different agents/modes need different permissions, and external parties (org admins, plugins) must be able to contribute rules or behavior in a decoupled way.

---

## 2. Current state (agent-core v1)

Code lives in `packages/agent-core/src/agent/permission/` (removed with the v1 engine).

### 2.1 Architecture: ordered chain of responsibility + first hit wins

`PermissionManager` (`index.ts`) holds a set of `PermissionPolicy`s; when deciding, it iterates in order and the first policy returning non-`undefined` wins:

```ts
// index.ts evaluatePolicies
for (const policy of this.policies) {
  const result = await policy.evaluate(context);
  if (result !== undefined) return { policyName: policy.name, result };
}
```

Each policy is a class implementing the `PermissionPolicy` interface; `evaluate(context)` returns `undefined` when not applicable (passing to the next). `PermissionPolicyResult` is not a scalar but a "behavior package" that can carry continuations and side effects:

```ts
// types.ts
type PermissionPolicyResult =
  | { kind: 'approve'; reason?; executionMetadata? }
  | { kind: 'deny';    reason?; message? }
  | { kind: 'ask';     reason?; resolveApproval?; resolveError? };
```

### 2.2 11 permission dimensions (19 policies)

The chain is currently **hardcoded** in `policies/index.ts#createPermissionDecisionPolicies()`; order is priority. The 19 policies can be grouped into 11 permission dimensions:

| # | Dimension | Policies | What the decision looks at |
|---|---|---|---|
| 1 | External hook veto | `pre-tool-call-hook` | whether the user's `PreToolUse` hook returns block |
| 2 | Tool batch exclusivity | `agent-swarm-exclusive-deny`、`swarm-mode-agent-swarm-approve` | same-batch tool structure (AgentSwarm must be alone) + swarm mode |
| 3 | Run-mode posture | `auto-mode-approve`、`yolo-mode-approve`、`auto-mode-ask-user-question-deny` | `permission.mode` |
| 4 | Plan mode constraints | `plan-mode-guard-deny`、`plan-mode-tool-approve`、`exit-plan-mode-review-ask` | `planMode.isActive` + plan file path + review state |
| 5 | Goal start approval | `goal-start-review-ask` | `tool === CreateGoal` and not auto |
| 6 | Static config rules | `user-configured-deny/ask/allow` | DSL rules configured by user/project/turn |
| 7 | Session approval memory | `session-approval-history` | this session's "approve for session" cache |
| 8 | Sensitive/special paths | `sensitive-file-access-ask`、`git-control-path-access-ask` | file paths the tool accesses |
| 9 | Intrinsic tool risk | `default-tool-approve` | tool name ∈ default safe set |
| 10 | Workspace write trust | `git-cwd-write-approve` | POSIX + git worktree + write within cwd |
| 11 | Fallback | `fallback-ask` | none (ask by default) |

The chain order is a **safety cascade from high to low**: external enforcement → structural denial → state-machine denial → static deny → mode allow → session-memory allow → static ask → static allow → flow allow → sensitive-path ask → default allow → fallback ask.

### 2.3 Resource access declaration: `resolveExecution` + `accesses`

Tools declare the resources they access via `resolveExecution(input)` before execution (`packages/agent-core/src/loop/types.ts`, `tool-access.ts` — removed with the v1 engine):

```ts
interface RunnableToolExecution {
  readonly accesses?: ToolAccesses;        // resources + operations
  readonly matchesRule?: (ruleArgs) => boolean;
  readonly approvalRule: string;
  readonly execute: (ctx) => Promise<ExecutableToolResult>;
}
```

`ToolAccesses` is `ToolResourceAccess[]`, currently supporting two resource kinds, `file` and `all` (see §5.5). Permission dimensions (e.g. `sensitive-file-access-ask`, `git-cwd-write-approve`) read `context.execution.accesses` to decide.

### 2.4 Strengths

- **Clear and auditable**: order is explicit, each policy has a comment explaining its position, the security posture is obvious at a glance.
- **First-hit short-circuit**: most calls (e.g. read-only tools) return at `default-tool-approve`, good performance.
- **Expressive behavior**: `ask` can carry a `resolveApproval` continuation, `executionMetadata`, custom messages, and side effects.

### 2.5 Pain points

1. **Hardcoded chain.** 19 policies are `new`ed in one function; externals cannot contribute.
2. **Mode is an `if` inside policies.** `YoloModeApprove` / `AutoModeApprove` each do `if (mode !== 'x') return`; "different chains per mode" can only be achieved by stuffing in more self-guarding policies.
3. **No per-agent chain entry point** (only scattered `agent.type === 'sub'` checks).
4. **No external extension point.** The only external intervention is the `PreToolUse` hook (occupying one fixed guard slot).
5. **Dimensions for generic tools (bash/write) are centralized in the core**; tools only declare `accesses` and don't know the dimensions exist — an advantage, but it means new dimensions require core changes.

---

## 3. Why not Casbin

Casbin's two selling points (`policy_effect` and flexible priority) don't land in the current business.

### 3.1 `policy_effect` is not needed

`policy_effect` answers "how to combine multiple matched rules". But agent-core's combination logic is a **fixed safety cascade**, and the real complexity lives in each policy's `evaluate` behavior, which Casbin expressions cannot absorb. More importantly: the combination order is safety-related and deliberately hardcoded — external changes are not wanted; the externally adjustable safety knobs are already exposed via `mode` + allow/deny/ask rules.

### 3.2 Flexible priority is not needed

The pain point priority solves is "numeric collisions when multiple modules each contribute rules". agent-core currently has no plugin injection point and no multi-subject/RBAC; the subject is fixed (agent/user), so no collision problem exists. Casbin's `(sub, obj, act)`, `g()`, domain and other abstractions spin idle here.

### 3.3 Fundamental mismatch: decisions are not scalars

`enforce()`'s contract is "input request → output effect". agent-core's decision is a **behavior package**:

| policy | real behavior after returning `ask` |
|---|---|
| `requestToolApproval` | trigger hook → async RPC ask user → record telemetry → write records/replay → optionally write session cache → invoke continuation |
| `goal-start-review-ask` | pop a menu → **switch permission mode** based on the answer → allow |
| `exit-plan-mode-review-ask` | advance the plan state machine → record multiple telemetry → **synthesize a tool result** to short-circuit execution |
| `pre-tool-call-hook` | `deny` is the result of **asynchronously running an external hook** |

These continuations, side effects, and synthesized results have no slot in Casbin's scalar effect. Even if Casbin computed `ask`, a whole set of logic associating `ask` with behavior would still need to be rewritten outside — Casbin degrades to an enum generator.

### 3.4 When Casbin would be worth it

Only when "the hard part is the matching semantics itself" — role inheritance, domain isolation, ABAC expressions, loading policies from a DB — does Casbin earn its place. Not before.

---

## 4. Design pattern positioning

Permission orchestration is not a single pattern but a layered composition:

| Layer | Pattern | Role |
|---|---|---|
| Runtime decision | **Chain of Responsibility** | multiple candidate handlers in order, first hit wins, rest short-circuit |
| Single handler | **Strategy** | each policy is an interchangeable implementation of the "permission adjudication" algorithm family |
| Assembly / external extension | **Plugin / Microkernel** | minimal kernel + explicit extension points + pluggable policies |
| Implementation support | **Registry + Factory** | collect plugins; assemble chains on the spot per (agent, mode) |

Paradigm comparison with Casbin:

- **Casbin = single Strategy + data-driven**: all decisions go through the same matcher expression, differences are compressed into policy rows (data).
- **This design = multiple Strategies + chain composition**: each policy is an independent strategy, differences live in code, assembled by the chain.

Behavior-intensive systems must choose the latter — behavior cannot be compressed into data rows.

---

## 5. Target design

### 5.1 Core principles

1. **The chain encodes "permission dimensions", not "tools".** New tools don't lengthen the chain; only new dimensions add nodes.
2. **Two contribution paths**: high-frequency trivial concrete content goes the **data path** (rules); low-frequency behavioral new dimensions go the **code path** (policies).
3. **Guards/reviews off the chain, risk onto the chain**: Harness constraints and artifact approvals hang on their owning domains as executor hooks (see 5.4); domain-contributed **risk** dimensions self-register policies in DI, mirroring v2's existing "domain self-registers tools".
4. **Tools declare resources, generic dimensions consume**: bash/write/read etc. only declare `accesses`; file/security dimensions judge centrally.

### 5.2 Core abstractions

```ts
type Phase =
  | 'guard' | 'user-deny' | 'mode' | 'session'
  | 'user-ask' | 'default' | 'fallback';

interface PermissionPolicyEntry {
  name: string;
  phase: Phase;
  modes?: PermissionMode[];        // declares which modes it applies to (no more if in evaluate)
  agentTypes?: AgentType[];
  factory: (accessor: ServicesAccessor) => PermissionPolicy;
}

// App scope — collects registrations from all domains
interface IPermissionPolicyRegistry {
  register(entry: PermissionPolicyEntry): IDisposable;
  list(): readonly PermissionPolicyEntry[];
}
```

`PermissionPolicyService` (Agent scope) changes from a hardcoded list to "assemble per (agent, mode)":

```ts
this.policies = registry.list()
  .filter(e => !e.modes    || e.modes.includes(mode))
  .filter(e => !e.agentTypes || e.agentTypes.includes(agentType))
  .sort(byPhaseThenRegistrationOrder)
  .map(e => e.factory(accessor));
```

Key points:

- `modes`/`agentTypes` are **declarations**, lifting the `if (mode !== 'yolo') return` in today's `YoloModeApprove` into metadata.
- `factory` rather than `instance`: nodes may depend on agent-scoped services (mode, rules) and need instantiation at Agent scope — symmetric to `IToolDefinitionRegistry`(App) storing factories and `IToolService`(Agent) instantiating tools.
- **Different (agent, mode) produce differently shaped chains**: under yolo, the ask/fallback phases are physically filtered out.

### 5.3 Two contribution paths

| What's new… | Path | Chain length change |
|---|---|---|
| New tool, new org rule, new user preference ("ban `Bash(curl *)`") | **Data path**: add a `PermissionRule` to an existing node | unchanged |
| New cross-cutting behavior (custom approval UI, audit logs, new mode) | **Code path**: register a new policy node | +1 |

The vast majority of growth goes the data path — node count is bounded by "behavior kinds", while rule count grows with concrete situations (rule matching is a cheap Set/glob).

### 5.4 Domain dimensions: guards/reviews via executor veto events, risk dimensions via chain registration

**Harness constraints and artifact approvals no longer go on the chain.** The owning domain registers an `onBeforeExecuteTool` veto listener and adjudicates through the event object:

```ts
// src/plan/planService.ts — constructor
constructor(@IAgentToolExecutorService executor, ...) {
  executor.onBeforeExecuteTool((event) => this.guardToolExecution(event));
}
```

- Veto events have no ids and no ordering contract. Listeners speak via `event.veto(result)` (first come first served, terminates adjudication), `event.allow()` (final allow, terminates all further statements including the permission gate itself), `event.pass(metadata)` (allow with a trace, does not terminate others' statements), or `event.waitUntil(factory)` (declares a pending adjudication that needs external input).
- **Guard (hard deny)**: `event.veto(denyToolExecution(toolApproval.formatDenyMessage(...)))`. An immediate veto suppresses all pending `waitUntil` factories — a deny can never be preceded by someone else's approval popup.
- **Review (artifact approval)**: intercept own tools, `event.waitUntil(() => ...requestToolApproval(event, ask, origin))`. The factory is cold — the executor only fulfills it after all listeners have run and nobody vetoed/allowed, so a review Interaction can only be emitted once the call is confirmed to proceed; when no approval is needed, stay silent and let user rules keep working.
- **Pure allow**: don't `allow()` casually — add the tool to the `default-tool-approve` whitelist to preserve the priority of user deny/ask rules; reserve `allow()` for scenarios that must bypass the whole permission chain, like the plan-file write guard.

**Domain-contributed risk dimensions still go on the chain** (the registry path below): domains whose state changes the *danger* conclusion self-register policies via `IPermissionPolicyRegistry`, mirroring v2's existing "domain calls `toolRegistry.register(...)` in its constructor" practice. Complex domains may register only **one composite node** (Composite) externally, running a small internal chain, to avoid leaking internal ordering into the global chain.

### 5.5 Tools declare resources at runtime (`resolveExecution` / `accesses`)

Tools declare the resources they access in `resolveExecution(input)`, before execution, using the `ToolAccesses.*` builders:

```ts
// v1: packages/agent-core/src/tools/builtin/file/write.ts (removed with the v1 engine)
resolveExecution(args: WriteInput): ToolExecution {
  const path = resolvePathAccessPath(args.path, { kaos, workspace, operation: 'write' });
  return {
    accesses: ToolAccesses.writeFile(path),            // declares: writing this file
    approvalRule: literalRulePattern(this.name, path),
    matchesRule: (ruleArgs) => matchesPathRuleSubject(ruleArgs, path, ...),
    execute: () => this.execution(args, path),
  };
}
```

`ToolAccesses` currently has two resource kinds:

```ts
type ToolResourceAccess =
  | { kind: 'file'; operation: 'read'|'write'|'readwrite'|'search'; path: string; recursive?: boolean }
  | { kind: 'all' };   // side effects that cannot be enumerated (pessimistic, globally exclusive)
```

**Two complementary channels**:

- **Enumerable resources** (write/read/edit/grep/glob) → use `accesses`; generic file dimensions cover them automatically.
- **Non-enumerable resources** (bash running arbitrary commands) → don't declare `accesses`; use the `matchesRule` DSL instead (e.g. `Bash(rm *)` globs the command string).

**kaos's role**: kaos is the execution-environment abstraction (fs/process/pathClass) that file dimensions use for path normalization and judgment — **not a permission-dimension abstraction itself**. Permission semantics live in the "file access" layer above kaos.

**v2 evolution direction**: extend the `ToolResourceAccess` union so non-file resources can also be declared structurally:

```ts
type ToolResourceAccess =
  | { kind: 'file';      operation: FileOp; path: string; recursive?: boolean }
  | { kind: 'network';   operation: 'connect'; host: string }
  | { kind: 'shell';     command: string }
  | { kind: 'datastore'; operation: 'read'|'write'; table: string }
  | { kind: 'all' };
```

Each new resource kind can get a generic dimension consuming it; the tool side always only **declares**.

### 5.6 Dimension ownership

| Dimension | Owner | Type |
|---|---|---|
| External hook veto | `externalHooks` domain | generic |
| Tool batch exclusivity | `swarm` domain — `onBeforeExecuteTool` veto listener | Harness constraint (off-chain) |
| Plan write guard | `plan` domain — `onBeforeExecuteTool` veto listener | Harness constraint (off-chain) |
| Plan approval | `plan` domain — same listener's `waitUntil` + `toolApproval` | artifact approval (off-chain) |
| Goal start approval | `goal` domain — veto listener's `waitUntil` + `toolApproval` | artifact approval (off-chain) |
| Goal budget/expiry rejection | `goal` domain — `onBeforeExecuteTool` veto listener | Harness constraint (off-chain) |
| btw tool prohibition | `btw` domain — veto listener on the fork | Harness constraint (off-chain) |
| Run-mode posture (auto/yolo) | `permissionMode` domain (chain node, pending "tier × routing" split) | generic |
| Static config rules | `permissionRules` domain | generic (data path) |
| Session approval memory | `permissionRules` domain | generic |
| Sensitive/special paths | generic "file access/security" dimension | generic (consumes `accesses`) |
| Intrinsic tool risk | core permission (`default-tool-approve`) | generic (consumes tool declarations) |
| Workspace write trust | generic "file access/security" dimension | generic (consumes `accesses`) |
| Fallback | core permission | generic |
| Approval round-trip | `toolApproval` domain — shared by the gate's ask and each domain's review | infrastructure |

Pattern: **Harness constraints and artifact approvals follow the owning domain via `onBeforeExecuteTool` veto listeners; risk dimensions go on the chain as policies (self-registered once the registry lands); generic dimensions register centrally and take effect across tools via the `accesses` tools declare.**

---

## 6. Current state vs. target design

| Aspect | Current (v1) | Target design |
|---|---|---|
| Chain construction | `policies/index.ts` hardcodes 19 `new`s | `IPermissionPolicyRegistry` collects; `compose(agent, mode)` assembles |
| Mode handling | `if (mode !== 'x') return` inside policies | declarative `modes` metadata, filtered at compose |
| Per-agent distinction | scattered `agent.type === 'sub'` | declarative `agentTypes` metadata |
| External extension | only the `PreToolUse` hook, one fixed slot | registry open for policy (code) + rule (data) registration |
| Domain dimensions | centralized in core files | guards/reviews via domain-owned `onBeforeExecuteTool` veto listeners; risk dimensions via domain self-registered policies |
| Tool dimensions | tools declare `accesses`, dimensions centralized | unchanged; extend `ToolResourceAccess` resource kinds |
| Decision behavior | continuations + side effects (already present) | unchanged (core capability that must be preserved) |
| Runtime performance | ordered chain + short-circuit | unchanged; tool-name index optimization possible when nodes grow |

**Unchanged**: the chain-of-responsibility kernel, first-hit-wins, the `PermissionPolicyResult` behavior package, the `resolveExecution`/`accesses` mechanism.

**Changed**: the chain goes from "hardcoded list" to "registry + factory assembly"; mode/agent go from "internal if" to "declarative metadata"; dimension ownership goes from "centralized in core" to "domain self-registration".

---

## 7. Evolution path

Incremental, avoiding a big bang:

1. ~~**Domain dimensions moved off the chain**~~ (done). plan guard/review, goal-start review, swarm batch exclusivity, and btw deny-all have been moved off the chain onto `onBeforeExecuteTool` veto listeners in their respective domains (immediate `veto`/`allow`/`pass` statements + cold `waitUntil` factories carrying approval round-trips); the approval round-trip was extracted into the shared `IAgentToolApprovalService`; the `registerPolicy` mechanism was removed (btw was its only production use). Only 12 danger-adjudication nodes remain on the chain.
2. **Tier × routing split**. Split "danger tier" (read-only/read-write/yolo — the substance of `yolo-mode-approve`) from "interaction routing" (the substance of `auto-mode-approve` / `auto-mode-ask-user-question-deny`: routing ask and review without the user); the routing layer lands on the `session/approval` broker, and the remaining 3 mode policies leave the chain in this step.
3. **Registry + Composer (zero behavior change)**. Replace the hardcoded `new`s in `PermissionPolicyService`'s constructor with reads from `IPermissionPolicyRegistry` and assembly; mode gating is promoted to `modes` metadata. Gains multi-agent/mode selectable chains and an external registration entry point.
4. **Step 4 (on demand): extend resource kinds**. When non-file resources (network/DB/shell) need structured dimensions, extend the `ToolResourceAccess` union.
5. **Step 5 (on demand): swap the matching kernel for Casbin**. Only if external rules genuinely need RBAC/ABAC semantics, replace the data path's rule-matching kernel with Casbin. Not before.

---

## 8. Open questions

1. **Composite node boundaries**: which domains use composite nodes internally (hiding sub-order), which register multiple phase nodes directly?
2. **Ordering of multiple nodes in the same phase**: is registration order enough, or is an explicit `order` escape hatch needed?
3. **`ToolResourceAccess` extension cadence**: which non-file resources get priority (shell / network / datastore)?
4. **v1 → v2 migration timing**: the v2 permission subsystem is currently a thin wrapper over v1 types/logic; when should `accesses`, `PermissionPolicyResult` etc. be promoted to first-class v2 types?
5. **Runtime performance threshold**: at how many nodes should a tool-name index (`byTool` dispatch) optimization be introduced? The current 12 nodes with first-hit short-circuit are far from it.
