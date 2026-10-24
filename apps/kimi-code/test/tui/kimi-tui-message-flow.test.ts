import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';

import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { deleteAllKittyImages, resetCapabilitiesCache, setCapabilities, type TuiMouseEvent } from '@moonshot-ai/pi-tui';
import { createKimiHarness, type ApprovalRequest, type ApprovalResponse, type Event, type GoalSnapshot, type Session } from '@moonshot-ai/kimi-code-sdk';
import { afterEach, describe, expect, it, jest, mock, spyOn, type Mock } from 'bun:test';
import { type AddressInfo } from 'node:net';
import { readE2EFlags } from '#test/helpers/e2e-flags';
import { createFakeClock, type FakeClock } from '#test/helpers/fake-clock';
import { setGlobal } from '#test/helpers/stubs';
import { waitForAssertion } from '#test/helpers/waitFor';


import { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import { CacheHintDialogComponent } from '#/tui/components/dialogs/cache-hint-dialog';
import * as cacheHintConfig from '#/utils/cache-hint-config';
import { EffortSelectorComponent } from '#/tui/components/dialogs/effort-selector';
import { kimiCodePluginMarketplaceUrl } from '#/constant/app';
import { handleFeedbackCommand } from '#/tui/commands/info';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import { openUrl } from '#/utils/open-url';
import { createFeedbackArchivePath } from '../../src/feedback/archive';
import * as feedbackArchiveModule from '../../src/feedback/archive';
import { packageCodebase, scanCodebase } from '../../src/feedback/codebase';
import * as feedbackCodebaseModule from '../../src/feedback/codebase';
import { ErrorCodes, KimiError } from '@moonshot-ai/kimi-code-sdk';
import { uploadArchive } from '../../src/feedback/upload';
import * as feedbackUploadModule from '../../src/feedback/upload';
import { promptFeedbackAttachment, promptFeedbackInput, runModelSelector, type FeedbackPromptResult } from '#/tui/commands/prompts';
import * as promptsModule from '#/tui/commands/prompts';
import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import { ModelSelectorComponent } from '#/tui/components/dialogs/model-selector';
import { PermissionSelectorComponent } from '#/tui/components/dialogs/permission-selector';
import { PluginInstallTrustConfirmComponent, PluginMcpSelectorComponent, PluginRemoveConfirmComponent, PluginsPanelComponent } from '#/tui/components/dialogs/plugins-selector';
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';
import { UndoSelectorComponent } from '#/tui/components/dialogs/undo-selector';
import { AgentSwarmProgressComponent, agentSwarmGridHeightForTerminalRows } from '#/tui/components/messages/agent-swarm-progress';
import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { StepSummaryComponent } from '#/tui/components/messages/step-summary';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { BtwPanelComponent } from '#/tui/components/panes/btw-panel';
import { MOON_SPINNER_FRAMES } from '#/tui/constant/rendering';
import { STREAMING_UI_FLUSH_MS } from '#/tui/constant/streaming';
import { SessionReplayRenderer } from '#/tui/controllers/session-replay';
import { StreamingUIController, type StreamingUIHost } from '#/tui/controllers/streaming-ui';
import { SurveyController } from '#/tui/controllers/survey-controller';
import { KimiTUI, type KimiTUIStartupInput, type TUIState } from '#/tui/kimi-tui';
import { type QueuedMessage, type TranscriptEntry } from '#/tui/types';
import { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';
import { extractMediaAttachments, type ExtractionResult } from '#/tui/utils/image-placeholder';
import type { RenderTimerHandle } from '#/tui/utils/render-clock';
import { groupTurns, TRANSCRIPT_KEEP_RECENT_ASSISTANT, TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED, TRANSCRIPT_KEEP_RECENT_STEPS } from '#/tui/utils/transcript-window';

void mock.module('#/tui/commands/prompts', () => ({
  ...promptsModule,
  promptFeedbackInput: mock(),
  promptFeedbackAttachment: mock(),
}));

void mock.module('../../src/feedback/codebase', () => ({
  ...feedbackCodebaseModule,
  scanCodebase: mock().mockResolvedValue(undefined),
  packageCodebase: mock(),
}));

void mock.module('../../src/feedback/upload', () => ({
  ...feedbackUploadModule,
  uploadArchive: mock(),
}));

void mock.module('../../src/feedback/archive', () => ({
  ...feedbackArchiveModule,
  createFeedbackArchivePath: mock(feedbackArchiveModule.createFeedbackArchivePath),
}));

void mock.module('#/utils/open-url', () => ({ openUrl: mock() }));

void mock.module('#/utils/clipboard/clipboard-text', () => ({
  copyTextToClipboard: mock(async () => 'native'),
}));

const promptFeedbackInputMock = promptFeedbackInput as Mock<typeof promptFeedbackInput>;
const promptFeedbackAttachmentMock = promptFeedbackAttachment as Mock<typeof promptFeedbackAttachment>;
const openUrlMock = openUrl as Mock<typeof openUrl>;
const scanCodebaseMock = scanCodebase as Mock<typeof scanCodebase>;
const packageCodebaseMock = packageCodebase as Mock<typeof packageCodebase>;
const uploadArchiveMock = uploadArchive as Mock<typeof uploadArchive>;
const createFeedbackArchivePathMock = createFeedbackArchivePath as Mock<typeof createFeedbackArchivePath>;
const copyTextToClipboardMock = copyTextToClipboard as Mock<typeof copyTextToClipboard>;

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

function stripSgr(text: string): string {
  return text
    .replaceAll(/\u001B\[[0-9;]*m/g, '')
    .replaceAll(new RegExp(`${ESC}\\]8;;[^${BEL}]*${BEL}`, 'g'), '');
}

interface MessageDriver {
  state: TUIState;
  btwPanelController: KimiTUI['btwPanelController'];
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
  switchToSession(session: Session, statusMessage: string): Promise<void>;
  reloadCurrentSessionView(session: Session, statusMessage: string): Promise<void>;
  createNewSession(): Promise<void>;
  syncRuntimeState(session?: unknown): Promise<void>;
  getCurrentSessionId(): string;
}

interface FeedbackDriver extends MessageDriver {
  handleFeedbackCommand(): Promise<void>;
  promptFeedbackInput(): Promise<FeedbackPromptResult | undefined>;
}

interface ModelSelectorDriver extends MessageDriver {
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

function makeStartupInput(): KimiTUIStartupInput {
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

function makeSession(overrides: Record<string, unknown> = {}) {
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
          context: { history: [] },
          replay: [],
          userTurnCount: 0,
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

function makeHarness(session = makeSession(), overrides: Record<string, unknown> = {}) {
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

async function makeDriver(
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

function makeActiveGoalSnapshot(): GoalSnapshot {
  return {
    goalId: 'g1',
    objective: 'Ship the feature',
    status: 'active',
    turnsUsed: 3,
    tokensUsed: 100,
    inputTokensUsed: 60,
    outputTokensUsed: 40,
    createdAt: 1000,
    updatedAt: 2000,
    wallClockMs: 1000,
    budget: {
      tokenBudget: null,
      turnBudget: null,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: null,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
      inputTokensUsed: 60,
      outputTokensUsed: 40,
    },
  };
}

function renderTranscript(driver: MessageDriver): string {
  return driver.state.transcriptContainer.render(120).join('\n');
}

function requestRenderSpy(driver: MessageDriver): Mock<TUIState['ui']['requestRender']> {
  return driver.state.ui.requestRender as Mock<TUIState['ui']['requestRender']>;
}

function readStreamingPhase(driver: MessageDriver): TUIState['appState']['streamingPhase'] {
  return driver.state.appState.streamingPhase;
}

function readEditorInputMode(driver: MessageDriver): TUIState['editor']['inputMode'] {
  return driver.state.editor.inputMode;
}

function readAppInputMode(driver: MessageDriver): TUIState['appState']['inputMode'] {
  return driver.state.appState.inputMode;
}

function readPermissionMode(driver: MessageDriver): TUIState['appState']['permissionMode'] {
  return driver.state.appState.permissionMode;
}

async function confirmUndoSelection(driver: MessageDriver): Promise<void> {
  await waitForAssertion(() => {
    expect(driver.state.editorContainer.children[0]).toBeInstanceOf(UndoSelectorComponent);
  });
  (driver.state.editorContainer.children[0] as UndoSelectorComponent).handleInput('\r');
}

function renderActivity(driver: MessageDriver): string {
  return driver.state.activityContainer.render(120).join('\n');
}

function renderBtwPanel(driver: MessageDriver): string {
  return driver.state.btwPanelContainer.render(120).join('\n');
}

function getMountedBtwPanel(driver: MessageDriver): BtwPanelComponent {
  const panel = driver.state.btwPanelContainer.children.find(
    (child) => child instanceof BtwPanelComponent,
  );
  if (panel === undefined) throw new Error('Expected a mounted /btw panel.');
  return panel;
}

async function openBtwPanel(
  driver: MessageDriver,
  session: ReturnType<typeof makeSession>,
  prompt = 'side question',
): Promise<void> {
  driver.handleUserInput(`/btw ${prompt}`);
  await waitForAssertion(() => {
    expect(session.startBtw).toHaveBeenCalled();
    expect(driver.state.btwPanelContainer.children).toHaveLength(2);
  });
}

function setTerminalRows(driver: MessageDriver, rows: number): void {
  Object.defineProperty(driver.state.terminal, 'rows', {
    configurable: true,
    get: () => rows,
  });
}

function setTerminalColumns(driver: MessageDriver, columns: number): void {
  Object.defineProperty(driver.state.terminal, 'columns', {
    configurable: true,
    get: () => columns,
  });
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const tempDirs: string[] = [];
const originalKimiCodeHome = process.env['KIMI_CODE_HOME'];
const originalPluginMarketplaceUrl = process.env['KIMI_CODE_PLUGIN_MARKETPLACE_URL'];
const originalVisual = process.env['VISUAL'];
const originalEditor = process.env['EDITOR'];

/**
 * The real-port twin of the video-upload abort case is opt-in: the fetch-stub
 * case covers the same abort semantics without binding a socket. `KIMI_E2E`
 * (set by `bun run e2e` and by the heavy CI run) turns it on.
 */
const runRealHttpE2E = readE2EFlags(process.env).e2e;

const realSetImmediate = setImmediate;
const realPerformanceNow = performance.now;
const realGlobalTimers = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  now: Date.now,
};

async function settlePendingWork(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      realSetImmediate(resolve);
    });
  }
}

async function advanceFakeTime(by: number): Promise<void> {
  jest.advanceTimersByTime(by);
  await settlePendingWork();
}

async function advanceClockAsync(clock: FakeClock, byMs: number): Promise<void> {
  await settlePendingWork();
  clock.advance(byMs);
  await settlePendingWork();
}

/** Swaps the streaming controller for one whose flush/pump timers run on `clock`. */
function useStreamingClock(driver: MessageDriver, clock: FakeClock): void {
  (driver as unknown as { streamingUI: StreamingUIController }).streamingUI =
    new StreamingUIController(driver as unknown as StreamingUIHost, { clock });
}

/**
 * Puts the ambient clock and timer APIs on `clock`, for the cases whose delay
 * is owned by a module that takes no injectable time source. `Date.now` and
 * `performance.now` follow the clock too, so idempotence and cooldown windows
 * measured against either one advance with it.
 */
function installGlobalClock(): FakeClock {
  const clock = createFakeClock(Date.now());
  const installedAtMs = clock.now();
  // `performance.now` keeps its own origin, so it continues from where the real
  // one stood and only advances with the clock. Its origin is rounded so that
  // elapsed deltas stay exact integers.
  const monotonicOrigin = Math.round(realPerformanceNow());
  const schedule =
    (interval: boolean) =>
    (callback: unknown, delayMs?: number, ...args: unknown[]): RenderTimerHandle => {
      if (typeof callback !== 'function') throw new Error('timer body must be a function');
      const run = (): void => {
        (callback as (...callArgs: unknown[]) => void)(...args);
      };
      return interval ? clock.setInterval(run, delayMs ?? 0) : clock.setTimeout(run, delayMs ?? 0);
    };
  globalThis.setTimeout = schedule(false) as unknown as typeof globalThis.setTimeout;
  globalThis.setInterval = schedule(true) as unknown as typeof globalThis.setInterval;
  globalThis.clearTimeout = ((handle: unknown) => {
    clock.clearTimeout(handle as RenderTimerHandle);
  }) as unknown as typeof globalThis.clearTimeout;
  globalThis.clearInterval = ((handle: unknown) => {
    clock.clearInterval(handle as RenderTimerHandle);
  }) as unknown as typeof globalThis.clearInterval;
  Date.now = () => clock.now();
  performance.now = () => monotonicOrigin + (clock.now() - installedAtMs);
  return clock;
}

function restoreGlobalClock(): void {
  globalThis.setTimeout = realGlobalTimers.setTimeout;
  globalThis.setInterval = realGlobalTimers.setInterval;
  globalThis.clearTimeout = realGlobalTimers.clearTimeout;
  globalThis.clearInterval = realGlobalTimers.clearInterval;
  Date.now = realGlobalTimers.now;
  performance.now = realPerformanceNow;
}

/** The SSE answer that makes the engine read `clip.mp4` and upload it. */
function videoUploadChatStream(): string {
  const chunks = [
    {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'mock',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_video_1',
                type: 'function',
                function: { name: 'Read', arguments: '{"path":"clip.mp4"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'mock',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    },
  ];
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
}

async function uploadedFileSize(body: unknown): Promise<number> {
  if (!(body instanceof FormData)) throw new Error('expected a multipart upload body');
  const file = body.get('file');
  if (!(file instanceof Blob)) throw new Error('expected a file part in the upload body');
  return (await file.arrayBuffer()).byteLength;
}

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-code-tui-'));
  tempDirs.push(dir);
  return dir;
}

function stagedImage(imageStore: ImageAttachmentStore, fileId: string) {
  return imageStore.addImage(new Uint8Array([0xaa, 0xbb]), 'image/png', 1, 1, undefined, fileId);
}

/**
 * Emits the turn.started/turn.ended pair that claims and then releases a
 * staged-media lease; `between` runs assertions after the claim.
 */
function emitTurn(
  driver: MessageDriver,
  turnId: number,
  between?: () => void,
  origin: { kind: string } = { kind: 'user' },
): void {
  driver.sessionEventHandler.handleEvent(
    { type: 'turn.started', agentId: 'main', turnId, origin } as Event,
    () => {},
  );
  between?.();
  driver.sessionEventHandler.handleEvent(
    { type: 'turn.ended', agentId: 'main', turnId, reason: 'completed' } as Event,
    () => {},
  );
}

async function makeExportedSessionZip(content = 'session zip'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-code-feedback-export-'));
  tempDirs.push(dir);
  const zipPath = join(dir, 'session.zip');
  await writeFile(zipPath, content);
  return zipPath;
}

afterEach(async () => {
  resetCapabilitiesCache();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  if (originalKimiCodeHome === undefined) {
    delete process.env['KIMI_CODE_HOME'];
  } else {
    process.env['KIMI_CODE_HOME'] = originalKimiCodeHome;
  }
  if (originalVisual === undefined) {
    delete process.env['VISUAL'];
  } else {
    process.env['VISUAL'] = originalVisual;
  }
  if (originalPluginMarketplaceUrl === undefined) {
    delete process.env['KIMI_CODE_PLUGIN_MARKETPLACE_URL'];
  } else {
    process.env['KIMI_CODE_PLUGIN_MARKETPLACE_URL'] = originalPluginMarketplaceUrl;
  }
  if (originalEditor === undefined) {
    delete process.env['EDITOR'];
  } else {
    process.env['EDITOR'] = originalEditor;
  }
});

describe('KimiTUI message flow', () => {
  it('tracks editor shortcut and paste hooks', async () => {
    const { driver, harness } = await makeDriver();
    harness.track.mockClear();

    driver.state.editor.handleInput('\u001F');
    delete process.env['VISUAL'];
    delete process.env['EDITOR'];
    driver.state.editor.onOpenExternalEditor?.();
    driver.state.editor.onToggleToolExpand?.();
    driver.state.editor.onTextPaste?.();

    expect(harness.track).toHaveBeenCalledWith('undo', undefined);
    expect(harness.track).toHaveBeenCalledWith('shortcut_editor', undefined);
    expect(harness.track).toHaveBeenCalledWith('shortcut_expand', undefined);
    expect(harness.track).toHaveBeenCalledWith('shortcut_paste', { kind: 'text' });
  });

  it('lazily creates the session on the first message (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(session, {}, startupInput);

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(driver.state.appState.sessionId).toBe('');
    expect(driver.state.appState.model).toBe('k2');

    driver.handleUserInput('hello');

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith('hello', { promptId: undefined });
    });
    expect(harness.createSession).toHaveBeenCalledTimes(1);
    expect(harness.createSession).toHaveBeenCalledWith({
      workDir: '/tmp/proj-a',
      model: 'k2',
      thinking: undefined,
      permission: 'manual',
      planMode: undefined,
    });
    expect(driver.getCurrentSessionId()).toBe('ses-lazy');
  });

  it('lazily creates the session for session-requiring slash commands (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(session, {}, startupInput);

    expect(harness.createSession).not.toHaveBeenCalled();

    driver.handleUserInput('/compact');

    await waitForAssertion(() => {
      expect(session.compact).toHaveBeenCalledWith({ instruction: undefined });
    });
    expect(harness.createSession).toHaveBeenCalledTimes(1);
    expect(driver.getCurrentSessionId()).toBe('ses-lazy');
  });

  it('lazily creates the session for skill commands (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy', activateSkill: mock(async () => {}) });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(
      session,
      {
        listWorkspaceSkills: mock(async () => [
          {
            name: 'my-skill',
            description: 'A test skill',
            path: '/tmp/my-skill',
            source: 'user',
          },
        ]),
        listPluginCommands: mock(async () => []),
      },
      startupInput,
    );
    // `makeDriver` stops after init(); the skill command list is refreshed in
    // finishStartup, so resolve it here to exercise the workspace-level path.
    await (driver as unknown as { refreshSkillCommands(): Promise<void> }).refreshSkillCommands();

    expect(harness.createSession).not.toHaveBeenCalled();

    driver.handleUserInput('/skill:my-skill src/app.ts');

    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledWith(
        '/skill:my-skill src/app.ts',
        [{ name: 'my-skill', args: 'src/app.ts' }],
      );
      expect(driver.state.transcriptEntries.filter((entry) => entry.kind === 'user')).toMatchObject([
        { content: '/skill:my-skill src/app.ts' },
      ]);
    });
    expect(session.activateSkill).not.toHaveBeenCalled();
    expect(harness.createSession).toHaveBeenCalledTimes(1);
    expect(driver.getCurrentSessionId()).toBe('ses-lazy');
  });

  it('submits inline skill tokens with the prompt as one grouped submission (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(
      session,
      {
        listWorkspaceSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
          {
            name: 'security',
            description: 'Security skill',
            path: '/tmp/security',
            source: 'user',
          },
        ]),
        listPluginCommands: mock(async () => []),
      },
      startupInput,
    );
    await (driver as unknown as { refreshSkillCommands(): Promise<void> }).refreshSkillCommands();

    driver.handleUserInput('please /skill:review and /skill:security this change');

    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledWith(
        'please /skill:review and /skill:security this change',
        [{ name: 'review' }, { name: 'security' }],
      );
    });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.activateSkill).not.toHaveBeenCalled();
  });

  it('combines a leading skill command with later inline skills into one submission (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(
      session,
      {
        listWorkspaceSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
          {
            name: 'security',
            description: 'Security skill',
            path: '/tmp/security',
            source: 'user',
          },
        ]),
        listPluginCommands: mock(async () => []),
      },
      startupInput,
    );
    await (driver as unknown as { refreshSkillCommands(): Promise<void> }).refreshSkillCommands();

    driver.handleUserInput('/skill:review check this /skill:security');

    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledWith(
        '/skill:review check this /skill:security',
        [{ name: 'review' }, { name: 'security' }],
      );
    });
    expect(session.activateSkill).not.toHaveBeenCalled();
  });

  it('bundles a repeated leading skill as one bundled submission (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(
      session,
      {
        listWorkspaceSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
        ]),
        listPluginCommands: mock(async () => []),
      },
      startupInput,
    );
    await (driver as unknown as { refreshSkillCommands(): Promise<void> }).refreshSkillCommands();

    driver.handleUserInput('/skill:review check /skill:review');

    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledWith('/skill:review check /skill:review', [
        { name: 'review' },
      ]);
    });
    expect(session.activateSkill).not.toHaveBeenCalled();
  });

  it('passes no args in a bundle while media rides the prompt parts (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(
      session,
      {
        listWorkspaceSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
          {
            name: 'security',
            description: 'Security skill',
            path: '/tmp/security',
            source: 'user',
          },
        ]),
        listPluginCommands: mock(async () => []),
      },
      startupInput,
    );
    await (driver as unknown as { refreshSkillCommands(): Promise<void> }).refreshSkillCommands();
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addImage(new Uint8Array([0xaa, 0xbb]), 'image/png', 1, 1);

    driver.handleUserInput(`/skill:review inspect ${attachment.placeholder} /skill:security`);

    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledWith(
        [
          { type: 'text', text: '/skill:review inspect ' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
          { type: 'text', text: ' /skill:security' },
        ],
        [{ name: 'review' }, { name: 'security' }],
      );
    });
  });

  it('bundles newline-separated skills with the leading one included (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(
      session,
      {
        listWorkspaceSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
          {
            name: 'security',
            description: 'Security skill',
            path: '/tmp/security',
            source: 'user',
          },
        ]),
        listPluginCommands: mock(async () => []),
      },
      startupInput,
    );
    await (driver as unknown as { refreshSkillCommands(): Promise<void> }).refreshSkillCommands();

    driver.handleUserInput('/skill:review\ncheck this /skill:security');

    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledWith(
        '/skill:review\ncheck this /skill:security',
        [{ name: 'review' }, { name: 'security' }],
      );
    });
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it('scans inline skills in messages that start with an unknown slash token (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(
      session,
      {
        listWorkspaceSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
        ]),
        listPluginCommands: mock(async () => []),
      },
      startupInput,
    );
    await (driver as unknown as { refreshSkillCommands(): Promise<void> }).refreshSkillCommands();

    driver.handleUserInput('/dance please use /skill:review');

    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledWith('/dance please use /skill:review', [
        { name: 'review' },
      ]);
    });
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it.each([
    { input: '/skill:review check', skills: [{ name: 'review', args: 'check' }] },
    { input: 'check /skill:review', skills: [{ name: 'review' }] },
    { input: '/skill:review check /skill:review', skills: [{ name: 'review' }] },
  ])('submits a skill prompt at an idle goal boundary ($input)', async ({ input, skills }) => {
    const session = makeSession({
      id: 'ses-lazy',
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(
      session,
      {
        listWorkspaceSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
        ]),
        listPluginCommands: mock(async () => []),
      },
      startupInput,
    );
    await (driver as unknown as { refreshSkillCommands(): Promise<void> }).refreshSkillCommands();
    // Materialize the lazy session first: an active goal only exists inside a
    // live session, and lazy creation would refresh (and clear) the goal
    // snapshot set up below.
    await (driver as unknown as { ensureSession(): Promise<unknown> }).ensureSession();
    driver.state.appState.goal = makeActiveGoalSnapshot();

    driver.state.editor.setText(input);
    driver.state.editor.handleInput('\r');

    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledWith(input, skills);
    });
    expect(driver.state.queuedMessages).toEqual([]);
    expect(driver.state.appState.goal?.status).toBe('active');
  });

  it.each([false, true])('queues a leading-combo bundle while busy instead of rejecting it (goal=%s)', async (goalActive) => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(
      session,
      {
        listWorkspaceSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
          {
            name: 'security',
            description: 'Security skill',
            path: '/tmp/security',
            source: 'user',
          },
        ]),
        listPluginCommands: mock(async () => []),
      },
      startupInput,
    );
    await (driver as unknown as { ensureSession(): Promise<unknown> }).ensureSession();
    await (
      driver as unknown as { refreshSkillCommands(): Promise<void> }
    ).refreshSkillCommands();
    if (goalActive) driver.state.appState.goal = makeActiveGoalSnapshot();
    driver.state.appState.streamingPhase = 'waiting';

    driver.handleUserInput('/skill:review check this /skill:security');

    expect(session.promptWithSkills).not.toHaveBeenCalled();
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toEqual([
        expect.objectContaining({
          text: '/skill:review check this /skill:security',
          inlineSkillActivations: [{ skillName: 'review' }, { skillName: 'security' }],
        }),
      ]);
    });
  });

  it('keeps submitted skill history when the grouped submission is rejected (v2 engine)', async () => {
    const session = makeSession({
      id: 'ses-lazy',
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
      promptWithSkills: mock(async () => {
        throw new Error('Skill "review" was not found');
      }),
    });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(
      session,
      {
        listWorkspaceSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
        ]),
        listPluginCommands: mock(async () => []),
      },
      startupInput,
    );
    await (driver as unknown as { refreshSkillCommands(): Promise<void> }).refreshSkillCommands();

    driver.handleUserInput('please /skill:review');

    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalled();
    });
    await waitForAssertion(() => {
      expect(readStreamingPhase(driver)).toBe('idle');
    });
    expect(driver.state.transcriptEntries.filter((entry) => entry.kind === 'user')).toMatchObject([
      { content: 'please /skill:review', skillNames: ['review'] },
    ]);
  });

  it('refreshes the view through the stale-reload handler while the prompt stays in flight (v2 engine)', async () => {
    let staleReload!: () => Promise<void>;
    let releasePrompt!: () => void;
    const session = makeSession({
      id: 'ses-1',
      setStaleReloadHandler: mock((handler: () => Promise<void>) => {
        staleReload = handler;
      }),
      prompt: mock(
        () =>
          new Promise<void>((resolve) => {
            releasePrompt = resolve;
          }),
      ),
    });
    const { driver, harness } = await makeDriver(session, { reloadSession: mock() });

    driver.handleUserInput('original message');
    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledTimes(1);
    });
    driver.handleUserInput('queued while reloading');
    driver.state.editor.setText('typed during reload');

    await staleReload();

    expect(driver.state.appState.streamingPhase).not.toBe('idle');
    expect(driver.state.transcriptEntries.filter((entry) => entry.kind === 'user')).toMatchObject([
      { content: 'original message' },
    ]);
    expect(driver.state.queuedMessages).toMatchObject([{ text: 'queued while reloading' }]);
    expect(driver.state.editor.getText()).toBe('typed during reload');
    expect(harness.reloadSession).not.toHaveBeenCalled();
    expect(session.close).not.toHaveBeenCalled();
    expect(session.prompt).toHaveBeenCalledTimes(1);
    releasePrompt();
  });

  it('asks to rerun /undo after the SDK reloaded a stale session (v2 engine)', async () => {
    const session = makeSession({
      id: 'ses-1',
      undoHistory: mock(async () => {
        throw new KimiError(ErrorCodes.SESSION_STALE, 'stale');
      }),
    });
    const { driver, harness } = await makeDriver(session, { reloadSession: mock() });

    driver.handleUserInput('hello');
    driver.state.appState.streamingPhase = 'idle';
    driver.handleUserInput('/undo');
    await confirmUndoSelection(driver);

    await waitForAssertion(() => {
      expect(stripSgr(renderTranscript(driver))).toContain('run /undo again');
    });
    expect(harness.reloadSession).not.toHaveBeenCalled();
  });

  it.each([
    ['two words', '/plug:cmd two words'],
    ['', '/plug:cmd'],
  ])('shows a wrapped occupied notice and restores the plugin command after cancellation', async (args, expected) => {
    const message =
      'This session is in use by another Kimi Code process. Stop the session in that process or exit it, then try again.';
    const session = makeSession({
      activatePluginCommand: mock(async () => {
        throw new KimiError(ErrorCodes.SESSION_OCCUPIED, message);
      }),
    });
    const { driver } = await makeDriver(session);

    (
      driver as unknown as {
        activatePluginCommand(s: unknown, pluginId: string, command: string, value: string): void;
      }
    ).activatePluginCommand(session, 'plug', 'cmd', args);
    await waitForAssertion(() => {
      expect(driver.state.editorReplacementMounted).toBe(true);
    });
    const picker = driver.state.editorContainer.children[0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    const output = stripSgr(picker.render(40).join(' ')).replaceAll(/\s+/g, ' ');
    expect(output).toContain('Session in use');
    expect(output).toContain(message);
    picker.handleInput('\u001B');

    expect(driver.state.editor.getText()).toBe(expected);
  });

  it.each([
    ['takes over the lock and resends', true],
    ['gives the message back', false],
  ] as const)('offers takeover once a retry is still occupied and %s', async (_label, takeOver) => {
    const occupied = new KimiError(ErrorCodes.SESSION_OCCUPIED, 'in use');
    const prompt = mock(async (_input: unknown) => {})
      .mockRejectedValueOnce(occupied)
      .mockRejectedValueOnce(occupied);
    const takeOverLock = mock(async () => {});
    const session = makeSession({ prompt, takeOverLock });
    const { driver } = await makeDriver(session);
    type Picker = { handleInput(data: string): void; render(width: number): string[] };
    const picker = (): Picker => driver.state.editorContainer.children[0] as Picker;

    driver.handleUserInput('hello');
    await waitForAssertion(() => {
      expect(stripSgr(picker().render(80).join(' '))).toContain('Session in use');
    });
    const first = stripSgr(picker().render(80).join(' '));
    expect(first).not.toContain('Take over');
    picker().handleInput('\r');

    await waitForAssertion(() => {
      expect(stripSgr(picker().render(80).join(' '))).toContain('Session still in use');
    });
    expect(stripSgr(picker().render(120).join(' '))).toContain(
      'If another Kimi Code process is still running, taking over may mix up the history.',
    );
    if (takeOver) picker().handleInput('\u001B[B');
    picker().handleInput('\r');

    if (takeOver) {
      await waitForAssertion(() => {
        expect(prompt).toHaveBeenCalledTimes(3);
      });
      expect(takeOverLock).toHaveBeenCalledTimes(1);
    } else {
      await waitForAssertion(() => {
        expect(driver.state.editor.getText()).toBe('hello');
      });
      expect(prompt).toHaveBeenCalledTimes(2);
      expect(takeOverLock).not.toHaveBeenCalled();
    }
  });

  it('renders a bundled replay submission as a single turn', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(session, {}, startupInput);
    (session.getResumeState as Mock<(...args: any[]) => any>).mockReturnValue({
      sessionMetadata: {},
      agents: {
        main: {
          config: { modelCapabilities: { max_context_tokens: 100 }, modelAlias: 'k2' },
          plan: null,
          permission: { mode: 'manual' },
          swarmMode: false,
          context: { history: [], tokenCount: 0 },
          background: [],
          toolStore: {},
          replay: [
            {
              type: 'message',
              time: 1,
              message: {
                role: 'user',
                content: [{ type: 'text', text: 'earlier question' }],
                toolCalls: [],
                origin: { kind: 'user' },
              },
            },
            {
              type: 'message',
              time: 2,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'earlier answer' }],
                toolCalls: [],
              },
            },
            {
              type: 'message',
              time: 3,
              message: {
                role: 'user',
                content: [{ type: 'text', text: 'hook note' }],
                toolCalls: [],
                origin: { kind: 'hook_result', event: 'UserPromptSubmit' },
              },
            },
            {
              type: 'message',
              time: 4,
              message: {
                role: 'user',
                content: [
                  { type: 'text', text: 'skill card A body' },
                  { type: 'text', text: 'skill card B body' },
                  { type: 'text', text: 'please /skill:review and /skill:security' },
                ],
                toolCalls: [],
                origin: {
                  kind: 'user',
                  skillActivations: [
                    { activationId: 'act-1', skillName: 'review' },
                    { activationId: 'act-2', skillName: 'security' },
                  ],
                },
              },
            },
            {
              type: 'message',
              time: 5,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'bundled answer' }],
                toolCalls: [],
              },
            },
            {
              type: 'message',
              time: 6,
              message: {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'skill card C body',
                    meta: { source: 'skill activation', activationId: 'act-3' },
                  },
                  { type: 'text', text: 'please /commit' },
                ],
                toolCalls: [],
                origin: {
                  kind: 'user',
                  skillActivations: [{ activationId: 'act-3', skillName: 'commit' }],
                },
              },
            },
          ],
        },
      },
    });

    const replayed = await driver.sessionReplay.hydrateFromReplay(session as unknown as Session);
    expect(replayed).toBe(true);

    const turns = groupTurns(driver.state.transcriptEntries);
    expect(turns).toHaveLength(3);
    expect(turns[1]!.entries.map((entry) => entry.kind)).toEqual(['assistant', 'user', 'assistant']);
    expect(turns[1]!.entries[0]!.hookResult).toBe(true);
    expect(turns[1]!.entries[1]!.content).toBe('please /skill:review and /skill:security');
    expect(turns[1]!.entries[1]!.skillNames).toEqual(['review', 'security']);
    expect(turns[2]!.entries.map((entry) => entry.kind)).toEqual(['user']);
    expect(turns[2]!.entries[0]!.content).toBe('please /commit');
    expect(stripSgr(renderTranscript(driver))).not.toContain('skill card');
  });

  it('pages Updates with Ctrl+N and the bracket keys while keeping the editor focused', async () => {
    const { driver } = await makeDriver(makeSession());
    const notifications = driver.sessionEventHandler.notifications;
    notifications.setEnabled(true);
    notifications.handleEvent({
      type: 'turn.started',
      agentId: 'main',
      sessionId: 's1',
      turnId: 1,
      origin: { kind: 'user' },
    });
    for (const [toolCallId, message] of [
      ['n1', 'first update'],
      ['n2', 'second update'],
      ['n3', 'third update'],
    ] as const) {
      notifications.handleEvent({
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 's1',
        turnId: 1,
        toolCallId,
        name: 'NotifyUser',
        args: { message },
      });
      notifications.handleEvent({
        type: 'tool.result',
        agentId: 'main',
        sessionId: 's1',
        turnId: 1,
        toolCallId,
        output: 'Update shown to the user.',
      });
    }
    driver.state.editor.setText('unsent follow-up');
    const cursor = driver.state.editor.getCursor();
    const setFocus = spyOn(driver.state.ui, 'setFocus');
    expect(driver.state.notifyPanel.render(100)[0]).toContain('Updates 3/3');
    driver.state.editor.handleInput('\u000E');
    expect(driver.state.notifyPanel.render(100)[0]).toContain('esc close');
    // `[`/`]` step between updates; the arrows scroll the current one instead.
    driver.state.editor.handleInput('[');
    expect(driver.state.notifyPanel.render(100)[0]).toContain('Updates 2/3');
    driver.state.editor.handleInput(']');
    expect(driver.state.notifyPanel.render(100)[0]).toContain('Updates 3/3');
    driver.state.editor.handleInput('\u001B');
    expect(driver.state.notifyPanel.render(100)[0]).toContain('ctrl+n page');
    expect(setFocus).not.toHaveBeenCalled();
    expect(driver.state.editor.getText()).toBe('unsent follow-up');
    expect(driver.state.editor.getCursor()).toEqual(cursor);
  });

  it('does not restore old NotifyUser updates into the panel', async () => {
    const session = makeSession({ id: 'ses-notify-replay' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(session, {}, startupInput);
    driver.sessionEventHandler.notifications.setEnabled(true);
    (session.getResumeState as Mock<(...args: any[]) => any>).mockReturnValue({
      sessionMetadata: {},
      agents: {
        main: {
          config: { modelCapabilities: { max_context_tokens: 100 }, modelAlias: 'k2' },
          plan: null,
          permission: { mode: 'manual' },
          swarmMode: false,
          context: { history: [], tokenCount: 0 },
          background: [],
          toolStore: {},
          replay: [
            {
              type: 'message',
              time: 1,
              message: {
                role: 'user',
                content: [{ type: 'text', text: 'first question' }],
                toolCalls: [],
                origin: { kind: 'user' },
              },
            },
            {
              type: 'message',
              time: 2,
              message: {
                role: 'assistant',
                content: [],
                toolCalls: [
                  {
                    type: 'function',
                    id: 'tc-notify-1',
                    name: 'NotifyUser',
                    arguments: JSON.stringify({ message: 'first-turn update' }),
                  },
                ],
              },
            },
            {
              type: 'message',
              time: 3,
              message: {
                role: 'tool',
                toolCallId: 'tc-notify-1',
                content: [{ type: 'text', text: 'Update shown to the user.' }],
                toolCalls: [],
              },
            },
            {
              type: 'message',
              time: 4,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'first answer' }],
                toolCalls: [],
              },
            },
            {
              type: 'message',
              time: 5,
              message: {
                role: 'user',
                content: [{ type: 'text', text: 'second question' }],
                toolCalls: [],
                origin: { kind: 'user' },
              },
            },
            {
              type: 'message',
              time: 6,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'second answer' }],
                toolCalls: [],
              },
            },
          ],
        },
      },
    });

    const replayed = await driver.sessionReplay.hydrateFromReplay(session as unknown as Session);
    expect(replayed).toBe(true);

    expect(driver.state.notifyPanel.isEmpty()).toBe(true);
    expect(driver.state.notifyPanelContainer.children).toHaveLength(0);
  });

  it('leaves the panel empty when replaying previous cron turns', async () => {
    const session = makeSession({ id: 'ses-notify-cron' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(session, {}, startupInput);
    driver.sessionEventHandler.notifications.setEnabled(true);
    (session.getResumeState as Mock<(...args: any[]) => any>).mockReturnValue({
      sessionMetadata: {},
      agents: {
        main: {
          config: { modelCapabilities: { max_context_tokens: 100 }, modelAlias: 'k2' },
          plan: null,
          permission: { mode: 'manual' },
          swarmMode: false,
          context: { history: [], tokenCount: 0 },
          background: [],
          toolStore: {},
          replay: [
            {
              type: 'message',
              time: 1,
              message: {
                role: 'user',
                content: [{ type: 'text', text: 'first question' }],
                toolCalls: [],
                origin: { kind: 'user' },
              },
            },
            {
              type: 'message',
              time: 2,
              message: {
                role: 'assistant',
                content: [],
                toolCalls: [
                  {
                    type: 'function',
                    id: 'tc-notify-cron',
                    name: 'NotifyUser',
                    arguments: JSON.stringify({ message: 'update from the prompt turn' }),
                  },
                ],
              },
            },
            {
              type: 'message',
              time: 3,
              message: {
                role: 'tool',
                toolCallId: 'tc-notify-cron',
                content: [{ type: 'text', text: 'Update shown to the user.' }],
                toolCalls: [],
              },
            },
            {
              type: 'message',
              time: 4,
              message: {
                role: 'user',
                content: [{ type: 'text', text: 'check the build' }],
                toolCalls: [],
                origin: { kind: 'cron_job', jobId: 'job-1', cron: '*/5 * * * *', recurring: true },
              },
            },
            {
              type: 'message',
              time: 5,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'build is green' }],
                toolCalls: [],
              },
            },
          ],
        },
      },
    });

    const replayed = await driver.sessionReplay.hydrateFromReplay(session as unknown as Session);
    expect(replayed).toBe(true);

    // Live, the cron fire's turn.started closes the panel; replay folds the
    // cron turn into the previous one for grouping but must close it too.
    expect(driver.state.notifyPanel.isEmpty()).toBe(true);
    expect(driver.state.notifyPanelContainer.children).toHaveLength(0);
  });

  it('keeps hook results recorded before the oldest retained bundle within the replay limit', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(session, {}, startupInput);
    const plainTurn = (index: number) => [
      {
        type: 'message',
        time: index * 2,
        message: {
          role: 'user',
          content: [{ type: 'text', text: `question ${index}` }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      {
        type: 'message',
        time: index * 2 + 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `answer ${index}` }],
          toolCalls: [],
        },
      },
    ];
    (session.getResumeState as Mock<(...args: any[]) => any>).mockReturnValue({
      sessionMetadata: {},
      agents: {
        main: {
          config: { modelCapabilities: { max_context_tokens: 100 }, modelAlias: 'k2' },
          plan: null,
          permission: { mode: 'manual' },
          swarmMode: false,
          context: { history: [], tokenCount: 0 },
          background: [],
          toolStore: {},
          replay: [
            ...plainTurn(0),
            {
              type: 'message',
              time: 1,
              message: {
                role: 'user',
                content: [{ type: 'text', text: 'hook note' }],
                toolCalls: [],
                origin: { kind: 'hook_result', event: 'UserPromptSubmit' },
              },
            },
            {
              type: 'message',
              time: 2,
              message: {
                role: 'user',
                content: [
                  { type: 'text', text: 'review body' },
                  { type: 'text', text: 'bundled question' },
                ],
                toolCalls: [],
                origin: {
                  kind: 'user',
                  skillActivations: [{ activationId: 'act-1', skillName: 'review' }],
                },
              },
            },
            {
              type: 'message',
              time: 3,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'bundled answer' }],
                toolCalls: [],
              },
            },
            ...Array.from({ length: 9 }, (_, i) => plainTurn(i + 10)).flat(),
          ],
        },
      },
    });

    const replayed = await driver.sessionReplay.hydrateFromReplay(session as unknown as Session);
    expect(replayed).toBe(true);

    const entries = driver.state.transcriptEntries;
    const hookIndex = entries.findIndex((entry) => entry.hookResult === true);
    expect(hookIndex).toBeGreaterThan(-1);
    expect(entries[hookIndex]!.content).toContain('hook note');
    const contents = entries.map((entry) => entry.content);
    expect(contents.indexOf('Activated skill: review')).toBeLessThan(hookIndex);
    expect(contents.indexOf('bundled question')).toBeGreaterThan(hookIndex);
    expect(contents).not.toContain('question 0');
  });

  it('renders an accepted skill prompt once without a user activation card (v2 engine)', async () => {
    const session = makeSession({
      id: 'ses-lazy',
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(
      session,
      {
        listWorkspaceSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
        ]),
        listPluginCommands: mock(async () => []),
      },
      startupInput,
    );
    await (driver as unknown as { refreshSkillCommands(): Promise<void> }).refreshSkillCommands();

    let release!: () => void;
    const heldPrompt = new Promise<void>((resolve) => {
      release = resolve;
    });
    (session.promptWithSkills as Mock<(...args: any[]) => any>).mockReturnValue(heldPrompt);

    driver.handleUserInput('please /skill:review');

    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalled();
    });
    driver.sessionEventHandler.handleEvent(
      {
        type: 'skill.activated',
        sessionId: 'ses-lazy',
        agentId: 'main',
        activationId: 'act-1',
        skillName: 'review',
        trigger: 'user-slash',
      } as Event,
      () => {},
    );
    release();

    await waitForAssertion(() => {
      expect(driver.state.transcriptEntries.map((entry) => entry.kind)).toEqual(['user']);
    });
    expect(driver.state.transcriptEntries[0]).toEqual(expect.objectContaining({
      content: 'please /skill:review', skillNames: ['review'],
    }));
  });

  it.each(['/skill:review inspect project', 'inspect project /skill:review'])(
    'keeps the skill prompt above turn output while submission is pending (%s)',
    async (input) => {
      let resolveSkill!: () => void;
      const request = new Promise<void>((resolve) => { resolveSkill = resolve; });
      const session = makeSession({
        listSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
        ]),
        promptWithSkills: mock(() => request),
      });
      const { driver } = await makeDriver(session);
      await (
        driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
      ).refreshSkillCommands(session);
      driver.state.editor.setText(input);
      driver.state.editor.handleInput('\r');
      await waitForAssertion(() => { expect(session.promptWithSkills).toHaveBeenCalledTimes(1); });
      driver.sessionEventHandler.handleEvent({
        type: 'turn.started', sessionId: session.id, agentId: 'main', turnId: 1,
        origin: { kind: 'user' },
      } as Event, () => {});
      driver.sessionEventHandler.handleEvent({
        type: 'assistant.delta', sessionId: session.id, agentId: 'main', turnId: 1,
        delta: 'REVIEW-PROGRESS',
      } as Event, () => {});
      driver.sessionEventHandler.handleEvent({
        type: 'tool.call.started', sessionId: session.id, agentId: 'main', turnId: 1,
        toolCallId: 'tc-review', name: 'Bash', args: { command: 'printf review' },
      } as Event, () => {});
      resolveSkill();
      await waitForAssertion(() => {
        expect(driver.state.transcriptEntries.some((entry) => entry.content === input)).toBe(true);
      });
      const entries = driver.state.transcriptEntries;
      const userIndex = entries.findIndex((entry) => entry.kind === 'user' && entry.content === input);
      const outputIndex = entries.findIndex((entry) => entry.kind === 'assistant' || entry.kind === 'tool_call');
      expect(outputIndex).toBeGreaterThanOrEqual(0);
      expect(userIndex).toBeLessThan(outputIndex);
      expect(entries.filter((entry) => entry.kind === 'user')).toHaveLength(1);
      expect(driver.streamingUI.hasActiveToolCall('tc-review')).toBe(true);
    },
  );

  it('keeps the previous conclusion visible when a skill turn starts before submission settles', async () => {
    const session = makeSession({
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const { driver } = await makeDriver(session);
    await (driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }).refreshSkillCommands(session);
    const emit = (event: Event) => driver.sessionEventHandler.handleEvent(event, () => {});
    driver.appendTranscriptEntry({
      id: 'previous-user', kind: 'user', renderMode: 'plain', content: 'previous prompt',
    });
    emit({ type: 'turn.started', agentId: 'main', turnId: 1, origin: { kind: 'user' } } as Event);
    driver.appendTranscriptEntry({
      id: 'previous-answer', kind: 'assistant', turnId: '1', renderMode: 'markdown', content: 'PREVIOUS-CONCLUSION',
    });
    emit({ type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event);
    session.promptWithSkills.mockImplementationOnce(async () => {
      emit({ type: 'turn.started', agentId: 'main', turnId: 2, origin: { kind: 'user' } } as Event);
    });

    driver.handleUserInput('/skill:review src/app.ts');

    await waitForAssertion(() => {
      expect(driver.state.transcriptEntries.some((entry) => entry.content === '/skill:review src/app.ts')).toBe(true);
    });
    driver.appendTranscriptEntry({
      id: 'review-progress', kind: 'assistant', turnId: '2', renderMode: 'markdown', content: 'REVIEW-PROGRESS',
    });
    driver.appendTranscriptEntry({
      id: 'review-answer', kind: 'assistant', turnId: '2', renderMode: 'markdown', content: 'REVIEW-CONCLUSION',
    });
    emit({ type: 'turn.ended', agentId: 'main', turnId: 2, reason: 'completed' } as Event);

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('PREVIOUS-CONCLUSION');
    expect(transcript).toContain('REVIEW-CONCLUSION');
  });

  it('serializes concurrent lazy session creation (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(session, {}, startupInput);

    let resolveCreate!: (s: ReturnType<typeof makeSession>) => void;
    harness.createSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const ensure = (driver as unknown as { ensureSession(): Promise<unknown> }).ensureSession;
    const first = ensure.call(driver);
    const second = ensure.call(driver);
    resolveCreate(session);
    await Promise.all([first, second]);

    expect(harness.createSession).toHaveBeenCalledTimes(1);
    expect(driver.getCurrentSessionId()).toBe('ses-lazy');
  });

  it('waits out the in-flight lazy creation before /new (v2 engine)', async () => {
    const lazySession = makeSession({ id: 'ses-lazy' });
    const newSession = makeSession({ id: 'ses-new' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(lazySession, {}, startupInput);

    let resolveCreate!: (s: ReturnType<typeof makeSession>) => void;
    harness.createSession
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve;
          }),
      )
      .mockResolvedValueOnce(newSession);
    const ensure = (driver as unknown as { ensureSession(): Promise<unknown> }).ensureSession;
    const pending = ensure.call(driver);
    await waitForAssertion(() => {
      expect(harness.createSession).toHaveBeenCalledTimes(1);
    });

    driver.handleUserInput('/new');
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.createSession).toHaveBeenCalledTimes(1);

    resolveCreate(lazySession);
    await pending;
    await waitForAssertion(() => {
      expect(harness.createSession).toHaveBeenCalledTimes(2);
      expect(driver.getCurrentSessionId()).toBe('ses-new');
    });
  });

  it('blocks /new while the waited-out first prompt starts a turn (v2 engine)', async () => {
    const lazySession = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(lazySession, {}, startupInput);

    let resolveCreate!: (s: ReturnType<typeof makeSession>) => void;
    harness.createSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    driver.handleUserInput('hello');
    await waitForAssertion(() => {
      expect(harness.createSession).toHaveBeenCalledTimes(1);
    });
    driver.handleUserInput('/new');

    resolveCreate(lazySession);
    await waitForAssertion(() => {
      expect(lazySession.prompt).toHaveBeenCalledWith('hello', { promptId: undefined });
      expect(stripSgr(renderTranscript(driver))).toContain('Cannot /new while streaming');
    });
    expect(harness.createSession).toHaveBeenCalledTimes(1);
    expect(driver.getCurrentSessionId()).toBe('ses-lazy');
  });

  const thinkingModelsConfig = () => ({
    models: {
      k2: {
        provider: 'managed:kimi-code',
        model: 'kimi-k2',
        maxContextSize: 100,
        capabilities: ['thinking'],
        supportEfforts: ['low', 'high', 'max'],
        defaultEffort: 'high',
      },
    },
    defaultModel: 'k2',
    thinking: { enabled: true },
  });

  it('blocks an effort switch once the waited-out first prompt starts a turn (v2 engine)', async () => {
    const lazySession = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(
      lazySession,
      { getConfig: mock(async () => thinkingModelsConfig()) },
      startupInput,
    );

    let resolveCreate!: (s: ReturnType<typeof makeSession>) => void;
    harness.createSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    driver.handleUserInput('hello');
    await waitForAssertion(() => {
      expect(harness.createSession).toHaveBeenCalledTimes(1);
    });
    driver.handleUserInput('/effort low');

    resolveCreate(lazySession);
    await waitForAssertion(() => {
      expect(lazySession.prompt).toHaveBeenCalledWith('hello', { promptId: undefined });
      expect(stripSgr(renderTranscript(driver))).toContain('Cannot switch models while streaming');
    });
    expect(lazySession.setThinking).not.toHaveBeenCalled();
  });

  it('applies an effort switch after waiting out an in-flight lazy creation (v2 engine)', async () => {
    const lazySession = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(
      lazySession,
      {
        getConfig: mock(async () => thinkingModelsConfig()),
        setConfig: mock(async () => ({ providers: {} })),
      },
      startupInput,
    );

    let resolveCreate!: (s: ReturnType<typeof makeSession>) => void;
    harness.createSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const ensure = (driver as unknown as { ensureSession(): Promise<unknown> }).ensureSession;
    const pending = ensure.call(driver);
    await waitForAssertion(() => {
      expect(harness.createSession).toHaveBeenCalledTimes(1);
    });

    driver.handleUserInput('/effort low');
    await new Promise((resolve) => setImmediate(resolve));
    expect(driver.state.appState.thinkingEffort).toBe('high');

    resolveCreate(lazySession);
    await pending;
    await waitForAssertion(() => {
      expect(lazySession.setThinking).toHaveBeenCalledWith('low');
    });
  });

  it('blocks a session-picker switch once the waited-out first prompt starts a turn (v2 engine)', async () => {
    const lazySession = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(
      lazySession,
      {
        listSessions: mock(async () => [
          { id: 'ses-old', title: 'Old session', workDir: '/tmp/proj-a', updatedAt: Date.now() },
        ]),
      },
      startupInput,
    );

    let resolveCreate!: (s: ReturnType<typeof makeSession>) => void;
    harness.createSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    driver.handleUserInput('hello');
    await waitForAssertion(() => {
      expect(harness.createSession).toHaveBeenCalledTimes(1);
    });

    await (driver as unknown as { showSessionPicker(): Promise<void> }).showSessionPicker();
    const picker = driver.state.editorContainer.children[0] as { handleInput(data: string): void };
    picker.handleInput('\r');

    resolveCreate(lazySession);
    await waitForAssertion(() => {
      expect(lazySession.prompt).toHaveBeenCalledWith('hello', { promptId: undefined });
      expect(stripSgr(renderTranscript(driver))).toContain(
        'Cannot switch sessions while streaming',
      );
    });
    expect(harness.resumeSession).not.toHaveBeenCalled();
    expect(driver.getCurrentSessionId()).toBe('ses-lazy');
  });

  it('carries a session-only thinking choice into the lazy-created session (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(session, {}, startupInput);

    await (
      driver as unknown as {
        authFlow: { activateModelAfterLogin(model: string, effort?: string): Promise<void> };
      }
    ).authFlow.activateModelAfterLogin('k2', 'high');

    driver.handleUserInput('hello');

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith('hello', { promptId: undefined });
    });
    expect(harness.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'k2', thinking: 'high' }),
    );
    expect(driver.state.appState.lazySessionThinking).toBeUndefined();
  });

  it('does not pass the config default plan mode into the lazy-created session (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(
      session,
      {
        getConfig: mock(async () => ({
          models: { k2: { model: 'moonshot-v1', maxContextSize: 100 } },
          defaultModel: 'k2',
          defaultPlanMode: true,
        })),
      },
      startupInput,
    );

    expect(driver.state.appState.planMode).toBe(true);

    driver.handleUserInput('hello');

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith('hello', { promptId: undefined });
    });
    expect(harness.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ planMode: undefined }),
    );
  });

  it('passes the explicit --plan flag into the lazy-created session (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2', plan: true },
    };
    const { driver, harness } = await makeDriver(session, {}, startupInput);

    driver.handleUserInput('hello');

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith('hello', { promptId: undefined });
    });
    expect(harness.createSession).toHaveBeenCalledWith(expect.objectContaining({ planMode: true }));
  });

  it('queues a bash command submitted while the lazy session is being created (v2 engine)', async () => {
    const runShellCommand = mock(async () => ({ stdout: '', stderr: '', isError: false }));
    const session = makeSession({ id: 'ses-lazy', runShellCommand });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(session, {}, startupInput);

    driver.handleUserInput('hello');
    await waitForAssertion(() => {
      expect(driver.state.appState.streamingPhase).not.toBe('idle');
    });
    driver.state.appState.inputMode = 'bash';
    driver.state.editor.inputMode = 'bash';
    driver.handleUserInput('ls');

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith('hello', { promptId: undefined });
    });
    expect(runShellCommand).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([{ text: 'ls', agentId: 'main', mode: 'bash' }]);
  });

  it('opens /settings without creating a session (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      // No model configured: /settings must still open so the user can fix
      // local editor/theme/update settings before picking a model.
      cliOptions: { ...makeStartupInput().cliOptions },
    };
    const { driver, harness } = await makeDriver(session, {}, startupInput);

    driver.handleUserInput('/settings');

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(driver.state.appState.sessionId).toBe('');
  });

  it('blocks a skill command submitted while the lazy session is being created (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy', activateSkill: mock(async () => {}) });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(
      session,
      {
        listWorkspaceSkills: mock(async () => [
          {
            name: 'my-skill',
            description: 'A test skill',
            path: '/tmp/my-skill',
            source: 'user',
          },
        ]),
        listPluginCommands: mock(async () => []),
      },
      startupInput,
    );
    await (driver as unknown as { refreshSkillCommands(): Promise<void> }).refreshSkillCommands();

    driver.handleUserInput('hello');
    driver.handleUserInput('/skill:my-skill');

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith('hello', { promptId: undefined });
    });
    expect(session.activateSkill).not.toHaveBeenCalled();
    expect(harness.createSession).toHaveBeenCalledTimes(1);
  });

  it('manages plugins without creating a session (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const listPlugins = mock(async () => []);
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      // No model configured: /plugins must still work via the app-global API.
      cliOptions: { ...makeStartupInput().cliOptions },
    };
    const { driver, harness } = await makeDriver(session, { listPlugins }, startupInput);

    driver.handleUserInput('/plugins list');

    await waitForAssertion(() => {
      expect(listPlugins).toHaveBeenCalled();
    });
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(driver.state.appState.sessionId).toBe('');
  });

  it('lists additional directories without creating a session (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      // No model configured: the read-only form must still work.
      cliOptions: { ...makeStartupInput().cliOptions },
    };
    const { driver, harness } = await makeDriver(session, {}, startupInput);

    driver.handleUserInput('/add-dir list');

    expect(harness.createSession).not.toHaveBeenCalled();
    expect(driver.state.appState.sessionId).toBe('');
  });

  it('lazily creates the session when adding a directory (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(session, {}, startupInput);

    driver.handleUserInput('/add-dir /tmp/extra');

    await waitForAssertion(() => {
      expect(driver.getCurrentSessionId()).toBe('ses-lazy');
    });
    expect(harness.createSession).toHaveBeenCalledTimes(1);
  });

  it('shows pending startup directories in /add-dir list before the lazy session (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      additionalDirs: ['/tmp/extra'],
      cliOptions: { ...makeStartupInput().cliOptions },
    };
    const { driver, harness } = await makeDriver(session, {}, startupInput);
    const showStatus = spyOn(
      driver as unknown as { showStatus: (msg: string) => void },
      'showStatus',
    );

    driver.handleUserInput('/add-dir list');

    await waitForAssertion(() => {
      expect(showStatus).toHaveBeenCalledWith(expect.stringContaining('/tmp/extra'));
    });
    expect(harness.createSession).not.toHaveBeenCalled();
  });

  it('refreshes plugin slash commands after a sessionless /plugins reload (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const listPluginCommands = mock(async () => [
      {
        pluginId: 'my-plugin',
        name: 'my-command',
        body: 'do things',
        description: 'A plugin command',
      },
    ]);
    const reloadPlugins = mock(async () => ({ added: [], removed: [], errors: [] }));
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions },
    };
    const { driver, harness } = await makeDriver(
      session,
      { listPluginCommands, reloadPlugins },
      startupInput,
    );

    driver.handleUserInput('/plugins reload');

    await waitForAssertion(() => {
      expect(reloadPlugins).toHaveBeenCalled();
      expect(listPluginCommands).toHaveBeenCalled();
      expect(driver.pluginCommandMap.get('my-plugin:my-command')).toBe('do things');
    });
    expect(harness.createSession).not.toHaveBeenCalled();
  });

  it('hydrates lazy config defaults on a sessionless /reload (v2 engine)', async () => {
    const homeDir = await makeTempHome();
    process.env['KIMI_CODE_HOME'] = homeDir;
    const session = makeSession({ id: 'ses-lazy' });
    const getConfig = mock(
      async (): Promise<{ models: Record<string, unknown>; defaultModel?: string }> => ({
        models: { k2: { model: 'moonshot-v1', maxContextSize: 100 } },
      }),
    );
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions },
    };
    const { driver, harness } = await makeDriver(session, { getConfig }, startupInput);
    expect(driver.state.appState.model).toBe('');

    getConfig.mockResolvedValue({
      models: { k2: { model: 'moonshot-v1', maxContextSize: 100 } },
      defaultModel: 'k2',
    });
    driver.handleUserInput('/reload');

    await waitForAssertion(() => {
      expect(driver.state.appState.model).toBe('k2');
    });
    expect(harness.createSession).not.toHaveBeenCalled();
  });

  it('clears stale lazy defaults when the default model is removed (v2 engine)', async () => {
    const homeDir = await makeTempHome();
    process.env['KIMI_CODE_HOME'] = homeDir;
    const session = makeSession({ id: 'ses-lazy' });
    const getConfig = mock(
      async (): Promise<{ models: Record<string, unknown>; defaultModel?: string }> => ({
        models: { k2: { model: 'moonshot-v1', maxContextSize: 100 } },
        defaultModel: 'k2',
      }),
    );
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions },
    };
    const { driver } = await makeDriver(session, { getConfig }, startupInput);
    expect(driver.state.appState.model).toBe('k2');
    expect(driver.state.appState.maxContextTokens).toBe(100);

    getConfig.mockResolvedValue({
      models: { k2: { model: 'moonshot-v1', maxContextSize: 100 } },
    });
    driver.handleUserInput('/reload');

    await waitForAssertion(() => {
      expect(driver.state.appState.model).toBe('');
    });
    expect(driver.state.appState.maxContextTokens).toBe(0);
  });

  it('does not re-enter plan mode on /plan on when config already applied it (v2 engine)', async () => {
    const session = makeSession({
      id: 'ses-lazy',
      getStatus: mock(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: true,
        contextTokens: 0,
        maxContextTokens: 100,
        contextUsage: 0,
      })),
    });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(
      session,
      {
        getConfig: mock(async () => ({
          models: { k2: { model: 'moonshot-v1', maxContextSize: 100 } },
          defaultModel: 'k2',
          defaultPlanMode: true,
        })),
      },
      startupInput,
    );

    driver.handleUserInput('/plan on');

    await waitForAssertion(() => {
      expect(harness.createSession).toHaveBeenCalledTimes(1);
    });
    expect(session.setPlanMode).not.toHaveBeenCalled();
    expect(driver.state.appState.planMode).toBe(true);
  });

  it('clears the stale permission default when it is removed from config (v2 engine)', async () => {
    const homeDir = await makeTempHome();
    process.env['KIMI_CODE_HOME'] = homeDir;
    const session = makeSession({ id: 'ses-lazy' });
    const getConfig = mock(
      async (): Promise<{
        models: Record<string, unknown>;
        defaultModel?: string;
        defaultPermissionMode?: string;
      }> => ({
        models: { k2: { model: 'moonshot-v1', maxContextSize: 100 } },
        defaultModel: 'k2',
        defaultPermissionMode: 'auto',
      }),
    );
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions },
    };
    const { driver } = await makeDriver(session, { getConfig }, startupInput);
    expect(readPermissionMode(driver)).toBe('auto');

    getConfig.mockResolvedValue({
      models: { k2: { model: 'moonshot-v1', maxContextSize: 100 } },
      defaultModel: 'k2',
    });
    driver.handleUserInput('/reload');

    await waitForAssertion(() => {
      expect(readPermissionMode(driver)).toBe('manual');
    });
  });

  it('does not pass --plan when config already applies default plan mode (v2 engine)', async () => {
    const session = makeSession({
      id: 'ses-lazy',
      getStatus: mock(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: true,
        contextTokens: 0,
        maxContextTokens: 100,
        contextUsage: 0,
      })),
    });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2', plan: true },
    };
    const { driver, harness } = await makeDriver(
      session,
      {
        getConfig: mock(async () => ({
          models: { k2: { model: 'moonshot-v1', maxContextSize: 100 } },
          defaultModel: 'k2',
          defaultPlanMode: true,
        })),
      },
      startupInput,
    );

    driver.handleUserInput('hello');

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith('hello', { promptId: undefined });
    });
    expect(harness.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ planMode: undefined }),
    );
    expect(driver.state.appState.planMode).toBe(true);
  });

  it('opens read-only status commands without creating a session (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      // No model configured: read-only views must still open.
      cliOptions: { ...makeStartupInput().cliOptions },
    };
    const { driver, harness } = await makeDriver(session, {}, startupInput);

    driver.handleUserInput('/status');

    await waitForAssertion(() => {
      expect(stripSgr(renderTranscript(driver))).toContain('Status');
    });
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(driver.state.appState.sessionId).toBe('');
  });

  it('applies /yolo session-less via the permission picker and passes the mode to the lazy session (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(session, {}, startupInput);

    driver.handleUserInput('/yolo');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PermissionSelectorComponent);
    });
    (driver.state.editorContainer.children[0] as PermissionSelectorComponent).handleInput('\r');

    await waitForAssertion(() => {
      expect(readPermissionMode(driver)).toBe('yolo');
    });
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(session.setPermission).not.toHaveBeenCalled();

    driver.handleUserInput('hello');

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith('hello', { promptId: undefined });
    });
    expect(harness.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ permission: 'yolo' }),
    );
  });

  it('waits for lazy session assembly before dispatching further input (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(session, {}, startupInput);

    let resolvePermission!: () => void;
    session.setPermission.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePermission = resolve;
        }),
    );

    const ensure = (driver as unknown as { ensureSession(): Promise<unknown> }).ensureSession;
    const first = ensure.call(driver);
    await waitForAssertion(() => {
      expect(session.setPermission).toHaveBeenCalled();
    });

    const second = ensure.call(driver);
    let secondResolved = false;
    void second.then(() => {
      secondResolved = true;
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    resolvePermission();
    await Promise.all([first, second]);
    expect(secondResolved).toBe(true);
    expect(harness.createSession).toHaveBeenCalledTimes(1);
  });

  it('lists MCP servers before the lazy session via the workspace view (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const listWorkspaceMcpServers = mock(async () => [
      { name: 'my-mcp', status: 'connected', transport: 'stdio', tools: [] },
    ]);
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions },
    };
    const { driver, harness } = await makeDriver(
      session,
      { listWorkspaceMcpServers },
      startupInput,
    );

    driver.handleUserInput('/mcp');

    await waitForAssertion(() => {
      expect(listWorkspaceMcpServers).toHaveBeenCalledWith('/tmp/proj-a');
    });
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(session.listMcpServers).not.toHaveBeenCalled();
  });

  it('tracks /clear as the clear alias for /new', async () => {
    const { driver, harness } = await makeDriver(makeSession({ id: 'ses-1' }));
    const nextSession = makeSession({ id: 'ses-2' });
    harness.createSession.mockResolvedValueOnce(nextSession);
    harness.track.mockClear();

    driver.handleUserInput('/clear');

    await waitForAssertion(() => {
      expect(driver.getCurrentSessionId()).toBe('ses-2');
    });
    expect(harness.track).toHaveBeenCalledWith('input_command', { command: 'new' });
    expect(harness.track).toHaveBeenCalledWith('clear', undefined);
  });

  it('tracks theme changes from slash commands', async () => {
    process.env['KIMI_CODE_HOME'] = await makeTempHome();
    const { driver, harness } = await makeDriver();
    harness.track.mockClear();

    driver.handleUserInput('/theme light');

    await waitForAssertion(() => {
      expect(driver.state.appState.theme).toBe('light');
    });
    expect(harness.track).toHaveBeenCalledWith('input_command', { command: 'theme' });
    expect(harness.track).toHaveBeenCalledWith('theme_switch', { theme: 'light' });
  });

  it('dispatches /reload-tui without reloading the active session', async () => {
    const homeDir = await makeTempHome();
    process.env['KIMI_CODE_HOME'] = homeDir;
    await writeFile(
      join(homeDir, 'tui.toml'),
      `
theme = "light"

[editor]
command = "vim"
`,
      'utf-8',
    );
    const { driver, session, harness } = await makeDriver();
    harness.track.mockClear();
    session.reloadSession.mockClear();

    driver.handleUserInput('/reload-tui');

    await waitForAssertion(() => {
      expect(driver.state.appState.theme).toBe('light');
    });
    expect(driver.state.appState.editorCommand).toBe('vim');
    expect(session.reloadSession).not.toHaveBeenCalled();
    expect(harness.track).toHaveBeenCalledWith('input_command', { command: 'reload-tui' });
  });

  it('dispatches /reload through session reload and applies tui.toml', async () => {
    const homeDir = await makeTempHome();
    process.env['KIMI_CODE_HOME'] = homeDir;
    await writeFile(join(homeDir, 'tui.toml'), 'theme = "light"\n', 'utf-8');
    const { driver, session, harness } = await makeDriver();
    harness.track.mockClear();
    session.reloadSession.mockClear();
    driver.handleUserInput('hello before reload');
    driver.state.appState.streamingPhase = 'idle';

    driver.handleUserInput('/reload');

    await waitForAssertion(() => {
      expect(harness.reloadSession).toHaveBeenCalledWith({
        id: session.id,
        forcePluginSessionStartReminder: true,
      });
    });
    await waitForAssertion(() => {
      expect(driver.state.appState.theme).toBe('light');
    });
    expect(session.reloadSession).not.toHaveBeenCalled();
    expect(harness.track).toHaveBeenCalledWith('input_command', { command: 'reload' });
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('hello before reload');
    expect(transcript).toContain('Session reloaded.');
  });

  it('prints the sign-up page and GitHub Issues links when not signed in', async () => {
    const { driver, harness } = await makeDriver(makeSession());
    harness.auth.status.mockResolvedValueOnce({
      providers: [{ providerName: 'managed:kimi-code', hasToken: false }],
    });
    const feedbackDriver = driver as unknown as FeedbackDriver;
    promptFeedbackInputMock.mockImplementation(async () => ({ value: 'useful feedback' }));
    openUrlMock.mockClear();

    await handleFeedbackCommand(feedbackDriver as any);

    expect(openUrl).not.toHaveBeenCalled();
    expect(promptFeedbackInput).not.toHaveBeenCalled();
    expect(harness.auth.submitFeedback).not.toHaveBeenCalled();
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain("You're not signed in");
    expect(transcript).toContain('https://www.kimi.com/code');
    expect(transcript).toContain('https://github.com/MoonshotAI/kimi-code/issues');
  });

  it('falls back to GitHub Issues when the sign-in status cannot be read', async () => {
    const { driver, harness } = await makeDriver(makeSession());
    harness.auth.status.mockRejectedValueOnce(new Error('token storage unavailable'));
    const feedbackDriver = driver as unknown as FeedbackDriver;
    promptFeedbackInputMock.mockClear();
    openUrlMock.mockClear();

    await handleFeedbackCommand(feedbackDriver as any);

    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith('https://github.com/MoonshotAI/kimi-code/issues');
    expect(promptFeedbackInput).not.toHaveBeenCalled();
    expect(harness.auth.submitFeedback).not.toHaveBeenCalled();
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Opening GitHub Issues as fallback');
  });

  it('submits feedback via OAuth for a signed-in user on an API-key model', async () => {
    const { driver, harness } = await makeDriver(makeSession());
    driver.state.appState.availableModels = {
      k2: {
        provider: 'openai',
        model: 'gpt-x',
        maxContextSize: 100,
        displayName: 'GPT X',
        capabilities: [],
      },
    };
    const feedbackDriver = driver as unknown as FeedbackDriver;
    promptFeedbackInputMock.mockImplementation(async () => ({ value: 'useful feedback' }));
    promptFeedbackAttachmentMock.mockImplementation(async () => 'none');
    harness.auth.submitFeedback.mockResolvedValueOnce({ kind: 'ok', feedbackId: 7 });

    await handleFeedbackCommand(feedbackDriver as any);

    expect(harness.auth.submitFeedback).toHaveBeenCalledTimes(1);
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Feedback ID: 7');
  });

  it('tracks successful feedback submissions only after the request succeeds', async () => {
    const { driver, harness } = await makeDriver(makeSession());
    const feedbackDriver = driver as unknown as FeedbackDriver;
    promptFeedbackInputMock.mockImplementation(async () => ({ value: 'useful feedback' }));
    promptFeedbackAttachmentMock.mockImplementation(async () => 'none');
    harness.auth.submitFeedback.mockResolvedValueOnce({ kind: 'ok', feedbackId: 3 });
    harness.track.mockClear();

    await handleFeedbackCommand(feedbackDriver as any);

    expect(harness.auth.submitFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'useful feedback',
        sessionId: 'ses-1',
        version: 'kimi-code-0.0.0-test',
        model: 'k2',
      }),
    );
    expect(harness.track).toHaveBeenCalledWith('feedback_submitted', undefined);
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Feedback ID: 3');
  });

  it('submits text feedback before preparing requested attachments', async () => {
    const { driver, harness } = await makeDriver(makeSession());
    const feedbackDriver = driver as unknown as FeedbackDriver;
    promptFeedbackInputMock.mockImplementation(async () => ({ value: 'useful feedback' }));
    promptFeedbackAttachmentMock.mockImplementation(async () => 'logs');
    harness.auth.submitFeedback.mockResolvedValueOnce({ kind: 'ok', feedbackId: 3 });
    harness.listSessions.mockResolvedValueOnce([
      { id: 'ses-1', sessionDir: '/tmp/session-a' },
    ] as never);

    const zipPath = await makeExportedSessionZip();
    let resolveExport!: () => void;
    const exportBlocked = new Promise<{
      zipPath: string;
      entries: string[];
      sessionDir: string;
      manifest: Record<string, never>;
    }>((resolve) => {
      resolveExport = () => {
        resolve({
          zipPath,
          entries: ['manifest.json', 'state.json'],
          sessionDir: '/tmp/session-a',
          manifest: {},
        });
      };
    });
    harness.exportSession.mockImplementationOnce(() => exportBlocked);

    let settled = false;
    const command = handleFeedbackCommand(feedbackDriver as any).then(() => {
      settled = true;
    });

    await waitForAssertion(
      () => {
        expect(harness.exportSession).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 'ses-1',
            includeGlobalLog: true,
            version: '0.0.0-test',
          }),
        );
      },
      // The command performs real fs work (archive path creation, install
      // detection) before reaching exportSession; the default 1s window is
      // too tight under full-suite parallel load.
      { timeout: 10_000 },
    );
    expect(harness.auth.submitFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'useful feedback' }),
    );
    expect(harness.auth.submitFeedback.mock.invocationCallOrder[0]).toBeLessThan(
      harness.exportSession.mock.invocationCallOrder[0]!,
    );
    expect(settled).toBe(false);

    resolveExport();
    await command;
  });

  it('waits for the codebase upload to finish before returning', async () => {
    const { driver, harness } = await makeDriver(makeSession());
    const feedbackDriver = driver as unknown as FeedbackDriver;
    scanCodebaseMock.mockReset();
    harness.exportSession.mockReset();
    packageCodebaseMock.mockReset();
    uploadArchiveMock.mockReset();
    promptFeedbackInputMock.mockImplementation(async () => ({ value: 'useful feedback' }));
    promptFeedbackAttachmentMock.mockImplementation(async () => 'logs+codebase');
    harness.auth.submitFeedback.mockResolvedValueOnce({ kind: 'ok', feedbackId: 3 });
    harness.listSessions.mockResolvedValueOnce([
      { id: 'ses-1', sessionDir: '/tmp/session-a' },
    ] as never);

    scanCodebaseMock.mockResolvedValueOnce({
      root: '/tmp/proj-a',
      files: [{ path: 'keep.ts', size: 4 }],
      fingerprint: 'fp-123',
      usedGitIgnore: false,
    } as any);
    const sessionZipPath = await makeExportedSessionZip();
    harness.exportSession.mockResolvedValueOnce({
      zipPath: sessionZipPath,
      entries: ['manifest.json', 'state.json'],
      sessionDir: '/tmp/session-a',
      manifest: {},
    });
    packageCodebaseMock.mockResolvedValueOnce({
      path: '/tmp/fake-codebase.zip',
      size: 4,
      sha256: 'hash-123',
      fingerprint: 'fp-123',
      fileCount: 1,
    });

    let resolveCodebaseUpload!: () => void;
    const codebaseUploadBlocked = new Promise<void>((resolve) => {
      resolveCodebaseUpload = resolve;
    });
    uploadArchiveMock.mockImplementation((_api, archive) => {
      if (archive.path === sessionZipPath) return Promise.resolve();
      return codebaseUploadBlocked;
    });

    let settled = false;
    const command = handleFeedbackCommand(feedbackDriver as any).then(() => {
      settled = true;
    });

    await waitForAssertion(
      () => {
        expect(uploadArchive).toHaveBeenCalledTimes(2);
      },
      { timeout: 10_000 },
    );
    expect(settled).toBe(false);

    resolveCodebaseUpload();
    await command;
    expect(settled).toBe(true);
    expect(uploadArchive).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ path: sessionZipPath }),
      3,
      { filename: 'session.zip' },
    );
    expect(uploadArchive).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ path: '/tmp/fake-codebase.zip' }),
      3,
      { filename: 'repo.zip' },
    );
    expect(harness.auth.submitFeedback).toHaveBeenCalledWith(
      expect.not.objectContaining({ info: expect.anything() }),
    );
  });

  it('uploads session logs when codebase scanning fails but the session directory is available', async () => {
    const { driver, harness } = await makeDriver(makeSession());
    const feedbackDriver = driver as unknown as FeedbackDriver;
    scanCodebaseMock.mockReset();
    harness.exportSession.mockReset();
    packageCodebaseMock.mockReset();
    uploadArchiveMock.mockReset();
    promptFeedbackInputMock.mockImplementation(async () => ({ value: 'useful feedback' }));
    promptFeedbackAttachmentMock.mockImplementation(async () => 'logs+codebase');
    harness.auth.submitFeedback.mockResolvedValueOnce({ kind: 'ok', feedbackId: 3 });
    harness.listSessions.mockResolvedValueOnce([
      { id: 'ses-1', sessionDir: '/tmp/session-a' },
    ] as never);
    const sessionZipPath = await makeExportedSessionZip();
    scanCodebaseMock.mockRejectedValueOnce(new Error('scan failed'));
    harness.exportSession.mockResolvedValueOnce({
      zipPath: sessionZipPath,
      entries: ['manifest.json', 'state.json'],
      sessionDir: '/tmp/session-a',
      manifest: {},
    });

    await handleFeedbackCommand(feedbackDriver as any);

    expect(harness.exportSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ses-1', includeGlobalLog: true }),
    );
    expect(packageCodebase).not.toHaveBeenCalled();
    expect(uploadArchive).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ path: sessionZipPath }),
      3,
      { filename: 'session.zip' },
    );
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Feedback ID: 3');
    expect(transcript).toContain('attachment upload failed');
  });

  it('keeps archive-path creation failures as partial failures without the GitHub fallback', async () => {
    const { driver, harness } = await makeDriver(makeSession());
    const feedbackDriver = driver as unknown as FeedbackDriver;
    promptFeedbackInputMock.mockImplementation(async () => ({ value: 'useful feedback' }));
    promptFeedbackAttachmentMock.mockImplementation(async () => 'logs');
    harness.auth.submitFeedback.mockResolvedValueOnce({ kind: 'ok', feedbackId: 3 });
    harness.listSessions.mockResolvedValueOnce([
      { id: 'ses-1', sessionDir: '/tmp/session-a' },
    ] as never);
    createFeedbackArchivePathMock.mockRejectedValueOnce(new Error('cache dir not writable'));
    openUrlMock.mockClear();

    await handleFeedbackCommand(feedbackDriver as any);

    expect(openUrl).not.toHaveBeenCalled();
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Feedback submitted, thank you!');
    expect(transcript).toContain('Feedback ID: 3');
    expect(transcript).toContain('attachment upload failed');
  });

  it('tells the user when feedback is sent but codebase packaging fails', async () => {
    const { driver, harness } = await makeDriver(makeSession());
    const feedbackDriver = driver as unknown as FeedbackDriver;
    scanCodebaseMock.mockReset();
    packageCodebaseMock.mockReset();
    harness.exportSession.mockReset();
    uploadArchiveMock.mockReset();
    promptFeedbackInputMock.mockImplementation(async () => ({ value: 'useful feedback' }));
    promptFeedbackAttachmentMock.mockImplementation(async () => 'logs+codebase');
    harness.auth.submitFeedback.mockResolvedValueOnce({ kind: 'ok', feedbackId: 3 });
    harness.listSessions.mockResolvedValueOnce([
      { id: 'ses-1', sessionDir: '/tmp/session-a' },
    ] as never);
    const sessionZipPath = await makeExportedSessionZip();

    scanCodebaseMock.mockResolvedValueOnce({
      root: '/tmp/proj-a',
      files: [{ path: 'keep.ts', size: 4 }],
      fingerprint: 'fp-123',
      usedGitIgnore: false,
    } as any);
    harness.exportSession.mockResolvedValueOnce({
      zipPath: sessionZipPath,
      entries: ['manifest.json', 'state.json'],
      sessionDir: '/tmp/session-a',
      manifest: {},
    });
    packageCodebaseMock.mockRejectedValueOnce(new Error('zip failed'));

    await handleFeedbackCommand(feedbackDriver as any);

    const calls = harness.auth.submitFeedback.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    expect(calls[0]?.[0]?.['info']).toBeUndefined();
    expect(uploadArchive).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ path: sessionZipPath }),
      3,
      { filename: 'session.zip' },
    );
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Feedback ID: 3');
    expect(transcript).toContain('attachment upload failed');
  });

  it('tells the user when the codebase upload fails', async () => {
    const { driver, harness } = await makeDriver(makeSession());
    const feedbackDriver = driver as unknown as FeedbackDriver;
    promptFeedbackInputMock.mockImplementation(async () => ({ value: 'useful feedback' }));
    promptFeedbackAttachmentMock.mockImplementation(async () => 'logs+codebase');
    harness.auth.submitFeedback.mockResolvedValueOnce({ kind: 'ok', feedbackId: 3 });

    scanCodebaseMock.mockResolvedValueOnce({
      root: '/tmp/proj-a',
      files: [{ path: 'keep.ts', size: 4 }],
      fingerprint: 'fp-123',
      usedGitIgnore: false,
    } as any);
    packageCodebaseMock.mockResolvedValueOnce({
      path: '/tmp/fake-codebase.zip',
      size: 4,
      sha256: 'hash-123',
      fingerprint: 'fp-123',
      fileCount: 1,
    });
    uploadArchiveMock.mockRejectedValueOnce(new Error('upload failed'));

    await handleFeedbackCommand(feedbackDriver as any);

    expect(harness.auth.submitFeedback).toHaveBeenCalledTimes(1);
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Feedback ID: 3');
    expect(transcript).toContain('attachment upload failed');
  });

  it('shows feedback API error messages without replacing them with HTTP status text', async () => {
    const { driver, harness } = await makeDriver(makeSession());
    const feedbackDriver = driver as unknown as FeedbackDriver;
    promptFeedbackInputMock.mockImplementation(async () => ({ value: 'useful feedback' }));
    promptFeedbackAttachmentMock.mockImplementation(async () => 'none');
    harness.auth.submitFeedback.mockResolvedValueOnce({
      kind: 'error',
      status: 500,
      message: 'backend says no',
    });

    await handleFeedbackCommand(feedbackDriver as any);

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('backend says no');
    expect(transcript).toContain('Opening GitHub Issues as fallback');
    expect(transcript).not.toContain('Failed to submit feedback (HTTP 500).');
  });

  it('falls back to GitHub Issues when the submission request rejects', async () => {
    const { driver, harness } = await makeDriver(makeSession());
    const feedbackDriver = driver as unknown as FeedbackDriver;
    promptFeedbackInputMock.mockImplementation(async () => ({ value: 'useful feedback' }));
    promptFeedbackAttachmentMock.mockImplementation(async () => 'none');
    harness.auth.submitFeedback.mockRejectedValueOnce(new Error('socket hangup'));
    openUrlMock.mockClear();

    await expect(handleFeedbackCommand(feedbackDriver as any)).rejects.toThrow('socket hangup');

    expect(openUrl).toHaveBeenCalledWith('https://github.com/MoonshotAI/kimi-code/issues');
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Opening GitHub Issues as fallback');
  });

  it('does not track feedback when the dialog is cancelled', async () => {
    const { driver, harness } = await makeDriver(makeSession());
    const feedbackDriver = driver as unknown as FeedbackDriver;
    promptFeedbackInputMock.mockImplementation(async () => undefined);
    harness.track.mockClear();

    await handleFeedbackCommand(feedbackDriver as any);

    expect(harness.auth.submitFeedback).not.toHaveBeenCalled();
    expect(harness.track).not.toHaveBeenCalledWith('feedback_submitted', undefined);
  });

  it('tracks blocked slash commands as invalid without counting them as executed commands', async () => {
    const { driver, harness } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';

    for (const command of ['/new', '/sessions']) {
      harness.track.mockClear();

      driver.handleUserInput(command);
      await Promise.resolve();

      expect(harness.track).toHaveBeenCalledWith('input_command_invalid', {
        reason: 'blocked',
        command: command.slice(1),
      });
      expect(harness.track).not.toHaveBeenCalledWith('input_command', {
        command: command.slice(1),
      });
    }
  });

  it('does not re-enter plan mode after creating a plan-mode session', async () => {
    const session = makeSession({
      getStatus: mock(async () => ({
        model: 'k2',
        thinkingEffort: 'off',
        permission: 'manual',
        planMode: true,
        contextTokens: 0,
        maxContextTokens: 100,
        contextUsage: 0,
      })),
      setPlanMode: mock(async () => {
        throw new Error('Already in plan mode');
      }),
    });
    const { driver, harness } = await makeDriver(session);
    harness.createSession.mockClear();
    session.setPlanMode.mockClear();
    driver.state.appState.planMode = true;

    driver.handleUserInput('/new');

    await waitForAssertion(() => {
      expect(harness.createSession).toHaveBeenCalledWith({
        workDir: '/tmp/proj-a',
        model: 'k2',
        thinking: 'off',
        permission: 'manual',
        planMode: true,
      });
    });
    expect(session.setPlanMode).not.toHaveBeenCalled();
    expect(stripSgr(renderTranscript(driver))).not.toContain('Post-create setup failed');
  });

  it('keeps the new session subscribed when post-create setup fails', async () => {
    const initialSession = makeSession({ id: 'ses-initial' });
    const failedSession = makeSession({
      id: 'ses-failed',
      setPermission: mock(async () => {
        throw new Error('permission setup failed');
      }),
    });
    const createSession = mock(async () => failedSession);
    const { driver } = await makeDriver(initialSession, { createSession });
    failedSession.onEvent.mockClear();

    driver.handleUserInput('/new');

    await waitForAssertion(() => {
      expect(stripSgr(renderTranscript(driver))).toContain(
        'Post-create setup failed: permission setup failed',
      );
    });
    expect(failedSession.onEvent).toHaveBeenCalled();
  });

  it('tracks Shift-Tab mode switches through the editor handler', async () => {
    const { driver, session, harness } = await makeDriver();
    harness.track.mockClear();

    driver.state.editor.onShiftTab?.();

    await waitForAssertion(() => {
      expect(session.setPlanMode).toHaveBeenCalledWith(true);
    });
    expect(harness.track).toHaveBeenCalledWith('shortcut_plan_toggle', { enabled: true });
    expect(harness.track).toHaveBeenCalledWith('shortcut_mode_switch', { to_mode: 'plan' });
  });

  it('routes /yolo through session permission state without app-layer telemetry duplication', async () => {
    const { driver, session, harness } = await makeDriver();
    harness.track.mockClear();

    driver.handleUserInput('/yolo');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PermissionSelectorComponent);
    });
    (driver.state.editorContainer.children[0] as PermissionSelectorComponent).handleInput('\r');

    await waitForAssertion(() => {
      expect(session.setPermission).toHaveBeenCalledWith('yolo');
    });
    expect(driver.state.appState).toMatchObject({
      permissionMode: 'yolo',
    });
    expect(stripSgr(renderTranscript(driver))).toContain(
      'Routine edits and commands run automatically; risky actions, questions, and plans still ask.',
    );
    expect(harness.track).toHaveBeenCalledWith('input_command', { command: 'yolo' });
    expect(harness.track).not.toHaveBeenCalledWith('yolo_toggle', expect.anything());
  });

  it('hydrates MCP server status after subscribing to session events', async () => {
    const session = makeSession({
      listMcpServers: mock(async () => [
        {
          name: 'local-tools',
          transport: 'stdio',
          status: 'connected',
          toolCount: 2,
        },
        {
          name: 'remote-tools',
          transport: 'http',
          status: 'failed',
          toolCount: 0,
          error: 'connection refused',
        },
      ]),
    });
    const { driver } = await makeDriver(session);

    session.onEvent.mockClear();
    session.listMcpServers.mockClear();
    driver.sessionEventHandler.startSubscription();

    await waitForAssertion(() => {
      expect(session.onEvent).toHaveBeenCalledTimes(1);
      expect(session.listMcpServers).toHaveBeenCalledTimes(1);
    });
    const subscribeOrder = session.onEvent.mock.invocationCallOrder[0];
    const snapshotOrder = session.listMcpServers.mock.invocationCallOrder[0];
    if (subscribeOrder === undefined || snapshotOrder === undefined) {
      throw new Error('Expected MCP status sync to subscribe and fetch a snapshot.');
    }
    expect(subscribeOrder).toBeLessThan(snapshotOrder);
    const transcript = renderTranscript(driver);
    expect(transcript).toContain('MCP server "local-tools" connected');
    expect(transcript).toContain('2 tools (stdio)');
    expect(transcript).toContain('MCP server "remote-tools" failed: connection refused');
  });

  it('deduplicates identical MCP status updates while allowing reconnect transitions', async () => {
    const eventListeners: Array<(event: Event) => void> = [];
    const connectedServer = {
      name: 'local-tools',
      transport: 'stdio',
      status: 'connected',
      toolCount: 2,
    };
    const session = makeSession({
      onEvent: mock((listener: (event: Event) => void) => {
        eventListeners.push(listener);
        return mock();
      }),
      listMcpServers: mock(async () => [connectedServer]),
    });
    const { driver } = await makeDriver(session);

    eventListeners.length = 0;
    driver.sessionEventHandler.startSubscription();

    await waitForAssertion(() => {
      expect(eventListeners.length).toBeGreaterThan(0);
    });
    eventListeners[0]?.({
      type: 'mcp.server.status',
      agentId: 'main',
      sessionId: 'ses-1',
      server: connectedServer,
    } as Event);

    expect(countOccurrences(renderTranscript(driver), 'MCP server "local-tools" connected')).toBe(
      1,
    );

    eventListeners[0]?.({
      type: 'mcp.server.status',
      agentId: 'main',
      sessionId: 'ses-1',
      server: {
        ...connectedServer,
        status: 'pending',
        toolCount: 0,
      },
    } as Event);
    eventListeners[0]?.({
      type: 'mcp.server.status',
      agentId: 'main',
      sessionId: 'ses-1',
      server: connectedServer,
    } as Event);

    expect(countOccurrences(renderTranscript(driver), 'MCP server "local-tools" connected')).toBe(
      2,
    );
  });

  it('does not let a late MCP snapshot overwrite a live status event', async () => {
    const eventListeners: Array<(event: Event) => void> = [];
    let resolveSnapshot: (
      servers: Array<{
        name: string;
        transport: 'stdio' | 'http' | 'sse';
        status: 'pending' | 'connected' | 'failed' | 'disabled';
        toolCount: number;
        error?: string;
      }>,
    ) => void = () => {};
    const snapshot = new Promise((resolve) => {
      resolveSnapshot = resolve;
    });
    const session = makeSession({
      onEvent: mock((listener: (event: Event) => void) => {
        eventListeners.push(listener);
        return mock();
      }),
      listMcpServers: mock(() => snapshot),
    });
    const { driver } = await makeDriver(session);

    eventListeners.length = 0;
    driver.sessionEventHandler.startSubscription();

    await waitForAssertion(() => {
      expect(eventListeners.length).toBeGreaterThan(0);
    });
    eventListeners[0]?.({
      type: 'mcp.server.status',
      agentId: 'main',
      sessionId: 'ses-1',
      server: {
        name: 'local-tools',
        transport: 'stdio',
        status: 'connected',
        toolCount: 2,
      },
    } as Event);
    resolveSnapshot([
      {
        name: 'local-tools',
        transport: 'stdio',
        status: 'failed',
        toolCount: 0,
        error: 'stale failure',
      },
    ]);
    await Promise.resolve();

    const transcript = renderTranscript(driver);
    expect(transcript).toContain('MCP server "local-tools" connected');
    expect(transcript).not.toContain('stale failure');
  });

  it('sends normal editor input to the active session and marks the turn as waiting', async () => {
    const { driver, session } = await makeDriver();

    driver.handleUserInput('hello');

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith('hello', { promptId: undefined });
    });
    expect(driver.state.appState.streamingPhase).not.toBe('idle');
    expect(readStreamingPhase(driver)).toBe('waiting');
    expect(driver.state.livePane.mode).toBe('waiting');
    expect(driver.state.transcriptEntries).toEqual([
      expect.objectContaining({
        kind: 'user',
        content: 'hello',
      }),
    ]);
  });

  it('keeps the transcript intact when undo RPC fails', async () => {
    const session = makeSession({
      undoHistory: mock(async () => {
        throw new Error('core rpc unavailable');
      }),
    });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('hello');
    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    driver.state.appState.streamingPhase = 'idle';

    driver.handleUserInput('/undo');
    await confirmUndoSelection(driver);

    await waitForAssertion(() => {
      expect(session.undoHistory).toHaveBeenCalledWith(1);
    });
    await waitForAssertion(() => {
      expect(stripSgr(renderTranscript(driver))).toContain(
        'Error: Failed to undo: core rpc unavailable',
      );
    });

    // The undo failure surfaces as an error status entry; the user turn itself
    // must survive the failed undo.
    expect(
      driver.state.transcriptEntries.filter((entry) => entry.kind !== 'status'),
    ).toEqual([
      expect.objectContaining({
        kind: 'user',
        content: 'hello',
      }),
    ]);
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('hello');
  });

  it('does not duplicate welcome after undoing the only turn', async () => {
    const { driver, session } = await makeDriver();

    driver.handleUserInput('hello');
    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    driver.state.appState.streamingPhase = 'idle';

    driver.handleUserInput('/undo');
    await confirmUndoSelection(driver);

    await waitForAssertion(() => {
      expect(driver.state.transcriptEntries).toEqual([]);
    });

    expect(
      driver.state.transcriptContainer.children.filter(
        (child) => child instanceof WelcomeComponent,
      ),
    ).toHaveLength(1);
  });

  it('keeps command notices that are not part of the undone context', async () => {
    const { driver, session } = await makeDriver();

    driver.handleUserInput('hello');
    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    driver.state.appState.streamingPhase = 'idle';
    driver.handleUserInput('/auto');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PermissionSelectorComponent);
    });
    (driver.state.editorContainer.children[0] as PermissionSelectorComponent).handleInput('\r');

    await waitForAssertion(() => {
      expect(stripSgr(renderTranscript(driver))).toContain('Permission mode: Never Ask');
    });

    driver.handleUserInput('/undo 10');
    await waitForAssertion(() => {
      expect(stripSgr(renderTranscript(driver))).toContain(
        'Cannot undo 10; only 1 can be undone in the active context.',
      );
    });

    driver.handleUserInput('/undo');
    await confirmUndoSelection(driver);

    await waitForAssertion(() => {
      expect(session.undoHistory).toHaveBeenCalledWith(1);
    });

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).not.toContain('hello');
    expect(transcript).not.toContain('Cannot undo 10 prompts');
    expect(transcript).toContain('Permission mode: Never Ask');
    expect(transcript).toContain(
      'Never interrupts you; everything runs and is decided automatically.',
    );
    expect(readPermissionMode(driver)).toBe('auto');
  });

  it('removes turn-scoped background status entries and restores welcome', async () => {
    const { driver, session } = await makeDriver();

    driver.handleUserInput('hello');
    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    driver.state.appState.streamingPhase = 'idle';
    driver.sessionEventHandler.handleEvent(
      {
        type: 'background.task.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        info: {
          kind: 'process',
          taskId: 'bash-bg123456',
          command: 'npm test',
          description: 'Run tests in background',
          status: 'running',
          pid: 1234,
          exitCode: null,
          startedAt: Date.now(),
          endedAt: null,
        },
      } as Event,
      () => {},
    );

    await waitForAssertion(() => {
      const transcript = stripSgr(renderTranscript(driver));
      expect(transcript).toContain('bash task started in background');
      expect(transcript).toContain('Run tests in background');
    });

    driver.handleUserInput('/undo');
    await confirmUndoSelection(driver);

    await waitForAssertion(() => {
      expect(session.undoHistory).toHaveBeenCalledWith(1);
    });

    const transcript = stripSgr(renderTranscript(driver));
    expect(driver.state.transcriptEntries).toEqual([]);
    expect(transcript).not.toContain('hello');
    expect(transcript).not.toContain('bash task started in background');
    expect(transcript).not.toContain('Run tests in background');
    expect(
      driver.state.transcriptContainer.children.filter(
        (child) => child instanceof WelcomeComponent,
      ),
    ).toHaveLength(1);
  });

  it('removes AgentSwarm progress from undone turns', async () => {
    const { driver, session } = await makeDriver();
    const sendQueued = mock();

    driver.handleUserInput('launch swarm');
    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_swarm',
        name: 'AgentSwarm',
        args: {
          description: 'Review changed files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts'],
        },
      } as Event,
      sendQueued,
    );

    let transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('launch swarm');
    expect(transcript).toContain('Agent Swarm');
    expect(transcript).toContain('Review changed files');

    driver.state.appState.streamingPhase = 'idle';
    driver.handleUserInput('/undo');
    await confirmUndoSelection(driver);

    await waitForAssertion(() => {
      expect(session.undoHistory).toHaveBeenCalledWith(1);
    });

    transcript = stripSgr(renderTranscript(driver));
    expect(transcript).not.toContain('launch swarm');
    expect(transcript).not.toContain('Agent Swarm');
    expect(transcript).not.toContain('Review changed files');
  });

  it('removes approval notices from undone turns', async () => {
    const { driver, session } = await makeDriver();
    const approvalHandler = session.setApprovalHandler.mock.calls[0]?.[0] as
      | ((request: ApprovalRequest) => Promise<ApprovalResponse>)
      | undefined;
    if (approvalHandler === undefined) throw new Error('expected approval handler');

    driver.handleUserInput('hello');
    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    driver.state.appState.streamingPhase = 'idle';
    const response = approvalHandler({
      turnId: 1,
      toolCallId: 'call_bash',
      toolName: 'Bash',
      action: 'Run shell command',
      display: {
        kind: 'generic',
        summary: 'Run shell command',
        detail: { command: 'echo ok', description: 'Run a shell command' },
      },
    });

    await waitForAssertion(() => {
      expect(driver.state.approvalRegion.panelComponent()).toBeInstanceOf(ApprovalPanelComponent);
    });
    // The approval is a region of the status strip, so it never takes the
    // editor's slot. (`editorReplacementMounted` is the other mechanism —
    // dialogs that really do swap the input area out — and an approval must
    // leave it false.)
    expect(driver.state.approvalRegion.isEmpty()).toBe(false);
    expect(driver.state.statusSurface.hasBlockingRegion()).toBe(true);
    expect(driver.state.editorReplacementMounted).toBe(false);
    driver.state.approvalRegion.panelComponent()!.handleInput('1');
    await expect(response).resolves.toMatchObject({ decision: 'approved' });

    await waitForAssertion(() => {
      expect(stripSgr(renderTranscript(driver))).toContain('Approved: Run shell command');
    });

    driver.handleUserInput('/undo');
    await confirmUndoSelection(driver);

    await waitForAssertion(() => {
      expect(session.undoHistory).toHaveBeenCalledWith(1);
    });

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).not.toContain('hello');
    expect(transcript).not.toContain('Approved: Run shell command');
  });

  it('removes debug timing status from undone turns', async () => {
    const { driver, session } = await makeDriver();
    const previousDebug = process.env['KIMI_CODE_DEBUG'];
    process.env['KIMI_CODE_DEBUG'] = '1';
    try {
      driver.handleUserInput('hello');
      await waitForAssertion(() => {
        expect(session.prompt).toHaveBeenCalled();
      });
      driver.sessionEventHandler.handleEvent(
        {
          type: 'turn.step.completed',
          agentId: 'main',
          sessionId: 'ses-1',
          turnId: 1,
          step: 1,
          llmFirstTokenLatencyMs: 120,
          llmStreamDurationMs: 800,
        } as Event,
        () => {},
      );

      await waitForAssertion(() => {
        expect(stripSgr(renderTranscript(driver))).toContain('[Debug]');
      });

      driver.state.appState.streamingPhase = 'idle';
      driver.handleUserInput('/undo');
      await confirmUndoSelection(driver);

      await waitForAssertion(() => {
        expect(session.undoHistory).toHaveBeenCalledWith(1);
      });

      const transcript = stripSgr(renderTranscript(driver));
      expect(transcript).not.toContain('hello');
      expect(transcript).not.toContain('[Debug]');
    } finally {
      if (previousDebug === undefined) {
        delete process.env['KIMI_CODE_DEBUG'];
      } else {
        process.env['KIMI_CODE_DEBUG'] = previousDebug;
      }
    }
  });

  it('undoes multiple turns when a count is provided', async () => {
    const { driver, session } = await makeDriver();

    driver.handleUserInput('first');
    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledTimes(1);
    });
    driver.state.appState.streamingPhase = 'idle';
    driver.handleUserInput('second');
    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledTimes(2);
    });
    driver.state.appState.streamingPhase = 'idle';
    driver.handleUserInput('third');
    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledTimes(3);
    });
    driver.state.appState.streamingPhase = 'idle';

    driver.handleUserInput('/undo 2');

    await waitForAssertion(() => {
      expect(session.undoHistory).toHaveBeenCalledWith(2);
    });

    expect(driver.state.transcriptEntries).toEqual([
      expect.objectContaining({
        kind: 'user',
        content: 'first',
      }),
    ]);
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('first');
    expect(transcript).not.toContain('second');
    expect(transcript).not.toContain('third');
  });

  it('rejects invalid undo counts without changing context', async () => {
    const { driver, session } = await makeDriver();

    driver.handleUserInput('hello');
    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    driver.state.appState.streamingPhase = 'idle';

    driver.handleUserInput('/undo 0');

    await waitForAssertion(() => {
      expect(stripSgr(renderTranscript(driver))).toContain(
        'Error: Usage: /undo [count], where count is a positive integer.',
      );
    });

    expect(session.undoHistory).not.toHaveBeenCalled();
    expect(
      driver.state.transcriptEntries.filter((entry) => entry.kind !== 'status'),
    ).toEqual([
      expect.objectContaining({
        kind: 'user',
        content: 'hello',
      }),
    ]);
  });

  it('undoes from the real user turn when the last skill activation came from the model', async () => {
    const { driver, session } = await makeDriver();

    driver.handleUserInput('hello');
    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    driver.sessionEventHandler.handleEvent(
      {
        type: 'skill.activated',
        agentId: 'main',
        activationId: 'act-model',
        skillName: 'review',
        trigger: 'model-tool',
      } as Event,
      () => {},
    );
    driver.state.appState.streamingPhase = 'idle';

    driver.handleUserInput('/undo');
    await confirmUndoSelection(driver);

    await waitForAssertion(() => {
      expect(driver.state.transcriptEntries).toEqual([]);
    });

    expect(driver.state.transcriptEntries).toEqual([]);
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).not.toContain('hello');
    expect(transcript).not.toContain('review');
  });

  it('undoes a user skill prompt together with its activation', async () => {
    const session = makeSession({
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const { driver } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    driver.handleUserInput('hello');
    driver.state.appState.streamingPhase = 'idle';
    driver.handleUserInput('/skill:review');
    await waitForAssertion(() => { expect(driver.state.transcriptEntries).toHaveLength(2); });
    driver.sessionEventHandler.handleEvent(
      {
        type: 'skill.activated',
        agentId: 'main',
        activationId: 'act-user',
        skillName: 'review',
        trigger: 'user-slash',
      } as Event,
      () => {},
    );
    driver.state.appState.streamingPhase = 'idle';

    driver.handleUserInput('/undo');
    await confirmUndoSelection(driver);

    await waitForAssertion(() => {
      expect(driver.state.transcriptEntries).toEqual([
        expect.objectContaining({
          kind: 'user',
          content: 'hello',
        }),
      ]);
    });

    expect(driver.state.transcriptEntries).toEqual([
      expect.objectContaining({
        kind: 'user',
        content: 'hello',
      }),
    ]);
    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('hello');
    expect(transcript).not.toContain('review');
  });

  it('deletes a pasted video’s daemon upload when the consuming turn ends', async () => {
    const session = makeSession();
    const { driver, harness } = await makeDriver(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addVideo('video/mp4', '/tmp/clip.mp4');
    imageStore.completeVideo(attachment, { fileId: 'file-v1' });

    driver.handleUserInput(`watch ${attachment.placeholder}`);

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    const parts = session.prompt.mock.calls[0]?.[0] as
      | Array<{
          type: string;
          text?: string;
          videoUrl?: { url: string };
        }>
      | undefined;
    expect(parts?.[0]).toEqual({ type: 'text', text: 'watch ' });
    expect(parts?.[1]).toEqual({ type: 'video_url', videoUrl: { url: 'kimi-file://file-v1' } });
    expect(harness.deleteFile).not.toHaveBeenCalled();

    emitTurn(driver, 1);

    await waitForAssertion(() => {
      expect(harness.deleteFile).toHaveBeenCalledWith('file-v1');
    });
    expect(attachment.fileId).toBeUndefined();
  });

  it('queues a pasted video (kimi-file part) while a turn is streaming', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addVideo('video/mp4', '/tmp/clip.mp4');
    imageStore.completeVideo(attachment, { fileId: 'file-v1' });
    driver.state.appState.streamingPhase = 'waiting';

    driver.handleUserInput(`describe ${attachment.placeholder}`);

    expect(session.prompt).not.toHaveBeenCalled();
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toHaveLength(1);
    });
    const queued = driver.state.queuedMessages[0];
    const parts = queued?.parts as Array<{
      type: string;
      text?: string;
      videoUrl?: { url: string };
    }>;
    expect(parts?.[0]).toEqual({ type: 'text', text: 'describe ' });
    expect(parts?.[1]).toEqual({ type: 'video_url', videoUrl: { url: 'kimi-file://file-v1' } });
    expect(queued?.videoAttachmentIds).toEqual([attachment.id]);

    driver.sendQueuedMessage(session, queued!);
    expect(session.prompt.mock.calls[0]?.[0]).toEqual(parts);
  });

  it('falls back to retained bytes when a queued image upload expires before dispatch', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addImage(
      new Uint8Array([0xaa, 0xbb]),
      'image/png',
      1,
      1,
      undefined,
      'file-expired',
      1,
    );

    driver.sendQueuedMessage(session, {
      text: `describe ${attachment.placeholder}`,
      parts: [{ type: 'image_url', imageUrl: { url: 'kimi-file://file-expired' } }],
      imageAttachmentIds: [attachment.id],
    });

    expect(session.prompt).toHaveBeenCalledWith(
      [{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } }],
      { promptId: expect.any(String) },
    );
  });

  it('sends pasted image placeholders as image content parts', async () => {
    const { driver, session } = await makeDriver();
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addImage(new Uint8Array([0xaa, 0xbb]), 'image/png', 1, 1);

    driver.handleUserInput(`describe ${attachment.placeholder}`);

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith(
        [
          { type: 'text', text: 'describe ' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
        ],
        // Staged media rides with a client-chosen prompt id so the consuming
        // turn's `turn.started` can bind the lease exactly.
        { promptId: expect.any(String) },
      );
    });
    expect(driver.state.transcriptEntries).toEqual([
      expect.objectContaining({
        kind: 'user',
        content: `describe ${attachment.placeholder}`,
        imageAttachmentIds: [attachment.id],
      }),
    ]);
  });

  it('keeps an image staging upload until the consuming turn ends', async () => {
    const { driver, session, harness } = await makeDriver();
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = stagedImage(imageStore, 'file-1');

    driver.handleUserInput(attachment.placeholder);

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledTimes(1);
    });
    emitTurn(driver, 1, () => {
      expect(harness.deleteFile).not.toHaveBeenCalled();
    });
    await waitForAssertion(() => {
      expect(harness.deleteFile).toHaveBeenCalledWith('file-1');
    });
    expect(attachment.fileId).toBeUndefined();
    expect(attachment.bytes).toEqual(new Uint8Array([0xaa, 0xbb]));
  });

  it('keeps a bundled-skill staging upload until the consuming turn ends', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(
      session,
      {
        listWorkspaceSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
          {
            name: 'security',
            description: 'Security skill',
            path: '/tmp/security',
            source: 'user',
          },
        ]),
        listPluginCommands: mock(async () => []),
      },
      startupInput,
    );
    await (driver as unknown as { refreshSkillCommands(): Promise<void> }).refreshSkillCommands();
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = stagedImage(imageStore, 'file-skill');

    driver.handleUserInput(`/skill:review inspect ${attachment.placeholder} /skill:security`);

    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledTimes(1);
    });
    expect(harness.deleteFile).not.toHaveBeenCalled();
    // The bundled submission's own turn carries the `user` origin (its prompt
    // origin is `user`); its lease must be claimed there and released (deleted)
    // at turn end — not prematurely at the intermediate check below.
    emitTurn(
      driver,
      1,
      () => {
        expect(harness.deleteFile).not.toHaveBeenCalled();
      },
      { kind: 'user' },
    );
    await waitForAssertion(() => {
      expect(harness.deleteFile).toHaveBeenCalledWith('file-skill');
    });
    expect(attachment.fileId).toBeUndefined();
  });

  it('keeps a queued bundled-skill staging upload until its turn ends', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(
      session,
      {
        listWorkspaceSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
          {
            name: 'security',
            description: 'Security skill',
            path: '/tmp/security',
            source: 'user',
          },
        ]),
        listPluginCommands: mock(async () => []),
      },
      startupInput,
    );
    await (driver as unknown as { refreshSkillCommands(): Promise<void> }).refreshSkillCommands();
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = stagedImage(imageStore, 'file-skill-queued');
    driver.state.appState.streamingPhase = 'waiting';

    driver.handleUserInput(`/skill:review inspect ${attachment.placeholder} /skill:security`);
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toHaveLength(1);
    });
    expect(session.promptWithSkills).not.toHaveBeenCalled();

    driver.sendQueuedMessage(session, driver.state.queuedMessages[0]!);
    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledTimes(1);
    });
    expect(harness.deleteFile).not.toHaveBeenCalled();

    emitTurn(driver, 2, undefined, { kind: 'user' });
    await waitForAssertion(() => {
      expect(harness.deleteFile).toHaveBeenCalledWith('file-skill-queued');
    });
    expect(attachment.fileId).toBeUndefined();
  });

  it('keeps an image staging upload across lazy session creation (v2 engine)', async () => {
    const session = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(session, {}, startupInput);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = stagedImage(imageStore, 'file-lazy');

    driver.handleUserInput(attachment.placeholder);

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith(
        [{ type: 'image_url', imageUrl: { url: 'kimi-file://file-lazy' } }],
        { promptId: expect.any(String) },
      );
    });
    expect(harness.deleteFile).not.toHaveBeenCalled();
    emitTurn(driver, 1, () => {
      expect(harness.deleteFile).not.toHaveBeenCalled();
    });
    await waitForAssertion(() => {
      expect(harness.deleteFile).toHaveBeenCalledWith('file-lazy');
    });
  });

  it('still deletes the staging upload when a cache-hint dismissal precedes the resend', async () => {
    const { driver, session, harness } = await makeDriver();
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = stagedImage(imageStore, 'file-dismissed');
    const text = `describe ${attachment.placeholder}`;

    // Simulate a cache-hint interception dismissed back into the editor: the
    // submit's extraction is stashed, then restored with recall semantics
    // (retain consumed, staged upload kept for the restored draft).
    const extraction = await extractMediaAttachments(text, imageStore);
    driver.recallStashedMedia(extraction);

    driver.handleUserInput(text);

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledTimes(1);
    });
    emitTurn(driver, 1, () => {
      expect(harness.deleteFile).not.toHaveBeenCalled();
    });
    await waitForAssertion(() => {
      expect(harness.deleteFile).toHaveBeenCalledWith('file-dismissed');
    });
    expect(harness.deleteFile).toHaveBeenCalledTimes(1);
  });

  it('waits briefly for a pending paste ingestion so the submit uses the daemon-ref form', async () => {
    const { driver, session } = await makeDriver();
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addImage(new Uint8Array([0xaa, 0xbb]), 'image/png', 1, 1);
    let finishIngestion!: () => void;
    attachment.pending = new Promise<void>((resolve) => {
      finishIngestion = () => {
        attachment.fileId = 'file-late';
        attachment.fileExpiresAt = Date.now() + 60 * 60 * 1000;
        attachment.pending = undefined;
        resolve();
      };
    });

    driver.handleUserInput(`describe ${attachment.placeholder}`);
    expect(session.prompt).not.toHaveBeenCalled();

    finishIngestion();
    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith(
        [
          { type: 'text', text: 'describe ' },
          { type: 'image_url', imageUrl: { url: 'kimi-file://file-late' } },
        ],
        { promptId: expect.any(String) },
      );
    });
  });

  it.each(['enter', 'steer'])('preserves literal leading multiline input and editor tab normalization (%s)', async (delivery) => {
    for (const separator of ['\n', '\t']) {
      const session = makeSession({
        listSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
        ]),
      });
      const { driver } = await makeDriver(session);
      await (
        driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
      ).refreshSkillCommands(session);
      driver.state.editor.setText(`/skill:review${separator}explain this`);
      if (delivery === 'steer') driver.state.appState.streamingPhase = 'waiting';
      driver.state.editor.handleInput(delivery === 'enter' ? '\r' : '\u0013');
      if (separator === '\n') {
        await waitForAssertion(() => {
          expect(delivery === 'enter' ? session.prompt : session.steer).toHaveBeenCalled();
        });
        expect(session.promptWithSkills).not.toHaveBeenCalled();
        expect((delivery === 'enter' ? session.prompt : session.steer).mock.calls[0]?.[0]).toBe(
          '/skill:review\nexplain this',
        );
      } else {
        await waitForAssertion(() => {
          expect(session.promptWithSkills).toHaveBeenCalled();
        });
        if (delivery === 'enter') expect(session.promptWithSkills).toHaveBeenCalledWith(
          '/skill:review    explain this', [{ name: 'review', args: 'explain this' }],
        );
        else expect(session.promptWithSkills).toHaveBeenCalledWith(
          '/skill:review    explain this', [{ name: 'review', args: 'explain this' }], { steerIfActive: true },
        );
      }
    }
  });

  it('keeps a pending skill video when another input creates the first session', async () => {
    process.env['KIMI_CODE_HOME'] = await makeTempHome();
    const sourcePath = join(process.env['KIMI_CODE_HOME'], 'example.mp4');
    await writeFile(sourcePath, 'example video');
    const session = makeSession({
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(session, {}, startupInput);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addVideo('video/mp4', sourcePath);
    let finishIngestion!: () => void;
    attachment.pending = new Promise<void>((resolve) => {
      finishIngestion = () => {
        imageStore.completeVideo(attachment, { fileId: 'file-first-session' });
        resolve();
      };
    });
    const input = `/skill:review ${attachment.placeholder}`;
    driver.state.editor.setText(input);
    driver.state.editor.handleInput('\r');
    driver.handleUserInput('create the first session');
    await waitForAssertion(() => { expect(session.prompt).toHaveBeenCalled(); });
    finishIngestion();
    await waitForAssertion(() => { expect(driver.state.queuedMessages).toHaveLength(1); });
    expect(driver.state.queuedMessages[0]?.text).toBe(input);
    driver.sessionEventHandler.handleEvent(
      { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event,
      (item) => { driver.sendQueuedMessage(session, item); },
    );
    await waitForAssertion(() => { expect(session.promptWithSkills).toHaveBeenCalledTimes(1); });
    expect(stripSgr(renderTranscript(driver))).not.toContain('Session changed');
  });

  it('keeps queued image parts aligned when one stashed skill attachment was removed', async () => {
    process.env['KIMI_CODE_HOME'] = await makeTempHome();
    const { driver, session } = await makeDriver();
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const first = imageStore.addImage(new Uint8Array([1]), 'image/png', 1, 1, undefined, 'file-first');
    const second = imageStore.addImage(new Uint8Array([2]), 'image/png', 1, 1, undefined, 'file-second');
    const input = `/skill:review ${first.placeholder} ${second.placeholder}`;
    const extraction = await extractMediaAttachments(input, imageStore);
    imageStore.remove(first.id);
    driver.state.appState.streamingPhase = 'waiting';
    await (
      driver as unknown as { sendInlineSkillUserInput(t: string, skills: Array<{ skillName: string; args: string }>, e: ExtractionResult): Promise<void> }
    ).sendInlineSkillUserInput(input, [{ skillName: 'review', args: `${first.placeholder} ${second.placeholder}` }], extraction);
    driver.state.appState.streamingPhase = 'idle';
    driver.sendQueuedMessage(session, driver.state.queuedMessages.shift()!);
    await waitForAssertion(() => { expect(session.promptWithSkills).toHaveBeenCalledTimes(1); });
    const [parts] = (
      session.promptWithSkills as Mock<(input: unknown, skills: unknown) => Promise<void>>
    ).mock.calls[0]!;
    expect(parts).toEqual([
      { type: 'text', text: '/skill:review ' },
      { type: 'image_url', imageUrl: { url: 'kimi-file://file-first' } },
      { type: 'image_url', imageUrl: { url: 'kimi-file://file-second' } },
    ]);
  });

  it.each([
    { action: 'new', existingSession: true },
    { action: 'switch', existingSession: true },
    { action: 'new', existingSession: false },
    { action: 'switch', existingSession: false },
  ])('does not send a pending skill video after a session change ($action, existing=$existingSession)', async ({ action, existingSession }) => {
    const listSkills = mock(async () => [
      { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
    ]);
    const session = makeSession({ listSkills });
    const nextSession = makeSession({ id: 'ses-next', listSkills });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(session, {
      createSession: mock(async () => nextSession),
    }, existingSession ? undefined : startupInput);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addVideo('video/mp4', '/tmp/example.mp4');
    let finishIngestion!: () => void;
    attachment.pending = new Promise<void>((resolve) => {
      finishIngestion = () => {
        imageStore.completeVideo(attachment, { fileId: 'file-old-session' });
        resolve();
      };
    });
    driver.state.editor.setText(`/skill:review ${attachment.placeholder}`);
    driver.state.editor.handleInput('\r');
    expect(session.promptWithSkills).not.toHaveBeenCalled();
    if (action === 'new') driver.handleUserInput('/new');
    else await (
      driver as unknown as { switchToSession(s: unknown, status: string): Promise<void> }
    ).switchToSession(nextSession, 'Resumed session');
    await waitForAssertion(() => {
      expect(driver.getCurrentSessionId()).toBe(nextSession.id);
    });
    driver.state.editor.setText('keep this new draft');
    finishIngestion();
    await new Promise((resolve) => setImmediate(resolve));

    expect(session.promptWithSkills).not.toHaveBeenCalled();
    expect(nextSession.promptWithSkills).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([]);
    expect(driver.state.editor.getText()).toBe('keep this new draft');
    expect(stripSgr(renderTranscript(driver))).toContain('Session changed');
  });

  it.each(['drain', 'steer'])('uses the cached skill video argument instead of an expired queued video part (%s)', async (delivery) => {
    process.env['KIMI_CODE_HOME'] = await makeTempHome();
    const sourcePath = join(process.env['KIMI_CODE_HOME'], 'example.mp4');
    await writeFile(sourcePath, 'example video');
    const session = makeSession({
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const { driver } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addVideo('video/mp4', sourcePath);
    imageStore.completeVideo(attachment, {
      fileId: 'file-expiring-video', fileExpiresAt: Date.now() + 60 * 60 * 1000,
    });
    driver.state.appState.streamingPhase = 'waiting';
    const input = `/skill:review describe ${attachment.placeholder}`;
    driver.state.editor.setText(input);
    driver.state.editor.handleInput('\r');
    expect(driver.state.queuedMessages).toHaveLength(1);
    expect(session.promptWithSkills).not.toHaveBeenCalled();
    attachment.fileExpiresAt = Date.now() - 1;
    if (delivery === 'drain') {
      driver.state.appState.streamingPhase = 'idle';
      driver.sendQueuedMessage(session, driver.state.queuedMessages.shift()!);
    } else {
      driver.state.editor.handleInput('\u0013');
    }
    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledTimes(1);
    });
    const [parts, skills] = (
      session.promptWithSkills as Mock<(input: unknown, skills: unknown) => Promise<void>>
    ).mock.calls[0]!;
    expect(parts).not.toContainEqual({
      type: 'video_url', videoUrl: { url: 'kimi-file://file-expiring-video' },
    });
    const args = (skills as Array<{ args: string }>)[0]!.args;
    const path = args.match(/Attached video file: (.+?) \(open it with Read\)/)?.[1];
    expect(path).toBeDefined();
    expect(await readFile(path!)).toEqual(Buffer.from('example video'));
    expect(driver.state.transcriptEntries).toContainEqual(expect.objectContaining({
      kind: 'user', content: input,
    }));
    emitTurn(driver, 1);
    expect(existsSync(path!)).toBe(true);
    await driver.closeSession('test');
    await waitForAssertion(() => { expect(existsSync(path!)).toBe(false); });
  });

  it.each(['image', 'video'])('preserves skill media arguments when the cache hint starts a new session (%s)', async (kind) => {
    process.env['KIMI_CODE_HOME'] = await makeTempHome();
    const listSkills = mock(async () => [
      { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
    ]);
    const session = makeSession({ listSkills });
    const nextSession = makeSession({
      id: 'ses-next', listSkills,
      promptWithSkills: mock(async (_input: unknown, _skills: unknown) => {}),
    });
    const { driver } = await makeDriver(session, {
      createSession: mock(async () => nextSession),
    });
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    driver.state.appState.availableModels = {
      k2: { model: 'example-model', provider: 'example-provider', maxContextSize: 100 },
    };
    driver.state.appState.availableProviders = {
      'example-provider': { type: 'kimi', oauth: { key: 'kimi-code', storage: 'file' } },
    };
    driver.state.appState.contextTokens = 150000;
    const peek = spyOn(cacheHintConfig, 'peekCacheHintConfig').mockReturnValue({
      version: 1,
      config: { 'example-model': { min_tokens_to_hint: 100000, cache_duration: 600 } },
    });
    (driver as unknown as { cacheHint: { recordActivity(): void } }).cacheHint.recordActivity();
    const now = spyOn(Date, 'now').mockReturnValue(Date.now() + 1200_000);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = kind === 'image'
      ? stagedImage(imageStore, 'file-cached-skill')
      : imageStore.addVideo('video/mp4', join(process.env['KIMI_CODE_HOME'], 'example.mp4'));
    if (attachment.kind === 'video') {
      await writeFile(attachment.sourcePath, 'example video');
      imageStore.completeVideo(attachment, {
        fileId: 'file-cached-skill', fileExpiresAt: Date.now() + 3600_000,
      });
    }
    const input = `/skill:review describe ${attachment.placeholder}`;
    try {
      driver.state.editor.setText(input);
      driver.state.editor.handleInput('\r');
      const dialog = driver.state.editorContainer.children[0];
      expect(dialog).toBeInstanceOf(CacheHintDialogComponent);
      now.mockRestore();
      dialog!.handleInput!('\u001B[B');
      dialog!.handleInput!('\r');
      await waitForAssertion(() => {
        expect(nextSession.promptWithSkills).toHaveBeenCalledTimes(1);
      });

      expect(session.promptWithSkills).not.toHaveBeenCalled();
      const [parts, skills] = (
        nextSession.promptWithSkills as Mock<(input: unknown, skills: unknown) => Promise<void>>
      ).mock.calls[0]!;
      expect(parts).toContainEqual(kind === 'image'
        ? { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } }
        : { type: 'video_url', videoUrl: { url: 'kimi-file://file-cached-skill' } });
      expect(skills).toEqual([{ name: 'review', args: expect.stringContaining(`Attached ${kind} file:`) }]);
      const args = (skills as Array<{ args: string }>)[0]!.args;
      expect(args).not.toContain(attachment.placeholder);
      const path = args.match(/Attached (?:image|video) file: (.+?) \(open it with Read\)/)?.[1];
      expect(path).toBeDefined();
      expect(await readFile(path!)).toEqual(kind === 'image' ? Buffer.from([0xaa, 0xbb]) : Buffer.from('example video'));
      expect(driver.state.transcriptEntries).toContainEqual(expect.objectContaining({
        kind: 'user', content: input,
      }));
      emitTurn(driver, 1);
      expect(existsSync(path!)).toBe(true);
      await driver.closeSession('test');
      await waitForAssertion(() => { expect(existsSync(path!)).toBe(false); });
    } finally {
      now.mockRestore();
      peek.mockRestore();
    }
  });

  it.each([
    { prefix: '/skill:review', skills: [{ name: 'review', args: expect.stringContaining('Attached video file:') }] },
    { prefix: 'watch /skill:review', skills: [{ name: 'review' }] },
    { prefix: '/skill:review /skill:security', skills: [{ name: 'review' }, { name: 'security' }] },
  ])('waits for a pending video before submitting a skill prompt ($prefix)', async ({ prefix, skills }) => {
    process.env['KIMI_CODE_HOME'] = await makeTempHome();
    const sourcePath = join(process.env['KIMI_CODE_HOME'], 'example.mp4');
    await writeFile(sourcePath, 'example video');
    const session = makeSession({
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
        { name: 'security', description: 'Security skill', path: '/tmp/security', source: 'user' },
      ]),
    });
    const { driver, harness } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addVideo('video/mp4', sourcePath);
    let finishIngestion!: () => void;
    attachment.pending = new Promise<void>((resolve) => {
      finishIngestion = () => {
        imageStore.completeVideo(attachment, { fileId: 'file-skill-video' });
        resolve();
      };
    });
    const input = `${prefix} ${attachment.placeholder}`;
    driver.state.editor.setText(input);
    driver.state.editor.handleInput('\r');

    expect(session.promptWithSkills).not.toHaveBeenCalled();
    expect(driver.state.editor.getText()).toBe('');
    expect(stripSgr(renderTranscript(driver))).not.toContain('Failed to prepare');
    finishIngestion();

    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledWith(
        [
          { type: 'text', text: `${prefix} ` },
          { type: 'video_url', videoUrl: { url: 'kimi-file://file-skill-video' } },
        ],
        skills,
      );
    });
    expect(driver.state.transcriptEntries).toContainEqual(expect.objectContaining({
      kind: 'user', content: input,
    }));
    emitTurn(driver, 1);
    await waitForAssertion(() => {
      expect(harness.deleteFile).toHaveBeenCalledTimes(1);
      expect(harness.deleteFile).toHaveBeenCalledWith('file-skill-video');
    });
  });

  it.each(['', 'keep this draft'])('keeps a timed-out skill video in input history without changing the editor (%s)', async (nextDraft) => {
    const session = makeSession({
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const { driver } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    driver.persistInputHistory = mock(async (text) => { driver.state.editor.addToHistory(text); });
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addVideo('video/mp4', '/tmp/example.mp4');
    let finishIngestion!: () => void;
    attachment.pending = new Promise<void>((resolve) => {
      finishIngestion = () => {
        imageStore.completeVideo(attachment, { fileId: 'file-timed-out' });
        resolve();
      };
    });
    const input = `/skill:review ${attachment.placeholder}`;
    const clock = installGlobalClock();
    try {
      driver.state.editor.setText(input);
      driver.state.editor.handleInput('\r');
      driver.state.editor.setText(nextDraft);
      await advanceClockAsync(clock, 1_999);
      expect(stripSgr(renderTranscript(driver))).not.toContain('Failed to prepare');
      expect(session.promptWithSkills).not.toHaveBeenCalled();

      await advanceClockAsync(clock, 1);
      expect(stripSgr(renderTranscript(driver))).toContain('still uploading');
      expect(driver.state.editor.getText()).toBe(nextDraft);
      expect(readStreamingPhase(driver)).toBe('idle');
      expect(session.promptWithSkills).not.toHaveBeenCalled();
      finishIngestion();
      await advanceClockAsync(clock, 0);
      expect(session.promptWithSkills).not.toHaveBeenCalled();
      driver.state.editor.handleInput('\u0001');
      driver.state.editor.handleInput('\u001B[A');
      expect(driver.state.editor.getText()).toBe(input);
      driver.state.editor.handleInput('\u001B[B');
      expect(driver.state.editor.getText()).toBe(nextDraft);
      expect(imageStore.get(attachment.id)?.fileId).toBe('file-timed-out');
    } finally {
      finishIngestion();
      restoreGlobalClock();
    }
  });

  it('releases staged media exactly once when the prompt dispatch rejects', async () => {
    const session = makeSession({
      prompt: mock(async () => {
        throw new Error('session closed');
      }),
    });
    const { driver, harness } = await makeDriver(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = stagedImage(imageStore, 'file-reject');

    driver.handleUserInput(attachment.placeholder);

    await waitForAssertion(() => {
      expect(readStreamingPhase(driver)).toBe('idle');
    });
    await waitForAssertion(() => {
      expect(stripSgr(renderTranscript(driver))).toContain('Failed to send: session closed');
    });
    expect(harness.deleteFile).toHaveBeenCalledWith('file-reject');

    emitTurn(driver, 1);
    await driver.closeSession('test');
    expect(harness.deleteFile).toHaveBeenCalledTimes(1);
  });

  it('force-exits instead of waiting for shutdown hooks when Ctrl+C is pressed during stop', async () => {
    const { driver } = await makeDriver();
    const stopUiForExit = spyOn(driver as unknown as { stopUiForExit(): void }, 'stopUiForExit')
      .mockImplementation(() => {});
    const onExit = mock(async () => {});
    (driver as unknown as { onExit?: (exitCode?: number) => Promise<void> }).onExit = onExit;
    let captured: ((data: string) => { consume?: boolean } | undefined) | undefined;
    spyOn(driver.state.ui, 'addInputListener').mockImplementation(((listener: unknown) => {
      captured = listener as (data: string) => { consume?: boolean } | undefined;
      return () => {};
    }) as never);
    spyOn(driver, 'closeSession').mockReturnValue(new Promise<void>(() => {}));

    const stopped = (driver as unknown as { stop(): Promise<void> }).stop();
    stopped.catch(() => {});

    expect(captured).toBeDefined();
    expect(captured?.('\u0003')).toEqual({ consume: true });
    expect(captured?.('a')).toBeUndefined();
    expect(stopUiForExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(130);
  });

  it('releases goal-steered staging media when the running goal turn ends', async () => {
    const { driver, session, harness } = await makeDriver();
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = stagedImage(imageStore, 'file-goal');
    driver.state.appState.goal = makeActiveGoalSnapshot();
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('7');

    driver.sendQueuedMessage(session, {
      text: attachment.placeholder,
      agentId: 'main',
      parts: [{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } }],
      imageAttachmentIds: [attachment.id],
    });

    expect(session.steer).toHaveBeenCalledTimes(1);
    expect(harness.deleteFile).not.toHaveBeenCalled();
    driver.sessionEventHandler.handleEvent(
      { type: 'turn.ended', agentId: 'main', turnId: 7, reason: 'completed' } as Event,
      () => {},
    );
    await waitForAssertion(() => {
      expect(harness.deleteFile).toHaveBeenCalledWith('file-goal');
    });
    expect(attachment.fileId).toBeUndefined();
  });

  it('releases every queued use of shared media when the queue is discarded', async () => {
    process.env['KIMI_CODE_HOME'] = await makeTempHome();
    const { driver, harness } = await makeDriver();
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = stagedImage(imageStore, 'file-queued');
    driver.state.appState.streamingPhase = 'waiting';

    driver.handleUserInput(`first ${attachment.placeholder}`);
    driver.handleUserInput(`second ${attachment.placeholder}`);
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toHaveLength(2);
    });

    driver.clearQueuedMessages();

    await waitForAssertion(() => {
      expect(harness.deleteFile).toHaveBeenCalledWith('file-queued');
    });
    expect(harness.deleteFile).toHaveBeenCalledTimes(1);
    expect(attachment.fileId).toBeUndefined();
  });

  it('does not delete shared daemon media while another turn still uses it', async () => {
    const session = makeSession();
    const { driver, harness } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = stagedImage(imageStore, 'file-shared-turn');

    driver.handleUserInput(`first ${attachment.placeholder}`);
    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    driver.sessionEventHandler.handleEvent(
      { type: 'turn.started', agentId: 'main', turnId: 1, origin: { kind: 'user' } } as Event,
      () => {},
    );
    driver.state.appState.streamingPhase = 'waiting';
    driver.handleUserInput(`second ${attachment.placeholder}`);
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toHaveLength(1);
    });
    driver.clearQueuedMessages();

    await Promise.resolve();
    expect(harness.deleteFile).not.toHaveBeenCalled();

    driver.sessionEventHandler.handleEvent(
      { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event,
      () => {},
    );
    await waitForAssertion(() => {
      expect(harness.deleteFile).toHaveBeenCalledWith('file-shared-turn');
    });
  });

  it('steers a skill draft with its original text and arguments', async () => {
    const session = makeSession({
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const { driver } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.editor.setText('/skill:review src/app.ts');

    driver.state.editor.onCtrlS?.();

    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledWith(
        '/skill:review src/app.ts',
        [{ name: 'review', args: 'src/app.ts' }],
        { steerIfActive: true },
      );
    });
    expect(session.activateSkill).not.toHaveBeenCalled();
    expect(session.steer).not.toHaveBeenCalled();
    expect(driver.state.editor.getText()).toBe('');
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it.each(['/skill:review', 'check /skill:review'])(
    'retries a failed skill video from input history (%s)',
    async (prefix) => {
      process.env['KIMI_CODE_HOME'] = await makeTempHome();
      const sourcePath = join(process.env['KIMI_CODE_HOME'], 'example.mp4');
      await writeFile(sourcePath, 'example video');
      const promptWithSkills = mock(async (_input: unknown) => {})
        .mockRejectedValueOnce(new Error('Skill dispatch failed'))
        .mockResolvedValue(undefined);
      const session = makeSession({
        promptWithSkills,
        listSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
        ]),
      });
      const { driver, harness } = await makeDriver(session);
      await (
        driver as unknown as { refreshSkillCommands(session: unknown): Promise<void> }
      ).refreshSkillCommands(session);
      const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
      const attachment = imageStore.addVideo('video/mp4', sourcePath);
      imageStore.completeVideo(attachment, { fileId: 'file-retry-video' });
      const input = `${prefix} ${attachment.placeholder}`;
      driver.persistInputHistory = mock(async (text) => { driver.state.editor.addToHistory(text); });
      driver.state.editor.setText(input);
      driver.state.editor.handleInput('\r');
      await waitForAssertion(() => {
        expect(session.promptWithSkills).toHaveBeenCalledTimes(1);
        expect(readStreamingPhase(driver)).toBe('idle');
      });
      expect(attachment.fileId).toBe('file-retry-video');
      expect(harness.deleteFile).not.toHaveBeenCalled();
      expect(driver.state.queuedMessages).toEqual([]);
      driver.state.editor.handleInput('\u001B[A');
      expect(driver.state.editor.getText()).toBe(input);
      driver.state.editor.handleInput('\r');
      await waitForAssertion(() => { expect(session.promptWithSkills).toHaveBeenCalledTimes(2); });
      expect(promptWithSkills.mock.calls[1]?.[0]).toContainEqual({
        type: 'video_url', videoUrl: { url: 'kimi-file://file-retry-video' },
      });
      emitTurn(driver, 1);
      await waitForAssertion(() => {
        expect(harness.deleteFile).toHaveBeenCalledTimes(1);
        expect(harness.deleteFile).toHaveBeenCalledWith('file-retry-video');
      });
      expect(attachment.fileId).toBeUndefined();
    },
  );

  it('recalls a skill preparation failure from input history', async () => {
    const session = makeSession({
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const { driver, harness } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addVideo('video/mp4', '/tmp/clip.mp4');
    const text = `watch /skill:review ${attachment.placeholder}`;
    driver.persistInputHistory = mock(async (input) => { driver.state.editor.addToHistory(input); });
    driver.state.editor.setText(text);
    driver.state.editor.handleInput('\r');

    expect(session.promptWithSkills).not.toHaveBeenCalled();
    expect(driver.state.editor.getText()).toBe('');
    expect(driver.state.queuedMessages).toEqual([]);
    imageStore.completeVideo(attachment, { fileId: 'file-retried-skill' });
    driver.state.editor.handleInput('\u001B[A');
    expect(driver.state.editor.getText()).toBe(text);
    driver.state.editor.handleInput('\r');
    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledWith([
        { type: 'text', text: 'watch /skill:review ' },
        { type: 'video_url', videoUrl: { url: 'kimi-file://file-retried-skill' } },
      ], [{ name: 'review' }]);
    });
    emitTurn(driver, 1);
    await waitForAssertion(() => { expect(harness.deleteFile).toHaveBeenCalledWith('file-retried-skill'); });
  });

  it.each(['/skill:review file.ts', 'check /skill:review file.ts'])(
    'retries a failed skill from input history without requeuing (%s)',
    async (input) => {
      const session = makeSession({
        promptWithSkills: mock().mockRejectedValueOnce(new Error('Skill unavailable')).mockResolvedValue(undefined),
        listSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
          { name: 'security', description: 'Security skill', path: '/tmp/security', source: 'user' },
        ]),
      });
      const { driver } = await makeDriver(session);
      await (
        driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
      ).refreshSkillCommands(session);
      driver.persistInputHistory = mock(async (text) => { driver.state.editor.addToHistory(text); });
      driver.state.editor.setText(input);
      driver.state.editor.handleInput('\r');
      await waitForAssertion(() => {
        expect(readStreamingPhase(driver)).toBe('idle');
        expect(stripSgr(renderTranscript(driver))).toContain('Skill unavailable');
      });
      expect(driver.state.queuedMessages).toEqual([]);
      expect(driver.state.editor.getText()).toBe('');
      expect(driver.state.transcriptEntries).toContainEqual(expect.objectContaining({
        kind: 'user', content: input, skillNames: ['review'],
      }));
      driver.state.editor.handleInput('\u001B[A');
      expect(driver.state.editor.getText()).toBe(input);
      const edited = input.replace('/skill:review', '/skill:security');
      driver.state.editor.setText(edited);
      driver.state.editor.handleInput('\r');
      const skills = input.startsWith('/skill:')
        ? [{ name: 'security', args: 'file.ts' }]
        : [{ name: 'security' }];
      expect(session.promptWithSkills).toHaveBeenLastCalledWith(edited, skills);
      expect(driver.state.queuedMessages).toEqual([]);
    },
  );

  it.each(['enter', 'queued'])('ignores a skill rejection after switching sessions (%s)', async (delivery) => {
    let rejectSkill!: (error: unknown) => void;
    const held = new Promise<void>((_resolve, reject) => { rejectSkill = reject; });
    const session = makeSession({
      promptWithSkills: mock(() => held),
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const { driver } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    if (delivery === 'queued') {
      driver.state.appState.streamingPhase = 'waiting';
      driver.streamingUI.setTurnId('1');
    }
    driver.state.editor.setText('/skill:review OLD_CHANGE');
    driver.state.editor.handleInput('\r');
    if (delivery === 'queued') {
      driver.sessionEventHandler.handleEvent(
        { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event,
        (item) => { driver.sendQueuedMessage(session, item); },
      );
    }
    await waitForAssertion(() => { expect(session.promptWithSkills).toHaveBeenCalledTimes(1); });
    const nextSession = makeSession({ id: 'ses-next' });
    await driver.setSession(nextSession);
    driver.state.appState.streamingPhase = 'idle';
    driver.state.editor.setText('NEXT_CHANGE');
    driver.state.editor.handleInput('\r');
    expect(nextSession.prompt).toHaveBeenCalledTimes(1);
    rejectSkill(new Error('Old skill request cancelled'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(readStreamingPhase(driver)).toBe('waiting');
    expect(driver.state.queuedMessages).toEqual([]);
    expect(stripSgr(renderTranscript(driver))).not.toContain('Old skill request cancelled');
  });

  it('keeps a goal continuation active while a queued skill rejection settles', async () => {
    let rejectSkill!: (error: unknown) => void;
    const held = new Promise<void>((_resolve, reject) => { rejectSkill = reject; });
    const session = makeSession({
      promptWithSkills: mock(() => held),
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const { driver } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    driver.state.editor.setText('/skill:review CHANGE');
    driver.state.editor.handleInput('\r');
    await waitForAssertion(() => { expect(session.promptWithSkills).toHaveBeenCalledTimes(1); });
    driver.sessionEventHandler.handleEvent(
      { type: 'turn.started', agentId: 'main', turnId: 1, origin: { kind: 'system_trigger', name: 'goal_continuation' } } as Event,
      () => {},
    );
    rejectSkill(new Error('Prompt blocked by UserPromptSubmit hook'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(readStreamingPhase(driver)).toBe('waiting');
    expect(driver.streamingUI.getTurnContext().turnId).toBe('1');
    expect(stripSgr(renderTranscript(driver))).toContain('Prompt blocked by UserPromptSubmit hook');
  });

  it('keeps a skill eligible for automatic dispatch when compaction defers Ctrl-S', async () => {
    const session = makeSession({
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const { driver } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    driver.handleUserInput('first');
    driver.handleUserInput('/skill:review delayed');
    session.steer.mockImplementation(async () => {
      driver.state.appState.isCompacting = true;
    });
    driver.state.editor.onCtrlS?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.steer).toHaveBeenCalledTimes(1);
    expect(session.promptWithSkills).not.toHaveBeenCalled();
    driver.state.appState.isCompacting = false;
    driver.sessionEventHandler.handleEvent(
      { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event,
      (item) => { driver.sendQueuedMessage(session, item); },
    );
    await waitForAssertion(() => { expect(session.promptWithSkills).toHaveBeenCalledTimes(1); });
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it('keeps the ordinary queued tail eligible after a skill failure', async () => {
    let rejectSkill!: (error: unknown) => void;
    const held = new Promise<void>((_resolve, reject) => { rejectSkill = reject; });
    const promptWithSkills = mock(() => held);
    const session = makeSession({
      promptWithSkills,
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const { driver } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    driver.handleUserInput('/skill:review FIRST');
    driver.handleUserInput('QUEUED_TAIL');
    driver.sessionEventHandler.handleEvent(
      { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event,
      (item) => { driver.sendQueuedMessage(session, item); },
    );
    await waitForAssertion(() => { expect(promptWithSkills).toHaveBeenCalledTimes(1); });
    driver.handleUserInput('OUTSIDE');
    rejectSkill(new Error('Skill unavailable'));
    await waitForAssertion(() => { expect(readStreamingPhase(driver)).toBe('idle'); });
    driver.state.editor.setText('NEXT');
    driver.state.editor.handleInput('\r');
    driver.sessionEventHandler.handleEvent(
      { type: 'turn.ended', agentId: 'main', turnId: 2, reason: 'completed' } as Event,
      (item) => { driver.sendQueuedMessage(session, item); },
    );
    await waitForAssertion(() => { expect(session.prompt).toHaveBeenCalledTimes(2); });
    expect(session.prompt).toHaveBeenLastCalledWith('QUEUED_TAIL', { promptId: undefined });
    expect(driver.state.queuedMessages.map((item) => item.text)).toEqual(['OUTSIDE']);
    expect(promptWithSkills).toHaveBeenCalledTimes(1);
  });

  it('keeps queued bash dispatch unchanged after a skill rejection', async () => {
    let rejectSkill!: (error: unknown) => void;
    const held = new Promise<void>((_resolve, reject) => { rejectSkill = reject; });
    const promptWithSkills = mock(() => held);
    const runShellCommand = mock(async () => ({ stdout: '', stderr: '', isError: false }));
    const session = makeSession({
      promptWithSkills,
      runShellCommand,
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const { driver } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    driver.handleUserInput('/skill:review FIRST');
    driver.state.appState.inputMode = 'bash';
    driver.state.editor.inputMode = 'bash';
    driver.handleUserInput('echo BASH_TAIL');
    driver.state.appState.inputMode = 'prompt';
    driver.state.editor.inputMode = 'prompt';
    driver.sessionEventHandler.handleEvent(
      { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event,
      (item) => { driver.sendQueuedMessage(session, item); },
    );
    await waitForAssertion(() => { expect(promptWithSkills).toHaveBeenCalledTimes(1); });
    rejectSkill(new Error('Skill unavailable'));
    await waitForAssertion(() => { expect(readStreamingPhase(driver)).toBe('idle'); });
    driver.state.editor.setText('NEXT');
    driver.state.editor.handleInput('\r');
    driver.sessionEventHandler.handleEvent(
      { type: 'turn.ended', agentId: 'main', turnId: 2, reason: 'completed' } as Event,
      (item) => { driver.sendQueuedMessage(session, item); },
    );
    await waitForAssertion(() => { expect(runShellCommand).toHaveBeenCalledTimes(1); });
    expect(runShellCommand).toHaveBeenCalledWith('echo BASH_TAIL', expect.objectContaining({ commandId: expect.any(String) }));
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(promptWithSkills).toHaveBeenCalledTimes(1);
    expect(driver.state.queuedMessages.map((item) => item.text)).toEqual([]);
  });

  it('keeps dispatched skill media alive when the remaining queue is discarded', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const session = makeSession({
      promptWithSkills: mock(() => held),
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const { driver, harness } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addImage(new Uint8Array([0xaa]), 'image/png', 1, 1);
    attachment.fileId = 'file-dispatched-skill';
    attachment.fileExpiresAt = Date.now() + 60 * 60 * 1000;
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    driver.handleUserInput(`check /skill:review ${attachment.placeholder}`);
    driver.handleUserInput('discard this later note');
    driver.state.editor.onCtrlS?.();
    expect(session.promptWithSkills).toHaveBeenCalledTimes(1);

    (driver as unknown as { clearQueuedMessages(): void }).clearQueuedMessages();

    expect(harness.deleteFile).not.toHaveBeenCalled();
    release();
    await waitForAssertion(() => { expect(driver.state.queuedMessages).toEqual([]); });
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.steer).not.toHaveBeenCalled();
    expect(harness.deleteFile).not.toHaveBeenCalled();
    emitTurn(driver, 1);
    await waitForAssertion(() => { expect(harness.deleteFile).toHaveBeenCalledWith('file-dispatched-skill'); });
    expect(harness.deleteFile).toHaveBeenCalledTimes(1);
  });

  it('keeps a skill steer media lease unclaimed by an untracked turn it cannot merge into', async () => {
    process.env['KIMI_CODE_HOME'] = await makeTempHome();
    const session = makeSession({
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const { driver, harness } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = stagedImage(imageStore, 'file-goal-skill');
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    driver.state.editor.setText(`check /skill:review ${attachment.placeholder}`);

    driver.state.editor.onCtrlS?.();

    await waitForAssertion(() => { expect(session.promptWithSkills).toHaveBeenCalledTimes(1); });
    driver.sessionEventHandler.handleEvent(
      { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event,
      (item) => { driver.sendQueuedMessage(session, item); },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.deleteFile).not.toHaveBeenCalled();

    emitTurn(driver, 2);
    await waitForAssertion(() => {
      expect(harness.deleteFile).toHaveBeenCalledTimes(1);
      expect(harness.deleteFile).toHaveBeenCalledWith('file-goal-skill');
    });
  });

  it('restores idle when skill preparation fails after the previous turn ends during Ctrl-S delivery', async () => {
    const session = makeSession({
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const { driver } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const missing = imageStore.addVideo('video/quicktime', '/tmp/kimi-missing-source.mov');
    imageStore.completeVideo(missing, { fileId: 'file-ended-turn-skill' });
    const text = `/skill:review look ${missing.placeholder}`;
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    driver.handleUserInput('accepted prefix');
    driver.handleUserInput(text);
    driver.handleUserInput('later');
    session.steer.mockImplementation(async () => {
      driver.sessionEventHandler.handleEvent(
        { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event,
        () => {},
      );
    });

    driver.state.editor.onCtrlS?.();

    await waitForAssertion(() => {
      expect(stripSgr(renderTranscript(driver))).toContain('Failed to prepare media attachment');
    });
    expect(readStreamingPhase(driver)).toBe('idle');
    expect(driver.state.livePane.mode).toBe('idle');
    expect(driver.state.queuedMessages).toEqual([]);
    expect(session.steer).toHaveBeenCalledTimes(2);
    expect(session.steer).toHaveBeenLastCalledWith('later');
    expect(session.promptWithSkills).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it.each(['/skill:review keep-me', 'check /skill:review keep-me'])('keeps submitted skill input after Ctrl-S rejection (%s)', async (input) => {
    const session = makeSession({
      promptWithSkills: mock(async () => { throw new Error('Skill unavailable'); }),
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const { driver } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    driver.handleUserInput('accepted prefix');
    driver.handleUserInput(input);
    driver.handleUserInput('later');
    session.steer.mockImplementation(async () => {
      driver.sessionEventHandler.handleEvent(
        { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event,
        () => {},
      );
    });

    driver.state.editor.onCtrlS?.();

    await waitForAssertion(() => {
      expect(stripSgr(renderTranscript(driver))).toContain('Skill unavailable');
    });
    expect(readStreamingPhase(driver)).toBe('idle');
    expect(driver.state.livePane.mode).toBe('idle');
    expect(driver.state.queuedMessages).toEqual([]);
    expect(driver.state.transcriptEntries).toContainEqual(expect.objectContaining({
      kind: 'user', content: input, skillNames: ['review'],
    }));
    expect(driver.state.transcriptEntries).toContainEqual(expect.objectContaining({
      kind: 'user', content: 'later',
    }));
    expect(session.steer).toHaveBeenCalledTimes(2);
    expect(session.steer).toHaveBeenLastCalledWith('later');
    expect(session.promptWithSkills).toHaveBeenCalledTimes(1);
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it('keeps submitted ordinary Ctrl-S input when the request fails', async () => {
    const session = makeSession({
      steer: mock(async () => { throw new Error('Input unavailable'); }),
    });
    const { driver } = await makeDriver(session);
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    driver.state.editor.setText('keep this input');

    driver.state.editor.onCtrlS?.();

    await waitForAssertion(() => {
      expect(stripSgr(renderTranscript(driver))).toContain('Input unavailable');
    });
    expect(session.steer).toHaveBeenCalledWith('keep this input');
    expect(driver.state.queuedMessages).toEqual([]);
    expect(driver.state.transcriptEntries).toContainEqual(expect.objectContaining({
      kind: 'user', content: 'keep this input',
    }));
  });

  it('serializes Ctrl-S inputs without blocking later submissions after a skill failure', async () => {
    let rejectSkill!: (error: unknown) => void;
    const held = new Promise<void>((_resolve, reject) => { rejectSkill = reject; });
    const sent: string[] = [];
    const promptWithSkills = mock(async (input: unknown) => { sent.push(String(input)); })
      .mockImplementationOnce((input: unknown) => {
        sent.push(String(input));
        return held;
      });
    const session = makeSession({
      promptWithSkills,
      steer: mock(async (input: unknown) => { sent.push(String(input)); }),
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
        { name: 'security', description: 'Security skill', path: '/tmp/security', source: 'user' },
      ]),
    });
    const { driver } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    driver.handleUserInput('first');
    driver.handleUserInput('check /skill:review');
    driver.handleUserInput('later');
    driver.state.editor.setText('draft /skill:security');
    driver.state.editor.onCtrlS?.();
    await waitForAssertion(() => { expect(promptWithSkills).toHaveBeenCalledTimes(1); });
    expect(sent).toEqual(['first', 'check /skill:review']);
    driver.state.appState.streamingPhase = 'idle';
    driver.handleUserInput('newer');
    expect(session.prompt).not.toHaveBeenCalled();
    rejectSkill(new Error('Skill unavailable'));
    await waitForAssertion(() => {
      expect(sent).toEqual(['first', 'check /skill:review', 'later', 'draft /skill:security']);
      expect(driver.state.queuedMessages.map((item) => item.text)).toEqual(['newer']);
    });
    expect(stripSgr(renderTranscript(driver))).toContain('Skill unavailable');
    expect(driver.state.transcriptEntries).toContainEqual(expect.objectContaining({
      kind: 'user', content: 'check /skill:review', skillNames: ['review'],
    }));
    driver.sessionEventHandler.handleEvent(
      { type: 'turn.started', agentId: 'main', turnId: 2, origin: { kind: 'user' } } as Event,
      () => {},
    );
    driver.sessionEventHandler.handleEvent(
      { type: 'turn.ended', agentId: 'main', turnId: 2, reason: 'completed' } as Event,
      (item) => { driver.sendQueuedMessage(session, item); },
    );
    await waitForAssertion(() => { expect(session.prompt).toHaveBeenCalledTimes(1); });
    expect(session.prompt).toHaveBeenCalledWith('newer', { promptId: undefined });
    expect(promptWithSkills).toHaveBeenCalledTimes(2);
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it.each(['enter', 'ctrl-s'])('keeps skill media args and releases uploads on consumption (%s)', async (submission) => {
    const session = makeSession({
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const { driver, harness } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addImage(new Uint8Array([0xaa]), 'image/png', 1, 1);
    attachment.fileId = 'file-skill-media';
    attachment.fileExpiresAt = Date.now() + 60 * 60 * 1000;
    const text = `/skill:review look ${attachment.placeholder}`;
    if (submission === 'ctrl-s') {
      driver.state.appState.streamingPhase = 'waiting';
      driver.streamingUI.setTurnId('1');
      driver.state.editor.setText(text);
      driver.state.editor.onCtrlS?.();
    } else {
      driver.handleUserInput(text);
    }

    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalled();
    });
    const [input, skills] = session.promptWithSkills.mock.calls[0] as unknown as [
      unknown,
      Array<{ name: string; args: string }>,
    ];
    expect(input).toEqual([
      { type: 'text', text: '/skill:review look ' },
      { type: 'image_url', imageUrl: { url: 'kimi-file://file-skill-media' } },
    ]);
    expect(skills[0]?.name).toBe('review');
    expect(skills[0]?.args).toMatch(/^look Attached image file: .+\.png \(open it with Read\)$/);
    expect(skills[0]?.args).not.toContain(attachment.placeholder);
    expect(driver.state.transcriptEntries).toContainEqual(
      expect.objectContaining({ kind: 'user', content: text, skillNames: ['review'] }),
    );
    expect(harness.deleteFile).not.toHaveBeenCalled();

    emitTurn(driver, 1);

    await waitForAssertion(() => {
      expect(harness.deleteFile).toHaveBeenCalledWith('file-skill-media');
    });
    expect(harness.deleteFile).toHaveBeenCalledTimes(1);
  });

  it('queues editor input instead of prompting while a turn is already streaming', async () => {
    const { driver, session, harness } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    harness.track.mockClear();

    driver.handleUserInput('queued message');

    expect(session.prompt).not.toHaveBeenCalled();
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toEqual([{ text: 'queued message', agentId: 'main' }]);
    });
    expect(driver.state.queueContainer.children.length).toBeGreaterThan(0);
    expect(harness.track).toHaveBeenCalledWith('input_queue', undefined);
  });

  it('queues a leading skill prompt while a turn is streaming and submits it on drain', async () => {
    const session = makeSession({
      listSkills: mock(async () => [
        {
          name: 'demo',
          description: 'demo skill',
          path: 'builtin://demo',
          source: 'builtin',
          type: 'inline',
        },
      ]),
    });
    const { driver, harness } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    driver.state.appState.streamingPhase = 'waiting';
    harness.track.mockClear();

    driver.handleUserInput('/demo refactor auth and ui');

    expect(session.activateSkill).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([
      {
        text: '/demo refactor auth and ui',
        agentId: 'main',
        inlineSkillActivations: [{ skillName: 'demo', args: 'refactor auth and ui' }],
      },
    ]);
    expect(harness.track).toHaveBeenCalledWith('input_queue', undefined);

    driver.state.appState.streamingPhase = 'idle';
    const queued = driver.state.queuedMessages[0]!;
    driver.state.queuedMessages = [];
    driver.sendQueuedMessage(session, queued);

    expect(session.promptWithSkills).toHaveBeenCalledWith(
      '/demo refactor auth and ui', [{ name: 'demo', args: 'refactor auth and ui' }],
    );
    expect(session.activateSkill).not.toHaveBeenCalled();
  });

  it('uses the existing media queue policy after the selected model changes', async () => {
    process.env['KIMI_CODE_HOME'] = await makeTempHome();
    const session = makeSession({
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const { driver } = await makeDriver(session);
    await (driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }).refreshSkillCommands(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = stagedImage(imageStore, 'file-queued-model-change');
    driver.state.appState.streamingPhase = 'waiting';
    driver.handleUserInput(`inspect /skill:review ${attachment.placeholder}`);
    expect(driver.state.queuedMessages).toHaveLength(1);
    driver.state.appState.model = 'text-only';
    driver.state.appState.availableModels = {
      'text-only': { provider: 'example', model: 'example-model', maxContextSize: 4096, capabilities: [] },
    };
    driver.state.appState.streamingPhase = 'idle';
    const queued = driver.state.queuedMessages.shift()!;

    driver.sendQueuedMessage(session, queued);

    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledWith(expect.any(Array), [{ name: 'review' }]);
    });
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it('queues a leading skill prompt while compacting and submits it on drain', async () => {
    const session = makeSession({
      listSkills: mock(async () => [
        {
          name: 'demo',
          description: 'demo skill',
          path: 'builtin://demo',
          source: 'builtin',
          type: 'inline',
        },
      ]),
    });
    const { driver, harness } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    driver.state.appState.isCompacting = true;
    harness.track.mockClear();

    driver.handleUserInput('/demo refactor auth and ui');

    expect(session.activateSkill).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([
      {
        text: '/demo refactor auth and ui',
        agentId: 'main',
        inlineSkillActivations: [{ skillName: 'demo', args: 'refactor auth and ui' }],
      },
    ]);
    expect(driver.state.queueContainer.children.length).toBeGreaterThan(0);
    expect(harness.track).toHaveBeenCalledWith('input_queue', undefined);

    driver.state.appState.isCompacting = false;
    const queued = driver.state.queuedMessages[0]!;
    driver.state.queuedMessages = [];
    driver.sendQueuedMessage(session, queued);

    expect(session.promptWithSkills).toHaveBeenCalledWith(
      '/demo refactor auth and ui', [{ name: 'demo', args: 'refactor auth and ui' }],
    );
    expect(session.activateSkill).not.toHaveBeenCalled();
  });

  it('queues /compact while streaming and fires it when the queued turn ends', async () => {
    const { driver, session, harness } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    harness.track.mockClear();

    driver.handleUserInput('/compact focus on src');

    expect(session.compact).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([
      {
        text: '/compact focus on src',
        agentId: 'main',
        mode: 'compact',
        compactInstruction: 'focus on src',
        queuedAfterAutoSerial: 0,
      },
    ]);
    expect(harness.track).toHaveBeenCalledWith('input_queue', undefined);
    expect(stripSgr(renderTranscript(driver))).not.toContain('Cannot /compact');

    driver.sessionEventHandler.handleEvent(
      { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event,
      (item) => { driver.sendQueuedMessage(session, item); },
    );

    await waitForAssertion(() => {
      expect(session.compact).toHaveBeenCalledWith({ instruction: 'focus on src' });
    });
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it('runs a queued /compact in FIFO order between queued prompts', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';

    driver.handleUserInput('first');
    driver.handleUserInput('/compact tidy up');
    driver.handleUserInput('second');

    expect(driver.state.queuedMessages.map((m) => m.text)).toEqual([
      'first',
      '/compact tidy up',
      'second',
    ]);

    const sendQueued = (item: QueuedMessage) => { driver.sendQueuedMessage(session, item); };
    driver.sessionEventHandler.handleEvent(
      { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event,
      sendQueued,
    );
    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith('first', { promptId: undefined });
    });
    expect(session.compact).not.toHaveBeenCalled();

    driver.sessionEventHandler.handleEvent(
      { type: 'turn.ended', agentId: 'main', turnId: 2, reason: 'completed' } as Event,
      sendQueued,
    );
    await waitForAssertion(() => {
      expect(session.compact).toHaveBeenCalledWith({ instruction: 'tidy up' });
    });
    expect(session.prompt).not.toHaveBeenCalledWith('second', { promptId: undefined });

    driver.sessionEventHandler.handleEvent(
      { type: 'compaction.started', agentId: 'main', sessionId: 'ses-1', trigger: 'manual' } as Event,
      sendQueued,
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'compaction.completed',
        agentId: 'main',
        sessionId: 'ses-1',
        result: { summary: 's', compactedCount: 1, tokensBefore: 10, tokensAfter: 5 },
      } as Event,
      sendQueued,
    );
    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith('second', { promptId: undefined });
    });
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it('rejects a second /compact while one is already queued', async () => {
    const { driver, session, harness } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.handleUserInput('/compact one');
    harness.track.mockClear();

    driver.handleUserInput('/compact two');

    expect(session.compact).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([
      expect.objectContaining({ mode: 'compact', compactInstruction: 'one' }),
    ]);
    expect(harness.track).toHaveBeenCalledWith('input_command_invalid', {
      reason: 'duplicate-compact',
      command: 'compact',
    });
    expect(stripSgr(renderTranscript(driver))).toContain('A /compact is already queued.');
    expect(driver.state.editor.getText()).toBe('/compact two');
  });

  it('keeps /compact blocked while compacting', async () => {
    const { driver, session, harness } = await makeDriver();
    driver.state.appState.isCompacting = true;
    harness.track.mockClear();

    driver.handleUserInput('/compact');

    expect(session.compact).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([]);
    expect(harness.track).toHaveBeenCalledWith('input_command_invalid', {
      reason: 'blocked',
      command: 'compact',
    });
    expect(stripSgr(renderTranscript(driver))).toContain('Cannot /compact while compacting');
    expect(driver.state.editor.getText()).toBe('/compact');
  });

  it('keeps /compact blocked while a compaction holds the turn', async () => {
    const { driver, session, harness } = await makeDriver();
    driver.state.appState.isCompacting = true;
    driver.state.appState.streamingPhase = 'waiting';
    harness.track.mockClear();

    driver.handleUserInput('/compact');

    expect(session.compact).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([]);
    expect(harness.track).toHaveBeenCalledWith('input_command_invalid', {
      reason: 'blocked',
      command: 'compact',
    });
    expect(stripSgr(renderTranscript(driver))).toContain('Cannot /compact while compacting');
    expect(driver.state.editor.getText()).toBe('/compact');
  });

  it('queues /compact submitted while the lazy session creation was in flight', async () => {
    const lazySession = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(lazySession, {}, startupInput);

    let resolveCreate!: (s: ReturnType<typeof makeSession>) => void;
    harness.createSession.mockImplementationOnce(
      () => new Promise((resolve) => { resolveCreate = resolve; }),
    );

    driver.handleUserInput('hello');
    await waitForAssertion(() => {
      expect(harness.createSession).toHaveBeenCalledTimes(1);
    });
    driver.handleUserInput('/compact');

    resolveCreate(lazySession);
    await waitForAssertion(() => {
      expect(lazySession.prompt).toHaveBeenCalledWith('hello', { promptId: undefined });
    });
    expect(driver.state.queuedMessages).toEqual([
      expect.objectContaining({ mode: 'compact', text: '/compact' }),
    ]);
    expect(lazySession.compact).not.toHaveBeenCalled();
    expect(stripSgr(renderTranscript(driver))).not.toContain('Cannot /compact');
  });

  it('restores the input when a second /compact is refused during lazy session creation', async () => {
    const lazySession = makeSession({ id: 'ses-lazy' });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver, harness } = await makeDriver(lazySession, {}, startupInput);

    let resolveCreate!: (s: ReturnType<typeof makeSession>) => void;
    harness.createSession.mockImplementationOnce(
      () => new Promise((resolve) => { resolveCreate = resolve; }),
    );

    driver.handleUserInput('hello');
    await waitForAssertion(() => {
      expect(harness.createSession).toHaveBeenCalledTimes(1);
    });
    driver.handleUserInput('/compact');
    driver.handleUserInput('/compact');

    resolveCreate(lazySession);
    await waitForAssertion(() => {
      expect(lazySession.prompt).toHaveBeenCalledWith('hello', { promptId: undefined });
      expect(stripSgr(renderTranscript(driver))).toContain('A /compact is already queued.');
    });
    expect(driver.state.editor.getText()).toBe('/compact');
    expect(driver.state.queuedMessages).toEqual([
      expect.objectContaining({ mode: 'compact', text: '/compact' }),
    ]);
    expect(lazySession.compact).not.toHaveBeenCalled();
  });

  it('skips a queued /compact when an auto compaction completed while it waited', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.handleUserInput('/compact');
    driver.handleUserInput('after compact');

    const sendQueued = (item: QueuedMessage) => { driver.sendQueuedMessage(session, item); };
    driver.sessionEventHandler.handleEvent(
      { type: 'compaction.started', agentId: 'main', sessionId: 'ses-1', trigger: 'auto' } as Event,
      sendQueued,
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'compaction.completed',
        agentId: 'main',
        sessionId: 'ses-1',
        result: { summary: 's', compactedCount: 1, tokensBefore: 10, tokensAfter: 5 },
      } as Event,
      sendQueued,
    );

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith('after compact', { promptId: undefined });
    });
    expect(session.compact).not.toHaveBeenCalled();
    expect(stripSgr(renderTranscript(driver))).toContain(
      'Skipped queued /compact — context was already auto-compacted.',
    );
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it('still fires a queued /compact when the intervening auto compaction is cancelled', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.handleUserInput('/compact');

    const sendQueued = (item: QueuedMessage) => { driver.sendQueuedMessage(session, item); };
    driver.sessionEventHandler.handleEvent(
      { type: 'compaction.started', agentId: 'main', sessionId: 'ses-1', trigger: 'auto' } as Event,
      sendQueued,
    );
    driver.sessionEventHandler.handleEvent(
      { type: 'compaction.cancelled', agentId: 'main', sessionId: 'ses-1' } as Event,
      sendQueued,
    );

    await waitForAssertion(() => {
      expect(session.compact).toHaveBeenCalledWith({ instruction: undefined });
    });
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it('steers only the messages ahead of a queued /compact on Ctrl-S', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    driver.handleUserInput('msg1');
    driver.handleUserInput('/compact foo');
    driver.handleUserInput('msg2');

    driver.state.editor.onCtrlS?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(session.steer).toHaveBeenCalledTimes(1);
    expect(session.steer).toHaveBeenCalledWith('msg1');
    expect(driver.state.queuedMessages.map((m) => m.text)).toEqual(['/compact foo', 'msg2']);
  });

  it('steers nothing on Ctrl-S when only /compact items are queued', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    driver.handleUserInput('/compact');

    driver.state.editor.onCtrlS?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(session.steer).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([
      expect.objectContaining({ mode: 'compact', text: '/compact' }),
    ]);
  });

  it('auto-steers messages ahead of a queued /compact when a WaitFor starts', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.handleUserInput('msg1');
    driver.handleUserInput('/compact foo');
    driver.handleUserInput('msg2');
    expect(driver.state.queuedMessages).toHaveLength(3);

    startWaitFor(driver);

    expect(session.steer).toHaveBeenCalledTimes(1);
    expect(session.steer).toHaveBeenCalledWith('msg1');
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages.map((m) => m.text)).toEqual(['/compact foo', 'msg2']);
    });
  });

  it('omits the steer hint when only /compact items are queued', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';

    driver.handleUserInput('/compact');
    const compactOnlyPane = driver.state.queueContainer.render(120).map(stripSgr).join('\n');
    expect(compactOnlyPane).toContain('/compact');
    expect(compactOnlyPane).not.toContain('ctrl-s to steer immediately');
  });

  it('omits the steer hint when every steerable message sits behind a queued /compact', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';

    driver.handleUserInput('/compact');
    driver.handleUserInput('plain note');

    const pane = driver.state.queueContainer.render(120).map(stripSgr).join('\n');
    expect(pane).not.toContain('ctrl-s to steer immediately');
  });

  it('shows the steer hint when a steerable message sits ahead of a queued /compact', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';

    driver.handleUserInput('plain note');
    driver.handleUserInput('/compact');

    const pane = driver.state.queueContainer.render(120).map(stripSgr).join('\n');
    expect(pane).toContain('ctrl-s to steer immediately');
  });

  it('recalls a queued /compact into the editor on up arrow', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.handleUserInput('/compact bring it back');

    expect(driver.state.editor.onUpArrowEmpty?.()).toBe(true);

    expect(driver.state.editor.getText()).toBe('/compact bring it back');
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it('attempts a failed queued /compact fire three times, then drops it and drains on', async () => {
    jest.useFakeTimers();
    try {
      const session = makeSession({
        compact: mock(async () => {
          throw new Error('COMPACTION_UNABLE');
        }),
      });
      const { driver } = await makeDriver(session);
      driver.state.queuedMessages = [
        { text: '/compact', agentId: 'main', mode: 'compact', queuedAfterAutoSerial: 0 },
        { text: 'next', agentId: 'main' },
      ];

      driver.sendQueuedMessage(session, driver.state.queuedMessages.shift()!);
      await advanceFakeTime(0);
      const requeuedPane = driver.state.queueContainer.render(120).map(stripSgr).join('\n');
      expect(requeuedPane).toContain('/compact');
      await advanceFakeTime(1000);
      await advanceFakeTime(1000);
      await advanceFakeTime(1000);

      expect(session.compact).toHaveBeenCalledTimes(3);
      expect(session.prompt).toHaveBeenCalledWith('next', { promptId: undefined });
      expect(driver.state.queuedMessages).toEqual([]);
      expect(stripSgr(renderTranscript(driver))).toContain('Failed to run queued /compact');
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits for idle before retrying a failed queued /compact fire', async () => {
    jest.useFakeTimers();
    try {
      const session = makeSession({
        compact: mock(async () => {
          throw new Error('COMPACTION_UNABLE');
        }),
      });
      const { driver } = await makeDriver(session);
      driver.state.queuedMessages = [
        { text: '/compact', agentId: 'main', mode: 'compact', queuedAfterAutoSerial: 0 },
      ];

      driver.sendQueuedMessage(session, driver.state.queuedMessages.shift()!);
      expect(session.compact).toHaveBeenCalledTimes(1);

      driver.state.appState.streamingPhase = 'waiting';
      await advanceFakeTime(3000);
      expect(session.compact).toHaveBeenCalledTimes(1);

      driver.state.appState.streamingPhase = 'idle';
      await advanceFakeTime(1000);
      expect(session.compact).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('requeues a queued /compact without firing when another compaction is already running', async () => {
    jest.useFakeTimers();
    try {
      const { driver, session } = await makeDriver();
      driver.state.queuedMessages = [
        { text: '/compact', agentId: 'main', mode: 'compact', queuedAfterAutoSerial: 0 },
      ];
      driver.state.appState.isCompacting = true;

      driver.sendQueuedMessage(session, driver.state.queuedMessages.shift()!);

      expect(session.compact).not.toHaveBeenCalled();
      expect(driver.state.queuedMessages).toEqual([
        { text: '/compact', agentId: 'main', mode: 'compact', queuedAfterAutoSerial: 0 },
      ]);

      await advanceFakeTime(2000);
      expect(session.compact).not.toHaveBeenCalled();

      driver.state.appState.isCompacting = false;
      await advanceFakeTime(1000);
      expect(session.compact).toHaveBeenCalledWith({ instruction: undefined });
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears a queued /compact when starting a new session', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.handleUserInput('/compact');
    expect(driver.state.queuedMessages).toHaveLength(1);

    driver.state.appState.streamingPhase = 'idle';
    driver.handleUserInput('/new');

    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toEqual([]);
    });
    expect(session.compact).not.toHaveBeenCalled();
  });

  it('steers fresh input while a goal is active even when the streaming phase is idle', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.goal = makeActiveGoalSnapshot();

    driver.handleUserInput('hello mid-goal');

    await waitForAssertion(() => {
      expect(session.steer).toHaveBeenCalledWith('hello mid-goal');
    });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(driver.state.transcriptEntries).toEqual([
      expect.objectContaining({
        kind: 'user',
        content: 'hello mid-goal',
      }),
    ]);
  });

  it('steers fresh input into the running turn while tower mode is active', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.towerMode = true;
    driver.state.appState.streamingPhase = 'waiting';

    driver.handleUserInput('second objective');

    expect(session.steer).toHaveBeenCalledWith('second objective');
    expect(session.prompt).not.toHaveBeenCalled();
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toEqual([]);
    });
    expect(driver.state.transcriptEntries).toEqual([
      expect.objectContaining({ kind: 'user', content: 'second objective' }),
    ]);
  });

  function waitForEvent(
    type: 'tool.call.started' | 'tool.progress' | 'tool.result',
    extra: Record<string, unknown> = {},
  ): Event {
    const base = { agentId: 'main', sessionId: 'ses-1', turnId: 1, toolCallId: 'call_wait' };
    if (type === 'tool.call.started') {
      return { type, ...base, name: 'WaitFor', args: { timeout: 60 }, ...extra } as Event;
    }
    if (type === 'tool.progress') {
      return {
        type,
        ...base,
        update: {
          kind: 'status',
          text: 'Waiting 0s / 1m · 1 background task still running',
          replace: true,
        },
        ...extra,
      } as Event;
    }
    return { type, ...base, output: 'wait_status: timed_out', ...extra } as Event;
  }

  function startWaitFor(driver: MessageDriver, extra: Record<string, unknown> = {}): void {
    driver.sessionEventHandler.handleEvent(waitForEvent('tool.call.started', extra), () => {});
    driver.sessionEventHandler.handleEvent(waitForEvent('tool.progress', extra), () => {});
  }

  function pendingSteer(): {
    session: ReturnType<typeof makeSession>;
    resolve: () => void;
    reject: (error: Error) => void;
  } {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const session = makeSession({
      steer: mock(
        () =>
          new Promise<void>((res, rej) => {
            resolve = res;
            reject = rej;
          }),
      ),
    });
    return { session, resolve: () => resolve(), reject: (error) => reject(error) };
  }

  it('steers fresh input into the running turn while a WaitFor call is running', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    startWaitFor(driver);

    driver.handleUserInput('stop waiting and check this');

    expect(session.steer).toHaveBeenCalledWith('stop waiting and check this');
    expect(session.prompt).not.toHaveBeenCalled();
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toEqual([]);
    });
  });

  it('steers messages queued before a WaitFor starts into the running turn', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.handleUserInput('first note');
    driver.handleUserInput('second note');
    expect(driver.state.queuedMessages).toHaveLength(2);

    startWaitFor(driver);

    expect(session.steer).toHaveBeenCalledTimes(1);
    expect(session.steer).toHaveBeenCalledWith('first note\n\nsecond note');
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toEqual([]);
    });
  });

  it('refreshes an expired queued image upload before steering it into a WaitFor', async () => {
    const { driver, session } = await makeDriver();
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addImage(
      new Uint8Array([0xaa, 0xbb]),
      'image/png',
      1,
      1,
      undefined,
      'file-expired',
      1,
    );
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.queuedMessages.push({
      text: `describe ${attachment.placeholder}`,
      agentId: 'main',
      parts: [{ type: 'image_url', imageUrl: { url: 'kimi-file://file-expired' } }],
      imageAttachmentIds: [attachment.id],
    });

    startWaitFor(driver);

    expect(session.steer).toHaveBeenCalledTimes(1);
    const steered = JSON.stringify(session.steer.mock.calls[0]);
    expect(steered).toContain('data:image/png;base64,qrs=');
    expect(steered).not.toContain('kimi-file://file-expired');
  });

  it('does not steer the queue for a WaitFor call that never starts waiting', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.handleUserInput('queued note');

    driver.sessionEventHandler.handleEvent(
      waitForEvent('tool.call.started', { args: { timeout: 600 } }),
      () => {},
    );
    driver.handleUserInput('typed while the call was rejected');
    driver.sessionEventHandler.handleEvent(
      waitForEvent('tool.result', { output: 'invalid arguments', isError: true }),
      () => {},
    );

    expect(session.steer).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([
      { text: 'queued note', agentId: 'main' },
      { text: 'typed while the call was rejected', agentId: 'main' },
    ]);
  });

  it('keeps the queue in place when steering it into a WaitFor fails', async () => {
    const steer = pendingSteer();
    const { driver } = await makeDriver(steer.session);
    driver.state.appState.streamingPhase = 'waiting';
    driver.handleUserInput('first note');
    driver.handleUserInput('second note');
    const queued = [...driver.state.queuedMessages];

    startWaitFor(driver);
    steer.reject(new Error('session closed'));

    await waitForAssertion(() => {
      expect(driver.state.transcriptEntries.filter((entry) => entry.kind === 'user')).toEqual([]);
    });
    expect(driver.state.queuedMessages).toEqual(queued);
  });

  it('keeps a queued video upload when steering it into a WaitFor fails', async () => {
    const steer = pendingSteer();
    const { driver, harness } = await makeDriver(steer.session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addVideo('video/mp4', '/tmp/clip.mp4');
    imageStore.completeVideo(attachment, { fileId: 'file-v1' });
    driver.state.appState.streamingPhase = 'waiting';
    driver.handleUserInput(`describe ${attachment.placeholder}`);

    startWaitFor(driver);
    steer.reject(new Error('session closed'));
    await (driver as unknown as { staging: { drain(): Promise<void> } }).staging.drain();
    driver.sessionEventHandler.handleEvent(
      { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event,
      () => {},
    );
    await (driver as unknown as { staging: { drain(): Promise<void> } }).staging.drain();

    expect(harness.deleteFile).not.toHaveBeenCalledWith('file-v1');
  });

  it('keeps submission order when a WaitFor steer fails after later input was queued', async () => {
    const steer = pendingSteer();
    const { driver } = await makeDriver(steer.session);
    driver.state.appState.streamingPhase = 'waiting';
    startWaitFor(driver);

    driver.handleUserInput('check this first');
    driver.state.queuedMessages.push({ text: 'make build', agentId: 'main', mode: 'bash' });
    steer.reject(new Error('session closed'));

    await waitForAssertion(() => {
      expect(driver.state.transcriptEntries.filter((entry) => entry.kind === 'user')).toEqual([]);
    });
    expect(driver.state.queuedMessages).toEqual([
      { text: 'check this first', agentId: 'main' },
      { text: 'make build', agentId: 'main', mode: 'bash' },
    ]);
  });

  it('steers input typed while an earlier WaitFor steer is in flight once it succeeds', async () => {
    const steer = pendingSteer();
    const { driver } = await makeDriver(steer.session);
    driver.state.appState.streamingPhase = 'waiting';
    startWaitFor(driver);

    driver.handleUserInput('first');
    driver.handleUserInput('second');
    expect(steer.session.steer).toHaveBeenCalledTimes(1);
    steer.resolve();

    await waitForAssertion(() => {
      expect(steer.session.steer).toHaveBeenCalledTimes(2);
    });
    expect(steer.session.steer).toHaveBeenNthCalledWith(2, 'second');
    expect(driver.state.queuedMessages).toEqual([{ text: 'second', agentId: 'main' }]);
  });

  it('drains input queued behind a steer that succeeds after the turn ended', async () => {
    const steer = pendingSteer();
    const { driver, session } = await makeDriver(steer.session);
    driver.state.appState.streamingPhase = 'waiting';
    driver.handleUserInput('earlier note');
    startWaitFor(driver);
    driver.state.queuedMessages.push({ text: 'later note', agentId: 'main' });

    driver.sessionEventHandler.handleEvent(
      { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event,
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.prompt).not.toHaveBeenCalled();

    steer.resolve();

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledTimes(1);
    });
    expect(session.prompt.mock.calls[0]?.[0]).toBe('later note');
  });

  it('does not offer Ctrl-S in the queue pane while a queue steer is in flight', async () => {
    const steer = pendingSteer();
    const { driver } = await makeDriver(steer.session);
    driver.state.appState.streamingPhase = 'waiting';
    driver.handleUserInput('queued note');
    expect(stripSgr(driver.state.queueContainer.render(120).join('\n'))).toContain(
      'ctrl-s to steer immediately',
    );

    startWaitFor(driver);

    expect(stripSgr(driver.state.queueContainer.render(120).join('\n'))).not.toContain(
      'ctrl-s to steer immediately',
    );
  });

  it('holds the queue behind an in-flight WaitFor steer across turn end', async () => {
    const steer = pendingSteer();
    const { driver, session } = await makeDriver(steer.session);
    driver.state.appState.streamingPhase = 'waiting';
    driver.handleUserInput('earlier note');
    startWaitFor(driver);
    driver.state.queuedMessages.push({ text: 'later note', agentId: 'main' });

    driver.sessionEventHandler.handleEvent(
      { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'cancelled' } as Event,
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.prompt).not.toHaveBeenCalled();

    steer.reject(new Error('turn cancelled'));

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledTimes(1);
    });
    expect(session.prompt.mock.calls[0]?.[0]).toBe('earlier note');
    expect(driver.state.queuedMessages).toEqual([{ text: 'later note', agentId: 'main' }]);
  });

  it('dispatches failed WaitFor input with its media right away when the turn ended meanwhile', async () => {
    const steer = pendingSteer();
    const { driver, harness, session } = await makeDriver(steer.session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addVideo('video/mp4', '/tmp/clip.mp4');
    imageStore.completeVideo(attachment, { fileId: 'file-v1' });
    driver.state.appState.streamingPhase = 'waiting';
    startWaitFor(driver);
    driver.handleUserInput(`describe ${attachment.placeholder}`);

    driver.sessionEventHandler.handleEvent(
      { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'cancelled' } as Event,
      () => {},
    );
    expect(harness.deleteFile).not.toHaveBeenCalledWith('file-v1');
    steer.reject(new Error('turn cancelled'));

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledTimes(1);
    });
    const parts = session.prompt.mock.calls[0]?.[0] as Array<{
      type: string;
      videoUrl?: { url: string };
    }>;
    expect(parts).toContainEqual({ type: 'video_url', videoUrl: { url: 'kimi-file://file-v1' } });
    await (driver as unknown as { staging: { drain(): Promise<void> } }).staging.drain();
    expect(harness.deleteFile).not.toHaveBeenCalledWith('file-v1');
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it('folds the engine-reported window into a step rate and a session average', async () => {
    const { driver } = await makeDriver();
    const tui = driver as unknown as {
      noteStepCacheStats(
        usage: unknown,
        window: { llmFirstTokenOffsetMs?: number; llmLastTokenOffsetMs?: number },
      ): void;
    };

    // 99 tokens (100 output tokens span 99 gaps) over an 800 ms window.
    tui.noteStepCacheStats(
      { output: 100 },
      {
        llmFirstTokenOffsetMs: 4_000,
        llmLastTokenOffsetMs: 4_800,
      },
    );
    // The first step is both figures: nothing else has been averaged yet.
    expect(driver.state.appState.tokenSpeed).toBeCloseTo(123.75, 6);
    expect(driver.state.appState.tokenSpeedAverage).toBeCloseTo(123.75, 6);

    // A slower second step drops the average toward it while the step figure
    // reports that step alone — the two answer different questions.
    tui.noteStepCacheStats(
      { output: 100 },
      {
        llmFirstTokenOffsetMs: 0,
        llmLastTokenOffsetMs: 8_000,
      },
    );
    expect(driver.state.appState.tokenSpeed).toBeCloseTo(12.375, 6);
    expect(driver.state.appState.tokenSpeedAverage).toBeGreaterThan(12.375);
    expect(driver.state.appState.tokenSpeedAverage).toBeLessThan(123.75);
  });

  it('ignores a step the engine reported no window for', async () => {
    const { driver } = await makeDriver();
    const tui = driver as unknown as {
      noteStepCacheStats(
        usage: unknown,
        window: { llmFirstTokenOffsetMs?: number; llmLastTokenOffsetMs?: number },
      ): void;
    };

    tui.noteStepCacheStats({ output: 500 }, {});
    expect(driver.state.appState.tokenSpeed).toBe(0);
  });

  it('resets the token-speed readout on a session switch', async () => {
    const { driver } = await makeDriver();
    const tui = driver as unknown as {
      noteStepCacheStats(
        usage: unknown,
        window: { llmFirstTokenOffsetMs?: number; llmLastTokenOffsetMs?: number },
      ): void;
    };

    tui.noteStepCacheStats(
      { output: 100 },
      { llmFirstTokenOffsetMs: 0, llmLastTokenOffsetMs: 800 },
    );
    expect(driver.state.appState.tokenSpeed).toBeCloseTo(123.75, 6);

    (driver as unknown as { resetSessionRuntime(): void }).resetSessionRuntime();
    expect(driver.state.appState.tokenSpeed).toBe(0);
    expect(driver.state.appState.tokenSpeedAverage).toBe(0);

    // The step after the reset reports its own rate, not one blended with the
    // previous session's history. The window is above MIN_STEP_WINDOW_MS so the
    // assertion is about the reset rather than about the gate.
    tui.noteStepCacheStats(
      { output: 100 },
      { llmFirstTokenOffsetMs: 0, llmLastTokenOffsetMs: 800 },
    );
    expect(driver.state.appState.tokenSpeed).toBeCloseTo(123.75, 6);
    expect(driver.state.appState.tokenSpeedAverage).toBeCloseTo(123.75, 6);
  });

  it('resets the token-speed readout on a /undo context cut', async () => {
    const { driver } = await makeDriver();
    const tui = driver as unknown as {
      noteStepCacheStats(
        usage: unknown,
        window: { llmFirstTokenOffsetMs?: number; llmLastTokenOffsetMs?: number },
      ): void;
      noteContextCut(): void;
    };

    tui.noteStepCacheStats(
      { output: 100 },
      { llmFirstTokenOffsetMs: 0, llmLastTokenOffsetMs: 800 },
    );
    expect(driver.state.appState.tokenSpeed).toBeCloseTo(123.75, 6);

    tui.noteContextCut();
    expect(driver.state.appState.tokenSpeed).toBe(0);
    expect(driver.state.appState.tokenSpeedAverage).toBe(0);
  });

  it('leaves the readout untouched when a step reports no tokens', async () => {
    const { driver } = await makeDriver();
    const tui = driver as unknown as {
      noteStepCacheStats(
        usage: unknown,
        window: { llmFirstTokenOffsetMs?: number; llmLastTokenOffsetMs?: number },
      ): void;
    };

    tui.noteStepCacheStats(
      { output: 100 },
      { llmFirstTokenOffsetMs: 0, llmLastTokenOffsetMs: 800 },
    );
    const settledStep = driver.state.appState.tokenSpeed;
    const settledAverage = driver.state.appState.tokenSpeedAverage;
    expect(settledStep).toBeCloseTo(123.75, 6);

    tui.noteStepCacheStats(undefined, {});
    expect(driver.state.appState.tokenSpeed).toBe(settledStep);
    expect(driver.state.appState.tokenSpeedAverage).toBe(settledAverage);
  });

  it('keeps the step rate when a step reports a single token', async () => {
    const { driver } = await makeDriver();
    const tui = driver as unknown as {
      noteStepCacheStats(
        usage: unknown,
        window: { llmFirstTokenOffsetMs?: number; llmLastTokenOffsetMs?: number },
      ): void;
    };

    tui.noteStepCacheStats(
      { output: 100 },
      { llmFirstTokenOffsetMs: 0, llmLastTokenOffsetMs: 800 },
    );
    const settled = driver.state.appState.tokenSpeed;

    // One token spans no interval, so the step has no rate of its own. Blanking
    // the figure would be worse than holding it: the reply it describes is
    // still the most recent measured one.
    tui.noteStepCacheStats({ output: 1 }, { llmFirstTokenOffsetMs: 0, llmLastTokenOffsetMs: 800 });
    expect(driver.state.appState.tokenSpeed).toBe(settled);
  });

  it('drops failed WaitFor input when the session changed meanwhile', async () => {
    const steer = pendingSteer();
    const { driver } = await makeDriver(steer.session);
    driver.state.appState.streamingPhase = 'waiting';
    startWaitFor(driver);
    driver.handleUserInput('for the old session');

    const next = makeSession();
    (driver as unknown as { resetSessionRuntime(): void }).resetSessionRuntime();
    (driver as unknown as { session: unknown }).session = next;
    steer.reject(new Error('session closed'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(driver.state.queuedMessages).toEqual([]);
    expect(next.prompt).not.toHaveBeenCalled();
  });

  it('keeps a queue with a bash command queued when a WaitFor starts', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.queuedMessages = [
      { text: 'note', agentId: 'main' },
      { text: 'make build', agentId: 'main', mode: 'bash' },
    ];

    startWaitFor(driver);

    expect(session.steer).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toHaveLength(2);
  });

  it('leaves queued messages alone when a tool other than WaitFor reports progress', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.handleUserInput('queued note');

    startWaitFor(driver, { toolCallId: 'call_bash', name: 'Bash', args: { command: 'sleep 5' } });

    expect(session.steer).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([{ text: 'queued note', agentId: 'main' }]);
  });

  it('queues input again once the WaitFor call has returned', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    startWaitFor(driver);
    driver.sessionEventHandler.handleEvent(waitForEvent('tool.result'), () => {});

    driver.handleUserInput('after the wait');

    expect(session.steer).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([{ text: 'after the wait', agentId: 'main' }]);
  });

  it('queues input while only a subagent is running WaitFor', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    startWaitFor(driver, { agentId: 'agent-child', toolCallId: 'call_child_wait' });

    driver.handleUserInput('main agent is busy');

    expect(session.steer).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([{ text: 'main agent is busy', agentId: 'main' }]);
  });

  it('prompts immediately while tower mode is active and the session is idle', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.towerMode = true;

    driver.handleUserInput('first objective');

    expect(session.prompt).toHaveBeenCalledWith('first objective', { promptId: undefined });
    expect(session.steer).not.toHaveBeenCalled();
  });

  it('queues input while tower mode is active but a foreground shell command is running', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.towerMode = true;
    driver.state.appState.streamingPhase = 'shell';

    driver.handleUserInput('objective during shell');

    expect(session.steer).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([
      { text: 'objective during shell', agentId: 'main' },
    ]);
  });

  it('queues input while tower mode is active but compaction is running', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.towerMode = true;
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.appState.isCompacting = true;

    driver.handleUserInput('objective during compaction');

    expect(session.steer).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([
      { text: 'objective during compaction', agentId: 'main' },
    ]);
  });

  it('steers the compaction backlog ahead of fresh input once compaction ends mid-turn', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.towerMode = true;
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.appState.isCompacting = true;
    driver.handleUserInput('objective one');
    expect(driver.state.queuedMessages).toHaveLength(1);

    driver.state.appState.isCompacting = false;
    driver.handleUserInput('objective two');

    expect(session.steer).toHaveBeenCalledWith('objective one\n\nobjective two');
    expect(session.prompt).not.toHaveBeenCalled();
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toEqual([]);
    });
  });

  it('queues fresh input behind a non-steerable backlog instead of jumping ahead', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.towerMode = true;
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.queuedMessages = [{ text: 'make build', agentId: 'main', mode: 'bash' }];

    driver.handleUserInput('objective two');

    expect(session.steer).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([
      { text: 'make build', agentId: 'main', mode: 'bash' },
      { text: 'objective two', agentId: 'main' },
    ]);
  });

  it('resets the streaming phase when steering mid-goal input fails', async () => {
    const session = makeSession({
      steer: mock(async () => {
        throw new Error('session closed');
      }),
    });
    const { driver } = await makeDriver(session);
    driver.state.appState.goal = makeActiveGoalSnapshot();

    driver.handleUserInput('hello mid-goal');

    await waitForAssertion(() => {
      expect(stripSgr(renderTranscript(driver))).toContain('Failed to steer: session closed');
    });
    expect(readStreamingPhase(driver)).toBe('idle');
  });

  it('steers a queued message at a turn boundary while a goal is active', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.goal = makeActiveGoalSnapshot();
    driver.state.appState.streamingPhase = 'waiting';
    driver.handleUserInput('mid-goal note');
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toEqual([{ text: 'mid-goal note', agentId: 'main' }]);
    });

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 0,
        reason: 'completed',
      } as Event,
      (item) => {
        driver.sendQueuedMessage(session, item);
      },
    );

    await waitForAssertion(() => {
      expect(session.steer).toHaveBeenCalledWith('mid-goal note');
    });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it('prompts the queued message as a new turn when no goal is active', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.handleUserInput('after the turn');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 0,
        reason: 'completed',
      } as Event,
      (item) => {
        driver.sendQueuedMessage(session, item);
      },
    );

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith('after the turn', { promptId: undefined });
    });
    expect(session.steer).not.toHaveBeenCalled();
  });

  it('cancels active streaming from Escape and Ctrl-C editor shortcuts', async () => {
    const { driver, session } = await makeDriver();

    driver.state.appState.streamingPhase = 'waiting';
    driver.state.editor.setText('draft while streaming');
    driver.state.editor.onEscape?.();

    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(driver.state.editor.getText()).toBe('draft while streaming');

    session.cancel.mockClear();
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.editor.setText('');
    driver.state.editor.onCtrlC?.();

    expect(session.cancel).toHaveBeenCalledTimes(1);
  });

  it('returns to idle and allows /clear after cancelling ReadMediaFile', async () => {
    const nextSession = makeSession({ id: 'ses-2' });
    const { driver, session, harness } = await makeDriver();
    harness.createSession.mockResolvedValueOnce(nextSession);
    driver.sessionEventHandler.handleEvent(
      { type: 'turn.started', agentId: 'main', sessionId: 'ses-1', turnId: 0, origin: { kind: 'user' } } as Event,
      () => {},
    );
    driver.sessionEventHandler.handleEvent(
      { type: 'turn.step.started', agentId: 'main', sessionId: 'ses-1', turnId: 0, step: 6 } as Event,
      () => {},
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 0,
        toolCallId: 'tool_LSp6cwjJVBvL6Zzej7YMboRi',
        name: 'ReadMediaFile',
        args: { path: 'analysis/full_small.mp4' },
        display: { kind: 'file_io', operation: 'read', path: '/tmp/full_small.mp4' },
      } as Event,
      () => {},
    );
    expect(driver.state.activitySpinner).not.toBeNull();

    session.cancel.mockImplementation(async () => {
      driver.sessionEventHandler.handleEvent(
        {
          type: 'tool.result',
          agentId: 'main',
          sessionId: 'ses-1',
          turnId: 0,
          toolCallId: 'tool_LSp6cwjJVBvL6Zzej7YMboRi',
          output: 'The user manually interrupted "ReadMediaFile".',
          isError: true,
        } as Event,
        () => {},
      );
      driver.sessionEventHandler.handleEvent(
        {
          type: 'turn.step.interrupted',
          agentId: 'main',
          sessionId: 'ses-1',
          turnId: 0,
          step: 6,
          reason: 'aborted',
        } as Event,
        () => {},
      );
      driver.sessionEventHandler.handleEvent(
        {
          type: 'turn.ended',
          agentId: 'main',
          sessionId: 'ses-1',
          turnId: 0,
          reason: 'cancelled',
          durationMs: 53847,
          traceId: '87ba9125dc01214ef86100ac03bd4fd9',
        } as Event,
        () => {},
      );
    });

    driver.state.editor.onEscape?.();

    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(readStreamingPhase(driver)).toBe('idle');
    expect(driver.state.livePane.mode).toBe('idle');
    expect(driver.state.activitySpinner).toBeNull();

    driver.handleUserInput('/clear');

    await waitForAssertion(() => {
      expect(driver.getCurrentSessionId()).toBe('ses-2');
    });
    expect(readStreamingPhase(driver)).toBe('idle');
    expect(driver.state.livePane.mode).toBe('idle');
    expect(driver.state.activitySpinner).toBeNull();
  });

  it('aborts an in-flight video upload and recovers through /clear', async () => {
    const homeDir = await makeTempHome();
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-code-tui-video-'));
    tempDirs.push(workDir);
    const clipBytes = Buffer.from('00000020667479706d703432000000006d70343269736f6d', 'hex');
    await writeFile(join(workDir, 'clip.mp4'), clipBytes);

    let notifyUploadStarted!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      notifyUploadStarted = resolve;
    });
    let uploadAborted = false;
    let uploadedFileBytes = 0;
    const fetchStub = spyOn(globalThis, 'fetch').mockImplementation(
      (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
        if (url.endsWith('/files')) {
          uploadedFileBytes = await uploadedFileSize(init?.body);
          notifyUploadStarted();
          // The real endpoint accepts the bytes and then holds the response
          // open; aborting the request is what closes it.
          return new Promise<Response>((_resolve, reject) => {
            const abort = (): void => {
              uploadAborted = true;
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            };
            if (signal?.aborted === true) {
              abort();
              return;
            }
            signal?.addEventListener('abort', abort, { once: true });
          });
        }
        if (url.endsWith('/chat/completions')) {
          return new Response(videoUploadChatStream(), {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch,
    );
    const baseUrl = 'http://stub.invalid/v1';
    await writeFile(
      join(homeDir, 'config.toml'),
      `
default_model = "stub"

[providers.stub]
type = "kimi"
base_url = "${baseUrl}"
api_key = "test-key"

[models.stub]
provider = "stub"
model = "stub"
max_context_size = 262144
capabilities = ["image_in", "video_in"]
`,
      'utf-8',
    );

    let harness: ReturnType<typeof createKimiHarness> | undefined;
    let driver: MessageDriver | undefined;
    try {
      harness = createKimiHarness({
        homeDir,
        identity: { productName: 'kimi-code-cli', version: '0.0.0-test', platform: 'kimi_code_cli' },
      });
      const startupInput = { ...makeStartupInput(), workDir };
      startupInput.cliOptions.model = 'stub';
      driver = new KimiTUI(harness, startupInput) as unknown as MessageDriver;
      spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
      spyOn(driver.state.terminal, 'setProgress').mockImplementation(() => {});
      driver.persistInputHistory = mock(async () => {});
      await driver.init();
      const session = await harness.createSession({ workDir });
      await driver.setSession(session);
      await driver.syncRuntimeState(session);
      driver.sessionEventHandler.startSubscription();

      driver.handleUserInput('watch clip.mp4');
      await uploadStarted;
      expect(uploadedFileBytes).toBe(clipBytes.length);
      driver.state.editor.onEscape?.();

      await waitForAssertion(() => {
        expect(driver!.state.appState.streamingPhase).toBe('idle');
      });
      await waitForAssertion(() => {
        expect(uploadAborted).toBe(true);
      });
      expect(driver.state.activitySpinner).toBeNull();
      const previousSessionId = driver.getCurrentSessionId();

      driver.handleUserInput('/clear');

      await waitForAssertion(() => {
        expect(driver!.getCurrentSessionId()).not.toBe(previousSessionId);
      });
      expect(readStreamingPhase(driver)).toBe('idle');
      expect(driver.state.livePane.mode).toBe('idle');
      expect(driver.state.activitySpinner).toBeNull();
    } finally {
      driver?.state.activitySpinner?.instance.stop();
      await driver?.closeSession('test').catch(() => {});
      await harness?.close();
      fetchStub.mockRestore();
    }
  });

  it.skipIf(!runRealHttpE2E)(
    'aborts an in-flight video upload against a real HTTP server',
    async () => {
      const homeDir = await makeTempHome();
      const workDir = await mkdtemp(join(tmpdir(), 'kimi-code-tui-video-'));
      tempDirs.push(workDir);
      await writeFile(
        join(workDir, 'clip.mp4'),
        Buffer.from('00000020667479706d703432000000006d70343269736f6d', 'hex'),
      );

      let notifyUploadStarted!: () => void;
      const uploadStarted = new Promise<void>((resolve) => {
        notifyUploadStarted = resolve;
      });
      let uploadAborted = false;
      const server = createServer((req, res) => {
        void (async () => {
          for await (const _chunk of req) {
          }
          if (req.url === '/v1/files') {
            notifyUploadStarted();
            res.on('close', () => {
              if (!res.writableEnded) uploadAborted = true;
            });
            return;
          }
          if (req.url === '/v1/chat/completions') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(videoUploadChatStream());
            return;
          }
          res.writeHead(404);
          res.end();
        })().catch(() => {
          res.destroy();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      await writeFile(
        join(homeDir, 'config.toml'),
        `
default_model = "stub"

[providers.stub]
type = "kimi"
base_url = "${baseUrl}"
api_key = "test-key"

[models.stub]
provider = "stub"
model = "stub"
max_context_size = 262144
capabilities = ["image_in", "video_in"]
`,
        'utf-8',
      );

      let harness: ReturnType<typeof createKimiHarness> | undefined;
      let driver: MessageDriver | undefined;
      try {
        harness = createKimiHarness({
          homeDir,
          identity: {
            productName: 'kimi-code-cli',
            version: '0.0.0-test',
            platform: 'kimi_code_cli',
          },
        });
        const startupInput = { ...makeStartupInput(), workDir };
        startupInput.cliOptions.model = 'stub';
        driver = new KimiTUI(harness, startupInput) as unknown as MessageDriver;
        spyOn(driver.state.ui, 'requestRender').mockImplementation(() => {});
        spyOn(driver.state.terminal, 'setProgress').mockImplementation(() => {});
        driver.persistInputHistory = mock(async () => {});
        await driver.init();
        const session = await harness.createSession({ workDir });
        await driver.setSession(session);
        await driver.syncRuntimeState(session);
        driver.sessionEventHandler.startSubscription();

        driver.handleUserInput('watch clip.mp4');
        await uploadStarted;
        driver.state.editor.onEscape?.();

        await waitForAssertion(() => {
          expect(driver!.state.appState.streamingPhase).toBe('idle');
        });
        await waitForAssertion(() => {
          expect(uploadAborted).toBe(true);
        });
        expect(driver.state.activitySpinner).toBeNull();
        const previousSessionId = driver.getCurrentSessionId();

        driver.handleUserInput('/clear');

        await waitForAssertion(() => {
          expect(driver!.getCurrentSessionId()).not.toBe(previousSessionId);
        });
        expect(readStreamingPhase(driver)).toBe('idle');
        expect(driver.state.livePane.mode).toBe('idle');
        expect(driver.state.activitySpinner).toBeNull();
      } finally {
        driver?.state.activitySpinner?.instance.stop();
        await driver?.closeSession('test').catch(() => {});
        await harness?.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
      }
    },
  );

  it('clears streaming editor text before cancelling the active turn on Ctrl-C', async () => {
    const { driver, session } = await makeDriver();

    driver.state.appState.streamingPhase = 'waiting';
    driver.state.editor.setText('draft while streaming');

    driver.state.editor.onCtrlC?.();

    expect(driver.state.editor.getText()).toBe('');
    expect(session.cancel).not.toHaveBeenCalled();
    expect(readStreamingPhase(driver)).toBe('waiting');

    driver.state.editor.onCtrlC?.();

    expect(session.cancel).toHaveBeenCalledTimes(1);
  });

  it('dispatches the next queued message after the active turn ends', async () => {
    const clock = createFakeClock(1_000);
    const { driver } = await makeDriver();
    useStreamingClock(driver, clock);
    const sendQueued = mock();
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.appState.streamingStartTime = 1;
    driver.streamingUI.setTurnId('1');
    driver.state.queuedMessages = [{ text: 'next' }];

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        reason: 'completed',
      } as Event,
      sendQueued,
    );

    expect(sendQueued).not.toHaveBeenCalled();
    await advanceClockAsync(clock, STREAMING_UI_FLUSH_MS);

    expect(sendQueued).toHaveBeenCalledWith({ text: 'next' });
    expect(driver.state.queuedMessages).toEqual([]);
    expect(readStreamingPhase(driver)).toBe('idle');
  });

  it('queues bash input with mode bash while a turn is streaming', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.appState.inputMode = 'bash';
    driver.state.editor.inputMode = 'bash';

    driver.handleUserInput('ls');

    expect(session.prompt).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([{ text: 'ls', agentId: 'main', mode: 'bash' }]);
  });

  it('dispatches a queued bash item to runShellCommand instead of prompt', async () => {
    const runShellCommand = mock(async () => ({ stdout: '', stderr: '', isError: false }));
    const session = makeSession({ runShellCommand });
    const { driver } = await makeDriver(session);

    driver.sendQueuedMessage(session, { text: 'ls', mode: 'bash' });
    await Promise.resolve();

    expect(runShellCommand).toHaveBeenCalledWith(
      'ls',
      expect.objectContaining({ commandId: expect.any(String) }),
    );
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it('persists bash input to input history with a leading !', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.appState.inputMode = 'bash';
    driver.state.editor.inputMode = 'bash';

    driver.handleUserInput('ls');

    expect(driver.persistInputHistory).toHaveBeenCalledWith('!ls');
  });

  it('persists normal input to input history', async () => {
    const { driver } = await makeDriver();

    driver.handleUserInput('hello');

    expect(driver.persistInputHistory).toHaveBeenCalledWith('hello');
  });

  it('does not steer queued bash commands, keeping them queued', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.queuedMessages = [
      { text: 'ls', agentId: 'main', mode: 'bash' },
      { text: 'focus on tests', agentId: 'main' },
    ];

    driver.state.editor.onCtrlS?.();

    expect(session.steer).toHaveBeenCalledWith('focus on tests');
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toEqual([
        { text: 'ls', agentId: 'main', mode: 'bash' },
      ]);
    });
  });

  it('does not steer while a shell command is running', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'shell';
    driver.state.queuedMessages = [{ text: 'summarize the output', agentId: 'main' }];

    driver.state.editor.onCtrlS?.();

    expect(session.steer).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([
      { text: 'summarize the output', agentId: 'main' },
    ]);
  });

  it('does not steer the editor draft while it is in bash mode', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.editor.inputMode = 'bash';
    driver.state.editor.setText('ls');

    driver.state.editor.onCtrlS?.();

    expect(session.steer).not.toHaveBeenCalled();
    expect(driver.state.editor.getText()).toBe('ls');
  });

  it('drains a queued image message with its media parts', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addImage(new Uint8Array([0xaa, 0xbb]), 'image/png', 1, 1);
    driver.state.appState.streamingPhase = 'waiting';

    driver.handleUserInput(`describe ${attachment.placeholder}`);

    expect(session.prompt).not.toHaveBeenCalled();
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toHaveLength(1);
    });
    const queued = driver.state.queuedMessages[0];
    expect(queued?.parts).toEqual([
      { type: 'text', text: 'describe ' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
    ]);

    driver.sendQueuedMessage(session, queued!);

    expect(session.prompt).toHaveBeenCalledWith(
      [
        { type: 'text', text: 'describe ' },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
      ],
      { promptId: expect.any(String) },
    );
  });

  it('steers editor image input as media parts', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addImage(new Uint8Array([0xaa, 0xbb]), 'image/png', 1, 1);
    driver.state.editor.setText(`check ${attachment.placeholder}`);

    driver.state.editor.onCtrlS?.();

    await waitForAssertion(() => {
      expect(session.steer).toHaveBeenCalledWith([
        { type: 'text', text: 'check ' },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
      ]);
    });
  });

  it('steers queued image messages with their media parts', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addImage(new Uint8Array([0xaa, 0xbb]), 'image/png', 1, 1);
    driver.state.queuedMessages = [
      {
        text: `look ${attachment.placeholder}`,
        agentId: 'main',
        parts: [
          { type: 'text', text: 'look ' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
        ],
        imageAttachmentIds: [attachment.id],
      },
    ];

    driver.state.editor.onCtrlS?.();

    expect(session.steer).toHaveBeenCalledWith([
      { type: 'text', text: 'look ' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
    ]);
    await waitForAssertion(() => { expect(driver.state.queuedMessages).toEqual([]); });
  });

  it('releases every queued use of shared media after a batched steer', async () => {
    const session = makeSession();
    const { driver, harness } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = stagedImage(imageStore, 'file-batched');
    driver.handleUserInput(`first ${attachment.placeholder}`);
    driver.handleUserInput(`second ${attachment.placeholder}`);
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toHaveLength(2);
    });

    driver.state.editor.onCtrlS?.();

    await waitForAssertion(() => {
      expect(session.steer).toHaveBeenCalledTimes(1);
    });
    driver.sessionEventHandler.handleEvent(
      { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event,
      () => {},
    );
    await waitForAssertion(() => {
      expect(harness.deleteFile).toHaveBeenCalledWith('file-batched');
    });
    expect(harness.deleteFile).toHaveBeenCalledTimes(1);
    expect(attachment.fileId).toBeUndefined();
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it('keeps a shared staged upload alive while another submission still holds it', async () => {
    const session = makeSession();
    const { driver, harness } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'waiting';
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = stagedImage(imageStore, 'file-shared');

    driver.handleUserInput(`compare ${attachment.placeholder} with ${attachment.placeholder}`);
    driver.handleUserInput(`and ${attachment.placeholder}`);
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toHaveLength(2);
    });
    const [first, second] = driver.state.queuedMessages;

    driver.sendQueuedMessage(session, first!);
    emitTurn(driver, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.deleteFile).not.toHaveBeenCalled();

    driver.sendQueuedMessage(session, second!);
    emitTurn(driver, 2);
    await waitForAssertion(() => {
      expect(harness.deleteFile).toHaveBeenCalledWith('file-shared');
    });
    expect(harness.deleteFile).toHaveBeenCalledTimes(1);
  });

  it('keeps staged media when a queued message is recalled into the editor', async () => {
    const session = makeSession();
    const { driver, harness } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'waiting';
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = stagedImage(imageStore, 'file-recall');

    driver.handleUserInput(`look ${attachment.placeholder}`);
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toHaveLength(1);
    });

    const recalled = driver.recallLastQueued();
    expect(recalled?.text).toContain(attachment.placeholder);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.deleteFile).not.toHaveBeenCalled();
    expect(attachment.fileId).toBe('file-recall');

    driver.handleUserInput(recalled!.text);
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toHaveLength(1);
    });
    const requeued = driver.state.queuedMessages[0]!;
    expect(requeued.parts).toContainEqual({
      type: 'image_url',
      imageUrl: { url: 'kimi-file://file-recall' },
    });

    driver.sendQueuedMessage(session, requeued);
    emitTurn(driver, 1);
    await waitForAssertion(() => {
      expect(harness.deleteFile).toHaveBeenCalledWith('file-recall');
    });
    expect(harness.deleteFile).toHaveBeenCalledTimes(1);
  });

  it('keeps a recalled video’s daemon upload alive for the restored draft', async () => {
    const session = makeSession();
    const { driver, harness } = await makeDriver(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addVideo('video/mp4', '/tmp/clip.mp4');
    imageStore.completeVideo(attachment, { fileId: 'file-v1' });
    driver.state.appState.streamingPhase = 'waiting';

    driver.handleUserInput(`describe ${attachment.placeholder}`);
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toHaveLength(1);
    });

    const recalled = driver.recallLastQueued();
    expect(recalled?.text).toContain(attachment.placeholder);
    expect(attachment.fileId).toBe('file-v1');
    expect(harness.deleteFile).not.toHaveBeenCalled();

    driver.handleUserInput(recalled!.text);
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toHaveLength(1);
    });
    const queued = driver.state.queuedMessages[0];
    const parts = queued?.parts as Array<{ type: string; videoUrl?: { url: string } }>;
    expect(parts?.[1]).toEqual({ type: 'video_url', videoUrl: { url: 'kimi-file://file-v1' } });
    expect(queued?.videoAttachmentIds).toEqual([attachment.id]);
  });

  it('steers consecutive image-only messages without a whitespace-only separator part', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const first = imageStore.addImage(new Uint8Array([0xaa]), 'image/png', 1, 1);
    const second = imageStore.addImage(new Uint8Array([0xbb]), 'image/png', 1, 1);
    const imagePart = (bytes: Uint8Array) => ({
      type: 'image_url' as const,
      imageUrl: { url: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}` },
    });
    driver.state.queuedMessages = [
      {
        text: first.placeholder,
        agentId: 'main',
        parts: [imagePart(first.bytes)],
        imageAttachmentIds: [first.id],
      },
      {
        text: second.placeholder,
        agentId: 'main',
        parts: [imagePart(second.bytes)],
        imageAttachmentIds: [second.id],
      },
    ];

    driver.state.editor.onCtrlS?.();

    expect(session.steer).toHaveBeenCalledWith([imagePart(first.bytes), imagePart(second.bytes)]);
  });

  it('steers a media item followed by plain text with a blank-line separator', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addImage(new Uint8Array([0xaa, 0xbb]), 'image/png', 1, 1);
    driver.state.queuedMessages = [
      {
        text: `look ${attachment.placeholder}`,
        agentId: 'main',
        parts: [
          { type: 'text', text: 'look ' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
        ],
        imageAttachmentIds: [attachment.id],
      },
      { text: 'focus on tests', agentId: 'main' },
    ];

    driver.state.editor.onCtrlS?.();

    expect(session.steer).toHaveBeenCalledWith([
      { type: 'text', text: 'look ' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
      { type: 'text', text: '\n\nfocus on tests' },
    ]);
  });

  it('steers plain text followed by a media item with a blank-line separator', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'waiting';
    driver.streamingUI.setTurnId('1');
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addImage(new Uint8Array([0xaa, 0xbb]), 'image/png', 1, 1);
    driver.state.queuedMessages = [
      { text: 'hello', agentId: 'main' },
      {
        text: attachment.placeholder,
        agentId: 'main',
        parts: [{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } }],
        imageAttachmentIds: [attachment.id],
      },
    ];

    driver.state.editor.onCtrlS?.();

    expect(session.steer).toHaveBeenCalledWith([
      { type: 'text', text: 'hello\n\n' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
    ]);
  });

  it('reports failed skill media argument materialization without requeuing', async () => {
    const session = makeSession({
      listSkills: mock(async () => [
        { name: 'test', description: 'Test skill', path: '/tmp/test', source: 'user' },
      ]),
    });
    const { driver } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const missing = imageStore.addVideo('video/quicktime', '/tmp/kimi-missing-source.mov');
    imageStore.completeVideo(missing, { fileId: 'file-missing-source' });
    const text = `/skill:test look ${missing.placeholder}`;

    driver.handleUserInput(text);

    expect(session.promptWithSkills).not.toHaveBeenCalled();
    expect(session.activateSkill).not.toHaveBeenCalled();
    expect(stripSgr(renderTranscript(driver))).toContain('Failed to prepare media attachment');
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it('shows an error instead of throwing when plugin command media materialization fails', async () => {
    const activatePluginCommand = mock(async () => {});
    const session = makeSession({ activatePluginCommand });
    const { driver } = await makeDriver(session);
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const missing = imageStore.addVideo('video/mp4', '/tmp/kimi-missing-source.mp4');

    (
      driver as unknown as {
        activatePluginCommand(s: unknown, pluginId: string, command: string, args: string): void;
      }
    ).activatePluginCommand(session, 'plug', 'cmd', missing.placeholder);

    expect(activatePluginCommand).not.toHaveBeenCalled();
    expect(stripSgr(renderTranscript(driver))).toContain('Failed to prepare media attachment');
  });

  it('keeps the queue and draft intact when steer media extraction fails', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    driver.state.appState.model = 'k2';
    driver.state.appState.streamingPhase = 'waiting';
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const missing = imageStore.addVideo('video/quicktime', '/tmp/kimi-missing-source.mov');
    driver.state.queuedMessages = [{ text: 'queued note', agentId: 'main' }];
    driver.state.editor.setText(`look ${missing.placeholder}`);

    driver.state.editor.onCtrlS?.();

    expect(session.steer).not.toHaveBeenCalled();
    expect(driver.state.queuedMessages).toEqual([{ text: 'queued note', agentId: 'main' }]);
    expect(driver.state.editor.getText()).toBe(`look ${missing.placeholder}`);
    await waitForAssertion(() => {
      expect(stripSgr(renderTranscript(driver))).toContain('Failed to prepare media attachment');
    });
  });

  it('recalls a queued bash command back into bash mode on Up', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.queuedMessages = [{ text: 'ls', agentId: 'main', mode: 'bash' }];
    driver.state.editor.inputMode = 'prompt';
    driver.state.appState.inputMode = 'prompt';

    const handled = driver.state.editor.onUpArrowEmpty?.();

    expect(handled).toBe(true);
    expect(driver.state.editor.getText()).toBe('ls');
    expect(readEditorInputMode(driver)).toBe('bash');
    expect(readAppInputMode(driver)).toBe('bash');
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it('recalls a queued prompt message in prompt mode on Up', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.queuedMessages = [{ text: 'hello', agentId: 'main' }];
    driver.state.editor.inputMode = 'bash';
    driver.state.appState.inputMode = 'bash';

    const handled = driver.state.editor.onUpArrowEmpty?.();

    expect(handled).toBe(true);
    expect(driver.state.editor.getText()).toBe('hello');
    expect(readEditorInputMode(driver)).toBe('prompt');
    expect(readAppInputMode(driver)).toBe('prompt');
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it('echoes a bash command with a $ prompt in the transcript', async () => {
    const runShellCommand = mock(async () => ({ stdout: '', stderr: '', isError: false }));
    const session = makeSession({ runShellCommand });
    const { driver, harness } = await makeDriver(session);
    driver.state.appState.inputMode = 'bash';
    driver.state.editor.inputMode = 'bash';

    driver.handleUserInput('ls');
    await Promise.resolve();

    expect(harness.track).toHaveBeenCalledWith('shell_command', undefined);

    const transcript = stripSgr(driver.state.transcriptContainer.render(120).join('\n'));
    expect(transcript).toContain('$ ls');
    expect(transcript).not.toContain('! ls');
  });

  it('collapses long ! output to its first 10 rows and expands it with ctrl+o', async () => {
    const stdout = Array.from(
      { length: 30 },
      (_, i) => `row-${String(i + 1).padStart(2, '0')}`,
    ).join('\n');
    const runShellCommand = mock(async () => ({ stdout, stderr: '', isError: false }));
    const session = makeSession({ runShellCommand });
    const { driver } = await makeDriver(session);
    driver.state.appState.inputMode = 'bash';
    driver.state.editor.inputMode = 'bash';

    driver.handleUserInput('seq 30');
    await waitForAssertion(() => {
      const transcript = stripSgr(driver.state.transcriptContainer.render(120).join('\n'));
      expect(transcript).toContain('… (20 more lines, ctrl+o to expand)');
    });

    let transcript = stripSgr(driver.state.transcriptContainer.render(120).join('\n'));
    expect(transcript).toContain('row-01');
    expect(transcript).not.toContain('row-11');

    driver.state.editor.onToggleToolExpand?.();
    transcript = stripSgr(driver.state.transcriptContainer.render(120).join('\n'));
    expect(transcript).toContain('row-30');
    expect(transcript).not.toContain('more lines');

    driver.state.editor.onToggleToolExpand?.();
    transcript = stripSgr(driver.state.transcriptContainer.render(120).join('\n'));
    expect(transcript).toContain('… (20 more lines, ctrl+o to expand)');
    expect(transcript).not.toContain('row-11');
  });

  it('a new ! card inherits an already-on ctrl+o expand state', async () => {
    const stdout = Array.from(
      { length: 30 },
      (_, i) => `row-${String(i + 1).padStart(2, '0')}`,
    ).join('\n');
    let resolveCmd!: (value: { stdout: string; stderr: string; isError: boolean }) => void;
    const runShellCommand = mock(
      () =>
        new Promise<{ stdout: string; stderr: string; isError: boolean }>((resolve) => {
          resolveCmd = resolve;
        }),
    );
    const session = makeSession({ runShellCommand });
    const { driver } = await makeDriver(session);
    driver.state.toolOutputExpanded = true;
    driver.state.appState.inputMode = 'bash';
    driver.state.editor.inputMode = 'bash';

    driver.handleUserInput('seq 30');
    await Promise.resolve();
    const outputEntry = driver.state.transcriptEntries.at(-1);
    expect(outputEntry).toBeDefined();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'shell.output',
        agentId: 'main',
        sessionId: 'ses-1',
        commandId: outputEntry!.id,
        update: { kind: 'stdout', text: stdout },
      } as Event,
      mock(),
    );
    let transcript = stripSgr(driver.state.transcriptContainer.render(120).join('\n'));
    expect(transcript).toContain('row-01');
    expect(transcript).not.toContain('+25 lines');

    resolveCmd({ stdout, stderr: '', isError: false });
    await waitForAssertion(() => {
      const finished = stripSgr(driver.state.transcriptContainer.render(120).join('\n'));
      expect(finished).toContain('row-30');
    });
    transcript = stripSgr(driver.state.transcriptContainer.render(120).join('\n'));
    expect(transcript).toContain('row-01');
    expect(transcript).not.toContain('more lines');
  });

  it('renders cron fired events as distinct transcript entries', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'cron.fired',
        agentId: 'main',
        sessionId: 'ses-1',
        origin: {
          kind: 'cron_job',
          jobId: 'deadbeef',
          cron: '* * * * *',
          recurring: true,
          coalescedCount: 1,
          stale: false,
        },
        prompt: 'Remind the user: this is a once-per-minute reminder',
      } as Event,
      mock(),
    );

    const entry = driver.state.transcriptEntries.at(-1);
    expect(entry).toMatchObject({
      kind: 'cron',
      content: 'Remind the user: this is a once-per-minute reminder',
      cronData: {
        jobId: 'deadbeef',
        cron: '* * * * *',
        coalescedCount: 1,
        stale: false,
      },
    });

    const transcript = stripSgr(driver.state.transcriptContainer.render(120).join('\n'));
    expect(transcript).toContain('Scheduled reminder fired');
    expect(transcript).toContain('* * * * *');
    expect(transcript).toContain('Remind the user: this is a once-per-minute reminder');
    expect(transcript).not.toContain('<cron-fire');
  });

  it('keeps the previous turn’s final answer mounted when a cron turn completes', async () => {
    const { driver } = await makeDriver();
    const emit = (event: Event) => driver.sessionEventHandler.handleEvent(event, () => {});
    let entrySeq = 0;
    const entry = (kind: 'user' | 'assistant', content: string, turnId?: string) => {
      entrySeq += 1;
      driver.appendTranscriptEntry({
        id: `cron-fold-${entrySeq}`,
        kind,
        turnId,
        renderMode: kind === 'assistant' ? 'markdown' : 'plain',
        content,
      });
    };

    entry('user', 'what is the answer?');
    emit({ type: 'turn.started', agentId: 'main', turnId: 1, origin: { kind: 'user' } } as Event);
    entry('assistant', 'working on it', '1');
    entry('assistant', 'FINAL-ANSWER', '1');
    emit({ type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event);

    expect(stripSgr(renderTranscript(driver))).toContain('FINAL-ANSWER');

    const cronOrigin = {
      kind: 'cron_job',
      jobId: 'job-42',
      cron: '*/5 * * * *',
      recurring: true,
      coalescedCount: 1,
      stale: false,
    };
    emit({ type: 'turn.started', agentId: 'main', turnId: 2, origin: cronOrigin } as Event);
    emit({
      type: 'cron.fired',
      agentId: 'main',
      origin: cronOrigin,
      prompt: 'inspect the fleet',
    } as Event);
    entry('assistant', 'cron report part one', '2');
    entry('assistant', 'cron report final', '2');
    emit({ type: 'turn.ended', agentId: 'main', turnId: 2, reason: 'completed' } as Event);

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('cron report final');
    expect(transcript).toContain('FINAL-ANSWER');
  });

  it('keeps the in-flight answer mounted when a cron fires mid-turn', async () => {
    const { driver } = await makeDriver();
    const emit = (event: Event) => driver.sessionEventHandler.handleEvent(event, () => {});
    let entrySeq = 0;
    const entry = (kind: 'user' | 'assistant', content: string, turnId?: string) => {
      entrySeq += 1;
      driver.appendTranscriptEntry({
        id: `cron-buffered-${entrySeq}`,
        kind,
        turnId,
        renderMode: kind === 'assistant' ? 'markdown' : 'plain',
        content,
      });
    };

    entry('user', 'what is the answer?');
    emit({ type: 'turn.started', agentId: 'main', turnId: 1, origin: { kind: 'user' } } as Event);
    entry('assistant', 'FINAL-ANSWER', '1');

    const cronOrigin = {
      kind: 'cron_job',
      jobId: 'job-42',
      cron: '*/5 * * * *',
      recurring: true,
      coalescedCount: 1,
      stale: false,
    };
    emit({
      type: 'cron.fired',
      agentId: 'main',
      origin: cronOrigin,
      prompt: 'inspect the fleet',
    } as Event);
    entry('assistant', 'cron report part one', '1');
    entry('assistant', 'cron report final', '1');
    emit({ type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event);

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('FINAL-ANSWER');
    expect(transcript).toContain('cron report final');
  });

  it('keeps the previous turn’s final answer mounted when a task-notification turn completes', async () => {
    const { driver } = await makeDriver();
    const emit = (event: Event) => driver.sessionEventHandler.handleEvent(event, () => {});
    let entrySeq = 0;
    const entry = (kind: 'user' | 'assistant', content: string, turnId?: string) => {
      entrySeq += 1;
      driver.appendTranscriptEntry({
        id: `task-fold-${entrySeq}`,
        kind,
        turnId,
        renderMode: kind === 'assistant' ? 'markdown' : 'plain',
        content,
      });
    };

    entry('user', 'what is the answer?');
    emit({ type: 'turn.started', agentId: 'main', turnId: 1, origin: { kind: 'user' } } as Event);
    entry('assistant', 'working on it', '1');
    entry('assistant', 'FINAL-ANSWER', '1');
    emit({ type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event);

    expect(stripSgr(renderTranscript(driver))).toContain('FINAL-ANSWER');

    emit({
      type: 'background.task.terminated',
      agentId: 'main',
      info: {
        taskId: 'task-1',
        kind: 'process',
        description: 'nightly sync',
        status: 'completed',
        exitCode: 0,
        startedAt: 0,
        endedAt: 1,
      },
    } as unknown as Event);
    const taskOrigin = {
      kind: 'task',
      taskId: 'task-1',
      status: 'completed',
      notificationId: 'ntf-1',
    };
    emit({ type: 'turn.started', agentId: 'main', turnId: 2, origin: taskOrigin } as Event);
    entry('assistant', 'task report part one', '2');
    entry('assistant', 'task report final', '2');
    emit({ type: 'turn.ended', agentId: 'main', turnId: 2, reason: 'completed' } as Event);

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('task report final');
    expect(transcript).toContain('FINAL-ANSWER');
  });

  it('keeps the previous turn’s final answer mounted when a background-agent notification turn completes', async () => {
    const { driver } = await makeDriver();
    const emit = (event: Event) => driver.sessionEventHandler.handleEvent(event, () => {});
    let entrySeq = 0;
    const entry = (kind: 'user' | 'assistant', content: string, turnId?: string) => {
      entrySeq += 1;
      driver.appendTranscriptEntry({
        id: `agent-task-fold-${entrySeq}`,
        kind,
        turnId,
        renderMode: kind === 'assistant' ? 'markdown' : 'plain',
        content,
      });
    };

    entry('user', 'what is the answer?');
    emit({ type: 'turn.started', agentId: 'main', turnId: 1, origin: { kind: 'user' } } as Event);
    entry('assistant', 'working on it', '1');
    entry('assistant', 'FINAL-ANSWER', '1');
    emit({ type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event);

    expect(stripSgr(renderTranscript(driver))).toContain('FINAL-ANSWER');

    emit({
      type: 'subagent.spawned',
      agentId: 'main',
      sessionId: 'ses-1',
      subagentId: 'agent-9',
      subagentName: 'explore',
      parentToolCallId: 'tc-9',
      description: 'scout the fleet',
      runInBackground: true,
    } as unknown as Event);
    emit({
      type: 'background.task.started',
      agentId: 'main',
      info: {
        taskId: 'task-9',
        kind: 'agent',
        agentId: 'agent-9',
        description: 'scout the fleet',
        status: 'running',
        startedAt: 0,
      },
    } as unknown as Event);
    emit({
      type: 'subagent.completed',
      agentId: 'main',
      sessionId: 'ses-1',
      subagentId: 'agent-9',
      parentToolCallId: 'tc-9',
      resultSummary: 'fleet scouted',
    } as unknown as Event);
    emit({
      type: 'background.task.terminated',
      agentId: 'main',
      info: {
        taskId: 'task-9',
        kind: 'agent',
        agentId: 'agent-9',
        description: 'scout the fleet',
        status: 'completed',
        startedAt: 0,
        endedAt: 1,
      },
    } as unknown as Event);

    const taskOrigin = {
      kind: 'task',
      taskId: 'task-9',
      status: 'completed',
      notificationId: 'ntf-9',
    };
    emit({ type: 'turn.started', agentId: 'main', turnId: 2, origin: taskOrigin } as Event);
    entry('assistant', 'agent report part one', '2');
    entry('assistant', 'agent report final', '2');
    emit({ type: 'turn.ended', agentId: 'main', turnId: 2, reason: 'completed' } as Event);

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('agent report final');
    expect(transcript).toContain('FINAL-ANSWER');
    const terminalCards = driver.state.transcriptEntries.filter(
      (transcriptEntry) => transcriptEntry.backgroundAgentStatus?.phase === 'completed',
    );
    expect(terminalCards).toHaveLength(1);
  });

  it('anchors the fold boundary to the notification turn when another task terminates mid-turn', async () => {
    const { driver } = await makeDriver();
    const emit = (event: Event) => driver.sessionEventHandler.handleEvent(event, () => {});
    let entrySeq = 0;
    const entry = (kind: 'user' | 'assistant', content: string, turnId?: string) => {
      entrySeq += 1;
      driver.appendTranscriptEntry({
        id: `task-anchor-${entrySeq}`,
        kind,
        turnId,
        renderMode: kind === 'assistant' ? 'markdown' : 'plain',
        content,
      });
    };
    const terminate = (taskId: string) =>
      emit({
        type: 'background.task.terminated',
        agentId: 'main',
        info: {
          taskId,
          kind: 'process',
          description: `task ${taskId}`,
          status: 'completed',
          exitCode: 0,
          startedAt: 0,
          endedAt: 1,
        },
      } as unknown as Event);
    const taskOrigin = (taskId: string) => ({
      kind: 'task',
      taskId,
      status: 'completed',
      notificationId: `ntf-${taskId}`,
    });

    entry('user', 'first question');
    emit({ type: 'turn.started', agentId: 'main', turnId: 1, origin: { kind: 'user' } } as Event);
    entry('assistant', 'working', '1');
    entry('assistant', 'USER-FINAL', '1');
    emit({ type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event);

    // task 1 terminates while idle; its notification turn opens and starts
    // answering, then task 2 terminates mid-turn and its terminal card lands
    // inside turn 2's output.
    terminate('task-1');
    emit({ type: 'turn.started', agentId: 'main', turnId: 2, origin: taskOrigin('task-1') } as Event);
    entry('assistant', 'report one intro', '2');
    terminate('task-2');
    entry('assistant', 'REPORT-ONE-FINAL', '2');
    emit({ type: 'turn.ended', agentId: 'main', turnId: 2, reason: 'completed' } as Event);

    // task 2's notification missed turn 2's last drain, so it opens its own
    // turn. When that turn ends, the fold must start at this turn's boundary —
    // not at task 2's card mounted mid-turn-2 — or REPORT-ONE-FINAL folds away.
    emit({ type: 'turn.started', agentId: 'main', turnId: 3, origin: taskOrigin('task-2') } as Event);
    entry('assistant', 'report two intro', '3');
    entry('assistant', 'report two middle', '3');
    entry('assistant', 'REPORT-TWO-FINAL', '3');
    emit({ type: 'turn.ended', agentId: 'main', turnId: 3, reason: 'completed' } as Event);

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('REPORT-ONE-FINAL');
    expect(transcript).toContain('REPORT-TWO-FINAL');
  });

  it('anchors the fold boundary by mounting a card when an abnormally terminated agent left none', async () => {
    const { driver } = await makeDriver();
    const emit = (event: Event) => driver.sessionEventHandler.handleEvent(event, () => {});
    let entrySeq = 0;
    const entry = (kind: 'user' | 'assistant', content: string, turnId?: string) => {
      entrySeq += 1;
      driver.appendTranscriptEntry({
        id: `agent-lost-fold-${entrySeq}`,
        kind,
        turnId,
        renderMode: kind === 'assistant' ? 'markdown' : 'plain',
        content,
      });
    };

    entry('user', 'what is the answer?');
    emit({ type: 'turn.started', agentId: 'main', turnId: 1, origin: { kind: 'user' } } as Event);
    entry('assistant', 'working on it', '1');
    entry('assistant', 'FINAL-ANSWER', '1');
    emit({ type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed' } as Event);

    expect(stripSgr(renderTranscript(driver))).toContain('FINAL-ANSWER');

    // The agent timed out without any subagent lifecycle event, so no
    // terminal card was ever mounted for it — agent-kind task terminations
    // mount none of their own.
    emit({
      type: 'background.task.terminated',
      agentId: 'main',
      info: {
        taskId: 'task-lost',
        kind: 'agent',
        agentId: 'agent-lost',
        description: 'scout the fleet',
        status: 'timed_out',
        startedAt: 0,
        endedAt: 1,
      },
    } as unknown as Event);
    expect(
      driver.state.transcriptEntries.filter(
        (transcriptEntry) => transcriptEntry.backgroundAgentStatus !== undefined,
      ),
    ).toHaveLength(0);

    // The notification turn anchors its fold boundary by mounting the missing
    // terminal card at the turn's start.
    emit({
      type: 'turn.started',
      agentId: 'main',
      turnId: 2,
      origin: { kind: 'task', taskId: 'task-lost', status: 'timed_out', notificationId: 'ntf-lost' },
    } as Event);
    entry('assistant', 'timeout report final', '2');
    emit({ type: 'turn.ended', agentId: 'main', turnId: 2, reason: 'completed' } as Event);

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('timeout report final');
    expect(transcript).toContain('FINAL-ANSWER');
    const terminalCards = driver.state.transcriptEntries.filter(
      (transcriptEntry) => transcriptEntry.backgroundAgentStatus !== undefined,
    );
    expect(terminalCards).toHaveLength(1);
    expect(terminalCards[0]!.backgroundAgentStatus?.phase).toBe('failed');
  });

  it('coalesces assistant delta component updates', async () => {
    const clock = createFakeClock(1_000);
    const { driver } = await makeDriver();
    useStreamingClock(driver, clock);
    requestRenderSpy(driver).mockClear();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        delta: 'a',
      } as Event,
      mock(),
    );
    const component = driver.streamingUI.getStreamingBlockComponent();
    if (component === undefined) throw new Error('expected streaming component');
    const updateSpy = spyOn(component, 'updateContent');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        delta: 'b',
      } as Event,
      mock(),
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        delta: 'c',
      } as Event,
      mock(),
    );

    expect(updateSpy).not.toHaveBeenCalled();
    await advanceClockAsync(clock, 0);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenLastCalledWith('abc', { transient: true });
  });

  it('flushes pending assistant deltas before turn completion', async () => {
    const clock = createFakeClock(1_000);
    const { driver } = await makeDriver();
    useStreamingClock(driver, clock);
    const sendQueued = mock();
    driver.state.appState.streamingPhase = 'waiting';

    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        delta: 'done',
      } as Event,
      sendQueued,
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        reason: 'completed',
      } as Event,
      sendQueued,
    );

    // The turn boundary flushes the drafting deltas itself — no timer needs to
    // fire before the transcript shows them.
    expect(stripSgr(renderTranscript(driver))).toContain('done');
    expect(clock.activeTimers).toBe(0);
  });

  it('coalesces streaming tool-call argument preview updates', async () => {
    const clock = createFakeClock(1_000);
    const { driver } = await makeDriver();
    useStreamingClock(driver, clock);
    driver.streamingUI.setTurnId('1');
    driver.streamingUI.setStep(1);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_bash',
        name: 'Bash',
        argumentsPart: '{"command":"echo hi"}',
      } as Event,
      mock(),
    );

    expect(driver.streamingUI.getToolComponent('call_bash')).toBeUndefined();
    expect(driver.streamingUI.hasActiveToolCall('call_bash')).toBe(false);

    await advanceClockAsync(clock, 0);

    expect(driver.streamingUI.getToolComponent('call_bash')).toBeDefined();
    expect(driver.streamingUI.getActiveToolCall('call_bash')?.args).toMatchObject({
      command: 'echo hi',
    });
  });

  it('cancels manual compaction from the editor', async () => {
    const { driver, session } = await makeDriver();
    driver.sessionEventHandler.handleEvent(
      {
        type: 'compaction.started',
        agentId: 'main',
        sessionId: 'ses-1',
        trigger: 'manual',
      } as Event,
      mock(),
    );

    driver.state.editor.onEscape?.();

    expect(session.cancelCompaction).toHaveBeenCalledTimes(1);

    session.cancelCompaction.mockClear();
    driver.state.appState.isCompacting = true;
    driver.state.editor.onCtrlC?.();

    expect(session.cancelCompaction).toHaveBeenCalledTimes(1);
  });

  it('clears editor text before cancelling compaction on Ctrl-C', async () => {
    const { driver, session } = await makeDriver();
    driver.sessionEventHandler.handleEvent(
      {
        type: 'compaction.started',
        agentId: 'main',
        sessionId: 'ses-1',
        trigger: 'manual',
      } as Event,
      mock(),
    );
    driver.state.editor.setText('draft while compacting');

    driver.state.editor.onCtrlC?.();

    expect(driver.state.editor.getText()).toBe('');
    expect(session.cancelCompaction).not.toHaveBeenCalled();
    expect(driver.state.appState.isCompacting).toBe(true);

    driver.state.editor.onCtrlC?.();

    expect(session.cancelCompaction).toHaveBeenCalledTimes(1);
  });

  it('dispatches the next queued message after compaction is cancelled', async () => {
    const { driver } = await makeDriver();
    const sendQueued = mock();
    driver.sessionEventHandler.handleEvent(
      {
        type: 'compaction.started',
        agentId: 'main',
        sessionId: 'ses-1',
        trigger: 'manual',
      } as Event,
      sendQueued,
    );
    driver.state.queuedMessages = [{ text: 'next' }];
    // The dispatch is a 0 ms timer owned by the session event handler.
    const clock = installGlobalClock();
    try {
      driver.sessionEventHandler.handleEvent(
        {
          type: 'compaction.cancelled',
          agentId: 'main',
          sessionId: 'ses-1',
        } as Event,
        sendQueued,
      );
      expect(sendQueued).not.toHaveBeenCalled();
      await advanceClockAsync(clock, 0);

      expect(driver.state.appState.isCompacting).toBe(false);
      expect(readStreamingPhase(driver)).toBe('idle');
      expect(driver.state.queuedMessages).toEqual([]);
      expect(sendQueued).toHaveBeenCalledWith({ text: 'next' });
      expect(driver.state.transcriptContainer.render(120).map(stripSgr).join('\n')).toContain(
        'Compaction cancelled',
      );
    } finally {
      restoreGlobalClock();
    }
  });

  it('stores the live compaction summary and expands it with tool output expansion', async () => {
    const { driver } = await makeDriver();
    const sendQueued = mock();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'compaction.started',
        agentId: 'main',
        sessionId: 'ses-1',
        trigger: 'manual',
      } as Event,
      sendQueued,
    );

    driver.sessionEventHandler.handleEvent(
      {
        type: 'compaction.completed',
        agentId: 'main',
        sessionId: 'ses-1',
        result: {
          summary: 'Keep the src/tui compaction notes.',
          compactedCount: 4,
          tokensBefore: 120,
          tokensAfter: 24,
        },
      } as Event,
      sendQueued,
    );

    const collapsed = driver.state.transcriptContainer.render(120).map(stripSgr).join('\n');
    expect(collapsed).toContain('Compaction complete');
    expect(collapsed).not.toContain('Keep the src/tui compaction notes.');

    driver.state.editor.onToggleToolExpand?.();

    const expanded = driver.state.transcriptContainer.render(120).map(stripSgr).join('\n');
    expect(driver.state.toolOutputExpanded).toBe(true);
    expect(expanded).toContain('Keep the src/tui compaction notes.');
  });

  it('honors existing tool output expansion when a compaction block is created', async () => {
    const { driver } = await makeDriver();
    const sendQueued = mock();

    driver.state.editor.onToggleToolExpand?.();
    expect(driver.state.toolOutputExpanded).toBe(true);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'compaction.started',
        agentId: 'main',
        sessionId: 'ses-1',
        trigger: 'manual',
      } as Event,
      sendQueued,
    );

    driver.sessionEventHandler.handleEvent(
      {
        type: 'compaction.completed',
        agentId: 'main',
        sessionId: 'ses-1',
        result: {
          summary: 'Keep the src/tui compaction notes.',
          compactedCount: 4,
          tokensBefore: 120,
          tokensAfter: 24,
        },
      } as Event,
      sendQueued,
    );

    const transcript = driver.state.transcriptContainer.render(120).map(stripSgr).join('\n');
    expect(transcript).toContain('Compaction complete');
    expect(transcript).toContain('Keep the src/tui compaction notes.');
  });

  it('renders an error instead of prompting when no model is selected', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.model = '';

    driver.handleUserInput('hello');

    expect(session.prompt).not.toHaveBeenCalled();
    expect(driver.state.transcriptContainer.render(120).join('\n')).toContain('LLM not set');
  });

  it('dispatches /init to the active session and clears busy state after completion', async () => {
    let resolveInit: (() => void) | undefined;
    const session = makeSession({
      init: mock(
        () =>
          new Promise<void>((resolve) => {
            resolveInit = resolve;
          }),
      ),
    });
    const { driver, harness } = await makeDriver(session);
    harness.track.mockClear();

    driver.handleUserInput('/init');

    await waitForAssertion(() => {
      expect(session.init).toHaveBeenCalledTimes(1);
    });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(driver.state.appState.streamingPhase).not.toBe('idle');
    expect(driver.state.livePane.mode).toBe('waiting');

    resolveInit?.();

    await waitForAssertion(() => {
      expect(readStreamingPhase(driver)).toBe('idle');
    });
    expect(driver.state.livePane.mode).toBe('idle');
    expect(harness.track).toHaveBeenCalledWith('init_complete', undefined);
  });

  it('starts /btw through a forked side agent without changing the main busy state', async () => {
    const session = makeSession();
    const { driver, harness } = await makeDriver(session);
    harness.track.mockClear();
    driver.state.appState.streamingPhase = 'composing';
    driver.state.livePane.mode = 'thinking';

    driver.handleUserInput('/btw What are you working on right now?');

    await waitForAssertion(() => {
      expect(session.startBtw).toHaveBeenCalledWith();
    });
    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith('What are you working on right now?');
    });
    expect(session.steer).not.toHaveBeenCalled();
    expect(readStreamingPhase(driver)).toBe('composing');
    expect(driver.state.livePane.mode).toBe('thinking');
    expect(harness.track).toHaveBeenCalledWith('input_command', { command: 'btw' });
  });

  it('opens /btw without a question and sends the first panel input to a side agent', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/btw');

    await waitForAssertion(() => {
      expect(session.startBtw).toHaveBeenCalledWith();
    });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(stripSgr(renderBtwPanel(driver))).toContain('Ready for a side question…');

    driver.handleUserInput('What are you working on right now?');

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith('What are you working on right now?');
    });
    expect(session.steer).not.toHaveBeenCalled();
    expect(stripSgr(renderBtwPanel(driver))).toContain('Q: What are you working on right now?');
  });

  it('sends /btw panel input with inline skills via promptWithSkills (v2 engine)', async () => {
    const session = makeSession({
      id: 'ses-lazy',
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(
      session,
      {
        listWorkspaceSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
        ]),
        listPluginCommands: mock(async () => []),
      },
      startupInput,
    );
    await (driver as unknown as { refreshSkillCommands(): Promise<void> }).refreshSkillCommands();

    driver.handleUserInput('/btw');
    await waitForAssertion(() => {
      expect(session.startBtw).toHaveBeenCalledWith();
    });
    expect(stripSgr(renderBtwPanel(driver))).toContain('Ready for a side question…');

    driver.handleUserInput('check /skill:review');

    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledWith('check /skill:review', [
        { name: 'review' },
      ]);
    });
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it.each([
    { prefix: '/skill:review inspect', skills: [{ name: 'review', args: expect.stringContaining('Attached image file:') }] },
    { prefix: 'inspect /skill:review', skills: [{ name: 'review' }] },
    { prefix: '/skill:review /skill:security', skills: [{ name: 'review' }, { name: 'security' }] },
  ])('sends a skill image to the open BTW panel without releasing it with the main turn ($prefix)', async ({ prefix, skills }) => {
    const agentScopes: string[] = [];
    const session = makeSession({
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
        { name: 'security', description: 'Security skill', path: '/tmp/security', source: 'user' },
      ]),
      promptWithSkills: mock(async () => { agentScopes.push(harness.interactiveAgentId); }),
    });
    const { driver, harness } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    await openBtwPanel(driver, session);
    getMountedBtwPanel(driver).markDone();
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = stagedImage(imageStore, 'file-btw-image');
    const input = `${prefix} ${attachment.placeholder}`;
    driver.state.editor.setText(input);
    driver.state.editor.handleInput('\r');

    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledWith([
        { type: 'text', text: `${prefix} ` },
        { type: 'image_url', imageUrl: { url: 'kimi-file://file-btw-image' } },
      ], skills);
    });
    expect(agentScopes).toEqual(['agent-btw']);
    expect(stripSgr(renderBtwPanel(driver))).toContain(input);
    emitTurn(driver, 1);
    expect(harness.deleteFile).not.toHaveBeenCalled();
    driver.sessionEventHandler.handleEvent({
      type: 'turn.started', sessionId: session.id, agentId: 'agent-btw',
      turnId: 1, origin: { kind: 'user' },
    } as Event, () => {});
    driver.sessionEventHandler.handleEvent({
      type: 'turn.ended', sessionId: session.id, agentId: 'agent-btw',
      turnId: 1, reason: 'completed',
    } as Event, () => {});
    await waitForAssertion(() => {
      expect(harness.deleteFile).toHaveBeenCalledTimes(1);
      expect(harness.deleteFile).toHaveBeenCalledWith('file-btw-image');
    });
  });

  it.each(['ready', 'timeout', 'closed'] as const)('keeps a pending BTW skill video with its intended recipient (%s)', async (outcome) => {
    process.env['KIMI_CODE_HOME'] = await makeTempHome();
    const sourcePath = join(process.env['KIMI_CODE_HOME'], 'example.mp4');
    await writeFile(sourcePath, 'example video');
    const session = makeSession({
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const { driver, harness } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    await openBtwPanel(driver, session);
    getMountedBtwPanel(driver).markDone();
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addVideo('video/mp4', sourcePath);
    let finishIngestion!: () => void;
    attachment.pending = new Promise<void>((resolve) => {
      finishIngestion = () => {
        imageStore.completeVideo(attachment, { fileId: 'file-btw-video' });
        resolve();
      };
    });
    const input = `/skill:review inspect ${attachment.placeholder}`;
    const clock = installGlobalClock();
    try {
      driver.state.editor.setText(input);
      driver.state.editor.handleInput('\r');
      expect(session.promptWithSkills).not.toHaveBeenCalled();
      if (outcome === 'closed') driver.btwPanelController.closeOrCancel();
      if (outcome === 'timeout') {
        driver.state.editor.setText('keep this draft');
        await advanceClockAsync(clock, 2_000);
        expect(stripSgr(renderBtwPanel(driver))).toContain('still uploading');
        expect(driver.state.editor.getText()).toBe('keep this draft');
      }
      finishIngestion();
      await advanceClockAsync(clock, 0);
      if (outcome === 'ready') {
        expect(session.promptWithSkills).toHaveBeenCalledTimes(1);
        expect(session.promptWithSkills).toHaveBeenCalledWith([
          { type: 'text', text: '/skill:review inspect ' },
          { type: 'video_url', videoUrl: { url: 'kimi-file://file-btw-video' } },
        ], [{ name: 'review', args: expect.stringContaining('Attached video file:') }]);
        driver.sessionEventHandler.handleEvent({
          type: 'turn.started', sessionId: session.id, agentId: 'agent-btw',
          turnId: 1, origin: { kind: 'user' },
        } as Event, () => {});
        driver.btwPanelController.closeOrCancel();
        driver.sessionEventHandler.handleEvent({
          type: 'turn.ended', sessionId: session.id, agentId: 'agent-btw',
          turnId: 1, reason: 'cancelled',
        } as Event, () => {});
        await advanceClockAsync(clock, 0);
        expect(harness.deleteFile).toHaveBeenCalledTimes(1);
        expect(harness.deleteFile).toHaveBeenCalledWith('file-btw-video');
      } else {
        expect(session.promptWithSkills).not.toHaveBeenCalled();
        expect(session.prompt).toHaveBeenCalledTimes(1);
        expect(imageStore.get(attachment.id)?.fileId).toBe('file-btw-video');
      }
    } finally {
      finishIngestion();
      restoreGlobalClock();
    }
  });

  it('reports a BTW skill failure without refilling the editor', async () => {
    const session = makeSession({
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
      promptWithSkills: mock()
        .mockRejectedValueOnce(new Error('Prompt rejected'))
        .mockResolvedValue(undefined),
    });
    const { driver, harness } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    await openBtwPanel(driver, session);
    getMountedBtwPanel(driver).markDone();
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = stagedImage(imageStore, 'file-btw-retry');
    const input = `/skill:review inspect ${attachment.placeholder}`;
    driver.state.editor.setText(input);
    driver.state.editor.handleInput('\r');
    await waitForAssertion(() => {
      expect(stripSgr(renderBtwPanel(driver))).toContain('Prompt rejected');
      expect(driver.state.editor.getText()).toBe('');
    });
    await waitForAssertion(() => {
      expect(harness.deleteFile).toHaveBeenCalledTimes(1);
      expect(harness.deleteFile).toHaveBeenCalledWith('file-btw-retry');
    });
    expect(driver.state.queuedMessages).toEqual([]);
    expect(session.promptWithSkills).toHaveBeenCalledTimes(1);
  });

  it('activates inline skills in the initial /btw prompt (v2 engine)', async () => {
    const session = makeSession({
      id: 'ses-lazy',
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(
      session,
      {
        listWorkspaceSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
        ]),
        listPluginCommands: mock(async () => []),
      },
      startupInput,
    );
    await (driver as unknown as { refreshSkillCommands(): Promise<void> }).refreshSkillCommands();

    driver.handleUserInput('/btw check this /skill:review');

    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledWith('check this /skill:review', [
        { name: 'review' },
      ]);
    });
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it('cancels a BTW skill prompt still waiting for media ingestion', async () => {
    process.env['KIMI_CODE_HOME'] = await makeTempHome();
    const sourcePath = join(process.env['KIMI_CODE_HOME'], 'example.mp4');
    await writeFile(sourcePath, 'example video');
    const session = makeSession({
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const { driver } = await makeDriver(session);
    await (
      driver as unknown as { refreshSkillCommands(s: unknown): Promise<void> }
    ).refreshSkillCommands(session);
    await openBtwPanel(driver, session);
    getMountedBtwPanel(driver).markDone();
    const imageStore = (driver as unknown as { imageStore: ImageAttachmentStore }).imageStore;
    const attachment = imageStore.addVideo('video/mp4', sourcePath);
    let finishIngestion!: () => void;
    attachment.pending = new Promise<void>((resolve) => {
      finishIngestion = () => {
        imageStore.completeVideo(attachment, { fileId: 'file-btw-cancel' });
        resolve();
      };
    });
    driver.state.editor.setText(`/skill:review inspect ${attachment.placeholder}`);
    driver.state.editor.handleInput('\r');
    expect(getMountedBtwPanel(driver).isRunning()).toBe(true);

    expect(driver.btwPanelController.cancelRunning()).toBe(true);
    finishIngestion();

    await waitForAssertion(() => {
      expect(getMountedBtwPanel(driver).isRunning()).toBe(false);
    });
    expect(session.promptWithSkills).not.toHaveBeenCalled();
    expect(stripSgr(renderBtwPanel(driver))).toContain('Interrupted by user');
  });

  it('activates a leading skill token in the initial /btw prompt (v2 engine)', async () => {
    const session = makeSession({
      id: 'ses-lazy',
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
      ]),
    });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(
      session,
      {
        listWorkspaceSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
        ]),
        listPluginCommands: mock(async () => []),
      },
      startupInput,
    );
    await (driver as unknown as { refreshSkillCommands(): Promise<void> }).refreshSkillCommands();

    driver.handleUserInput('/btw /skill:review check this');

    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledWith('/skill:review check this', [
        { name: 'review' },
      ]);
    });
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it('keeps /btw as the leading command when its prompt mentions multiple skills (v2 engine)', async () => {
    const session = makeSession({
      id: 'ses-lazy',
      listSkills: mock(async () => [
        { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
        { name: 'security', description: 'Security skill', path: '/tmp/security', source: 'user' },
      ]),
    });
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      cliOptions: { ...makeStartupInput().cliOptions, model: 'k2' },
    };
    const { driver } = await makeDriver(
      session,
      {
        listWorkspaceSkills: mock(async () => [
          { name: 'review', description: 'Review skill', path: '/tmp/review', source: 'user' },
          {
            name: 'security',
            description: 'Security skill',
            path: '/tmp/security',
            source: 'user',
          },
        ]),
        listPluginCommands: mock(async () => []),
      },
      startupInput,
    );
    await (driver as unknown as { refreshSkillCommands(): Promise<void> }).refreshSkillCommands();

    driver.handleUserInput('/btw check /skill:review /skill:security');

    await waitForAssertion(() => {
      expect(session.startBtw).toHaveBeenCalledWith();
    });
    await waitForAssertion(() => {
      expect(session.promptWithSkills).toHaveBeenCalledWith('check /skill:review /skill:security', [
        { name: 'review' },
        { name: 'security' },
      ]);
    });
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it('cancels an unused /btw side agent when closing an empty panel', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/btw');

    await waitForAssertion(() => {
      expect(session.startBtw).toHaveBeenCalledWith();
    });
    driver.state.editor.onEscape?.();

    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(driver.state.btwPanelContainer.children).toHaveLength(0);
  });

  it('renders /btw output in a dedicated panel instead of an Agent tool card', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session, 'What are you working on right now?');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        delta: 'I am implementing the dedicated /btw panel.',
      } as Event,
      () => {},
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        reason: 'completed',
      } as Event,
      () => {},
    );

    expect(driver.state.btwPanelContainer.children).toHaveLength(2);
    expect(driver.state.btwPanelContainer.render(120)[0]?.trim()).toBe('');
    expect(getMountedBtwPanel(driver).isRunning()).toBe(false);
    expect(driver.state.editor.focused).toBe(true);

    const transcript = stripSgr(renderTranscript(driver));
    const panel = stripSgr(renderBtwPanel(driver));
    const editorTopBorder = stripSgr(driver.state.editor.render(80)[0] ?? '');
    expect(panel).toContain('BTW ─ Esc close');
    expect(panel).not.toContain('ctrl+o expand');
    expect(editorTopBorder.startsWith('├')).toBe(true);
    expect(editorTopBorder.endsWith('┤')).toBe(true);

    driver.state.editor.handleInput('/');
    const highlightedEditorTopBorder = stripSgr(driver.state.editor.render(80)[0] ?? '');
    expect(highlightedEditorTopBorder.startsWith('╭')).toBe(true);
    expect(highlightedEditorTopBorder.endsWith('╮')).toBe(true);
    expect(panel).not.toContain('BTW done');
    expect(panel).not.toContain('BTW running');
    expect(panel).not.toContain('BTW failed');
    expect(panel).not.toContain('Ask:');
    expect(panel).not.toContain('Type follow-up');
    expect(panel).toContain('Q: What are you working on right now?');
    expect(panel).toContain('I am implementing the dedicated /btw panel.');
    expect(panel).not.toContain('Agent');
    expect(transcript).not.toContain('BTW');
    expect(transcript).not.toContain('Esc close');
    expect(transcript).not.toContain('I am implementing the dedicated /btw panel.');
  });

  it('keeps the /btw panel closest to the input after later transcript output', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        delta: 'side answer',
      } as Event,
      () => {},
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        reason: 'completed',
      } as Event,
      () => {},
    );

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        origin: { kind: 'user' },
      } as Event,
      () => {},
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        delta: 'main answer after btw',
      } as Event,
      () => {},
    );
    driver.streamingUI.flushNow();

    const transcript = stripSgr(renderTranscript(driver));
    const panel = stripSgr(renderBtwPanel(driver));
    const rootChildren = driver.state.ui.children;
    expect(rootChildren.indexOf(driver.state.surveyContainer)).toBe(
      rootChildren.indexOf(driver.state.editorContainer) - 1,
    );
    expect(rootChildren.indexOf(driver.state.btwPanelContainer)).toBe(
      rootChildren.indexOf(driver.state.surveyContainer) - 1,
    );
    expect(transcript).toContain('main answer after btw');
    expect(transcript).not.toContain('side answer');
    expect(panel).toContain('BTW');
    expect(panel).not.toContain('BTW done');
    expect(panel).not.toContain('BTW running');
    expect(panel).not.toContain('BTW failed');
    expect(panel).toContain('side answer');
    expect(panel).not.toContain('main answer after btw');
  });

  it('renders only the tail of /btw thinking output', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'thinking.delta',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        delta: ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7'].join('\n'),
      } as Event,
      () => {},
    );

    const transcript = stripSgr(renderTranscript(driver));
    const panel = stripSgr(renderBtwPanel(driver));
    expect(transcript).not.toContain('line7');
    expect(panel).not.toContain('line1');
    expect(panel).not.toContain('line5');
    expect(panel).toContain('line6');
    expect(panel).toContain('line7');
  });

  it('renders /btw body at its actual content height when under the cap', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session);

    const lines = getMountedBtwPanel(driver).render(80).map(stripSgr);
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).toContain('Q: side question');
    expect(lines.join('\n')).toContain('Waiting for answer…');
  });

  it('keeps /btw panel height stable when final output is shorter than thinking', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'thinking.delta',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        delta: 'thinking line 1\nthinking line 2',
      } as Event,
      () => {},
    );

    const mountedPanel = getMountedBtwPanel(driver);
    const thinkingLines = mountedPanel.render(80).map(stripSgr);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        delta: 'final answer',
      } as Event,
      () => {},
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        reason: 'completed',
      } as Event,
      () => {},
    );

    const finalLines = mountedPanel.render(80).map(stripSgr);
    expect(finalLines).toHaveLength(thinkingLines.length);
    expect(finalLines.join('\n')).toContain('final answer');
    expect(finalLines.at(-1)).toMatch(/^│\s+│$/);
  });

  it('caps /btw height to one-third of the terminal and supports scrolling', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    setTerminalRows(driver, 15);
    await openBtwPanel(driver, session, 'question 1');

    const panel = getMountedBtwPanel(driver);
    panel.appendAnswer('answer 1');
    panel.markDone();
    for (let i = 2; i <= 8; i++) {
      panel.submit(`question ${String(i)}`);
      panel.appendAnswer(`answer ${String(i)}`);
      panel.markDone();
    }

    const collapsed = panel.render(80).map(stripSgr);
    expect(collapsed).toHaveLength(5);
    expect(collapsed.join('\n')).toContain('BTW ─ Esc close · ↑↓ scroll');
    expect(collapsed.join('\n')).not.toContain('ctrl+o expand');
    expect(collapsed.join('\n')).toContain('question 8');
    expect(collapsed.join('\n')).toContain('answer 8');
    expect(collapsed.join('\n')).not.toContain('question 1');

    driver.state.editor.setText('draft main input');
    const collapsedWithInput = panel.render(80).map(stripSgr);
    expect(collapsedWithInput.join('\n')).toContain('BTW ─ Esc close');
    expect(collapsedWithInput.join('\n')).not.toContain('↑↓ scroll');
    driver.state.editor.setText('');

    const requestRender = requestRenderSpy(driver);
    requestRender.mockClear();
    for (let i = 0; i < 20; i++) {
      driver.state.editor.handleInput('\u001B[A');
    }
    const scrolledUp = panel.render(80).map(stripSgr);
    expect(requestRender).toHaveBeenCalled();
    expect(scrolledUp.join('\n')).toContain('question 1');
    expect(scrolledUp.join('\n')).not.toContain('answer 8');

    panel.appendAnswer('\nstreamed tail while scrolled');
    expect(panel.render(80).map(stripSgr)).toEqual(scrolledUp);

    requestRender.mockClear();
    for (let i = 0; i < 20; i++) {
      driver.state.editor.handleInput('\u001B[B');
    }
    const scrolledDown = panel.render(80).map(stripSgr);
    expect(requestRender).toHaveBeenCalled();
    expect(scrolledDown.join('\n')).toContain('question 8');
    expect(scrolledDown.join('\n')).toContain('answer 8');
    expect(scrolledDown.join('\n')).toContain('streamed tail while scrolled');

    setTerminalRows(driver, 4);
    const tiny = panel.render(80).map(stripSgr);
    expect(tiny).toHaveLength(3);
    expect(tiny.join('\n')).not.toContain('ctrl+o expand');
    expect(tiny.join('\n')).toContain('answer 8');

    requestRender.mockClear();
    driver.state.editor.onToggleToolExpand?.();
    expect(driver.state.toolOutputExpanded).toBe(true);
    expect(panel.render(80).map(stripSgr)).toEqual(tiny);
  });

  it('cancels and closes a running /btw panel on Escape', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session);

    const panel = getMountedBtwPanel(driver);
    expect(panel.isRunning()).toBe(true);
    expect(driver.state.editor.focused).toBe(true);

    const requestRender = requestRenderSpy(driver);
    requestRender.mockClear();
    driver.state.editor.onEscape?.();

    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(driver.state.btwPanelContainer.children).toHaveLength(0);
    expect(requestRender.mock.calls.at(-1)).toEqual([true]);
    const editorTopBorder = stripSgr(driver.state.editor.render(80)[0] ?? '');
    expect(editorTopBorder.startsWith('╭')).toBe(true);
    expect(editorTopBorder.endsWith('╮')).toBe(true);
    expect(driver.state.editor.focused).toBe(true);
  });

  it('cancels a running /btw panel on Ctrl-C without closing it or cancelling main streaming', async () => {
    const session = makeSession();
    const { driver, harness } = await makeDriver(session);
    const cancelledAgentIds: string[] = [];
    session.cancel.mockImplementation(async () => {
      cancelledAgentIds.push(harness.interactiveAgentId);
    });
    await openBtwPanel(driver, session);
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.editor.setText('draft main input');

    const panel = getMountedBtwPanel(driver);
    expect(panel.isRunning()).toBe(true);

    driver.state.editor.onCtrlC?.();

    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(cancelledAgentIds).toEqual(['agent-btw']);
    expect(getMountedBtwPanel(driver)).toBe(panel);
    expect(driver.state.btwPanelContainer.children).toHaveLength(2);
    expect(driver.state.editor.focused).toBe(true);
    expect(driver.state.editor.getText()).toBe('draft main input');
    expect(readStreamingPhase(driver)).toBe('waiting');
  });

  it('preserves rendered /btw output when a running panel is cancelled', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session);
    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        delta: 'partial side answer',
      } as Event,
      () => {},
    );

    driver.state.editor.onCtrlC?.();
    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        reason: 'cancelled',
      } as Event,
      () => {},
    );

    const panel = stripSgr(renderBtwPanel(driver));
    expect(panel).toContain('partial side answer');
    expect(panel).toContain('Interrupted by user');
  });

  it('cancels a running /btw panel when starting a new session clears it', async () => {
    const initialSession = makeSession({ id: 'ses-initial' });
    const nextSession = makeSession({ id: 'ses-next' });
    const createSession = mock(async () => nextSession);
    const { driver, harness } = await makeDriver(initialSession, { createSession });
    const cancelledAgentIds: string[] = [];
    initialSession.cancel.mockImplementation(async () => {
      cancelledAgentIds.push(harness.interactiveAgentId);
    });
    await openBtwPanel(driver, initialSession);

    driver.handleUserInput('/new');

    await waitForAssertion(() => {
      expect(driver.getCurrentSessionId()).toBe('ses-next');
    });
    expect(initialSession.cancel).toHaveBeenCalledTimes(1);
    expect(cancelledAgentIds).toEqual(['agent-btw']);
    expect(nextSession.cancel).not.toHaveBeenCalled();
    expect(driver.state.btwPanelContainer.children).toHaveLength(0);
  });

  it('closes a completed /btw panel on Ctrl-C without cancelling main streaming', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        reason: 'completed',
      } as Event,
      () => {},
    );
    driver.state.appState.streamingPhase = 'waiting';
    driver.state.editor.setText('draft main input');

    expect(getMountedBtwPanel(driver).isRunning()).toBe(false);

    driver.state.editor.onCtrlC?.();

    expect(session.cancel).not.toHaveBeenCalled();
    expect(driver.state.btwPanelContainer.children).toHaveLength(0);
    expect(driver.state.editor.focused).toBe(true);
    expect(driver.state.editor.getText()).toBe('draft main input');
    expect(readStreamingPhase(driver)).toBe('waiting');
  });

  it('closes a completed /btw panel on Escape without cancelling it', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        reason: 'completed',
      } as Event,
      () => {},
    );

    const panel = getMountedBtwPanel(driver);
    expect(panel.isRunning()).toBe(false);
    expect(driver.state.editor.focused).toBe(true);

    driver.state.editor.onEscape?.();

    expect(session.cancel).not.toHaveBeenCalled();
    expect(driver.state.btwPanelContainer.children).toHaveLength(0);
    expect(driver.state.editor.focused).toBe(true);
  });

  it('sends follow-up /btw input through ordinary prompt on the same side agent', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session, 'first question');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        reason: 'completed',
      } as Event,
      () => {},
    );

    const panel = getMountedBtwPanel(driver);
    expect(panel.isRunning()).toBe(false);
    driver.handleUserInput('follow up');

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith('follow up');
    });
    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(driver.state.btwPanelContainer.children).toHaveLength(2);
    expect(driver.state.editor.focused).toBe(true);
  });

  it('keeps main input pointed at /btw while the panel is open', async () => {
    let resolveBtwPrompt: (() => void) | undefined;
    const session = makeSession({
      prompt: mock(
        () =>
          new Promise<void>((resolve) => {
            resolveBtwPrompt = resolve;
          }),
      ),
    });
    const { driver, harness } = await makeDriver(session);

    await openBtwPanel(driver, session, 'slow side question');

    expect(harness.interactiveAgentId).toBe('main');
    driver.handleUserInput('follow-up while btw prompt is pending');
    driver.handleUserInput('another follow-up while btw prompt is pending');

    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(driver.state.queuedMessages).toEqual([]);
    expect(driver.state.editor.getText()).toBe('another follow-up while btw prompt is pending');
    expect(stripSgr(renderTranscript(driver))).not.toContain(
      'Wait for /btw to finish before sending another question.',
    );
    expect(
      countOccurrences(
        stripSgr(renderBtwPanel(driver)),
        'Wait for /btw to finish before sending another question.',
      ),
    ).toBe(2);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'agent-btw',
        sessionId: 'ses-1',
        turnId: 0,
        reason: 'completed',
      } as Event,
      () => {},
    );

    expect(stripSgr(renderBtwPanel(driver))).not.toContain(
      'Wait for /btw to finish before sending another question.',
    );

    resolveBtwPrompt?.();
  });

  it('replaces a running /btw panel when another /btw command is submitted', async () => {
    const session = makeSession({
      startBtw: mock().mockResolvedValueOnce('agent-btw-1').mockResolvedValueOnce('agent-btw-2'),
    });
    const { driver } = await makeDriver(session);
    await openBtwPanel(driver, session, 'first question');

    const firstPanel = getMountedBtwPanel(driver);
    expect(firstPanel.isRunning()).toBe(true);

    driver.handleUserInput('/btw second question');

    await waitForAssertion(() => {
      expect(session.startBtw).toHaveBeenCalledTimes(2);
    });
    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith('second question');
    });

    const secondPanel = getMountedBtwPanel(driver);
    expect(secondPanel).not.toBe(firstPanel);
    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(session.prompt).toHaveBeenCalledTimes(2);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'agent-btw-1',
        sessionId: 'ses-1',
        turnId: 0,
        delta: 'answer from old side agent',
      } as Event,
      () => {},
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'agent-btw-2',
        sessionId: 'ses-1',
        turnId: 1,
        delta: 'answer from new side agent',
      } as Event,
      () => {},
    );

    const renderedPanel = stripSgr(renderBtwPanel(driver));
    expect(renderedPanel).not.toContain('answer from old side agent');
    expect(renderedPanel).toContain('answer from new side agent');
  });

  it('does not run /btw without a selected model', async () => {
    const { driver, session } = await makeDriver();

    driver.state.appState.model = '';
    driver.handleUserInput('/btw');
    expect(session.startBtw).not.toHaveBeenCalled();
    expect(driver.state.btwPanelContainer.children).toHaveLength(0);
    expect(stripSgr(renderTranscript(driver))).toContain('LLM not set');

    driver.handleUserInput('/btw What are you doing now?');

    expect(session.startBtw).not.toHaveBeenCalled();
    expect(stripSgr(renderTranscript(driver))).toContain('LLM not set');
  });

  it('recomputes contextUsage when a status update carries contextTokens without it', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.contextTokens = 0;
    driver.state.appState.maxContextTokens = 1_000_000;
    driver.state.appState.contextUsage = 0.74;

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        contextTokens: 180_000,
      } as Event,
      mock(),
    );

    expect(driver.state.appState.contextTokens).toBe(180_000);
    expect(driver.state.appState.contextUsage).toBeCloseTo(0.18);
  });

  it('recomputes contextUsage when a status update carries maxContextTokens without it', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.contextTokens = 180_000;
    driver.state.appState.maxContextTokens = 256_000;
    driver.state.appState.contextUsage = 180_000 / 256_000;

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        maxContextTokens: 1_000_000,
      } as Event,
      mock(),
    );

    expect(driver.state.appState.maxContextTokens).toBe(1_000_000);
    expect(driver.state.appState.contextUsage).toBeCloseTo(0.18);
  });

  it('keeps an explicit contextUsage from status updates instead of recomputing', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.contextTokens = 100;
    driver.state.appState.maxContextTokens = 1_000_000;
    driver.state.appState.contextUsage = 0;

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        contextTokens: 180_000,
        maxContextTokens: 1_000_000,
        contextUsage: 0.42,
      } as Event,
      mock(),
    );

    expect(driver.state.appState.contextUsage).toBe(0.42);
  });

  it('zeroes contextUsage when a recomputation has no known context window', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.contextTokens = 180_000;
    driver.state.appState.maxContextTokens = 0;
    driver.state.appState.contextUsage = 0.74;

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        contextTokens: 190_000,
      } as Event,
      mock(),
    );

    expect(driver.state.appState.contextUsage).toBe(0);
  });

  it('applies the effective thinking effort from status updates', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        model: 'turbo',
        thinkingEffort: 'mid',
      } as Event,
      mock(),
    );

    expect(driver.state.appState.model).toBe('turbo');
    expect(driver.state.appState.thinkingEffort).toBe('mid');
  });

  it('applies tower mode from status updates', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        towerMode: true,
      } as Event,
      mock(),
    );
    expect(driver.state.appState.towerMode).toBe(true);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        towerMode: false,
      } as Event,
      mock(),
    );
    expect(driver.state.appState.towerMode).toBe(false);
  });

  it('renders a marker when tower mode exits because a goal was activated', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        towerMode: true,
      } as Event,
      mock(),
    );
    expect(driver.state.appState.towerMode).toBe(true);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        towerMode: false,
        towerExitReason: 'mode-mutex',
      } as Event,
      mock(),
    );

    expect(driver.state.appState.towerMode).toBe(false);
    const transcript = stripSgr(renderTranscript(driver));
    expect(countOccurrences(transcript, 'Tower mode ended — a goal was activated')).toBe(1);
  });

  it('does not render the goal-exit marker for a reasonless tower exit', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        towerMode: true,
      } as Event,
      mock(),
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        towerMode: false,
      } as Event,
      mock(),
    );

    expect(driver.state.appState.towerMode).toBe(false);
    expect(stripSgr(renderTranscript(driver))).not.toContain('Tower mode ended');
  });

  it('renders swarm mode markers from /swarm commands, not tool-triggered status updates', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        swarmMode: true,
      } as Event,
      mock(),
    );

    expect(driver.state.appState.swarmMode).toBe(true);
    expect(stripSgr(renderTranscript(driver))).not.toContain('Swarm activated');

    let transcript = stripSgr(renderTranscript(driver));
    expect(countOccurrences(transcript, 'Swarm activated')).toBe(0);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        swarmMode: false,
      } as Event,
      mock(),
    );

    expect(driver.state.appState.swarmMode).toBe(false);
    transcript = stripSgr(renderTranscript(driver));
    expect(transcript).not.toContain('Swarm deactivated');
    expect(transcript).not.toContain('Swarm ended');

    expect(countOccurrences(transcript, 'Swarm activated')).toBe(0);
    expect(countOccurrences(transcript, 'Swarm deactivated')).toBe(0);
    expect(countOccurrences(transcript, 'Swarm ended')).toBe(0);
  });

  it('syncs permission mode from agent.status.updated events', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.permissionMode = 'manual';

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        permission: 'auto',
      } as Event,
      mock(),
    );

    expect(readPermissionMode(driver)).toBe('auto');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        permission: 'yolo',
      } as Event,
      mock(),
    );

    expect(readPermissionMode(driver)).toBe('yolo');
  });

  it('renders an ended marker when a one-shot /swarm task exits', async () => {
    const { driver, session } = await makeDriver(undefined);
    driver.state.appState.permissionMode = 'auto';

    driver.handleUserInput('/swarm Ship feature X');

    await waitForAssertion(() => {
      expect(session.setSwarmMode).toHaveBeenCalledWith(true, 'task');
    });
    await waitForAssertion(() => {
      expect(countOccurrences(stripSgr(renderTranscript(driver)), 'Swarm activated')).toBe(1);
    });
    let transcript = stripSgr(renderTranscript(driver));
    expect(countOccurrences(transcript, 'Swarm activated')).toBe(1);
    expect(transcript).not.toContain('Swarm ended');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        sessionId: 'ses-1',
        swarmMode: false,
      } as Event,
      mock(),
    );

    expect(driver.state.appState.swarmMode).toBe(false);
    transcript = stripSgr(renderTranscript(driver));
    expect(countOccurrences(transcript, 'Swarm activated')).toBe(1);
    expect(countOccurrences(transcript, 'Swarm ended')).toBe(1);
    expect(transcript).not.toContain('Swarm deactivated');
  });

  it('queues Ctrl-S input instead of steering while /init is running', async () => {
    let resolveInit: (() => void) | undefined;
    const session = makeSession({
      init: mock(
        () =>
          new Promise<void>((resolve) => {
            resolveInit = resolve;
          }),
      ),
    });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/init');
    await waitForAssertion(() => {
      expect(session.init).toHaveBeenCalledTimes(1);
    });

    driver.state.editor.setText('apply after init');
    driver.state.editor.onCtrlS?.();

    expect(session.steer).not.toHaveBeenCalled();
    await waitForAssertion(() => {
      expect(driver.state.queuedMessages).toEqual([{ text: 'apply after init', agentId: 'main' }]);
    });
    expect(stripSgr(driver.state.queueContainer.render(120).join('\n'))).not.toContain(
      'ctrl-s to steer immediately',
    );

    resolveInit?.();

    await waitForAssertion(() => {
      expect(session.prompt).toHaveBeenCalledWith('apply after init', { promptId: undefined });
    });
    expect(driver.state.queuedMessages).toEqual([]);
  });

  it('cancels the active /init request through the session', async () => {
    let resolveInit: (() => void) | undefined;
    const session = makeSession({
      init: mock(
        () =>
          new Promise<void>((resolve) => {
            resolveInit = resolve;
          }),
      ),
    });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/init');
    await waitForAssertion(() => {
      expect(session.init).toHaveBeenCalledTimes(1);
    });

    driver.state.editor.onEscape?.();

    await waitForAssertion(() => {
      expect(session.cancel).toHaveBeenCalledTimes(1);
    });

    resolveInit?.();
  });

  it('does not run /init when no model is selected', async () => {
    const { driver, session } = await makeDriver();
    driver.state.appState.model = '';

    driver.handleUserInput('/init');

    expect(session.init).not.toHaveBeenCalled();
    expect(driver.state.transcriptContainer.render(120).join('\n')).toContain('LLM not set');
  });

  it('shows the login prompt for auth.login_required session errors', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'error',
        agentId: 'main',
        sessionId: 'ses-1',
        code: 'auth.login_required',
        message: 'OAuth provider credentials were rejected.',
        retryable: false,
      } as Event,
      mock(),
    );

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('OAuth login expired. Send /login to login.');
    expect(transcript).not.toContain('[auth.login_required]');
    expect(transcript).not.toContain('/export-debug-zip');
  });

  it('shows a programmatic abort reason instead of reporting a user interruption', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.step.interrupted',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        step: 1,
        reason: 'aborted',
        message: 'Tool execution timed out',
      } as Event,
      mock(),
    );

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Error: Tool execution timed out');
    expect(transcript).not.toContain('Interrupted by user');
  });

  it('keeps unmessaged aborted events compatible with user interruptions', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.step.interrupted',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        step: 1,
        reason: 'aborted',
      } as Event,
      mock(),
    );

    expect(stripSgr(renderTranscript(driver))).toContain('Interrupted by user');
  });

  it('appends the /export-debug-zip hint beneath session error messages', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'error',
        agentId: 'main',
        sessionId: 'ses-1',
        code: 'compaction.failed',
        message:
          "APIStatusError: 400 the message at position 82 with role 'assistant' must not be empty",
        retryable: false,
      } as Event,
      mock(),
    );

    const transcript = stripSgr(driver.state.transcriptContainer.render(200).join('\n'));
    expect(transcript).toContain('Error: [compaction.failed]');
    expect(transcript).toContain('If this persists, run `/export-debug-zip`');
    expect(transcript).toContain("Please don't share it publicly");
    expect(transcript).not.toContain('kimi export');
  });

  it('shows concise provider filter text for filtered session errors', async () => {
    const { driver } = await makeDriver();
    const verboseMessage =
      'The API returned a response containing only thinking content without any text or tool calls. ' +
      'This usually indicates the stream was interrupted or the output token budget was exhausted ' +
      'during reasoning. Provider stop details: finishReason=filtered, rawFinishReason=content_filter. ' +
      'The provider filtered the response before visible output was emitted. Provider: example-provider, model: example-model';

    driver.sessionEventHandler.handleEvent(
      {
        type: 'error',
        agentId: 'main',
        sessionId: 'ses-1',
        code: 'provider.api_error',
        message: verboseMessage,
        details: {
          finishReason: 'filtered',
          rawFinishReason: 'content_filter',
        },
        retryable: true,
      } as Event,
      mock(),
    );

    const transcript = stripSgr(driver.state.transcriptContainer.render(200).join('\n'));
    expect(transcript).toContain(
      'Error: [provider.api_error] Provider filtered the response before visible output',
    );
    expect(transcript).toContain('finishReason=filtered');
    expect(transcript).toContain('rawFinishReason=content_filter');
    expect(transcript).not.toContain('only thinking content');
    expect(transcript).not.toContain('token budget');
    expect(transcript).not.toContain('stream was interrupted');
  });

  it('skips the /export-debug-zip hint when no active session id is set', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.sessionId = '';

    driver.sessionEventHandler.handleEvent(
      {
        type: 'error',
        agentId: 'main',
        sessionId: '',
        code: 'compaction.failed',
        message: 'boom',
        retryable: false,
      } as Event,
      mock(),
    );

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Error: [compaction.failed]');
    expect(transcript).not.toContain('/export-debug-zip');
  });

  it('shows ExitPlanMode plan only in the current-plan card during approval', async () => {
    const planContent = '# No Duplicate Plan\n\n- Do the non-duplicated plan work';
    const session = makeSession({
      getPlan: mock(async () => ({
        id: 'no-duplicate-plan',
        content: planContent,
        path: '/tmp/no-duplicate-plan.md',
      })),
    });
    const { driver } = await makeDriver(session);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_exit_plan',
        name: 'ExitPlanMode',
        args: {},
      } as Event,
      mock(),
    );

    await waitForAssertion(() => {
      const transcript = stripSgr(renderTranscript(driver));
      expect(transcript).toContain('Current plan');
      expect(countOccurrences(transcript, 'non-duplicated plan work')).toBe(1);
    });

    const approvalHandler = session.setApprovalHandler.mock.calls[0]?.[0] as
      | ((request: ApprovalRequest) => Promise<ApprovalResponse>)
      | undefined;
    if (approvalHandler === undefined) throw new Error('expected approval handler');
    void approvalHandler({
      turnId: 1,
      toolCallId: 'call_exit_plan',
      toolName: 'ExitPlanMode',
      action: 'Review plan',
      display: {
        kind: 'plan_review',
        plan: planContent,
        path: '/tmp/no-duplicate-plan.md',
      },
    });

    await waitForAssertion(() => {
      // The approval is a region of the status strip now, so the rendered
      // prompt lives there rather than in the editor's slot.
      const approval = stripSgr(driver.state.statusSurface.render(120).join('\n'));
      expect(approval).toContain('Ready to build with this plan?');
      expect(approval).not.toContain('non-duplicated plan work');
      expect(approval).not.toContain('/tmp/no-duplicate-plan.md');
    });
  });

  it('renders AgentSwarm progress in the transcript instead of the tool-card body', async () => {
    const { driver } = await makeDriver();
    const sendQueued = mock();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_swarm',
        name: 'AgentSwarm',
        args: {
          description: 'Review changed files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts'],
        },
      } as Event,
      sendQueued,
    );

    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.spawned',
        agentId: 'main',
        sessionId: 'ses-1',
        parentToolCallId: 'call_swarm',
        subagentId: 'agent-1',
        subagentName: 'coder',
        description: 'Review changed files #1 (coder)',
        swarmIndex: 1,
        runInBackground: false,
      } as Event,
      sendQueued,
    );

    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.spawned',
        agentId: 'main',
        sessionId: 'ses-1',
        parentToolCallId: 'call_swarm',
        subagentId: 'agent-2',
        subagentName: 'coder',
        description: 'Review changed files #2 (coder)',
        swarmIndex: 2,
        runInBackground: false,
      } as Event,
      sendQueued,
    );

    requestRenderSpy(driver).mockClear();
    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'agent-1',
        sessionId: 'ses-1',
        turnId: 2,
        toolCallId: 'call_read',
        name: 'Read',
        args: { path: 'src/a.ts' },
      } as Event,
      sendQueued,
    );
    // Swarm child events are batched onto the swarm's own frame timer instead
    // of rendering the whole tree per event.
    expect(driver.state.ui.requestRender).not.toHaveBeenCalled();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'agent-1',
        sessionId: 'ses-1',
        turnId: 2,
        delta: 'Reviewing src/a.ts and checking imports for regressions in detail',
      } as Event,
      sendQueued,
    );
    let transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('01 [');
    expect(transcript).toContain('Reviewing src/a.ts');

    requestRenderSpy(driver).mockClear();
    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.suspended',
        agentId: 'main',
        sessionId: 'ses-1',
        subagentId: 'agent-1',
        reason: 'Provider rate limit; subagent requeued for retry.',
      } as Event,
      sendQueued,
    );
    expect(driver.state.ui.requestRender).toHaveBeenCalled();

    transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('001 [');
    expect(transcript).toContain('Queued…');
    expect(transcript).not.toContain('Provider rate limit');
    expect(transcript).not.toContain('Failed');

    requestRenderSpy(driver).mockClear();
    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.started',
        agentId: 'main',
        sessionId: 'ses-1',
        subagentId: 'agent-1',
      } as Event,
      sendQueued,
    );
    expect(driver.state.ui.requestRender).toHaveBeenCalled();

    transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('01 [');
    expect(transcript).not.toContain('Suspended');

    requestRenderSpy(driver).mockClear();
    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'agent-1',
        sessionId: 'ses-1',
        turnId: 2,
        reason: 'completed',
      } as Event,
      sendQueued,
    );
    // A child turn end changes no swarm state, so it stays on the batched
    // frame timer like the deltas above.
    expect(driver.state.ui.requestRender).not.toHaveBeenCalled();

    transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Agent Swarm');
    expect(transcript).toContain('Review changed files');
    expect(transcript).toContain('001 [');
    expect(transcript).toContain('Reviewing src/a.ts');
    expect(transcript).not.toContain('Completed');
    expect(transcript).toContain('002 Queued…');
    expect(transcript).not.toContain('002 [');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.completed',
        agentId: 'main',
        sessionId: 'ses-1',
        subagentId: 'agent-1',
        resultSummary: 'Imports are stable',
      } as Event,
      sendQueued,
    );

    transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('✓ Imports are stable');
    expect(transcript).not.toContain('Completed');
  });

  it('marks only core user-cancellation subagent failures as cancelled', async () => {
    const { driver } = await makeDriver();
    const sendQueued = mock();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_swarm',
        name: 'AgentSwarm',
        args: {
          description: 'Review changed files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts'],
        },
      } as Event,
      sendQueued,
    );

    for (const [index, subagentId] of ['agent-1', 'agent-2'].entries()) {
      driver.sessionEventHandler.handleEvent(
        {
          type: 'subagent.spawned',
          agentId: 'main',
          sessionId: 'ses-1',
          parentToolCallId: 'call_swarm',
          subagentId,
          subagentName: 'coder',
          description: `Review changed files #${String(index + 1)} (coder)`,
          swarmIndex: index + 1,
          runInBackground: false,
        } as Event,
        sendQueued,
      );
    }

    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.failed',
        agentId: 'main',
        sessionId: 'ses-1',
        subagentId: 'agent-1',
        error: 'Aborted by the user',
      } as Event,
      sendQueued,
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.failed',
        agentId: 'main',
        sessionId: 'ses-1',
        subagentId: 'agent-2',
        error: 'The user manually interrupted this subagent x.',
      } as Event,
      sendQueued,
    );

    const transcript = stripSgr(driver.state.transcriptContainer.render(200).join('\n'));
    expect(transcript).toContain('⊘ Cancelled.');
    expect(transcript).toContain('✗ The user manually interrupted this subagent x.');
  });

  it('shows the spawned model on the subagent card at spawn, mapped through the model catalog', async () => {
    const { driver } = await makeDriver();
    const sendQueued = mock();
    driver.state.appState.availableModels = {
      'k2-cheap': {
        provider: 'managed:kimi-code',
        model: 'kimi-k2-cheap',
        maxContextSize: 100_000,
        displayName: 'Kimi K2 Cheap',
        capabilities: [],
      },
    };

    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.spawned',
        agentId: 'main',
        sessionId: 'ses-1',
        parentToolCallId: 'call_agent',
        subagentId: 'agent-1',
        subagentName: 'explore',
        description: 'explore project',
        runInBackground: false,
        model: 'k2-cheap',
      } as Event,
      sendQueued,
    );

    expect(stripSgr(renderTranscript(driver))).toContain('Kimi K2 Cheap');
  });

  it('falls back to the raw alias when the spawned model is missing from the catalog', async () => {
    const { driver } = await makeDriver();
    const sendQueued = mock();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.spawned',
        agentId: 'main',
        sessionId: 'ses-1',
        parentToolCallId: 'call_agent',
        subagentId: 'agent-1',
        subagentName: 'explore',
        description: 'explore project',
        runInBackground: false,
        model: 'k2-cheap',
      } as Event,
      sendQueued,
    );

    expect(stripSgr(renderTranscript(driver))).toContain('k2-cheap');
  });

  it('shows any concrete spawned effort, same as the session or not', async () => {
    const { driver } = await makeDriver();
    const sendQueued = mock();
    driver.state.appState.thinkingEffort = 'high';

    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.spawned',
        agentId: 'main',
        sessionId: 'ses-1',
        parentToolCallId: 'call_agent',
        subagentId: 'agent-1',
        subagentName: 'explore',
        description: 'explore project',
        runInBackground: false,
        model: 'k2-cheap',
        thinkingEffort: 'high',
      } as Event,
      sendQueued,
    );
    expect(stripSgr(renderTranscript(driver))).toContain('· high');
  });

  it('hides the boolean effort states on and off', async () => {
    const { driver } = await makeDriver();
    const sendQueued = mock();

    for (const effort of ['on', 'off']) {
      driver.sessionEventHandler.handleEvent(
        {
          type: 'subagent.spawned',
          agentId: 'main',
          sessionId: 'ses-1',
          parentToolCallId: `call_agent_${effort}`,
          subagentId: `agent-${effort}`,
          subagentName: 'explore',
          description: `explore ${effort}`,
          runInBackground: false,
          model: 'k2-cheap',
          thinkingEffort: effort,
        } as Event,
        sendQueued,
      );
    }

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).not.toContain('· on');
    expect(transcript).not.toContain('· off');
  });

  it('keeps the child status update as the model fallback when spawned omits it', async () => {
    const { driver } = await makeDriver();
    const sendQueued = mock();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.spawned',
        agentId: 'main',
        sessionId: 'ses-1',
        parentToolCallId: 'call_agent',
        subagentId: 'agent-1',
        subagentName: 'explore',
        description: 'explore project',
        runInBackground: false,
      } as Event,
      sendQueued,
    );
    expect(stripSgr(renderTranscript(driver))).not.toContain('k2-cheap');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'agent-1',
        sessionId: 'ses-1',
        model: 'k2-cheap',
      } as Event,
      sendQueued,
    );
    expect(stripSgr(renderTranscript(driver))).toContain('k2-cheap');
  });

  it('shows the spawned model in the swarm panel header at spawn', async () => {
    const { driver } = await makeDriver();
    const sendQueued = mock();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_swarm',
        name: 'AgentSwarm',
        args: {
          description: 'Review changed files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts'],
        },
      } as Event,
      sendQueued,
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.spawned',
        agentId: 'main',
        sessionId: 'ses-1',
        parentToolCallId: 'call_swarm',
        subagentId: 'agent-1',
        subagentName: 'coder',
        description: 'Review changed files #1 (coder)',
        swarmIndex: 1,
        runInBackground: false,
        model: 'k2-cheap',
      } as Event,
      sendQueued,
    );

    const progress = driver.state.transcriptContainer.children.find(
      (child): child is AgentSwarmProgressComponent => child instanceof AgentSwarmProgressComponent,
    );
    if (progress === undefined) throw new Error('expected AgentSwarm progress');
    expect(stripSgr(progress.render(118).join('\n'))).toContain('k2-cheap');
  });

  it('includes the spawned model in the background-agent transcript entry', async () => {
    const { driver } = await makeDriver();
    const sendQueued = mock();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.spawned',
        agentId: 'main',
        sessionId: 'ses-1',
        parentToolCallId: 'call_agent',
        subagentId: 'agent-1',
        subagentName: 'explore',
        description: 'explore project',
        runInBackground: true,
        model: 'k2-cheap',
      } as Event,
      sendQueued,
    );

    expect(stripSgr(renderTranscript(driver))).toContain('k2-cheap');
  });

  it('does not let later transcript entries reduce the AgentSwarm grid height', async () => {
    const { driver } = await makeDriver();
    const sendQueued = mock();
    const terminalColumns = 80;
    setTerminalColumns(driver, terminalColumns);
    const outerChildren = driver.state.ui.children;
    const transcriptIndex = outerChildren.indexOf(driver.state.transcriptContainer);
    const rowsAfterTranscript = outerChildren
      .slice(transcriptIndex + 1)
      .reduce((sum, child) => sum + child.render(terminalColumns).length, 0);
    const nonGridRows = 20 - (agentSwarmGridHeightForTerminalRows(20) ?? 0);
    setTerminalRows(driver, rowsAfterTranscript + nonGridRows + 2);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_swarm',
        name: 'AgentSwarm',
        args: {
          description: 'Review changed files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
        },
      } as Event,
      sendQueued,
    );

    const swarmProgress = driver.state.transcriptContainer.children.find(
      (child): child is AgentSwarmProgressComponent => child instanceof AgentSwarmProgressComponent,
    );
    if (swarmProgress === undefined) throw new Error('expected AgentSwarm progress');

    const transcriptWidth = Math.max(1, terminalColumns - 2);
    const renderSwarm = (): string => stripSgr(swarmProgress.render(transcriptWidth).join('\n'));

    expect(renderSwarm()).toContain('001 Queued…');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_read',
        name: 'Read',
        args: { path: 'src/after.ts' },
      } as Event,
      sendQueued,
    );

    const transcriptChildren = driver.state.transcriptContainer.children;
    const swarmIndex = transcriptChildren.indexOf(
      swarmProgress as (typeof transcriptChildren)[number],
    );
    expect(swarmIndex).toBeGreaterThanOrEqual(0);

    const rowsAfterSwarmInTranscript = transcriptChildren
      .slice(swarmIndex + 1)
      .reduce((sum, child) => sum + child.render(transcriptWidth).length, 0);
    expect(rowsAfterSwarmInTranscript).toBeGreaterThan(0);

    expect(renderSwarm()).toContain('001 Queued…');
    const transcript = stripSgr(
      driver.state.transcriptContainer.render(terminalColumns).join('\n'),
    );
    expect(transcript).toContain('Using Read (src/after.ts)');
  });

  it('shows AgentSwarm as completed when only some subagents fail', async () => {
    const { driver } = await makeDriver();
    const sendQueued = mock();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_swarm',
        name: 'AgentSwarm',
        args: {
          description: 'Review changed files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts'],
        },
      } as Event,
      sendQueued,
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.result',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_swarm',
        output: [
          '<agent_swarm_result>',
          '<summary>completed: 1, failed: 1</summary>',
          '<subagent index="1" agent_id="agent-1" outcome="completed">Imports are stable.</subagent>',
          '<subagent index="2" agent_id="agent-2" outcome="failed">Agent timed out after 30s.</subagent>',
          '</agent_swarm_result>',
        ].join('\n'),
        isError: undefined,
      } as Event,
      sendQueued,
    );

    const transcript = stripSgr(renderTranscript(driver));
    const totalStatusLine = transcript.split('\n').find((line) => line.includes('Completed.'));
    expect(totalStatusLine).toBeDefined();
    expect(totalStatusLine).not.toContain('Failed.');
    expect(transcript).toContain('✓ Imports are stable.');
    expect(transcript).toContain('✗ Agent timed out after 30s.');
  });

  it('renders AgentSwarm progress while tool args are still streaming', async () => {
    const { driver } = await makeDriver();
    const sendQueued = mock();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_swarm',
        name: 'AgentSwarm',
        argumentsPart: '{"description":"Review changed files',
      } as Event,
      sendQueued,
    );

    let transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Agent Swarm');
    expect(transcript).toContain('Orchestrating…');
    expect(transcript).not.toContain('01');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_swarm',
        argumentsPart: '","items":["src/a.ts","src/b',
      } as Event,
      sendQueued,
    );

    transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('Agent Swarm');
    expect(transcript).toContain('Review changed files');
    expect(transcript).toContain('001 src/a.ts');
    expect(transcript).toContain('002 src/b');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'subagent.spawned',
        agentId: 'main',
        sessionId: 'ses-1',
        parentToolCallId: 'call_swarm',
        subagentId: 'agent-1',
        subagentName: 'coder',
        description: 'Review changed files #1 (coder)',
        swarmIndex: 1,
        runInBackground: false,
      } as Event,
      sendQueued,
    );

    transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('001 Queued…');
    expect(transcript).not.toContain('001 [');
    expect(transcript).toContain('002 src/b');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_swarm',
        name: 'AgentSwarm',
        args: {
          description: 'Review changed files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts'],
        },
      } as Event,
      sendQueued,
    );

    transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('001 Queued…');
    expect(transcript).toContain('002 Queued…');
    expect(transcript).not.toContain('001 [');
    expect(transcript).not.toContain('002 [');
  });

  it('shows plan review reject on the plan card without an approval notice', async () => {
    const planContent = '# Reject Plan\n\n- keep this plan visible after reject';
    const session = makeSession({
      getPlan: mock(async () => ({
        id: 'reject-plan',
        content: planContent,
        path: '/tmp/reject-plan.md',
      })),
    });
    const { driver } = await makeDriver(session);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_exit_reject_plan',
        name: 'ExitPlanMode',
        args: {},
      } as Event,
      mock(),
    );

    await waitForAssertion(() => {
      const transcript = stripSgr(renderTranscript(driver));
      expect(transcript).toContain('Reject Plan');
      expect(countOccurrences(transcript, 'keep this plan visible after reject')).toBe(1);
    });

    const approvalHandler = session.setApprovalHandler.mock.calls[0]?.[0] as
      | ((request: ApprovalRequest) => Promise<ApprovalResponse>)
      | undefined;
    if (approvalHandler === undefined) throw new Error('expected approval handler');
    const response = approvalHandler({
      turnId: 1,
      toolCallId: 'call_exit_reject_plan',
      toolName: 'ExitPlanMode',
      action: 'Review plan',
      display: {
        kind: 'plan_review',
        plan: planContent,
        path: '/tmp/reject-plan.md',
      },
    });

    await waitForAssertion(() => {
      expect(driver.state.approvalRegion.panelComponent()).toBeInstanceOf(ApprovalPanelComponent);
    });
    driver.state.approvalRegion.panelComponent()!.handleInput('2');
    await expect(response).resolves.toMatchObject({ decision: 'rejected' });

    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.result',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId: 'call_exit_reject_plan',
        output: 'Plan rejected by user. Plan mode remains active.',
        isError: true,
      } as Event,
      mock(),
    );

    await waitForAssertion(() => {
      const transcript = stripSgr(renderTranscript(driver));
      expect(transcript).toContain('plan: reject-plan.md · Rejected');
      expect(transcript).toContain('Reject Plan');
      expect(countOccurrences(transcript, 'keep this plan visible after reject')).toBe(1);
      expect(transcript).not.toContain('Rejected: Review plan');
      expect(transcript).not.toContain('Plan rejected by user.');
      expect(transcript).not.toContain('Plan mode remains active.');
    });
  });

  it('renders /status using the active session runtime status', async () => {
    const session = makeSession({
      getStatus: mock(async () => ({
        model: 'k2',
        thinkingEffort: 'high',
        permission: 'auto',
        planMode: true,
        contextTokens: 25,
        maxContextTokens: 100,
        contextUsage: 0.25,
      })),
    });
    const { driver } = await makeDriver(session);
    const getStatus = session.getStatus;
    const previousStatusCalls = getStatus.mock.calls.length;

    driver.handleUserInput('/status');

    await waitForAssertion(() => {
      expect(getStatus).toHaveBeenCalledTimes(previousStatusCalls + 1);
      const output = stripSgr(driver.state.transcriptContainer.render(120).join('\n'));
      expect(output).toContain(' Status ');
      expect(output).toContain('>_ Kimi Code');
      expect(output).toContain('Model');
      expect(output).toContain('thinking high');
      expect(output).toContain('Permissions  Never Ask');
      expect(output).toContain('Plan mode    on');
      expect(output).toContain('Context window');
      expect(output).toContain('25%');
    });
  });

  it('renders /mcp using a fresh MCP server snapshot', async () => {
    const session = makeSession({
      listMcpServers: mock(async () => [
        {
          name: 'local-tools',
          transport: 'stdio',
          status: 'connected',
          toolCount: 2,
        },
        {
          name: 'remote-tools',
          transport: 'http',
          status: 'failed',
          toolCount: 0,
          error: 'connection refused',
        },
        {
          name: 'linear',
          transport: 'http',
          status: 'needs-auth',
          toolCount: 0,
        },
        {
          name: 'disabled-tools',
          transport: 'stdio',
          status: 'disabled',
          toolCount: 0,
        },
      ]),
    });
    const { driver } = await makeDriver(session);
    const listMcpServers = session.listMcpServers;
    const previousCalls = listMcpServers.mock.calls.length;

    driver.handleUserInput('/mcp');

    await waitForAssertion(() => {
      expect(listMcpServers).toHaveBeenCalledTimes(previousCalls + 1);
      const output = stripSgr(driver.state.transcriptContainer.render(140).join('\n'));
      expect(output).toContain(' MCP (4) ');
      expect(output).toContain('Servers');
      expect(output).toContain('local-tools');
      expect(output).toContain('connected');
      expect(output).toContain('stdio');
      expect(output).toContain('2 tools');
      expect(output).toContain('remote-tools');
      expect(output).toContain('failed');
      expect(output).toContain('connection refused');
      expect(output).toContain('linear');
      expect(output).toContain('needs auth');
      expect(output).toContain('/mcp-config login linear');
      expect(output).toContain('disabled-tools');
      expect(output).toContain('disabled');
      expect(output).toContain(
        '1 connected · 1 needs auth · 1 failed · 1 disabled · 2 tools available',
      );
    });
  });

  it('renders an empty /mcp state when no MCP servers are configured', async () => {
    const session = makeSession({
      listMcpServers: mock(async () => []),
    });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/mcp');

    await waitForAssertion(() => {
      const output = stripSgr(driver.state.transcriptContainer.render(120).join('\n'));
      expect(output).toContain('No MCP servers configured. Run /mcp-config to add one.');
    });
  });

  it('renders /mcp list failures as command boundary errors', async () => {
    const session = makeSession({
      listMcpServers: mock(async () => {
        throw new Error('rpc unavailable');
      }),
    });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/mcp');

    await waitForAssertion(() => {
      const output = stripSgr(driver.state.transcriptContainer.render(120).join('\n'));
      expect(output).toContain('Error: Failed to load MCP servers: rpc unavailable');
    });
  });

  it('toggles plugin MCP servers from the text command', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins mcp enable kimi-datasource data');

    await waitForAssertion(() => {
      expect(session.setPluginMcpServerEnabled).toHaveBeenCalledWith(
        'kimi-datasource',
        'data',
        true,
      );
    });
  });

  it('errors when /plugins install has no argument', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins install');

    await waitForAssertion(() => {
      expect(stripSgr(renderTranscript(driver))).toContain(
        'Usage: /plugins install <local-path-or-zip-url>',
      );
    });
    expect(session.installPlugin).not.toHaveBeenCalled();
  });

  it('installs from a positional source on /plugins install after trusting it', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins install ./plugins/kimi-datasource');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(
        PluginInstallTrustConfirmComponent,
      );
    });
    const confirm = driver.state.editorContainer.children[0] as PluginInstallTrustConfirmComponent;
    confirm.handleInput('\u001B[B'); // switch from "Exit" to "Trust and install"
    confirm.handleInput('\r');

    await waitForAssertion(() => {
      expect(session.installPlugin).toHaveBeenCalledWith(
        resolve('/tmp/proj-a', './plugins/kimi-datasource'),
      );
    });
  });

  it('shows a quota note after installing a quota-consuming official plugin', async () => {
    const session = makeSession({
      installPlugin: mock(async () => ({
        id: 'kimi-datasource',
        displayName: 'Kimi Datasource',
        version: '3.3.0',
        enabled: true,
        state: 'ok',
        skillCount: 0,
        mcpServerCount: 1,
        enabledMcpServerCount: 1,
        hasErrors: false,
        source: 'zip-url',
        originalSource: 'https://code.kimi.com/kimi-code/plugins/official/kimi-datasource.zip',
      })),
    });
    const { driver } = await makeDriver(session);

    driver.handleUserInput(
      '/plugins install https://code.kimi.com/kimi-code/plugins/official/kimi-datasource.zip',
    );

    await waitForAssertion(() => {
      const transcript = stripSgr(renderTranscript(driver));
      expect(transcript).toContain('Run /new or /reload to apply plugin changes.');
      expect(transcript).toContain('Note: This plugin consumes your quota.');
    });
  });

  it('does not show the quota note for a same-id fork installed from a local path', async () => {
    const session = makeSession({
      installPlugin: mock(async () => ({
        id: 'kimi-datasource',
        displayName: 'Kimi Datasource',
        version: '3.3.0',
        enabled: true,
        state: 'ok',
        skillCount: 0,
        mcpServerCount: 1,
        enabledMcpServerCount: 1,
        hasErrors: false,
        source: 'local-path',
      })),
    });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins install ./plugins/kimi-datasource-fork');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(
        PluginInstallTrustConfirmComponent,
      );
    });
    const confirm = driver.state.editorContainer.children[0] as PluginInstallTrustConfirmComponent;
    confirm.handleInput('\u001B[B'); // switch from "Exit" to "Trust and install"
    confirm.handleInput('\r');

    await waitForAssertion(() => {
      const transcript = stripSgr(renderTranscript(driver));
      expect(transcript).toContain('Installed Kimi Datasource');
    });
    expect(stripSgr(renderTranscript(driver))).not.toContain(
      'Note: This plugin consumes your quota.',
    );
  });

  it('does not install when the third-party trust prompt is dismissed', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins install ./plugins/kimi-datasource');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(
        PluginInstallTrustConfirmComponent,
      );
    });
    const confirm = driver.state.editorContainer.children[0] as PluginInstallTrustConfirmComponent;
    confirm.handleInput('\r'); // default option is "Exit"

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBe(driver.state.editor);
    });
    expect(session.installPlugin).not.toHaveBeenCalled();
  });

  it('loads a local plugin marketplace file and installs from it', async () => {
    const marketplaceDir = await makeTempHome();
    const marketplacePath = join(marketplaceDir, 'marketplace.json');
    await writeFile(
      marketplacePath,
      JSON.stringify({
        plugins: [
          {
            id: 'kimi-datasource',
            tier: 'official',
            displayName: 'Kimi Datasource',
            description: 'Datasource plugin',
            source: 'https://code.kimi.com/kimi-code/plugins/official/kimi-datasource.zip',
          },
        ],
      }),
      'utf8',
    );
    process.env['KIMI_CODE_PLUGIN_MARKETPLACE_URL'] = marketplacePath;
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins marketplace');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginsPanelComponent);
    });
    const panel = driver.state.editorContainer.children[0] as PluginsPanelComponent;
    await waitForAssertion(() => {
      expect(stripSgr(panel.render(120).join('\n'))).toContain('Kimi Datasource');
    });
    panel.handleInput('\u001B[B');
    panel.handleInput('\r');

    await waitForAssertion(() => {
      expect(session.installPlugin).toHaveBeenCalledWith(
        'https://code.kimi.com/kimi-code/plugins/official/kimi-datasource.zip',
      );
    });
    await waitForAssertion(() => {
      const transcript = stripSgr(renderTranscript(driver));
      expect(transcript).toContain('Installed Demo');
      expect(transcript).toContain('Run /new or /reload to apply plugin changes.');
      expect(transcript).not.toContain('Note: This plugin consumes your quota.');
    });
    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBe(driver.state.editor);
    });
  });

  it('returns to the plugin list when a marketplace install fails', async () => {
    const marketplaceDir = await makeTempHome();
    const marketplacePath = join(marketplaceDir, 'marketplace.json');
    await writeFile(
      marketplacePath,
      JSON.stringify({
        plugins: [
          {
            id: 'kimi-datasource',
            tier: 'official',
            displayName: 'Kimi Datasource',
            source: 'https://code.kimi.com/kimi-code/plugins/official/kimi-datasource.zip',
          },
        ],
      }),
      'utf8',
    );
    process.env['KIMI_CODE_PLUGIN_MARKETPLACE_URL'] = marketplacePath;
    const installPlugin = mock(async () => {
      throw new Error('install failed');
    });
    const session = makeSession({ installPlugin });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins marketplace');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginsPanelComponent);
    });
    const panel = driver.state.editorContainer.children[0] as PluginsPanelComponent;
    await waitForAssertion(() => {
      expect(stripSgr(panel.render(120).join('\n'))).toContain('Kimi Datasource');
    });
    panel.handleInput('\r');

    await waitForAssertion(() => {
      const rendered = stripSgr(panel.render(120).join('\n'));
      expect(rendered).toContain('Kimi Datasource');
      expect(rendered).not.toContain('Installing');
    });
  });

  it('prompts for trust before installing a third-party marketplace entry', async () => {
    const marketplaceDir = await makeTempHome();
    const marketplacePath = join(marketplaceDir, 'marketplace.json');
    await writeFile(
      marketplacePath,
      JSON.stringify({
        plugins: [
          {
            id: 'superpowers',
            tier: 'curated',
            displayName: 'Superpowers',
            description: 'Curated plugin',
            source: './superpowers',
          },
        ],
      }),
      'utf8',
    );
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput(`/plugins marketplace ${marketplacePath}`);

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginsPanelComponent);
    });
    const panel = driver.state.editorContainer.children[0] as PluginsPanelComponent;
    await waitForAssertion(() => {
      expect(stripSgr(panel.render(120).join('\n'))).toContain('Superpowers');
    });
    panel.handleInput('\r');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(
        PluginInstallTrustConfirmComponent,
      );
    });
    const confirm = driver.state.editorContainer.children[0] as PluginInstallTrustConfirmComponent;
    confirm.handleInput('\u001B[B'); // switch from "Exit" to "Trust and install"
    confirm.handleInput('\r');

    await waitForAssertion(() => {
      expect(session.installPlugin).toHaveBeenCalledWith(join(marketplaceDir, 'superpowers'));
    });
  });

  it('restores the panel when a third-party marketplace install fails', async () => {
    const marketplaceDir = await makeTempHome();
    const marketplacePath = join(marketplaceDir, 'marketplace.json');
    await writeFile(
      marketplacePath,
      JSON.stringify({
        plugins: [
          {
            id: 'superpowers',
            tier: 'curated',
            displayName: 'Superpowers',
            source: './superpowers',
          },
        ],
      }),
      'utf8',
    );
    const installPlugin = mock(async () => {
      throw new Error('install failed');
    });
    const session = makeSession({ installPlugin });
    const { driver } = await makeDriver(session);

    driver.handleUserInput(`/plugins marketplace ${marketplacePath}`);

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginsPanelComponent);
    });
    const panel = driver.state.editorContainer.children[0] as PluginsPanelComponent;
    await waitForAssertion(() => {
      expect(stripSgr(panel.render(120).join('\n'))).toContain('Superpowers');
    });
    panel.handleInput('\r');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(
        PluginInstallTrustConfirmComponent,
      );
    });
    const confirm = driver.state.editorContainer.children[0] as PluginInstallTrustConfirmComponent;
    confirm.handleInput('\u001B[B'); // switch from "Exit" to "Trust and install"
    confirm.handleInput('\r');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBe(panel);
    });
  });

  it('removes a plugin record without auto-running any cleanup skill', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins remove kimi-webbridge');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginRemoveConfirmComponent);
    });
    const confirm = driver.state.editorContainer.children[0] as PluginRemoveConfirmComponent;
    confirm.handleInput('\u001B[B');
    confirm.handleInput('\r');

    await waitForAssertion(() => {
      expect(session.removePlugin).toHaveBeenCalledWith('kimi-webbridge');
    });
    expect(session.activateSkill).not.toHaveBeenCalled();
  });

  it('installs default marketplace entries through plain install', async () => {
    const originalFetch = globalThis.fetch;
    setGlobal(
      'fetch',
      mock(
        async () =>
          new Response(
            JSON.stringify({
              plugins: [
                {
                  id: 'kimi-datasource',
                  tier: 'official',
                  displayName: 'Kimi Datasource',
                  description: 'Datasource plugin',
                  source: './official/kimi-datasource.zip',
                },
              ],
            }),
          ),
      ),
    );
    const session = makeSession();
    const { driver } = await makeDriver(session);

    try {
      driver.handleUserInput('/plugins marketplace');

      await waitForAssertion(() => {
        expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginsPanelComponent);
      });
      const panel = driver.state.editorContainer.children[0] as PluginsPanelComponent;
      await waitForAssertion(() => {
        expect(stripSgr(panel.render(120).join('\n'))).toContain('Kimi Datasource');
      });
      panel.handleInput('\u001B[B');
      panel.handleInput('\r');

      await waitForAssertion(() => {
        expect(session.installPlugin).toHaveBeenCalledWith(
          'https://code.kimi.com/kimi-code/plugins/official/kimi-datasource.zip',
        );
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(kimiCodePluginMarketplaceUrl());
    } finally {
      setGlobal('fetch', originalFetch);
    }
  });

  it('shows an inline Official error when the marketplace is unreachable, keeping the panel open', async () => {
    const originalFetch = globalThis.fetch;
    process.env['KIMI_CODE_PLUGIN_MARKETPLACE_URL'] = 'https://example.test/marketplace.json';
    setGlobal(
      'fetch',
      mock(async () => {
        throw new Error('fetch failed');
      }),
    );
    const session = makeSession();
    const { driver } = await makeDriver(session);

    try {
      driver.handleUserInput('/plugins');

      await waitForAssertion(() => {
        expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginsPanelComponent);
      });
      const panel = driver.state.editorContainer.children[0] as PluginsPanelComponent;
      panel.handleInput('\t'); // → Official, which lazily (and unsuccessfully) loads

      await waitForAssertion(() => {
        expect(stripSgr(panel.render(120).join('\n'))).toContain(
          'Marketplace unavailable: fetch failed',
        );
      });
      expect(driver.state.editorContainer.children[0]).toBe(panel);
    } finally {
      setGlobal('fetch', originalFetch);
    }
  });

  it('toggles plugins from the Installed tab with space', async () => {
    let enabled = true;
    const session = makeSession({
      listPlugins: mock(async () => [
        {
          id: 'demo',
          displayName: 'Demo',
          version: '1.0.0',
          enabled,
          state: 'ok',
          skillCount: 1,
          mcpServerCount: 0,
          enabledMcpServerCount: 0,
          hasErrors: false,
          source: 'local-path',
        },
      ]),
      setPluginEnabled: mock(async (_id: string, nextEnabled: boolean) => {
        enabled = nextEnabled;
      }),
    });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginsPanelComponent);
    });
    const panel = driver.state.editorContainer.children[0] as PluginsPanelComponent;
    panel.handleInput(' ');

    expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginsPanelComponent);

    await waitForAssertion(() => {
      expect(session.setPluginEnabled).toHaveBeenCalledWith('demo', false);
    });
    await waitForAssertion(() => {
      const refreshed = stripSgr(driver.state.editorContainer.children[0]!.render(120).join('\n'));
      expect(refreshed).toContain('❯ Demo  disabled  run /reload or /new to apply');
    });
    expect(stripSgr(renderTranscript(driver))).not.toContain(
      'Disabled demo. Run /reload or /new to apply.',
    );
  });

  it('toggles plugin MCP servers from the overview MCP picker', async () => {
    const serverEnabled = new Map([
      ['metadata', true],
      ['data', true],
    ]);
    const session = makeSession({
      listPlugins: mock(async () => [
        {
          id: 'kimi-datasource',
          displayName: 'Kimi Datasource',
          version: '1.0.0',
          enabled: true,
          state: 'ok',
          skillCount: 1,
          mcpServerCount: 2,
          enabledMcpServerCount: 2,
          hasErrors: false,
        },
      ]),
      getPluginInfo: mock(async () => ({
        id: 'kimi-datasource',
        displayName: 'Kimi Datasource',
        version: '1.0.0',
        enabled: true,
        state: 'ok',
        skillCount: 1,
        mcpServerCount: 2,
        enabledMcpServerCount: [...serverEnabled.values()].filter(Boolean).length,
        hasErrors: false,
        source: 'local-path',
        root: '/plugins/kimi-datasource',
        manifest: undefined,
        mcpServers: [
          {
            name: 'metadata',
            runtimeName: 'plugin-kimi-datasource-metadata',
            enabled: serverEnabled.get('metadata') === true,
            transport: 'stdio',
            command: 'node',
            args: ['./bin/kimi-datasource.mjs', 'metadata'],
          },
          {
            name: 'data',
            runtimeName: 'plugin-kimi-datasource-data',
            enabled: serverEnabled.get('data') === true,
            transport: 'stdio',
            command: 'node',
            args: ['./bin/kimi-datasource.mjs', 'data'],
          },
        ],
        diagnostics: [],
      })),
      setPluginMcpServerEnabled: mock(
        async (_id: string, _server: string, nextEnabled: boolean) => {
          serverEnabled.set(_server, nextEnabled);
        },
      ),
    });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginsPanelComponent);
    });
    const panel = driver.state.editorContainer.children[0] as PluginsPanelComponent;
    panel.handleInput('m');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginMcpSelectorComponent);
    });
    const mcpPicker = driver.state.editorContainer.children[0] as PluginMcpSelectorComponent;
    mcpPicker.handleInput('\u001B[B');
    mcpPicker.handleInput(' ');

    await waitForAssertion(() => {
      expect(session.setPluginMcpServerEnabled).toHaveBeenCalledWith(
        'kimi-datasource',
        'data',
        false,
      );
    });
    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginMcpSelectorComponent);
    });
    const out = stripSgr(driver.state.editorContainer.children[0]!.render(120).join('\n'));
    expect(out).toContain('❯ data  disabled  run /reload or /new to apply');
    expect(stripSgr(renderTranscript(driver))).not.toContain(
      'Disabled MCP server data for kimi-datasource. Run /reload or /new to apply.',
    );
  });

  it('requires confirmation before /plugins remove removes a plugin', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins remove demo');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(PluginRemoveConfirmComponent);
    });
    expect(session.removePlugin).not.toHaveBeenCalled();

    const confirm = driver.state.editorContainer.children[0] as PluginRemoveConfirmComponent;
    expect(stripSgr(confirm.render(120).join('\n'))).toContain('Remove demo (demo)?');
    confirm.handleInput('\r');

    await waitForAssertion(() => {
      expect(stripSgr(renderTranscript(driver))).toContain('Remove cancelled: demo.');
    });
    expect(session.removePlugin).not.toHaveBeenCalled();
  });

  it('renders /plugins <id> info to the transcript', async () => {
    const session = makeSession({
      listPlugins: mock(async () => [
        {
          id: 'demo',
          displayName: 'Demo',
          version: '1.0.0',
          enabled: true,
          state: 'ok',
          skillCount: 1,
          mcpServerCount: 0,
          enabledMcpServerCount: 0,
          hasErrors: false,
        },
      ]),
    });
    const { driver } = await makeDriver(session);

    driver.handleUserInput('/plugins demo');

    await waitForAssertion(() => {
      expect(session.getPluginInfo).toHaveBeenCalledWith('demo');
    });
  });

  it('applies /model selection with inline thinking state', async () => {
    const session = makeSession();
    const setConfig = mock(async () => ({ providers: {} }));
    const { driver } = await makeDriver(session, {
      getConfig: mock(async () => ({
        models: {
          k2: {
            provider: 'managed:kimi-code',
            model: 'kimi-k2',
            maxContextSize: 100,
            displayName: 'Kimi K2',
            capabilities: ['thinking'],
          },
          turbo: {
            provider: 'managed:kimi-code',
            model: 'kimi-turbo',
            maxContextSize: 100,
            displayName: 'Kimi Turbo',
            capabilities: ['thinking'],
          },
        },
        defaultModel: 'k2',
        thinking: { enabled: false },
      })),
      setConfig,
    });

    driver.handleUserInput('/model turbo');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(TabbedModelSelectorComponent);
    });
    const picker = driver.state.editorContainer.children[0];
    const pickerOutput = stripSgr((picker as TabbedModelSelectorComponent).render(120).join('\n'));
    expect(pickerOutput).toMatch(/Kimi K2\s+Kimi Code ← current/);
    expect(pickerOutput).toMatch(/❯ Kimi Turbo\s+Kimi Code/);
    (picker as TabbedModelSelectorComponent).handleInput('t');
    (picker as TabbedModelSelectorComponent).handleInput('u');
    const filteredOutput = stripSgr(
      (picker as TabbedModelSelectorComponent).render(120).join('\n'),
    );
    expect(filteredOutput).toContain('Search: tu');
    expect(filteredOutput).toContain('Kimi Turbo');
    expect(filteredOutput).not.toContain('Kimi K2');
    (picker as TabbedModelSelectorComponent).handleInput('\r');

    await waitForAssertion(() => {
      expect(session.setModel).toHaveBeenCalledWith('turbo');
      expect(session.setThinking).toHaveBeenCalledWith('on');
      expect(setConfig).toHaveBeenCalledWith({
        defaultModel: 'turbo',
        thinking: { enabled: true },
      });
    });
    expect(driver.state.appState.model).toBe('turbo');
    expect(driver.state.appState.thinkingEffort).toBe('on');
  });

  it('applies /model selection to the session only on Alt+S without persisting', async () => {
    const session = makeSession();
    const setConfig = mock(async () => ({ providers: {} }));
    const { driver } = await makeDriver(session, {
      getConfig: mock(async () => ({
        models: {
          k2: {
            provider: 'managed:kimi-code',
            model: 'kimi-k2',
            maxContextSize: 100,
            displayName: 'Kimi K2',
            capabilities: ['thinking'],
          },
          turbo: {
            provider: 'managed:kimi-code',
            model: 'kimi-turbo',
            maxContextSize: 100,
            displayName: 'Kimi Turbo',
            capabilities: ['thinking'],
          },
        },
        defaultModel: 'k2',
        thinking: { enabled: false },
      })),
      setConfig,
    });

    driver.handleUserInput('/model turbo');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(TabbedModelSelectorComponent);
    });
    const picker = driver.state.editorContainer.children[0];
    (picker as TabbedModelSelectorComponent).handleInput(`${ESC}s`);

    await waitForAssertion(() => {
      expect(session.setModel).toHaveBeenCalledWith('turbo');
      expect(session.setThinking).toHaveBeenCalledWith('on');
    });
    expect(setConfig).not.toHaveBeenCalled();
    expect(driver.state.appState.model).toBe('turbo');
    expect(driver.state.appState.thinkingEffort).toBe('on');
  });

  it('uses the effective effort returned after a model-switch fallback', async () => {
    let switched = false;
    const session = makeSession({
      getStatus: mock(async () => ({
        model: switched ? 'turbo' : 'k2',
        thinkingEffort: switched ? 'mid' : 'ultra',
        permission: 'manual',
        planMode: false,
        contextTokens: 0,
        maxContextTokens: 100,
        contextUsage: 0,
      })),
      setModel: mock(async () => {
        switched = true;
      }),
    });
    const setConfig = mock(async () => ({ providers: {} }));
    const { driver } = await makeDriver(session, {
      getConfig: mock(async () => ({
        models: {
          k2: {
            provider: 'managed:kimi-code',
            model: 'kimi-k2',
            maxContextSize: 100,
            capabilities: ['thinking'],
            supportEfforts: ['low', 'high', 'ultra'],
            defaultEffort: 'ultra',
          },
          turbo: {
            provider: 'managed:kimi-code',
            model: 'kimi-turbo',
            maxContextSize: 100,
            capabilities: ['thinking'],
            supportEfforts: ['low', 'mid', 'high'],
            defaultEffort: 'mid',
          },
        },
        defaultModel: 'k2',
        thinking: { enabled: true, effort: 'ultra' },
      })),
      setConfig,
    });

    driver.handleUserInput('/model turbo');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(TabbedModelSelectorComponent);
    });
    (driver.state.editorContainer.children[0] as TabbedModelSelectorComponent).handleInput('\r');

    await waitForAssertion(() => {
      expect(setConfig).toHaveBeenCalledWith({
        defaultModel: 'turbo',
        thinking: { enabled: true, effort: 'mid' },
      });
    });
    expect(driver.state.appState.model).toBe('turbo');
    expect(driver.state.appState.thinkingEffort).toBe('mid');
    expect(renderTranscript(driver)).toContain('Switched to kimi-turbo with thinking mid.');
  });

  it('persists /model selection even when runtime state is unchanged', async () => {
    const session = makeSession();
    const setConfig = mock(async () => ({ providers: {} }));
    const { driver } = await makeDriver(session, {
      getConfig: mock(async () => ({
        models: {
          k2: {
            provider: 'managed:kimi-code',
            model: 'kimi-k2',
            maxContextSize: 100,
            displayName: 'Kimi K2',
            capabilities: ['thinking'],
          },
        },
        defaultModel: 'old-default',
        thinking: { enabled: true },
      })),
      setConfig,
    });

    driver.handleUserInput('/model k2');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(TabbedModelSelectorComponent);
    });
    const picker = driver.state.editorContainer.children[0];
    (picker as TabbedModelSelectorComponent).handleInput('\r');

    await waitForAssertion(() => {
      expect(setConfig).toHaveBeenCalledWith({
        defaultModel: 'k2',
        thinking: { enabled: false },
      });
    });
    expect(session.setModel).not.toHaveBeenCalled();
    expect(session.setThinking).not.toHaveBeenCalled();
  });

  it('does not write config when re-confirming the current effort in the picker', async () => {
    const session = makeSession({
      getStatus: mock(async () => ({
        model: 'k2',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        contextTokens: 0,
        maxContextTokens: 100,
        contextUsage: 0,
      })),
    });
    const setConfig = mock(async () => ({ providers: {} }));
    const { driver } = await makeDriver(session, {
      getConfig: mock(async () => ({
        models: {
          k2: {
            provider: 'managed:kimi-code',
            model: 'kimi-k2',
            maxContextSize: 100,
            displayName: 'Kimi K2',
            capabilities: ['thinking'],
            supportEfforts: ['low', 'high', 'max'],
            defaultEffort: 'high',
          },
        },
        defaultModel: 'k2',
        thinking: { enabled: true },
      })),
      setConfig,
    });

    driver.handleUserInput('/effort');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(EffortSelectorComponent);
    });
    (driver.state.editorContainer.children[0] as EffortSelectorComponent).handleInput('\r');

    await waitForAssertion(() => {
      expect(renderTranscript(driver)).toContain('Already using Kimi K2 with thinking high.');
    });
    expect(setConfig).not.toHaveBeenCalled();
    expect(session.setThinking).not.toHaveBeenCalled();
  });

  it('persists only the model when a switch keeps the same effort', async () => {
    let switched = false;
    const session = makeSession({
      getStatus: mock(async () => ({
        model: switched ? 'turbo' : 'k2',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        contextTokens: 0,
        maxContextTokens: 100,
        contextUsage: 0,
      })),
      setModel: mock(async () => {
        switched = true;
      }),
    });
    const setConfig = mock(async () => ({ providers: {} }));
    const { driver } = await makeDriver(session, {
      getConfig: mock(async () => ({
        models: {
          k2: {
            provider: 'managed:kimi-code',
            model: 'kimi-k2',
            maxContextSize: 100,
            displayName: 'Kimi K2',
            capabilities: ['thinking'],
            supportEfforts: ['low', 'high', 'max'],
            defaultEffort: 'high',
          },
          turbo: {
            provider: 'managed:kimi-code',
            model: 'kimi-turbo',
            maxContextSize: 100,
            displayName: 'Turbo',
            capabilities: ['thinking'],
            supportEfforts: ['low', 'high', 'max'],
            defaultEffort: 'high',
          },
        },
        defaultModel: 'k2',
        thinking: { enabled: true, effort: 'high' },
      })),
      setConfig,
    });

    driver.handleUserInput('/model turbo');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(TabbedModelSelectorComponent);
    });
    (driver.state.editorContainer.children[0] as TabbedModelSelectorComponent).handleInput('\r');

    await waitForAssertion(() => {
      expect(setConfig).toHaveBeenCalledWith({
        defaultModel: 'turbo',
        thinking: { enabled: true },
      });
    });
  });

  it('refreshes only OAuth provider models before opening /model picker', async () => {
    const { driver } = await makeDriver(makeSession(), {
      getConfig: mock(async () => ({
        models: {
          k2: {
            provider: 'managed:kimi-code',
            model: 'kimi-k2',
            maxContextSize: 100,
            displayName: 'Old Kimi K2',
            capabilities: ['thinking'],
          },
        },
      })),
    });
    const tui = driver as unknown as KimiTUI;
    const refreshProviderModels = spyOn(tui.authFlow, 'refreshProviderModels')
      .mockRejectedValue(new Error('full provider refresh should not run'));
    const refreshOAuthProviderModels = mock(async () => {
      await Promise.resolve();
      tui.setAppState({
        availableModels: {
          k2: {
            provider: 'managed:kimi-code',
            model: 'kimi-k2',
            maxContextSize: 100,
            displayName: 'Fresh Kimi K2',
            capabilities: ['thinking'],
          },
        },
      });
      return { changed: [], unchanged: ['managed:kimi-code'], failed: [] };
    });
    (
      tui.authFlow as unknown as {
        refreshOAuthProviderModels: typeof refreshOAuthProviderModels;
      }
    ).refreshOAuthProviderModels = refreshOAuthProviderModels;

    driver.handleUserInput('/model');

    await waitForAssertion(() => {
      const picker = driver.state.editorContainer.children[0];
      expect(picker).toBeInstanceOf(TabbedModelSelectorComponent);
      const output = stripSgr((picker as TabbedModelSelectorComponent).render(120).join('\n'));
      expect(output).toContain('Fresh Kimi K2');
      expect(output).not.toContain('Old Kimi K2');
    });
    expect(refreshOAuthProviderModels).toHaveBeenCalledTimes(1);
    expect(refreshProviderModels).not.toHaveBeenCalled();
  });

  it('opens /model picker after 2s when OAuth refresh is still pending', async () => {
    const { driver } = await makeDriver(makeSession(), {
      getConfig: mock(async () => ({
        models: {
          k2: {
            provider: 'managed:kimi-code',
            model: 'kimi-k2',
            maxContextSize: 100,
            displayName: 'Kimi K2',
            capabilities: ['thinking'],
          },
        },
      })),
    });
    const tui = driver as unknown as KimiTUI;
    const refreshOAuthProviderModels = mock(() => new Promise<never>(() => {}));
    (
      tui.authFlow as unknown as {
        refreshOAuthProviderModels: typeof refreshOAuthProviderModels;
      }
    ).refreshOAuthProviderModels = refreshOAuthProviderModels;

    const clock = installGlobalClock();
    try {
      driver.handleUserInput('/model');
      await Promise.resolve();

      expect(refreshOAuthProviderModels).toHaveBeenCalledTimes(1);
      expect(driver.state.editorContainer.children[0]).not.toBeInstanceOf(
        TabbedModelSelectorComponent,
      );

      await advanceClockAsync(clock, 1_999);
      expect(driver.state.editorContainer.children[0]).not.toBeInstanceOf(
        TabbedModelSelectorComponent,
      );

      await advanceClockAsync(clock, 1);
      const picker = driver.state.editorContainer.children[0];
      expect(picker).toBeInstanceOf(TabbedModelSelectorComponent);
      const output = stripSgr((picker as TabbedModelSelectorComponent).render(120).join('\n'));
      expect(output).toContain('Kimi K2');
    } finally {
      restoreGlobalClock();
    }
  });

  it('enables search in the shared model selector helper', async () => {
    const { driver } = await makeDriver();
    const selection = runModelSelector(driver as any, {
      alpha: {
        provider: 'managed:kimi-code',
        model: 'kimi-alpha',
        maxContextSize: 100,
        displayName: 'Kimi Alpha',
        capabilities: ['thinking'],
      },
      turbo: {
        provider: 'managed:kimi-code',
        model: 'kimi-turbo',
        maxContextSize: 100,
        displayName: 'Kimi Turbo',
        capabilities: ['thinking'],
      },
    });

    const picker = driver.state.editorContainer.children[0];
    expect(picker).toBeInstanceOf(ModelSelectorComponent);
    (picker as ModelSelectorComponent).handleInput('t');
    (picker as ModelSelectorComponent).handleInput('u');

    const output = stripSgr((picker as ModelSelectorComponent).render(120).join('\n'));
    expect(output).toContain('Search: tu');
    expect(output).toContain('Kimi Turbo');
    expect(output).not.toContain('Kimi Alpha');

    (picker as ModelSelectorComponent).handleInput('\u001B');
    (picker as ModelSelectorComponent).handleInput('\u001B');
    await expect(selection).resolves.toBeUndefined();
  });

  it('deletes Kitty inline images when /new clears the transcript', async () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const { driver, harness } = await makeDriver(makeSession({ id: 'ses-1' }));
    const nextSession = makeSession({ id: 'ses-2' });
    harness.createSession.mockResolvedValueOnce(nextSession);
    const write = spyOn(driver.state.terminal, 'write').mockImplementation(() => {});

    driver.handleUserInput('/new');

    await waitForAssertion(() => {
      expect(harness.createSession).toHaveBeenCalledTimes(1);
      expect(driver.getCurrentSessionId()).toBe('ses-2');
    });
    expect(write).toHaveBeenCalledWith(deleteAllKittyImages());
  });

  it('updates terminal title through pi-tui without changing process title', async () => {
    const originalTitle = process.title;
    const { driver } = await makeDriver(makeSession({ id: 'ses-1' }));
    const setTitle = spyOn(driver.state.terminal, 'setTitle').mockImplementation(() => {});

    try {
      process.title = 'kimi-test-runner';
      driver.sessionEventHandler.handleEvent(
        {
          type: 'session.meta.updated',
          sessionId: 'ses-1',
          agentId: 'main',
          title: 'Implement terminal title',
        } as Event,
        () => {},
      );

      expect(setTitle).toHaveBeenCalledWith('Implement terminal title');
      expect(process.title).toBe('kimi-test-runner');
    } finally {
      process.title = originalTitle;
    }
  });

  const expectedForkResumeCommand =
    process.platform === 'win32'
      ? 'pushd "/tmp/proj-a" && kimi --resume "ses-fork"'
      : "cd '/tmp/proj-a' && kimi --resume 'ses-fork'";

  it('forks the active session and stays in the source session', async () => {
    const originalTitle = process.title;
    const source = makeSession({
      id: 'ses-source',
      summary: { title: 'Source title' },
    });
    const forked = makeSession({
      id: 'ses-fork',
      summary: { title: 'Fork: Source title' },
    });
    const forkSession = mock(async () => forked);
    const { driver, harness } = await makeDriver(source, { forkSession });
    const setTitle = spyOn(driver.state.terminal, 'setTitle').mockImplementation(() => {});

    try {
      process.title = 'kimi-test-runner';
      driver.handleUserInput('/fork ignored args');

      await waitForAssertion(() => {
        expect(forkSession).toHaveBeenCalledWith({ id: 'ses-source' });
        expect(driver.state.transcriptContainer.render(120).join('\n')).toContain(
          'Session forked (ses-fork). Still in the original session; switch to the fork via /sessions.',
        );
      });
      expect(copyTextToClipboard).toHaveBeenCalledWith(expectedForkResumeCommand);
      const transcript = driver.state.transcriptContainer.render(120).join('\n');
      expect(transcript).toContain(
        `To enter the fork in a new process, run: ${expectedForkResumeCommand}`,
      );
      expect(transcript).toContain('Command copied to clipboard');
      expect(driver.getCurrentSessionId()).toBe('ses-source');
      expect(source.close).not.toHaveBeenCalled();
      expect(forked.close).toHaveBeenCalledTimes(1);
      expect(forked.onEvent).not.toHaveBeenCalled();
      expect(setTitle).not.toHaveBeenCalled();
      expect(process.title).toBe('kimi-test-runner');
      expect(harness.resumeSession).not.toHaveBeenCalled();
    } finally {
      process.title = originalTitle;
    }
  });

  it('still prints the fork resume command when the clipboard copy fails', async () => {
    copyTextToClipboardMock.mockRejectedValueOnce(new Error('no clipboard'));
    const source = makeSession({ id: 'ses-source' });
    const forked = makeSession({ id: 'ses-fork' });
    const forkSession = mock(async () => forked);
    const { driver } = await makeDriver(source, { forkSession });

    driver.handleUserInput('/fork');

    await waitForAssertion(() => {
      const transcript = driver.state.transcriptContainer.render(120).join('\n');
      expect(transcript).toContain(
        `To enter the fork in a new process, run: ${expectedForkResumeCommand}`,
      );
      expect(transcript).toContain('Failed to copy command to clipboard');
    });
    expect(driver.getCurrentSessionId()).toBe('ses-source');
  });

  it('labels OSC 52 clipboard delivery as unverified after a fork', async () => {
    copyTextToClipboardMock.mockResolvedValueOnce('osc52');
    const source = makeSession({ id: 'ses-source' });
    const forked = makeSession({ id: 'ses-fork' });
    const forkSession = mock(async () => forked);
    const { driver } = await makeDriver(source, { forkSession });

    driver.handleUserInput('/fork');

    await waitForAssertion(() => {
      expect(driver.state.transcriptContainer.render(120).join('\n')).toContain(
        'Command copied via terminal escape sequence (unverified)',
      );
    });
    expect(driver.getCurrentSessionId()).toBe('ses-source');
  });

  it('prints a pushd-based fork resume command on Windows', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const source = makeSession({ id: 'ses-source' });
      const forked = makeSession({ id: 'ses-fork' });
      const forkSession = mock(async () => forked);
      const { driver } = await makeDriver(
        source,
        { forkSession },
        {
          ...makeStartupInput(),
          workDir: 'D:\\proj',
        },
      );
      await driver.setSession(source);
      await driver.syncRuntimeState(source);

      driver.handleUserInput('/fork');

      await waitForAssertion(() => {
        expect(copyTextToClipboard).toHaveBeenCalledWith(
          'pushd "D:\\proj" && kimi --resume "ses-fork"',
        );
      });
      expect(driver.getCurrentSessionId()).toBe('ses-source');
    } finally {
      if (platformDescriptor !== undefined) {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
    }
  });

  it('keeps the current session when fork fails', async () => {
    const forkSession = mock(async () => {
      throw new Error('fork unavailable');
    });
    const { driver } = await makeDriver(makeSession({ id: 'ses-source' }), { forkSession });

    driver.handleUserInput('/fork');

    await waitForAssertion(() => {
      expect(forkSession).toHaveBeenCalledWith({ id: 'ses-source' });
      expect(driver.getCurrentSessionId()).toBe('ses-source');
      expect(driver.state.transcriptContainer.render(120).join('\n')).toContain(
        'Failed to fork session: fork unavailable',
      );
    });
  });

  it('reports when the forked runtime cannot be released', async () => {
    const source = makeSession({ id: 'ses-source' });
    const forked = makeSession({ id: 'ses-fork' });
    forked.close.mockRejectedValueOnce(new Error('close unavailable'));
    const forkSession = mock(async () => forked);
    const { driver } = await makeDriver(source, { forkSession });

    driver.handleUserInput('/fork');

    await waitForAssertion(() => {
      expect(forked.close).toHaveBeenCalledTimes(1);
      expect(driver.getCurrentSessionId()).toBe('ses-source');
      expect(driver.state.transcriptContainer.render(120).join('\n')).toContain(
        'Session forked (ses-fork), but failed to release its runtime: close unavailable',
      );
    });
    expect(source.close).not.toHaveBeenCalled();
  });

  it('does not create a thinking component for empty thinking deltas', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.streamingPhase = 'thinking';
    driver.state.appState.streamingStartTime = 1;

    driver.sessionEventHandler.handleEvent(
      {
        type: 'thinking.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        delta: '',
      } as Event,
      mock(),
    );

    expect(driver.streamingUI.hasActiveThinkingComponent()).toBe(false);
  });

  it('does not create a thinking component for whitespace-only thinking deltas', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.streamingPhase = 'waiting';

    driver.sessionEventHandler.handleEvent(
      {
        type: 'thinking.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        delta: ' ',
      } as Event,
      mock(),
    );
    driver.streamingUI.flushNow();

    expect(driver.streamingUI.hasActiveThinkingComponent()).toBe(false);
    expect(readStreamingPhase(driver)).toBe('waiting');

    driver.sessionEventHandler.handleEvent(
      {
        type: 'thinking.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        delta: 'actual reasoning',
      } as Event,
      mock(),
    );
    driver.streamingUI.flushNow();

    expect(readStreamingPhase(driver)).toBe('thinking');
    expect(driver.streamingUI.hasActiveThinkingComponent()).toBe(true);
    expect(stripSgr(renderTranscript(driver))).toContain('actual reasoning');
  });

  it('does not create a thinking component for whitespace-only thinking on session replay', async () => {
    const { driver } = await makeDriver();

    driver.streamingUI.onThinkingUpdate(' ');
    driver.streamingUI.onThinkingEnd();

    expect(driver.streamingUI.hasActiveThinkingComponent()).toBe(false);
    expect(
      driver.state.transcriptContainer.children.filter(
        (child) => child instanceof ThinkingComponent,
      ),
    ).toHaveLength(0);

    driver.streamingUI.onThinkingUpdate('visible reasoning');
    driver.streamingUI.onThinkingEnd();

    expect(stripSgr(renderTranscript(driver))).toContain('visible reasoning');
  });

  it('keeps the waiting moon spinner while reasoning streams only empty (encrypted) thinking deltas', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
      } as Event,
      mock(),
    );
    expect(readStreamingPhase(driver)).toBe('waiting');
    expect(driver.state.livePane.mode).toBe('waiting');

    for (let i = 0; i < 3; i++) {
      driver.sessionEventHandler.handleEvent(
        {
          type: 'thinking.delta',
          agentId: 'main',
          sessionId: 'ses-1',
          delta: '',
        } as Event,
        mock(),
      );
    }

    expect(readStreamingPhase(driver)).toBe('waiting');
    expect(driver.state.livePane.mode).toBe('waiting');
    expect(driver.streamingUI.hasActiveThinkingComponent()).toBe(false);
    const activity = stripSgr(renderActivity(driver));
    expect(MOON_SPINNER_FRAMES.some((frame) => activity.includes(frame))).toBe(true);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'thinking.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        delta: 'actual reasoning',
      } as Event,
      mock(),
    );
    driver.streamingUI.flushNow();
    expect(readStreamingPhase(driver)).toBe('thinking');
    expect(driver.streamingUI.hasActiveThinkingComponent()).toBe(true);
  });

  it('finalizes an orphaned thinking component on turn end', async () => {
    const { driver } = await makeDriver();
    driver.state.appState.streamingPhase = 'thinking';
    driver.state.appState.streamingStartTime = 1;
    const sendQueued = mock();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'thinking.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        delta: 'leaked',
      } as Event,
      mock(),
    );
    driver.streamingUI.flushNow();
    expect(driver.streamingUI.hasActiveThinkingComponent()).toBe(true);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        reason: 'completed',
      } as Event,
      sendQueued,
    );

    expect(driver.streamingUI.hasActiveThinkingComponent()).toBe(false);
  });

  it('renders newly streamed thinking expanded when ctrl+o toggle was already active', async () => {
    const { driver } = await makeDriver();
    driver.state.toolOutputExpanded = true;

    const longThinking = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'].join('\n');
    driver.sessionEventHandler.handleEvent(
      {
        type: 'thinking.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        delta: longThinking,
      } as Event,
      mock(),
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'assistant.delta',
        agentId: 'main',
        sessionId: 'ses-1',
        delta: 'answer',
      } as Event,
      mock(),
    );

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('t7');
    expect(transcript).not.toContain('ctrl+o expand');
  });

  it('renders hook results without XML tags', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'hook.result',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        hookEvent: 'UserPromptSubmit',
        content: '{}',
      } as Event,
      mock(),
    );

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('UserPromptSubmit hook');
    expect(transcript).toContain('{}');
    expect(transcript).not.toContain('<hook_result');
  });

  it('renders empty hook results as empty status text', async () => {
    const { driver } = await makeDriver();

    driver.sessionEventHandler.handleEvent(
      {
        type: 'hook.result',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        hookEvent: 'UserPromptSubmit',
        content: '',
      } as Event,
      mock(),
    );

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('UserPromptSubmit hook');
    expect(transcript).toContain('(empty)');
    expect(transcript).not.toContain('<hook_result');
  });

});

describe('auto session title', () => {
  const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('generates a session title after the first completed turn', async () => {
    const generateSessionTitle = mock(async () => 'Generated Title');
    const { driver } = await makeDriver(makeSession(), { generateSessionTitle });

    emitTurn(driver, 1);

    await waitForAssertion(() => {
      expect(generateSessionTitle).toHaveBeenCalledWith({ id: 'ses-1', source: 'first_turn' });
    });
  });

  it('does not generate when autoSessionTitle is disabled', async () => {
    const generateSessionTitle = mock(async () => 'Generated Title');
    const { driver } = await makeDriver(makeSession(), {
      generateSessionTitle,
      getConfig: mock(async () => ({ models: {}, autoSessionTitle: false })),
    });

    emitTurn(driver, 1);
    await flushAsync();

    expect(generateSessionTitle).not.toHaveBeenCalled();
  });

  it('does not generate when the tui.toml auto_session_title toggle is off', async () => {
    const generateSessionTitle = mock(async () => 'Generated Title');
    const startupInput: KimiTUIStartupInput = {
      ...makeStartupInput(),
      tuiConfig: { ...makeStartupInput().tuiConfig, autoSessionTitle: false },
    };
    const session = makeSession();
    const { driver } = await makeDriver(session, { generateSessionTitle }, startupInput);
    await driver.setSession(session);
    await driver.syncRuntimeState(session);

    emitTurn(driver, 1);
    await flushAsync();

    expect(generateSessionTitle).not.toHaveBeenCalled();
  });

  it('does not regenerate once a title was generated', async () => {
    const generateSessionTitle = mock(async () => 'Generated Title');
    const { driver } = await makeDriver(makeSession(), { generateSessionTitle });

    emitTurn(driver, 1);
    await waitForAssertion(() => {
      expect(generateSessionTitle).toHaveBeenCalledTimes(1);
    });
    await flushAsync();

    emitTurn(driver, 2);
    await flushAsync();

    expect(generateSessionTitle).toHaveBeenCalledTimes(1);
  });

  it('stops retrying after three failed attempts', async () => {
    const generateSessionTitle = mock(async (): Promise<string | undefined> => {
      throw new Error('unavailable');
    });
    const { driver } = await makeDriver(makeSession(), { generateSessionTitle });

    for (let turnId = 1; turnId <= 4; turnId += 1) {
      emitTurn(driver, turnId);
      await flushAsync();
    }

    expect(generateSessionTitle).toHaveBeenCalledTimes(3);
  });

  it('skips generation for turns that did not complete', async () => {
    const generateSessionTitle = mock(async () => 'Generated Title');
    const { driver } = await makeDriver(makeSession(), { generateSessionTitle });

    driver.sessionEventHandler.handleEvent(
      { type: 'turn.started', agentId: 'main', turnId: 1, origin: { kind: 'user' } } as Event,
      () => {},
    );
    driver.sessionEventHandler.handleEvent(
      { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'cancelled' } as Event,
      () => {},
    );
    await flushAsync();

    expect(generateSessionTitle).not.toHaveBeenCalled();
  });
});

describe('/model status displayName override', () => {
  it('shows the overridden display name in the switch status', async () => {
    const session = makeSession();
    const setConfig = mock(async () => ({ providers: {} }));
    const { driver } = await makeDriver(session, {
      getConfig: mock(async () => ({
        models: {
          k2: {
            provider: 'managed:kimi-code',
            model: 'kimi-k2',
            maxContextSize: 100,
            displayName: 'Kimi K2',
            capabilities: ['thinking'],
          },
          turbo: {
            provider: 'managed:kimi-code',
            model: 'kimi-turbo',
            maxContextSize: 100,
            displayName: 'Remote Turbo',
            capabilities: ['thinking'],
            overrides: { displayName: 'Custom Turbo' },
          },
        },
        defaultModel: 'k2',
        thinking: { enabled: false },
      })),
      setConfig,
    });

    driver.handleUserInput('/model turbo');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(TabbedModelSelectorComponent);
    });
    (driver.state.editorContainer.children[0] as TabbedModelSelectorComponent).handleInput('\r');

    await waitForAssertion(() => {
      expect(setConfig).toHaveBeenCalledWith({
        defaultModel: 'turbo',
        thinking: { enabled: true },
      });
    });

    expect(renderTranscript(driver)).toContain('Switched to Custom Turbo with thinking on.');
    expect(renderTranscript(driver)).not.toContain('Remote Turbo');
  });
});

describe('/effort support_efforts override', () => {
  it('warns and applies efforts hidden by an Anthropic support_efforts override', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session, {
      getConfig: mock(async () => ({
        providers: {
          compatible: { type: 'kimi', apiKey: 'test-key' },
        },
        models: {
          k2: {
            provider: 'compatible',
            model: 'compatible-model',
            protocol: 'anthropic',
            maxContextSize: 100,
            displayName: 'Compatible Model',
            capabilities: ['thinking'],
            supportEfforts: ['low', 'high', 'max'],
            overrides: { supportEfforts: ['low', 'high'] },
          },
        },
        defaultModel: 'k2',
        thinking: { enabled: true, effort: 'low' },
      })),
    });

    driver.handleUserInput('/effort max');

    await waitForAssertion(() => {
      expect(session.setThinking).toHaveBeenCalledWith('max');
    });
    await waitForAssertion(() => {
      expect(renderTranscript(driver)).toContain('Thinking set to max.');
    });
    const transcript = renderTranscript(driver).replaceAll(/\s+/g, ' ');
    expect(transcript).toContain(
      'Thinking effort "max" is not listed for k2 (known: low, high). Sending "max" unchanged; the configured provider will validate it.',
    );
    expect(transcript).toContain('Thinking set to max.');
  });

  it('offers the latest Opus efforts for an unknown Claude-marked Anthropic-compatible model', async () => {
    const { driver } = await makeDriver(makeSession(), {
      getConfig: mock(async () => ({
        providers: {
          compatible: { type: 'anthropic', apiKey: 'test-key' },
        },
        models: {
          k2: {
            provider: 'compatible',
            model: 'compatible-claude-model',
            maxContextSize: 100,
          },
        },
        defaultModel: 'k2',
      })),
    });

    driver.handleUserInput('/effort');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(EffortSelectorComponent);
    });
    const picker = driver.state.editorContainer.children[0] as EffortSelectorComponent;
    expect(picker.render(80).join('\n')).toContain('Max');
  });

  it('offers no fallback efforts for a clearly non-Claude Anthropic-compatible model', async () => {
    const { driver } = await makeDriver(makeSession(), {
      getConfig: mock(async () => ({
        providers: {
          compatible: { type: 'anthropic', apiKey: 'test-key' },
        },
        models: {
          k2: {
            provider: 'compatible',
            model: 'compatible-model',
            maxContextSize: 100,
          },
        },
        defaultModel: 'k2',
      })),
    });

    driver.handleUserInput('/effort');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(EffortSelectorComponent);
    });
    const picker = driver.state.editorContainer.children[0] as EffortSelectorComponent;
    expect(picker.render(80).join('\n')).not.toContain('Max');
  });

  it('offers no fallback efforts for an unknown model on a Kimi provider using the Anthropic protocol', async () => {
    const { driver } = await makeDriver(makeSession(), {
      getConfig: mock(async () => ({
        providers: {
          compatible: { type: 'kimi', apiKey: 'test-key' },
        },
        models: {
          k2: {
            provider: 'compatible',
            model: 'compatible-model',
            protocol: 'anthropic',
            maxContextSize: 100,
          },
        },
        defaultModel: 'k2',
      })),
    });

    driver.handleUserInput('/effort');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(EffortSelectorComponent);
    });
    const picker = driver.state.editorContainer.children[0] as EffortSelectorComponent;
    expect(picker.render(80).join('\n')).not.toContain('Max');
  });

  it('offers the latest Opus efforts for a flat providerless Claude-marked Anthropic model', async () => {
    const { driver } = await makeDriver(makeSession(), {
      getConfig: mock(async () => ({
        providers: {},
        models: {
          k2: {
            model: 'compatible-claude-model',
            baseUrl: 'https://anthropic.example.test',
            protocol: 'anthropic',
            maxContextSize: 100,
          },
        },
        defaultModel: 'k2',
      })),
    });

    driver.handleUserInput('/effort');

    await waitForAssertion(() => {
      expect(driver.state.editorContainer.children[0]).toBeInstanceOf(EffortSelectorComponent);
    });
    const picker = driver.state.editorContainer.children[0] as EffortSelectorComponent;
    expect(picker.render(80).join('\n')).toContain('Max');
  });

  it('keeps rejecting efforts hidden by a Kimi support_efforts override', async () => {
    const session = makeSession();
    const { driver } = await makeDriver(session, {
      getConfig: mock(async () => ({
        providers: {
          kimi: { type: 'kimi', apiKey: 'test-key' },
        },
        models: {
          k2: {
            provider: 'kimi',
            model: 'kimi-model',
            maxContextSize: 100,
            capabilities: ['thinking'],
            supportEfforts: ['low', 'high'],
          },
        },
        defaultModel: 'k2',
        thinking: { enabled: true, effort: 'low' },
      })),
    });

    driver.handleUserInput('/effort max');

    await waitForAssertion(() => {
      expect(renderTranscript(driver)).toContain(
        'Unsupported thinking effort "max" for k2. Available: off, low, high',
      );
    });
    expect(session.setThinking).not.toHaveBeenCalled();
  });
});

describe('transcript step and assistant folding', () => {
  function driveSteps(driver: MessageDriver, cycles: number): void {
    for (let i = 0; i < cycles; i++) {
      driver.sessionEventHandler.handleEvent(
        {
          type: 'assistant.delta',
          agentId: 'main',
          sessionId: 'ses-1',
          turnId: 1,
          delta: `msg-${i} `,
        } as Event,
        mock(),
      );
      driver.sessionEventHandler.handleEvent(
        {
          type: 'tool.call.started',
          agentId: 'main',
          sessionId: 'ses-1',
          turnId: 1,
          toolCallId: `call_${i}`,
          name: 'Bash',
          args: { command: 'ls' },
        } as Event,
        mock(),
      );
      driver.sessionEventHandler.handleEvent(
        {
          type: 'tool.result',
          agentId: 'main',
          sessionId: 'ses-1',
          turnId: 1,
          toolCallId: `call_${i}`,
          output: 'ok',
          isError: undefined,
        } as Event,
        mock(),
      );
    }
  }

  it('folds the oldest assistant messages and steps beyond their per-turn caps', async () => {
    const { driver } = await makeDriver();
    driver.handleUserInput('fold me');

    const cycles = Math.max(TRANSCRIPT_KEEP_RECENT_ASSISTANT, TRANSCRIPT_KEEP_RECENT_STEPS) + 7;
    driveSteps(driver, cycles);

    const children = driver.state.transcriptContainer.children;
    const assistantCount = children.filter(
      (child) => child instanceof AssistantMessageComponent,
    ).length;
    const toolCount = children.filter((child) => child instanceof ToolCallComponent).length;
    expect(assistantCount).toBe(TRANSCRIPT_KEEP_RECENT_ASSISTANT);
    expect(toolCount).toBe(TRANSCRIPT_KEEP_RECENT_STEPS);

    const summaries = children.filter((child) => child instanceof StepSummaryComponent);
    expect(summaries).toHaveLength(1);
    const summaryText = stripSgr(summaries[0]!.render(120).join('\n'));
    expect(summaryText).toContain(`call ${cycles - TRANSCRIPT_KEEP_RECENT_STEPS} tools`);
    expect(summaryText).toContain(`${cycles - TRANSCRIPT_KEEP_RECENT_ASSISTANT} messages`);

    const assistantEntries = driver.state.transcriptEntries.filter(
      (entry) => entry.kind === 'assistant',
    );
    expect(assistantEntries).toHaveLength(cycles);
  });

  it('does not fold a turn within the caps', async () => {
    const { driver } = await makeDriver();
    driver.handleUserInput('small turn');
    driveSteps(driver, 3);

    const children = driver.state.transcriptContainer.children;
    expect(children.filter((child) => child instanceof AssistantMessageComponent)).toHaveLength(3);
    expect(children.filter((child) => child instanceof ToolCallComponent)).toHaveLength(3);
    expect(children.filter((child) => child instanceof StepSummaryComponent)).toHaveLength(0);
  });

  it('folds a completed turn down to its conclusion tail on turn end', async () => {
    const { driver } = await makeDriver();
    driver.handleUserInput('round one');
    const cycles = 10;
    driveSteps(driver, cycles);

    let children = driver.state.transcriptContainer.children;
    expect(
      children.filter((child) => child instanceof AssistantMessageComponent),
    ).toHaveLength(cycles);

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        reason: 'completed',
      } as Event,
      mock(),
    );

    children = driver.state.transcriptContainer.children;
    const assistants = children.filter((child) => child instanceof AssistantMessageComponent);
    expect(assistants).toHaveLength(TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED);

    const summaries = children.filter((child) => child instanceof StepSummaryComponent);
    expect(summaries).toHaveLength(1);
    const summaryText = stripSgr(summaries[0]!.render(120).join('\n'));
    expect(summaryText).toContain(`${cycles - TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED} messages`);

    expect(children.filter((child) => child instanceof ToolCallComponent)).toHaveLength(cycles);

    const lastAssistant = assistants.at(-1)!;
    expect(stripSgr(lastAssistant.render(120).join('\n'))).toContain(`msg-${cycles - 1}`);
  });
});

describe('footer ctrl+o hint', () => {
  function emitBashResult(driver: MessageDriver, toolCallId: string, output: string): void {
    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId,
        name: 'Bash',
        args: { command: 'pnpm test' },
      } as Event,
      mock(),
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.result',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId,
        output,
        isError: undefined,
      } as Event,
      mock(),
    );
  }

  function renderFooterLine1(driver: MessageDriver): string {
    return stripSgr(driver.state.footer.render(160)[0] ?? '');
  }

  it('offers expand while a card hides output and collapse once it is shown', async () => {
    const { driver } = await makeDriver();
    expect(renderFooterLine1(driver)).not.toContain('ctrl+o');

    emitBashResult(driver, 'call_bash', ['line1', 'line2', 'line3', 'line4', 'Tests 5 passed'].join('\n'));
    expect(renderFooterLine1(driver)).toContain('ctrl+o expand');

    driver.toggleToolOutputExpansion();
    expect(renderFooterLine1(driver)).toContain('ctrl+o collapse');

    driver.toggleToolOutputExpansion();
    expect(renderFooterLine1(driver)).toContain('ctrl+o expand');
  });

  it('stays silent when every card shows its whole output', async () => {
    const { driver } = await makeDriver();
    emitBashResult(driver, 'call_bash', ['line1', 'line2', 'line3'].join('\n'));
    expect(renderFooterLine1(driver)).not.toContain('ctrl+o');
  });

  it('keeps the collapse hint for an expanded card that slid out of the expansion window', async () => {
    const { driver } = await makeDriver();
    emitBashResult(driver, 'call_bash', ['line1', 'line2', 'line3', 'line4', 'Tests 5 passed'].join('\n'));
    driver.toggleToolOutputExpansion();
    expect(renderFooterLine1(driver)).toContain('ctrl+o collapse');

    // Four later user turns move the expanded card before the three-turn
    // cutoff; nothing collapses it, and ctrl+o would still visibly collapse it.
    for (let i = 0; i < 4; i++) {
      driver.appendTranscriptEntry({
        id: `later-${String(i)}`,
        kind: 'user',
        renderMode: 'plain',
        content: `next ${String(i)}`,
      });
    }
    expect(renderFooterLine1(driver)).toContain('ctrl+o collapse');

    driver.toggleToolOutputExpansion();
    expect(renderFooterLine1(driver)).not.toContain('ctrl+o');
  });
});

describe('KimiTUI session rating survey', () => {
  it.each(['startup', 'switch', 'reload'] as const)(
    'reports cumulative user turns after a %s mount',
    async (mount) => {
      process.env['KIMI_CODE_HOME'] = await makeTempHome();
      spyOn(Math, 'random').mockReturnValue(0);
      try {
        const session = makeSession();
        const resumeState = session.getResumeState();
        resumeState.agents.main.userTurnCount = 40;
        session.getResumeState.mockReturnValue(resumeState);
        const startup = makeStartupInput();
        startup.cliOptions.session = 'ses-1';
        const { driver, harness } = await makeDriver(
          session,
          { listSessions: mock(async () => [{ id: 'ses-1', workDir: '/tmp/proj-a' }]) },
          mount === 'startup' ? startup : undefined,
        );
        if (mount === 'switch') {
          emitTurn(driver, 1);
          await driver.switchToSession(session as unknown as Session, 'Resumed session.');
        } else if (mount === 'reload') {
          emitTurn(driver, 1);
          await driver.reloadCurrentSessionView(session as unknown as Session, 'Reloaded session.');
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        const clock = installGlobalClock();
        try {
          harness.trackWithContext.mockClear();
          emitTurn(driver, 41, () => {
            driver.sessionEventHandler.handleEvent(
              { type: 'agent.status.updated', agentId: 'main', contextTokens: 205_000 } as Event,
              () => {},
            );
          });
          await advanceClockAsync(clock, 2_000);

          expect(harness.trackWithContext).toHaveBeenCalledWith(
            'long_context_survey',
            expect.objectContaining({ event_type: 'appeared', user_turn_count: 41 }),
            { sessionId: 'ses-1' },
          );
        } finally {
          restoreGlobalClock();
        }
      } finally {
        mock.restore();
      }
    },
  );

  it.each(['lazy', 'new-command'] as const)(
    'starts from zero when a new session is created through %s',
    async (creation) => {
      process.env['KIMI_CODE_HOME'] = await makeTempHome();
      spyOn(Math, 'random').mockReturnValue(0);
      try {
        const session = makeSession({ getResumeState: mock(() => undefined) });
        const startup = makeStartupInput();
        startup.cliOptions.model = 'k2';
        const { driver, harness } = await makeDriver(session, {}, startup);
        if (creation === 'lazy') {
          driver.handleUserInput('first question');
          await waitForAssertion(() => {
            expect(session.prompt).toHaveBeenCalled();
          });
        } else {
          await driver.createNewSession();
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        const clock = installGlobalClock();
        try {
          harness.trackWithContext.mockClear();
          emitTurn(driver, 1, () => {
            driver.sessionEventHandler.handleEvent(
              { type: 'agent.status.updated', agentId: 'main', contextTokens: 205_000 } as Event,
              () => {},
            );
          });
          await advanceClockAsync(clock, 2_000);

          expect(harness.trackWithContext).toHaveBeenCalledWith(
            'long_context_survey',
            expect.objectContaining({ event_type: 'appeared', user_turn_count: 1 }),
            { sessionId: 'ses-1' },
          );
        } finally {
          restoreGlobalClock();
        }
      } finally {
        mock.restore();
      }
    },
  );

  it('runs the end-to-end rating flow after five user turns', async () => {
    const homeDir = await makeTempHome();
    process.env['KIMI_CODE_HOME'] = homeDir;
    spyOn(Math, 'random').mockReturnValue(0);
    try {
      const { driver, harness } = await makeDriver();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const clock = installGlobalClock();
      harness.track.mockClear();

      for (let turn = 1; turn <= 4; turn++) emitTurn(driver, turn);
      clock.advance(600_000);
      clock.advance(2_000);
      expect(driver.state.surveyContainer.children).toHaveLength(0);

      emitTurn(driver, 5, () => {
        driver.sessionEventHandler.handleEvent(
          {
            type: 'tool.call.started',
            agentId: 'main',
            sessionId: 'ses-1',
            turnId: 5,
            toolCallId: 'call_1',
            name: 'Read',
            args: { path: 'a.ts' },
          } as Event,
          () => {},
        );
        driver.sessionEventHandler.handleEvent(
          {
            type: 'agent.status.updated',
            agentId: 'main',
            sessionId: 'ses-1',
            contextTokens: 4321,
            usage: {
              total: { inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10 },
            },
          } as Event,
          () => {},
        );
      });
      clock.advance(2_000);
      const docked = stripSgr(driver.state.surveyContainer.render(120).join('\n'));
      expect(docked).toContain('How is Kimi doing this session? (optional)');
      expect(docked).toContain('1: Bad  2: Fine  3: Good  0: Dismiss');
      expect(harness.trackWithContext).toHaveBeenCalledTimes(1);
      expect(harness.trackWithContext).toHaveBeenCalledWith(
        'feedback_survey',
        {
          event_type: 'appeared',
          appearance_id: expect.any(String),
          appearance_index: 1,
          response: undefined,
          current_model: 'k2',
          user_turn_count: 5,
          cumulative_tokens: 160,
          virtual_context_tokens: 4321,
          tool_call_count: 1,
          compaction_count: 0,
          permission_mode: 'manual',
          thinking_effort: 'off',
          subagent_count: 0,
          swarm_run_count: 0,
          config_probability: 0.005,
          config_on_for_models: '*',
          config_min_time_before_feedback_ms: 600_000,
          config_min_user_turns_before_feedback: 5,
          config_min_time_between_feedback_ms: 3_600_000,
          config_min_user_turns_between_feedback: 10,
          config_min_time_between_global_feedback_ms: 100_000_000,
          config_long_context_survey_threshold: 200_000,
          config_long_context_probability: 0.2,
          config_long_context_trigger_mode: 'virtual_context',
        },
        { sessionId: 'ses-1' },
      );
      const appearanceId = (
        harness.trackWithContext.mock.calls[0]![1] as { appearance_id: string }
      ).appearance_id;

      driver.state.editor.handleInput('1');
      clock.advance(400);
      expect(harness.trackWithContext).toHaveBeenCalledTimes(1);

      clock.advance(600);
      driver.state.editor.setText('');
      driver.state.editor.handleInput('1');
      clock.advance(400);
      expect(driver.state.editor.getText()).toBe('');
      expect(stripSgr(driver.state.surveyContainer.render(120).join('\n'))).toContain(
        'Feedback: Bad · [escape: undo]',
      );
      expect(harness.trackWithContext).toHaveBeenCalledTimes(1);

      driver.state.editor.handleInput('\u001B');
      clock.advance(3_000);
      expect(harness.trackWithContext).toHaveBeenCalledTimes(1);
      expect(stripSgr(driver.state.surveyContainer.render(120).join('\n'))).toContain(
        'How is Kimi doing this session? (optional)',
      );

      driver.state.editor.setText('');
      driver.state.editor.handleInput('3');
      clock.advance(400);
      clock.advance(3_000);
      const responded = harness.trackWithContext.mock.calls
        .filter(
          (call) =>
            call[0] === 'feedback_survey' &&
            (call[1] as { event_type?: string }).event_type === 'responded',
        )
        .map((call) => call[1] as { response?: string; appearance_id: string });
      expect(responded.map((call) => call.response)).toEqual(['good']);
      expect(responded.map((call) => call.appearance_id)).toEqual([appearanceId]);

      expect(stripSgr(driver.state.surveyContainer.render(120).join('\n'))).toContain(
        'Thanks for your feedback!',
      );
      clock.advance(5_000);
      expect(driver.state.surveyContainer.children).toHaveLength(0);

      restoreGlobalClock();
      const stateFile = join(homeDir, 'feedback-survey-state.json');
      await waitForAssertion(() => {
        expect(existsSync(stateFile)).toBe(true);
      });
      const persisted = JSON.parse(await readFile(stateFile, 'utf-8')) as {
        version: number;
        last_shown_time: number;
      };
      expect(persisted.version).toBe(1);
      expect(typeof persisted.last_shown_time).toBe('number');
    } finally {
      restoreGlobalClock();
      mock.restore();
    }
  });

  it('shows the long-context survey once the context window crosses the threshold', async () => {
    const homeDir = await makeTempHome();
    process.env['KIMI_CODE_HOME'] = homeDir;
    spyOn(Math, 'random').mockReturnValue(0);
    try {
      const { driver, harness } = await makeDriver();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const clock = installGlobalClock();
      harness.track.mockClear();

      emitTurn(driver, 1, () => {
        driver.sessionEventHandler.handleEvent(
          {
            type: 'agent.status.updated',
            agentId: 'main',
            sessionId: 'ses-1',
            contextTokens: 205_000,
            usage: {
              total: {
                inputOther: 1_000,
                output: 500,
                inputCacheRead: 0,
                inputCacheCreation: 0,
              },
            },
          } as Event,
          () => {},
        );
      });
      clock.advance(2_000);

      expect(stripSgr(driver.state.surveyContainer.render(120).join('\n'))).toContain(
        'How is Kimi doing this session? (optional)',
      );
      expect(harness.trackWithContext).toHaveBeenCalledTimes(1);
      expect(harness.trackWithContext).toHaveBeenCalledWith(
        'long_context_survey',
        expect.objectContaining({
          event_type: 'appeared',
          appearance_index: 1,
          user_turn_count: 1,
          cumulative_tokens: 1500,
          virtual_context_tokens: 205_000,
          config_long_context_survey_threshold: 200_000,
          config_long_context_probability: 0.2,
          config_long_context_trigger_mode: 'virtual_context',
        }),
        { sessionId: 'ses-1' },
      );

      restoreGlobalClock();
      const stateFile = join(homeDir, 'feedback-survey-state.json');
      await waitForAssertion(() => {
        expect(existsSync(stateFile)).toBe(true);
      });
      const persisted = JSON.parse(await readFile(stateFile, 'utf-8')) as {
        version: number;
        last_shown_time: number;
      };
      expect(persisted.version).toBe(1);
      expect(typeof persisted.last_shown_time).toBe('number');
    } finally {
      restoreGlobalClock();
      mock.restore();
    }
  });

  it('ignores non-user turns for the survey warmup', async () => {
    process.env['KIMI_CODE_HOME'] = await makeTempHome();
    spyOn(Math, 'random').mockReturnValue(0);
    try {
      const { driver } = await makeDriver();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const clock = installGlobalClock();
      const emit = (event: Event) => {
        driver.sessionEventHandler.handleEvent(event, () => {});
      };
      const cronOrigin = {
        kind: 'cron_job',
        jobId: 'job-42',
        cron: '*/5 * * * *',
        recurring: true,
        coalescedCount: 1,
        stale: false,
      };

      clock.advance(600_000);
      for (let turn = 1; turn <= 5; turn++) {
        emit({ type: 'turn.started', agentId: 'main', turnId: turn, origin: cronOrigin } as Event);
        emit({ type: 'turn.ended', agentId: 'main', turnId: turn, reason: 'completed' } as Event);
      }
      clock.advance(2_000);
      expect(driver.state.surveyContainer.children).toHaveLength(0);

      for (let turn = 6; turn <= 10; turn++) emitTurn(driver, turn);
      clock.advance(2_000);
      expect(driver.state.surveyContainer.children).not.toHaveLength(0);

      restoreGlobalClock();
      await waitForAssertion(() => {
        expect(existsSync(join(process.env['KIMI_CODE_HOME']!, 'feedback-survey-state.json'))).toBe(
          true,
        );
      });
    } finally {
      restoreGlobalClock();
      mock.restore();
    }
  });

  it('counts user-slash skill and plugin command turns toward the survey warmup', async () => {
    process.env['KIMI_CODE_HOME'] = await makeTempHome();
    spyOn(Math, 'random').mockReturnValue(0);
    try {
      const { driver } = await makeDriver();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const clock = installGlobalClock();
      const emit = (event: Event) => {
        driver.sessionEventHandler.handleEvent(event, () => {});
      };

      clock.advance(600_000);
      for (let turn = 1; turn <= 5; turn++) {
        emit({
          type: 'turn.started',
          agentId: 'main',
          turnId: turn,
          origin: {
            kind: 'skill_activation',
            activationId: `a${turn}`,
            skillName: 'review',
            trigger: 'model-tool',
          },
        } as Event);
        emit({ type: 'turn.ended', agentId: 'main', turnId: turn, reason: 'completed' } as Event);
      }
      clock.advance(2_000);
      expect(driver.state.surveyContainer.children).toHaveLength(0);

      for (let turn = 6; turn <= 8; turn++) {
        emit({
          type: 'turn.started',
          agentId: 'main',
          turnId: turn,
          origin: {
            kind: 'skill_activation',
            activationId: `a${turn}`,
            skillName: 'review',
            trigger: 'user-slash',
          },
        } as Event);
        emit({ type: 'turn.ended', agentId: 'main', turnId: turn, reason: 'completed' } as Event);
      }
      for (let turn = 9; turn <= 10; turn++) {
        emit({
          type: 'turn.started',
          agentId: 'main',
          turnId: turn,
          origin: {
            kind: 'plugin_command',
            activationId: `p${turn}`,
            pluginId: 'fmt',
            commandName: 'fmt',
            trigger: 'user-slash',
          },
        } as Event);
        emit({ type: 'turn.ended', agentId: 'main', turnId: turn, reason: 'completed' } as Event);
      }
      clock.advance(2_000);
      expect(driver.state.surveyContainer.children).not.toHaveLength(0);

      restoreGlobalClock();
      await waitForAssertion(() => {
        expect(existsSync(join(process.env['KIMI_CODE_HOME']!, 'feedback-survey-state.json'))).toBe(
          true,
        );
      });
    } finally {
      restoreGlobalClock();
      mock.restore();
    }
  });
});

describe('transcript fold block clicks', () => {
  const transcriptWidth = 120;

  function hiddenOutput(name: string): string {
    return [`${name}-body`, `${name}-mid`, `${name}-more`, `${name}-tail`].join('\n');
  }

  function emitBash(
    driver: MessageDriver,
    toolCallId: string,
    command: string,
    output: string,
  ): void {
    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId,
        name: 'Bash',
        args: { command },
      } as Event,
      mock(),
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.result',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId,
        output,
        isError: undefined,
      } as Event,
      mock(),
    );
  }

  function renderFooterLine1(driver: MessageDriver): string {
    return stripSgr(driver.state.footer.render(160)[0] ?? '');
  }

  function clickTranscriptLine(driver: MessageDriver, needle: string): void {
    const lines = driver.state.transcriptContainer.render(transcriptWidth);
    const y = lines.findIndex((line) => stripSgr(line).includes(needle));
    expect(y).toBeGreaterThanOrEqual(0);
    const event: TuiMouseEvent = {
      type: 'click',
      button: 'left',
      x: 2,
      y,
      screenX: 2,
      screenY: y,
      width: transcriptWidth,
      height: lines.length,
      shift: false,
      alt: false,
      ctrl: false,
      clickCount: 1,
    };
    driver.state.transcriptContainer.handleMouse(event);
  }

  it('opens only the clicked tool card while the footer still offers expand', async () => {
    const { driver } = await makeDriver();
    emitBash(driver, 'call_alpha', 'echo alpha', hiddenOutput('alpha'));
    emitBash(driver, 'call_beta', 'echo beta', hiddenOutput('beta'));

    const collapsed = stripSgr(renderTranscript(driver));
    expect(collapsed).toContain('alpha-tail');
    expect(collapsed).not.toContain('alpha-body');
    expect(collapsed).not.toContain('beta-body');
    expect(renderFooterLine1(driver)).toContain('ctrl+o expand');

    clickTranscriptLine(driver, 'alpha-tail');

    const opened = stripSgr(renderTranscript(driver));
    expect(opened).toContain('alpha-body');
    expect(opened).not.toContain('beta-body');
    expect(driver.state.toolOutputExpanded).toBe(false);
    expect(renderFooterLine1(driver)).toContain('ctrl+o expand');

    clickTranscriptLine(driver, 'alpha-body');

    const closed = stripSgr(renderTranscript(driver));
    expect(closed).not.toContain('alpha-body');
    expect(closed).not.toContain('beta-body');
    expect(driver.state.toolOutputExpanded).toBe(false);
    expect(renderFooterLine1(driver)).toContain('ctrl+o expand');
  });

  it('lets ctrl+o overwrite a clicked card and keeps a neighbor open', async () => {
    const { driver } = await makeDriver();
    emitBash(driver, 'call_alpha', 'echo alpha', hiddenOutput('alpha'));
    emitBash(driver, 'call_beta', 'echo beta', hiddenOutput('beta'));

    clickTranscriptLine(driver, 'alpha-tail');
    driver.toggleToolOutputExpansion();

    const expanded = stripSgr(renderTranscript(driver));
    expect(expanded).toContain('alpha-body');
    expect(expanded).toContain('beta-body');
    expect(driver.state.toolOutputExpanded).toBe(true);
    expect(renderFooterLine1(driver)).toContain('ctrl+o collapse');

    clickTranscriptLine(driver, 'alpha-body');

    const oneClosed = stripSgr(renderTranscript(driver));
    expect(oneClosed).not.toContain('alpha-body');
    expect(oneClosed).toContain('beta-body');
    expect(driver.state.toolOutputExpanded).toBe(true);
    expect(renderFooterLine1(driver)).toContain('ctrl+o collapse');

    driver.toggleToolOutputExpansion();

    const collapsed = stripSgr(renderTranscript(driver));
    expect(collapsed).not.toContain('alpha-body');
    expect(collapsed).not.toContain('beta-body');
    expect(driver.state.toolOutputExpanded).toBe(false);
    expect(renderFooterLine1(driver)).toContain('ctrl+o expand');
  });

  it('closes an aged-out open card and does not open it again', async () => {
    const { driver } = await makeDriver();
    emitBash(driver, 'call_old', 'echo old', hiddenOutput('old'));
    driver.toggleToolOutputExpansion();
    expect(stripSgr(renderTranscript(driver))).toContain('old-body');

    for (let i = 0; i < 4; i++) {
      driver.appendTranscriptEntry({
        id: `later-${String(i)}`,
        kind: 'user',
        renderMode: 'plain',
        content: `later turn ${String(i)}`,
      });
    }
    emitBash(driver, 'call_recent', 'echo recent', hiddenOutput('recent'));

    expect(stripSgr(renderTranscript(driver))).toContain('old-body');
    expect(stripSgr(renderTranscript(driver))).toContain('recent-body');

    clickTranscriptLine(driver, 'old-body');

    const oldClosed = stripSgr(renderTranscript(driver));
    expect(oldClosed).not.toContain('old-body');
    expect(oldClosed).toContain('recent-body');
    expect(driver.state.toolOutputExpanded).toBe(true);

    clickTranscriptLine(driver, 'old-tail');
    expect(stripSgr(renderTranscript(driver))).not.toContain('old-body');
    expect(stripSgr(renderTranscript(driver))).toContain('recent-body');

    driver.toggleToolOutputExpansion();
    expect(stripSgr(renderTranscript(driver))).not.toContain('old-body');
    expect(stripSgr(renderTranscript(driver))).not.toContain('recent-body');
    expect(driver.state.toolOutputExpanded).toBe(false);

    driver.toggleToolOutputExpansion();
    const reopened = stripSgr(renderTranscript(driver));
    expect(reopened).not.toContain('old-body');
    expect(reopened).toContain('recent-body');
    expect(renderFooterLine1(driver)).toContain('ctrl+o collapse');
  });

  it('does not change a fold block when the click lands on message text', async () => {
    const { driver } = await makeDriver();
    emitBash(driver, 'call_alpha', 'echo alpha', hiddenOutput('alpha'));
    driver.appendTranscriptEntry({
      id: 'user-plain',
      kind: 'user',
      renderMode: 'plain',
      content: 'plain user sentence',
    });

    clickTranscriptLine(driver, 'plain user sentence');

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('plain user sentence');
    expect(transcript).not.toContain('alpha-body');
    expect(transcript).toContain('alpha-tail');
    expect(driver.state.toolOutputExpanded).toBe(false);
    expect(renderFooterLine1(driver)).toContain('ctrl+o expand');
  });

  it('toggles a long finalized thinking block without advertising it in the footer', async () => {
    const { driver } = await makeDriver();
    const longThinking = ['think-one', 'think-two', 'think-three', 'think-four'].join('\n');
    driver.streamingUI.onThinkingUpdate(longThinking);
    const streaming = stripSgr(renderTranscript(driver));
    expect(streaming).toContain('think-four');
    expect(streaming).not.toContain('think-one');

    clickTranscriptLine(driver, 'think-four');
    expect(stripSgr(renderTranscript(driver))).not.toContain('think-one');

    driver.streamingUI.onThinkingEnd();

    const collapsed = stripSgr(renderTranscript(driver));
    expect(collapsed).toContain('think-one');
    expect(collapsed).not.toContain('think-four');
    expect(renderFooterLine1(driver)).not.toContain('ctrl+o');

    clickTranscriptLine(driver, 'think-one');

    const opened = stripSgr(renderTranscript(driver));
    expect(opened).toContain('think-four');
    expect(renderFooterLine1(driver)).not.toContain('ctrl+o');

    clickTranscriptLine(driver, 'think-four');
    expect(stripSgr(renderTranscript(driver))).not.toContain('think-four');

    driver.toggleToolOutputExpansion();
    expect(stripSgr(renderTranscript(driver))).toContain('think-four');
    expect(renderFooterLine1(driver)).not.toContain('ctrl+o');
    expect(driver.state.toolOutputExpanded).toBe(true);

    driver.toggleToolOutputExpansion();
    expect(stripSgr(renderTranscript(driver))).not.toContain('think-four');
    expect(driver.state.toolOutputExpanded).toBe(false);
    expect(renderFooterLine1(driver)).not.toContain('ctrl+o');
  });

  it('keeps the expand hint when clicked cards are all open', async () => {
    const { driver } = await makeDriver();
    emitBash(driver, 'call_alpha', 'echo alpha', hiddenOutput('alpha'));
    emitBash(driver, 'call_beta', 'echo beta', hiddenOutput('beta'));

    clickTranscriptLine(driver, 'alpha-tail');
    clickTranscriptLine(driver, 'beta-tail');

    const opened = stripSgr(renderTranscript(driver));
    expect(opened).toContain('alpha-body');
    expect(opened).toContain('beta-body');
    expect(driver.state.toolOutputExpanded).toBe(false);
    expect(renderFooterLine1(driver)).toContain('ctrl+o expand');
  });

  it('drops the collapse hint after every open card is clicked shut', async () => {
    const { driver } = await makeDriver();
    emitBash(driver, 'call_alpha', 'echo alpha', hiddenOutput('alpha'));
    emitBash(driver, 'call_beta', 'echo beta', hiddenOutput('beta'));
    driver.toggleToolOutputExpansion();
    expect(renderFooterLine1(driver)).toContain('ctrl+o collapse');

    clickTranscriptLine(driver, 'alpha-body');
    clickTranscriptLine(driver, 'beta-body');

    const closed = stripSgr(renderTranscript(driver));
    expect(closed).not.toContain('alpha-body');
    expect(closed).not.toContain('beta-body');
    expect(driver.state.toolOutputExpanded).toBe(true);
    expect(renderFooterLine1(driver)).not.toContain('ctrl+o');
  });

  it('closes a wrapped ! card that was opened from its preview', async () => {
    const marker = 'shell-tail-marker';
    const stdout = `${'x'.repeat(4000)}${marker}`;
    const runShellCommand = mock(async () => ({ stdout, stderr: '', isError: false }));
    const session = makeSession({ runShellCommand });
    const { driver } = await makeDriver(session);
    driver.state.appState.inputMode = 'bash';
    driver.state.editor.inputMode = 'bash';

    driver.handleUserInput('echo-shell');
    await waitForAssertion(() => {
      const transcript = stripSgr(renderTranscript(driver));
      expect(transcript).toContain('ctrl+o to expand');
      expect(transcript).not.toContain(marker);
    });

    clickTranscriptLine(driver, 'more lines');
    expect(stripSgr(renderTranscript(driver))).toContain(marker);

    clickTranscriptLine(driver, marker);
    const closed = stripSgr(renderTranscript(driver));
    expect(closed).not.toContain(marker);
    expect(closed).toContain('ctrl+o to expand');
    expect(driver.state.toolOutputExpanded).toBe(false);
  });

  it('closes a wide tool card that mounted while the transcript was expanded', async () => {
    const { driver } = await makeDriver();
    driver.toggleToolOutputExpansion();
    const output = `wide-head ${'w'.repeat(500)} wide-tail`;
    emitBash(driver, 'call_wide', 'echo wide', output);

    expect(stripSgr(renderTranscript(driver))).toContain('wide-tail');

    clickTranscriptLine(driver, 'echo wide');

    const closed = stripSgr(renderTranscript(driver));
    expect(closed).not.toContain('wide-tail');
    expect(closed).toContain('wide-head');
    expect(driver.state.toolOutputExpanded).toBe(true);
  });
});
