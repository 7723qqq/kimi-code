/**
 * Scenario: the **config** slice — every Service that registers a config
 * section, shown against one shared, file-backed `IConfigService`.
 *
 * `config` holds no schema of its own; each domain that consumes a config owns
 * its section and registers it from its Service constructor. This example
 * resolves **every** current section owner so its `registerSection` runs, then
 * reads the single `IConfigRegistry` / `IConfigService` they all populated:
 *
 *  App-scope owners:
 *   - `IModelService`          → `models`          (+ the `KIMI_MODEL_*` overlay)
 *   - `IProviderService`       → `providers`
 *   - `IFlagService`           → `experimental`
 *
 *  Agent-scope owners:
 *   - `IAgentBackgroundService`     → `background`
 *   - `IAgentCronService`           → `cron`
 *   - `IAgentPermissionRulesService`→ `permission`
 *   - `IAgentProfileService`        → `thinking`, `defaultThinking`
 *   - `IAgentLoopService`           → `loopControl`
 *   - `IAgentExternalHooksService`  → `hooks`
 *
 * Wiring: the real composition root (`_harness`) provides every collaborator,
 * so each owner is resolved for real — no hand-rolled stub list. The only
 * override is `IAgentCronService`, seeded with `{ isSubagent: true }` so its
 * runtime scheduler does not start (only its `cron` section registration is
 * relevant here).
 *
 * Two scenarios are shown:
 *  1. **register + inspect** — every owner registers its section into the one
 *     registry; `inspect` reports each section's default layer.
 *  2. **write + round-trip** — a schema-valid value for every *persistable*
 *     section is written through `IConfigService.set`; each is validated,
 *     env-stripped, and persisted, then `reload()` parses the file back.
 *
 * All Services come from `src/`; nothing here defines a new Service.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { type ServiceIdentifier } from '#/_base/di/instantiation';
import { AgentCronService, IAgentCronService } from '#/agent/cron';
import {
  type ConfigInspectValue,
  IConfigRegistry,
  IConfigService,
} from '#/app/config/config';
import { IFlagService } from '#/app/flag';
import { IModelService } from '#/app/model';
import { IProviderService } from '#/app/provider';
import { IAgentBackgroundService } from '#/agent/background';
import { IAgentExternalHooksService } from '#/agent/externalHooks';
import { IAgentLoopService } from '#/agent/loop';
import { IAgentPermissionRulesService } from '#/agent/permissionRules';
import { IAgentProfileService } from '#/agent/profile';

import { createSliceHost, type SliceHost } from './_harness';

/**
 * One schema-valid sample value per **persistable** section, written through
 * `IConfigService.set` so each owner's write path round-trips to `config.toml`.
 * `cron` is intentionally absent: it is operational / env-only, so it is never
 * persisted to `config.toml` by design.
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

describe('config slice (every section owner against one shared registry)', () => {
  let host: SliceHost;
  let configPath: string;

  function setUp() {
    const homeDir = process.env['KIMI_CODE_HOME'];
    if (homeDir === undefined) {
      throw new Error('KIMI_CODE_HOME is not set; globalSetup should have initialized it');
    }
    configPath = join(homeDir, 'config.toml');
    host = createSliceHost({
      homeDir,
      // Seed cron as a subagent so its scheduler/tool registration stays idle.
      agentSeeds: [
        [
          IAgentCronService as unknown as ServiceIdentifier<unknown>,
          new SyncDescriptor(AgentCronService, [{ isSubagent: true }], true),
        ],
      ],
    });
  }

  /** Resolve every section owner so its constructor registers its section. */
  function resolveOwners(): void {
    host.app.accessor.get(IModelService).list();
    host.app.accessor.get(IProviderService).list();
    host.app.accessor.get(IFlagService).snapshot();
    host.agent.accessor.get(IAgentBackgroundService);
    host.agent.accessor.get(IAgentPermissionRulesService);
    host.agent.accessor.get(IAgentProfileService);
    host.agent.accessor.get(IAgentExternalHooksService);
    host.agent.accessor.get(IAgentLoopService);
    host.agent.accessor.get(IAgentCronService);
  }

  afterEach(() => host?.dispose());

  test('every section owner registers its section into the shared registry', async () => {
    setUp();
    const registry = host.app.accessor.get(IConfigRegistry);
    const config = host.app.accessor.get(IConfigService);
    await config.ready;

    resolveOwners();

    const registered = registry
      .listSections()
      .map((s) => s.domain)
      .toSorted();
    console.log('registered sections:', registered);

    // Every known owner registers its section. The real composition root may
    // register additional sections as the system grows, so assert inclusion
    // rather than an exact list (which would rot on the next new section).
    expect(registered).toEqual(expect.arrayContaining([...EXPECTED_SECTIONS]));

    console.log('\ninspect (default layer) per section:');
    for (const domain of EXPECTED_SECTIONS) {
      console.log(`   ${domain}:`, summarizeInspect(config.inspect(domain)));
    }
  });

  test('writes every persistable section through config and round-trips the file', async () => {
    setUp();
    const config = host.app.accessor.get(IConfigService);
    await config.ready;

    resolveOwners();

    let changes = 0;
    const sub = config.onDidChangeConfiguration(() => changes++);
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
      `\n${Object.keys(SECTION_VALUES).length} sections written; onDidChangeConfiguration fired ${changes} times.`,
    );

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
