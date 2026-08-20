import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  createKimiHarnessV2,
  flushDiagnosticLogsSync,
  log,
  setLocale as setAgentCoreLocale,
  type KimiHarness,
  type KimiHarnessOptions,
  type TelemetryClient,
} from '@moonshot-ai/kimi-code-sdk';
import {
  setCrashPhase,
  setTelemetryContext,
  shutdownTelemetry,
  track,
  withTelemetryContext,
} from '@moonshot-ai/kimi-telemetry';

import { CLI_SHUTDOWN_TIMEOUT_MS, CLI_UI_MODE } from '#/constant/app';
import { setLocale, t } from '#/i18n';
import { detectPendingMigration } from '#/migration/index';
import type { TuiConfig } from '#/tui/config';
import { loadTuiConfig, TuiConfigParseError } from '#/tui/config';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { currentTheme, getColorPalette } from '#/tui/theme';
import { resolveTuiVariant } from '#/tui2/env';
import { resolveCommandPath } from '#/utils/process/resolve-command';
import { startupTrace } from '#/utils/startup-trace';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';
import { restoreTerminalModes } from '#/utils/terminal-restore';

import { resolveAgentProfileSelection } from './agent-selection';
import type { CLIOptions } from './options';
import { createCliTelemetryBootstrap, initializeCliTelemetry } from './telemetry';
import { createKimiCodeHostIdentity } from './version';

/**
 * The TUI surface the CLI shell needs for telemetry + exit handling. Both
 * stacks implement it structurally: the v1 pi-tui KimiTUI and the v2
 * opentui host. The shell never reaches into stack-specific internals.
 */
interface TuiSurface {
  getCurrentSessionId(): string;
  hasSessionContent(): boolean;
  readonly uiMode: string;
  exitOpenUrl: string | undefined;
  exitForegroundTask: ((exitCode: number) => Promise<void>) | undefined;
}

export async function runShell(
  opts: CLIOptions,
  version: string,
  runOptions: { readonly migrateOnly?: boolean } = {},
): Promise<void> {
  const startedAt = Date.now();
  const configStartedAt = startedAt;

  // Resolve which TUI stack serves this session. v2 (opentui + SolidJS) is
  // opt-in via KIMI_TUI=v2; unset/v1 keeps the pi-tui default. The v2 entry
  // currently re-exports the v1 surface, so this is behaviour-preserving —
  // it just wires the routing so the rollout switch is real.
  const tuiVariant = resolveTuiVariant();
  const tuiEntry = await (tuiVariant === 'v2'
    ? import('#/tui2/index')
    : import('#/tui/index'));
  const KimiTUI = tuiEntry.KimiTUI;
  let tuiConfig: TuiConfig;
  let configWarning: string | undefined;
  try {
    tuiConfig = await loadTuiConfig();
  } catch (error) {
    if (!(error instanceof TuiConfigParseError)) throw error;
    tuiConfig = error.fallback;
    configWarning = error.message;
  }

  // Initialise the global Theme singleton before pi-tui grabs stdin.
  const palette = await getColorPalette(tuiConfig.theme);
  currentTheme.setPalette(palette);

  const workDir = process.cwd();
  const telemetryBootstrap = createCliTelemetryBootstrap();
  const telemetryClient: TelemetryClient = {
    track,
    withContext: withTelemetryContext,
    setContext: setTelemetryContext,
  };
  const harnessOptions: KimiHarnessOptions = {
    homeDir: telemetryBootstrap.homeDir,
    identity: createKimiCodeHostIdentity(version),
    skillDirs: opts.skillsDirs,
    telemetry: telemetryClient,
    onOAuthRefresh: (outcome) => {
      if (outcome.success) {
        track('oauth_refresh', { outcome: 'success' });
        return;
      }
      track('oauth_refresh', {
        outcome: 'error',
        reason: outcome.reason,
      });
    },
    sessionStartedProperties: { yolo: opts.yolo, auto: opts.auto, plan: opts.plan, afk: false },
  };
  // The agent-core-v2 route is the only engine (same engine as `kimi -p`):
  // the harness is the SDK's v2-backed client, so the whole TUI runs on the
  // agent-core-v2 engine.
  const engineV2 = true;
  const harness = createKimiHarnessV2(harnessOptions);
  startupTrace('harness:created');
  log.info('kimi-code starting', {
    version,
    uiMode: CLI_UI_MODE,
    tuiVariant,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    workDir,
  });

  await harness.ensureConfigFile();
  const migrationPlan = await detectPendingMigration({
    sourceHome: join(homedir(), '.kimi'),
    targetHome: harness.homeDir,
    ignoreMarker: runOptions.migrateOnly,
  });
  if (runOptions.migrateOnly === true && migrationPlan === null) {
    process.stdout.write(t('tui.statusMessages.shellNothingToMigrate') + '\n');
    await harness.close();
    return;
  }
  const config = await harness.getConfig();
  startupTrace('config:loaded');
  // Config diagnostics (deprecated keys, invalid sections, ...) are surfaced
  // by the TUI itself at `finishStartup` via `showConfigWarningsIfAny` —
  // folded into the dim startup notice they were too easy to miss.
  const configMs = Date.now() - configStartedAt;
  // Propagate locale from tui.toml to i18n engine and agent-core
  setLocale(tuiConfig.locale);
  setAgentCoreLocale(tuiConfig.locale);

  // Resolve --agent/--agent-file once for the startup session; validateOptions
  // has already rejected them alongside --session/--continue.
  const agentProfile = await resolveAgentProfileSelection(opts, workDir);
  const startupInput: ConstructorParameters<typeof KimiTUI>[1] = {
    cliOptions: opts,
    agentProfile,
    additionalDirs: opts.addDirs?.length ? opts.addDirs : undefined,
    tuiConfig,
    version,
    workDir,
    startupNotice: configWarning,
    migrationPlan,
    migrateOnly: runOptions.migrateOnly,
    engineV2,
  };
  const tui = new KimiTUI(harness, startupInput);

  initializeCliTelemetry({
    harness,
    bootstrap: telemetryBootstrap,
    config,
    version,
    uiMode: CLI_UI_MODE,
  });
  setCrashPhase('runtime');

  const trackLifecycleForSession = (
    sessionId: string,
    event: string,
    properties?: Parameters<KimiHarness['track']>[1],
  ) => {
    if (sessionId.length === 0) {
      harness.track(event, properties);
      return;
    }
    withTelemetryContext({ sessionId }).track(event, properties);
  };
  // The exit/telemetry surface both TUI stacks share. v1 keeps the KimiTUI
  // instance; the v2 runner swaps this to the opentui host once it exists
  // (see the KIMI_TUI=v2 branch below).
  let tuiSurface: TuiSurface = tui;
  const trackLifecycle = (event: string, props?: Parameters<KimiHarness['track']>[1]) => {
    trackLifecycleForSession(tuiSurface.getCurrentSessionId(), event, props);
  };

  let savedStty: string | undefined;
  // stty runs before tui.start() reaches the workspace trust gate, so it must
  // never be resolved by name through PATH: a `.` or empty PATH segment would
  // let an untrusted checkout plant an `stty` executable and run it pre-trust.
  // resolveCommandPath returns an absolute path and refuses hits inside the
  // cwd; when it cannot resolve stty, skip the save/restore entirely — it is
  // best-effort terminal hygiene, not required for startup.
  // stty is also POSIX-only, so skip it on Windows instead of relying on the
  // catch below.
  const sttyPath = process.platform === 'win32' ? undefined : resolveCommandPath('stty');
  if (sttyPath !== undefined) {
    try {
      // stty operates on the terminal behind stdin, so stdin must be the TTY —
      // piping /dev/null (ignore) makes stty fail with "not a tty".
      const saved = execFileSync(sttyPath, ['-g'], {
        encoding: 'utf8',
        stdio: ['inherit', 'pipe', 'ignore'],
      });
      savedStty = saved.trim();
      execFileSync(sttyPath, ['-ixon'], { stdio: ['inherit', 'ignore', 'ignore'] });
    } catch {
      /* ignore */
    }
  }
  const restoreStty = (): void => {
    if (sttyPath === undefined || savedStty === undefined) return;
    const args = savedStty.split(/\s+/).filter((arg) => arg.length > 0);
    if (args.length === 0) return;
    spawnSync(sttyPath, args, { stdio: ['inherit', 'ignore', 'ignore'] });
  };

  // If we crash without going through KimiTUI.stop(), the terminal is left in
  // raw mode with a hidden cursor and XON/XOFF flow control disabled. Restore
  // both before exiting so the user's shell is usable afterwards.
  const emergencyExit = (exitCode: number): void => {
    // The crash log above is only enqueued into the async sink; flush it
    // synchronously or the `process.exit()` below would drop the one line that
    // explains why we crashed. Best-effort: an exit path must never throw.
    try {
      flushDiagnosticLogsSync();
    } catch {
      /* ignore */
    }
    restoreTerminalModes();
    restoreStty();
    process.exit(exitCode);
  };
  const onUncaughtException = (error: unknown): void => {
    try {
      log.error('uncaughtException, restoring terminal and exiting', { error: String(error) });
    } catch {
      /* ignore */
    }
    emergencyExit(1);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    try {
      log.error('unhandledRejection, restoring terminal and exiting', { reason: String(reason) });
    } catch {
      /* ignore */
    }
    emergencyExit(1);
  };
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  // Remove the crash handlers once the TUI exits cleanly so repeated runShell()
  // calls in the same process (e.g. tests) don't accumulate process listeners.
  const removeCrashHandlers = (): void => {
    process.off('uncaughtException', onUncaughtException);
    process.off('unhandledRejection', onUnhandledRejection);
  };

  const exitHandler = async (exitCode = 0) => {
    const sessionId = tuiSurface.getCurrentSessionId();
    const hasContent = tuiSurface.hasSessionContent();
    setCrashPhase('shutdown');
    trackLifecycle('exit', { duration_ms: Date.now() - startedAt, tui_mode: tuiSurface.uiMode });
    await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
    const gutter = ' '.repeat(CHROME_GUTTER);
    process.stdout.write(`${gutter}${t('tui.statusMessages.shellBye')}\n`);
    const hints: string[] = [];
    if (sessionId !== '' && hasContent) {
      hints.push(`${gutter}${t('tui.statusMessages.shellResumeHint', { sessionId })}`);
    }
    if (tuiSurface.exitOpenUrl !== undefined) {
      hints.push(
        `${gutter}${t('tui.statusMessages.webOpenUrl', { url: toTerminalHyperlink(tuiSurface.exitOpenUrl, tuiSurface.exitOpenUrl) })}`,
      );
    }
    if (hints.length > 0) {
      process.stderr.write(`\n${hints.join('\n')}\n`);
    }
    removeCrashHandlers();
    restoreStty();
    if (tuiSurface.exitForegroundTask !== undefined) {
      // `/web` starting a new server: the TUI has shut down cleanly; hand the
      // terminal to the foreground server instead of exiting. The task runs
      // until the server stops (Ctrl+C), then this process exits.
      await tuiSurface.exitForegroundTask(exitCode);
      return;
    }
    process.exit(exitCode);
  };
  tui.onExit = exitHandler;
  if (tuiVariant === 'v2') {
    // The opentui runner owns the renderer + host lifecycle and blocks until
    // the renderer is destroyed (in a real terminal: on exit). The shared
    // crash/stty/telemetry plumbing above stays active; exit routes through
    // exitHandler with the opentui host swapped into tuiSurface. Startup-perf
    // telemetry is not recorded on this experimental path (the runner is
    // already inside its own render loop by the time startup settles).
    try {
      const { runKimiTui2 } = await import('#/tui2/run');
      await runKimiTui2({
        harness,
        startupInput,
        onExit: async (host, exitCode = 0) => {
          tuiSurface = host;
          await exitHandler(exitCode);
        },
      });
    } catch (error) {
      removeCrashHandlers();
      setCrashPhase('shutdown');
      trackLifecycle('exit', { duration_ms: Date.now() - startedAt, tui_mode: tuiSurface.uiMode });
      await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
      await harness.close();
      throw error;
    }
    return;
  }
  try {
    const initStartedAt = Date.now();
    startupTrace('tui.start:begin');
    await tui.start();
    startupTrace('tui.start:end');
    const initMs = Date.now() - initStartedAt;
    const startupSessionId = tui.getCurrentSessionId();
    const mcpMs = await tui.getStartupMcpMs();
    trackLifecycleForSession(startupSessionId, 'startup_perf', {
      duration_ms: Date.now() - startedAt,
      config_ms: configMs,
      init_ms: initMs,
      mcp_ms: mcpMs,
      tui_mode: tui.uiMode,
    });
  } catch (error) {
    removeCrashHandlers();
    setCrashPhase('shutdown');
    trackLifecycle('exit', { duration_ms: Date.now() - startedAt, tui_mode: tuiSurface.uiMode });
    await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
    await harness.close();
    throw error;
  }
}
