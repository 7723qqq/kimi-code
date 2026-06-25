/**
 * `telemetry` domain (L1) — `ITelemetryService` implementation.
 *
 * Merges bound context into each tracked event and fans it out to the
 * registered `TelemetryClient` sinks; owns the sink set, the enabled flag,
 * and the bound context, but no enrichment or transport of its own. Bound at
 * Core scope; has no cross-domain collaborators.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { type IDisposable, toDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';

import {
  ITelemetryService,
  noopTelemetryClient,
  type TelemetryClient,
  type TelemetryContextPatch,
  type TelemetryProperties,
  type TelemetryServiceOptions,
} from './telemetry';

export class TelemetryService implements ITelemetryService {
  declare readonly _serviceBrand: undefined;

  private sinks: TelemetryClient[];
  private context: TelemetryProperties;
  private enabled = true;

  constructor(options: TelemetryServiceOptions = {}) {
    this.sinks = resolveSinks(options);
    this.context = {
      ...options.context,
      ...definedContext({
        sessionId: options.sessionId,
        agentId: options.agentId,
        turnId: options.turnId,
      }),
    };
  }

  track(event: string, properties?: TelemetryProperties): void {
    if (!this.enabled) {
      return;
    }
    const merged = { ...this.context, ...properties };
    for (const sink of this.sinks) {
      try {
        sink.track(event, merged);
      } catch (err) {
        onUnexpectedError(err);
      }
    }
  }

  withContext(patch: TelemetryContextPatch): ITelemetryService {
    const child = new TelemetryService({
      clients: this.sinks.map((sink) => sink.withContext?.(patch) ?? sink),
      context: { ...this.context, ...patch },
    });
    child.enabled = this.enabled;
    return child;
  }

  setContext(patch: TelemetryContextPatch): void {
    this.context = { ...this.context, ...patch };
    for (const sink of this.sinks) {
      sink.setContext?.(patch);
    }
  }

  addSink(client: TelemetryClient): IDisposable {
    this.sinks.push(client);
    return toDisposable(() => this.removeSink(client));
  }

  removeSink(client: TelemetryClient): void {
    this.sinks = this.sinks.filter((sink) => sink !== client);
  }

  setDelegate(client: TelemetryClient): void {
    this.sinks = [client];
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async flush(): Promise<void> {
    await Promise.all(
      this.sinks.map((sink) =>
        Promise.resolve(sink.flush?.()).catch(onUnexpectedError),
      ),
    );
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      this.sinks.map((sink) =>
        Promise.resolve(sink.shutdown?.()).catch(onUnexpectedError),
      ),
    );
  }
}

registerScopedService(
  LifecycleScope.Core,
  ITelemetryService,
  TelemetryService,
  InstantiationType.Delayed,
  'telemetry',
);

function resolveSinks(options: TelemetryServiceOptions): TelemetryClient[] {
  if (options.clients !== undefined) {
    return options.clients.length > 0 ? [...options.clients] : [noopTelemetryClient];
  }
  return [options.client ?? noopTelemetryClient];
}

function definedContext(input: TelemetryProperties): TelemetryProperties {
  const out: Record<string, Exclude<TelemetryProperties[string], undefined>> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}
