/**
 * Print-mode harness/session surface consumed by `kimi -p`.
 *
 * Print mode drives the native Rust engine through the SDK session, so this
 * module keeps the type-level view of the session surface the print path uses.
 */

import type {
  ConfigDiagnostics,
  CreateSessionOptions,
  KimiAuthFacade,
  KimiConfig,
  ListSessionsOptions,
  ResumeSessionInput,
  Session,
  SessionSummary,
  TelemetryProperties,
} from '@moonshot-ai/kimi-code-sdk';

export interface PromptHarness {
  readonly homeDir: string;
  readonly auth: KimiAuthFacade;

  track(event: string, properties?: TelemetryProperties): void;

  ensureConfigFile(): Promise<void>;
  getConfig(): Promise<Pick<KimiConfig, 'defaultModel' | 'telemetry'>>;
  getConfigDiagnostics(): Promise<ConfigDiagnostics>;
  listSessions(options: ListSessionsOptions): Promise<readonly SessionSummary[]>;
  createSession(options: CreateSessionOptions): Promise<Session>;
  resumeSession(input: ResumeSessionInput): Promise<Session>;
  close(): Promise<void>;
}
