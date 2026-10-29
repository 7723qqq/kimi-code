import type * as ChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { afterEach, beforeEach, describe, expect, it, jest, vi } from 'bun:test';
import { setEnv, restoreEnvs } from '../../helpers/stubs';

const requireReal = createRequire(import.meta.url);

import { readUpdateCache } from '#/cli/update/cache';
import {
  emptyUpdateInstallState,
  readUpdateInstallState,
  writeUpdateInstallState,
} from '#/cli/update/install-state';
import { installCommandFor, runUpdatePreflight } from '#/cli/update/preflight';
import * as actualPrompt from '#/cli/update/prompt';
import { promptForInstallChoice } from '#/cli/update/prompt';
import type * as PromptModule from '#/cli/update/prompt';
import * as actualRefresh from '#/cli/update/refresh';
import { refreshUpdateCache } from '#/cli/update/refresh';
import type * as RefreshModule from '#/cli/update/refresh';
import * as actualRollout from '#/cli/update/rollout';
import type * as RolloutModule from '#/cli/update/rollout';
import { detectInstallSource } from '#/cli/update/source';
import {
  emptyUpdateCache,
  type UpdateCache,
  type UpdateInstallState,
  type UpdateManifest,
} from '#/cli/update/types';
import type { TuiConfig } from '#/tui/config';
import { resetKimiRegionCache } from '#/utils/region';

/** Set by a case that hands the preflight a never-settling refresh. */
let releasePendingRefresh: (() => void) | undefined;

const mocks = (() => ({
  readUpdateCache: jest.fn(),
  readUpdateInstallState: jest.fn(),
  writeUpdateInstallState: jest.fn(),
  tryAcquireUpdateInstallLock: jest.fn(),
  loadTuiConfig: jest.fn(),
  detectInstallSource: jest.fn(),
  promptForInstallChoice: jest.fn(),
  refreshUpdateCache: jest.fn(),
  resolveUpdateDeviceId: jest.fn(),
  appendRolloutDecisionLog: jest.fn(),
  spawn: jest.fn(),
  // Identity by default: resolution is covered by resolve-command.test.ts;
  // here we only care which command string reaches spawn().
  resolveCommandPath: jest.fn((cmd: string) => cmd as string | undefined),
}))();

jest.mock('#/utils/process/resolve-command', () => ({
  resolveCommandPath: mocks.resolveCommandPath,
}));

jest.mock('../../../src/cli/update/cache', () => ({
  readUpdateCache: mocks.readUpdateCache,
}));

jest.mock('../../../src/cli/update/install-lock', () => ({
  tryAcquireUpdateInstallLock: mocks.tryAcquireUpdateInstallLock,
}));

jest.mock('../../../src/cli/update/install-state', () => ({
  emptyUpdateInstallState: () => ({
    active: null,
    lastFailure: null,
    lastSuccess: null,
  }),
  readUpdateInstallState: mocks.readUpdateInstallState,
  writeUpdateInstallState: mocks.writeUpdateInstallState,
}));

jest.mock('../../../src/tui/config', () => ({
  loadTuiConfig: mocks.loadTuiConfig,
  TuiConfigParseError: class TuiConfigParseError extends Error {
    readonly fallback: TuiConfig;

    constructor(fallback: TuiConfig) {
      super('Invalid client preferences in ~/.kimi-code/tui.toml; using defaults.');
      this.fallback = fallback;
    }
  },
}));

jest.mock('../../../src/cli/update/source', () => ({
  detectInstallSource: mocks.detectInstallSource,
}));

jest.mock('../../../src/cli/update/prompt', () => ({
  ...actualPrompt,
  promptForInstallChoice: mocks.promptForInstallChoice,
}));

jest.mock('../../../src/cli/update/refresh', () => ({
  ...actualRefresh,
  refreshUpdateCache: mocks.refreshUpdateCache,
}));

jest.mock('../../../src/cli/update/rollout', () => ({
  ...actualRollout,
  resolveUpdateDeviceId: mocks.resolveUpdateDeviceId,
  // Stubbed so preflight tests never write a real rollout.log.
  appendRolloutDecisionLog: mocks.appendRolloutDecisionLog,
}));

jest.mock('node:child_process', () => ({
  ...requireReal('node:child_process'),
  spawn: mocks.spawn,
}));

function cacheWith(version: string): UpdateCache {
  return {
    source: 'cdn',
    checkedAt: '2026-04-23T08:00:00.000Z',
    latest: version,
    manifest: null,
  };
}

function manifestFor(version: string, overrides: Partial<UpdateManifest> = {}): UpdateManifest {
  return {
    version,
    publishedAt: '2020-01-01T00:00:00.000Z',
    rollout: [],
    ...overrides,
  };
}

function cacheWithManifest(manifest: UpdateManifest): UpdateCache {
  return {
    source: 'cdn',
    checkedAt: '2026-04-23T08:00:00.000Z',
    latest: manifest.version,
    manifest,
  };
}

/**
 * The spawn target the installer produces for a package-manager hit on the
 * current platform. `resolveSpawnCommand` quotes the resolved path and the
 * caller turns on `shell` on win32 (a `.cmd` shim cannot be spawned directly),
 * so the expectation has to follow the host rather than assume a bare name.
 */
function packageManagerSpawn(name: string): {
  readonly cmd: RegExp;
  readonly shell: boolean | undefined;
} {
  return process.platform === 'win32'
    ? { cmd: new RegExp(`^"${name}(\\.cmd|\\.exe)?"$`), shell: true }
    : { cmd: new RegExp(`^${name}$`), shell: undefined };
}

/**
 * Assert the `spawn` call the installer made. `toHaveBeenCalledWith` compares a
 * RegExp argument literally, so the command pattern is checked separately.
 */
function expectPackageManagerSpawn(
  name: string,
  args: readonly string[],
  options: Record<string, unknown>,
): void {
  const target = packageManagerSpawn(name);
  expect(mocks.spawn).toHaveBeenCalledWith(
    expect.any(String),
    args,
    expect.objectContaining({ ...options, shell: target.shell }),
  );
  expect(mocks.spawn.mock.lastCall?.[0]).toMatch(target.cmd);
}

function npmSpawnTarget(): { readonly cmd: RegExp; readonly shell: boolean | undefined } {
  return packageManagerSpawn('npm');
}

function expectNpmSpawn(args: readonly string[], options: Record<string, unknown>): void {
  expectPackageManagerSpawn('npm', args, options);
}

/** Every bucket delayed by 24h and the clock just started: nobody is eligible. */
function heldForEveryone(version: string): UpdateManifest {
  return manifestFor(version, {
    publishedAt: new Date(Date.now() - 1_000).toISOString(),
    rollout: [{ percent: 100, delaySeconds: 86_400 }],
  });
}

/** Every bucket immediate and publishedAt long past: everybody is eligible. */
function releasedForEveryone(version: string): UpdateManifest {
  return manifestFor(version, {
    rollout: [{ percent: 100, delaySeconds: 0 }],
  });
}

function installState(overrides: Partial<UpdateInstallState> = {}): UpdateInstallState {
  return {
    active: null,
    lastFailure: null,
    lastSuccess: null,
    ...overrides,
  };
}

function tuiConfig(overrides: Partial<TuiConfig> = {}): TuiConfig {
  return {
    theme: 'auto',
    disablePasteBurst: false,
    locale: 'en',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    upgrade: { autoInstall: true },
    ...overrides,
  };
}

function disableAutoInstall(): void {
  mocks.loadTuiConfig.mockResolvedValue(tuiConfig({ upgrade: { autoInstall: false } }));
}

function captureOutput(): {
  stdout: string[];
  stderr: string[];
  options: {
    stdout: { write(chunk: string): boolean };
    stderr: { write(chunk: string): boolean };
    isTTY: boolean;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    options: {
      stdout: { write: (chunk: string) => { stdout.push(chunk); return true; } },
      stderr: { write: (chunk: string) => { stderr.push(chunk); return true; } },
      isTTY: true,
    },
  };
}

type TestLogFn = ReturnType<typeof jest.fn<(message: string, payload?: unknown) => void>>;

function captureLogger(): {
  info: TestLogFn;
  warn: TestLogFn;
  error: TestLogFn;
  debug: TestLogFn;
} {
  return {
    info: jest.fn<(message: string, payload?: unknown) => void>(),
    warn: jest.fn<(message: string, payload?: unknown) => void>(),
    error: jest.fn<(message: string, payload?: unknown) => void>(),
    debug: jest.fn<(message: string, payload?: unknown) => void>(),
  };
}

function mockSpawnExit(code: number, signal: NodeJS.Signals | null = null): void {
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: jest.fn() });
    queueMicrotask(() => { child.emit('exit', code, signal); });
    return child;
  });
}

async function flushBackgroundInstall(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('runUpdatePreflight', () => {
  beforeEach(() => {
    // Pin the experimental flag off so rollout gating is deterministic
    // regardless of the host environment (the flag bypasses batch holds).
    // Tests that exercise the bypass opt back in with `setEnv(..., '1')`.
    setEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '');
    // Pin the region to cn so address assertions don't follow the dev
    // machine's own login/marker state; global tests override below.
    setEnv('KIMI_CODE_OAUTH_HOST', 'https://auth.kimi.com');
    resetKimiRegionCache();
    mocks.readUpdateInstallState.mockResolvedValue(emptyUpdateInstallState());
    mocks.writeUpdateInstallState.mockResolvedValue(undefined);
    mocks.loadTuiConfig.mockResolvedValue(tuiConfig());
    mocks.resolveUpdateDeviceId.mockReturnValue('test-device');
    mocks.appendRolloutDecisionLog.mockResolvedValue(undefined);
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue({
      filePath: '/tmp/kimi-update-install.lock',
      release: jest.fn().mockResolvedValue(undefined),
    });
    mocks.resolveCommandPath.mockImplementation((cmd: string) => cmd);
  });

  afterEach(() => {
    // Release any refresh a fire-and-forget background helper is still
    // awaiting: an unsettled promise would keep the runner alive.
    releasePendingRefresh?.();
    releasePendingRefresh = undefined;
    jest.clearAllMocks();
    restoreEnvs();
    resetKimiRegionCache();
  });

  it('skips all update work when KIMI_CODE_NO_AUTO_UPDATE is set', async () => {
    setEnv('KIMI_CODE_NO_AUTO_UPDATE', '1');
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');

    expect(readUpdateCache).not.toHaveBeenCalled();
    expect(refreshUpdateCache).not.toHaveBeenCalled();
    expect(detectInstallSource).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('also honors the legacy KIMI_CLI_NO_AUTO_UPDATE alias', async () => {
    setEnv('KIMI_CLI_NO_AUTO_UPDATE', 'true');
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');

    expect(readUpdateCache).not.toHaveBeenCalled();
    expect(detectInstallSource).not.toHaveBeenCalled();
  });

  it('starts an automatic update from the first fresh check when the cache is empty', async () => {
    mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mockSpawnExit(0);
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    await flushBackgroundInstall();

    expect(readUpdateCache).toHaveBeenCalledTimes(1);
    expect(refreshUpdateCache).toHaveBeenCalledTimes(1);
    expect(promptForInstallChoice).not.toHaveBeenCalled();
    expect(detectInstallSource).toHaveBeenCalledTimes(1);
    expectNpmSpawn(['install', '-g', '@moonshot-ai/kimi-code@0.5.0'], { detached: true, stdio: 'ignore' });
  });

  it('does not start a fresh-check background install when automatic updates are disabled', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    await flushBackgroundInstall();

    expect(refreshUpdateCache).toHaveBeenCalledTimes(1);
    expect(detectInstallSource).toHaveBeenCalledTimes(1);
    expect(promptForInstallChoice).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('skips when non-interactive', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    const { options } = captureOutput();
    await expect(
      runUpdatePreflight('0.4.0', { ...options, isTTY: false }),
    ).resolves.toBe('continue');
    expect(detectInstallSource).not.toHaveBeenCalled();
  });

  it('does not start a fresh-check background install when non-interactive', async () => {
    mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    const { options } = captureOutput();

    await expect(
      runUpdatePreflight('0.4.0', { ...options, isTTY: false }),
    ).resolves.toBe('continue');
    await flushBackgroundInstall();

    expect(refreshUpdateCache).toHaveBeenCalledTimes(1);
    expect(detectInstallSource).not.toHaveBeenCalled();
    expect(promptForInstallChoice).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('npm-global: prompts and spawns npm install -g when automatic updates are disabled', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.promptForInstallChoice.mockResolvedValue('install');
    mockSpawnExit(0);
    const { stdout, options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('exit');
    expect(mocks.promptForInstallChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        installCommand: 'npm install -g @moonshot-ai/kimi-code@0.5.0',
        installSource: 'npm-global',
      }),
    );
    expectNpmSpawn(['install', '-g', '@moonshot-ai/kimi-code@0.5.0'], { stdio: 'inherit' });
    expect(stdout.join('')).toContain('Updated @moonshot-ai/kimi-code to 0.5.0');
  });

  it('refreshes a stale cached target before showing the foreground install prompt', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.6.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.7.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.promptForInstallChoice.mockResolvedValue('install');
    mockSpawnExit(0);
    const { stdout, options } = captureOutput();

    await expect(runUpdatePreflight('0.5.0', options)).resolves.toBe('exit');

    expect(refreshUpdateCache).toHaveBeenCalledTimes(1);
    expect(mocks.promptForInstallChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { version: '0.7.0' },
        installCommand: 'npm install -g @moonshot-ai/kimi-code@0.7.0',
      }),
    );
    expectNpmSpawn(['install', '-g', '@moonshot-ai/kimi-code@0.7.0'], { stdio: 'inherit' });
    expect(stdout.join('')).toContain('Updated @moonshot-ai/kimi-code to 0.7.0');
  });

  it('falls back to the cached foreground prompt target when the refresh hangs', async () => {
    // The refresh budget runs on the injected clock. Bun's fake timers do not
    // take over the process-global `setTimeout`, so hand the preflight a clock
    // whose timer this case fires by hand instead of advancing global time.
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.6.0'));
    // A hung refresh: the promise never settles on its own, but it is resolved
    // at the end of the case so the pending microtask does not keep the test
    // process alive after the assertion.
    let releaseRefresh = (): void => {};
    releasePendingRefresh = () => releaseRefresh();
    mocks.refreshUpdateCache.mockReturnValue(
      new Promise((resolve) => {
        releaseRefresh = () => resolve(cacheWith('0.6.0') as never);
      }),
    );
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.promptForInstallChoice.mockResolvedValue('skip');
    const { options } = captureOutput();

    let fireTimeout = (): void => {};
    let fireTimeoutRegistered = false;
    const noopHandle = { id: 0 } as never;
    const result = runUpdatePreflight('0.5.0', {
      ...options,
      clock: {
        now: () => Date.now(),
        setTimeout: (handler: () => void) => {
          fireTimeout = handler;
          fireTimeoutRegistered = true;
          return noopHandle;
        },
        clearTimeout: () => {},
        setInterval: () => noopHandle,
        clearInterval: () => {},
      },
    });

    // `runUpdatePreflight` is async: let it reach the point where it arms the
    // clock before firing the timeout, otherwise `fireTimeout` is still the
    // empty placeholder.
    for (let i = 0; i < 20 && fireTimeoutRegistered === false; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    fireTimeout();

    await expect(result).resolves.toBe('continue');
    expect(mocks.promptForInstallChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { version: '0.6.0' },
        installCommand: 'npm install -g @moonshot-ai/kimi-code@0.6.0',
      }),
    );
    releaseRefresh();
  });

  it('yarn-global: spawns yarn global add', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('yarn-global');
    mocks.promptForInstallChoice.mockResolvedValue('install');
    mockSpawnExit(0);
    const { options } = captureOutput();
    await runUpdatePreflight('0.4.0', options);
    expectPackageManagerSpawn('yarn', ['global', 'add', '@moonshot-ai/kimi-code@0.5.0'], { stdio: 'inherit' });
  });

  it('bun-global: spawns bun add -g', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('bun-global');
    mocks.promptForInstallChoice.mockResolvedValue('install');
    mockSpawnExit(0);
    const { options } = captureOutput();
    await runUpdatePreflight('0.4.0', options);
    expectPackageManagerSpawn('bun', ['add', '-g', '@moonshot-ai/kimi-code@0.5.0'], { stdio: 'inherit' });
  });

  it('homebrew: prints manual brew upgrade command, does not spawn', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('homebrew');
    const { stdout, options } = captureOutput();
    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(stdout.join('')).toContain('brew upgrade kimi-code');
    expect(stdout.join('')).toContain('Third-party sources may lag behind the official release.');
    expect(stdout.join('')).toContain('https://www.kimi.com/code');
    expect(promptForInstallChoice).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('native: self-spawns the staged downloader sub-command', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('native');
    mocks.promptForInstallChoice.mockResolvedValue('install');
    mockSpawnExit(0);
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const { stdout, options } = captureOutput();
      await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('exit');
      expect(mocks.spawn).toHaveBeenCalledWith(
        process.execPath,
        ['__update_download', '0.5.0', '--manual'],
        expect.objectContaining({ stdio: 'inherit' }),
      );
      expect(stdout.join('')).toContain('Updated @moonshot-ai/kimi-code to 0.5.0');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('native on win32: auto-installs via the staged downloader sub-command', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('native');
    mocks.promptForInstallChoice.mockResolvedValue('install');
    mockSpawnExit(0);
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const { stdout, options } = captureOutput();
      await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('exit');
      expect(mocks.spawn).toHaveBeenCalledWith(
        process.execPath,
        ['__update_download', '0.5.0', '--manual'],
        expect.objectContaining({ stdio: 'inherit' }),
      );
      expect(stdout.join('')).toContain('Updated @moonshot-ai/kimi-code to 0.5.0');
      expect(stdout.join('')).not.toContain('Auto-update is not supported');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('global region: derives install commands and site links from the .ai profile', async () => {
    setEnv('KIMI_CODE_OAUTH_HOST', 'https://auth.kimi.ai');
    resetKimiRegionCache();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      // Native updates self-spawn the staged downloader silently, so the
      // region surface there is the manual install command text.
      expect(installCommandFor('native', '0.5.0', 'win32')).toBe(
        'irm https://code.kimi.ai/kimi-code/install.ps1 | iex',
      );

      mocks.detectInstallSource.mockResolvedValue('homebrew');
      const brew = captureOutput();
      await expect(runUpdatePreflight('0.4.0', brew.options)).resolves.toBe('continue');
      expect(brew.stdout.join('')).toContain('https://www.kimi.ai/code');
      expect(mocks.spawn).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      resetKimiRegionCache();
    }
  });

  it('unsupported: prints fallback npm command', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('unsupported');
    const { stdout, options } = captureOutput();
    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(stdout.join('')).toContain('npm install -g @moonshot-ai/kimi-code@0.5.0');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('declined install continues without spawn', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.promptForInstallChoice.mockResolvedValue('skip');
    const { options } = captureOutput();
    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('warns and continues when spawn exits non-zero, without claiming success', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.promptForInstallChoice.mockResolvedValue('install');
    mockSpawnExit(1);
    const { stdout, stderr, options } = captureOutput();
    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(stderr.join('')).toContain('warning: failed to install');
    // A failed install must never print the "Updated …" success line.
    expect(stdout.join('')).not.toContain('Updated @moonshot-ai/kimi-code');
  });

  it('spawns the resolved absolute path instead of the bare command name', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.promptForInstallChoice.mockResolvedValue('install');
    mocks.resolveCommandPath.mockReturnValue('/usr/local/bin/npm');
    mockSpawnExit(0);
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('exit');

    // win32 resolves the `.cmd` shim name and then quotes the absolute path.
    const resolvedName = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const spawnCmd =
      process.platform === 'win32' ? '"/usr/local/bin/npm"' : '/usr/local/bin/npm';

    expect(mocks.resolveCommandPath).toHaveBeenCalledWith(resolvedName);
    expect(mocks.spawn).toHaveBeenCalledWith(
      spawnCmd,
      ['install', '-g', '@moonshot-ai/kimi-code@0.5.0'],
      { stdio: 'inherit', shell: process.platform === 'win32' ? true : undefined },
    );
  });

  it('warns and continues without spawning when the package manager cannot be resolved', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.promptForInstallChoice.mockResolvedValue('install');
    // Only resolvable inside the cwd (or missing entirely): refuse to run it.
    mocks.resolveCommandPath.mockReturnValue(undefined);
    const { stdout, stderr, options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('warning: failed to install');
    expect(stdout.join('')).not.toContain('Updated @moonshot-ai/kimi-code');
  });

  it('records a background install failure without spawning when the package manager cannot be resolved', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.resolveCommandPath.mockReturnValue(undefined);
    const { stderr, options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    await flushBackgroundInstall();

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(stderr.join('')).toBe('');
    expect(writeUpdateInstallState).toHaveBeenLastCalledWith(expect.objectContaining({
      active: null,
      lastFailure: expect.objectContaining({
        version: '0.5.0',
        attempts: 1,
      }),
      lastSuccess: null,
    }));
  });

  it('starts an automatic update in the background by default', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mockSpawnExit(0);
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(promptForInstallChoice).not.toHaveBeenCalled();
    expectNpmSpawn(['install', '-g', '@moonshot-ai/kimi-code@0.5.0'], { detached: true, stdio: 'ignore' });
    expect(writeUpdateInstallState).toHaveBeenCalledWith(expect.objectContaining({
      active: expect.objectContaining({
        version: '0.5.0',
        source: 'npm-global',
        startedAt: expect.any(String),
      }),
      lastFailure: null,
    }));

    await flushBackgroundInstall();

    expect(writeUpdateInstallState).toHaveBeenLastCalledWith(expect.objectContaining({
      active: null,
      lastFailure: null,
      lastSuccess: expect.objectContaining({
        version: '0.5.0',
        installedAt: expect.any(String),
        notifiedAt: null,
      }),
    }));
  });

  it('win32 background auto-update hides the console window', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mockSpawnExit(0);
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const { options } = captureOutput();
      await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
      expect(mocks.spawn).toHaveBeenCalledWith(
        // Resolved to an absolute path and quoted for the cmd.exe shell.
        '"npm.cmd"',
        ['install', '-g', '@moonshot-ai/kimi-code@0.5.0'],
        { detached: true, stdio: 'ignore', shell: true, windowsHide: true },
      );
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('native: retries the background install when an old active record has no live lock', async () => {
    // Orphaned `active`: older than the spawn grace window and the lock is
    // free (beforeEach default) ⇒ the previous downloader is gone; retry.
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState({
      active: {
        version: '0.5.0',
        source: 'native',
        startedAt: new Date(Date.now() - 120_000).toISOString(),
      },
    }));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('native');
    mockSpawnExit(0);
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      ['__update_download', '0.5.0'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
  });

  it('native: does not re-spawn while the install lock is genuinely held', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState({
      active: {
        version: '0.5.0',
        source: 'native',
        startedAt: new Date(Date.now() - 120_000).toISOString(),
      },
    }));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('native');
    // Lock probe fails ⇒ a downloader is actually in flight; trust it.
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue(null);
    mockSpawnExit(0);
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('native: trusts a fresh active record within the spawn grace window', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState({
      active: {
        version: '0.5.0',
        source: 'native',
        startedAt: new Date().toISOString(),
      },
    }));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('native');
    mockSpawnExit(0);
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(mocks.spawn).not.toHaveBeenCalled();
    // Inside the grace window the lock is never probed — the freshly spawned
    // worker may simply not have reached its self-acquire yet.
    expect(mocks.tryAcquireUpdateInstallLock).not.toHaveBeenCalled();
  });

  it('tracks and logs successful background update installs', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mockSpawnExit(0);
    const { options } = captureOutput();
    const track = jest.fn();
    const logger = captureLogger();

    await expect(runUpdatePreflight('0.4.0', { ...options, track, logger })).resolves.toBe('continue');
    await flushBackgroundInstall();

    expect(track).toHaveBeenCalledWith('update_background_install_started', expect.objectContaining({
      current_version: '0.4.0',
      target_version: '0.5.0',
      source: 'npm-global',
    }));
    expect(track).toHaveBeenCalledWith('update_background_install_succeeded', expect.objectContaining({
      target_version: '0.5.0',
      source: 'npm-global',
    }));
    expect(logger.info).toHaveBeenCalledWith('background update install started', expect.objectContaining({
      currentVersion: '0.4.0',
      targetVersion: '0.5.0',
      source: 'npm-global',
    }));
    expect(logger.info).toHaveBeenCalledWith('background update install succeeded', expect.objectContaining({
      targetVersion: '0.5.0',
      source: 'npm-global',
    }));
  });

  it('defaults to automatic background updates when client preferences cannot be loaded', async () => {
    mocks.loadTuiConfig.mockRejectedValue(new Error('broken tui.toml'));
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mockSpawnExit(0);
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');

    expect(promptForInstallChoice).not.toHaveBeenCalled();
    expectNpmSpawn(['install', '-g', '@moonshot-ai/kimi-code@0.5.0'], { detached: true, stdio: 'ignore' });
  });

  it('starts only one background update when two sessions preflight concurrently', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    let acquired = false;
    mocks.tryAcquireUpdateInstallLock.mockImplementation(async () => {
      if (acquired) return null;
      acquired = true;
      return {
        filePath: '/tmp/kimi-update-install.lock',
        release: jest.fn().mockResolvedValue(undefined),
      };
    });
    mockSpawnExit(0);
    const first = captureOutput();
    const second = captureOutput();

    await expect(Promise.all([
      runUpdatePreflight('0.4.0', first.options),
      runUpdatePreflight('0.4.0', second.options),
    ])).resolves.toEqual(['continue', 'continue']);

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('records the first background failure silently so the next launch can retry', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mockSpawnExit(1);
    const { stderr, options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    await flushBackgroundInstall();

    expect(stderr.join('')).toBe('');
    expect(writeUpdateInstallState).toHaveBeenLastCalledWith(expect.objectContaining({
      active: null,
      lastFailure: expect.objectContaining({
        version: '0.5.0',
        attempts: 1,
        failedAt: expect.any(String),
      }),
      lastSuccess: null,
    }));
  });

  it('tracks and logs background update install failures without writing stderr', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState());
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mockSpawnExit(1);
    const { stderr, options } = captureOutput();
    const track = jest.fn();
    const logger = captureLogger();

    await expect(runUpdatePreflight('0.4.0', { ...options, track, logger })).resolves.toBe('continue');
    await flushBackgroundInstall();

    expect(stderr.join('')).toBe('');
    expect(track).toHaveBeenCalledWith('update_background_install_failed', expect.objectContaining({
      target_version: '0.5.0',
      source: 'npm-global',
      attempts: 1,
    }));
    expect(logger.warn).toHaveBeenCalledWith('background update install failed', expect.objectContaining({
      targetVersion: '0.5.0',
      source: 'npm-global',
      attempts: 1,
    }));
  });

  it('retries automatic update once after the first background failure', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState({
      lastFailure: {
        version: '0.5.0',
        failedAt: '2026-04-23T08:00:00.000Z',
        attempts: 1,
      },
    }));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mockSpawnExit(1);
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    await flushBackgroundInstall();

    expect(promptForInstallChoice).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(writeUpdateInstallState).toHaveBeenLastCalledWith(expect.objectContaining({
      lastFailure: expect.objectContaining({
        version: '0.5.0',
        attempts: 2,
      }),
    }));
  });

  it('prompts for manual foreground install after two background failures', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.readUpdateInstallState.mockResolvedValue(installState({
      lastFailure: {
        version: '0.5.0',
        failedAt: '2026-04-23T08:00:00.000Z',
        attempts: 2,
      },
    }));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.promptForInstallChoice.mockResolvedValue('skip');
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');

    expect(promptForInstallChoice).toHaveBeenCalledWith(expect.objectContaining({
      target: { version: '0.5.0' },
      installSource: 'npm-global',
    }));
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('shows a one-shot notice after a background update succeeds and the new version starts', async () => {
    mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
    mocks.readUpdateInstallState.mockResolvedValue(installState({
      lastSuccess: {
        version: '0.5.0',
        installedAt: '2026-04-23T08:00:00.000Z',
        notifiedAt: null,
      },
    }));
    mocks.refreshUpdateCache.mockResolvedValue(emptyUpdateCache());
    const { stdout, options } = captureOutput();
    const track = jest.fn();
    const logger = captureLogger();

    await expect(runUpdatePreflight('0.5.0', { ...options, track, logger })).resolves.toBe('continue');

    const rendered = stdout.join('');
    expect(rendered).toContain('Kimi Code updated to v0.5.0');
    expect(rendered).toContain(
      'https://moonshotai.github.io/kimi-code/en/release-notes/changelog.html',
    );
    expect(track).toHaveBeenCalledWith('update_success_notice_shown', expect.objectContaining({
      version: '0.5.0',
      inferred_from_active: false,
    }));
    expect(logger.info).toHaveBeenCalledWith('background update success notice shown', expect.objectContaining({
      version: '0.5.0',
      inferredFromActive: false,
    }));
    expect(writeUpdateInstallState).toHaveBeenCalledWith(expect.objectContaining({
      lastSuccess: expect.objectContaining({
        version: '0.5.0',
        notifiedAt: expect.any(String),
      }),
    }));
    expect(detectInstallSource).not.toHaveBeenCalled();
  });

  it('infers a background update success notice when the active install version is now running', async () => {
    mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
    mocks.readUpdateInstallState.mockResolvedValue(installState({
      active: {
        version: '0.5.0',
        source: 'npm-global',
        startedAt: '2026-04-23T08:00:00.000Z',
      },
    }));
    mocks.refreshUpdateCache.mockResolvedValue(emptyUpdateCache());
    const { stdout, options } = captureOutput();

    await expect(runUpdatePreflight('0.5.0', options)).resolves.toBe('continue');

    expect(stdout.join('')).toContain('Kimi Code updated to v0.5.0');
    expect(writeUpdateInstallState).toHaveBeenCalledWith(expect.objectContaining({
      active: null,
      lastFailure: null,
      lastSuccess: expect.objectContaining({
        version: '0.5.0',
        notifiedAt: expect.any(String),
      }),
    }));
  });

  it('tracks update_prompted telemetry', async () => {
    disableAutoInstall();
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockResolvedValue('npm-global');
    mocks.promptForInstallChoice.mockResolvedValue('skip');
    const { options } = captureOutput();
    const track = jest.fn();
    await runUpdatePreflight('0.4.0', { ...options, track });
    expect(track).toHaveBeenCalledWith('update_prompted', expect.objectContaining({
      current_version: '0.4.0',
      target_version: '0.5.0',
      decision: 'prompt-install',
      source: 'npm-global',
    }));
  });

  describe('rollout gating', () => {
    it('hides a cached update whose batch is not yet eligible', async () => {
      const held = cacheWithManifest(heldForEveryone('0.5.0'));
      mocks.readUpdateCache.mockResolvedValue(held);
      mocks.refreshUpdateCache.mockResolvedValue(held);
      mocks.detectInstallSource.mockResolvedValue('npm-global');
      const { stdout, options } = captureOutput();

      await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
      await flushBackgroundInstall();

      expect(stdout.join('')).toBe('');
      expect(promptForInstallChoice).not.toHaveBeenCalled();
      expect(detectInstallSource).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
      // The launch still refreshes the cache in the background so the device
      // flips to eligible purely by time passing.
      expect(refreshUpdateCache).toHaveBeenCalledTimes(1);
      // Both checks of this launch are recorded in the rollout log.
      expect(mocks.appendRolloutDecisionLog).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'startup-cache',
        reason: 'held',
        current: '0.4.0',
        latest: '0.5.0',
        bucket: expect.any(Number),
        delaySeconds: 86_400,
        eligibleAt: expect.any(String),
      }));
      expect(mocks.appendRolloutDecisionLog).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'background-refresh',
        reason: 'held',
      }));
    });

    it('starts the background install once the device batch is eligible', async () => {
      const released = cacheWithManifest(releasedForEveryone('0.5.0'));
      mocks.readUpdateCache.mockResolvedValue(released);
      mocks.refreshUpdateCache.mockResolvedValue(released);
      mocks.detectInstallSource.mockResolvedValue('npm-global');
      mockSpawnExit(0);
      const { options } = captureOutput();
      const track = jest.fn();

      await expect(runUpdatePreflight('0.4.0', { ...options, track })).resolves.toBe('continue');
      await flushBackgroundInstall();

      expectNpmSpawn(['install', '-g', '@moonshot-ai/kimi-code@0.5.0'], { detached: true, stdio: 'ignore' });
      expect(track).toHaveBeenCalledWith('update_background_install_started', expect.objectContaining({
        target_version: '0.5.0',
        rollout_bucket: expect.any(Number),
        rollout_delay_seconds: 0,
        rollout_from_manifest: true,
      }));
      expect(mocks.appendRolloutDecisionLog).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'startup-cache',
        reason: 'eligible',
        target: '0.5.0',
      }));
    });

    it('prompts with rollout telemetry when eligible and auto-install is disabled', async () => {
      disableAutoInstall();
      const released = cacheWithManifest(releasedForEveryone('0.5.0'));
      mocks.readUpdateCache.mockResolvedValue(released);
      mocks.refreshUpdateCache.mockResolvedValue(released);
      mocks.detectInstallSource.mockResolvedValue('npm-global');
      mocks.promptForInstallChoice.mockResolvedValue('skip');
      const { options } = captureOutput();
      const track = jest.fn();

      await expect(runUpdatePreflight('0.4.0', { ...options, track })).resolves.toBe('continue');

      expect(mocks.promptForInstallChoice).toHaveBeenCalledWith(
        expect.objectContaining({ target: { version: '0.5.0' } }),
      );
      expect(track).toHaveBeenCalledWith('update_prompted', expect.objectContaining({
        target_version: '0.5.0',
        rollout_bucket: expect.any(Number),
        rollout_delay_seconds: 0,
        rollout_from_manifest: true,
      }));
    });

    it('uses the refreshed manifest for rollout telemetry when the prompt target changes', async () => {
      disableAutoInstall();
      const cached = cacheWithManifest(manifestFor('0.6.0', {
        publishedAt: '2020-01-01T00:00:00.000Z',
        rollout: [{ percent: 100, delaySeconds: 0 }],
      }));
      const refreshed = cacheWithManifest(manifestFor('0.7.0', {
        publishedAt: '2020-01-01T00:00:00.000Z',
        rollout: [{ percent: 100, delaySeconds: 43_200 }],
      }));
      mocks.readUpdateCache.mockResolvedValue(cached);
      mocks.refreshUpdateCache.mockResolvedValue(refreshed);
      mocks.detectInstallSource.mockResolvedValue('npm-global');
      mocks.promptForInstallChoice.mockResolvedValue('skip');
      const { options } = captureOutput();
      const track = jest.fn();

      await expect(runUpdatePreflight('0.5.0', { ...options, track })).resolves.toBe('continue');

      expect(mocks.promptForInstallChoice).toHaveBeenCalledWith(
        expect.objectContaining({ target: { version: '0.7.0' } }),
      );
      expect(track).toHaveBeenCalledWith('update_prompted', expect.objectContaining({
        target_version: '0.7.0',
        rollout_bucket: expect.any(Number),
        rollout_delay_seconds: 43_200,
        rollout_from_manifest: true,
      }));
    });

    it('suppresses the manual-command notice while a homebrew device batch is held', async () => {
      const held = cacheWithManifest(heldForEveryone('0.5.0'));
      mocks.readUpdateCache.mockResolvedValue(held);
      mocks.refreshUpdateCache.mockResolvedValue(held);
      mocks.detectInstallSource.mockResolvedValue('homebrew');
      const { stdout, options } = captureOutput();

      await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
      await flushBackgroundInstall();

      expect(stdout.join('')).toBe('');
      expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('does not start a fresh-check background install while the refreshed manifest is held', async () => {
      mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
      mocks.refreshUpdateCache.mockResolvedValue(cacheWithManifest(heldForEveryone('0.5.0')));
      mocks.detectInstallSource.mockResolvedValue('npm-global');
      const { options } = captureOutput();

      await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
      await flushBackgroundInstall();

      expect(refreshUpdateCache).toHaveBeenCalledTimes(1);
      expect(detectInstallSource).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('stays silent when the user-visible refresh reveals a held newer version', async () => {
      disableAutoInstall();
      mocks.readUpdateCache.mockResolvedValue(cacheWithManifest(releasedForEveryone('0.6.0')));
      mocks.refreshUpdateCache.mockResolvedValue(cacheWithManifest(heldForEveryone('0.7.0')));
      mocks.detectInstallSource.mockResolvedValue('npm-global');
      const { stdout, options } = captureOutput();

      await expect(runUpdatePreflight('0.5.0', options)).resolves.toBe('continue');

      expect(stdout.join('')).toBe('');
      expect(promptForInstallChoice).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('KIMI_CODE_EXPERIMENTAL_FLAG bypasses the rollout: held devices still update', async () => {
      setEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '1');
      const held = cacheWithManifest(heldForEveryone('0.5.0'));
      mocks.readUpdateCache.mockResolvedValue(held);
      mocks.refreshUpdateCache.mockResolvedValue(held);
      mocks.detectInstallSource.mockResolvedValue('npm-global');
      mockSpawnExit(0);
      const { options } = captureOutput();
      const track = jest.fn();

      await expect(runUpdatePreflight('0.4.0', { ...options, track })).resolves.toBe('continue');
      await flushBackgroundInstall();

      expectNpmSpawn(['install', '-g', '@moonshot-ai/kimi-code@0.5.0'], { detached: true, stdio: 'ignore' });
      expect(track).toHaveBeenCalledWith('update_background_install_started', expect.objectContaining({
        target_version: '0.5.0',
        rollout_bypassed: true,
      }));
      expect(mocks.appendRolloutDecisionLog).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'startup-cache',
        reason: 'experimental',
        target: '0.5.0',
      }));
    });

    it('KIMI_CODE_NO_AUTO_UPDATE still wins over the experimental flag', async () => {
      setEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '1');
      setEnv('KIMI_CODE_NO_AUTO_UPDATE', '1');
      mocks.readUpdateCache.mockResolvedValue(cacheWithManifest(releasedForEveryone('0.5.0')));
      const { options } = captureOutput();

      await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');

      expect(readUpdateCache).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('treats any plan older than 24h as fully rolled out', async () => {
      disableAutoInstall();
      const staleRollout = manifestFor('0.5.0', {
        publishedAt: new Date(Date.now() - 25 * 3_600 * 1_000).toISOString(),
        rollout: [
          { percent: 30, delaySeconds: 0 },
          { percent: 30, delaySeconds: 43_200 },
          { percent: 40, delaySeconds: 86_400 },
        ],
      });
      mocks.readUpdateCache.mockResolvedValue(cacheWithManifest(staleRollout));
      mocks.refreshUpdateCache.mockResolvedValue(cacheWithManifest(staleRollout));
      mocks.detectInstallSource.mockResolvedValue('npm-global');
      mocks.promptForInstallChoice.mockResolvedValue('skip');
      const { options } = captureOutput();

      await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');

      expect(mocks.promptForInstallChoice).toHaveBeenCalledWith(
        expect.objectContaining({ target: { version: '0.5.0' } }),
      );
    });
  });
});
