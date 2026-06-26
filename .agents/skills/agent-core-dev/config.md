# Topic — Config

How the `config` domain works and how a domain owns its configuration section. Covers the section-registry model, the Core vs Session split, the TOML on-disk format, and the recipe for adding or migrating a config section.

The `config` domain is a thin registry + loader: it does **not** know the shape of any individual section. Each domain owns the schema (and, where needed, the TOML transform) for the config it consumes, registers the section into `IConfigRegistry`, and reads it through `IConfigService`. There is no whole-config object passed around.

## Layout

- `src/config/config.ts` — `IConfigRegistry` / `IConfigService` / `ISessionConfigService` tokens, `ConfigSection`, event types.
- `src/config/configService.ts` — `ConfigRegistry` + `ConfigService` impl; self-registers at Core scope.
- `src/config/sessionConfigService.ts` — `SessionConfigService` impl; self-registers at Session scope.
- `src/config/toml.ts` — snake_case ↔ camelCase read/write transforms (`transformTomlData`, `applySectionToToml`) and per-section transform helpers.
- `src/config/env-model.ts` — `KIMI_MODEL_*` env overlay (`applyEnvModelOverlay`) and write-path strip (`stripEnvForDomain`).
- `src/config/schema.ts` — **legacy** monolithic `KimiConfigSchema` + section schemas that have not been migrated to an owner yet (see "Ownership map"). Shrinks as sections move out.
- `src/config/thinking.ts` — `resolveThinkingEffort` / `resolveThinkingLevel` helpers (own a local `ThinkingConfigDefaults` structural type; do not import `profile`).
- `src/config/configPure.ts` — `isPlainObject`, `deepMerge`, `omitUndefined`, `describeUnknownError`.

A domain that owns a section keeps the schema in its own `configSection.ts` (e.g. `src/flag/flag.ts` for `experimental`, `src/profile/configSection.ts` for `thinking`, `src/loop/configSection.ts` for `loopControl`).

## Core vs Session

- `IConfigRegistry` / `IConfigService` — **Core** scope, process-global. One registry of sections; one loader reading `~/.kimi-code/config.toml` (path from `IEnvironmentService.configPath`).
- `ISessionConfigService` — **Session** scope. The active session's runtime overrides (`modelAlias` / `thinkingLevel` / `systemPrompt` / `provider`), seeded from the global `session` section and persisted through `ISessionMetaStore`.

Most consumers inject `IConfigService` (global config). Inject `ISessionConfigService` only for the per-session runtime overrides.

## The section-registry model

A config section is identified by a camelCase domain key (`'providers'`, `'thinking'`, `'loopControl'`). Each section has:

- `schema?: ConfigSchema<T>` — zod schema used to validate the value (absent ⇒ passthrough).
- `defaultValue?: T` — filled when the file has no value for the domain.
- `merge?: ConfigMerge<T>` — how `set(domain, patch)` combines base + patch (default `deepMerge`).

Ownership rules:

- **One owner per section.** `registerSection` throws if a domain is registered twice.
- **The domain that consumes a config owns its schema.** This is what keeps `config` (L2) from importing higher domains: `config/schema.ts` must not import `externalHooks` / `permissionRules` / etc. If a schema needs a domain's types, the schema lives in that domain.
- **Demand-driven.** Do not register sections for config that no domain reads yet; dead schema stays in `config/schema.ts` until a consumer appears.

## Add a config section (recipe)

1. Define the schema in the owning domain, e.g. `src/<domain>/configSection.ts`:
   ```ts
   export const MY_SECTION = 'mySection';
   export const MySectionSchema = z.object({ /* ... */ });
   export type MySection = z.infer<typeof MySectionSchema>;
   ```
2. In the domain's service constructor, inject `IConfigRegistry` and register:
   ```ts
   constructor(@IConfigRegistry registry: IConfigRegistry) {
     registry.registerSection(MY_SECTION, MySectionSchema, { defaultValue: {} });
   }
   ```
   Pick a service whose scope matches when the config is first needed. Registering from an Agent-scope service is fine — see "Late registration".
3. Read it anywhere via `IConfigService`:
   ```ts
   constructor(@IConfigService private readonly config: IConfigService) {}
   // ...
   const value = this.config.get<MySection>(MY_SECTION);
   ```
4. React to edits by subscribing `IConfigService.onDidChange` and filtering on `e.domain === MY_SECTION` (see `FlagService`).
5. Write it only through `IConfigService.set(domain, patch)` (merge) or `.replace(domain, value)` (wholesale). Never write `config.toml` directly.

## Reads vs writes

Data flow is one-way by default — reading config never touches the file:

```text
config.toml  ──load──▶  IConfigService.effective  ──get──▶  services read
   ▲                                                          │
   └────────  IConfigService.set/replace  ◀────  only on explicit writes
```

- **Read path** (startup, every service): `config.toml` is loaded into `IConfigService` once; services read via `get()`. This path **never writes the file**.
- **Write path** (rare): `config.toml` is rewritten only when something explicitly calls `IConfigService.set/replace`. The only production writers today are provider CRUD (`ProviderService.set/delete`, e.g. provisioning a provider after OAuth login).

**Runtime service state is not config.** Mutating a service at runtime does **not** rewrite `config.toml`:

- `ProfileService.configure(...)` / `update(...)` / `setModel(...)` / `setThinking(...)` only change **in-memory** fields and append to the session **wireRecord** (for replay). They never call `IConfigService.set`.
- Switching model or thinking level mid-session is session runtime state, not a config edit — the user's `config.toml` is left untouched.

So `configure(...)` never overwrites the local file. Treat `config.toml` as the user's static config; runtime overrides live in memory and the session record.

## Late registration

`ConfigService` loads in its constructor (first `get(IConfigService)`). Domain services that register sections may be constructed later (especially Agent-scope services). To keep validation and defaults correct:

- `IConfigRegistry` emits `onDidRegisterSection` whenever a section is registered.
- `ConfigService` subscribes and, on registration, re-validates the already-loaded raw value for that domain, applies the default if the raw value is absent, re-runs the env overlay, and fires `onDidChange` if the effective value changed.
- Before a section is registered, `get(domain)` returns the raw (transformed, unvalidated) value; consumers that need validated values should read after the owning service is constructed, or react to `onDidChange`.

This means registration order is never a correctness concern — you do not need an eager bootstrap.

## TOML on-disk format

`config.toml` stores keys in **snake_case**; in-memory values are **camelCase**. `ConfigService` converts both ways:

- **Read**: `transformTomlData(fileData)` converts top-level keys to camelCase and applies per-section normalization (provider `oauth`/`env`/`customHeaders`, permission `deny/allow/ask` → `rules`, `loop_control.max_steps_per_run` → `maxStepsPerTurn`, services entry-name conversion, `experimental` keys preserved verbatim). Unknown top-level scalars pass through; unknown objects get a plain key conversion.
- **Write**: `applySectionToToml(rawSnake, domain, value)` converts one domain back to snake_case into a raw clone of the file, preserving unknown top-level keys and unknown sub-fields (lossless round-trip).

`ConfigService` keeps three views:

- `rawSnake` — snake_case clone of the file; the write base, never carries the env overlay.
- `raw` — camelCase, env-free; the read/set/replace base.
- `effective` — validated `raw` plus the env overlay; what `get()` returns.

### `KIMI_MODEL_*` env overlay

When `KIMI_MODEL_NAME` is set, `applyEnvModelOverlay` injects a reserved provider (`__kimi_env__`) and model alias (`__kimi_env_model__`) into `effective`, points `defaultModel` at the alias, and merges `KIMI_MODEL_THINKING_*` / `KIMI_MODEL_DEFAULT_THINKING`. The overlay is applied **only to `effective`**, never to `rawSnake`, so it is never persisted. `set`/`replace` additionally run `stripEnvForDomain` as a final guard so a caller that read `effective` (with the overlay) cannot write the reserved entries or the shell API key back to disk.

## Migrate a section out of `config/schema.ts` (recipe)

`config/schema.ts` still holds a monolithic `KimiConfigSchema` and several section schemas that predate the registry. To move a section to its owner:

1. Move the schema (and its `*PatchSchema`, if any) to the owner's `configSection.ts`.
2. Remove the field from `KimiConfigSchema` and `KimiConfigPatchSchema`.
3. Update every consumer to import the schema/type from the owner, and to read via `IConfigService` instead of the `KimiConfig` options.
4. If removing the field breaks a layer rule, the schema belongs to a different domain — re-check the ownership map; do **not** add a `config > higher-domain` import.
5. Run `lint:domain`, `typecheck`, and `test`.

## Ownership map (current)

| Section | Owner | Layer | Status |
|---|---|---|---|
| `providers` | `provider` | L2 | migrated (`IProviderService` CRUD) |
| `experimental` | `flag` | L3 | migrated |
| `thinking` | `profile` | L4 | migrated |
| `loopControl` | `loop` | L4 | migrated (read by `loop` + `profile`) |
| `McpServerConfig` (type) | `mcp` | L5 | migrated (type only; not a registered section) |
| `session` | `config` | L2 | in config |
| `models` / `defaultModel` / `defaultProvider` | `kosong` | L1 | pending (Phase 4) |
| `hooks` | `externalHooks` | L4 | pending (dead in v2) |
| `permission` | `permissionRules` | L3 | pending (dead in v2) |
| `background` | `background` | L5 | pending (dead in v2) |
| `services` / scalar defaults / `raw` | `config` | L2 | in config (dead or meta) |

`config/schema.ts` must not import from any of these owner domains; that is the whole reason the schemas live with their owners.

## Layering & scope

- `config` is **L2**. Domains that own sections import `config` (for `IConfigRegistry` / `IConfigService`) and must be at L2 or higher; lower layers need an entry in `ALLOWED_EXCEPTIONS` (e.g. `kosong>config`).
- Cross-domain type sharing for a config type may need an exception too (e.g. `plugin>mcp` for `McpServerConfig`). Prefer importing the type from the owning domain over re-declaring it.
- `IConfigRegistry` / `IConfigService` are **Core**; `ISessionConfigService` is **Session**. Agent / Turn scope services may inject Core services via ancestor lookup.
- `config` never imports a higher domain. If `config/schema.ts` needs a type from another domain, that schema belongs to that domain — move it.

## Red lines (this topic)

- One owner per section; `registerSection` throws on duplicate domains.
- `config` (L2) never imports a higher domain — keep section schemas in the owning domain.
- Do not pass a whole `KimiConfig` via options; read the section through `IConfigService`.
- `config.toml` is snake_case on disk, camelCase in memory — never write camelCase keys to disk, and never write to `config.toml` except through `IConfigService.set/replace`.
- Reading config / calling `configure(...)` / switching model at runtime must not rewrite `config.toml`; runtime state lives in memory and the session wireRecord, not the file.
- Never persist the `KIMI_MODEL_*` env overlay (`__kimi_env__` / `__kimi_env_model__` / shell API key); the overlay lives only in `effective`.
- Registering from an Agent-scope service is fine — the late-registration mechanism keeps validation correct; do not add an eager bootstrap.
