import { statSync } from 'node:fs';
import { join } from 'node:path';

import type { TelemetryProperties } from '@moonshot-ai/agent-core-v2';
import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk/runtime';
import { nativeTheme } from 'electron';

import type { BackendChannel } from '../../shared/backend-channel';
import { markFirstLaunchReported, shouldReportFirstLaunch } from '../app/ui-state';
import { launchChannel, launchId, log } from './log';
import { startDesktopSystemMetrics, stopDesktopSystemMetrics } from './system-metrics';
import { getRuntimeLocale, setDesktopTrackImpl } from './track';

export { isTelemetryConsentEnabled } from '../../shared/telemetry-consent';

export interface DesktopTelemetryHandle {
  readonly shutdown: () => Promise<void>;
}

const DAY_MS = 86_400_000;
const DAYS_SINCE_INSTALL_TTL_MS = 3_600_000;
let daysSinceInstallCache: { at: number; value: number | undefined } | undefined;

export function daysSince(birthtimeMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - birthtimeMs) / DAY_MS));
}

function readDaysSinceInstall(): number | undefined {
  const now = Date.now();
  if (
    daysSinceInstallCache !== undefined &&
    now - daysSinceInstallCache.at < DAYS_SINCE_INSTALL_TTL_MS
  )
    return daysSinceInstallCache.value;
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

function withSuperProperties(properties: TelemetryProperties | undefined): TelemetryProperties {
  const daysSinceInstall = readDaysSinceInstall();
  return {
    app_uptime_ms: Math.round(process.uptime() * 1000),
    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    launch_id: launchId(),
    release_channel: launchChannel(),
    days_since_install: daysSinceInstall,
    locale: getRuntimeLocale(),
    ...properties,
  };
}

export async function wireDesktopTelemetry(
  channel: BackendChannel,
  enabled: boolean,
): Promise<DesktopTelemetryHandle> {
  let closed = false;
  const off = channel.onDisconnect(() => {
    closed = true;
    stopDesktopSystemMetrics();
    setDesktopTrackImpl(null);
  });
  if (enabled) {
    setDesktopTrackImpl((event, properties) => {
      if (closed) return;
      const values = Object.fromEntries(
        Object.entries(withSuperProperties(properties)).filter(
          (entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined,
        ),
      );
      void channel.emit('telemetry.record', { event, properties: values }).catch(() => {});
    });
    startDesktopSystemMetrics({
      sessionCount: () => channel.request('telemetry.session-count', null),
    });
    if (shouldReportFirstLaunch() && (await channel.request('telemetry.first-launch', null)))
      markFirstLaunchReported();
  } else {
    setDesktopTrackImpl(null);
    log.info('[kimi-desktop] telemetry disabled by config or env');
  }
  let closing: Promise<void> | undefined;
  return {
    shutdown: () =>
      (closing ??= (async () => {
        stopDesktopSystemMetrics();
        try {
          if (!closed) {
            await channel.drain();
            await channel.request('telemetry.shutdown', null, { timeoutMs: 5000 });
          }
        } finally {
          closed = true;
          setDesktopTrackImpl(null);
          off();
        }
      })()),
  };
}
