import {
  createCloudAppender,
  IConfigService,
  IOAuthToolkit,
  ISessionIndex,
  ITelemetryService,
  IWorkspaceService,
  type Scope,
  type TelemetryProperties,
} from '@moonshot-ai/agent-core-v2';

import { DESKTOP_PRODUCT_NAME, DESKTOP_UI_MODE } from '../shared/identity';
import { isTelemetryConsentEnabled } from '../shared/telemetry-consent';

export async function wireBackendTelemetry(core: Scope, deviceId: string) {
  const config = core.accessor.get(IConfigService);
  await config.ready;
  const enabled = () => {
    let value: unknown;
    try {
      value = config.get('telemetry');
    } catch {
      value = undefined;
    }
    return isTelemetryConsentEnabled(value, process.env['KIMI_DISABLE_TELEMETRY']);
  };
  if (!enabled()) return null;
  const telemetry = core.accessor.get(ITelemetryService);
  const auth = core.accessor.get(IOAuthToolkit);
  const appender = createCloudAppender(core.accessor, {
    deviceId,
    appName: DESKTOP_PRODUCT_NAME,
    uiMode: DESKTOP_UI_MODE,
    getAccessToken: async () => (await auth.getCachedAccessToken()) ?? null,
  });
  const registration = telemetry.addAppender(appender);
  const startedAt = Date.now();
  appender.startPeriodicFlush();
  void appender.retryDiskEvents().catch(() => {
    console.error('[kimi-desktop] telemetry retry failed');
  });
  let closing: Promise<void> | undefined;
  return {
    track(event: string, properties?: TelemetryProperties): void {
      if (closing !== undefined || !enabled()) return;
      const { session_id, ...eventProperties } = properties ?? {};
      appender.track({
        event,
        context: typeof session_id === 'string' ? { session_id } : {},
        properties: eventProperties,
      });
    },
    firstLaunch(): boolean {
      if (closing !== undefined || !enabled()) return false;
      telemetry.track2('first_launch');
      return true;
    },
    async sessionCount(): Promise<number> {
      const workspaces = await core.accessor.get(IWorkspaceService).list();
      return core.accessor
        .get(ISessionIndex)
        .count({ workspaceIds: workspaces.map((workspace) => workspace.id) });
    },
    shutdown(): Promise<void> {
      return (closing ??= (async () => {
        if (enabled()) telemetry.track2('exit', { duration_ms: Date.now() - startedAt });
        appender.stopPeriodicFlush();
        registration.dispose();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            appender.shutdown(),
            new Promise<void>((resolve) => {
              timeout = setTimeout(resolve, 3000);
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
      })());
    },
  };
}
