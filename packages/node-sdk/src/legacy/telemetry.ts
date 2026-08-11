/**
 * Localized telemetry primitives — the v1 core's `TelemetryClient` contract,
 * copied so the SDK keeps its public telemetry surface without importing
 * `agent-core`. New code should prefer the v2 `ITelemetryService`
 * (`@moonshot-ai/agent-core-v2`); these shapes are kept for the SDK's public
 * API and the remaining v1-client path until that client is removed.
 */
export type TelemetryPropertyValue = boolean | number | string | undefined | null;

export type TelemetryProperties = Readonly<Record<string, TelemetryPropertyValue>>;

export interface TelemetryContextPatch {
  readonly sessionId?: string | null;
}

export interface TelemetryClient {
  track(event: string, properties?: TelemetryProperties): void;
  withContext?(patch: TelemetryContextPatch): TelemetryClient;
  setContext?(patch: TelemetryContextPatch): void;
}

export const noopTelemetryClient: TelemetryClient = {
  track: () => {},
  withContext: () => noopTelemetryClient,
  setContext: () => {},
};

export function withTelemetryContext(
  telemetry: TelemetryClient,
  patch: TelemetryContextPatch,
): TelemetryClient {
  return telemetry.withContext?.(patch) ?? telemetry;
}

export function withTelemetryProperties(
  telemetry: TelemetryClient,
  defaults: TelemetryProperties,
): TelemetryClient {
  return {
    track(event, properties) {
      telemetry.track(event, { ...defaults, ...properties });
    },
    withContext(patch) {
      return withTelemetryProperties(withTelemetryContext(telemetry, patch), defaults);
    },
    setContext(patch) {
      telemetry.setContext?.(patch);
    },
  };
}
