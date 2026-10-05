/**
 * Minimal harness/session surface consumed by `kimi -p` (print mode).
 *
 * The v2 print driver (`cli/v2/run-v2-print.ts`) talks to agent-core-v2's
 * native DI services directly, so the print-mode path no longer goes through a
 * `PromptHarness`-shaped SDK session. This module keeps the type-level view of
 * that surface for reference; new print-mode code should target the native
 * `ISessionScopeHandle` / `IAgentScopeHandle` interfaces instead.
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
