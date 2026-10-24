import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type { createKimiDeviceId as createKimiDeviceIdFn } from '@moonshot-ai/kimi-code-oauth';
import * as oauthModule from '@moonshot-ai/kimi-code-oauth';
import * as sdkModule from '@moonshot-ai/kimi-code-sdk';

import { runShell as runShellWith, type RunShellChildProcess } from '#/cli/run-shell';
import { refreshKimiRegion } from '#/utils/region';
import { setEnv, restoreEnvs } from '#test/helpers/stubs';

import * as migrationModule from '../../src/migration/index';
import { captureProcessWrite, ExitCalled, mockProcessExit } from '../helpers/process';

type CreateKimiDeviceId = typeof createKimiDeviceIdFn;

const mocks = (() => {
  type TuiConfigFallback = {
    theme: 'dark' | 'light' | 'auto';
    editorCommand: string | null;
    notifications: { enabled: boolean; condition: 'unfocused' | 'always' };
  };

  class TuiConfigParseError extends Error {
    readonly fallback: TuiConfigFallback;

    constructor(fallback: TuiConfigFallback) {
      super('Invalid TUI config in ~/.kimi-code/tui.toml; using defaults.');
      this.fallback = fallback;
    }
  }

  const lifecycleTrack = mock();

  return {
    loadTuiConfig: mock(),
    detectTerminalTheme: mock(),
    kimiHarnessConstructor: mock(),
    harnessEnsureConfigFile: mock(),
    harnessGetConfig: mock(async () => ({
      providers: {},
      defaultModel: 'k2',
      telemetry: true,
    })),
    harnessGetConfigDiagnostics: mock(async () => ({ warnings: [] as readonly string[] })),
    harnessGetCachedAccessToken: mock(),
    harnessClose: mock(),
    detectPendingMigration: mock<() => Promise<unknown>>(async () => null),
    harnessTrack: mock(),
    harnessSetEngineLocale: mock(),
    kimiTuiConstructor: mock(),
    tuiStart: mock(),
    tuiGetStartupMcpMs: mock(async () => 0),
    tuiGetCurrentSessionId: mock(() => ''),
    tuiHasSessionContent: mock(() => false),
    createKimiDeviceId: mock<CreateKimiDeviceId>(() => 'device-1'),
    initializeTelemetry: mock(),
    setCrashPhase: mock(),
    shutdownTelemetry: mock(),
    telemetryTrack: mock(),
    setTelemetryContext: mock(),
    lifecycleTrack,
    withTelemetryContext: mock(() => ({
      track: lifecycleTrack,
    })),
    resolveKimiHome: mock((homeDir?: string) => homeDir ?? '/tmp/kimi-code-test-home'),
    flushDiagnosticLogsSync: mock(),
    harnessCreatesDeviceIdOnConstruction: false,
    execFileSync: mock(() => ''),
    spawnSync: mock(),
    resolveCommandPath: mock(() => '/bin/stty' as string | undefined),
    TuiConfigParseError,
  };
})();

/**
 * Drive `runShell` against the injected child-process surface. The startup
 * `stty` calls are a seam of the source, not something to module-mock: the
 * runner below is exactly what production passes by default.
 */
const childProcessRunner = {
  execFileSync: mocks.execFileSync,
  spawnSync: mocks.spawnSync,
} as unknown as RunShellChildProcess;

function runShell(
  opts: Parameters<typeof runShellWith>[0],
  version: string,
  runOptions: Parameters<typeof runShellWith>[2] = {},
): Promise<void> {
  return runShellWith(opts, version, { ...runOptions, childProcess: childProcessRunner });
}

void mock.module('@moonshot-ai/kimi-code-sdk', () => {
  const makeHarnessStub = (args: unknown[]) => {
    const options = args[0] as { readonly homeDir?: string } | undefined;
    const homeDir = options?.homeDir ?? '/tmp/kimi-code-test-home';
    return {
      homeDir,
      auth: {
        getCachedAccessToken: mocks.harnessGetCachedAccessToken,
      },
      ensureConfigFile: mocks.harnessEnsureConfigFile,
      getConfig: mocks.harnessGetConfig,
      getConfigDiagnostics: mocks.harnessGetConfigDiagnostics,
      close: mocks.harnessClose,
      track: mocks.harnessTrack,
      setEngineLocale: mocks.harnessSetEngineLocale,
    };
  };
  return {
    ...sdkModule,
    resolveKimiHome: mocks.resolveKimiHome,
    flushDiagnosticLogsSync: mocks.flushDiagnosticLogsSync,
    createKimiHarness: (...args: unknown[]) => {
      const options = args[0] as { readonly homeDir?: string } | undefined;
      const homeDir = options?.homeDir ?? '/tmp/kimi-code-test-home';
      if (mocks.harnessCreatesDeviceIdOnConstruction) {
        mocks.createKimiDeviceId(homeDir);
      }
      mocks.kimiHarnessConstructor(...args);
      return makeHarnessStub(args);
    },
  };
});

void mock.module('@moonshot-ai/kimi-code-oauth', () => {
  return {
    ...oauthModule,
    createKimiDeviceId: mocks.createKimiDeviceId,
    KIMI_CODE_PROVIDER_NAME: 'kimi-code',
  };
});

void mock.module('@moonshot-ai/kimi-telemetry', () => ({
  initializeTelemetry: mocks.initializeTelemetry,
  setCrashPhase: mocks.setCrashPhase,
  shutdownTelemetry: mocks.shutdownTelemetry,
  track: mocks.telemetryTrack,
  setTelemetryContext: mocks.setTelemetryContext,
  withTelemetryContext: mocks.withTelemetryContext,
}));

void mock.module('../../src/tui/config', () => ({
  loadTuiConfig: mocks.loadTuiConfig,
  TuiConfigParseError: mocks.TuiConfigParseError,
}));

void mock.module('../../src/tui/index', () => ({
  KimiTUI: class {
    onExit?: () => Promise<void>;

    readonly state = { ui: { mode: 'regular' as const } };

    constructor(...args: unknown[]) {
      mocks.kimiTuiConstructor(this, ...args);
    }

    start = mocks.tuiStart;
    getStartupMcpMs = mocks.tuiGetStartupMcpMs;
    getCurrentSessionId = mocks.tuiGetCurrentSessionId;
    hasSessionContent = mocks.tuiHasSessionContent;
  },
}));

void mock.module('../../src/tui/theme/detect', () => ({
  detectTerminalTheme: mocks.detectTerminalTheme,
}));

void mock.module('../../src/migration/index', () => ({
  ...migrationModule,
  detectPendingMigration: mocks.detectPendingMigration,
}));

void mock.module('../../src/utils/process/resolve-command', () => ({
  resolveCommandPath: mocks.resolveCommandPath,
}));

describe('runShell', () => {
  beforeEach(() => {
    // Pin region to cn: the telemetry endpoint assertion below must not
    // follow the dev machine's own login/marker state.
    setEnv('KIMI_CODE_OAUTH_HOST', 'https://auth.kimi.com');
    refreshKimiRegion();
  });

  afterEach(() => {
    mock.clearAllMocks();
    restoreEnvs();
    refreshKimiRegion();
    mocks.harnessGetConfig.mockResolvedValue({
      providers: {},
      defaultModel: 'k2',
      telemetry: true,
    });
    mocks.tuiGetStartupMcpMs.mockResolvedValue(0);
    mocks.tuiGetCurrentSessionId.mockReturnValue('');
    mocks.tuiHasSessionContent.mockReturnValue(false);
    mocks.createKimiDeviceId.mockImplementation(() => 'device-1');
    mocks.resolveKimiHome.mockImplementation(
      (homeDir?: string) => homeDir ?? '/tmp/kimi-code-test-home',
    );
    mocks.resolveCommandPath.mockImplementation(() => '/bin/stty');
    mocks.harnessCreatesDeviceIdOnConstruction = false;
  });

  const minimalCliOptions = {
    session: undefined,
    continue: false,
    yolo: false,
    auto: false,
    plan: false,
    model: undefined,
    outputFormat: undefined,
    prompt: undefined,
    skillsDirs: [],
    agent: undefined,
    agentFiles: [],
  };

  function stubTuiStartup(): void {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
  }

  function withEnv(
    patch: Record<string, string | undefined>,
    fn: () => Promise<void>,
  ): Promise<void> {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(patch)) {
      saved[key] = process.env[key];
      const value = patch[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return fn().finally(() => {
      for (const key of Object.keys(patch)) {
        const value = saved[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
  }

  it('builds the harness through the SDK factory', async () => {
    stubTuiStartup();
    await runShell(minimalCliOptions, '1.2.3-test');
    expect(mocks.kimiHarnessConstructor).toHaveBeenCalledTimes(1);
  });

  it('constructs KimiHarness and KimiTUI with startup input', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.tuiGetStartupMcpMs.mockResolvedValue(47);
    mocks.tuiGetCurrentSessionId.mockReturnValue('ses-startup');

    const cliOptions = {
      session: undefined,
      continue: false,
      yolo: true,
      auto: false,
      plan: true,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
      agent: undefined,
      agentFiles: [],
      addDirs: ['../shared', '/tmp/extra'],
    };

    await runShell(cliOptions, '1.2.3-test');

    expect(mocks.kimiHarnessConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          productName: 'kimi-code-cli',
          version: '1.2.3-test',
        }),
        sessionStartedProperties: { yolo: true, auto: false, plan: true, afk: false },
      }),
    );
    expect(mocks.harnessEnsureConfigFile).toHaveBeenCalledTimes(1);
    expect(mocks.harnessEnsureConfigFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.harnessGetConfig.mock.invocationCallOrder[0]!,
    );
    // stty is resolved to an absolute path before the trust gate and skipped
    // entirely on Windows (a bare `stty` name would resolve into the
    // untrusted cwd).
    if (process.platform !== 'win32') {
      expect(mocks.execFileSync).toHaveBeenCalledWith('/bin/stty', ['-ixon'], {
        stdio: ['inherit', 'ignore', 'ignore'],
      });
    } else {
      expect(mocks.execFileSync).not.toHaveBeenCalled();
    }
    expect(mocks.kimiTuiConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.createKimiDeviceId).toHaveBeenCalledWith(
      '/tmp/kimi-code-test-home',
      expect.any(Object),
    );
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith({
      homeDir: '/tmp/kimi-code-test-home',
      deviceId: 'device-1',
      enabled: true,
      appName: 'kimi-code-cli',
      version: '1.2.3-test',
      uiMode: 'shell',
      model: 'k2',
      sessionId: undefined,
      endpoint: expect.any(Function),
      getAccessToken: expect.any(Function),
      onUnexpectedError: expect.any(Function),
    });
    // The endpoint resolver defers to the active region profile at flush time.
    const telemetryOptions = mocks.initializeTelemetry.mock.calls[0]![0] as {
      endpoint: () => string;
    };
    expect(telemetryOptions.endpoint()).toBe('https://telemetry-logs.kimi.com/v1/event');
    expect(mocks.setCrashPhase).toHaveBeenCalledWith('runtime');

    const [, harness, startupInput] = mocks.kimiTuiConstructor.mock.calls[0]!;
    expect(typeof harness).toBe('object');
    expect(startupInput).toMatchObject({
      cliOptions,
      additionalDirs: ['../shared', '/tmp/extra'],
      tuiConfig: {
        theme: 'dark',
        editorCommand: null,
        notifications: { enabled: true, condition: 'unfocused' },
      },
      version: '1.2.3-test',
      workDir: process.cwd(),
      telemetryDisabled: false,
    });
    expect(mocks.tuiStart).toHaveBeenCalledTimes(1);
    expect(mocks.withTelemetryContext).toHaveBeenCalledWith({ sessionId: 'ses-startup' });
    expect(mocks.lifecycleTrack).toHaveBeenCalledWith('startup_perf', {
      duration_ms: expect.any(Number),
      config_ms: expect.any(Number),
      init_ms: expect.any(Number),
      mcp_ms: 47,
      tui_mode: 'regular',
    });
  });

  it('never runs stty on Windows, where it would resolve into the untrusted cwd', async () => {
    stubTuiStartup();
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await runShell(minimalCliOptions, '1.2.3-test');
      expect(mocks.execFileSync).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('skips stty when it cannot be resolved outside the untrusted cwd', async () => {
    stubTuiStartup();
    if (process.platform === 'win32') return;
    mocks.resolveCommandPath.mockReturnValue(undefined);
    await runShell(minimalCliOptions, '1.2.3-test');
    expect(mocks.resolveCommandPath).toHaveBeenCalledWith('stty');
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it('resolves the --agent profile into the TUI startup input', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(
      {
        session: undefined,
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
        agent: 'reviewer',
        agentFiles: [],
      },
      '1.2.3-test',
    );

    const [, , startupInput] = mocks.kimiTuiConstructor.mock.calls[0]!;
    expect(startupInput).toMatchObject({ agentProfile: 'reviewer' });
  });

  it('forwards the telemetry opt-out from config to the TUI startup input', async () => {
    stubTuiStartup();
    mocks.harnessGetConfig.mockResolvedValue({
      providers: {},
      defaultModel: 'k2',
      telemetry: false,
    });

    await runShell(minimalCliOptions, '1.2.3-test');

    const [, , startupInput] = mocks.kimiTuiConstructor.mock.calls[0]!;
    expect(startupInput).toMatchObject({ telemetryDisabled: true });
  });

  it('forwards skillsDirs from CLI options to the harness', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(
      {
        session: undefined,
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: ['/skills'],
        agent: undefined,
        agentFiles: [],
      },
      '1.2.3-test',
    );

    expect(mocks.kimiHarnessConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ skillDirs: ['/skills'] }),
    );
  });

  it('tracks first launch when device id creation reports first launch', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.createKimiDeviceId.mockImplementationOnce((homeDir, options) => {
      const deviceId = `device-for-${homeDir}`;
      options?.onFirstLaunch?.(deviceId);
      return deviceId;
    });

    await runShell(
      {
        session: undefined,
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
        agent: undefined,
        agentFiles: [],
      },
      '1.2.3-test',
    );

    expect(mocks.createKimiDeviceId).toHaveBeenCalledWith(
      '/tmp/kimi-code-test-home',
      expect.objectContaining({ onFirstLaunch: expect.any(Function) }),
    );
    expect(mocks.harnessTrack).toHaveBeenCalledWith('first_launch');
  });

  it('registers first launch before harness construction can create the device id', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.harnessCreatesDeviceIdOnConstruction = true;
    const createdHomes = new Set<string>();
    mocks.createKimiDeviceId.mockImplementation((homeDir, options) => {
      const deviceId = `device-for-${homeDir}`;
      if (!createdHomes.has(homeDir)) {
        createdHomes.add(homeDir);
        options?.onFirstLaunch?.(deviceId);
      }
      return deviceId;
    });

    await runShell(
      {
        session: undefined,
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
        agent: undefined,
        agentFiles: [],
      },
      '1.2.3-test',
    );

    expect(mocks.createKimiDeviceId).toHaveBeenNthCalledWith(
      1,
      '/tmp/kimi-code-test-home',
      expect.objectContaining({ onFirstLaunch: expect.any(Function) }),
    );
    expect(mocks.createKimiDeviceId.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.kimiHarnessConstructor.mock.invocationCallOrder[0]!,
    );
    expect(mocks.kimiHarnessConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ homeDir: '/tmp/kimi-code-test-home' }),
    );
    expect(mocks.harnessTrack).toHaveBeenCalledWith('first_launch');
  });

  it('binds startup_perf to the session captured before MCP metrics resolve', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    let currentSessionId = 'ses-startup';
    mocks.tuiGetCurrentSessionId.mockImplementation(() => currentSessionId);
    mocks.tuiGetStartupMcpMs.mockImplementation(async () => {
      currentSessionId = 'ses-later';
      return 47;
    });

    await runShell(
      {
        session: undefined,
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
        agent: undefined,
        agentFiles: [],
      },
      '1.2.3-test',
    );

    expect(mocks.withTelemetryContext).toHaveBeenCalledWith({ sessionId: 'ses-startup' });
    expect(mocks.withTelemetryContext).not.toHaveBeenCalledWith({ sessionId: 'ses-later' });
    expect(mocks.lifecycleTrack).toHaveBeenCalledWith('startup_perf', {
      duration_ms: expect.any(Number),
      config_ms: expect.any(Number),
      init_ms: expect.any(Number),
      mcp_ms: 47,
      tui_mode: 'regular',
    });
  });

  it('bridges OAuth refresh outcomes to telemetry', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(
      {
        session: undefined,
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
        agent: undefined,
        agentFiles: [],
      },
      '1.2.3-test',
    );

    const [harnessOptions] = mocks.kimiHarnessConstructor.mock.calls[0] as [
      {
        readonly onOAuthRefresh: (
          outcome:
            | { readonly success: true }
            | { readonly success: false; readonly reason: 'unauthorized' | 'network_or_other' },
        ) => void;
      },
    ];

    harnessOptions.onOAuthRefresh({ success: true });
    harnessOptions.onOAuthRefresh({ success: false, reason: 'unauthorized' });
    harnessOptions.onOAuthRefresh({ success: false, reason: 'network_or_other' });

    expect(mocks.telemetryTrack).toHaveBeenCalledWith('oauth_refresh', { outcome: 'success' });
    expect(mocks.telemetryTrack).toHaveBeenCalledWith('oauth_refresh', {
      outcome: 'error',
      reason: 'unauthorized',
    });
    expect(mocks.telemetryTrack).toHaveBeenCalledWith('oauth_refresh', {
      outcome: 'error',
      reason: 'network_or_other',
    });
  });

  it('detects auto theme and forwards config parse warnings as startup notice', async () => {
    mocks.loadTuiConfig.mockRejectedValue(
      new mocks.TuiConfigParseError({
        theme: 'auto',
        editorCommand: 'vim',
        notifications: { enabled: true, condition: 'always' },
      }),
    );
    mocks.detectTerminalTheme.mockResolvedValue('light');
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(
      {
        session: '',
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
        agent: undefined,
        agentFiles: [],
      },
      '1.2.3-test',
    );

    expect(mocks.detectTerminalTheme).toHaveBeenCalledTimes(1);
    const [, , startupInput] = mocks.kimiTuiConstructor.mock.calls[0]!;
    expect(startupInput).toMatchObject({
      startupNotice: 'Invalid TUI config in ~/.kimi-code/tui.toml; using defaults.',
      tuiConfig: {
        theme: 'auto',
        editorCommand: 'vim',
        notifications: { enabled: true, condition: 'always' },
      },
    });
  });

  it('folds worker-install startup warnings into the same startup notice', async () => {
    mocks.loadTuiConfig.mockRejectedValue(
      new mocks.TuiConfigParseError({
        theme: 'dark',
        editorCommand: null,
        notifications: { enabled: true, condition: 'unfocused' },
      }),
    );
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(minimalCliOptions, '1.2.3-test', {
      startupWarnings: ['Native worker "kap-search" failed to install (EACCES).'],
    });

    const [, , startupInput] = mocks.kimiTuiConstructor.mock.calls[0]!;
    // A parse warning and a degraded-worker warning must both survive: the
    // notice is the only user-visible channel for either.
    expect(startupInput).toMatchObject({
      startupNotice:
        'Invalid TUI config in ~/.kimi-code/tui.toml; using defaults.\nNative worker "kap-search" failed to install (EACCES).',
    });
  });

  it('passes only the worker warnings when there is no config warning', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(minimalCliOptions, '1.2.3-test', {
      startupWarnings: ['minidb degraded'],
    });

    const [, , startupInput] = mocks.kimiTuiConstructor.mock.calls[0]!;
    expect(startupInput).toMatchObject({ startupNotice: 'minidb degraded' });
  });

  it('leaves config.toml diagnostics to the TUI instead of the startup notice', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.harnessGetConfigDiagnostics.mockResolvedValue({
      warnings: ['Ignored invalid config in config.toml: loop_control.'],
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(
      {
        session: '',
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
        agent: undefined,
        agentFiles: [],
      },
      '1.2.3-test',
    );

    // Diagnostics render in warning yellow via `showConfigWarningsIfAny` at
    // `finishStartup`; the (dim) startup notice stays reserved for things like
    // tui.toml parse errors, so the same warning is not shown twice.
    const [, , startupInput] = mocks.kimiTuiConstructor.mock.calls[0]!;
    expect(startupInput).toMatchObject({
      startupNotice: undefined,
    });
  });

  it('flushes diagnostic logs synchronously before exiting on a runtime crash', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    const processOnSpy = spyOn(process, 'on');
    const stdout = captureProcessWrite('stdout');
    const exitSpy = mockProcessExit();

    try {
      await runShell(
        {
          session: undefined,
          continue: false,
          yolo: false,
          auto: false,
          plan: false,
          model: undefined,
          outputFormat: undefined,
          prompt: undefined,
          skillsDirs: [],
          agent: undefined,
          agentFiles: [],
        },
        '1.2.3-test',
      );

      const handler = (processOnSpy.mock.calls as Array<[string, (error: unknown) => void]>).find(
        ([event]) => event === 'uncaughtException',
      )?.[1];
      expect(handler).toBeDefined();

      // The async log sink cannot flush before process.exit() runs, so the
      // crash handler must force a synchronous flush or the crash reason is
      // lost (regression: uncaughtException logs never reached disk).
      expect(() => handler?.(new Error('boom'))).toThrow(ExitCalled);
      expect(mocks.flushDiagnosticLogsSync).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mocks.flushDiagnosticLogsSync.mock.invocationCallOrder[0]!).toBeLessThan(
        exitSpy.mock.invocationCallOrder[0]!,
      );
    } finally {
      processOnSpy.mockRestore();
      exitSpy.mockRestore();
      stdout.restore();
    }
  });

  it('flushes diagnostic logs synchronously before exiting on an unhandled rejection', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    const processOnSpy = spyOn(process, 'on');
    const stdout = captureProcessWrite('stdout');
    const exitSpy = mockProcessExit();

    try {
      await runShell(
        {
          session: undefined,
          continue: false,
          yolo: false,
          auto: false,
          plan: false,
          model: undefined,
          outputFormat: undefined,
          prompt: undefined,
          skillsDirs: [],
          agent: undefined,
          agentFiles: [],
        },
        '1.2.3-test',
      );

      const handler = (processOnSpy.mock.calls as Array<[string, (reason: unknown) => void]>).find(
        ([event]) => event === 'unhandledRejection',
      )?.[1];
      expect(handler).toBeDefined();

      expect(() => handler?.(new Error('boom'))).toThrow(ExitCalled);
      expect(mocks.flushDiagnosticLogsSync).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mocks.flushDiagnosticLogsSync.mock.invocationCallOrder[0]!).toBeLessThan(
        exitSpy.mock.invocationCallOrder[0]!,
      );
    } finally {
      processOnSpy.mockRestore();
      exitSpy.mockRestore();
      stdout.restore();
    }
  });

  it('closes the harness when TUI startup fails', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockRejectedValue(new Error('boom'));

    await expect(
      runShell(
        {
          session: undefined,
          continue: false,
          yolo: false,
          auto: false,
          plan: false,
          model: undefined,
          outputFormat: undefined,
          prompt: undefined,
          skillsDirs: [],
          agent: undefined,
          agentFiles: [],
        },
        '1.2.3-test',
      ),
    ).rejects.toThrow('boom');

    expect(mocks.setCrashPhase).toHaveBeenCalledWith('shutdown');
    expect(mocks.harnessTrack).toHaveBeenCalledWith('exit', {
      duration_ms: expect.any(Number),
      tui_mode: 'regular',
    });
    expect(mocks.shutdownTelemetry).toHaveBeenCalledTimes(1);
    expect(mocks.harnessClose).toHaveBeenCalledTimes(1);
  });

  it('tracks exit and prints resume instructions from the TUI exit handler', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.tuiGetCurrentSessionId.mockReturnValue('ses-1');
    mocks.tuiHasSessionContent.mockReturnValue(true);

    const stdout = captureProcessWrite('stdout');
    const stderr = captureProcessWrite('stderr');
    const exitSpy = mockProcessExit();

    try {
      await runShell(
        {
          session: undefined,
          continue: false,
          yolo: false,
          auto: false,
          plan: false,
          model: undefined,
          outputFormat: undefined,
          prompt: undefined,
          skillsDirs: [],
          agent: undefined,
          agentFiles: [],
        },
        '1.2.3-test',
      );
      const [tui] = mocks.kimiTuiConstructor.mock.calls[0]!;
      mocks.harnessTrack.mockClear();
      mocks.lifecycleTrack.mockClear();
      mocks.withTelemetryContext.mockClear();

      await expect((tui as { onExit: () => Promise<void> }).onExit()).rejects.toBeInstanceOf(
        ExitCalled,
      );

      expect(mocks.setCrashPhase).toHaveBeenCalledWith('shutdown');
      expect(mocks.withTelemetryContext).toHaveBeenCalledWith({ sessionId: 'ses-1' });
      expect(mocks.lifecycleTrack).toHaveBeenCalledWith('exit', {
        duration_ms: expect.any(Number),
        tui_mode: 'regular',
      });
      expect(mocks.harnessTrack).not.toHaveBeenCalledWith('exit', expect.anything());
      expect(mocks.shutdownTelemetry).toHaveBeenCalledTimes(1);
      expect(stdout.text()).toBe(' Bye!\n');
      expect(stderr.text()).toContain(' To resume this session: kimi -r ses-1');
    } finally {
      exitSpy.mockRestore();
      stdout.restore();
      stderr.restore();
    }
  });

  it('prints the opened web URL from the TUI exit handler when set', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.tuiGetCurrentSessionId.mockReturnValue('ses-1');
    mocks.tuiHasSessionContent.mockReturnValue(true);

    const stdout = captureProcessWrite('stdout');
    const stderr = captureProcessWrite('stderr');
    const exitSpy = mockProcessExit();

    try {
      await runShell(
        {
          session: undefined,
          continue: false,
          yolo: false,
          auto: false,
          plan: false,
          model: undefined,
          outputFormat: undefined,
          prompt: undefined,
          skillsDirs: [],
          agent: undefined,
          agentFiles: [],
        },
        '1.2.3-test',
      );
      const [tui] = mocks.kimiTuiConstructor.mock.calls[0]!;
      const openedUrl = 'http://127.0.0.1:58627/sessions/ses-1#token=tok-1';
      (tui as { exitOpenUrl?: string }).exitOpenUrl = openedUrl;

      await expect((tui as { onExit: () => Promise<void> }).onExit()).rejects.toBeInstanceOf(
        ExitCalled,
      );

      expect(stderr.text()).toContain(' To resume this session: kimi -r ses-1');
      expect(stderr.text()).toContain('open ');
      expect(stderr.text()).toContain(openedUrl);
    } finally {
      exitSpy.mockRestore();
      stdout.restore();
      stderr.restore();
    }
  });

  it('surfaces an invalid target config as an error for kimi migrate, not silently', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.detectPendingMigration.mockResolvedValue({ totalSessions: 1 });
    mocks.harnessGetConfig.mockRejectedValue(
      new Error('Invalid configuration in ~/.kimi-code/config.toml'),
    );

    // A broken config.toml must fail loudly — `kimi migrate` must not swallow
    // it and proceed, or the user never learns their config is broken.
    await expect(
      runShell(
        {
          session: undefined,
          continue: false,
          yolo: false,
          auto: false,
          plan: false,
          model: undefined,
          outputFormat: undefined,
          prompt: undefined,
          skillsDirs: [],
          agent: undefined,
          agentFiles: [],
        },
        '1.2.3-test',
        { migrateOnly: true },
      ),
    ).rejects.toThrow('Invalid configuration');
    expect(mocks.tuiStart).not.toHaveBeenCalled();
  });

  it('refuses migration when KIMI_SHARE_DIR resolves to the Kimi Code home', async () => {
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await withEnv({ KIMI_SHARE_DIR: '/tmp/kimi-code-test-home' }, async () => {
        await runShell(minimalCliOptions, '1.2.3-test', { migrateOnly: true });
      });
      expect(mocks.detectPendingMigration).not.toHaveBeenCalled();
      expect(mocks.harnessClose).toHaveBeenCalledTimes(1);
      expect(mocks.tuiStart).not.toHaveBeenCalled();
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('KIMI_SHARE_DIR'));
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
