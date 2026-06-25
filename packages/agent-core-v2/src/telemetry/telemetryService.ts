import {
  ITelemetryService,
  noopTelemetryClient,
  type TelemetryClient,
  type TelemetryContextPatch,
  type TelemetryProperties,
  type TelemetryServiceOptions,
} from './telemetry';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

export class TelemetryService implements ITelemetryService {
  private client: TelemetryClient;
  private context: TelemetryProperties;

  constructor(options: TelemetryServiceOptions = {}) {
    this.client = options.client ?? noopTelemetryClient;
    this.context = {
      ...options.context,
      ...definedContext({
        sessionId: options.sessionId,
        agentId: options.agentId,
        turnId: options.turnId,
      }),
    };
  }

  setDelegate(client: TelemetryClient): void {
    this.client = client;
  }

  track(event: string, properties?: TelemetryProperties): void {
    this.client.track(event, { ...this.context, ...properties });
  }

  withContext(patch: TelemetryContextPatch): ITelemetryService {
    return new TelemetryService({
      client: this.client.withContext?.(patch) ?? this.client,
      context: { ...this.context, ...patch },
    });
  }

  setContext(patch: TelemetryContextPatch): void {
    this.context = { ...this.context, ...patch };
    this.client.setContext?.(patch);
  }
}

registerScopedService(
  LifecycleScope.Core,
  ITelemetryService,
  TelemetryService,
  InstantiationType.Delayed,
  'telemetry',
);

function definedContext(input: TelemetryProperties): TelemetryProperties {
  const out: Record<string, Exclude<TelemetryProperties[string], undefined>> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}
