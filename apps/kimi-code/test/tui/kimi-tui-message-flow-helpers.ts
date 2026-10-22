import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Event, GoalSnapshot } from '@moonshot-ai/kimi-code-sdk';
import { mock, spyOn } from 'bun:test';

import type { FeedbackPromptResult } from '#/tui/commands/prompts';
import type { SessionReplayRenderer } from '#/tui/controllers/session-replay';
import type { StreamingUIController } from '#/tui/controllers/streaming-ui';
import type { SurveyController } from '#/tui/controllers/survey-controller';
import { KimiTUI, type KimiTUIStartupInput, type TUIState } from '#/tui/kimi-tui';
import type { QueuedMessage, TranscriptEntry } from '#/tui/types';
import type { ExtractionResult } from '#/tui/utils/image-placeholder';

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

export function stripSgr(text: string): string {
  return text
    .replaceAll(/\u001B\[[0-9;]*m/g, '')
    .replaceAll(new RegExp(`${ESC}\\]8;;[^${BEL}]*${BEL}`, 'g'), '');
}

export interface MessageDriver {
  state: TUIState;
  surveyController: SurveyController;
  streamingUI: StreamingUIController;
  sessionReplay: SessionReplayRenderer;
  pluginCommandMap: Map<string, string>;
  sessionEventHandler: {
    notifications: import('#/tui/controllers/notify').NotifyController;
    startSubscription(): void;
    handleEvent(event: Event, sendQueued: (item: QueuedMessage) => void): void;
  };
  init(): Promise<boolean>;
  handleUserInput(text: string): void;
  toggleToolOutputExpansion(): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  persistInputHistory(text: string): Promise<void>;
  sendQueuedMessage(session: unknown, item: QueuedMessage): void;
  recallLastQueued(): QueuedMessage | undefined;
  recallStashedMedia(extraction: ExtractionResult | undefined): void;
  clearQueuedMessages(): void;
  closeSession(reason: string): Promise<void>;
  setSession(session: unknown): Promise<void>;
  syncRuntimeState(session?: unknown): Promise<void>;
  getCurrentSessionId(): string;
}

export interface FeedbackDriver extends MessageDriver {
  handleFeedbackCommand(): Promise<void>;
  promptFeedbackInput(): Promise<FeedbackPromptResult | undefined>;
}

export interface ModelSelectorDriver extends MessageDriver {
  runModelSelector(
    models: Record<
      string,
      {
        provider: string;
        model: string;
        maxContextSize: number;
        displayName?: string;
        capabilities?: string[];
      }
    >,
  ): Promise<{ alias: string; thinking: boolean } | undefined>;
}

export function makeStartupInput(): KimiTUIStartupInput {
  return {
    cliOptions: {
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
      agent: undefined,
      agentFiles: [],
    },
    tuiConfig: {
      theme: 'dark',
      locale: 'en',
      disablePasteBurst: false,
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: true },
      statusLine: { items: null, command: null },
    },
    version: '0.0.0-test',
    workDir: '/tmp/proj-a',
  };
}

export function makeSession(overrides: Record<string, unknown> = {}) {
  let model = 'k2';
  let thinkingEffort = 'off';
  return {
    id: 'ses-1',
    model: 'k2',
    summary: { title: null },
    prompt: mock(async (_input: unknown) => {}),
    compact: mock(async () => {}),
    steer: mock(async () => {}),
    init: mock(async () => {}),
    startBtw: mock(async () => 'agent-btw'),
    undoHistory: mock(async () => {}),
    cancel: mock(async () => {}),
    cancelCompaction: mock(async () => {}),
    getStatus: mock(async () => ({
      model,
      thinkingEffort,
      permission: 'manual',
      planMode: false,
      contextTokens: 0,
      maxContextTokens: 100,
      contextUsage: 0,
    })),
    getGoal: mock(async () => ({ goal: null })),
    setApprovalHandler: mock(),
    setQuestionHandler: mock(),
    setModel: mock(async (alias: string) => {
      model = alias;
    }),
    setThinking: mock(async (effort: string) => {
      thinkingEffort = effort;
    }),
    setPermission: mock(async () => {}),
    setPlanMode: mock(async () => {}),
    setSwarmMode: mock(async () => {}),
    onEvent: mock(() => mock()),
    listMcpServers: mock(async () => []),
    listSkills: mock(async () => []),
    getResumeState: mock(() => ({
      sessionMetadata: {},
      agents: {
        main: {
          status: {
            model: 'k2',
            thinkingEffort: 'off',
            permission: 'manual',
            planMode: false,
            contextTokens: 0,
            maxContextTokens: 100,
            contextUsage: 0,
          },
          // Real resume states carry the stored user-turn count; the survey
          // telemetry reads it through `seedUserTurnCount`.
          userTurnCount: 0,
          context: { history: [] },
          replay: [],
        },
      },
    })),
    close: mock(async () => {}),
    listPlugins: mock(async () => []),
    installPlugin: mock(async () => ({
      id: 'demo',
      displayName: 'Demo',
      version: '1.0.0',
      enabled: true,
      state: 'ok',
      skillCount: 1,
      mcpServerCount: 0,
      enabledMcpServerCount: 0,
      hasErrors: false,
      source: 'local-path',
    })),
    setPluginEnabled: mock(async () => {}),
    setPluginMcpServerEnabled: mock(async () => {}),
    removePlugin: mock(async () => {}),
    reloadPlugins: mock(async () => ({ added: [], removed: [], errors: [] })),
    reloadSession: mock(async () => ({})),
    activateSkill: mock(async () => {}),
    promptWithSkills: mock(async () => {}),
    getPluginInfo: mock(async (id: string) => ({
      id,
      displayName: id,
      version: '1.0.0',
      enabled: true,
      state: 'ok',
      skillCount: 1,
      mcpServerCount: 0,
      enabledMcpServerCount: 0,
      hasErrors: false,
      source: 'local-path',
      root: `/plugins/${id}`,
      manifest: undefined,
      mcpServers: [],
      diagnostics: [],
    })),
    ...overrides,
  };
}

export function makeHarness(session = makeSession(), overrides: Record<string, unknown> = {}) {
  const interactiveAgentScope = new AsyncLocalStorage<string>();
  const harness = {
    getConfig: mock(async () => ({
      models: {
        k2: { model: 'moonshot-v1', maxContextSize: 100 },
      },
    })),
    setConfig: mock(async () => ({ providers: {} })),
    createSession: mock(async () => session),
    resumeSession: mock(async () => session),
    forkSession: mock(async () => session),
    reloadSession: mock(async () => session),
    listSessions: mock(async () => []),
    exportSession: mock(async () => ({
      zipPath: '/tmp/fake-session.zip',
      entries: ['manifest.json', 'state.json'],
      sessionDir: '/tmp/session-a',
      manifest: {},
    })),
    deleteFile: mock(async () => {}),
    close: mock(async () => {}),
    track: mock(),
    trackWithContext: mock(),
    setTelemetryContext: mock(),
    get interactiveAgentId() {
      return interactiveAgentScope.getStore() ?? 'main';
    },
    withInteractiveAgent: mock((agentId: string, fn: () => unknown) => {
      return interactiveAgentScope.run(agentId, fn);
    }),
    getExperimentalFeatures: mock(async () => []),
    onConfigSectionChanged: mock(() => () => {}),
    auth: {
      status: mock(async () => ({
        providers: [{ providerName: 'managed:kimi-code', hasToken: true }],
      })),
      login: mock(),
      logout: mock(),
      getManagedUsage: mock(),
      submitFeedback: mock(
        async (): Promise<
          { kind: 'ok'; feedbackId: number } | { kind: 'error'; status?: number; message: string }
        > => ({
          kind: 'ok',
          feedbackId: 3,
        }),
      ),
    },
    ...overrides,
  };
  if (!('listSessionsPage' in harness)) {
    const listSessions = harness.listSessions as (input?: {
      workDir?: string;
      sessionId?: string;
    }) => Promise<unknown[]>;
    Object.assign(harness, {
      listSessionsPage: mock(async (input: { workDir?: string; sessionId?: string } = {}) => ({
        items: await listSessions({ workDir: input.workDir, sessionId: input.sessionId }),
        nextCursor: undefined,
      })),
    });
  }
  return harness;
}

const tempDirs: string[] = [];

export async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-code-tui-'));
  tempDirs.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  const { rm } = await import('node:fs/promises');
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function makeDriver(
  session = makeSession(),
  harnessOverrides: Record<string, unknown> = {},
  startupInput?: KimiTUIStartupInput,
): Promise<{
  driver: MessageDriver;
  session: ReturnType<typeof makeSession>;
  harness: ReturnType<typeof makeHarness>;
}> {
  const harness = makeHarness(session, harnessOverrides);
  const driver = new KimiTUI(
    harness as never,
    startupInput ?? makeStartupInput(),
  ) as unknown as MessageDriver;
  spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
  spyOn(driver.state.terminal, 'setProgress').mockImplementation(() => {});
  driver.persistInputHistory = mock(async () => {});
  await driver.init();
  if (startupInput === undefined) {
    await driver.setSession(session);
    await driver.syncRuntimeState(session);
  }
  return { driver, session, harness };
}

export function renderTranscript(driver: MessageDriver): string {
  return driver.state.transcriptContainer.render(120).join('\n');
}

export function emitTurn(driver: MessageDriver, turnId: number, between?: () => void): void {
  driver.sessionEventHandler.handleEvent(
    { type: 'turn.started', agentId: 'main', turnId, origin: { kind: 'user' } } as Event,
    () => {},
  );
  between?.();
  driver.sessionEventHandler.handleEvent(
    { type: 'turn.ended', agentId: 'main', turnId, reason: 'completed' } as Event,
    () => {},
  );
}
