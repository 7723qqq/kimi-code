/**
 * Print-mode harness/session surface consumed by `kimi -p`.
 *
 * Print mode drives the native Rust engine through the SDK session, so this
 * module keeps the type-level view of the session surface the print path uses.
 */

import type {
  ApprovalHandler,
  ConfigDiagnostics,
  CreateGoalInput,
  CreateSessionOptions,
  Event,
  GetCronTasksResult,
  GoalSnapshot,
  GoalToolResult,
  KimiAuthFacade,
  KimiConfig,
  ListSessionsOptions,
  PermissionMode,
  PromptInput,
  QuestionHandler,
  ResumeSessionInput,
  SessionStatus,
  SessionSummary,
  TelemetryProperties,
  Unsubscribe,
} from '@moonshot-ai/kimi-code-sdk';

export interface PromptHarness {
  readonly homeDir: string;
  readonly auth: KimiAuthFacade;

  track(event: string, properties?: TelemetryProperties): void;

  ensureConfigFile(): Promise<void>;
  getConfig(): Promise<Pick<KimiConfig, 'defaultModel' | 'telemetry'>>;
  getConfigDiagnostics(): Promise<ConfigDiagnostics>;
  listSessions(options: ListSessionsOptions): Promise<readonly SessionSummary[]>;
  createSession(options: CreateSessionOptions): Promise<PromptSession>;
  resumeSession(input: ResumeSessionInput): Promise<PromptSession>;
  close(): Promise<void>;
}

export interface PromptSession {
  readonly id: string;
  readonly workDir: string;

  getStatus(): Promise<SessionStatus>;
  setModel(model: string): Promise<void>;
  setPermission(mode: PermissionMode): Promise<void>;
  setApprovalHandler(handler: ApprovalHandler | undefined): void;
  setQuestionHandler(handler: QuestionHandler | undefined): void;
  onEvent(listener: (event: Event) => void): Unsubscribe;
  prompt(input: string | PromptInput): Promise<void>;
  waitForBackgroundTasksOnPrint(): Promise<void>;
  handlePrintMainTurnCompleted?(): Promise<'finish' | 'continue'>;
  createGoal(input: CreateGoalInput): Promise<GoalSnapshot>;
  getGoal(): Promise<GoalToolResult>;
  getCronTasks(): Promise<GetCronTasksResult>;
}
