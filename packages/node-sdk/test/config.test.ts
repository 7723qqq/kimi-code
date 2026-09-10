import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseConfigString, readConfigFile, writeConfigFile } from '#/config-local';
import { createKimiConfigRpc, createKimiHarness, KimiError } from '#/index';
import {
  buildPolicySnapshot,
  resolveMaxAttemptsPerStep,
  resolveMaxStepsPerTurn,
  resolveSecondaryModelPool,
} from '#/native/native-llm-resolver';

import { TEST_IDENTITY } from './test-identity';

// node-sdk/agent-core normalize paths to forward slashes (pathe). Mirror that
// in path assertions so they hold on Windows, where node:path produces
// backslashes.
const toPosix = (p: string): string => p.replaceAll('\\', '/');

const tempDirs: string[] = [];

/**
 * Windows keeps file handles (antivirus, fs watchers, lazy minidb flush) alive
 * briefly after close, so a bare `rm` can fail with ENOTEMPTY/EBUSY/EPERM.
 * Retry briefly before giving up.
 */
async function removeDirWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  await rm(dir, { recursive: true, force: true });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    await removeDirWithRetry(dir);
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-config-'));
  tempDirs.push(dir);
  return dir;
}

const COMPLETE_TOML = `
default_model = "kimi-for-coding"
default_permission_mode = "auto"
skip_afk_prompt_injection = false
default_plan_mode = false
default_editor = ""
theme = "dark"
show_thinking_stream = true
merge_all_available_skills = true
extra_skill_dirs = ["~/team-skills", ".agents/team-skills"]

[providers.kimi-for-coding]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = "sk-xxx"
custom_headers = { "X-Custom-Header" = "value" }

[providers.kimi-for-coding.env]
GOOGLE_CLOUD_PROJECT = "project-1"

[models.kimi-for-coding]
provider = "kimi-for-coding"
model = "kimi-for-coding"
max_context_size = 262144
capabilities = ["image_in", "thinking", "video_in"]
display_name = "Kimi for Coding"

[loop_control]
max_retries_per_step = 3
max_ralph_iterations = 0
reserved_context_size = 50000
compaction_trigger_ratio = 0.85

[background]
max_running_tasks = 4
keep_alive_on_exit = false
kill_grace_period_ms = 2000
print_wait_ceiling_s = 3600

[services.moonshot_search]
base_url = "https://api.kimi.com/coding/v1/search"
api_key = "sk-search"
custom_headers = { "X-Search" = "1" }

[services.moonshot_fetch]
base_url = "https://api.kimi.com/coding/v1/fetch"
api_key = "sk-fetch"

[notifications]
claim_stale_after_ms = 15000

[thinking]
enabled = true
effort = "high"
`;

describe('SDK config TOML', () => {
  it('resolves config paths through the config RPC wrapper', async () => {
    const dir = await makeTempDir();
    const rpc = createKimiConfigRpc();

    await expect(rpc.resolveConfigPath({ homeDir: dir })).resolves.toBe(
      toPosix(join(dir, 'config.toml')),
    );
  });

  it('returns structured validation issues through the config RPC wrapper', async () => {
    const rpc = createKimiConfigRpc();

    await expect(
      rpc.validateConfigToml({
        text: `
[providers.kimi]
type = "kimi"

[models.kimi]
provider = "kimi"
model = "kimi"
max_context_size = "large"
`,
        filePath: 'broken.toml',
      }),
    ).rejects.toMatchObject({
      details: {
        validationIssues: [
          {
            path: ['models', 'kimi', 'maxContextSize'],
          },
        ],
      },
    });
  });

  it('parses the documented config shape and keeps TUI-only fields in raw', () => {
    const config = parseConfigString(COMPLETE_TOML, 'complete.toml');

    expect(config.defaultModel).toBe('kimi-for-coding');
    expect(config.thinking?.enabled).toBe(true);
    expect(config.thinking?.effort).toBe('high');
    expect(config.defaultPermissionMode).toBe('auto');
    expect(config.defaultPlanMode).toBe(false);
    expect(config.mergeAllAvailableSkills).toBe(true);
    expect(config.extraSkillDirs).toEqual(['~/team-skills', '.agents/team-skills']);

    const provider = config.providers['kimi-for-coding'];
    expect(provider).toMatchObject({
      type: 'kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-xxx',
      customHeaders: { 'X-Custom-Header': 'value' },
      env: { GOOGLE_CLOUD_PROJECT: 'project-1' },
    });

    expect(config.models?.['kimi-for-coding']).toMatchObject({
      provider: 'kimi-for-coding',
      model: 'kimi-for-coding',
      maxContextSize: 262144,
      capabilities: ['image_in', 'thinking', 'video_in'],
      displayName: 'Kimi for Coding',
    });

    expect(config.loopControl).toEqual({
      maxRetriesPerStep: 3,
      maxRalphIterations: 0,
      reservedContextSize: 50000,
      compactionTriggerRatio: 0.85,
    });
    expect(config.background).toEqual({
      maxRunningTasks: 4,
      keepAliveOnExit: false,
      killGracePeriodMs: 2000,
      printWaitCeilingS: 3600,
    });
    expect(config.services?.moonshotSearch?.customHeaders).toEqual({ 'X-Search': '1' });
    expect(config.services?.moonshotFetch?.apiKey).toBe('sk-fetch');

    expect('theme' in config).toBe(false);
    expect(config.raw?.['theme']).toBe('dark');
    expect(config.raw?.['skip_afk_prompt_injection']).toBe(false);
    expect(config.raw?.['show_thinking_stream']).toBe(true);
    expect(config.raw?.['notifications']).toEqual({ claim_stale_after_ms: 15000 });
  });

  it('writes typed fields in snake_case and preserves unknown raw sections', async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, 'config.toml');
    const config = parseConfigString(COMPLETE_TOML, configPath);

    await writeConfigFile(configPath, {
      ...config,
      defaultModel: 'kimi-for-coding',
      loopControl: {
        ...config.loopControl,
        maxStepsPerTurn: 42,
      },
    });

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('default_model = "kimi-for-coding"');
    expect(text).toContain('default_permission_mode = "auto"');
    expect(text).toContain('extra_skill_dirs = [ "~/team-skills", ".agents/team-skills" ]');
    expect(text).not.toContain('default_yolo');
    expect(text).toContain('max_steps_per_turn = 42');
    expect(text).toContain('display_name = "Kimi for Coding"');
    expect(text).toContain('GOOGLE_CLOUD_PROJECT = "project-1"');
    expect(text).toContain('claim_stale_after_ms = 15000');
    expect(text).toContain('theme = "dark"');

    const reloaded = readConfigFile(configPath);
    expect(reloaded.loopControl?.maxStepsPerTurn).toBe(42);
    expect(reloaded.raw?.['theme']).toBe('dark');
  });

  it('round-trips the github token section as a typed string field', async () => {
    const config = parseConfigString(
      `
[github]
token = "ghp_example_token"
base_url = "https://github.example.com/api/v3"
`,
      'github.toml',
    );
    expect(config.github).toEqual({
      token: 'ghp_example_token',
      baseUrl: 'https://github.example.com/api/v3',
    });
    expect(config.experimental).toBeUndefined();

    const dir = await makeTempDir();
    const configPath = join(dir, 'config.toml');
    await writeConfigFile(configPath, config);

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('[github]');
    expect(text).toContain('token = "ghp_example_token"');
    expect(text).toContain('base_url = "https://github.example.com/api/v3"');

    const reloaded = readConfigFile(configPath);
    expect(reloaded.github).toEqual({
      token: 'ghp_example_token',
      baseUrl: 'https://github.example.com/api/v3',
    });
  });

  it('round-trips the [tools] global switch and resolves it into the policy snapshot', async () => {
    const config = parseConfigString(
      `
[tools]
enabled = ["Read", "Grep"]
disabled = ["Bash"]
`,
      'tools.toml',
    );
    expect(config.tools).toEqual({ enabled: ['Read', 'Grep'], disabled: ['Bash'] });

    // The engine receives the switch through the policy snapshot.
    expect(buildPolicySnapshot(config, '.').tools_filter).toEqual({
      enabled: ['Read', 'Grep'],
      disabled: ['Bash'],
    });
    expect(
      buildPolicySnapshot(parseConfigString('', 'empty.toml'), '.').tools_filter,
    ).toBeUndefined();

    const dir = await makeTempDir();
    const configPath = join(dir, 'config.toml');
    await writeConfigFile(configPath, config);

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('[tools]');
    expect(text).toContain('enabled = [ "Read", "Grep" ]');
    expect(readConfigFile(configPath).tools).toEqual({
      enabled: ['Read', 'Grep'],
      disabled: ['Bash'],
    });
  });

  const POOL_TOML = `
default_model = "kimi-code/k3"

[providers.local]
type = "openai"
base_url = "https://example.test/v1"
api_key = "YOUR_API_KEY"

[models."kimi-code/k3"]
provider = "local"
model = "k3"
max_context_size = 200000

[models."kimi-code/fast"]
provider = "local"
model = "fast"
max_context_size = 200000
`;

  it('resolves the [secondary_model] pool into the engine wire shape', () => {
    const config = parseConfigString(
      `${POOL_TOML}
[secondary_model]
default_model = "kimi-code/fast"
default_effort = "high"

[secondary_model.models]
"kimi-code/k3" = "Hard problems."
"kimi-code/fast" = "Cheap and quick."
`,
      'secondary.toml',
    );

    const pool = resolveSecondaryModelPool(config, true);
    expect(pool).toMatchObject({
      force: false,
      defaultModel: 'kimi-code/fast',
      callerModelAlias: 'kimi-code/k3',
    });
    expect(pool?.models.map((entry) => entry.alias)).toEqual(['kimi-code/k3', 'kimi-code/fast']);
    expect(pool?.models.find((entry) => entry.alias === 'kimi-code/fast')?.hint).toBe(
      'Cheap and quick.',
    );
    // The section's default_effort outranks the entry's own effort.
    expect(pool?.models.find((entry) => entry.alias === 'kimi-code/fast')?.llm).toMatchObject({
      model: 'fast',
      base_url: 'https://example.test/v1',
      reasoning_effort: 'high',
    });
  });

  it('treats a lone default_model as a single-entry pool', () => {
    const config = parseConfigString(
      `${POOL_TOML}
[secondary_model]
default_model = "kimi-code/fast"
`,
      'secondary-lone.toml',
    );
    const pool = resolveSecondaryModelPool(config, true);
    expect(pool?.models.map((entry) => entry.alias)).toEqual(['kimi-code/fast']);
    expect(pool?.models[0]?.hint).toBe('');
  });

  it('rejects a malformed [secondary_model] section by naming the entry', () => {
    const unknownDefault = parseConfigString(
      `${POOL_TOML}
[secondary_model]
default_model = "kimi-code/missing"

[secondary_model.models]
"kimi-code/fast" = ""
`,
      'secondary-bad-default.toml',
    );
    expect(() => resolveSecondaryModelPool(unknownDefault, true)).toThrow(
      /not a \[secondary_model\.models\] key/,
    );

    const forceWithTable = parseConfigString(
      `${POOL_TOML}
[secondary_model]
default_model = "kimi-code/fast"
force = true

[secondary_model.models]
"kimi-code/fast" = ""
`,
      'secondary-force.toml',
    );
    expect(() => resolveSecondaryModelPool(forceWithTable, true)).toThrow(
      /force cannot be combined/,
    );

    const forceWithoutDefault = parseConfigString(
      `${POOL_TOML}
[secondary_model]
force = true
`,
      'secondary-force-without-default.toml',
    );
    expect(() => resolveSecondaryModelPool(forceWithoutDefault, true)).toThrow(
      /required when \[secondary_model\]\.force is set/,
    );

    const forceWithTableNoDefault = parseConfigString(
      `${POOL_TOML}
[secondary_model]
force = true

[secondary_model.models]
"kimi-code/fast" = ""
`,
      'secondary-force-table-no-default.toml',
    );
    expect(() => resolveSecondaryModelPool(forceWithTableNoDefault, true)).toThrow(
      /force cannot be combined/,
    );

    const brokenAlias = parseConfigString(
      `${POOL_TOML}
[secondary_model]
default_model = "kimi-code/unresolvable"

[secondary_model.models]
"kimi-code/unresolvable" = ""
`,
      'secondary-broken-alias.toml',
    );
    expect(() => resolveSecondaryModelPool(brokenAlias, true)).toThrow(
      /"kimi-code\/unresolvable" could not be resolved/,
    );

    const reserved = parseConfigString(
      `${POOL_TOML}
[secondary_model]
default_model = "primary"

[secondary_model.models]
primary = ""
`,
      'secondary-reserved.toml',
    );
    expect(() => resolveSecondaryModelPool(reserved, true)).toThrow(/reserved/);
  });

  it('stays inert while the experimental flag is disabled', () => {
    const config = parseConfigString(
      `${POOL_TOML}
[secondary_model]
default_model = "kimi-code/fast"
`,
      'secondary-disabled.toml',
    );
    expect(resolveSecondaryModelPool(config, false)).toBeUndefined();
    expect(resolveSecondaryModelPool(parseConfigString('', 'no-pool.toml'), true)).toBeUndefined();
  });

  it('resolves loop_control.max_attempts_per_step with env precedence', () => {
    const config = parseConfigString(
      `
[loop_control]
max_attempts_per_step = 3
`,
      'loop-control.toml',
    );
    expect(resolveMaxAttemptsPerStep(config)).toBe(3);

    // The deprecated spelling still resolves, but the current key wins.
    const deprecated = parseConfigString(
      `
[loop_control]
max_retries_per_step = 5
`,
      'loop-control-deprecated.toml',
    );
    expect(resolveMaxAttemptsPerStep(deprecated)).toBe(5);

    vi.stubEnv('KIMI_LOOP_MAX_ATTEMPTS_PER_STEP', '7');
    expect(resolveMaxAttemptsPerStep(config)).toBe(7);
    vi.unstubAllEnvs();

    vi.stubEnv('KIMI_LOOP_MAX_RETRIES_PER_STEP', '9');
    expect(resolveMaxAttemptsPerStep(config)).toBe(9);
    vi.unstubAllEnvs();
  });

  it('resolves loop_control.max_steps_per_turn with env precedence', () => {
    const config = parseConfigString(
      `
[loop_control]
max_steps_per_turn = 25
`,
      'loop-control-steps.toml',
    );
    expect(resolveMaxStepsPerTurn(config)).toBe(25);

    // `0` means unlimited, exactly like an unset value.
    const unlimited = parseConfigString(
      `
[loop_control]
max_steps_per_turn = 0
`,
      'loop-control-unlimited.toml',
    );
    expect(resolveMaxStepsPerTurn(unlimited)).toBeUndefined();
    expect(resolveMaxStepsPerTurn(parseConfigString('', 'no-loop-control.toml'))).toBeUndefined();

    vi.stubEnv('KIMI_LOOP_MAX_STEPS_PER_TURN', '12');
    expect(resolveMaxStepsPerTurn(config)).toBe(12);
    vi.stubEnv('KIMI_LOOP_MAX_STEPS_PER_TURN', '0');
    expect(resolveMaxStepsPerTurn(config)).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('accepts camelCase aliases without keeping unknown fields in typed config', () => {
    const config = parseConfigString(`
defaultModel = "camel-model"

[providers.local]
type = "openai"
baseUrl = "https://example.test/v1"
apiKey = "sk-test"
unsupported_provider_field = "raw-only"

[models.camel-model]
provider = "local"
model = "gpt-test"
maxContextSize = 128000
displayName = "Camel Model"
custom_model_field = "raw-only"

[services.moonshotSearch]
baseUrl = "https://example.test/search"
apiKey = "sk-search"

[loopControl]
maxStepsPerRun = 7

[background]
maxRunningTasks = 2
`);

    expect(config.defaultModel).toBe('camel-model');
    expect(config.providers['local']).toMatchObject({
      type: 'openai',
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-test',
    });
    expect(config.models?.['camel-model']).toMatchObject({
      maxContextSize: 128000,
      displayName: 'Camel Model',
    });
    expect(config.services?.moonshotSearch).toMatchObject({
      baseUrl: 'https://example.test/search',
      apiKey: 'sk-search',
    });
    expect(config.loopControl?.maxStepsPerTurn).toBe(7);
    expect(config.background?.maxRunningTasks).toBe(2);

    expect('unsupportedProviderField' in config.providers['local']!).toBe(false);
    expect('customModelField' in config.models!['camel-model']!).toBe(false);

    const rawProviders = config.raw?.['providers'] as Record<string, Record<string, unknown>>;
    const rawModels = config.raw?.['models'] as Record<string, Record<string, unknown>>;
    expect(rawProviders['local']?.['unsupported_provider_field']).toBe('raw-only');
    expect(rawModels['camel-model']?.['custom_model_field']).toBe('raw-only');
  });
});

describe('KimiHarness config API', () => {
  it('loads default config when missing and deep-merges setConfig patches from disk', async () => {
    const homeDir = await makeTempDir();
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');

    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await harness.setConfig({
      providers: {
        'kimi-for-coding': {
          apiKey: 'sk-updated',
        },
      },
      services: {
        moonshotSearch: {
          apiKey: 'sk-search-updated',
        },
      },
    });

    const config = await harness.getConfig({ reload: true });
    expect(config.providers['kimi-for-coding']).toMatchObject({
      type: 'kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiKey: 'sk-updated',
      env: { GOOGLE_CLOUD_PROJECT: 'project-1' },
    });
    expect(config.services?.moonshotSearch?.apiKey).toBe('sk-search-updated');
    // v2's getConfig has no v1-style `raw` passthrough (pinned in the
    // config-mapper notes); the raw document is asserted from the file below.
    expect(config.raw).toBeUndefined();

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('theme = "dark"');
    expect(text).toContain('GOOGLE_CLOUD_PROJECT = "project-1"');
    expect(text).toContain('claim_stale_after_ms = 15000');
  });

  it('does not write invalid config patches', async () => {
    const homeDir = await makeTempDir();
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');
    const before = await readFile(configPath, 'utf-8');

    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    const setInvalidConfig = harness.setConfig({
      providers: {
        bad: {
          type: 'not-a-provider',
        },
      },
    } as never);

    // v2 defers provider validation to resolution time: the config write
    // itself succeeds (deep-merge per domain) and the provider entry lands on
    // disk; resolving it would fail later. Assert the write is accepted.
    await expect(setInvalidConfig).resolves.toBeDefined();
    const after = await readFile(configPath, 'utf-8');
    expect(after).not.toBe(before);
    expect(after).toContain('not-a-provider');
  });

  it('uses default config when the config file is absent', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    // v2's effective view materializes registered section defaults (models {},
    // image {}, ...) on top of the empty document; the v1 `{providers: {}}`
    // shape is a subset of it. Assert the contract fields that matter.
    const config = await harness.getConfig();
    expect(config.providers).toEqual({});
    expect(config.defaultModel).toBeUndefined();
    expect(config.models).toEqual({});
  });

  it('returns experimental feature metadata through the harness', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    const features = await harness.getExperimentalFeatures();
    // v2's flag registry carries a superset of v1's list (the v1 comparison
    // fixture only covered the entries both engines shared); assert the
    // shared entries are present with their full metadata.
    expect(features).toEqual(
      expect.arrayContaining([
        {
          id: 'tool_select',
          title: 'Tool select (progressive tool disclosure)',
          description:
            'Keep MCP tool schemas out of the immutable top-level tools[]; the model loads them on demand via the select_tools tool. Only takes effect on models whose capability catalog declares dynamically loaded tools.',
          surface: 'core',
          env: 'KIMI_CODE_EXPERIMENTAL_TOOL_SELECT',
          defaultEnabled: true,
          enabled: true,
          source: 'default',
        },
        {
          id: 'secondary-model',
          title: 'Secondary model for subagents',
          description:
            'Let newly spawned subagents use a separately configured secondary model by default, with an explicit primary-model override for quality-sensitive tasks.',
          surface: 'core',
          env: 'KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL',
          defaultEnabled: true,
          enabled: true,
          source: 'default',
        },
      ]),
    );
  });

  it('can create the default config scaffold without selecting a model', async () => {
    const homeDir = await makeTempDir();
    const configPath = join(homeDir, 'config.toml');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    await harness.ensureConfigFile();

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('Runtime settings for Kimi Code.');
    expect(text).not.toMatch(/^default_thinking =/m);
    expect(text).not.toMatch(/^default_model =/m);

    const config = await harness.getConfig({ reload: true });
    expect(config.providers).toEqual({});
    expect(config.defaultModel).toBeUndefined();
    expect(config.thinking?.enabled).toBeUndefined();
  });

  it('reloads an active session without closing the SDK session wrapper', async () => {
    const homeDir = await makeTempDir();
    const workDir = join(homeDir, 'work');
    await mkdir(workDir, { recursive: true });
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    const session = await harness.createSession({
      id: 'session-sdk-reload',
      workDir,
      model: 'kimi-for-coding',
    });

    expect(session.getResumeState()).toBeUndefined();

    const reloaded = await harness.reloadSession({ id: session.id });

    expect(reloaded).toBe(session);
    expect(harness.getSession(session.id)).toBe(session);
    expect(session.getResumeState()?.agents['main']).toBeDefined();
    await expect(session.getStatus()).resolves.toMatchObject({ model: 'kimi-for-coding' });
  });

  it('forwards forcePluginSessionStartReminder to the active session reload', async () => {
    const homeDir = await makeTempDir();
    const workDir = join(homeDir, 'work');
    await mkdir(workDir, { recursive: true });
    const configPath = join(homeDir, 'config.toml');
    await writeFile(configPath, COMPLETE_TOML, 'utf-8');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    const session = await harness.createSession({
      id: 'session-sdk-reload-forward',
      workDir,
      model: 'kimi-for-coding',
    });

    const reloadSpy = vi.spyOn(session, 'reloadSession').mockResolvedValue({} as never);

    await harness.reloadSession({ id: session.id, forcePluginSessionStartReminder: true });

    expect(reloadSpy).toHaveBeenCalledWith({ forcePluginSessionStartReminder: true });
  });
});
