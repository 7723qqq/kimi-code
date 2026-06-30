/**
 * Scenario: the **config** slice — every Service that registers a config
 * section, shown against one shared, file-backed `IConfigService`.
 *
 * `config` holds no schema of its own; each domain that consumes a config owns
 * its section and registers it from its Service constructor. This example
 * resolves **every** current section owner so its `registerSection` runs, then
 * reads the single `IConfigRegistry` / `IConfigService` they all populated:
 *
 *  Core-scope owners (resolved from the production `bootstrap` Core scope):
 *   - `IModelService`          → `models`          (+ the `KIMI_MODEL_*` overlay)
 *   - `IProviderService`       → `providers`
 *   - `IFlagService`           → `experimental`
 *
 *  Agent-scope owners (constructed here against the same registry):
 *   - `IBackgroundService`     → `background`
 *   - `ICronService`           → `cron`
 *   - `IPermissionRulesService`→ `permission`
 *   - `IProfileService`        → `thinking`, `defaultThinking`
 *   - `ILoopService`           → `loopControl`
 *   - `IExternalHooksService`  → `hooks`
 *
 * The Agent owners are constructed through `createServices` with their
 * non-config collaborators stubbed, mirroring how the slice tests isolate a
 * domain (see `feature-flags.example.ts`). Only the `registerSection` call and
 * the config reads are real — which is exactly what this example is about. The
 * Core owners are *not* re-constructed: they are resolved from the real Core
 * scope, so no section is registered twice.
 *
 * Two scenarios are shown:
 *
 *  1. **register + inspect** — every owner registers its section into the one
 *     registry; `inspect` reports each section's default layer.
 *  2. **write + round-trip** — a schema-valid value for every *persistable*
 *     section is written through `IConfigService.set`; each is validated,
 *     env-stripped, and persisted, then `reload()` parses the file back so the
 *     effective value matches what was written. (`cron` is operational /
 *     env-only and is intentionally not persisted.)
 *
 * All Services come from `src/`; nothing here defines a new Service.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import type { Scope } from '#/_base/di/scope';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { BackgroundService, IBackgroundService } from '#/background';
import { bootstrap } from '#/bootstrap/bootstrap';
import { type ConfigInspectValue, IConfigRegistry, IConfigService } from '#/config/config';
import '#/config/index';
import { IContextMemory } from '#/contextMemory';
import { IContextProjector } from '#/contextProjector';
import { IContextSizeService } from '#/contextSize';
import { CronService } from '#/cron';
import { IEventSink } from '#/eventSink';
import { ExternalHooksService, IExternalHooksService } from '#/externalHooks';
import { IFlagService } from '#/flag';
import { ILLMRequester } from '#/llmRequester';
import { logSeed, resolveLoggingConfig } from '#/log/logConfig';
import { LoopService, ILoopService } from '#/loop';
import { IChatProviderFactory } from '#/chatProvider';
import { IModelService } from '#/model';
import '#/model/index';
import { IModelResolver } from '#/modelRuntime';
import { IPermissionRulesService, PermissionRulesService } from '#/permissionRules';
import { IProfileService, ProfileService } from '#/profile';
import { IPromptService } from '#/prompt';
import { IProviderService } from '#/provider';
import '#/provider/index';
import '#/flag/index';
import { IReplayBuilderService } from '#/replayBuilder';
import { ISessionContext } from '#/session-context';
import { IAtomicDocumentStore, IStorageService } from '#/storage';
import '#/storage/index';
import { ITelemetryService } from '#/telemetry';
import { IToolExecutor } from '#/toolExecutor';
import { IToolRegistry } from '#/toolRegistry';
import { ITurnService } from '#/turn';
import { IWireRecord } from '#/wireRecord';

/**
 * One schema-valid sample value per **persistable** section, written through
 * `IConfigService.set` so each owner's write path round-trips to `config.toml`.
 * `cron` is intentionally absent: it is operational / env-only (`stripCronEnv`
 * drops it), so it is never persisted to `config.toml` by design.
 */
const SECTION_VALUES: Record<string, unknown> = {
  models: {
    'kimi-k2': { provider: 'moonshot', model: 'kimi-k2-0905-preview', maxContextSize: 262_144 },
  },
  providers: {
    moonshot: { type: 'kimi', apiKey: 'YOUR_API_KEY' },
  },
  experimental: { demo_feature: true },
  background: { maxRunningTasks: 4, keepAliveOnExit: true },
  permission: {
    rules: [{ decision: 'allow', scope: 'user', pattern: 'bash(git status)' }],
  },
  thinking: { mode: 'auto', effort: 'medium' },
  defaultThinking: true,
  loopControl: { maxStepsPerTurn: 50, maxRetriesPerStep: 3 },
  hooks: [{ event: 'PreToolUse', matcher: 'bash', command: 'echo demo' }],
};

/** Domains every current section owner registers, in registration order. */
const EXPECTED_SECTIONS = [
  'models',
  'providers',
  'experimental',
  'background',
  'cron',
  'permission',
  'thinking',
  'defaultThinking',
  'loopControl',
  'hooks',
] as const;

/** `HookSlot` stub — owners only `.register()` hooks during construction. */
function hookSlot() {
  return {
    register: () => toDisposable(() => {}),
    delete: () => true,
    run: async () => {},
  };
}

describe('config slice (every section owner against one shared registry)', () => {
  let homeDir: string;
  let core: Scope;
  let configPath: string;
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    const resolved = process.env['KIMI_CODE_HOME'];
    if (resolved === undefined) {
      throw new Error('KIMI_CODE_HOME is not set; globalSetup should have initialized it');
    }
    homeDir = resolved;
    mkdirSync(homeDir, { recursive: true });
    configPath = join(homeDir, 'config.toml');

    // Real, file-backed config. Constructing the Core scope eager-loads
    // `IModelService`, which registers the `models` section + overlay.
    core = bootstrap({ homeDir }, logSeed(resolveLoggingConfig({ homeDir, env: process.env }))).core;

    const registry = core.accessor.get(IConfigRegistry);
    const config = core.accessor.get(IConfigService);

    // Construct the Agent-scope owners against the SAME registry/service. Their
    // non-config collaborators are stubbed: this example isolates the config
    // slice, it does not run the owners. Real owner constructors are used so the
    // real `registerSection` calls execute.
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IConfigRegistry, registry);
        reg.defineInstance(IConfigService, config);

        // Collaborators touched during owner construction, with real shape.
        reg.definePartialInstance(IWireRecord, {
          register: () => toDisposable(() => {}),
          append: () => {},
          hooks: { onRestoredRecord: hookSlot(), onResumeEnded: hookSlot() },
        });
        reg.definePartialInstance(IContextMemory, { hooks: { onSpliced: hookSlot() } });
        reg.definePartialInstance(IToolExecutor, {
          // `OrderedHookSlot` is a class with private members, so the stub is
          // shaped as a `HookSlot` and cast to the declared slot type.
          hooks: {
            onWillExecuteTool: hookSlot(),
            onDidExecuteTool: hookSlot(),
          } as unknown as IToolExecutor['hooks'],
        });
        reg.definePartialInstance(IModelResolver, { defaultModel: 'mock-model' });
        reg.definePartialInstance(ISessionContext, {
          metaScope: 'sessions/demo/demo/session-meta',
          sessionDir: homeDir,
        });
        reg.definePartialInstance(ITurnService, { getActiveTurn: () => undefined });

        // Collaborators declared but not touched during construction — empty
        // stubs keep the container strict-clean (no "unknown service" warnings).
        reg.definePartialInstance(IEventSink, {});
        reg.definePartialInstance(ITelemetryService, { track: () => {} });
        reg.definePartialInstance(IPromptService, {});
        reg.definePartialInstance(IAtomicDocumentStore, {});
        reg.definePartialInstance(IStorageService, {});
        reg.definePartialInstance(IToolRegistry, {});
        reg.definePartialInstance(IReplayBuilderService, {});
        reg.definePartialInstance(IChatProviderFactory, {});
        reg.definePartialInstance(IContextProjector, {});
        reg.definePartialInstance(IContextSizeService, {});
        reg.definePartialInstance(ILLMRequester, {});

        // Real Agent-scope section owners. `ICronService` is constructed via
        // `createInstance` below (not here) so we can pass `{ isSubagent: true }`
        // and keep its runtime scheduler/tool registration from starting.
        reg.define(IExternalHooksService, ExternalHooksService);
        reg.define(IPermissionRulesService, PermissionRulesService);
        reg.define(IProfileService, ProfileService);
        reg.define(IBackgroundService, BackgroundService);
        reg.define(ILoopService, LoopService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
    core.dispose();
  });

  test('every section owner registers its section into the shared registry', async () => {
    const registry = core.accessor.get(IConfigRegistry);
    const config = core.accessor.get(IConfigService);
    await config.ready;

    // Resolve the Core owners and touch each one: delayed Core services return
    // a lazy proxy, so reading a method forces construction (and thus the
    // `registerSection` call). `IModelService` is eager but still needs a `get`.
    core.accessor.get(IModelService).list();
    core.accessor.get(IProviderService).list();
    core.accessor.get(IFlagService).snapshot();

    // Construct the Agent owners — each registers its section(s).
    ix.get(IBackgroundService);
    ix.get(IPermissionRulesService);
    ix.get(IProfileService);
    ix.get(IExternalHooksService);
    ix.get(ILoopService);
    // `isSubagent: true` keeps the cron scheduler/tool registration from
    // starting — only the `cron` config-section registration is relevant here.
    ix.createInstance(CronService, { isSubagent: true });

    const registered = registry
      .listSections()
      .map((s) => s.domain)
      .toSorted();
    console.log('registered sections:', registered);

    expect(registered).toEqual([...EXPECTED_SECTIONS].toSorted());

    console.log('\ninspect (default layer) per section:');
    for (const domain of EXPECTED_SECTIONS) {
      const view = config.inspect(domain);
      console.log(`   ${domain}:`, summarizeInspect(view));
    }
  });

  test('writes every persistable section through config and round-trips the file', async () => {
    const config = core.accessor.get(IConfigService);
    await config.ready;

    // Resolve every owner so its section is registered before writing.
    core.accessor.get(IModelService).list();
    core.accessor.get(IProviderService).list();
    core.accessor.get(IFlagService).snapshot();
    ix.get(IBackgroundService);
    ix.get(IPermissionRulesService);
    ix.get(IProfileService);
    ix.get(IExternalHooksService);
    ix.get(ILoopService);
    ix.createInstance(CronService, { isSubagent: true });

    // Write each persistable section through IConfigService — every owner's
    // value is validated, env-stripped, and persisted to config.toml.
    let changes = 0;
    const sub = config.onDidChange(() => changes++);
    for (const [domain, value] of Object.entries(SECTION_VALUES)) {
      await config.set(domain, value);
    }
    sub.dispose();

    const onDisk = readFileSync(configPath, 'utf8').trim();
    console.log('config.toml after writing every section:');
    for (const line of onDisk.split('\n')) {
      console.log('   ', line);
    }
    console.log(
      `\n${Object.keys(SECTION_VALUES).length} sections written; onDidChange fired ${changes} times.`,
    );
    console.log('(cron is operational/env-only and intentionally not persisted.)');

    // Round-trip: reload the file and confirm each section parses back to the
    // value just written (read path: snake_case file → fromToml → effective).
    await config.reload();
    console.log('\ninspect after reload (round-trip) per section:');
    for (const domain of Object.keys(SECTION_VALUES)) {
      console.log(`   ${domain}:`, config.inspect(domain).value);
    }
  });
});

function summarizeInspect(inspect: ConfigInspectValue<unknown>): Record<string, unknown> {
  return {
    hasDefaultValue: inspect.defaultValue !== undefined,
    hasUserValue: inspect.userValue !== undefined,
    hasMemoryValue: inspect.memoryValue !== undefined,
    keys: inspect.value !== null && typeof inspect.value === 'object' ? Object.keys(inspect.value) : [],
  };
}
