/**
 * Local type/value mirror of the `@moonshot-ai/agent-core-v2` surface that
 * kimi-inspect consumes (service decorator ids + wire payload shapes).
 *
 * The v2 engine was removed from the repo (P157-P162); this debug tool talks
 * to the `/api/v1/debug` RPC surface, whose channel names are exactly the
 * service decorator ids below, so local re-declarations resolve to the same
 * tokens. Only the subset used by kimi-inspect is included.
 */

// ════════════════════════════════════════════════════════════════════════════
// DI primitives
// ════════════════════════════════════════════════════════════════════════════

export interface ServiceIdentifier<T = unknown> {
  (...args: unknown[]): void;
  type: T;
  id: string;
}

export function createDecorator<T = unknown>(serviceId: string): ServiceIdentifier<T> {
  const fn = function (_target: unknown, _key: string, _index: number): void {};
  (fn as unknown as { id: string }).id = serviceId;
  (fn as unknown as { toString: () => string }).toString = () => serviceId;
  return fn as unknown as ServiceIdentifier<T>;
}

// ════════════════════════════════════════════════════════════════════════════
// Event / disposable primitives
// ════════════════════════════════════════════════════════════════════════════

export interface IDisposable {
  dispose(): void;
}

export interface Event<T> {
  (listener: (event: T) => unknown, thisArg?: unknown, disposables?: IDisposable[]): IDisposable;
}

// ════════════════════════════════════════════════════════════════════════════
// Wire payload types
// ════════════════════════════════════════════════════════════════════════════

export interface Workspace {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastOpenedAt: number;
}

export interface WorkspaceInstancesSnapshot {
  readonly workspaces: readonly WorkspaceInstanceSnapshot[];
}

export interface WorkspaceInstanceSnapshot {
  readonly metadata: Workspace;
  readonly lifecycle: 'materializing' | 'active' | 'closing' | 'disposed';
  readonly program: unknown;
  readonly runtimes: unknown;
}

export interface SessionWorkspaceAssociationSnapshot {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly cwd: string;
}

export interface AgentRuntimeBindingSnapshot {
  readonly binding: {
    readonly workspaceId: string;
    readonly runtimeId: string;
  };
  readonly available: boolean;
  readonly runtime?: {
    readonly generation: number;
    readonly status: string;
    readonly capabilities: readonly string[];
  };
}

export type InspectionSourceKind =
  | 'config'
  | 'override'
  | 'builtin'
  | 'env'
  | 'synthesized'
  | 'none';

export interface InspectionSource {
  readonly kind: InspectionSourceKind;
  readonly detail?: string;
}

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
  readonly inputOther: number;
  readonly reasoningTokens?: number;
  readonly usageMetadata?: unknown;
}

export type UnitState = 'Pending' | 'Activating' | 'Active' | 'Unloading' | 'Failed';

export interface LedgerEntryInfo {
  readonly label: string;
  readonly kind: 'disposer' | 'effect' | 'ledger';
  readonly stack?: string;
  readonly children?: readonly LedgerEntryInfo[];
}

export interface DebugUnit {
  readonly token: string;
  readonly uid: number;
  readonly state?: UnitState;
  readonly error?: string;
  readonly everActive?: boolean;
  readonly inFlight?: boolean;
}

export interface DebugLedgerNode {
  readonly path: string;
  readonly label: string;
  readonly units: DebugUnit[];
  readonly ledger: LedgerEntryInfo[];
  readonly children: DebugLedgerNode[];
}

export interface DebugGraphNode {
  readonly id: string;
  readonly token: string;
  readonly scopePath: string;
  readonly uid?: number;
  readonly state?: UnitState;
}

export interface DebugGraph {
  readonly nodes: DebugGraphNode[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly kind: string }[];
}

export interface DebugCascadeEntry {
  readonly scopePath: string;
  readonly seq: number;
  readonly reason: string;
  readonly changes: ReadonlyArray<{ token: string; action: string }>;
  readonly affected: readonly string[];
  readonly tornDown: readonly string[];
  readonly rebuilt: readonly string[];
  readonly failed: readonly string[];
  readonly abortWaited: boolean;
  readonly abortTimedOut: boolean;
  readonly durationMs: number;
}

export interface DebugPendingUnit {
  readonly token: string;
  readonly missing: string[];
}

export interface DebugFailedUnit {
  readonly token: string;
  readonly error?: string;
}

export interface DebugPendingGroup {
  readonly scopePath: string;
  readonly waiting: DebugPendingUnit[];
  readonly failed: DebugFailedUnit[];
}

export interface DebugEventSubscription {
  readonly scopePath: string;
  readonly unit: string;
  readonly uid?: number;
  readonly label: string;
  readonly kind: LedgerEntryInfo['kind'];
}

export interface DebugEventBusSnapshot {
  readonly scopePath: string;
  readonly all: number;
  readonly perType: Record<string, number>;
}

export interface DebugEventSubscriptions {
  readonly subscriptions: readonly DebugEventSubscription[];
  readonly buses: readonly DebugEventBusSnapshot[];
  readonly globalListeners?: number;
}

export interface ModelPingResult {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly text?: string;
  readonly finishReason?: string;
  readonly usage?: TokenUsage;
  readonly error?: string;
}

export interface ModelInspection {
  readonly model: string;
  readonly provider: string;
  readonly resolved: {
    readonly config?: unknown;
    readonly override?: unknown;
    readonly builtin?: unknown;
    readonly env?: unknown;
  };
  readonly sources: Readonly<Record<string, InspectionSource>>;
}

export interface ModelCatalogItem {
  readonly provider: string;
  readonly model: string;
  readonly display_name?: string;
  readonly max_context_size: number;
  readonly capabilities?: readonly string[];
  readonly support_efforts?: readonly string[];
  readonly default_effort?: string;
}

export interface ProviderCatalogItem {
  readonly id: string;
  readonly type: string;
  readonly base_url?: string;
  readonly default_model?: string;
  readonly has_api_key: boolean;
  readonly status: 'connected' | 'error' | 'unconfigured';
  readonly models?: readonly string[];
}

export interface FsBrowseEntry {
  readonly name: string;
  readonly path: string;
  readonly is_dir: true;
}

export interface FsBrowseResponse {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly FsBrowseEntry[];
}

export interface FsHomeResponse {
  readonly home: string;
  readonly recent_roots: readonly string[];
}

export interface SessionSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd?: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly archivedAt?: number;
  readonly custom?: Record<string, unknown>;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export interface SessionMeta {
  readonly id: string;
  readonly version?: number;
  readonly title?: string;
  readonly titleKind?: 'replaceable' | 'generated' | 'custom';
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly archivedAt?: number;
  readonly cwd?: string;
  readonly forkedFrom?: string;
  readonly agents?: Readonly<Record<string, unknown>>;
}

export interface ApprovalRequest {
  readonly id?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: unknown;
}

export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';

export interface ApprovalResponse {
  readonly decision: ApprovalDecision;
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selectedLabel?: string;
}

export interface QuestionItem {
  readonly question: string;
  readonly header?: string;
  readonly body?: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect?: boolean;
  readonly otherLabel?: string;
  readonly otherDescription?: string;
}

export type QuestionAnswers = Record<string, string | true>;
export type QuestionResult = null | QuestionAnswers | { answers: QuestionAnswers; method?: string };

export interface QuestionRequest {
  readonly id?: string;
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly questions: readonly QuestionItem[];
}

export interface BashSyntaxNode {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly isNamed: boolean;
  readonly children: readonly BashSyntaxNode[];
}

export type BashParseResult =
  | { readonly ok: true; readonly hasError: boolean; readonly root: BashSyntaxNode }
  | { readonly ok: false; readonly reason: string };

// ════════════════════════════════════════════════════════════════════════════
// Service contracts (loose — the RPC layer returns JSON; panels treat results
// as data). Method signatures stay one-name/one-arity so `ServiceProxy` maps
// them to wire calls; return types are the payload shapes above or `unknown`.
// ════════════════════════════════════════════════════════════════════════════

export interface IConfigServiceContract {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidChangeConfiguration: Event<unknown>;
  readonly onDidSectionChange: Event<unknown>;
  readonly onDidChangeDiagnostics: Event<readonly unknown[]>;
  get<T = unknown>(domain: string): T;
  inspect<_T = unknown>(domain: string): unknown;
  getAll(): Record<string, unknown>;
  set(domain: string, patch: unknown): Promise<void>;
  replace(domain: string, value: unknown): Promise<void>;
}

export interface IModelCatalogContract {
  readonly _serviceBrand: undefined;
  get(id: string): unknown;
  inspect(id: string): ModelInspection;
  ping(id: string): Promise<ModelPingResult>;
  findByName(name: string): readonly string[];
  listModels(): Promise<readonly ModelCatalogItem[]>;
  listProviders(): Promise<readonly ProviderCatalogItem[]>;
  getProvider(providerId: string): Promise<ProviderCatalogItem>;
  setDefaultModel(modelId: string): Promise<{ default_model: string; model: ModelCatalogItem }>;
}

export interface IModelServiceContract {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  get(id: string): ModelRecord | undefined;
  list(): Readonly<Record<string, ModelRecord>>;
  getDefaultModel(): string | undefined;
}

export interface ModelRecord {
  readonly providerId?: string;
  readonly provider?: string;
  readonly name?: string;
  readonly aliases?: readonly string[];
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly protocol?: string;
  readonly maxContextSize?: number;
  readonly capabilities?: readonly string[];
  readonly model?: string;
}

export interface IWorkspaceServiceContract {
  readonly _serviceBrand: undefined;
  list(): Promise<readonly Workspace[]>;
  get(id: string): Promise<Workspace | undefined>;
  createOrTouch(root: string, name?: string): Promise<Workspace>;
  update(id: string, patch: { name?: string }): Promise<Workspace | undefined>;
  delete(id: string): Promise<void>;
}

export interface IHostFolderBrowserContract {
  readonly _serviceBrand: undefined;
  browse(absPath?: string): Promise<FsBrowseResponse>;
  home(): Promise<FsHomeResponse>;
}

export interface IWorkspaceTrustContract {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  get(): Promise<boolean>;
  isTrusted(): boolean;
  trust(): Promise<void>;
  untrust(): Promise<void>;
  readonly onDidChange: Event<{ readonly trusted: boolean }>;
}

export interface ISessionManagerContract {
  readonly _serviceBrand: undefined;
  create(options: { workspaceId?: string; workDir: string }): Promise<{ id: string }>;
  resume(sessionId: string): Promise<unknown>;
  get(sessionId: string): unknown;
}

export interface ISessionIndexContract {
  readonly _serviceBrand: undefined;
  prepare(options?: { deadlineMs?: number }): Promise<unknown>;
  status(): unknown;
  get(id: string): Promise<SessionSummary | undefined>;
  listRecent(query: { workspaceIds?: readonly string[] }): Promise<unknown>;
  count(query: unknown): Promise<number>;
  remove(id: string): Promise<void>;
}

export interface ISessionLifecycleServiceContract {
  readonly _serviceBrand: undefined;
  create(opts: { sessionId?: string; workDir: string }): Promise<{ id: string }>;
  get(sessionId: string): unknown;
  list(): readonly unknown[];
  resume(sessionId: string): Promise<unknown>;
}

export interface IAgentPromptServiceContract {
  readonly _serviceBrand: undefined;
  submit(payload: { input: readonly unknown[]; disabledTools?: readonly string[] }): Promise<unknown>;
  list(): unknown;
  steer(promptIds: readonly string[]): Promise<readonly unknown[]>;
  abort(promptId: string): boolean;
  clear(): void;
}

export interface IAgentProfileServiceContract {
  readonly _serviceBrand: undefined;
  update(changed: Record<string, unknown>): void;
  bind(input: { profile: string; model?: string }): Promise<void>;
  setModel(model: string): Promise<{ model: string }>;
  setThinking(level: string): void;
  getModel(): string;
  data(): Record<string, unknown>;
}

export interface ISessionStateServiceContract {
  readonly _serviceBrand: undefined;
  snapshot(): Promise<Record<string, unknown>>;
}

export interface IAgentStateServiceContract {
  readonly _serviceBrand: undefined;
  snapshot(): Promise<Record<string, unknown>>;
  replayableKeys(): readonly unknown[];
}

export interface ISessionApprovalServiceContract {
  readonly _serviceBrand: undefined;
  request(req: ApprovalRequest): Promise<ApprovalResponse>;
  enqueue(req: ApprovalRequest): ApprovalRequest & { readonly id: string };
  decide(id: string, response: ApprovalResponse): void;
  listPending(): readonly ApprovalRequest[];
}

export interface ISessionQuestionServiceContract {
  readonly _serviceBrand: undefined;
  request(req: QuestionRequest): Promise<QuestionResult>;
  enqueue(req: QuestionRequest): QuestionRequest & { readonly id: string };
  answer(id: string, result: QuestionResult): void;
  dismiss(id: string): void;
  listPending(): readonly QuestionRequest[];
}

export interface ISessionMetadataContract {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  read(): Promise<SessionMeta>;
  update(patch: Record<string, unknown>): Promise<void>;
  setTitle(title: string): Promise<void>;
  setArchived(archived: boolean): Promise<void>;
}

export interface IDebugLedgerServiceContract {
  readonly _serviceBrand: undefined;
  tree(): DebugLedgerNode;
}

export interface IDebugGraphServiceContract {
  readonly _serviceBrand: undefined;
  graph(): DebugGraph;
}

export interface IDebugEventsServiceContract {
  readonly _serviceBrand: undefined;
  subscriptions(): DebugEventSubscriptions;
}

export interface IDebugCascadeServiceContract {
  readonly _serviceBrand: undefined;
  history(): DebugCascadeEntry[];
  pending(): DebugPendingGroup[];
  unprovide(scopePath: string, token: string): Promise<void>;
  update(scopePath: string, token: string, config?: unknown): Promise<void>;
  dispose(scopePath: string, token: string): Promise<void>;
}

export interface IAgentLoopServiceContract {
  readonly _serviceBrand: undefined;
  cancelFromUser(turnId?: number): void;
  status(): unknown;
  settled(): Promise<void>;
}

export interface IBashParserServiceContract {
  readonly _serviceBrand: undefined;
  parse(source: string, options?: { timeoutMs?: number; maxNodes?: number }): BashParseResult;
}

// ════════════════════════════════════════════════════════════════════════════
// Service identifiers (wire channel names — same ids as the server registry)
// ════════════════════════════════════════════════════════════════════════════

export const IAgentActivityView = createDecorator<Record<string, unknown>>('agentActivityView');
export const IAgentMcpService = createDecorator<Record<string, unknown>>('agentMcpService');
export const IAgentPermissionModeService =
  createDecorator<Record<string, unknown>>('agentPermissionModeService');
export const IAgentPermissionRulesService =
  createDecorator<Record<string, unknown>>('agentPermissionRulesService');
export const IAgentPlanService = createDecorator<Record<string, unknown>>('agentPlanService');
export const IAgentPromptService = createDecorator<IAgentPromptServiceContract>('agentPromptService');
export const IAgentProfileService = createDecorator<IAgentProfileServiceContract>('agentProfileService');
export const IAgentStateService = createDecorator<IAgentStateServiceContract>('agentStateService');
export const IAgentSwarmService = createDecorator<Record<string, unknown>>('agentSwarmService');
export const IAgentTaskService = createDecorator<Record<string, unknown>>('agentTaskService');
export const IAgentToolRegistryService =
  createDecorator<Record<string, unknown>>('agentToolRegistryService');
export const IAgentLoopService = createDecorator<IAgentLoopServiceContract>('agentLoopService');
export const IAuthSummaryService = createDecorator<Record<string, unknown>>('authSummaryService');
export const IBashParserService = createDecorator<IBashParserServiceContract>('bashParserService');
export const IConfigService = createDecorator<IConfigServiceContract>('configService');
export const IDebugCascadeService =
  createDecorator<IDebugCascadeServiceContract>('debugCascadeService');
export const IDebugEventsService = createDecorator<IDebugEventsServiceContract>('debugEventsService');
export const IDebugGraphService = createDecorator<IDebugGraphServiceContract>('debugGraphService');
export const IDebugLedgerService = createDecorator<IDebugLedgerServiceContract>('debugLedgerService');
export const IFlagService = createDecorator<Record<string, unknown>>('flagService');
export const IHostFolderBrowser = createDecorator<IHostFolderBrowserContract>('hostFolderBrowser');
export const IModelCatalog = createDecorator<IModelCatalogContract>('modelResolver');
export const IModelService = createDecorator<IModelServiceContract>('modelService');
export const IProviderService = createDecorator<Record<string, unknown>>('providerService');
export const ISessionApprovalService =
  createDecorator<ISessionApprovalServiceContract>('sessionApprovalService');
export const ISessionIndex = createDecorator<ISessionIndexContract>('sessionIndex');
export const ISessionInitService = createDecorator<Record<string, unknown>>('sessionInitService');
export const ISessionLifecycleService =
  createDecorator<ISessionLifecycleServiceContract>('sessionLifecycleService');
export const ISessionManager = createDecorator<ISessionManagerContract>('sessionManager');
export const ISessionMetadata = createDecorator<ISessionMetadataContract>('sessionMetadata');
export const ISessionQuestionService =
  createDecorator<ISessionQuestionServiceContract>('sessionQuestionService');
export const ISessionStateService = createDecorator<ISessionStateServiceContract>('sessionStateService');
export const ISessionWorkspaceContext = createDecorator<Record<string, unknown>>('sessionWorkspaceContext');
export const IWorkspaceService = createDecorator<IWorkspaceServiceContract>('workspaceService');
export const IWorkspaceTrust = createDecorator<IWorkspaceTrustContract>('workspaceTrust');