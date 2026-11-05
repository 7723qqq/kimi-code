import { spawn } from 'node:child_process';

import { log } from '@moonshot-ai/kimi-code-sdk/logging';
import type { TelemetryProperties } from '@moonshot-ai/kimi-telemetry';

import { CLI_COMMAND_NAME } from '#/constant/app';
import {
  kimiCodeOfficialInstallUrl,
  nativeInstallCommandUnix,
  nativeInstallCommandWin,
} from '#/constant/region-urls';
import { t } from '#/i18n';
import { resolveCommandPath } from '#/utils/process/resolve-command';
import { SYSTEM_RENDER_CLOCK, type RenderClock } from '#/utils/render-clock';

import {
  isAutoUpdateDisabledByEnv,
  shouldAutoInstallUpdates,
  type UpdateLogger,
} from './auto-install';
import { readUpdateCache } from './cache';
import { tryAcquireUpdateInstallLock } from './install-lock';
import {
  emptyUpdateInstallState,
  readUpdateInstallState,
  writeUpdateInstallState,
} from './install-state';
import {
  CHANGELOG_URL,
  promptForInstallChoice,
  type InstallPromptChoiceValue,
  type InstallPromptOptions,
} from './prompt';
import { refreshUpdateCache } from './refresh';
import {
  appendRolloutDecisionLog,
  decidePassiveUpdate,
  isRolloutBypassedByExperimentalEnv,
  resolveUpdateDeviceId,
  rolloutBucket,
  rolloutDelayForBucket,
  type PassiveUpdateDecision,
} from './rollout';
import { formatUpdateChannelWarning, resolveUpdateChannel, updateChannelForVersion } from './select';
import { detectInstallSource } from './source';
import {
  NPM_PACKAGE_NAME,
  type ActionableUpdatePlan,
  type ChannelSelection,
  type InstallSource,
  type UpdateChannel,
  type UpdateFeed,
  type UpdateInstallState,
  type UpdateManifest,
  type UpdatePlan,
  type UpdatePreflightResult,
  type UpdatePromptAction,
  type UpdateTarget,
  type UpgradePlan,
} from './types';

export type { UpdatePreflightResult } from './types';

export interface RunUpdatePreflightOptions {
  readonly stdout?: { write(chunk: string): boolean };
  readonly stderr?: { write(chunk: string): boolean };
  readonly isTTY?: boolean;
  readonly track?: (event: string, properties?: TelemetryProperties) => void;
  readonly logger?: UpdateLogger;
  /** Spawn implementation for install children; defaults to `node:child_process`. */
  readonly spawn?: typeof spawn;
  /** Clock for the user-visible refresh budget; defaults to the system clock. */
  readonly clock?: RenderClock;
}

const AUTO_INSTALL_FAILURE_PROMPT_THRESHOLD = 2;
const AUTO_INSTALL_ACTIVE_TTL_MS = 6 * 60 * 60 * 1000;
const USER_VISIBLE_UPDATE_REFRESH_TIMEOUT_MS = 1_000;

/** Everything the internal update paths need beyond their explicit arguments. */
interface PreflightDeps {
  readonly spawn: typeof spawn;
  readonly clock: RenderClock;
  readonly track: RunUpdatePreflightOptions['track'];
  readonly logger: UpdateLogger;
}

function withCmdSuffix(base: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${base}.cmd` : base;
}

function bunCommand(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'bun.exe' : 'bun';
}

export function installCommandFor(
  source: InstallSource,
  version: string,
  platform: NodeJS.Platform,
  channel: UpdateChannel = 'stable',
): string {
  if (source === 'native' && channel === 'canary') {
    return platform === 'win32'
      ? `$env:KIMI_CODE_UPDATE_CHANNEL='canary'; ${CLI_COMMAND_NAME} update --yes`
      : `KIMI_CODE_UPDATE_CHANNEL=canary ${CLI_COMMAND_NAME} update --yes`;
  }
  switch (source) {
    case 'npm-global':
      return `npm install -g ${NPM_PACKAGE_NAME}@${version}`;
    case 'yarn-global':
      return `yarn global add ${NPM_PACKAGE_NAME}@${version}`;
    case 'bun-global':
      return `bun add -g ${NPM_PACKAGE_NAME}@${version}`;
    case 'homebrew':
      return 'brew upgrade kimi-code';
    case 'native':
      return platform === 'win32' ? nativeInstallCommandWin() : nativeInstallCommandUnix();
    case 'unsupported':
      return `npm install -g ${NPM_PACKAGE_NAME}@${version}`;
  }
}

export function canAutoInstall(source: InstallSource, _platform: NodeJS.Platform): boolean {
  switch (source) {
    case 'npm-global':
    case 'yarn-global':
    case 'bun-global':
      return true;
    case 'homebrew':
      // Homebrew upgrade may mutate other dependents and the formula can lag
      // behind the CDN release — prompt the user to run `brew upgrade` manually.
      return false;
    case 'native':
      // Staged-swap self update works on every platform (win32 included).
      return true;
    case 'unsupported':
      return false;
  }
}

interface SpawnCommand {
  readonly cmd: string;
  readonly args: readonly string[];
}

export function spawnForSource(
  source: InstallSource,
  version: string,
  platform: NodeJS.Platform,
): SpawnCommand {
  switch (source) {
    case 'npm-global':
      return {
        cmd: withCmdSuffix('npm', platform),
        args: ['install', '-g', `${NPM_PACKAGE_NAME}@${version}`],
      };
    case 'yarn-global':
      return {
        cmd: withCmdSuffix('yarn', platform),
        args: ['global', 'add', `${NPM_PACKAGE_NAME}@${version}`],
      };
    case 'bun-global':
      return { cmd: bunCommand(platform), args: ['add', '-g', `${NPM_PACKAGE_NAME}@${version}`] };
    case 'homebrew':
      return { cmd: 'brew', args: ['upgrade', 'kimi-code'] };
    case 'native':
      // Native installs self-spawn the hidden downloader sub-command, which
      // stages the binary next to the exe (verified against the release
      // manifest's sha256); the swap happens on the next startup. This
      // replaces the old `curl|bash` / `irm|iex` re-install dance — no shell,
      // no pipeline exit-status loss, no PowerShell dependency on Windows.
      return { cmd: process.execPath, args: ['__update_download', version] };
    case 'unsupported':
      throw new Error('unsupported install source cannot be auto-installed');
  }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve a spawn target from `spawnForSource` to an absolute executable path
 * via PATH, refusing hits inside the current working directory: the update
 * preflight runs before the workspace trust gate, so a package-manager binary
 * planted in an untrusted workspace must never be executed. On win32 the
 * resolved path is quoted because the spawn goes through cmd.exe (shell:
 * true) and paths like `C:\Program Files\...` would otherwise split. Returns
 * undefined when the command cannot be safely resolved.
 */
function resolveSpawnCommand(cmd: string, platform: NodeJS.Platform): string | undefined {
  const resolved = resolveCommandPath(cmd);
  if (resolved === undefined) return undefined;
  return platform === 'win32' ? `"${resolved}"` : resolved;
}

/**
 * Resolve the spawn target for an install. Package managers are resolved from
 * `PATH` to an absolute executable via `resolveSpawnCommand` (workspace-trust
 * safety, see above). The native self-spawn instead uses `process.execPath`
 * verbatim — already absolute — and never goes through a shell. Returns the
 * shell flag alongside, since Windows package-manager shims (.cmd) still
 * need one.
 *
 * The native downloader is told which channel and intent the install has, so
 * a canary stage is never adopted by a stable client and a channel switch is
 * only ever applied after the user chose it.
 */
function resolveInstallSpawn(
  source: InstallSource,
  plan: ActionableUpdatePlan,
  platform: NodeJS.Platform,
  options?: { readonly manual?: boolean },
):
  | { readonly resolvedCmd: string; readonly args: readonly string[]; readonly shell: boolean }
  | undefined {
  const { cmd, args } = spawnForSource(source, plan.target.version, platform);
  if (source === 'native') {
    // A user-confirmed install marks the stage as manual so the startup swap
    // applies it even when automatic updates are opted out via env.
    const nativeArgs = [...args];
    if (plan.target.channel === 'canary') nativeArgs.push('--channel', 'canary');
    if (options?.manual === true) nativeArgs.push('--manual');
    if (plan.kind === 'switch-channel') nativeArgs.push('--switch-channel');
    return { resolvedCmd: cmd, args: nativeArgs, shell: false };
  }
  const resolvedCmd = resolveSpawnCommand(cmd, platform);
  if (resolvedCmd === undefined) return undefined;
  return { resolvedCmd, args, shell: platform === 'win32' };
}

// Built per call: the official-installer URL follows the current region.
function thirdPartySourceNote(): string {
  return (
    '\n' +
    t('tui.statusMessages.updateManualThirdPartyNote', { url: kimiCodeOfficialInstallUrl() }) +
    '\n'
  );
}

export function renderManualUpdateMessage(
  currentVersion: string,
  plan: ActionableUpdatePlan,
  source: InstallSource,
  installCommand: string,
): string {
  let sourceDesc: string;
  switch (source) {
    case 'npm-global':
    case 'yarn-global':
    case 'bun-global':
      sourceDesc = source;
      break;
    case 'homebrew':
      sourceDesc = 'homebrew';
      break;
    case 'native':
      sourceDesc = t('tui.statusMessages.updateSourceNative');
      break;
    case 'unsupported':
      sourceDesc = t('tui.statusMessages.updateUnsupportedManager');
      break;
  }
  const target = plan.target;
  if (plan.kind === 'switch-channel') {
    return (
      t('tui.statusMessages.updateManualSwitchRequested', {
        current: currentVersion,
        version: target.version,
      }) +
      '\n' +
      t('tui.statusMessages.updateManualSwitchChannel', {
        from: plan.sourceChannel,
        to: target.channel,
      }) +
      '\n' +
      t('tui.statusMessages.updateManualDetectedSource', { source: sourceDesc }) +
      '\n' +
      t('tui.statusMessages.updateManualRunCommand', { command: installCommand }) +
      '\n' +
      (source === 'homebrew' ? thirdPartySourceNote() : '')
    );
  }
  return (
    t('tui.statusMessages.updateManualNewerAvailable', {
      package: NPM_PACKAGE_NAME,
      current: currentVersion,
      target: target.version,
    }) +
    '\n' +
    t('tui.statusMessages.updateManualDetectedSource', { source: sourceDesc }) +
    '\n' +
    t('tui.statusMessages.updateManualRunCommand', { command: installCommand }) +
    '\n' +
    (source === 'homebrew' ? thirdPartySourceNote() : '')
  );
}

export function renderInstallSuccessMessage(plan: ActionableUpdatePlan): string {
  if (plan.kind === 'switch-channel') {
    return (
      t('tui.statusMessages.updateInstallSwitched', {
        package: NPM_PACKAGE_NAME,
        channel: plan.target.channel,
        version: plan.target.version,
      }) + '\n'
    );
  }
  return (
    t('tui.statusMessages.updateInstallSuccess', {
      package: NPM_PACKAGE_NAME,
      version: plan.target.version,
    }) + '\n'
  );
}

function renderBackgroundInstallSuccessNotice(version: string): string {
  const displayVersion = version.startsWith('v') ? version : `v${version}`;
  return (
    t('tui.statusMessages.updateBackgroundSuccessNotice', {
      version: displayVersion,
      url: CHANGELOG_URL,
    }) + '\n'
  );
}

/** Resolved once per preflight: which feed to read and whether rollout gating applies. */
interface UpdateCheckContext {
  readonly selection: ChannelSelection;
  readonly experimental: boolean;
}

function refreshInBackground(check: UpdateCheckContext): void {
  void refreshUpdateCache({ channel: check.selection.channel }).catch(() => {});
}

/** Telemetry properties describing where this device sits in the rollout. */
interface RolloutTelemetry {
  readonly rollout_bucket: number;
  readonly rollout_delay_seconds: number;
  readonly rollout_from_manifest: boolean;
  readonly rollout_bypassed: boolean;
}

function rolloutTelemetryFor(
  deviceId: string,
  plan: ActionableUpdatePlan,
  manifest: UpdateManifest | null,
  experimental: boolean,
): RolloutTelemetry {
  const bucket = rolloutBucket(deviceId, plan.target.version);
  return {
    rollout_bucket: bucket,
    rollout_delay_seconds:
      manifest === null || experimental || plan.kind === 'switch-channel'
        ? 0
        : rolloutDelayForBucket(manifest.rollout, bucket),
    rollout_from_manifest: manifest !== null,
    rollout_bypassed: experimental,
  };
}

type RolloutCheckPhase = 'startup-cache' | 'background-refresh' | 'prompt-refresh';

/** Record which case a passive version check hit in `updates/rollout.log`. */
function logRolloutDecision(
  phase: RolloutCheckPhase,
  check: UpdateCheckContext,
  currentVersion: string,
  feed: UpdateFeed,
  decision: PassiveUpdateDecision,
): void {
  void appendRolloutDecisionLog({
    ts: nowIso(),
    phase,
    channel: feed.channel,
    invalidChannel: check.selection.origin === 'invalid' ? check.selection.raw : undefined,
    reason: decision.reason,
    current: currentVersion,
    latest: feed.latest,
    target: decision.plan.kind === 'none' ? null : decision.plan.target.version,
    manifestPresent: feed.manifest !== null,
    publishedAt: feed.manifest?.publishedAt ?? null,
    bucket: decision.bucket,
    delaySeconds: decision.delaySeconds,
    eligibleAt: decision.eligibleAt,
  });
}

function refreshAndMaybeInstallInBackground(
  currentVersion: string,
  deviceId: string,
  check: UpdateCheckContext,
  isInteractive: boolean,
  installState: UpdateInstallState,
  sourceHint: InstallSource | null,
  platform: NodeJS.Platform,
  deps: PreflightDeps,
): void {
  void (async () => {
    const refreshed = await refreshUpdateCache({ channel: check.selection.channel });
    if (!isInteractive) return;
    const decision = decidePassiveUpdate(
      currentVersion,
      refreshed,
      deviceId,
      new Date(),
      check.experimental,
    );
    logRolloutDecision('background-refresh', check, currentVersion, refreshed, decision);
    const plan = decision.plan;
    if (plan.kind !== 'upgrade') return;
    const source = sourceHint ?? (await detectInstallSource().catch(() => 'unsupported' as const));
    await tryStartAutomaticBackgroundInstall(
      installState,
      currentVersion,
      plan,
      source,
      platform,
      deps,
      rolloutTelemetryFor(deviceId, plan, refreshed.manifest, check.experimental),
    );
  })().catch(() => {});
}

interface UserVisibleUpdate {
  readonly decision: PassiveUpdateDecision;
  readonly manifest: UpdateManifest | null;
}

async function refreshUserVisibleUpdate(
  currentVersion: string,
  deviceId: string,
  check: UpdateCheckContext,
  fallbackDecision: PassiveUpdateDecision,
  fallbackManifest: UpdateManifest | null,
  clock: RenderClock,
): Promise<UserVisibleUpdate> {
  let timeout: ReturnType<RenderClock['setTimeout']> | undefined;
  const fallback: UserVisibleUpdate = {
    decision: fallbackDecision,
    manifest: fallbackManifest,
  };
  try {
    const refresh = refreshUpdateCache({ channel: check.selection.channel })
      .then((refreshed) => {
        const decision = decidePassiveUpdate(
          currentVersion,
          refreshed,
          deviceId,
          new Date(),
          check.experimental,
        );
        logRolloutDecision('prompt-refresh', check, currentVersion, refreshed, decision);
        return { decision, manifest: refreshed.manifest };
      })
      .catch(() => fallback);
    const timeoutFallback = new Promise<UserVisibleUpdate>((resolve) => {
      timeout = clock.setTimeout(() => {
        resolve(fallback);
      }, USER_VISIBLE_UPDATE_REFRESH_TIMEOUT_MS);
    });
    return await Promise.race([refresh, timeoutFallback]);
  } catch {
    return fallback;
  } finally {
    if (timeout !== undefined) {
      clock.clearTimeout(timeout);
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function failureAttemptsFor(state: UpdateInstallState, target: UpdateTarget): number {
  return state.lastFailure?.version === target.version ? state.lastFailure.attempts : 0;
}

function hasFreshActiveInstall(state: UpdateInstallState, target: UpdateTarget): boolean {
  const active = state.active;
  if (active === null || active.version !== target.version) return false;
  const startedAt = Date.parse(active.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  return Date.now() - startedAt < AUTO_INSTALL_ACTIVE_TTL_MS;
}

/**
 * A fresh-looking `active` record is not proof of work for native installs:
 * the parent that wrote it may have exited before the spawned downloader's
 * exit event (or the downloader died before doing anything), and the 6 h TTL
 * would then silently block every retry. Past the spawn grace window — the
 * worker needs a moment to self-acquire the lock — lock liveness IS the
 * truth: held ⇒ a download is running; free ⇒ the record is an orphan and
 * the caller may start a new attempt. Package-manager sources have no such
 * liveness signal and keep the TTL behavior above.
 */
const NATIVE_INSTALL_SPAWN_GRACE_MS = 60_000;

async function hasNativeInstallInFlight(
  state: UpdateInstallState,
  target: UpdateTarget,
): Promise<boolean> {
  const active = state.active;
  if (active === null || active.version !== target.version) return false;
  const startedAt = Date.parse(active.startedAt);
  if (Number.isFinite(startedAt) && Date.now() - startedAt < NATIVE_INSTALL_SPAWN_GRACE_MS) {
    return true;
  }
  const probe = await tryAcquireUpdateInstallLock({ version: target.version });
  if (probe === null) return true;
  await probe.release().catch(() => {});
  return false;
}

async function hasInstallInFlight(
  source: InstallSource,
  state: UpdateInstallState,
  target: UpdateTarget,
): Promise<boolean> {
  return source === 'native'
    ? hasNativeInstallInFlight(state, target)
    : hasFreshActiveInstall(state, target);
}

async function showPendingBackgroundInstallNotice(
  state: UpdateInstallState,
  currentVersion: string,
  stdout: { write(chunk: string): boolean },
  deps: PreflightDeps,
): Promise<UpdateInstallState> {
  const success = state.lastSuccess;
  if (success !== null && success.notifiedAt === null && success.version === currentVersion) {
    stdout.write(renderBackgroundInstallSuccessNotice(success.version));
    trackUpdateEvent(deps.track, 'update_success_notice_shown', {
      version: success.version,
      inferred_from_active: false,
    });
    logUpdateInfo(deps.logger, 'background update success notice shown', {
      version: success.version,
      inferredFromActive: false,
    });
    const nextState: UpdateInstallState = {
      ...state,
      active: null,
      lastFailure: null,
      lastSuccess: {
        ...success,
        notifiedAt: nowIso(),
      },
    };
    await writeUpdateInstallState(nextState).catch(() => {});
    return nextState;
  }

  const active = state.active;
  if (active === null || active.version !== currentVersion) return state;
  if (success !== null && success.version === currentVersion && success.notifiedAt !== null) {
    return state;
  }

  const notifiedAt = nowIso();
  stdout.write(renderBackgroundInstallSuccessNotice(active.version));
  trackUpdateEvent(deps.track, 'update_success_notice_shown', {
    version: active.version,
    inferred_from_active: true,
  });
  logUpdateInfo(deps.logger, 'background update success notice shown', {
    version: active.version,
    inferredFromActive: true,
  });
  const nextState: UpdateInstallState = {
    ...state,
    active: null,
    lastFailure: null,
    lastSuccess: {
      version: active.version,
      installedAt: notifiedAt,
      notifiedAt,
    },
  };
  await writeUpdateInstallState(nextState).catch(() => {});
  return nextState;
}

export { isAutoUpdateDisabledByEnv, shouldAutoInstallUpdates } from './auto-install';

function trackUpdatePrompted(
  track: RunUpdatePreflightOptions['track'],
  currentVersion: string,
  target: UpdateTarget,
  source: InstallSource,
  decision: UpdatePromptAction,
  rolloutTelemetry: RolloutTelemetry,
): void {
  trackUpdateEvent(track, 'update_prompted', {
    current_version: currentVersion,
    target_version: target.version,
    source,
    decision,
    ...rolloutTelemetry,
  });
}

function trackUpdateEvent(
  track: RunUpdatePreflightOptions['track'],
  event: string,
  properties: TelemetryProperties,
): void {
  try {
    track?.(event, properties);
  } catch {
    // Telemetry must never affect update prompting.
  }
}

function logUpdateInfo(
  logger: UpdateLogger,
  message: string,
  payload: Record<string, unknown>,
): void {
  try {
    logger.info(message, payload);
  } catch {
    // Diagnostic logging must never affect update prompting.
  }
}

function logUpdateWarn(
  logger: UpdateLogger,
  message: string,
  payload: Record<string, unknown>,
): void {
  try {
    logger.warn(message, payload);
  } catch {
    // Diagnostic logging must never affect update prompting.
  }
}

async function promptInstall(
  currentVersion: string,
  plan: ActionableUpdatePlan,
  source: InstallSource,
  installCommand: string,
): Promise<InstallPromptChoiceValue> {
  const options: InstallPromptOptions = {
    currentVersion,
    plan,
    installSource: source,
    installCommand,
  };
  return promptForInstallChoice(options);
}

export async function installUpdate(
  source: InstallSource,
  plan: ActionableUpdatePlan,
  platform: NodeJS.Platform,
  spawnImpl: typeof spawn = spawn,
): Promise<void> {
  // installUpdate only runs after an explicit user choice (the `upgrade`
  // command or the interactive prompt) — mark the stage as manual.
  const spawnTarget = resolveInstallSpawn(source, plan, platform, { manual: true });
  if (spawnTarget === undefined) {
    throw new Error(
      `${spawnForSource(source, plan.target.version, platform).cmd} was not found in PATH; cannot install the update`,
    );
  }
  await new Promise<void>((resolve, reject) => {
    // Windows package managers (npm/yarn) are .cmd shims. Since the
    // CVE-2024-27980 fix, Node throws EINVAL when spawning a .cmd/.bat without
    // a shell, so run through the shell on win32. The version is a validated
    // semver and the package name is a constant, so args are shell-safe. The
    // native self-spawn is an .exe and needs no shell.
    const child = spawnImpl(spawnTarget.resolvedCmd, [...spawnTarget.args], {
      stdio: 'inherit',
      shell: spawnTarget.shell ? true : undefined,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = signal !== null ? `signal ${signal}` : `code ${String(code)}`;
      reject(new Error(t('tui.statusMessages.updateInstallExited', { detail })));
    });
  });
}

async function startBackgroundInstall(
  state: UpdateInstallState,
  currentVersion: string,
  plan: UpgradePlan,
  source: InstallSource,
  platform: NodeJS.Platform,
  deps: PreflightDeps,
  rolloutTelemetry: RolloutTelemetry,
): Promise<void> {
  const target = plan.target;
  // The native self-spawned downloader holds the install lock itself for the
  // whole download — taking it here too would race the child (it starts before
  // this function's finally releases) into a false success. Package-manager
  // installs keep the outer lock, which only guards against duplicate spawns.
  const lock =
    source === 'native'
      ? { filePath: '', release: async (): Promise<void> => {} }
      : await tryAcquireUpdateInstallLock({ version: target.version });
  if (lock === null) return;

  try {
    const freshState = await readUpdateInstallState().catch(() => state);
    if (
      (await hasInstallInFlight(source, freshState, target)) ||
      failureAttemptsFor(freshState, target) >= AUTO_INSTALL_FAILURE_PROMPT_THRESHOLD
    ) {
      return;
    }

    const startedState: UpdateInstallState = {
      ...freshState,
      active: {
        version: target.version,
        source,
        startedAt: nowIso(),
      },
    };
    await writeUpdateInstallState(startedState);
    trackUpdateEvent(deps.track, 'update_background_install_started', {
      current_version: currentVersion,
      target_version: target.version,
      source,
      ...rolloutTelemetry,
    });
    logUpdateInfo(deps.logger, 'background update install started', {
      currentVersion,
      targetVersion: target.version,
      source,
    });

    const spawnTarget = resolveInstallSpawn(source, plan, platform);
    let settled = false;

    const finish = (succeeded: boolean): void => {
      if (settled) return;
      settled = true;
      const attempts = failureAttemptsFor(startedState, target) + 1;

      const nextState: UpdateInstallState = succeeded
        ? {
            ...startedState,
            active: null,
            lastFailure: null,
            lastSuccess: {
              version: target.version,
              installedAt: nowIso(),
              notifiedAt: null,
            },
          }
        : {
            ...startedState,
            active: null,
            lastFailure: {
              version: target.version,
              failedAt: nowIso(),
              attempts,
            },
          };
      void writeUpdateInstallState(nextState).catch(() => {});
      if (succeeded) {
        trackUpdateEvent(deps.track, 'update_background_install_succeeded', {
          target_version: target.version,
          source,
        });
        logUpdateInfo(deps.logger, 'background update install succeeded', {
          targetVersion: target.version,
          source,
        });
        return;
      }
      trackUpdateEvent(deps.track, 'update_background_install_failed', {
        target_version: target.version,
        source,
        attempts,
      });
      logUpdateWarn(deps.logger, 'background update install failed', {
        targetVersion: target.version,
        source,
        attempts,
      });
    };

    if (spawnTarget === undefined) {
      // The package manager cannot be resolved to an absolute path outside
      // the cwd — record a normal install failure instead of spawning a bare
      // command name that Windows would resolve into the untrusted workspace.
      finish(false);
      return;
    }
    const child = deps.spawn(spawnTarget.resolvedCmd, [...spawnTarget.args], {
      detached: true,
      stdio: 'ignore',
      shell: spawnTarget.shell ? true : undefined,
      // On Windows a detached child gets its own console window; with shell:true
      // that window would flash during a passive background update. Hide it so
      // the silent updater stays silent.
      windowsHide: platform === 'win32' ? true : undefined,
    });
    child.once('error', () => {
      finish(false);
    });
    child.once('exit', (code) => {
      finish(code === 0);
    });
    child.unref();
  } finally {
    await lock.release().catch(() => {});
  }
}

async function tryStartAutomaticBackgroundInstall(
  installState: UpdateInstallState,
  currentVersion: string,
  plan: UpgradePlan,
  source: InstallSource,
  platform: NodeJS.Platform,
  deps: PreflightDeps,
  rolloutTelemetry: RolloutTelemetry,
): Promise<boolean> {
  const target = plan.target;
  const sourceCanAutoInstall = canAutoInstall(source, platform);
  const autoInstallUpdates = sourceCanAutoInstall
    ? await shouldAutoInstallUpdates(deps.logger)
    : false;
  if (!autoInstallUpdates || !sourceCanAutoInstall) return false;
  if (failureAttemptsFor(installState, target) >= AUTO_INSTALL_FAILURE_PROMPT_THRESHOLD) {
    return false;
  }
  if (!(await hasInstallInFlight(source, installState, target))) {
    await startBackgroundInstall(
      installState,
      currentVersion,
      plan,
      source,
      platform,
      deps,
      rolloutTelemetry,
    ).catch(() => {});
  }
  return true;
}

export function decideUpdateAction(
  plan: UpdatePlan,
  isInteractive: boolean,
  source: InstallSource,
  platform: NodeJS.Platform,
): UpdatePromptAction {
  if (plan.kind === 'none' || !isInteractive) return 'none';
  return canAutoInstall(source, platform) ? 'prompt-install' : 'manual-command';
}

export async function runUpdatePreflight(
  currentVersion: string,
  options: RunUpdatePreflightOptions = {},
): Promise<UpdatePreflightResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const logger = options.logger ?? log;
  const platform = process.platform;

  if (isAutoUpdateDisabledByEnv()) {
    return 'continue';
  }

  const deps: PreflightDeps = {
    spawn: options.spawn ?? spawn,
    clock: options.clock ?? SYSTEM_RENDER_CLOCK,
    track: options.track,
    logger,
  };

  try {
    const isInteractive = options.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);
    const deviceId = resolveUpdateDeviceId();
    const sourceHint = await detectInstallSource({ allowGlobalPrefix: false }).catch(() => null);
    const selection = resolveUpdateChannel(currentVersion, sourceHint ?? 'unsupported');
    const channelWarning = formatUpdateChannelWarning(selection);
    if (channelWarning !== null) stderr.write(channelWarning);
    const check: UpdateCheckContext = {
      selection,
      experimental: isRolloutBypassedByExperimentalEnv(),
    };
    let installState = await readUpdateInstallState().catch(() => emptyUpdateInstallState());
    if (isInteractive) {
      installState = await showPendingBackgroundInstallNotice(
        installState,
        currentVersion,
        stdout,
        deps,
      );
    }

    // A cache written for another channel describes a different release line:
    // its `latest` must never be compared against this channel's versions.
    const storedCache = await readUpdateCache().catch(() => null);
    const cache = storedCache?.channel === selection.channel ? storedCache : null;
    const cachedFeed: UpdateFeed = cache ?? {
      channel: selection.channel,
      latest: null,
      manifest: null,
    };
    let decision = decidePassiveUpdate(
      currentVersion,
      cachedFeed,
      deviceId,
      new Date(),
      check.experimental,
    );
    let manifest = cachedFeed.manifest;
    logRolloutDecision('startup-cache', check, currentVersion, cachedFeed, decision);
    let plan = decision.plan;

    if (plan.kind === 'none') {
      // Nothing usable is cached for the selected channel. On an interactive
      // startup that only happens when the channel differs from the installed
      // one (an explicitly requested switch, or an env override), so refresh
      // once within the user-visible budget instead of waiting for the next
      // background cycle.
      if (!isInteractive || selection.channel === updateChannelForVersion(currentVersion)) {
        refreshAndMaybeInstallInBackground(
          currentVersion,
          deviceId,
          check,
          isInteractive,
          installState,
          sourceHint,
          platform,
          deps,
        );
        return 'continue';
      }
      const refreshed = await refreshUserVisibleUpdate(
        currentVersion,
        deviceId,
        check,
        decision,
        manifest,
        deps.clock,
      );
      decision = refreshed.decision;
      manifest = refreshed.manifest;
      plan = decision.plan;
      if (plan.kind === 'none') return 'continue';
    }

    const source: InstallSource = !isInteractive
      ? 'unsupported'
      : (sourceHint ?? (await detectInstallSource().catch(() => 'unsupported' as const)));

    const promptAction = decideUpdateAction(plan, isInteractive, source, platform);
    if (promptAction === 'none') {
      refreshInBackground(check);
      return 'continue';
    }

    if (
      plan.kind === 'upgrade' &&
      (await tryStartAutomaticBackgroundInstall(
        installState,
        currentVersion,
        plan,
        source,
        platform,
        deps,
        rolloutTelemetryFor(deviceId, plan, manifest, check.experimental),
      ))
    ) {
      refreshInBackground(check);
      return 'continue';
    }

    // The user-visible prompt renders from the cached target without waiting on
    // the network: a refresh race here would block startup-to-prompt by up to
    // the full refresh budget on a slow CDN, and every failure branch fell back
    // to this same cached target anyway. Freshness is re-validated after the
    // user accepts — before anything is installed — so a withdrawn or
    // superseded target still never gets installed, and a declined prompt costs
    // no network wait at all.
    const cachedRollout = rolloutTelemetryFor(deviceId, plan, manifest, check.experimental);
    const installCommand = installCommandFor(
      source,
      plan.target.version,
      platform,
      plan.target.channel,
    );
    trackUpdatePrompted(deps.track, currentVersion, plan.target, source, promptAction, cachedRollout);

    if (promptAction === 'manual-command') {
      stdout.write(renderManualUpdateMessage(currentVersion, plan, source, installCommand));
      return 'continue';
    }

    const choice = await promptInstall(currentVersion, plan, source, installCommand);
    if (choice === 'skip') return 'continue';

    const revalidated = await refreshUserVisibleUpdate(
      currentVersion,
      deviceId,
      check,
      decision,
      manifest,
      deps.clock,
    );
    const installPlan = revalidated.decision.plan;
    if (installPlan.kind === 'none') return 'continue';
    if (
      installPlan.kind === 'upgrade' &&
      (await tryStartAutomaticBackgroundInstall(
        installState,
        currentVersion,
        installPlan,
        source,
        platform,
        deps,
        rolloutTelemetryFor(deviceId, installPlan, revalidated.manifest, check.experimental),
      ))
    ) {
      return 'continue';
    }

    try {
      await installUpdate(source, installPlan, platform, deps.spawn);
      stdout.write(renderInstallSuccessMessage(installPlan));
      return 'exit';
    } catch (error) {
      stderr.write(
        t('tui.statusMessages.updateInstallFailedWarning', {
          package: NPM_PACKAGE_NAME,
          version: installPlan.target.version,
          error: formatErrorMessage(error),
        }) + '\n',
      );
      return 'continue';
    }
  } catch {
    return 'continue';
  }
}
