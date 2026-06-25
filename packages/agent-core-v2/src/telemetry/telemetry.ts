/**
 * `telemetry` domain (L1) — `ITelemetryService` contract and sink types.
 *
 * Layer-1 root service: merges bound context into tracked events and fans
 * them out to one or more `TelemetryClient` sinks. Core-scoped — stateless
 * beyond its sink set and bound context; enrichment, batching, and transport
 * are owned by the sinks, not by this layer. Defines the `TelemetryClient`
 * sink contract, the `ITelemetryService` facade, the service options, and the
 * no-op sink.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

export type TelemetryPropertyValue = unknown;

export type TelemetryProperties = Readonly<Record<string, TelemetryPropertyValue>>;

export type TelemetryContextPatch = TelemetryProperties;

export interface TelemetryClient {
  track(event: string, properties?: TelemetryProperties): void;
  withContext?(patch: TelemetryContextPatch): TelemetryClient;
  setContext?(patch: TelemetryContextPatch): void;
  flush?(): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}

export interface TelemetryServiceOptions {
  readonly client?: TelemetryClient;
  readonly clients?: readonly TelemetryClient[];
  readonly context?: TelemetryProperties;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: string;
}

export interface ITelemetryService {
  readonly _serviceBrand: undefined;
  track(event: string, properties?: TelemetryProperties): void;
  withContext(patch: TelemetryContextPatch): ITelemetryService;
  setContext(patch: TelemetryContextPatch): void;
  addSink(client: TelemetryClient): IDisposable;
  removeSink(client: TelemetryClient): void;
  setDelegate(client: TelemetryClient): void;
  setEnabled(enabled: boolean): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export const noopTelemetryClient: TelemetryClient = {
  track: () => {},
  withContext: () => noopTelemetryClient,
  setContext: () => {},
  flush: () => {},
  shutdown: () => {},
};

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ITelemetryService = createDecorator<ITelemetryService>(
  'agentTelemetryService',
);
