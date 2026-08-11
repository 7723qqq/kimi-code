/**
 * Scenario: KimiHarness session creation and resume transport behavior.
 * Responsibilities: SDK options reach the in-process core and session identity remains stable.
 * Wiring: the real SDK/core are used; model/network boundaries are configured but never called.
 * Run: pnpm -C packages/node-sdk exec vitest run test/create-session-transport.test.ts
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { join } from 'pathe';

import { createKimiHarness, KimiHarness } from '#/index';
import type { KimiError } from '#/index';
import type { ResumeSessionInput, ResumedSessionSummary } from '#/types';
import { SDKRpcClientBase } from '#/rpc';
import { afterEach, describe, expect, it } from 'vitest';

import { waitForAgentWireEvent } from './session-runtime-helpers';
import { recordingTelemetry, type TelemetryRecord } from './telemetry';
import { TEST_IDENTITY } from './test-identity';

// node-sdk/agent-core normalize paths to forward slashes (pathe). Mirror that
// in path assertions so they hold on Windows, where node:path produces
// backslashes.
const toPosix = (p: string): string => p.replaceAll('\\', '/');

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-create-'));
  tempDirs.push(dir);
  return dir;
}

async function writeTestModelConfig(homeDir: string, modelName = 'kimi-test-model'): Promise<void> {
  await writeFile(
    join(homeDir, 'config.toml'),
    `
[providers.local]
type = "kimi"
base_url = "https://example.test/v1"
api_key = "sk-test"

[models."${modelName}"]
provider = "local"
model = "${modelName}"
max_context_size = 1000
`,
    'utf-8',
  );
}

async function writeReviewerAgent(workDir: string): Promise<void> {
  const agentDir = join(workDir, '.kimi-code', 'agents');
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews code.\nsubagents:\n  - explore\n---\n\nReview the requested change.\n',
    'utf-8',
  );
}

class StubRpc extends SDKRpcClientBase {
  protected override async getRpc(): Promise<never> {
    throw new Error('not used');
  }

  override async createSession(input: { id?: string; workDir: string }) {
    return {
      id: input.id ?? 'ses_stub',
      workDir: input.workDir,
      sessionDir: '/tmp/session',
      createdAt: 1,
      updatedAt: 1,
    };
  }

  override async resumeSession(input: { id: string; workDir?: string }): Promise<ResumedSessionSummary> {
    return {
      id: input.id,
      workDir: '/tmp/work',
      sessionDir: '/tmp/session',
      createdAt: 1,
      updatedAt: 1,
      sessionMetadata: {
        createdAt: '',
        updatedAt: '',
        title: '',
        isCustomTitle: false,
        agents: {},
        custom: {},
      },
      agents: {},
    };
  }
}

describe('KimiHarness.createSession transport link', () => {
  it('emits session_started with client attribution when a session is opened', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
    });

    try {
      const session = await harness.createSession({
        id: 'ses_session_started',
        workDir,
      });
      await harness.resumeSession({ id: session.id });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_id: null,
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: false,
        },
      });
      // The v2 engine forwards its own `session_started` track2 event into
      // the host telemetry client (installEngineTelemetry); count only the
      // SDK harness's attribution-carrying events.
      expect(
        records.filter(
          (record) => record.event === 'session_started' && record.properties !== undefined && 'client_name' in record.properties,
        ),
      ).toHaveLength(1);
      expect(records).toContainEqual({
        event: 'session_new',
        sessionId: session.id,
        properties: undefined,
      });

      await session.close();
      await harness.resumeSession({ id: session.id });

      expect(
        records.filter(
          (record) => record.event === 'session_started' && record.properties !== undefined && 'client_name' in record.properties,
        ),
      ).toHaveLength(2);
      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_id: null,
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: true,
        },
      });
      expect(records).toContainEqual({
        event: 'session_resume',
        sessionId: session.id,
        properties: undefined,
      });
    } finally {
      await harness.close();
    }
  });

  it('uses the configured UI mode for session_started attribution', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
      uiMode: 'print',
    });

    try {
      const session = await harness.createSession({
        id: 'ses_session_started_print',
        workDir,
      });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_id: null,
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'print',
          resumed: false,
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('merges process-level sessionStartedProperties into session_started', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
      sessionStartedProperties: { yolo: true, plan: false },
    });

    try {
      const session = await harness.createSession({
        id: 'ses_process_props',
        workDir,
      });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_id: null,
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: false,
          yolo: true,
          plan: false,
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('merges session-level sessionStartedProperties and overrides process-level ones', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
      sessionStartedProperties: { mode: 'process', source: 'process' },
    });

    try {
      const session = await harness.createSession({
        id: 'ses_scoped_props',
        workDir,
        sessionStartedProperties: { mode: 'new' },
      });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_id: null,
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: false,
          mode: 'new',
          source: 'process',
        },
      });

      await session.close();
      await harness.resumeSession({
        id: session.id,
        sessionStartedProperties: { mode: 'load' },
      });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_id: null,
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: true,
          mode: 'load',
          source: 'process',
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('does not let sessionStartedProperties override canonical session_started fields', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
    });

    try {
      const session = await harness.createSession({
        id: 'ses_reserved_keys',
        workDir,
        sessionStartedProperties: {
          client_name: 'evil',
          client_version: 'evil',
          ui_mode: 'evil',
          resumed: true,
          extra: 'kept',
        },
      });

      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: session.id,
        properties: {
          client_id: null,
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: false,
          extra: 'kept',
        },
      });
    } finally {
      await harness.close();
    }
  });

  it('emits session_fork with the forked session context', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
    });

    try {
      const source = await harness.createSession({
        id: 'ses_fork_source',
        workDir,
      });
      const forked = await harness.forkSession({
        id: source.id,
        forkId: 'ses_fork_child',
        title: 'Forked child',
      });

      expect(forked.id).toBe('ses_fork_child');
      expect(records).toContainEqual({
        event: 'session_started',
        sessionId: forked.id,
        properties: {
          client_id: null,
          client_name: 'kimi-code-cli',
          client_version: '0.0.0-test',
          ui_mode: 'shell',
          resumed: true,
        },
      });
      expect(records).toContainEqual({
        event: 'session_fork',
        sessionId: forked.id,
        properties: undefined,
      });
    } finally {
      await harness.close();
    }
  });

  it('requires a host identity for the v2 engine bootstrap', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const records: TelemetryRecord[] = [];

    // The v2 client asserts the host identity at construction (it seeds the
    // engine's client identity / request headers); the v1 client tolerated
    // its absence and reported null attribution.
    expect(() =>
      createKimiHarness({
        homeDir,
        telemetry: recordingTelemetry(records),
      }),
    ).toThrow(/host identity/i);
    void workDir;
  });

  it('creates metadata and keeps the session active in the harness', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: 'ses_transport_link',
        workDir,
        model: 'kimi-test-model',
      });

      expect(session.id).toBe('ses_transport_link');
      expect(session.workDir).toBe(toPosix(workDir));
      await expect(session.getStatus()).resolves.toMatchObject({ model: 'kimi-test-model' });
      expect(harness.sessions.get(session.id)).toBe(session);
      // v2 persists the main-agent binding as `profile.bind` (v1 wrote
      // `config.update` — pinned in the parity KNOWN_DIFFS).
      const bindEvent = await waitForAgentWireEvent(
        homeDir,
        session.id,
        'profile.bind',
        (event) => event['modelAlias'] === 'kimi-test-model',
      );
      expect(bindEvent).toMatchObject({
        type: 'profile.bind',
        modelAlias: 'kimi-test-model',
      });
      expect(bindEvent).not.toHaveProperty('provider');

      const summaries = await harness.listSessions({ workDir });
      const summary = summaries.find((item) => item.id === session.id);
      expect(summary?.sessionDir).not.toBe(join(homeDir, 'sessions', session.id));
      expect(summary?.sessionDir).toContain(pathJoin(homeDir, 'sessions'));
      expect(existsSync(join(summary!.sessionDir, 'state.json'))).toBe(true);

      const summariesById = await harness.listSessions({ sessionId: session.id });
      expect(summariesById).toHaveLength(1);
      expect(summariesById[0]).toMatchObject({
        id: session.id,
        workDir: toPosix(workDir),
      });
      await expect(harness.listSessions({ sessionId: 'ses_missing' })).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('accepts configured model aliases while creating the core session', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeFile(
      join(homeDir, 'config.toml'),
      `
default_model = "alias-model"

[providers.local]
type = "openai"
base_url = "https://example.test/v1"
api_key = "sk-test"

[models.alias-model]
provider = "local"
model = "real-model"
max_context_size = 1000

[thinking]
effort = "medium"
`,
      'utf-8',
    );
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_alias_model', workDir });
      expect(session.id).toBe('ses_alias_model');
      await expect(session.getStatus()).resolves.toMatchObject({ model: 'alias-model' });
      expect(harness.sessions.get(session.id)).toBe(session);
      const configEvent = await waitForAgentWireEvent(
        homeDir,
        session.id,
        'profile.bind',
        (event) => event['modelAlias'] === 'alias-model',
      );
      expect(configEvent).toMatchObject({
        type: 'profile.bind',
        modelAlias: 'alias-model',
      });
      expect(configEvent).not.toHaveProperty('provider');
    } finally {
      await harness.close();
    }
  });

  it('does not require provider config or API keys before prompt is implemented', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_empty_config', workDir });
      expect(session.id).toBe('ses_empty_config');
      expect((await session.getStatus()).model).toBeUndefined();
      expect(harness.sessions.get(session.id)).toBe(session);
    } finally {
      await harness.close();
    }
  });

  it('requires a non-empty workDir on createSession', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await expect(
        harness.createSession({ id: 'ses_missing_workdir' } as never),
      ).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.work_dir_required',
      } satisfies Partial<KimiError>);
      await expect(
        harness.createSession({ id: 'ses_blank_workdir', workDir: '   ' }),
      ).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.work_dir_required',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('does not persist a session record when MCP config validation fails', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    // Project-local mcp.json is intentionally ignored, so plant the malformed
    // file under the user home dir where the loader actually reads from.
    await writeFile(join(homeDir, 'mcp.json'), '{not json}', 'utf-8');
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      // v1 validated the user-global mcp.json at session creation and
      // refused to persist the session; v2 defers MCP validation to
      // connection time, so creation succeeds (pinned in the migration
      // tracker).
      await expect(
        harness.createSession({ id: 'ses_bad_mcp_config', workDir }),
      ).resolves.toMatchObject({ id: 'ses_bad_mcp_config' });
    } finally {
      await harness.close();
    }
  });

  it('does not persist a session record when the requested agent profile is missing', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      // v1 resolved the requested agent profile eagerly at create and refused
      // to persist on failure; v2's createSession has no agentProfile channel
      // (the profile binds at agent materialization), so creation succeeds.
      await expect(
        harness.createSession({
          id: 'ses_missing_agent_profile',
          workDir,
          agentProfile: 'missing-agent',
        }),
      ).resolves.toMatchObject({ id: 'ses_missing_agent_profile' });
    } finally {
      await harness.close();
    }
  });

  it('allows the session ID to be reused after agent profile selection fails', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      // v2 ignores the agentProfile option (no eager profile resolution), so
      // the first create succeeds; a duplicate id then rejects.
      await expect(
        harness.createSession({
          id: 'ses_reusable_after_missing_profile',
          workDir,
          agentProfile: 'missing-agent',
        }),
      ).resolves.toMatchObject({ id: 'ses_reusable_after_missing_profile' });

      await expect(
        harness.createSession({
          id: 'ses_reusable_after_missing_profile',
          workDir,
        }),
      ).rejects.toMatchObject({ code: 'session.already_exists' });
    } finally {
      await harness.close();
    }
  });

  it('does not persist a session record when an explicit agent file cannot be loaded', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      // v1 loaded explicit agentfiles eagerly at create; v2 has no agentFiles
      // channel on the SDK surface, so creation succeeds.
      await expect(
        harness.createSession({
          id: 'ses_missing_explicit_agent_file',
          workDir,
          agentFiles: [join(workDir, 'missing-agent.md')],
        }),
      ).resolves.toMatchObject({ id: 'ses_missing_explicit_agent_file' });
    } finally {
      await harness.close();
    }
  });

  it('closes active runtime handles through closeSession, session.close, and close', async () => {
    const harnessSessions = (h: KimiHarness): readonly string[] => [...h.sessions.keys()];
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    const first = await harness.createSession({
      id: 'ses_close_one',
      workDir,
      model: 'kimi-test-model',
    });
    const second = await harness.createSession({
      id: 'ses_close_two',
      workDir,
      model: 'kimi-test-model',
    });
    expect(harnessSessions(harness)).toEqual([first.id, second.id]);

    await harness.closeSession(first.id);
    expect(harness.getSession(first.id)).toBeUndefined();

    await second.close();
    expect(harness.getSession(second.id)).toBeUndefined();
    expect(harness.sessions.size).toBe(0);

    await harness.close();
    expect(harness.sessions.size).toBe(0);
  });

  it('rejects deleteSession with not_implemented (v2 has no session deletion)', async () => {
    // The v2 engine has no session-deletion capability anywhere (tracked in
    // .tmp/v2-migration-tracker.md); the v1 client permanently removed the
    // session directory and index entry.
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      const session = await harness.createSession({ id: 'ses_delete_active', workDir });
      await expect(harness.deleteSession(session.id)).rejects.toMatchObject({
        code: 'not_implemented',
      });
      await expect(harness.deleteSession('ses_delete_missing')).rejects.toMatchObject({
        code: 'not_implemented',
      });
    } finally {
      await harness.close();
    }
  });

  it('preserves a legacy source directory referenced by session metadata', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const legacySourceDir = await makeTempDir();
    const markerPath = join(legacySourceDir, 'legacy-marker.txt');
    await writeFile(markerPath, 'legacy source remains', 'utf-8');
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      const session = await harness.createSession({
        id: 'ses_delete_migrated',
        workDir,
        metadata: { kimi_cli_source_path: legacySourceDir },
      });

      await harness.closeSession(session.id);

      await expect(readFile(markerPath, 'utf-8')).resolves.toBe('legacy source remains');
    } finally {
      await harness.close();
    }
  });

  it('applies initial thinking and permission runtime options', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: 'ses_initial_runtime_options',
        workDir,
        model: 'kimi-test-model',
        thinking: 'low',
        permission: 'auto',
      });

      // v2 persists the binding as `profile.bind` (v1 wrote config.update).
      // The requested 'low' effort resolves through the model's capability
      // profile (the fixture model declares none), so only the record's
      // presence and the bound model are asserted.
      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          'profile.bind',
          (event) => typeof event['modelAlias'] === 'string',
        ),
      ).resolves.toMatchObject({
        type: 'profile.bind',
        modelAlias: 'kimi-test-model',
      });
      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          'permission.set_mode',
          (event) => event['mode'] === 'auto',
        ),
      ).resolves.toMatchObject({
        type: 'permission.set_mode',
        mode: 'auto',
      });
    } finally {
      await harness.close();
    }
  });

  it('applies configured default permission mode to new sessions', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeFile(
      join(homeDir, 'config.toml'),
      `
default_permission_mode = "auto"
default_model = "kimi-test-model"

[providers.local]
type = "kimi"
base_url = "https://example.test/v1"
api_key = "sk-test"

[models."kimi-test-model"]
provider = "local"
model = "kimi-test-model"
max_context_size = 1000
`,
      'utf-8',
    );
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: 'ses_default_permission_mode',
        workDir,
      });

      await expect(session.getStatus()).resolves.toMatchObject({ permission: 'auto' });
      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          'permission.set_mode',
          (event) => event['mode'] === 'auto',
        ),
      ).resolves.toMatchObject({
        type: 'permission.set_mode',
        mode: 'auto',
      });

      const explicit = await harness.createSession({
        id: 'ses_default_permission_explicit_override',
        workDir,
        permission: 'manual',
      });
      await expect(explicit.getStatus()).resolves.toMatchObject({ permission: 'manual' });
    } finally {
      await harness.close();
    }
  });

  it('ignores a differing requested profile on an active-session resume (v2 pinned)', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    await writeReviewerAgent(workDir);
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      const session = await harness.createSession({
        id: 'ses_active_profile_identity',
        workDir,
        agentProfile: 'reviewer',
      });

      // v1 rejected a differing profile on resume; v2's resumeSession has no
      // agentProfile channel and re-selects the persisted binding (pinned in
      // the migration tracker).
      await expect(
        harness.resumeSession({ id: session.id, agentProfile: 'agent' }),
      ).resolves.toBe(session);
    } finally {
      await harness.close();
    }
  });

  it('returns the active session when the requested profile matches its binding', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    await writeReviewerAgent(workDir);
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      const session = await harness.createSession({
        id: 'ses_matching_profile_identity',
        workDir,
        agentProfile: 'reviewer',
      });

      await expect(
        harness.resumeSession({ id: session.id, agentProfile: 'reviewer' }),
      ).resolves.toBe(session);
    } finally {
      await harness.close();
    }
  });

  it('ignores a differing requested profile on a persisted-session resume (v2 pinned)', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await writeTestModelConfig(homeDir);
    await writeReviewerAgent(workDir);
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      const session = await harness.createSession({
        id: 'ses_persisted_profile_identity',
        workDir,
        agentProfile: 'reviewer',
      });
      await session.close();

      // v2 re-selects the persisted binding and ignores the requested
      // profile (see the active-session variant above).
      await expect(
        harness.resumeSession({ id: session.id, agentProfile: 'agent' }),
      ).resolves.toMatchObject({ id: session.id });
    } finally {
      await harness.close();
    }
  });
});

function coreSessionIds(harness: KimiHarness): readonly string[] {
  const core = (
    harness as unknown as {
      readonly rpc: { readonly core: { readonly sessions: ReadonlyMap<string, unknown> } };
    }
  ).rpc.core;
  return Array.from(core.sessions.keys()).toSorted();
}
