# Kimi Code `/plugins` v1 — Design

Status: draft for implementation
Date: 2026-05-25
Prior research: `reports/plugins-implementation-plan.html`

## Goal

Ship `/plugins` so a user can install a local-path plugin and have its skills
work in new sessions, with Superpowers as the day-one verification target.
"Works" means more than "skills appear in the list": after install, a fresh
session must respect Superpowers' `using-superpowers` flow (model brainstorms
instead of jumping to code).

## Scope

### In scope (v1)

- Local-path install only (`/plugins install <abs-path>`).
- Two manifest files supported: `.kimi-plugin/plugin.json` (Kimi native) and
  `.codex-plugin/plugin.json` (compatibility fallback, strict subset).
- Skill injection from enabled plugins into new sessions.
- Narrow bootstrap mechanism: a plugin declares one skill to inject as a
  `<system-reminder>` on session start, dedup via the existing `injection/`
  framework.
- `/plugins` TUI command: `list | install | info | enable | disable | remove | reload`.
- Diagnostics surfaced through `/plugins info`.

### Out of scope (later)

- Remote install (git / zip / npm / marketplace).
- Claude `commands` / `agents` / `outputStyles` / `userConfig` ingestion.
- OpenCode / Kilo runtime hooks (`tool.execute.before`, `permission.ask`,
  `chat.messages.transform`, etc.).
- kimi-cli stdin/stdout tool adapter.
- Project- or session-level plugin scoping (global only in v1).
- Hot reload into already-running sessions.

### Non-goals (will not be added later either)

- Executing third-party JavaScript shipped inside a plugin. Plugins contribute
  data (manifest + skill markdown), never executable code.

## §1 — Manifest

### Lookup

A directory is a plugin candidate when it contains one of:

```
<plugin_root>/.kimi-plugin/plugin.json   # Kimi native, authoritative
<plugin_root>/.codex-plugin/plugin.json  # compatibility fallback
```

Resolution rule:

1. If `.kimi-plugin/plugin.json` **exists**, it is authoritative. Parse it.
   If parsing fails the plugin is in `error` state and `.codex-plugin/` is
   **not** consulted — silent fallback would make the native manifest
   undebuggable.
2. Otherwise, if `.codex-plugin/plugin.json` exists, parse it.
3. Otherwise, the directory is not a plugin.

When `.kimi-plugin/` wins and `.codex-plugin/` is also present, `/plugins info`
shows a `shadowed:` line so the user knows.

### Schema (both files)

```jsonc
{
  "name": "superpowers",            // required, /^[a-z0-9][a-z0-9_-]{0,63}$/
  "version": "5.1.0",               // optional
  "description": "...",             // optional
  "author": { "name": "...", "email": "..." },  // optional
  "homepage": "...",                // optional
  "license": "MIT",                 // optional

  "skills": "./skills/",            // optional; string or string[]
                                    // relative path(s), must start with "./"

  "bootstrap": {                    // optional, Kimi-only field
    "skill": "using-superpowers"    // name of a skill in this plugin
  }
}
```

`bootstrap` is the only Kimi-only field in v1. `.codex-plugin/plugin.json`
written by a Codex plugin won't have it; that's fine — it's optional. The
field is reserved here so we don't have to redesign the manifest later.

### Field handling table

When parsing `.codex-plugin/plugin.json`, the Codex schema has fields Kimi
doesn't natively define. Each is sorted into one of four buckets:

| Bucket | Fields | Behavior |
|---|---|---|
| **Used as data** | `name`, `version`, `description`, `author`, `homepage`, `license`, `skills` | Drive the plugin record. |
| **Used for display only** | `interface.displayName`, `interface.shortDescription`, `interface.longDescription`, `interface.developerName`, `interface.capabilities`, `interface.websiteURL`, `interface.defaultPrompt` | Shown in `/plugins` list and `/plugins info`. Reading metadata is not "executing" the plugin. |
| **Recognized but not executed** | `hooks`, `mcpServers`, `apps` | `/plugins info` explicitly lists these as "present, not executed by Kimi". Not silently dropped — the user needs to know Kimi sees the field but ignores its behavior. |
| **Structurally not applicable** | `interface.brandColor`, `interface.composerIcon`, `interface.logo`, `interface.screenshots`, `interface.privacyPolicyURL`, `interface.termsOfServiceURL`, `keywords` | Parsed onto the in-memory record (for future use) but not surfaced in the TUI v1. No diagnostic. |

### Path safety

Every relative path field (`skills`, future `bootstrap.path`-style fields):

- Must start with `./`. Bare `skills/` or `../foo` fails.
- After resolution against `plugin_root`, the absolute path must remain inside
  `plugin_root`. Symlinks are resolved before the containment check.
- A path that fails containment produces an `error` diagnostic and the plugin
  loses that capability but otherwise loads.

These rules are taken from Codex's `resolve_manifest_path`
(`codex-rs/utils/plugins/src/plugin_namespace.rs`). Re-stated here so behavior
is explicit, not "see Codex source".

### Diagnostics

```ts
type PluginDiagnostic = {
  severity: 'error' | 'warn' | 'info';
  code: string;        // dotted, machine-stable
  message: string;     // human, may include the offending value
};
```

Codes used in v1:

- `manifest.missing` (error) — neither manifest file exists at install time.
- `manifest.invalid_json` (error) — parse failed.
- `manifest.missing_name` (error) — `name` field absent or empty.
- `manifest.invalid_name` (error) — fails the name regex.
- `manifest.skills.path_required_dot_slash` (error)
- `manifest.skills.path_escape` (error) — resolves outside `plugin_root`.
- `manifest.skills.not_a_directory` (warn) — path resolves but isn't a dir; plugin loads without skills.
- `manifest.bootstrap.skill_not_found` (warn) — `bootstrap.skill` doesn't match any skill in the plugin; bootstrap is skipped, rest of plugin loads.
- `manifest.unknown_field.<name>` (info) — for each entry in the "recognized but not executed" bucket that is actually present.

All diagnostics are returned with `/plugins info <id>`.

## §2 — Plugin manager

### Module layout

```
packages/agent-core/src/plugin/
  index.ts          # public exports
  types.ts          # PluginRecord, PluginManifest, PluginDiagnostic, PluginSummary
  manifest.ts       # parseManifest(root): { record, diagnostics }
  store.ts          # readInstalled() / writeInstalled() against installed.json
  manager.ts        # PluginManager class
  superpowers.ts    # Superpowers compatibility shim (see §3)
  __tests__/        # parser, store, manager, end-to-end fixture tests
```

Tests live next to the module per AGENTS.md ("do not add too many new test
files; prefer adding to the existing test file"). Fixtures use minimal trees
(one `.codex-plugin/plugin.json` + two `SKILL.md` files), not full Superpowers
copies.

### `installed.json`

Path: `path.join(resolveKimiHome(homeDir), 'plugins', 'installed.json')` —
i.e. `~/.kimi-code/plugins/installed.json` by default, overridden by
`KIMI_CODE_HOME` env var.

Format:

```jsonc
{
  "version": 1,
  "plugins": [
    {
      "id": "superpowers",
      "root": "/Users/moonshot/code/superpowers",
      "source": "local-path",
      "enabled": true,
      "installedAt": "2026-05-25T09:00:00Z"
    }
  ]
}
```

Atomic write: write to `installed.json.tmp` and rename. Read is best-effort —
missing file is treated as empty. Corrupt file fails loudly (we don't want to
overwrite damaged state with an empty list).

### `PluginManager` API (internal to core)

```ts
class PluginManager {
  constructor(opts: { kimiHomeDir: string; log: Logger });

  // Called once at core startup. Reads installed.json + parses all manifests.
  load(): Promise<void>;

  // Mutators — all async because they write installed.json.
  install(root: string): Promise<PluginRecord>;   // adds to installed.json, parses manifest
  setEnabled(id: string, enabled: boolean): Promise<void>;
  remove(id: string): Promise<void>;              // removes from installed.json; never deletes <root>
  reload(): Promise<ReloadSummary>;               // re-reads installed.json + every manifest

  // Synchronous reads — operate on the in-memory snapshot.
  list(): readonly PluginRecord[];
  get(id: string): PluginRecord | undefined;

  // Called by session creation in core-impl.ts.
  enabledSkillDirs(): readonly string[];
  enabledBootstraps(): readonly EnabledBootstrap[];
}

interface ReloadSummary {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly errors: ReadonlyArray<{ id: string; message: string }>;
}

interface EnabledBootstrap {
  readonly pluginId: string;
  readonly skillName: string;       // name as declared in manifest
}
```

`PluginManager` is constructed once by the core RPC layer and owned alongside
the existing per-session resources. It is per-host, not per-session — the
state lives in `installed.json` and is shared across all sessions on the
machine.

### Session wiring (skills)

Modify `packages/agent-core/src/rpc/core-impl.ts:549` —
`resolveSessionSkillConfig`:

```ts
private resolveSessionSkillConfig(config: KimiConfig): SessionSkillConfig {
  const explicitDirs = this.skillDirs.length > 0 ? this.skillDirs : undefined;
  return {
    userHomeDir: this.userHomeDir,
    explicitDirs,
    extraDirs: [
      ...(config.extraSkillDirs ?? []),
      ...this.plugins.enabledSkillDirs(),
    ],
    mergeAllAvailableSkills: config.mergeAllAvailableSkills,
  };
}
```

Downstream (`scanner.ts:resolveSkillRoots` → `discoverSkills` →
`SkillRegistry`) is unchanged. Plugin skills land with `source: 'extra'`,
which the registry already groups under "Extra" in its skill listing.

### Reload semantics

`PluginManager.reload()`:

- Re-reads `installed.json` from disk (handles external edits, e.g. user hand-edited).
- Re-parses every plugin's manifest (handles in-place edits to a referenced source dir).
- Updates the in-memory snapshot.
- **Does not affect already-running sessions.** Sessions take a snapshot of
  enabled skill dirs / bootstraps at startup; reload changes what the *next*
  new session sees. The status line after `/plugins reload` reminds the user:
  *"Reload applies to new sessions — run `/new` to pick up changes."*

This matches existing behavior for `extraSkillDirs` config changes and MCP
server changes.

## §3 — Bootstrap injection

### Why this exists

Superpowers' contract with a "supported harness" is that a clean session
automatically loads `using-superpowers` content as a system reminder so the
model brainstorms instead of jumping to code. Without this, "Superpowers
works" is false advertising. Bootstrap is the narrowest mechanism that
satisfies that contract.

### Mechanism

A plugin declares:

```jsonc
{
  "bootstrap": { "skill": "<skill-name-in-this-plugin>" }
}
```

At session creation, `PluginManager.enabledBootstraps()` returns the list. A
new `PluginsBootstrapInjector` (under
`packages/agent-core/src/agent/injection/`) handles delivery:

- Modeled on `plan-mode.ts`. Extends the abstract `Injector` from
  `injector.ts`. `injectionVariant = 'plugins_bootstrap'`.
- On first invocation in a session, resolves each declared skill by name
  through the agent's `SkillRegistry`, takes the skill `content` (already
  stripped of YAML frontmatter by `parseSkillFromFile`), and emits one
  `<system-reminder>` per plugin via `agent.context.appendSystemReminder()`:
  ```
  <plugin_bootstrap plugin="superpowers" skill="using-superpowers">
  {skill content}
  </plugin_bootstrap>
  ```
- Sets internal `injectedAt` once. Never re-injects in the same session.
- A bootstrap whose skill name doesn't resolve in the registry produces a
  `manifest.bootstrap.skill_not_found` diagnostic; injection for that plugin
  is skipped, other plugins' bootstraps still run.

### Why `<system-reminder>`, not user message

`appendSystemReminder` is the existing injection channel used by plan-mode.
The model treats `<system-reminder>` as platform-level instructions, which
matches what Superpowers' OpenCode adapter does (it injects via
`chat.messages.transform` into a system-channel block). Putting bootstrap
into the user message would conflate user intent with platform instruction,
mishandle compaction, and surprise anyone reading the transcript.

### Compact / fork / resume

- **Compact**: the system reminder is part of the agent context which compaction
  preserves. No re-injection.
- **Fork**: forked session starts with parent's context including the reminder. No re-injection.
- **Resume**: the `injectedAt` state is in-memory and reset on resume; the
  reminder lives in the persisted message history, so the model still sees
  it. The injector's `getInjection()` checks for an existing reminder of the
  same variant before emitting — same dedupe pattern plan-mode already uses.

### Superpowers compatibility shim

Upstream Superpowers does not yet ship `.kimi-plugin/plugin.json` or a
`bootstrap` field in its `.codex-plugin/`. To make Superpowers work on day
one, `plugin/superpowers.ts` exposes:

```ts
// Hard-coded knowledge of known plugins that predate Kimi's manifest fields.
// Each entry MUST be removable once the upstream plugin ships a Kimi-aware
// manifest. This file is intentionally a registry of named exceptions, not a
// pattern-matching system.
export function applyCompatShims(record: PluginRecord): PluginRecord {
  if (record.manifest.name === 'superpowers' && record.manifest.bootstrap === undefined) {
    // Superpowers >= 5.x ships `skills/using-superpowers/SKILL.md`.
    return withSyntheticBootstrap(record, 'using-superpowers');
  }
  return record;
}
```

Called inside `parseManifest` after the raw parse succeeds. The shim is
visible in `/plugins info` as a `compat.bootstrap.synthesized` info-level
diagnostic so users understand why the bootstrap fires without a manifest
field.

Follow-up (not in v1): open a PR against
`obra/superpowers` adding the `bootstrap` field. Once merged, the shim can
be deleted.

## §4 — RPC + TUI

### Core RPC additions (`packages/agent-core/src/rpc/core-api.ts`)

Add to `CoreAPI` interface:

```ts
listPlugins:      (p: EmptyPayload) => readonly PluginSummary[];
installPlugin:    (p: InstallPluginPayload) => PluginSummary;
setPluginEnabled: (p: SetPluginEnabledPayload) => void;
removePlugin:     (p: RemovePluginPayload) => void;
reloadPlugins:    (p: EmptyPayload) => ReloadPluginsResult;
getPluginInfo:    (p: GetPluginInfoPayload) => PluginInfo;
```

These signatures follow the existing `CoreAPI` convention (see
`listMcpServers`, `reconnectMcpServer` in `core-api.ts`): the type is
sync-shaped and the RPC transport wraps the call in a `Promise` end-to-end.
The underlying `PluginManager` mutators are async — `core-impl.ts` `await`s
them and the transport propagates the result.

`PluginSummary` is the list-view shape; `PluginInfo` is the detail-view shape
(includes diagnostics + manifest path + shadowed manifest + ignored-field
buckets). Payload types live next to their siblings in `core-api.ts`.

Implementation in `core-impl.ts` mirrors how `listMcpServers` /
`reconnectMcpServer` are wired today. SDK exports from
`packages/node-sdk/src/rpc.ts` follow the same pattern.

### TUI slash command (`apps/kimi-code/src/tui/`)

In `commands/registry.ts:BUILTIN_SLASH_COMMANDS`:

```ts
{
  name: 'plugins',
  aliases: [],
  description: 'Manage plugins',
  priority: 60,
  availability: 'always',
}
```

`priority: 60` puts it in the same row as `/mcp` and `/usage`.

In `kimi-tui.ts`, dispatch mirroring the `'mcp'` case:

```ts
case 'plugins':
  void this.handlePluginsCommand(args);
  return;
```

Sub-commands parsed from `args`:

| Input | Action |
|---|---|
| `/plugins` | List panel: id, displayName (falls back to id), version, enabled badge, skill count, error/warn badge |
| `/plugins install <abs-path>` | Calls `installPlugin`; renders one-line success or error; status hint about `/new` |
| `/plugins info <id>` | Detail panel: manifest path, shadowed path, source, capabilities (from `interface`), skill list, recognized-but-not-executed fields, all diagnostics |
| `/plugins enable <id>` / `disable <id>` | Calls `setPluginEnabled`; status hint about `/new` |
| `/plugins remove <id>` | Confirm via the existing approval flow before calling `removePlugin` |
| `/plugins reload` | Calls `reloadPlugins`; shows ReloadSummary |

New file `apps/kimi-code/src/tui/components/messages/plugins-status-panel.ts`,
modeled on `mcp-status-panel.ts`. Both the list and info views reuse
`UsagePanelComponent` for rendering, same as the MCP view.

### Hot-reload behavior

Plugin state changes (`install`, `enable`, `disable`, `remove`, `reload`) do
**not** mutate the running session's skill registry. The status line after
each mutating action says:

> Run `/new` to start a fresh session with the updated plugin set.

Rationale: skill rooting happens at session construction. Rebuilding the
registry mid-session would invalidate cached skill lookups in active turns.
This matches MCP's "config change → reconnect server" model; users already
expect Kimi's runtime to be session-bounded.

## §5 — Security & error handling

- **No plugin code executes.** The plugin module must not contain `require()`,
  dynamic `import()`, `child_process`, `vm`, or `worker_threads`. Enforced
  by a unit test in `packages/agent-core/src/plugin/__tests__/` that greps
  the module's compiled output (same grep as §7).
- **Path containment.** Every relative path resolves through symlinks and
  must stay within `plugin_root`. Re-validated on each load (in case
  symlinks change).
- **Bad manifest degrades, never crashes.** Invalid JSON or schema failure
  yields a plugin in `error` state. Session creation continues; the plugin
  contributes no skills or bootstraps.
- **Future tool naming.** When plugin tools land post-v1, names use
  `plugin__<plugin>__<tool>` — same shape as the existing
  `mcp__server__tool` namespace.
- **`remove` never deletes source files.** The user installed by path; that
  directory is theirs. `remove` clears `installed.json` and nothing else.
- **`installed.json` write atomicity.** Write-to-tmp + rename. A killed
  process can leave `installed.json.tmp` behind; load discards it.

## §6 — Phasing (each chunk = one PR)

1. **`plugin/`: manifest parser + store**
   - `types.ts`, `manifest.ts`, `store.ts` + tests.
   - No session integration. Unit tests cover fixture parse, path safety,
     diagnostics enumeration, atomic write/read.

2. **`plugin/`: manager + session wiring + bootstrap (+ Superpowers shim)**
   - `manager.ts`, `superpowers.ts`, `PluginsBootstrapInjector`.
   - Wire `enabledSkillDirs()` into `resolveSessionSkillConfig`.
   - Wire `PluginsBootstrapInjector` into the agent's injector pipeline
     (same place plan-mode is registered).
   - Integration test: fixture plugin with `bootstrap.skill` → session sees
     the system reminder; verify dedup across compact/fork; verify shim
     synthesizes Superpowers bootstrap.

3. **CoreAPI + SDK RPC**
   - Add the six methods to `CoreAPI`, implement in `core-impl.ts`, export
     from `node-sdk/src/rpc.ts`.
   - RPC roundtrip test with an in-process fixture plugin.

4. **TUI `/plugins` command + status panel**
   - `commands/registry.ts` entry, `kimi-tui.ts` dispatch,
     `plugins-status-panel.ts`, info renderer.
   - Manual smoke test against `/Users/moonshot/code/superpowers`.

Each PR runs `gen-changesets` per AGENTS.md. Default bump is `minor`.

## §7 — Acceptance (verifies before declaring v1 done)

End-to-end checklist run against `/Users/moonshot/code/superpowers`:

- [ ] `/plugins install /Users/moonshot/code/superpowers` succeeds; status
      line points the user at `/new`.
- [ ] `/plugins` lists `superpowers` as enabled, version `5.1.0`, with a
      skill count > 0 and the displayName from `interface`.
- [ ] After `/new`, `listSkills()` includes Superpowers skills
      (`brainstorming`, `writing-plans`, `subagent-driven-development`, ...).
- [ ] After `/new`, the system reminder pipeline emits a
      `<plugin_bootstrap plugin="superpowers" skill="using-superpowers">`
      block exactly once.
- [ ] **Critical:** in a fresh session, prompting *"Let's make a react todo list"*
      causes the model to engage the brainstorming flow rather than writing
      code directly. If this fails, v1 is not done.
- [ ] `/plugins info superpowers` shows: manifest path, source, capabilities,
      skill list, recognized-but-not-executed fields (none for Superpowers'
      `.codex-plugin/`, but the section renders), and the
      `compat.bootstrap.synthesized` info diagnostic.
- [ ] `/plugins disable superpowers` → `/new` → skills gone, bootstrap
      reminder no longer emitted.
- [ ] `/plugins remove superpowers` → `installed.json.plugins` is empty;
      `/Users/moonshot/code/superpowers/` is untouched (verify mtime).
- [ ] Corrupting `.codex-plugin/plugin.json` (invalid JSON) and running
      `/plugins reload` puts the plugin into `error` state; new session
      startup is unaffected.
- [ ] The plugin module's no-execution unit test passes
      (`grep -rE 'require\(|child_process|vm\.|worker_threads|import\([^)]*\$' packages/agent-core/src/plugin/`
      returns no matches; the test wraps this grep).

## §8 — Open follow-ups (tracked, not in v1)

- Upstream PR to `obra/superpowers` adding a `bootstrap` field to
  `.codex-plugin/plugin.json` (or a `.kimi-plugin/plugin.json`). Removes the
  hardcoded shim in `plugin/superpowers.ts`.
- `tools` field in the manifest, reusing kimi-cli's shape or Claude's
  `commands` shape — decide when there's a concrete second plugin asking.
- `commands` field for slash commands contributed by plugins.
- Remote install (git / zip / npm). Touches supply-chain concerns: pinning,
  caching, verification, rollback. Own spec.
- Claude `commands` / `agents` ingestion. Each requires a semantic mapping
  decision; not a parser exercise.
