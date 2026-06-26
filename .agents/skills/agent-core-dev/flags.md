# Topic — Flags

Experimental feature-flag gating for agent-core-v2 — a Core-scope `IFlagService` resolver plus an exported `FlagRegistry` catalog, backed by the `[experimental]` config section.

Gate not-yet-public features behind `IFlagService.enabled(id)`, per the repository hard rule that unreleased behavior must be flag-gated. v1 was a process-global `FlagResolver` singleton; v2 is a scoped DI service with no implicit global state.

## Layout

- `src/flag/registry.ts` — `FLAG_DEFINITIONS`, `FlagId`, `FlagDefinition`, `FlagRegistry` (catalog), `ExperimentalConfigSchema` / `ExperimentalConfig` (zod).
- `src/flag/flag.ts` — `IFlagService` token + resolver types (`ExperimentalFlagMap`, `ExperimentalFlagConfig`, `ExperimentalFlagSource`, `ExperimentalFeatureState`).
- `src/flag/flagService.ts` — `FlagService` impl + `MASTER_ENV` (`KIMI_CODE_EXPERIMENTAL_FLAG`) + `EXPERIMENTAL_SECTION` (`experimental`); self-registers at Core scope.
- `src/flag/index.ts` — barrel; re-exported by `src/index.ts` at the L3 block.

## Public surface

- `IFlagService` (DI token, Core scope): `enabled(id)`, `explain(id)`, `snapshot()`, `enabledIds()`, `explainAll()`, `setConfigOverrides(overrides)`, `registry`.
- `FlagRegistry`: `get(id)`, `list()`, `definitions` — read-only catalog for hosts/UI to enumerate flags without resolving them.
- `FlagService`: exported for tests and hosts that construct it directly.

## Resolution precedence

Highest wins; env is read live on every call (nothing cached):

1. L1 master env `KIMI_CODE_EXPERIMENTAL_FLAG` truthy → every flag on.
2. L2 per-feature `def.env` (e.g. `KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION`) → forces on/off.
3. L3 `[experimental]` config section per-flag override.
4. L4 registry `default`.

`explain(id)` returns the winning `source` (`master-env` | `env` | `config` | `default`) plus the effective `configValue`.

## Config integration

- `FlagService` registers the `[experimental]` section into `IConfigRegistry` at construction (`registerSection('experimental', ExperimentalConfigSchema)`) and reads overrides from `IConfigService`.
- It subscribes `IConfigService.onDidChange` and refreshes overrides whenever the `experimental` domain changes, so config edits apply live.
- `IConfigRegistry.registerSection` throws if a domain is registered twice — `experimental` is owned exclusively by `FlagService`.
- `setConfigOverrides(overrides)` is an imperative escape hatch for tests and hosts without an `IConfigService`; hosts on `IConfigService` should set the `[experimental]` section instead.

Config shape:

```toml
[experimental]
micro_compaction = false
```

Keys are intentionally loose (`z.record(z.string(), z.boolean())`), so obsolete flags stay inert config.

## Add a flag

Append to `FLAG_DEFINITIONS` in `src/flag/registry.ts`:

```ts
{ id: 'my_feature', title: 'My feature', description: '...', env: 'KIMI_CODE_EXPERIMENTAL_MY_FEATURE', default: false, surface: 'both' }
```

- Keep the `as const satisfies` — it derives the `FlagId` union that gives `enabled()` autocomplete and typo-checking.
- `env` must start with `KIMI_CODE_EXPERIMENTAL_`, be unique, and not equal `KIMI_CODE_EXPERIMENTAL_FLAG`.
- `id` must not be `flag`.
- `surface`: `core` | `tui` | `both` (documentation/grouping only; not used in resolution).

## Consume a flag

Inject `IFlagService` and gate on it. It is resolvable from any scope (Core ancestor):

```ts
constructor(@IFlagService private readonly flags: IFlagService) {}
// ...
if (!this.flags.enabled('micro_compaction')) return;
```

## Layering & scope

- Domain `flag` is registered at **L3**. It imports only `config` (L2) downward.
- It cannot live in `_base` (L0): registering/reading the config section requires importing `config`, and L0 must not import L2.
- Scope: `Core` (`registerScopedService(LifecycleScope.Core, IFlagService, FlagService, Delayed, 'flag')`). Env + config are process-global inputs, so there is no per-session/agent state.
- Tests construct `FlagService` directly with a real `ConfigRegistry`/`ConfigService` and an injected env map.

## Red lines (this topic)

- Gate unreleased behavior behind a `FLAG_DEFINITIONS` flag; no ad-hoc env toggles.
- `env` must start with `KIMI_CODE_EXPERIMENTAL_`, be unique, and not equal `KIMI_CODE_EXPERIMENTAL_FLAG`; `id` must not be `flag`.
- Keep the `as const satisfies` on `FLAG_DEFINITIONS` so `FlagId` stays derived.
- `flag` lives at L3 and `Core` scope — never in `_base`, never per-session.
