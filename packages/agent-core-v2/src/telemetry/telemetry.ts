import { createDecorator } from '#/_base/di/instantiation';

export type TelemetryPropertyValue = unknown;

export type TelemetryProperties = Readonly<Record<string, TelemetryPropertyValue>>;

export type TelemetryContextPatch = TelemetryProperties;

export interface TelemetryClient {
  track(event: string, properties?: TelemetryProperties): void;
  withContext?(patch: TelemetryContextPatch): TelemetryClient;
  setContext?(patch: TelemetryContextPatch): void;
}

export interface TelemetryServiceOptions {
  readonly client?: TelemetryClient;
  readonly context?: TelemetryProperties;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: string;
}

export interface ITelemetryService {
  track(event: string, properties?: TelemetryProperties): void;
  withContext(patch: TelemetryContextPatch): ITelemetryService;
  setContext(patch: TelemetryContextPatch): void;
}

export const noopTelemetryClient: TelemetryClient = {
  track: () => {},
  withContext: () => noopTelemetryClient,
  setContext: () => {},
};

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ITelemetryService = createDecorator<ITelemetryService>(
  'agentTelemetryService',
);
