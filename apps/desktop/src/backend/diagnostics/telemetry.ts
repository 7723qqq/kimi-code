import { statSync } from 'node:fs';
import { join } from 'node:path';

import {
  createCloudAppender,
  IConfigService,
  IOAuthToolkit,
  ITelemetryService,
  type Scope,
  type TelemetryProperties,
} from '@moonshot-ai/agent-core-v2';
import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';

import { DESKTOP_PRODUCT_NAME, DESKTOP_UI_MODE } from '../../shared/identity';
import { getRuntimeLocale, setDesktopTrackImpl } from './track';

export interface DesktopTelemetryHandle {
  readonly shutdown: () => Promise<void>;
}

export interface DesktopTelemetryIdentity {
  readonly deviceId: string;
  readonly theme?: 'dark' | 'light';
  readonly launchId?: string;
  readonly releaseChannel?: string;
  readonly locale?: string;
  readonly firstLaunch?: boolean;
  readonly onFirstLaunch?: () => void;
}

const SHUTDOWN_TIMEOUT_MS = 3_000;
const DISABLE_ENV = 'KIMI_DISABLE_TELEMETRY';
const TRUE_ENV_VALUES = new Set(['1', 'true', 't', 'yes', 'y']);
const DAY_MS = 86_400_000;

export function daysSince(birthtimeMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - birthtimeMs) / DAY_MS));
}

const DAYS_SINCE_INSTALL_TTL_MS = 3_600_000;
let daysSinceInstallCache: { at: number; value: number | undefined } | undefined;

function readDaysSinceInstall(): number | undefined {
  const now = Date.now();
  if (daysSinceInstallCache !== undefined && now - daysSinceInstallCache.at < DAYS_SINCE_INSTALL_TTL_MS) {
    return daysSinceInstallCache.value;
  }
  let value: number | undefined;
  try {
    const { birthtimeMs } = statSync(join(resolveKimiHome(), 'device_id'));
    if (birthtimeMs > 0) value = daysSince(birthtimeMs, now);
  } catch {
    value = undefined;
  }
  daysSinceInstallCache = { at: now, value };
  return value;
}

export function resetDaysSinceInstallCacheForTests(): void {
  daysSinceInstallCache = undefined;
}

function withSuperProperties(identity: DesktopTelemetryIdentity, properties: TelemetryProperties | undefined): TelemetryProperties {
  const injected: Record<string, string | number> = {
    app_uptime_ms: Math.round(process.uptime() * 1000),
    theme: identity.theme ?? 'light',
    launch_id: identity.launchId ?? '',
    release_channel: identity.releaseChannel ?? '',
  };
  const daysSinceInstall = readDaysSinceInstall();
  if (daysSinceInstall !== undefined) injected['days_since_install'] = daysSinceInstall;
  const locale = identity.locale ?? getRuntimeLocale();
  if (locale !== undefined) injected['locale'] = locale;
  return { ...injected, ...properties };
}

export function isTelemetryConsentEnabled(configValue: unknown, envValue: string | undefined): boolean {
  if (envValue !== undefined && TRUE_ENV_VALUES.has(envValue.trim().toLowerCase())) return false;
  return configValue !== false;
}

export async function wireDesktopTelemetry(
  core: Scope,
  identity: DesktopTelemetryIdentity,
): Promise<DesktopTelemetryHandle | null> {
  try {
    const configService = core.accessor.get(IConfigService);
    await configService.ready;
    let configValue: unknown;
    try {
      configValue = configService.get('telemetry');
    } catch {
      configValue = undefined;
    }
    if (!isTelemetryConsentEnabled(configValue, process.env[DISABLE_ENV])) return null;

    const telemetry = core.accessor.get(ITelemetryService);
    const startedAt = Date.now();
    const auth = core.accessor.get(IOAuthToolkit);
    const appender = createCloudAppender(core.accessor, {
      deviceId: identity.deviceId,
      appName: DESKTOP_PRODUCT_NAME,
      uiMode: DESKTOP_UI_MODE,
      getAccessToken: async () => (await auth.getCachedAccessToken()) ?? null,
    });
    telemetry.addAppender(appender);
    setDesktopTrackImpl((event, properties) => {
      const { session_id, ...eventProperties } = properties ?? {};
      appender.track({
        event,
        context: typeof session_id === 'string' ? { session_id } : {},
        properties: withSuperProperties(identity, eventProperties),
      });
    });
    appender.startPeriodicFlush();
    void appender.retryDiskEvents().catch(() => {});
    if (identity.firstLaunch === true) {
      telemetry.track2('first_launch');
      identity.onFirstLaunch?.();
    }

    let shutdownOnce: Promise<void> | undefined;
    return {
      shutdown: () =>
        (shutdownOnce ??= (async () => {
          telemetry.track2('exit', { duration_ms: Date.now() - startedAt });
          appender.stopPeriodicFlush();
          await raceTimeout(telemetry.shutdown(), SHUTDOWN_TIMEOUT_MS);
          setDesktopTrackImpl(null);
        })()),
    };
  } catch (error) {
    console.error('[kimi-desktop] telemetry wiring failed', error);
    return null;
  }
}

async function raceTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {} finally {
    clearTimeout(timer);
  }
}
