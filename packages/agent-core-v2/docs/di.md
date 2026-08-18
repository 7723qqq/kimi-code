# DI (Dependency Injection) and Scope — a scenario-driven guide

> This document walks through the scenarios you'll hit when "adding business functionality to agent-core-v2", from simplest to most complex, introducing DI concepts one at a time.
> Source lives in [`src/_base/di/`](../src/_base/di/); testing conventions in [`docs/di-testing.md`](di-testing.md).

---

## 0. Treat DI as a black box first

When writing business code, you only declare three things to this black box:

- **Who I am** — an "identity" that works as both a key and a type.
- **Who I need** — who provides my dependencies.
- **How long I live** — which lifecycle tier I belong to.

Everything else (when to create, whether it's the same instance, who comes first, when to dispose) is the container's job. Classes only deal with interfaces and never care how implementations are `new`ed.

Each scenario below introduces only the piece of DI it needs. Follow the scenarios and the concepts accumulate.

---

## Scenario 1: Add a global service (depending on nothing)

> What you're doing: a process-wide, universally usable basic capability, e.g. logging, telemetry. See [`log`](../src/_base/log/log.ts).

This step introduces four pieces: **interface / identity / implementation / registration**.

### 1.1 Write the interface, with `_serviceBrand`

```ts
// greet/greet.ts
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IGreeter {
  readonly _serviceBrand: undefined;   // type marker: tells DI "this is a service"
  hello(): string;
}

export const IGreeter: ServiceIdentifier<IGreeter> = createDecorator<IGreeter>('greeter');
```

The `ServiceIdentifier` produced by `createDecorator(name)` serves two roles: at runtime it's a key and a parameter decorator; at compile time it carries the `IGreeter` type.

> ⚠️ **Constraint: identity names must be globally unique.** `createDecorator` caches by `name`; the same name returns the same identity. Two domains using the same string collide and share one identity.

### 1.2 Write the implementation class

```ts
// greet/greetService.ts
import { LifecycleScope } from '#/app/scopes';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { IGreeter } from './greet';

export class Greeter implements IGreeter {
  declare readonly _serviceBrand: undefined;   // matches the interface's _serviceBrand
  hello(): string { return 'hi'; }
}
```

The implementation class uses `declare readonly _serviceBrand: undefined;` to match the type marker on the interface.

### 1.3 Register to a lifecycle tier

```ts
// greet/greetService.ts (file top level, runs at import time)
registerScopedService(
  LifecycleScope.App,               // how long it lives: process-wide
  IGreeter,                          // identity
  Greeter,                           // implementation
  ScopeActivation.OnScopeCreated,   // constructed when the App scope is created
  'greet',                           // domain name (for debugging)
);
```

Which tier a class is bound to is an **inherent property** of the class, decided at the registration point, not the call site.

### 1.4 Export from the package entry so the registration takes effect

```ts
// src/index.ts (package entry, exporting each leaf file individually; no <domain>/index.ts barrel)
export * from '#/greet/greet';
export * from '#/greet/greetService';   // exporting this line triggers the registerScopedService above
```

So "importing the package" = "loading all registrations". **There is no central assembly file and no domain barrel**: bindings are scattered in each domain's implementation files, collected via import side effects; `src/index.ts` does `export * from '#/<domain>/<file>'` for each leaf file individually (see the `#/app/flag/*` pattern). Registrations default to `ScopeActivation.OnScopeCreated`, constructing the real instance when the corresponding scope is created; only services explicitly declaring `ScopeActivation.OnDemand` defer construction to the first `get()` (see scenario 5).

At this point anyone can `accessor.get(IGreeter)` to get this globally unique service.

---

## Scenario 2: Your service uses other services

> What you're doing: your service needs capabilities from other domains. See [`sessionMetadataService.ts`](../src/session/sessionMetadata/sessionMetadataService.ts).

This step introduces: **constructor injection** and **resolution by interface**.

### 2.1 Declare dependencies with `@IX` on the constructor

```ts
export class SessionMetadata extends Disposable implements ISessionMetadata {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
    @ILogService private readonly log: ILogService,
  ) {
    super();
  }
}
```

`@ISessionContext` does exactly one thing: records "the 0th parameter needs `ISessionContext`" on the class's metadata. When the container `new`s this class, it reads the metadata and fills in the dependencies.

### 2.2 Three unbreakable constraints

1. **Never `new` a class with `@IService` dependencies.** `new` bypasses the container: bypasses registration, scope, and singleton caching. Use `@IX` injection or `accessor.get(IX)`.
2. **`@IX` can only decorate constructor parameters.** Decorating fields/methods throws at runtime.
3. **Service parameters come after static parameters** (static parameters in scenario 7).

### 2.3 Consumers get by interface, never see the implementation

```ts
const meta = accessor.get(ISessionMetadata);   // type is ISessionMetadata
```

Consumers only import the **interface** and the **`IX` identity**, never the implementation class. This is the key to DI holding the "interface → implementation" substitution right entirely in the container's hands.

> If what you need is not "a service" but "a piece of configuration", the usual approach is to make it a service too and inject it (e.g. `IConfigService`); if it's "a non-singleton object with parameters, one per turn", see scenario 7.

---

## Scenario 3: Your service is not global

> What you're doing: one per session, or one per agent. See [`sessionMetadata`](../src/session/sessionMetadata/sessionMetadata.ts), [`agentLoop`](../src/agent/loop/loop.ts).

This step introduces: **the four-tier `LifecycleScope`** and **parent/child scope visibility**.

### 3.1 Four tiers, longest-lived first

```ts
// src/app/scopes.ts (business-layer declaration; the kernel only knows opaque string kinds and topological order)
export enum LifecycleScope {
  App = 'app',             // process-wide, one global instance
  Workspace = 'workspace', // one workspace handler (one-to-many with Sessions)
  Session = 'session',     // one session
  Agent = 'agent',         // one agent
}
```

The further down the topology, the shorter the lifetime and the closer to the leaves. Register with the corresponding tier as `scope`:

```ts
registerScopedService(
  LifecycleScope.Session,
  ISessionMetadata,
  SessionMetadata,
  ScopeActivation.OnDemand,
  'sessionMetadata',
);
```

The granularity of "singleton" is **one per scope**: the App `ILogService` has exactly one instance globally; each Session scope has its own `ISessionMetadata`.

### 3.2 Child scopes see parent scopes, not vice versa

A scope is a tree; `kind` must **strictly increase** along the parent-child direction:

```
App (0)
 └── Workspace (1)
      └── Session (2)
           └── Agent (3)
```

When resolving a service, the container first looks at its own tier, then **recursively asks parent scopes**. Hence one iron rule:

> **Short-lived services can inject long-lived services; the reverse is not allowed.**

- ✅ An Agent service can inject Session / Workspace / App services (looks upward, finds them).
- ❌ An App service cannot inject a Session service (the Session doesn't exist when App is created, and parents don't look downward).

This rule is enforced by the tree structure, not by discipline.

---

## Scenario 4: Your service must release resources

> What you're doing: your service subscribed to events, started timers, or holds handles that must be released when the scope is disposed. See `FlagService` ([`flagService.ts`](../src/app/flag/flagService.ts)).

This step introduces: **the `Disposable` / `IDisposable` lifecycle**.

```ts
import { Disposable } from '#/_base/di/lifecycle';

export class FlagService extends Disposable implements IFlagService {
  declare readonly _serviceBrand: undefined;

  constructor(@IConfigService private readonly config: IConfigService) {
    super();
    this._register(
      this.config.onDidChangeConfiguration(() => { /* … */ }),   // collect child resources
    );
  }
}
```

- Extend `Disposable` and use `this._register(d)` to collect any `IDisposable` (event subscriptions, `toDisposable(fn)`, etc.).
- When the container disposes this service, it automatically calls its `dispose()`, releasing the registered child resources.

Disposal order is deterministic (see the tree in scenario 3): **child scopes die first; within the same scope, release in reverse construction order** (later `new`ed released first). Business code only declares "which tier I live in" and never disposes manually.

---

## Scenario 5: Choosing when a service is constructed

> What you're doing: decide whether the service is created with the Scope, or on first request.

This step introduces the single construction-timing option: **`ScopeActivation`**.

```ts
export enum ScopeActivation {
  OnScopeCreated = 0,
  OnDemand = 1,
}
```

```ts
// default: construct the real instance when the App scope is created
registerScopedService(
  LifecycleScope.App,
  ILogService,
  LogService,
  ScopeActivation.OnScopeCreated,
  'log',
);

// on demand: construct the real instance on first get(IDebugGraphService) (real example: src/debug/debugGraphService.ts)
registerScopedService(
  LifecycleScope.App,
  IDebugGraphService,
  DebugGraphService,
  ScopeActivation.OnDemand,
  'debug',
);
```

`ScopeActivation.OnScopeCreated` is the default for the fourth parameter. When a scope is created, the container constructs all services using this mode, constructing their dependencies first. If any constructor fails, the service keeps a sticky `Failed` state (scope creation itself does not fail); subsequent `get()` rethrows the original construction error, and `update()` can reload. Ordinary services and constructor side effects that must take effect when the scope is ready use this mode.

`ScopeActivation.OnDemand` only saves the descriptor and does not construct the service at scope creation. The first `get()` constructs and caches the real instance; later `get()`s return the same instance. Use this mode only when the constructor genuinely must wait until the service is requested.

Both modes share the same dependency graph; cycles throw `CyclicDependencyError` in both.

The full signature is `registerScopedService(scope, id, ctor, activation = ScopeActivation.OnScopeCreated, domain?)`: the fourth parameter is activation, the fifth is domain.

---

## Scenario 6: Using a service temporarily in a plain function

> What you're doing: you don't want to write a new class, just grab a service temporarily inside a function. Or you need to expose a `ServicesAccessor` externally. See [`gatewayService.ts`](../src/app/gateway/gatewayService.ts).

This step introduces: **`IInstantiationService.invokeFunction`** and **`ServicesAccessor`**.

```ts
const accessor: ServicesAccessor = {
  get: <T>(id: ServiceIdentifier<T>): T => instantiation.invokeFunction((a) => a.get(id)),
};
```

`invokeFunction(fn)` gives `fn` a `ServicesAccessor` that is **valid only during this invocation**.

> ⚠️ **Constraint: the accessor is only valid during the invocation.** Calling `accessor.get()` after `invokeFunction` returns throws `"service accessor is only valid during the invocation"`. Don't stash the accessor for async use — to hold a service long-term, inject it in the constructor (scenario 2).

---

## Scenario 7: Creating objects with dependencies that are not singletons

> What you're doing: every turn needs a `new` object that also has `@IService` dependencies. E.g. a per-turn executor.

This step introduces: **`IInstantiationService.createInstance`** and **static parameters**.

```ts
class TurnRunner {
  constructor(
    private readonly input: string,                 // static parameter: passed at call time
    private readonly turn: number,                  // static parameter: passed at call time
    @ILogService private readonly log: ILogService, // service parameter: injected by the container
  ) {}
}

// at call time: you pass static parameters, the container fills service parameters
const runner = instantiation.createInstance(TurnRunner, 'hello', 1);
```

The container puts static parameters first, service parameters after, then `Reflect.construct`s the instance. This object is **not** put into any scope's singleton cache — every time is a new instance.

> This is why "service parameters must come after static parameters": the container sorts by the parameter positions recorded by `@IX` and injects in order. `_serviceBrand` lets the compiler distinguish the two kinds of parameters at the type level.

---

## Scenario 8: Your service spawns child containers / child scopes

> What you're doing: your service is responsible for "spinning up a new session / new agent" and needs a child scope for it. See `RestGateway` ([`gatewayService.ts`](../src/app/gateway/gatewayService.ts)).

This step introduces: **injecting `IInstantiationService` itself** and **`createChild`**.

Every container binds itself as `IInstantiationService`, so you can inject it like any other service:

```ts
// the core three steps when manually controlling the ServiceCollection (full wrapper in createScopedChildHandle,
// src/_base/di/scope.ts — it also filters this tier's descriptors and runs scope activation)
const collection = new ServiceCollection();
const child = instantiation.createChild(collection);   // spawn a child container
const accessor: ServicesAccessor = {
  get: <T>(id: ServiceIdentifier<T>): T => child.invokeFunction((a) => a.get(id)),
};
const handle: IScopeHandle = {
  id: sessionId,
  kind: LifecycleScope.Session,
  accessor,
  dispose: () => child.dispose(),
};
```

Key points:

- `getScopedServiceDescriptors(scope)` returns all descriptors registered at a tier (`createScopedChildHandle` uses it to filter this tier's descriptors, see [`scope.ts`](../src/_base/di/scope.ts)).
- `instantiation.createChild(collection)` creates a child container whose parent pointer points at the current container — so the child can resolve upward to App services (scenario 3's visibility rule).
- When exposing externally, wrap the child container as a `ServicesAccessor` with `invokeFunction` (scenario 6).

> Higher layers usually use [`Scope.createChild(kind, id)`](../src/_base/di/scope.ts) directly (it does "filter descriptors + build child container + construct `OnScopeCreated` services" for you); only write it like above when you need manual control of the `ServiceCollection` — a manual `createChild` does not run scope activation, and services must be resolved by consumers.

---

## Scenario 9: Hitting a circular dependency (not allowed, refactor)

> Business rule: **circular dependencies are not allowed.** The container rejects them; the correct response is to refactor, not to make it run.

### 9.1 The container rejects synchronous cycles

A needs B while being created, B needs A while being created — the container throws `CyclicDependencyError` with a `path` like `['A', 'B', 'A']`. Self-cycles (A depending on itself) are rejected too. This is not a bug; it's a protection mechanism telling you "the responsibilities of these two services were split wrong".

### 9.2 Why not allowed

- Scope layering makes normal dependencies naturally a DAG (Agent → Session → Workspace → App, looking upward); a cycle is almost always a design smell.
- Making "the cycle just barely run" turns construction order into an implicit convention that's hard to debug and hard to reason about.

So v2's stance: **the dependency graph must be acyclic.**

### 9.3 How to refactor when you hit one

Consider in priority order:

1. **Extract a third service C.** Move the part A and B need from each other into C, so A and B both depend on C instead of each other. This is the most common fix.
2. **Decouple with events.** If A only wants to know about some change in B, have B emit events through `IEventService` and A subscribe, instead of A holding a reference to B.
3. **Re-partition scopes.** Maybe one of them doesn't belong at this tier — it should live shorter or longer; after moving, the cycle naturally disappears.

### 9.4 Activation mode cannot break a cycle

`ScopeActivation.OnScopeCreated` and `ScopeActivation.OnDemand` both construct services through the same synchronous dependency graph. Changing the activation mode cannot make a circular dependency legal. When you hit `CyclicDependencyError`, refactor per 9.3.

---

## Scenario 10: Writing tests for services

> What you're doing: make tests go the same path as production — resolve by interface, dependencies injected by the container.

This step introduces: **two test harnesses**. See [`docs/di-testing.md`](di-testing.md) for details; here are only the selection criteria:

| What to test | Which harness | How to get the SUT |
|---|---|---|
| A single service's behavior (unit) | `TestInstantiationService` (flat container) | `ix.set(ISut, new SyncDescriptor(Sut))` then `ix.get(ISut)` |
| Cross-scope wiring / which tier a service lives in | `createScopedTestHost` (scope tree) | `host.<scope>.accessor.get(ISut)` |

Core rule: **resolve the system under test by interface, never `new` an implementation class with `@IService` dependencies** — otherwise the `registerScopedService(IX → Impl)` binding never runs in the test.

---

## Appendix A: Interface quick reference

| Interface | Scenario | Role |
|---|---|---|
| `createDecorator<T>(name)` → `ServiceIdentifier<T>` | 1 | create an identity (runtime key + compile-time type + parameter decorator) |
| `@IService` | 2, 7 | declare a dependency on a constructor parameter |
| `registerScopedService(scope, id, ctor, activation, domain)` | 1, 3, 5 | bind an implementation to a lifecycle tier and construction timing |
| `ServicesAccessor.get(IX)` | 2, 6 | resolve an instance by interface |
| `IInstantiationService.invokeFunction(fn, …)` | 6, 8 | get an accessor temporarily inside a function |
| `IInstantiationService.createInstance(ctor, …args)` | 7 | create a non-singleton object and inject dependencies |
| `IInstantiationService.createChild(collection)` | 8 | spawn a child container |
| `getScopedServiceDescriptors(scope)` | 8 | get all descriptors registered at a tier |
| `Disposable` / `DisposableStore` / `IDisposable` | 4 | resource management and disposal |
| `Scope` / `LifecycleScope` | 3, 8 | lifecycle tree |
| `ScopeActivation` | 3, 5 | choose construction at scope creation or first `get()` |
| `SyncDescriptor` | (tests/low-level) | package "constructor + static parameters" into a to-be-`new`ed descriptor |

> Legacy export (not used by v2, good to know): `refineServiceDecorator` is a VS Code legacy DI utility; v2's src/test has zero references to it, everything goes through `registerScopedService`.

## Appendix B: Red lines summary

1. Don't `new` classes with `@IService` dependencies — use `@IX` injection or `accessor.get(IX)`.
2. `@IX` can only decorate constructor parameters; service parameters come after static parameters.
3. Both interface and implementation carry `_serviceBrand`.
4. Identity names are globally unique.
5. Parent-scope services don't depend on child-scope services (unresolvable at runtime too).
6. **No circular dependencies** — the container throws `CyclicDependencyError`; refactor per scenario 9 when hit; activation mode cannot bypass cycle detection.
7. `ServicesAccessor` is only valid during the `invokeFunction` invocation; don't stash it for async use.
8. Registrations live at the top of implementation files; in tests, call `_clearScopedRegistryForTests()` and re-register explicitly, don't rely on production import order.

## Appendix C: Standard steps for adding a service

1. **Contract**: write the interface (with `_serviceBrand`) + `createDecorator` identity in `src/<domain>/<domain>.ts`.
2. **Implementation**: write the class in `src/<domain>/<domain>Service.ts`, declare dependencies with `@IX`, and at the file top level `registerScopedService(scope, IX, Impl, activation, '<domain>')`; the fourth parameter is activation, the fifth is domain.
3. **Export (no barrel)**: there is no `<domain>/index.ts` barrel in the package — `src/index.ts` does `export * from '#/<domain>/<file>'` per leaf file (one line for contract and one for implementation, see the `#/app/flag/*` pattern).
4. **Registration side effect**: the top-level `registerScopedService` call in the implementation file is triggered by `import '#/<domain>/<fileService>'` in `src/index.ts` (`#/app/flag/*` has both `import` and `export *`).
5. **Tests**: in `test/<domain>/`, use `TestInstantiationService` or `createScopedTestHost`, resolve by interface.
