

import { createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, normalize, parse, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { ZipFile } from 'yazl';
import { z } from 'zod';
import {
  isoDateTimeSchema,
  permissionRuleSchema,
  sessionAgentConfigPartialSchema,
  sessionAgentConfigSchema,
  sessionMetadataSchema,
  fsDiffRequestSchema,
  fsDiffResponseSchema,
  fsGitStatusRequestSchema,
  fsGitStatusResponseSchema,
  fsGrepRequestSchema,
  fsGrepResponseSchema,
  fsListManyRequestSchema,
  fsListManyResponseSchema,
  fsListRequestSchema,
  fsListResponseSchema,
  fsMkdirRequestSchema,
  fsMkdirResponseSchema,
  fsReadRequestSchema,
  fsReadResponseSchema,
  fsSearchRequestSchema,
  fsSearchResponseSchema,
  fsStatManyRequestSchema,
  fsStatManyResponseSchema,
  fsStatRequestSchema,
  fsStatResponseSchema,
  fsSuggestRequestSchema,
  fsSuggestResponseSchema,
  modelCatalogItemSchema,
  providerCatalogItemSchema,
  providerRefreshChangeSchema,
  providerRefreshFailureSchema,
  oauthFlowStartSchema,
  oauthFlowSnapshotSchema,
  oauthLoginCancelResponseSchema,
  oauthLogoutResponseSchema,
  promptThinkingSchema,
  promptPermissionModeSchema,
  sessionStatusResponseSchema,
  sessionWarningSchema,
  sessionWarningsResponseSchema,
  updateSessionProfileRequestSchema,
  fsBrowseQuerySchema,
  fsBrowseResponseSchema,
  fsHomeResponseSchema,
  createTerminalRequestSchema,
} from '@moonshot-ai/protocol';
import type {
  PromptPermissionMode,
  PromptThinking,
  SessionAgentConfigPartial,
  SessionStatusResponse,
  SessionWarning,
  SessionWarningsResponse,
} from '@moonshot-ai/protocol';
import type { ContentPart } from '@moonshot-ai/kosong';

export type {
  PromptPermissionMode,
  PromptThinking,
  SessionAgentConfigPartial,
  SessionStatusResponse,
  SessionWarning,
  SessionWarningsResponse,
};

export const fsListBranchesResponseSchema = z.object({}).passthrough();

export {
  isoDateTimeSchema,
  permissionRuleSchema,
  sessionAgentConfigPartialSchema,
  sessionAgentConfigSchema,
  sessionMetadataSchema,
  fsDiffRequestSchema,
  fsDiffResponseSchema,
  fsGitStatusRequestSchema,
  fsGitStatusResponseSchema,
  fsGrepRequestSchema,
  fsGrepResponseSchema,
  fsListManyRequestSchema,
  fsListManyResponseSchema,
  fsListRequestSchema,
  fsListResponseSchema,
  fsMkdirRequestSchema,
  fsMkdirResponseSchema,
  fsReadRequestSchema,
  fsReadResponseSchema,
  fsSearchRequestSchema,
  fsSearchResponseSchema,
  fsStatManyRequestSchema,
  fsStatManyResponseSchema,
  fsStatRequestSchema,
  fsStatResponseSchema,
  fsSuggestRequestSchema,
  fsSuggestResponseSchema,
  modelCatalogItemSchema,
  providerCatalogItemSchema,
  providerRefreshChangeSchema,
  providerRefreshFailureSchema,
  oauthFlowStartSchema,
  oauthFlowSnapshotSchema,
  oauthLoginCancelResponseSchema,
  oauthLogoutResponseSchema,
  promptThinkingSchema,
  promptPermissionModeSchema,
  sessionStatusResponseSchema,
  sessionWarningSchema,
  sessionWarningsResponseSchema,
  updateSessionProfileRequestSchema,
  fsBrowseQuerySchema,
  fsBrowseResponseSchema,
  fsHomeResponseSchema,
  createTerminalRequestSchema,
};

export const managedUserInfoResultSchema = z.object({}).passthrough();
export const managedUsageResultSchema = z.object({}).passthrough();
export const oauthRegionResultSchema = z.object({}).passthrough();
export type ManagedUsageResult = any;
export type UsageRow = any;
export type { ContentPart };





export const ErrorCodes = {
  UNKNOWN: 'internal.unknown',
  REQUEST_INVALID: 'request.invalid',
  VALIDATION_FAILED: 'validation.failed',
  CONFIG_INVALID: 'config.invalid',
  NOT_FOUND: 'resource.not_found',
  FILE_NOT_FOUND: 'file.not_found',
  SESSION_NOT_FOUND: 'session.not_found',
  AGENT_NOT_FOUND: 'agent.not_found',
  MCP_SERVER_NOT_FOUND: 'mcp.server_not_found',
  MCP_OAUTH_FAILED: 'mcp.oauth_failed',
  PROMPT_ID_CONFLICT: 'prompt.id_conflict',
  PROMPT_NOT_FOUND: 'prompt.not_found',
  PROMPT_ALREADY_COMPLETED: 'prompt.already_completed',
  SESSION_BUSY: 'session.busy',
  INTERNAL: 'internal.error',
  NOT_IMPLEMENTED: 'internal.not_implemented',
  STORAGE_IO_FAILED: 'storage.io_failed',
  STORAGE_LOCKED: 'storage.locked',
  TERMINAL_NOT_FOUND: 'terminal.not_found',
  FS_PATH_ESCAPES: 'fs.path_escapes',
  FS_PATH_NOT_FOUND: 'fs.path_not_found',
  FS_IS_DIRECTORY: 'fs.is_directory',
  FS_IS_BINARY: 'fs.is_binary',
  FS_TOO_LARGE: 'fs.too_large',
  FS_TOO_MANY_RESULTS: 'fs.too_many_results',
  FS_ALREADY_EXISTS: 'fs.already_exists',
  FS_GREP_TIMEOUT: 'fs.grep_timeout',
  FS_GIT_UNAVAILABLE: 'fs.git_unavailable',
  OS_FS_NOT_FOUND: 'os_fs.not_found',
  OS_FS_NOT_DIRECTORY: 'os_fs.not_directory',
  OS_FS_IS_DIRECTORY: 'os_fs.is_directory',
  OS_FS_ALREADY_EXISTS: 'os_fs.already_exists',
  OS_FS_PERMISSION_DENIED: 'os_fs.permission_denied',
  OS_FS_UNKNOWN: 'os_fs.unknown',
  OS_FS_NOT_EMPTY: 'os_fs.not_empty',
  OS_FS_UNAVAILABLE: 'os_fs.unavailable',
  SKILL_NOT_FOUND: 'skill.not_found',
  SKILL_NAME_EMPTY: 'skill.name_empty',
  SKILL_TYPE_UNSUPPORTED: 'skill.type_unsupported',
  GOAL_ALREADY_EXISTS: 'goal.already_exists',
  GOAL_NOT_FOUND: 'goal.not_found',
  GOAL_STATUS_INVALID: 'goal.status_invalid',
  GOAL_NOT_RESUMABLE: 'goal.not_resumable',
  GOAL_OBJECTIVE_EMPTY: 'goal.objective_empty',
  GOAL_OBJECTIVE_TOO_LONG: 'goal.objective_too_long',
  GOAL_UNSUPPORTED_AGENT: 'goal.unsupported_agent',
  SESSION_UNDO_UNAVAILABLE: 'session.undo_unavailable',
  SESSION_TOWER_MODE_INVALID: 'session.tower_mode_invalid',
  CONFLICT: 'conflict',
};

export class Error2 extends Error {
  readonly code: number | string;
  readonly details?: unknown;
  constructor(code: number | string, message: string, details?: unknown) {
    super(message);
    this.name = 'Error2';
    this.code = code;
    this.details = details;
  }
}

export function isError2(err: unknown): err is Error2 {
  if (!(err instanceof Error)) return false;
  const c = (err as { code?: unknown }).code;
  return typeof c === 'number' || typeof c === 'string';
}

export class RuntimeError extends Error2 {
  constructor(code: number, message: string) {
    super(code, message);
    this.name = 'RuntimeError';
  }
}

export const ModelsDevImportErrors = {
  codes: {
    CATALOG_UNAVAILABLE: 'catalog.unavailable',
    CATALOG_ENTRY_NOT_FOUND: 'catalog.entry_not_found',
    CATALOG_IMPORT_INVALID: 'catalog.import_invalid',
    REGISTRY_IMPORT_INVALID: 'registry.import_invalid',
    PROVIDER_OAUTH_MANAGED: 'provider.oauth_managed',
  },
};

export const PluginErrors = {
  codes: {
    PLUGIN_NOT_FOUND: 'plugin.not_found',
    PLUGIN_LOAD_FAILED: 'plugin.load_failed',
  },
};

export const DomainErrorCodes = {
  VALIDATION_FAILED: 'validation.failed',
};

export const CapabilityErrors = {
  codes: {
    CAPABILITY_NOT_FOUND: 'capability.not_found',
    CAPABILITY_UNSUPPORTED: 'capability.unsupported',
    CAPABILITY_INSTALL_IN_PROGRESS: 'capability.install_in_progress',
    CAPABILITY_INSTALL_FAILED: 'capability.install_failed',
  },
  disabled: (name: string) => new Error2(40001, `Capability disabled: ${name}`),
};





export function resolveKimiHome(homeDir?: string): string {
  return homeDir ?? process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
}

export function resolveConfigPath(
  homeDirOrOpts?: string | { homeDir?: string; configPath?: string },
): string {
  const homeDir =
    typeof homeDirOrOpts === 'string' ? homeDirOrOpts : (homeDirOrOpts?.homeDir ?? resolveKimiHome());
  return join(homeDir, 'config.toml');
}

export function resolveLoggingConfig(opts: { homeDir?: string; env?: NodeJS.ProcessEnv }) {
  return {
    homeDir: opts.homeDir ?? resolveKimiHome(),
    env: opts.env ?? process.env,
  };
}

export enum LifecycleScope {
  App = 'app',
  Workspace = 'workspace',
  Session = 'session',
  Agent = 'agent',
}

export function registerFlagDefinition(_def: any): void {}

export function logSeed(_config: unknown): readonly ScopeSeed[] {
  return [];
}

const MAX_WORKDIR_SLUG_LENGTH = 40;
const WORKDIR_KEY_PREFIX = 'wd_';
const HASH_LENGTH = 12;

export function slugifyWorkDirName(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, MAX_WORKDIR_SLUG_LENGTH)
    .replaceAll(/^-+|-+$/g, '');
  return slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
}

export function encodeWorkDirKey(workDir: string): string {
  const normalized = workDir.replaceAll(/\\/g, '/').replace(/\/+$/, '');
  const base = normalized.split('/').pop() ?? normalized;
  const slug = slugifyWorkDirName(base);
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}

export function workspaceRootKey(root: string): string {
  const slashed = root.replaceAll('\\', '/');
  const shaped = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/.test(slashed);
  const normalized = slashed.replace(/\/+$/, '');
  return shaped ? normalized.toLowerCase() : normalized;
}

export function isSensitiveFile(filepath: string): boolean {
  const base = filepath.toLowerCase();
  return base.includes('.env') || base.includes('id_rsa') || base.includes('credentials');
}

export function sniffMediaFromMagic(buffer: Buffer | Uint8Array): { mimeType: string; extension: string } | null {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (buf.length >= 6 && buf.toString('ascii', 0, 6).startsWith('GIF8')) {
    return { mimeType: 'image/gif', extension: 'gif' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return null;
}

export function matchSingleMediaPathTag(
  text: string,
): { kind: string; path: string } | undefined {
  const match = /^\s*<(image|video|audio|file)\b[^>]*?\bpath="([^"]*)"[^>]*>(?:<\/\1>)?\s*$/.exec(text);
  if (match === null) return undefined;
  return { kind: match[1]!, path: match[2]! };
}

export function classifyTextSample(sample: Uint8Array): {
  encoding: string;
  confidence: number;
  isBinary: boolean;
} {
  if (sample.length === 0) return { encoding: 'utf-8', confidence: 1, isBinary: false };
  if (sample.includes(0)) return { encoding: 'utf-8', confidence: 1, isBinary: true };
  let end = sample.length;
  for (let i = Math.max(0, sample.length - 3); i < sample.length; i++) {
    const b = sample[i]!;
    const expected =
      b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    if (expected === 0 || i + expected <= sample.length) continue;
    let validPrefix = true;
    for (let j = i + 1; j < sample.length; j++) {
      const cb = sample[j]!;
      if (cb < 0x80 || cb > 0xbf) {
        validPrefix = false;
        break;
      }
    }
    if (validPrefix) {
      end = i;
      break;
    }
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, end));
  } catch {
    return { encoding: 'utf-8', confidence: 0, isBinary: true };
  }
  let nonPrintable = 0;
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    total++;
    if (cp === 9 || cp === 10 || cp === 13) continue;
    if (cp < 32 || (cp >= 0x7f && cp <= 0x9f)) nonPrintable++;
  }
  if (total > 0 && nonPrintable / total > 0.3) {
    return { encoding: 'utf-8', confidence: 0, isBinary: true };
  }
  return { encoding: 'utf-8', confidence: 1, isBinary: false };
}





export interface ServiceIdentifier<T = unknown> {
  (...args: unknown[]): void;
  type: T;
  id: string;
}

const allDecorators = new Map<string, ServiceIdentifier<any>>();

export function createDecorator<T = unknown>(serviceId: string): ServiceIdentifier<T> {
  const existing = allDecorators.get(serviceId);
  if (existing) return existing as ServiceIdentifier<T>;
  const fn = function (target: any, _key: string | undefined, index: number): void {
    if (typeof target === 'function' && typeof index === 'number') {
      if (!target._paramServiceIds) target._paramServiceIds = [];
      target._paramServiceIds[index] = fn;
    }
  };
  (fn as unknown as { id: string }).id = serviceId;
  (fn as unknown as { toString: () => string }).toString = () => serviceId;
  allDecorators.set(serviceId, fn as unknown as ServiceIdentifier<T>);
  return fn as unknown as ServiceIdentifier<T>;
}

export interface Scope {
  readonly accessor: {
    get<T>(id: ServiceIdentifier<T>): T;
  };
  get<T>(id: ServiceIdentifier<T>): T;
  dispose(): void;
}

export type ScopeSeed = ReadonlyArray<readonly [ServiceIdentifier<any>, unknown]>;

const stringRecordSchema = z.record(z.string(), z.string());
const mcpTimeoutMsSchema = z.number().int().min(1).max(2_147_483_647);
const mcpServerCommonFields = {
  enabled: z.boolean().optional(),
  startupTimeoutMs: mcpTimeoutMsSchema.optional(),
  toolTimeoutMs: mcpTimeoutMsSchema.optional(),
  enabledTools: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
};

export const McpServerStdioConfigSchema = z.object({
  transport: z.literal('stdio'),
  runtime_id: z.string().min(1).optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: stringRecordSchema.optional(),
  cwd: z.string().optional(),
  executor: z.enum(['local', 'kaos']).optional(),
  ...mcpServerCommonFields,
});

export const McpServerHttpConfigSchema = z.object({
  transport: z.literal('http'),
  url: z.string().url(),
  headers: stringRecordSchema.optional(),
  auth: z.literal('oauth').optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  ...mcpServerCommonFields,
});

export const McpServerSseConfigSchema = z.object({
  transport: z.literal('sse'),
  url: z.string().url(),
  headers: stringRecordSchema.optional(),
  auth: z.literal('oauth').optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  ...mcpServerCommonFields,
});

export type IMcpManagementService = AnyService;
export const IMcpManagementService = createDecorator<AnyService>('mcpManagementService');

export const IEngineOverrideService = createDecorator<AnyService>('engineOverrideService');
export const IFileSystemStorageService = createDecorator<AnyService>('fileSystemStorageService');
export const ISessionLifecycleService = createDecorator<AnyService>('sessionLifecycleService');
export const makeAgentScopeContext = (opts: any, _b?: any) => ({
  agentContext: { id: opts?.agentId ?? '', agentScope: opts?.agentScope, ...opts },
});
export type BootstrapInput = any;

type AnyService = any;
export interface IAppendLogStore {
  read<T>(scope: unknown, key: string): AsyncIterable<T>;
  drainRetirements(): Promise<void>;
}
export const IAppendLogStore = createDecorator<IAppendLogStore>('appendLogStore');
export interface IConfigService {
  readonly ready: Promise<unknown>;
  inspect<T>(section: string): { userValue?: T; value?: T };
  get<T>(section: string): T | undefined;
  getAll(): any;
  set(section: string, value: unknown): Promise<void>;
  replace(section: string, value: unknown): Promise<void>;
  reload(): Promise<void>;
  diagnostics(): readonly ConfigDiagnostic[];
  onDidChangeDiagnostics(listener: (...args: any[]) => void): IDisposable;
  onDidChangeConfiguration(listener: (...args: any[]) => void): IDisposable;
  onDidSectionChange(listener: (...args: any[]) => void): IDisposable;
  onDidChange: unknown;
}
export const IConfigService = createDecorator<IConfigService>('configService');
export type IEventService = AnyService;
export const IEventService = createDecorator<IEventService>('eventService');
export type IMcpOAuthService = AnyService;
export const IMcpOAuthService = createDecorator<IMcpOAuthService>('mcpOAuthService');
export type IOAuthService = AnyService;
export const IOAuthService = createDecorator<IOAuthService>('oauthService');
export type IProviderDiscoveryService = AnyService;
export const IProviderDiscoveryService = createDecorator<IProviderDiscoveryService>('providerDiscoveryService');
export type ISessionIndex = AnyService;
export const ISessionIndex = createDecorator<ISessionIndex>('sessionIndex');
export type ISessionIndexMirror = AnyService;
export const ISessionIndexMirror = createDecorator<ISessionIndexMirror>('sessionIndexMirror');
export type ICapabilityService = AnyService;
export const ICapabilityService = createDecorator<ICapabilityService>('capabilityService');
export type IPluginService = AnyService;
export const IPluginService = createDecorator<IPluginService>('pluginService');
export type IWorkspaceService = AnyService;
export const IWorkspaceService = createDecorator<IWorkspaceService>('workspaceService');
export const IFileService = createDecorator<IFileService>('fileService');
export type IAuthLegacyService = AnyService;
export const IAuthLegacyService = createDecorator<IAuthLegacyService>('authLegacyService');
export type IAgentCronService = AnyService;
export const IAgentCronService = createDecorator<IAgentCronService>('agentCronService');
export type IFeatureManager = AnyService;
export const IFeatureManager = createDecorator<IFeatureManager>('featureManager');
export type IFlagService = AnyService;
export const IFlagService = createDecorator<IFlagService>('flagService');
export type ISessionManager = AnyService;
export const ISessionManager = createDecorator<ISessionManager>('sessionManager');
export type ISessionMetadata = AnyService;
export const ISessionMetadata = createDecorator<ISessionMetadata>('sessionMetadata');
export type IAgentLifecycleService = AnyService;
export const IAgentLifecycleService = createDecorator<IAgentLifecycleService>('agentLifecycleService');
export type ILogService = AnyService;
export const ILogService = createDecorator<ILogService>('logService');
export type IBootstrapService = AnyService;
export const IBootstrapService = createDecorator<IBootstrapService>('bootstrapService');
export const ScopeActivation = { eager: 'eager', lazy: 'lazy', OnDemand: 'on_demand' };

const appScopedFactories = new Map<string, (scope: Scope) => any>();

export function registerScopedService(
  _lifecycleScope: any,
  id: ServiceIdentifier<any>,
  ctor: any,
  _activation?: any,
  _name?: string,
): void {
  appScopedFactories.set(id.id, (scope) => {
    const deps = (ctor._paramServiceIds ?? []).map((depId: any) => scope.accessor.get(depId));
    return new ctor(...deps);
  });
}
export function sessionDirOf(..._args: string[]): string {
  return join(..._args.filter((part) => !!part));
}
export function workspacePersistenceScope(scope: any, workspaceId?: any): any {
  const base = typeof scope === 'string' && scope.length > 0 ? scope : 'sessions';
  return typeof workspaceId === 'string' && workspaceId.length > 0 ? join(base, workspaceId) : base;
}

export class Event2<T = unknown> {
  readonly type: string;
  readonly payload: T;
  readonly time?: number;
  [key: string]: any;
  constructor(init: { payload: T; type: string; time?: number }) {
    this.type = init.type;
    this.payload = init.payload;
    if (init.time !== undefined) this.time = init.time;
  }
}

export class SessionCreated extends Event2<unknown> {
  constructor(init: { payload: unknown; time?: number }) {
    super({ payload: init.payload, type: 'event.session.created', time: init.time });
  }
}

export class ConfigWarning extends Event2<unknown> {
  constructor(init: { payload: unknown; time?: number }) {
    super({ payload: init.payload, type: 'event.config.warning', time: init.time });
  }
}

export class CapabilityChanged extends Event2<unknown> {
  constructor(init: { payload: unknown; time?: number }) {
    super({ payload: init.payload, type: 'event.capability.changed', time: init.time });
  }
}

export class PluginChanged extends Event2<unknown> {
  constructor(init: { payload: unknown; time?: number }) {
    super({ payload: init.payload, type: 'event.plugin.changed', time: init.time });
  }
}

export class ConfigChanged extends Event2<{
  changedFields?: string[];
  config?: any;
  [key: string]: any;
}> {
  constructor(init: { payload: unknown; time?: number }) {
    super({
      payload: init.payload as { changedFields?: string[]; config?: any; [key: string]: any },
      type: 'event.config.changed',
      time: init.time,
    });
  }
}

export class SessionMetaUpdated extends Event2<unknown> {
  constructor(init: { payload: unknown; time?: number }) {
    super({ payload: init.payload, type: 'session.meta.updated', time: init.time });
  }
}

export class Disposable {
  dispose(): void {}
}

export const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export async function drainQueryStoreDisposals(): Promise<void> {}
export async function drainSessionMetadataWrites(): Promise<void> {}
export async function drainSessionIndexMirror(): Promise<void> {}
export async function drainLogCloses(): Promise<void> {}

export interface ConfigDiagnostic {
  readonly domain?: string;
  readonly severity: 'warning' | 'error';
  readonly message: string;
}

interface InMemoryWorkspace {
  id: string;
  root: string;
  name: string;
  createdAt: number;
  lastOpenedAt: number;
  sessionCount: number;
}

interface InMemorySessionMeta {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  archivedAt?: number;
  lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  lastPrompt?: string;
  parentId?: string;
  agents?: Record<string, { type?: string; parentAgentId?: string | null; labels?: Record<string, unknown>; homedir?: string }>;
  custom: Record<string, unknown>;
}

const sessionDataStore = new Map<
  string,
  {
    cronTasks: Map<string, any>;
    recordedPrompts: string[];
    wireRecords?: { agentId: string; record: any }[];
  }
>();

function sessionDataOf(sessionId: string): NonNullable<ReturnType<typeof sessionDataStore.get>> {
  let data = sessionDataStore.get(sessionId);
  if (!data) {
    data = { cronTasks: new Map<string, any>(), recordedPrompts: [] };
    sessionDataStore.set(sessionId, data);
  }
  return data;
}

function wireRecordsOf(sessionId: string): { agentId: string; record: any }[] {
  const data = sessionDataOf(sessionId);
  if (!data.wireRecords) data.wireRecords = [];
  return data.wireRecords;
}

export function bootstrap(
  opts: {
    homeDir: string;
    configPath?: string;
    env?: NodeJS.ProcessEnv;
    clientIdentity?: unknown;
    args?: any;
  },
  seeds?: readonly unknown[],
): { app: Scope } {
  const serviceMap = new Map<string, unknown>();
  if (seeds) {
    for (const item of seeds) {
      const seed = item as readonly [ServiceIdentifier<any>, unknown];
      serviceMap.set(seed[0].id, seed[1]);
    }
  }

  void mkdir(join(opts.homeDir, 'cache'), { recursive: true }).catch(() => {});

  const createMockList = () => {
    const arr: any = [];
    arr.active = undefined;
    arr.pending = [];
    return arr;
  };

  const defaultMock = (_id: string) => ({
    _serviceBrand: undefined,
    list: () => createMockList(),
    get: async () => undefined,
    getAll: () => ({}),
    prepare: async () => {},
    diagnostics: () => [],
    subscribe: () => ({ dispose: () => {} }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    onDidSectionChange: () => ({ dispose: () => {} }),
    onDidChangeDiagnostics: () => ({ dispose: () => {} }),
    setLiveTranscriptSource: () => {},
    publish: () => {},
    getEnv: () => undefined,
    drain: async () => {},
    shutdown: async () => {},
    drainRetirements: async () => {},
    onDidReload: () => ({ dispose: () => {} }),
    onDidChangeInstall: () => ({ dispose: () => {} }),
    getRegion: () => undefined,
    ready: Promise.resolve(),
    has: () => false,
    enabled: () => false,
    getDefaultModel: () => undefined,
    dispose: () => {},
    flush: async () => {},
    delete: async () => {},
    warn: () => {},
    info: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    open: async () => {},
    onDidChange: () => ({ dispose: () => {} }),
    snapshot: () => ({}),
    listRecent: async () => ({ items: [], nextCursor: undefined }),
    status: () => ({ state: 'ready', generation: 1 }),
    count: async () => 0,
    remove: async () => {},
    undo: async () => undefined,
    activate: async () => {},
    listSkills: async () => [],
    listCapabilities: async () => [],
    listPlugins: async () => [],
    resolveAliasIds: async () => [],
    all: async () => [],
    read: async () => undefined,
    setTitle: async () => {},
    search: async () => ({ items: [] }),
    browse: async () => undefined,
    home: async () => undefined,
    stat: async () => undefined,
    acquire: async () => undefined,
    createLocalRuntime: async () => undefined,
    export: async () => undefined,
    start: async () => undefined,
    decide: async () => undefined,
    getTask: async () => undefined,
    getProvider: async () => undefined,
    contentAt: async () => undefined,
    cancelFromUser: async () => undefined,
    ensureReady: async () => {},
    getAgentsMdWarning: () => undefined,
    getModel: () => undefined,
    getFlow: async () => undefined,
    cancelLogin: async () => {},
    logout: async () => {},
    getManagedUsage: async () => undefined,
    getManagedUserInfo: async () => undefined,
    resolve: async () => undefined,
    installPlugin: async () => {},
    listModelsDevProviders: async () => [],
    getModelsDevProvider: async () => undefined,
    importModelsDevProvider: async () => undefined,
    importCustomRegistry: async () => undefined,
    getOrCreate: async () => undefined,
    push: () => {},
    state: () => ({}),
    track: () => {},
    withContext: () => ({ track: () => {}, track2: () => {} }),
    now: () => Date.now(),
    close: async () => {},
    enter: async () => undefined,
    restore: async () => undefined,
    createChild: async () => undefined,
  });

  const inMemoryWorkspaces = new Map<string, InMemoryWorkspace>();
  const inMemorySessions = new Map<string, InMemorySessionMeta>();
  const liveSessionHandles = new Map<string, ISessionScopeHandle>();
  const sessionCloseEmitters = new Emitter<{ sessionId: string }>();
  const sessionArchiveEmitters = new Emitter<{ sessionId: string }>();

  function createAgentHandle(agentId: string, _sessionDir: string, sessionId: string): IAgentScopeHandle {
    const eventBusListeners = new Set<(e: any) => void>();
    const eventBus = {
      publish: (e: any) => {
        for (const l of Array.from(eventBusListeners)) l(e);
      },
      emit: (e: any) => {
        for (const l of Array.from(eventBusListeners)) l(e);
      },
      subscribe: (cb: (e: any) => void) => {
        eventBusListeners.add(cb);
        return {
          dispose: () => {
            eventBusListeners.delete(cb);
          },
        };
      },
    };

    let currentModel = 'stub';
    let currentThinking = 'off';
    let currentPermission: PermissionMode = 'default';
    let isPlanActive = false;
    let isSwarmActive = false;
    let isTowerActive = false;

    let goalState: any = { status: 'active', objective: '' };
    const goalService = {
      status: () => (goalState.objective ? goalState : null),
      getGoal: async () => (goalState.objective ? goalState : null),
      createGoal: async (opt: { objective: string }) => {
        if (goalState.objective && goalState.status !== 'cancelled') {
          throw new Error2(ErrorCodes.GOAL_ALREADY_EXISTS, 'goal already exists');
        }
        goalState = { status: 'active', objective: opt.objective };
        return goalState;
      },
      pauseGoal: async () => {
        goalState = { ...goalState, status: 'paused' };
        return goalState;
      },
      resumeGoal: async () => {
        goalState = { ...goalState, status: 'active' };
        eventBus.publish(
          new TurnStarted({
            agentId,
            turnId: Date.now(),
            origin: { kind: 'system_trigger', name: 'goal_continuation' },
          }),
        );
        return goalState;
      },
      markBlocked: async (req: any) => {
        goalState = { ...goalState, status: 'blocked', reason: req?.reason };
        return goalState;
      },
      cancelGoal: async () => {
        goalState = { ...goalState, status: 'cancelled' };
        return goalState;
      },
    };

    let sessionData = sessionDataStore.get(sessionId);
    if (!sessionData) {
      sessionData = { cronTasks: new Map<string, any>(), recordedPrompts: [] };
      sessionDataStore.set(sessionId, sessionData);
    }
    const cronTasks = sessionData.cronTasks;
    const cronService = {
      addTask: (task: any) => {
        const id = 'cron_' + Math.random().toString(36).slice(2, 10);
        const t = { id, ...task, createdAt: Date.now() };
        cronTasks.set(id, t);
        void appendFile(
          join(_sessionDir, 'agents', agentId, 'wire.jsonl'),
          JSON.stringify({ type: 'cron.add', task: t, time: Date.now() }) + '\n',
        ).catch(() => {});
        return t;
      },
      list: () => Array.from(cronTasks.values()),
      removeTask: (id: string) => {
        const existed = cronTasks.delete(id);
        if (existed) {
          void appendFile(
            join(_sessionDir, 'agents', agentId, 'wire.jsonl'),
            JSON.stringify({ type: 'cron.delete', ids: [id], time: Date.now() }) + '\n',
          ).catch(() => {});
        }
        return existed;
      },
    };

    const registeredTools: any[] = [
      { name: 'Read', description: 'Read a file', parameters: {}, source: 'builtin' },
      { name: 'Write', description: 'Write a file', parameters: {}, source: 'builtin' },
      { name: 'Edit', description: 'Edit a file', parameters: {}, source: 'builtin' },
      { name: 'Bash', description: 'Run a shell command', parameters: {}, source: 'builtin' },
    ];
    const toolRegistryService = {
      list: () => registeredTools,
      register: (tool: any, meta: any) => {
        registeredTools.push({
          name: tool.name,
          description: tool.description ?? '',
          parameters: tool.parameters ?? {},
          source: meta?.source ?? 'builtin',
          ...tool,
        });
      },
    };

    const toolPolicyService = {
      isToolActive: (_name: string, _source: string) => true,
    };

    const contextMessages: any[] = [];
    const agentContextMemoryService = {
      get: () => contextMessages,
      read: () => ({ messages: contextMessages }),
      append: (...msgs: any[]) => {
        contextMessages.push(...msgs);
        const records = wireRecordsOf(sessionId);
        for (const m of msgs) {
          records.push({
            agentId,
            record: { type: 'context.append_message', message: m, time: Date.now() },
          });
        }
      },
    };

    const undoService = {
      async undoService(_count?: number) {
        throw new Error2(ErrorCodes.SESSION_UNDO_UNAVAILABLE, 'nothing to undo');
      },
      undo(_count?: number) {
        return this.undoService(_count);
      },
    };

    const loopService = {
      status: () => ({ state: 'ready' }),
      cancelFromUser: () => {},
    };

    const compactionService = {
      begin: () => {},
    };

    const mcpService = {
      list: () => [],
    };

    const wireService = {
      flush: async () => {
        const records = wireRecordsOf(sessionId);
        const mine: any[] = [];
        for (let i = records.length - 1; i >= 0; i--) {
          if (records[i]!.agentId === agentId) {
            mine.unshift(records[i]!.record);
            records.splice(i, 1);
          }
        }
        if (mine.length === 0) return;
        const wirePath = join(_sessionDir, 'agents', agentId, 'wire.jsonl');
        const lines = mine.map((r) => JSON.stringify(r) + '\n').join('');
        await mkdir(dirname(wirePath), { recursive: true }).catch(() => {});
        await appendFile(wirePath, lines, 'utf8').catch(() => {});
      },
      write: async (record: any) => {
        wireRecordsOf(sessionId).push({ agentId, record });
      },
    };

    const planService = {
      status: async () => (isPlanActive ? {} : null),
      enter: async () => {
        isPlanActive = true;
      },
      exit: () => {
        isPlanActive = false;
      },
    };

    const swarmService = {
      get isActive() {
        return isSwarmActive;
      },
      enter: (_mode?: string) => {
        isSwarmActive = true;
      },
      exit: () => {
        isSwarmActive = false;
      },
    };

    const towerService = {
      get isActive() {
        return isTowerActive;
      },
      enter: async (_base?: string) => {
        isTowerActive = false;
      },
      exit: () => {
        isTowerActive = false;
      },
    };

    const profileService = {
      getModelCapabilities: () => ({ max_input_tokens: 131072, max_context_tokens: 131072 }),
      getModel: () => currentModel,
      setModel: async (m: string) => {
        currentModel = m;
      },
      setThinking: (t: string) => {
        currentThinking = t;
      },
      getThinking: () => currentThinking,
      getAgentsMdWarning: () => undefined,
    };

    const usageService = {
      status: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    };

    const tokenCountingService = {
      statusSize: () => 0,
    };

    const agentLifecycle = {
      broadcastPermissionMode: (mode: PermissionMode) => {
        currentPermission = mode;
      },
      getPermissionMode: () => currentPermission,
    };

    const permissionModeService = {
      getMode: () => currentPermission,
      setMode: (mode: PermissionMode) => {
        currentPermission = mode;
      },
    };

    const taskService = {
      list: (_activeOnly?: boolean) => [],
      getTask: (_id: string) => undefined,
      readOutput: async (_id: string, _tail?: number) => ({ preview: '', hasMore: false }),
      stopByUser: async (_id: string) => {},
      detach: (_id: string) => undefined,
      onTaskEvent: () => ({ dispose: () => {} }),
    };

    let activePrompt: any = undefined;
    const pendingPrompts: any[] = [];
    const promptService = {
      list: () => ({
        active: activePrompt,
        pending: pendingPrompts,
      }),
      enqueue: (handle: any) => {
        if (!activePrompt) {
          activePrompt = handle;
        } else {
          pendingPrompts.push(handle);
        }
      },
      dequeue: () => {
        activePrompt = pendingPrompts.shift();
        return activePrompt;
      },
      clear: () => {
        activePrompt = undefined;
        pendingPrompts.length = 0;
      },
    };

    const agentServices = new Map<string, unknown>([
      [IEventBus.id, eventBus],
      [IAgentGoalService.id, goalService],
      [IAgentCronService.id, cronService],
      [IAgentTaskService.id, taskService],
      [IAgentPromptService.id, promptService],
      [IAgentToolRegistryService.id, toolRegistryService],
      [IAgentToolPolicyService.id, toolPolicyService],
      [IAgentContextMemoryService.id, agentContextMemoryService],
      [IAgentConversationUndoService.id, undoService],
      [IAgentLoopService.id, loopService],
      [IAgentFullCompactionService.id, compactionService],
      [IAgentMcpService.id, mcpService],
      [IWireService.id, wireService],
      [IAgentPlanService.id, planService],
      [IAgentSwarmService.id, swarmService],
      [IAgentTowerService.id, towerService],
      [IAgentProfileService.id, profileService],
      [ISessionUsageService.id, usageService],
      [ISessionTokenCountingService.id, tokenCountingService],
      [IAgentLifecycleService.id, agentLifecycle],
      [IAgentPermissionModeService.id, permissionModeService],
      [IAgentScopeContext.id, { scope: () => ({ sessionDir: _sessionDir, agentId }) }],
      [IAgentBlobService.id, { loadParts: async (parts: any) => parts }],
      [IAuthSummaryService.id, { ensureReady: async () => {}, status: async () => ({}) }],
    ]);

    const agentHandle: IAgentScopeHandle = {
      id: agentId,
      accessor: {
        get<T>(id: ServiceIdentifier<T>): T {
          return (agentServices.get(id.id) ?? defaultMock(id.id)) as T;
        },
      },
    };
    return agentHandle;
  }

  function createSessionScopeHandle(
    meta: InMemorySessionMeta,
    sessionDir: string,
  ): ISessionScopeHandle {
    const agents = new Map<string, IAgentScopeHandle>();
    agents.set(MAIN_AGENT_ID, createAgentHandle(MAIN_AGENT_ID, sessionDir, meta.id));

    const interactions = new Map<string, Interaction>();
    const recentlyResolved = new Map<string, any>();
    const pendingChangeEmitter = new Emitter<any>();
    const resolveEmitter = new Emitter<any>();

    let activityState: SessionActivityState = {
      busy: false,
      mainTurnActive: false,
      pendingInteraction: 'none',
    };
    const activityEmitter = new Emitter<SessionActivityState>();

    const metadataService = {
      read: async () => ({ ...meta, agents: meta.agents }),
      setTitle: async (t: string) => {
        meta.title = t;
        meta.updatedAt = Date.now();
      },
      setCustom: async (k: string, v: unknown) => {
        meta.custom[k] = v;
        meta.updatedAt = Date.now();
      },
      update: async (patch: any) => {
        if (patch.custom) {
          const preservedCwd = meta.custom['cwd'];
          meta.custom = { ...patch.custom };
          if (preservedCwd !== undefined && meta.custom['cwd'] === undefined) {
            meta.custom['cwd'] = preservedCwd;
          }
        }
        if (patch.title !== undefined) {
          meta.title = patch.title;
        }
        meta.updatedAt = Date.now();
        return { ...meta };
      },
      entries: async () => [],
      describeAgent: () => undefined,
    };

    const stateJsonPath = join(opts.homeDir, 'sessions', meta.workspaceId, meta.id, 'state.json');
    const persistAgents = async (): Promise<void> => {
      try {
        const raw = await readFile(stateJsonPath, 'utf8');
        const data = JSON.parse(raw);
        data.agents = { ...data.agents, ...meta.agents };
        await writeFile(stateJsonPath, JSON.stringify(data));
      } catch {}
    };

    const contextService = {
      workspaceId: meta.workspaceId,
      cwd: (meta.custom['cwd'] as string | undefined) ?? sessionDir,
      sessionDir,
    };

    const activityView = {
      state: () => ({ ...activityState }),
      push: (patch: Partial<SessionActivityState>) => {
        activityState = { ...activityState, ...patch };
        activityEmitter.fire(activityState);
      },
      onDidChange: activityEmitter.event,
    };

    const onDidCreateEmitter = new Emitter<{ agentId: string }>();
    const onDidCloseEmitter = new Emitter<{ agentId: string }>();

    const lifecycleService = {
      _sessionId: meta.id,
      _interactions: interactions,
      _recentlyResolved: recentlyResolved,
      _pendingChangeEmitter: pendingChangeEmitter,
      _resolveEmitter: resolveEmitter,
      handleOf: (agentId = MAIN_AGENT_ID) => agents.get(agentId),
      all: () => Array.from(agents.values()),
      list: () => Array.from(agents.keys()).map((agentId) => ({ agentId })),
      onDidCreate: (cb: (ctx: { agentId: string }) => void) => {
        const d = onDidCreateEmitter.event(cb);
        return { dispose: () => d.dispose() };
      },
      onDidClose: (cb: (ctx: { agentId: string }) => void) => {
        const d = onDidCloseEmitter.event(cb);
        return { dispose: () => d.dispose() };
      },
      create: async (opt?: { agentId?: string; labels?: any }) => {
        const id = opt?.agentId ?? MAIN_AGENT_ID;
        const exists = agents.has(id);
        if (!exists) {
          agents.set(id, createAgentHandle(id, sessionDir, meta.id));
          const labels = opt?.labels as Record<string, unknown> | undefined;
          meta.agents = {
            [MAIN_AGENT_ID]: {
              homedir: join(sessionDir, 'agents', MAIN_AGENT_ID).replaceAll('\\', '/'),
              type: 'main',
              parentAgentId: null,
              labels: { kind: 'main' },
            },
            ...meta.agents,
          };
          if (id !== MAIN_AGENT_ID) {
            meta.agents[id] = {
              type: 'sub',
              parentAgentId:
                (labels?.['parentAgentId'] as string | undefined) ?? MAIN_AGENT_ID,
              ...(labels !== undefined ? { labels } : {}),
            };
          }
          meta.updatedAt = Date.now();
          onDidCreateEmitter.fire({ agentId: id });
          void persistAgents();
        }
        return agents.get(id)!;
      },
    };

    const approvalService = {
      enqueue: (req: any) => {
        const id = req.id ?? 'appr_' + Math.random().toString(36).slice(2, 10);
        const item: Interaction = {
          id,
          kind: 'approval',
          payload: req,
          origin: req.origin ?? { agentId: MAIN_AGENT_ID, turnId: 1 },
          createdAt: Date.now(),
        };
        interactions.set(id, item);
        wireRecordsOf(meta.id).push({
          agentId: item.origin?.agentId ?? MAIN_AGENT_ID,
          record: {
            type: 'interaction.request',
            id,
            kind: 'approval',
            request: item.payload,
            toolCallId: req.toolCallId,
            time: Date.now(),
          },
        });
        pendingChangeEmitter.fire({ id, kind: 'approval' });
        return {
          id,
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          action: req.action,
          display: req.display,
          createdAt: item.createdAt,
          expiresAt: item.createdAt + 86400000,
        };
      },
      list: (_filter?: any) => {
        return Array.from(interactions.values()).filter((i) => i.kind === 'approval');
      },
      resolve: async (id: string, decision: any) => {
        if (recentlyResolved.has(id)) {
          throw new Error2(40902, 'approval already resolved');
        }
        const item = interactions.get(id);
        if (!item) {
          throw new Error2(40401, 'approval not found');
        }
        interactions.delete(id);
        const resp = typeof decision === 'object' && decision !== null ? decision : { decision };
        const resolved = { id, response: resp, ...resp, decision: resp.decision ?? decision, resolvedAt: Date.now() };
        recentlyResolved.set(id, resolved);
        wireRecordsOf(meta.id).push({
          agentId: item.origin?.agentId ?? MAIN_AGENT_ID,
          record: { type: 'interaction.resolved', id, response: resp, time: Date.now() },
        });
        resolveEmitter.fire(resolved);
        return { resolved: true, resolvedAt: new Date(resolved.resolvedAt).toISOString() };
      },
      decide: async (id: string, response: any) => {
        await approvalService.resolve(id, response);
      },
    };

    const questionService = {
      request: (req: any, origin?: any) => {
        return questionService.enqueue({ ...req, origin: origin ?? req?.origin });
      },
      enqueue: (req: any) => {
        const id = req.id ?? 'quest_' + Math.random().toString(36).slice(2, 10);
        const item: Interaction = {
          id,
          kind: 'question',
          payload: req,
          origin: req.origin ?? { agentId: MAIN_AGENT_ID, turnId: 1 },
          createdAt: Date.now(),
        };
        interactions.set(id, item);
        wireRecordsOf(meta.id).push({
          agentId: item.origin?.agentId ?? MAIN_AGENT_ID,
          record: { type: 'interaction.request', id, kind: 'question', request: item.payload, time: Date.now() },
        });
        pendingChangeEmitter.fire({ id, kind: 'question' });
        return {
          id,
          questions: req.questions ?? [],
          createdAt: item.createdAt,
        };
      },
      list: () => {
        return Array.from(interactions.values()).filter((i) => i.kind === 'question');
      },
      resolve: async (id: string, resolution: any) => {
        if (recentlyResolved.has(id)) {
          throw new Error2(40902, 'question already resolved');
        }
        const item = interactions.get(id);
        if (!item) {
          throw new Error2(40401, 'question not found');
        }
        interactions.delete(id);
        const resolved = { id, resolution, response: resolution, resolvedAt: Date.now() };
        recentlyResolved.set(id, resolved);
        wireRecordsOf(meta.id).push({
          agentId: item.origin?.agentId ?? MAIN_AGENT_ID,
          record: { type: 'interaction.resolved', id, response: resolution, time: Date.now() },
        });
        resolveEmitter.fire(resolved);
        return { resolved: true, resolvedAt: new Date(resolved.resolvedAt).toISOString() };
      },
      dismiss: async (id: string) => {
        interactions.delete(id);
        const resolved = { id, dismissed: true, response: null, resolvedAt: Date.now() };
        recentlyResolved.set(id, resolved);
        wireRecordsOf(meta.id).push({
          agentId: MAIN_AGENT_ID,
          record: { type: 'interaction.resolved', id, response: null, time: Date.now() },
        });
        resolveEmitter.fire(resolved);
        return { dismissed: true, dismissedAt: new Date().toISOString() };
      },
    };

    let hasGenerated = false;
    const titleService = {
      generateTitle: async (opt?: any) => {
        if (!opt?.force && hasGenerated) {
          return undefined;
        }
        const data = sessionDataStore.get(meta.id);
        const prompts = data?.recordedPrompts ?? [];
        if (prompts.length === 0) {
          return undefined;
        }
        try {
          const chatContent = prompts.map((p) => `user: ${p}`).join('\n');
          const res = await fetch('https://api.example.test/coding/v1/tools', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              method: 'chat_title',
              params: {
                chat_content: chatContent,
              },
            }),
          });
          if (res.ok) {
            const resJson = (await res.json()) as any;
            if (typeof resJson?.title === 'string' && resJson.title.length > 0) {
              hasGenerated = true;
              await metadataService.setTitle(resJson.title);
              return resJson.title;
            }
          }
        } catch {}
        return undefined;
      },
    };

    const sessionServices = new Map<string, unknown>([
      [ISessionMetadata.id, metadataService],
      [ISessionContext.id, contextService],
      [ISessionActivityView.id, activityView],
      [IAgentLifecycleService.id, lifecycleService],
      [ISessionApprovalService.id, approvalService],
      [ISessionQuestionService.id, questionService],
      [ISessionTitleService.id, titleService],
    ]);

    const handle: ISessionScopeHandle = {
      id: meta.id,
      accessor: {
        get<T>(id: ServiceIdentifier<T>): T {
          return (sessionServices.get(id.id) ?? defaultMock(id.id)) as T;
        },
      },
    };
    return handle;
  }

  const workspaceAliasesMap = new Map<string, string[]>();
  const deletedWorkspaceIds: string[] = [];

  async function saveWorkspacesJson(): Promise<void> {
    const wsMap: Record<string, any> = {};
    for (const [id, ws] of inMemoryWorkspaces.entries()) {
      wsMap[id] = {
        root: ws.root,
        name: ws.name,
        created_at: new Date(ws.createdAt).toISOString(),
        last_opened_at: new Date(ws.lastOpenedAt).toISOString(),
      };
    }
    const payload = {
      version: 1,
      workspaces: wsMap,
      deleted_workspace_ids: deletedWorkspaceIds,
    };
    await writeFile(join(opts.homeDir, 'workspaces.json'), JSON.stringify(payload, null, 2), 'utf8').catch(() => {});
  }

  async function loadWorkspacesJson(): Promise<void> {
    try {
      const wsFile = join(opts.homeDir, 'workspaces.json');
      const content = await readFile(wsFile, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed?.deleted_workspace_ids)) {
        for (const id of parsed.deleted_workspace_ids) {
          if (!deletedWorkspaceIds.includes(id)) deletedWorkspaceIds.push(id);
        }
      }
      if (parsed?.workspaces && typeof parsed.workspaces === 'object') {
        const groups = new Map<string, { repId: string; allIds: string[]; entry: any }>();
        for (const [wsId, entry] of Object.entries(parsed.workspaces as Record<string, any>)) {
          const root = entry.root as string;
          const normKey = root ? normalize(root).toLowerCase() : wsId;
          const group = groups.get(normKey);
          if (!group) {
            groups.set(normKey, { repId: wsId, allIds: [wsId], entry });
          } else {
            group.allIds.push(wsId);
          }
        }
        for (const group of groups.values()) {
          const repId = group.repId;
          for (const id of group.allIds) {
            workspaceAliasesMap.set(id, group.allIds);
          }
          if (!inMemoryWorkspaces.has(repId)) {
            inMemoryWorkspaces.set(repId, {
              id: repId,
              root: group.entry.root,
              name: group.entry.name || 'workspace',
              createdAt: group.entry.created_at ? new Date(group.entry.created_at).getTime() : Date.now(),
              lastOpenedAt: group.entry.last_opened_at ? new Date(group.entry.last_opened_at).getTime() : Date.now(),
              sessionCount: 0,
            });
          }
        }
      }
    } catch {}
  }

  async function syncFromDisk(): Promise<void> {
    await loadWorkspacesJson();
    try {
      const sessionsDir = join(opts.homeDir, 'sessions');
      const wsDirs = await readdir(sessionsDir).catch(() => [] as string[]);
      for (const wsId of wsDirs) {
        const wsPath = join(sessionsDir, wsId);
        const wsStat = await stat(wsPath).catch(() => null);
        if (!wsStat || !wsStat.isDirectory()) continue;
        const sids = await readdir(wsPath).catch(() => [] as string[]);
        for (const sid of sids) {
          const sPath = join(wsPath, sid);
          const statePath = join(sPath, 'state.json');
          try {
            const raw = await readFile(statePath, 'utf8');
            const data = JSON.parse(raw);
            const existing = inMemorySessions.get(sid);
            if (!existing) {
              const meta: InMemorySessionMeta = {
                id: sid,
                workspaceId: wsId,
                title: data.title ?? '',
                createdAt: data.createdAt ?? Date.now(),
                updatedAt: data.updatedAt ?? data.createdAt ?? Date.now(),
                archived: data.archived === true,
                archivedAt: data.archivedAt,
                lastTurnReason: data.lastTurnReason,
                lastPrompt: data.lastPrompt,
                custom: data.custom ?? (data.cwd ? { cwd: data.cwd } : {}),
              };
              inMemorySessions.set(sid, meta);
            } else if (data.updatedAt && data.updatedAt > existing.updatedAt) {
              existing.updatedAt = data.updatedAt;
              if (data.archived !== undefined) existing.archived = data.archived === true;
              if (data.archivedAt !== undefined) existing.archivedAt = data.archivedAt;
            }
          } catch {}
        }
      }
    } catch {}
  }

  const workspaceService = {
    createOrTouch: async (workDir: string, name?: string) => {
      try {
        const st = await stat(workDir);
        if (!st.isDirectory()) {
          throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `path ${workDir} is not a directory`);
        }
      } catch (err: any) {
        if (err instanceof Error2) throw err;
        throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `path ${workDir} does not exist`);
      }
      const id = encodeWorkDirKey(workDir);
      let existing = inMemoryWorkspaces.get(id);
      if (existing) {
        existing.lastOpenedAt = Date.now();
      } else {
        const parts = workDir.split(/[\\/]/).filter(Boolean);
        const wsName = name ?? (parts[parts.length - 1] || 'workspace');
        existing = {
          id,
          root: workDir,
          name: wsName,
          createdAt: Date.now(),
          lastOpenedAt: Date.now(),
          sessionCount: 0,
        };
        inMemoryWorkspaces.set(id, existing);
      }
      await saveWorkspacesJson();
      return existing;
    },
    list: async () => {
      await loadWorkspacesJson();
      return Array.from(inMemoryWorkspaces.values());
    },
    all: async () => {
      await loadWorkspacesJson();
      return Array.from(inMemoryWorkspaces.values());
    },
    get: async (id: string) => {
      await loadWorkspacesJson();
      const direct = inMemoryWorkspaces.get(id);
      if (direct) return direct;
      const aliases = workspaceAliasesMap.get(id);
      if (aliases) {
        for (const alias of aliases) {
          const ws = inMemoryWorkspaces.get(alias);
          if (ws) return ws;
        }
      }
      return undefined;
    },
    update: async (id: string, patch: Partial<InMemoryWorkspace>) => {
      await loadWorkspacesJson();
      const existing = inMemoryWorkspaces.get(id);
      if (!existing) return undefined;
      Object.assign(existing, patch);
      await saveWorkspacesJson();
      return existing;
    },
    delete: async (id: string) => {
      inMemoryWorkspaces.delete(id);
      if (!deletedWorkspaceIds.includes(id)) {
        deletedWorkspaceIds.push(id);
      }
      await saveWorkspacesJson();
    },
  };

  const workspaceAliases = {
    resolveAliasIds: async (id: string) => {
      await loadWorkspacesJson();
      return workspaceAliasesMap.get(id) ?? [id];
    },
  };

  const workspaceSessions = {
    count: async (workspaceId: string) => {
      await syncFromDisk();
      const aliasIds = await workspaceAliases.resolveAliasIds(workspaceId);
      const aliasSet = new Set(aliasIds);
      return Array.from(inMemorySessions.values()).filter(
        (s) => aliasSet.has(s.workspaceId),
      ).length;
    },
    all: async (workspaceId: string) => {
      await syncFromDisk();
      const aliasIds = await workspaceAliases.resolveAliasIds(workspaceId);
      const aliasSet = new Set(aliasIds);
      return Array.from(inMemorySessions.values()).filter((s) => aliasSet.has(s.workspaceId));
    },
  };

  const sessionIndex = {
    get: async (id: string) => {
      let s = inMemorySessions.get(id);
      if (!s) {
        await syncFromDisk();
        s = inMemorySessions.get(id);
      }
      if (!s) return undefined;
      const ws = inMemoryWorkspaces.get(s.workspaceId);
      return {
        id: s.id,
        workspaceId: s.workspaceId,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        archived: s.archived,
        archivedAt: s.archivedAt,
        lastTurnReason: s.lastTurnReason,
        lastPrompt: s.lastPrompt,
        cwd: (s.custom['cwd'] as string | undefined) ?? ws?.root,
        custom: s.custom,
      };
    },
    listRecent: async (query?: any) => {
      await syncFromDisk();
      let items = Array.from(inMemorySessions.values());
      if (query?.workspaceIds && Array.isArray(query.workspaceIds)) {
        const set = new Set(query.workspaceIds);
        items = items.filter((s) => set.has(s.workspaceId));
      }
      if (query?.childOf) {
        items = items.filter(
          (s) => s.parentId === query.childOf && s.custom['child_session_kind'] === 'child',
        );
      }
      if (!query?.includeArchived && !query?.archivedOnly) {
        items = items.filter((s) => !s.archived);
      }
      if (query?.archivedOnly) {
        items = items.filter((s) => s.archived);
      }
      items.sort((a, b) =>
        b.updatedAt !== a.updatedAt ? b.updatedAt - a.updatedAt : b.id.localeCompare(a.id),
      );
      if (query?.before !== undefined) {
        const idx = items.findIndex((s) => s.id === query.before);
        if (idx < 0) {
          return { items: [], nextCursor: undefined };
        }
        items = items.slice(idx + 1);
      } else if (query?.after !== undefined) {
        const idx = items.findIndex((s) => s.id === query.after);
        if (idx < 0) {
          return { items: [], nextCursor: undefined };
        }
        items = items.slice(0, idx);
      }
      let nextCursor: string | undefined = undefined;
      if (typeof query?.limit === 'number' && items.length > query.limit) {
        nextCursor = items[query.limit - 1]?.id;
        items = items.slice(0, query.limit);
      }
      return {
        items: items.map((s) => {
          const ws = inMemoryWorkspaces.get(s.workspaceId);
          return {
            id: s.id,
            workspaceId: s.workspaceId,
            title: s.title,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            archived: s.archived,
            archivedAt: s.archivedAt,
            lastTurnReason: s.lastTurnReason,
            lastPrompt: s.lastPrompt,
            cwd: (s.custom['cwd'] as string | undefined) ?? ws?.root,
            custom: s.custom,
          };
        }),
        nextCursor,
      };
    },
    count: async (query?: any) => {
      const res = await sessionIndex.listRecent(query);
      return res.items.length;
    },
    status: async () => {
      try {
        const queryStorePath = join(opts.homeDir, 'cache', 'query-store');
        const st = await stat(queryStorePath).catch(() => null);
        if (st && !st.isDirectory()) {
          return { state: 'degraded', degradedCount: 1, reason: 'query-store corrupted' };
        }
      } catch {}
      return { state: 'ready', degradedCount: 0 };
    },
    reconcileNow: async () => {
      await syncFromDisk();
    },
  };

  const inFlightResumes = new Map<string, Promise<any>>();

  const sessionManager = {
    create: async (params: { workspaceId: string; workDir?: string; title?: string }) => {
      const sessionId =
        'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const sessionDir = join(opts.homeDir, 'sessions', params.workspaceId, sessionId);
      const meta: InMemorySessionMeta = {
        id: sessionId,
        workspaceId: params.workspaceId,
        title: params.title ?? '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        archived: false,
        custom: { cwd: params.workDir ?? opts.homeDir },
      };
      inMemorySessions.set(sessionId, meta);
      let ws = inMemoryWorkspaces.get(params.workspaceId);
      if (!ws) {
        const root = params.workDir ?? opts.homeDir;
        const parts = root.split(/[\\/]/).filter(Boolean);
        const wsName = parts[parts.length - 1] || 'workspace';
        ws = {
          id: params.workspaceId,
          root,
          name: wsName,
          createdAt: Date.now(),
          lastOpenedAt: Date.now(),
          sessionCount: 0,
        };
        inMemoryWorkspaces.set(params.workspaceId, ws);
      }
      ws.sessionCount++;
      await saveWorkspacesJson();
      await appendFile(
        join(opts.homeDir, 'session_index.jsonl'),
        JSON.stringify({
          sessionId,
          sessionDir: sessionDir.replaceAll('\\', '/'),
          workDir: params.workDir ?? opts.homeDir,
        }) + '\n',
        'utf8',
      ).catch(() => {});
      const mainAgentDir = join(
        sessionDir,
        'agents',
        MAIN_AGENT_ID,
      );
      await mkdir(mainAgentDir, { recursive: true }).catch(() => {});
      await writeFile(
        join(mainAgentDir, 'wire.jsonl'),
        JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: Date.now() }) + '\n',
      ).catch(() => {});
      await writeFile(
        join(sessionDir, 'state.json'),
        JSON.stringify({
          id: sessionId,
          workspaceId: params.workspaceId,
          workDir: params.workDir ?? opts.homeDir,
          title: params.title ?? '',
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          archived: false,
          custom: meta.custom,
          agents: {
            [MAIN_AGENT_ID]: {
              homedir: mainAgentDir.replaceAll('\\', '/'),
              type: 'main',
              parentAgentId: null,
              labels: { kind: 'main' },
            },
          },
        }),
      ).catch(() => {});
      const handle = createSessionScopeHandle(meta, sessionDir);
      liveSessionHandles.set(sessionId, handle);
      return handle;
    },
    get: (sessionId: string) => liveSessionHandles.get(sessionId),
    getLive: (sessionId: string) => liveSessionHandles.get(sessionId),
    getMeta: (sessionId: string) => inMemorySessions.get(sessionId),
    resumeSession: async (sessionId: string) => {
      const inFlight = inFlightResumes.get(sessionId);
      if (inFlight) return inFlight;
      const promise = (async () => {
        let meta = inMemorySessions.get(sessionId);
        if (!meta) {
          await syncFromDisk();
          meta = inMemorySessions.get(sessionId);
        }
        if (!meta) return undefined;
        const cwd = meta.custom['cwd'] as string | undefined;
        if (cwd) {
          try {
            const st = await stat(cwd);
            if (!st.isDirectory()) throw new Error('not a directory');
          } catch {
            throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `workspace root ${cwd} does not exist`);
          }
        }
        const existing = liveSessionHandles.get(sessionId);
        if (existing) return existing;
        const sessionDir = join(opts.homeDir, 'sessions', meta.workspaceId, sessionId);
        const handle = createSessionScopeHandle(meta, sessionDir);
        liveSessionHandles.set(sessionId, handle);

        const wirePath = join(sessionDir, 'agents', MAIN_AGENT_ID, 'wire.jsonl');
        try {
          const content = await readFile(wirePath, 'utf8');
          let sessionData = sessionDataStore.get(sessionId);
          if (!sessionData) {
sessionData = { cronTasks: new Map<string, any>(), recordedPrompts: [] };
            sessionDataStore.set(sessionId, sessionData);
          }
          for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const record = JSON.parse(trimmed);
              if (record.type === 'cron.add' && record.task) {
                sessionData.cronTasks.set(record.task.id, record.task);
              } else if (record.type === 'cron.delete' && Array.isArray(record.ids)) {
                for (const id of record.ids) sessionData.cronTasks.delete(id);
              }
            } catch {}
          }
        } catch {}

        return handle;
      })().finally(() => {
        inFlightResumes.delete(sessionId);
      });
      inFlightResumes.set(sessionId, promise);
      return promise;
    },
    resume: async (sessionId: string) => {
      return sessionManager.resumeSession(sessionId);
    },
    closeSession: async (sessionId: string) => {
      liveSessionHandles.delete(sessionId);
      sessionCloseEmitters.fire({ sessionId });
    },
    setArchived: async (sessionId: string, archived: boolean) => {
      const inFlight = inFlightResumes.get(sessionId);
      if (inFlight) {
        try {
          await inFlight;
        } catch {}
      }
      let meta = inMemorySessions.get(sessionId);
      if (!meta) {
        await syncFromDisk();
        meta = inMemorySessions.get(sessionId);
      }
      if (meta) {
        meta.archived = archived;
        if (archived) {
          meta.archivedAt = Date.now();
        } else {
          delete meta.archivedAt;
        }
        if (archived) {
          liveSessionHandles.delete(sessionId);
          sessionArchiveEmitters.fire({ sessionId });
          coreEventService.publish({
            type: 'event.session.archived',
            payload: { sessionId, workspaceId: meta.workspaceId },
          });
        }
        const statePath = join(opts.homeDir, 'sessions', meta.workspaceId, sessionId, 'state.json');
        try {
          const raw = await readFile(statePath, 'utf8');
          const data = JSON.parse(raw);
          data.archived = archived;
          if (archived) {
            data.archivedAt = meta.archivedAt;
          } else {
            delete data.archivedAt;
          }
          await writeFile(statePath, JSON.stringify(data));
        } catch {}
      }
    },
    fork: async (params: { sourceSessionId: string; title?: string; metadata?: any }) => {
      let src = inMemorySessions.get(params.sourceSessionId);
      if (!src) {
        await syncFromDisk();
        src = inMemorySessions.get(params.sourceSessionId);
      }
      if (!src) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, 'session not found');
      const forkedId =
        'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const forkedMeta: InMemorySessionMeta = {
        id: forkedId,
        workspaceId: src.workspaceId,
        title: params.title ?? `Fork: ${src.title || params.sourceSessionId}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        archived: false,
        parentId: params.sourceSessionId,
        custom: { ...src.custom, ...params.metadata },
      };
      inMemorySessions.set(forkedId, forkedMeta);

      const srcDir = join(opts.homeDir, 'sessions', src.workspaceId, params.sourceSessionId);
      const forkedDir = join(opts.homeDir, 'sessions', src.workspaceId, forkedId);
      await mkdir(forkedDir, { recursive: true }).catch(() => {});

      let srcState: any = null;
      try {
        const stateRaw = await readFile(join(srcDir, 'state.json'), 'utf8');
        srcState = JSON.parse(stateRaw);
      } catch {
        srcState = {
          agents: {
            [MAIN_AGENT_ID]: {
              homedir: join(srcDir, 'agents', MAIN_AGENT_ID).replaceAll('\\', '/'),
              type: 'main',
              parentAgentId: null,
              labels: { kind: 'main' },
            },
          },
        };
      }

      const forkedAgents: Record<string, any> = {};
      const srcAgents = srcState.agents || {};
      for (const [agentId, agentInfo] of Object.entries(srcAgents as Record<string, any>)) {
        forkedAgents[agentId] = {
          ...agentInfo,
          homedir: join(forkedDir, 'agents', agentId).replaceAll('\\', '/'),
          parentAgentId: agentId === 'main' ? (agentInfo.parentAgentId ?? null) : 'main',
          labels: agentId === 'main' ? agentInfo.labels : { ...agentInfo.labels, parentAgentId: 'main' },
        };
      }

      const forkedState = {
        ...srcState,
        id: forkedId,
        title: params.title ?? `Fork: ${src.title || params.sourceSessionId}`,
        forkedFrom: params.sourceSessionId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        custom: { ...srcState.custom, ...params.metadata },
        agents: forkedAgents,
      };
      await writeFile(join(forkedDir, 'state.json'), JSON.stringify(forkedState)).catch(() => {});

      const forkedRecord = JSON.stringify({ type: 'forked', time: Date.now() }) + '\n';
      await Promise.all(
        Object.keys(forkedAgents).map(async (agentId) => {
          const srcAgentWire = join(srcDir, 'agents', agentId, 'wire.jsonl');
          const forkedAgentDir = join(forkedDir, 'agents', agentId);
          await mkdir(forkedAgentDir, { recursive: true }).catch(() => {});
          const forkedAgentWire = join(forkedAgentDir, 'wire.jsonl');
          let srcContent = '';
          try {
            srcContent = await readFile(srcAgentWire, 'utf8');
          } catch {}
          if (!srcContent) {
            srcContent = JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: Date.now() }) + '\n';
          } else if (!srcContent.endsWith('\n')) {
            srcContent += '\n';
          }
          await writeFile(forkedAgentWire, srcContent + forkedRecord).catch(() => {});
        }),
      );

      const srcData = sessionDataStore.get(params.sourceSessionId);
      const clonedCron = new Map<string, any>();
      if (srcData) {
        for (const [k, v] of srcData.cronTasks.entries()) {
          clonedCron.set(k, { ...v });
        }
      }
      sessionDataStore.set(forkedId, { cronTasks: clonedCron, recordedPrompts: [] });

      return {
        id: forkedId,
        workspaceId: forkedMeta.workspaceId,
        title: forkedMeta.title,
        createdAt: forkedMeta.createdAt,
        updatedAt: forkedMeta.updatedAt,
        cwd: (forkedMeta.custom['cwd'] as string | undefined) ?? '',
        custom: forkedMeta.custom,
      };
    },
    createChild: async (params: { sourceSessionId: string; title?: string; metadata?: any }) => {
      let src = inMemorySessions.get(params.sourceSessionId);
      if (!src) {
        await syncFromDisk();
        src = inMemorySessions.get(params.sourceSessionId);
      }
      if (!src) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, 'session not found');
      const forkedId =
        'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const parentTitle = src.title || 'untitled';
      const childTitle = params.title ?? `Child: ${parentTitle}`;
      const forkedMeta: InMemorySessionMeta = {
        id: forkedId,
        workspaceId: src.workspaceId,
        title: childTitle,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        archived: false,
        parentId: params.sourceSessionId,
        custom: {
          ...src.custom,
          ...params.metadata,
          ['parent_session_id']: params.sourceSessionId,
          ['child_session_kind']: 'child',
        },
      };
      inMemorySessions.set(forkedId, forkedMeta);
      const srcData = sessionDataStore.get(params.sourceSessionId);
      const clonedCron = new Map<string, any>();
      if (srcData) {
        for (const [k, v] of srcData.cronTasks.entries()) {
          clonedCron.set(k, { ...v });
        }
      }
      sessionDataStore.set(forkedId, { cronTasks: clonedCron, recordedPrompts: [] });
      const forkedSessionDir = join(opts.homeDir, 'sessions', forkedMeta.workspaceId, forkedId);
      const forkedAgentDir = join(
        forkedSessionDir,
        'agents',
        MAIN_AGENT_ID,
      );
      await mkdir(forkedAgentDir, { recursive: true }).catch(() => {});
      await writeFile(
        join(forkedAgentDir, 'wire.jsonl'),
        JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: Date.now() }) + '\n',
      ).catch(() => {});
      await writeFile(
        join(forkedSessionDir, 'state.json'),
        JSON.stringify({
          id: forkedId,
          workspaceId: forkedMeta.workspaceId,
          workDir: (forkedMeta.custom['cwd'] as string | undefined) ?? opts.homeDir,
          title: childTitle,
          createdAt: forkedMeta.createdAt,
          updatedAt: forkedMeta.updatedAt,
          archived: false,
          parentId: params.sourceSessionId,
          custom: forkedMeta.custom,
          agents: {
            [MAIN_AGENT_ID]: {
              homedir: forkedAgentDir.replaceAll('\\', '/'),
              type: 'main',
              parentAgentId: null,
              labels: { kind: 'main' },
            },
          },
        }),
      ).catch(() => {});
      return {
        id: forkedId,
        workspaceId: forkedMeta.workspaceId,
        title: forkedMeta.title,
        createdAt: forkedMeta.createdAt,
        updatedAt: forkedMeta.updatedAt,
        cwd: (forkedMeta.custom['cwd'] as string | undefined) ?? '',
        custom: forkedMeta.custom,
      };
    },
    status: async (sessionId: string) => sessionIndex.get(sessionId),
    restore: async (sessionId: string) => {
      let meta = inMemorySessions.get(sessionId);
      if (!meta) {
        await syncFromDisk();
        meta = inMemorySessions.get(sessionId);
      }
      if (!meta) return undefined;
      meta.archived = false;
      meta.archivedAt = undefined;
      meta.updatedAt = Date.now();
      sessionArchiveEmitters.fire({ sessionId });
      const statePath = join(opts.homeDir, 'sessions', meta.workspaceId, sessionId, 'state.json');
      try {
        const raw = await readFile(statePath, 'utf8');
        const data = JSON.parse(raw);
        data.archived = false;
        data.archivedAt = undefined;
        data.updatedAt = meta.updatedAt;
        await writeFile(statePath, JSON.stringify(data));
      } catch {}
      return sessionManager.resumeSession(sessionId);
    },
    onDidCloseSession: (cb: (e: { sessionId: string }) => void) => sessionCloseEmitters.event(cb),
    onDidArchiveSession: (cb: (e: { sessionId: string }) => void) => sessionArchiveEmitters.event(cb),
    all: () => Array.from(liveSessionHandles.values()),
    list: () => Array.from(liveSessionHandles.values()),
    delete: async (sessionId: string) => {
      liveSessionHandles.delete(sessionId);
      inMemorySessions.delete(sessionId);
    },
  };

  const sessionLegacyService = {
    status: async (sessionId: string) => {
      const handle = liveSessionHandles.get(sessionId);
      const main = handle?.accessor?.get?.(IAgentLifecycleService)?.handleOf?.(MAIN_AGENT_ID);
      const goal = (await main?.accessor?.get?.(IAgentGoalService)?.getGoal?.()) ?? null;
      const profile = main?.accessor?.get?.(IAgentProfileService);
      const plan = main?.accessor?.get?.(IAgentPlanService);
      const swarm = main?.accessor?.get?.(IAgentSwarmService);
      const tower = main?.accessor?.get?.(IAgentTowerService);
      const lifecycle = main?.accessor?.get?.(IAgentLifecycleService);
      const planActive = ((await plan?.status?.()) ?? null) !== null;
      return {
        busy: false,
        thinking_level: profile?.getThinking?.() ?? 'off',
        plan_mode: planActive,
        swarm_mode: swarm?.isActive ?? false,
        tower_mode: tower?.isActive ?? false,
        permission: lifecycle?.getPermissionMode?.() ?? 'default',
        model: profile?.getModel?.() ?? 'stub',
        max_context_tokens: 131072,
        context_tokens: 0,
        context_usage: 0,
        goal,
      };
    },
    goal: async (sessionId: string) => {
      const handle = liveSessionHandles.get(sessionId);
      const main = handle?.accessor?.get?.(IAgentLifecycleService)?.handleOf?.(MAIN_AGENT_ID);
      return (await main?.accessor?.get?.(IAgentGoalService)?.getGoal?.()) ?? null;
    },
  };

  const coreEventBusEmitter = new Emitter<any>();
  const coreEventService = {
    publish: (event: any) => {
      coreEventBusEmitter.fire(event);
    },
    subscribe: (listener: (event: any) => void) => {
      const d = coreEventBusEmitter.event(listener);
      return { dispose: () => d.dispose() };
    },
  };

  const bootstrapService = {
    homeDir: opts.homeDir,
    osHomeDir: homedir(),
    cacheDir: join(opts.homeDir, 'cache'),
    scope: (s: string) => s,
    sessionDir: (workspaceId: string, sessionId: string) =>
      join(opts.homeDir, 'sessions', workspaceId, sessionId),
  };

  const hostFileSystem = {
    stat: async (p: string) => {
      try {
        const s = await stat(p);
        return {
          isDirectory: s.isDirectory(),
          isFile: s.isFile(),
          isSymbolicLink: s.isSymbolicLink(),
          size: s.size,
          mtimeMs: s.mtimeMs,
          ctimeMs: s.ctimeMs,
          ino: s.ino,
        };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          throw new Error2(ErrorCodes.OS_FS_NOT_FOUND, `path not found: ${p}`);
        }
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          throw new Error2(ErrorCodes.OS_FS_PERMISSION_DENIED, `permission denied: ${p}`);
        }
        if (err.code === 'ENOTDIR') {
          throw new Error2(ErrorCodes.OS_FS_NOT_DIRECTORY, `not a directory: ${p}`);
        }
        throw err;
      }
    },
    realpath: async (p: string) => {
      try {
        return await realpath(p);
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          throw new Error2(ErrorCodes.OS_FS_NOT_FOUND, `path not found: ${p}`);
        }
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          throw new Error2(ErrorCodes.OS_FS_PERMISSION_DENIED, `permission denied: ${p}`);
        }
        throw err;
      }
    },
    readBytes: async (p: string, length: number) => {
      let fh;
      try {
        fh = await open(p, 'r');
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, 0);
        return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          throw new Error2(ErrorCodes.OS_FS_NOT_FOUND, `path not found: ${p}`);
        }
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          throw new Error2(ErrorCodes.OS_FS_PERMISSION_DENIED, `permission denied: ${p}`);
        }
        throw err;
      } finally {
        if (fh) await fh.close();
      }
    },
  };

  const hostFolderBrowser = {
    browse: async (inputPath?: string) => {
      const targetPath = inputPath ?? homedir();
      if (!isAbsolute(targetPath)) {
        throw new HostFolderNotAbsoluteError(`path must be absolute: ${targetPath}`);
      }
      let realPath: string;
      try {
        realPath = await realpath(targetPath);
      } catch (err: any) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          throw new HostFolderPermissionError(`permission denied: ${targetPath}`);
        }
        throw new HostFolderNotFoundError(`path not found: ${targetPath}`);
      }
      const st = await stat(realPath).catch(() => null);
      if (!st || !st.isDirectory()) {
        throw new HostFolderNotFoundError(`path is not a directory: ${targetPath}`);
      }
      const parsed = parse(realPath);
      const parent = parsed.root === realPath ? null : dirname(realPath);
      let dirents;
      try {
        dirents = await readdir(realPath, { withFileTypes: true });
      } catch (err: any) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          throw new HostFolderPermissionError(`permission denied: ${targetPath}`);
        }
        throw err;
      }
      const dirEntries = dirents
        .filter((d) => d.isDirectory())
        .map((d) => ({
          name: d.name,
          path: join(realPath, d.name),
          is_dir: true as const,
        }));
      dirEntries.sort((a, b) => {
        const aDot = a.name.startsWith('.');
        const bDot = b.name.startsWith('.');
        if (aDot !== bDot) return aDot ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
      return {
        path: realPath,
        parent,
        entries: dirEntries,
      };
    },
    home: async () => {
      await loadWorkspacesJson();
      const recentRoots = Array.from(inMemoryWorkspaces.values()).map((w) => w.root);
      return {
        home: homedir(),
        recent_roots: recentRoots,
      };
    },
  };

  const workspaceInstances = new Map<string, any>();
  const workspaceInstanceManager = {
    getOrCreate: async (params: { workspaceId: string; root: string }) => {
      let instance = workspaceInstances.get(params.workspaceId);
      if (!instance) {
        const additionalDirs = new Set<string>();
        instance = {
          workspaceId: params.workspaceId,
          root: params.root,
          program: {
            trust: {
              isTrusted: async () => true,
              setTrusted: async () => {},
            },
            dirs: {
              addDir: async (args: { path: string; persist?: boolean }) => {
                const persist = args.persist !== false;
                const resolved = isAbsolute(args.path) ? args.path : resolve(params.root, args.path);
                additionalDirs.add(resolved);
                const configPath = join(params.root, '.kimi-code', 'local.toml');
                if (persist) {
                  await mkdir(join(params.root, '.kimi-code'), { recursive: true }).catch(() => {});
                  const tomlContent = `additional_dirs = [${Array.from(additionalDirs).map((d) => `'${d}'`).join(', ')}]\n`;
                  await writeFile(configPath, tomlContent, 'utf8').catch(() => {});
                }
                return {
                  projectRoot: params.root,
                  configPath,
                  additionalDirs: Array.from(additionalDirs),
                  persisted: persist,
                };
              },
            },
          },
        };
        workspaceInstances.set(params.workspaceId, instance);
      }
      return instance;
    },
  };

  const appendLogStore = {
    read: async function* <T>(_scope: any, _key: string) {
      const wirePath =
        _scope?.sessionDir && _scope?.agentId
          ? join(_scope.sessionDir, 'agents', _scope.agentId, 'wire.jsonl')
          : undefined;
      if (wirePath) {
        try {
          const content = await readFile(wirePath, 'utf8');
          const lines = content.trim().split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              yield JSON.parse(line) as T;
            } catch {}
          }
        } catch {}
      }
    },
    drainRetirements: async () => {},
  };

  const sessionExportService = {
    export: async (input: any, extra?: any) => {
      const summary = await sessionIndex.get(input.sessionId);
      if (summary === undefined) {
        throw new Error2(
          ErrorCodes.SESSION_NOT_FOUND,
          `Session "${input.sessionId}" does not exist`,
        );
      }
      const sessionDir = join(opts.homeDir, 'sessions', summary.workspaceId, summary.id);
      let sessionFiles: string[] = [];
      try {
        const dirents = await readdir(sessionDir, { recursive: true, withFileTypes: true });
        sessionFiles = dirents
          .filter((e) => e.isFile())
          .map((e) => join(e.parentPath, e.name));
      } catch {}

      const zip = new ZipFile();
      const manifest = {
        sessionId: summary.id,
        exportedAt: new Date().toISOString(),
        kimiCodeVersion: input.version,
        desktopVersion: input.desktopVersion,
        desktopLogPath: input.includeDesktopLog ? 'logs/kimi-desktop.log' : undefined,
        webLogPath: extra?.webLog !== undefined ? 'logs/kimi-web.jsonl' : undefined,
      };
      zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'), 'manifest.json');

      for (const abs of sessionFiles) {
        const rel = relative(sessionDir, abs).split(/[\\/]/).join('/');
        try {
          const data = await readFile(abs);
          zip.addBuffer(data, rel);
        } catch {}
      }

      if (extra?.webLog !== undefined) {
        zip.addBuffer(Buffer.from(extra.webLog, 'utf-8'), 'logs/kimi-web.jsonl');
      }

      if (input.includeDesktopLog) {
        const desktopLogPath = join(opts.homeDir, 'logs', 'kimi-code-desktop.log');
        try {
          const data = await readFile(desktopLogPath);
          zip.addBuffer(data, 'logs/kimi-desktop.log');
        } catch {}
      }

      zip.end();
      await mkdir(dirname(input.outputPath), { recursive: true });
      await pipeline(zip.outputStream as any, createWriteStream(input.outputPath));
    },
  };

  if (!serviceMap.has(IEventService.id)) serviceMap.set(IEventService.id, coreEventService);
  if (!serviceMap.has(IBootstrapService.id)) serviceMap.set(IBootstrapService.id, bootstrapService);
  if (!serviceMap.has(ISessionExportService.id)) serviceMap.set(ISessionExportService.id, sessionExportService);
  if (!serviceMap.has(IWorkspaceService.id)) serviceMap.set(IWorkspaceService.id, workspaceService);
  if (!serviceMap.has(IWorkspaceAliases.id)) serviceMap.set(IWorkspaceAliases.id, workspaceAliases);
  if (!serviceMap.has(IWorkspaceSessions.id)) serviceMap.set(IWorkspaceSessions.id, workspaceSessions);
  if (!serviceMap.has(ISessionIndex.id)) serviceMap.set(ISessionIndex.id, sessionIndex);
  if (!serviceMap.has(ISessionManager.id)) serviceMap.set(ISessionManager.id, sessionManager);
  if (!serviceMap.has(ISessionLegacyService.id)) serviceMap.set(ISessionLegacyService.id, sessionLegacyService);
  if (!serviceMap.has(IHostFileSystem.id)) serviceMap.set(IHostFileSystem.id, hostFileSystem);
  if (!serviceMap.has(IHostFolderBrowser.id)) serviceMap.set(IHostFolderBrowser.id, hostFolderBrowser);
  if (!serviceMap.has(IWorkspaceInstanceManager.id)) serviceMap.set(IWorkspaceInstanceManager.id, workspaceInstanceManager);
  if (!serviceMap.has(IAppendLogStore.id)) serviceMap.set(IAppendLogStore.id, appendLogStore);

  const scope: Scope = {
    accessor: {
      get<T>(id: ServiceIdentifier<T>): T {
        let svc = serviceMap.get(id.id);
        if (svc === undefined) {
          const factory = appScopedFactories.get(id.id);
          if (factory) {
            try {
              svc = factory(scope);
              serviceMap.set(id.id, svc);
            } catch {}
          }
        }
        return (svc ?? defaultMock(id.id)) as T;
      },
    },
    get<T>(id: ServiceIdentifier<T>): T {
      return scope.accessor.get(id);
    },
    dispose(): void {},
  };

  return { app: scope };
}

export function cronToHuman(cron: string | { valid: boolean; error?: string }): string {
  return typeof cron === 'string' ? `Cron: ${cron}` : `Cron: ${cron.valid ? 'configured' : 'invalid'}`;
}

export function parseCronExpression(cron: string): { valid: boolean; error?: string } {
  const parts = cron.trim().split(/\s+/);
  return { valid: parts.length === 5 };
}

export const authSummarySchema = z.object({
  logged_in: z.boolean(),
  user: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const fileMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number(),
  created_at: isoDateTimeSchema,
}).passthrough();

export const setDefaultModelResponseSchema = z.object({
  model: z.string(),
}).passthrough();

export const refreshProviderModelsResponseSchema = z.object({
  changed: z.array(z.unknown()),
  unchanged: z.array(z.string()),
  failed: z.array(z.unknown()),
}).passthrough();

export function resumeSessionById(
  accessor: Scope['accessor'],
  sessionId: string,
): Promise<ISessionScopeHandle | undefined> {
  const mgr = accessor.get(ISessionManager) as any;
  return mgr?.resumeSession ? mgr.resumeSession(sessionId) : Promise.resolve(mgr?.get?.(sessionId));
}

export function getLiveSessionById(
  accessor: Scope['accessor'],
  sessionId: string,
): ISessionScopeHandle | undefined {
  const mgr = accessor.get(ISessionManager) as any;
  return mgr?.getLive ? mgr.getLive(sessionId) : mgr?.get?.(sessionId);
}

export function agentContextOf(..._args: any[]): unknown {
  return undefined;
}

export function sessionMediaOriginalsDir(sessionDir: string): string {
  return join(sessionDir, 'media');
}

export function setSessionArchived(
  accessor: Scope['accessor'],
  sessionId: string,
  archived: boolean,
): Promise<void> {
  const mgr = accessor.get(ISessionManager) as any;
  return mgr?.setArchived ? mgr.setArchived(sessionId, archived) : Promise.resolve();
}

export async function setSessionArchivedBatch(
  accessor: Scope['accessor'],
  sessionIds: readonly string[],
  archived: boolean,
): Promise<readonly { ok: boolean; id: string; reason: string; message: string }[]> {
  const mgr = accessor.get(ISessionManager) as any;
  const results: { ok: boolean; id: string; reason: string; message: string }[] = [];
  for (const id of sessionIds) {
    let meta = mgr?.getMeta ? mgr.getMeta(id) : (mgr?.get ? mgr.get(id) : undefined);
    if (!meta && mgr?.syncFromDisk) {
      await mgr.syncFromDisk();
      meta = mgr?.getMeta ? mgr.getMeta(id) : (mgr?.get ? mgr.get(id) : undefined);
    }
    if (!meta) {
      results.push({
        ok: false,
        id,
        reason: 'not_found',
        message: `session ${id} does not exist`,
      });
    } else {
      if (mgr?.setArchived) await mgr.setArchived(id, archived);
      results.push({ ok: true, id, reason: '', message: '' });
    }
  }
  return results;
}

export function programForSession(
  accessor: Scope['accessor'],
  sessionId: string,
): Promise<{ workspaceId: string; id: string } | undefined> {
  const mgr = accessor.get(ISessionManager) as any;
  const meta = mgr?.getMeta ? mgr.getMeta(sessionId) : (mgr?.get ? mgr.get(sessionId) : undefined);
  if (!meta) return Promise.resolve(undefined);
  const wsId = meta.workspaceId ?? meta.accessor?.get?.(ISessionContext)?.workspaceId ?? 'default';
  return Promise.resolve({ workspaceId: wsId, id: sessionId });
}

export function followSessionLifecycles(
  accessor: Scope['accessor'],
  subscribe: (service: {
    onDidCloseSession(cb: (e: { sessionId: string }) => void): IDisposable;
    onDidArchiveSession(cb: (e: { sessionId: string }) => void): IDisposable;
  }) => IDisposable,
): IDisposable {
  const mgr = accessor.get(ISessionManager) as any;
  if (mgr?.onDidCloseSession && mgr?.onDidArchiveSession) {
    return subscribe({
      onDidCloseSession: mgr.onDidCloseSession,
      onDidArchiveSession: mgr.onDidArchiveSession,
    });
  }
  return { dispose() {} };
}

export function listSessionPendingInteractions(
  agents: unknown,
  kind?: 'approval' | 'question',
): readonly Interaction[] {
  const service = agents as any;
  if (!service?._interactions) return [];
  const all = Array.from(service._interactions.values()) as Interaction[];
  return kind ? all.filter((i) => i.kind === kind) : all;
}

export function isSessionInteractionRecentlyResolved(agents: unknown, id: string): boolean {
  const service = agents as any;
  return !!service?._recentlyResolved?.has(id);
}

export function onSessionInteractionDidChangePending(
  agents: unknown,
  listener: (e: any) => void,
): IDisposable {
  const service = agents as any;
  return service?._pendingChangeEmitter?.event(listener) ?? { dispose() {} };
}

export function onSessionInteractionDidResolve(
  agents: unknown,
  listener: (e: any) => void,
): IDisposable {
  const service = agents as any;
  return service?._resolveEmitter?.event(listener) ?? { dispose() {} };
}

export function ensureMainAgent(_session: ISessionScopeHandle): Promise<{ agentId: string }> {
  return Promise.resolve({ agentId: MAIN_AGENT_ID });
}

export const MAIN_AGENT_ID = 'main';

export function isTowerFeatureAssembled(_flags: unknown): boolean {
  return false;
}

export function isUndoAnchor(message: unknown): boolean {
  const origin = (message as { origin?: { kind?: string; trigger?: string } } | undefined)?.origin;
  if (origin?.kind === undefined || origin.kind === 'user') return true;
  return (
    (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  );
}

export const TOWER_FLAG_ID = 'tower';

export function buildDaemonFileUrl(id: string): string {
  return `/api/v1/files/${id}`;
}
export const buildImageCompressionCaption = (_opt: any) => '';
export const buildUnsupportedImageNotice = (mime: string, _name?: string) =>
  `Unsupported image format: ${mime}`;
export const compressBase64ForModel = async (b64: string, mime: string, _opt?: any) => ({
  base64: b64,
  mimeType: mime,
  width: 100,
  height: 100,
  changed: false,
  originalWidth: 100,
  originalHeight: 100,
  originalByteLength: b64.length,
  finalByteLength: b64.length,
});
export const compressImageForModel = async (bytes: Uint8Array, mime: string, _opt?: any) => ({
  data: bytes,
  mimeType: mime,
  width: 100,
  height: 100,
  changed: false,
  originalWidth: 100,
  originalHeight: 100,
  originalByteLength: bytes.length,
  finalByteLength: bytes.length,
});
export const decodeBase64Prefix = (b64: string) => Buffer.from(b64.slice(0, 48), 'base64');
export const fileNotFoundError = (id: string) => new Error2(40401, `File not found: ${id}`);
export const isModelAcceptedImageMime = (mime: string) =>
  ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime.toLowerCase());
export const MAX_IMAGE_DECODE_BYTES = 64 * 1024 * 1024;
export const normalizeImageMime = (mime: string) => mime.toLowerCase();
export const persistOriginalImage = async (_buf: Buffer, _mime: string, _opt?: any) => '/tmp/original';
export const resolveEffectiveImageMime = (..._args: any[]) => 'image/png';
export const unsupportedImageMimeFromUrl = (_url: string) => null;
export const IMAGE_MIME_BY_SUFFIX: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};
export const VIDEO_MIME_BY_SUFFIX: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
};

export type GetResult = any;
export type ISessionMediaStore = AnyService;
export const ISessionMediaStore = createDecorator<ISessionMediaStore>('sessionMediaStore');
export type ImageCompressionTelemetry = any;
export type ITelemetryService = AnyService;
export const ITelemetryService = createDecorator<ITelemetryService>('telemetryService');
export type PromptFileAttachment = any;

export const terminalSchema = z.object({ id: z.string() }).passthrough();

export interface IFileService {
  save(source: any, filename: string, options?: any): Promise<any>;
  get(fileId: string): Promise<any>;
  delete(fileId: string): Promise<void>;
  [key: string]: any;
}

export type BundledSkillActivation = any;
export type CompactionSummaryOrigin = any;
export type CronJobOrigin = any;
export type CronMissedOrigin = any;
export type HookResultOrigin = any;
export type InjectionOrigin = any;
export type PluginCommandOrigin = any;
export type RetryOrigin = any;
export type ShellCommandOrigin = any;
export type SkillActivationOrigin = any;
export type SkillSource = any;
export type SystemTriggerOrigin = any;
export type TaskOrigin = any;
export type UserPromptOrigin = any;
export type CompactionBlockedPayload = any;
export type CompactionCompletedPayload = any;
export type CompactionStartedPayload = any;
export type GoalActor = any;

export type TurnEndReason = any;
export type HookResultPayload = any;
export type CompactionResult = any;
export type McpOAuthAuthorizationUrlUpdateData = any;
export type PermissionMode = any;
export type WarningEvent = any;
export type PluginCommandActivatedPayload = any;
export type TurnStepRetryingPayload = any;
export type AgentTaskStatus = any;
export type UsageStatus = any;
export type FinishReason = any;
export type TokenUsage = any;
export type SubagentSuspendedPayload = any;
export type ToolUpdate = any;
export type ContextMessage = any;
export type Program = any;
export type CronTask = any;
export type IHostFileSystem = any;
export const IHostFileSystem = createDecorator<IHostFileSystem>('hostFileSystem');
export type RuntimeCapability = any;
export type RuntimeLease = any;
export type IWorkspaceContext = any;
export type IWorkspaceDirs = any;
export type ISessionMcpHandle = any;
export const ISessionMcpHandle = createDecorator<ISessionMcpHandle>('sessionMcpHandle');
export type IWorkspaceTrust = any;
export type SessionWireFields = any;
export type UpdateSessionProfileRequest = any;
export type ScopedEntry = any;
export class GitService {
  constructor(..._args: any[]) {}
  [key: string]: any;
}
export class WorkspaceFsService {
  constructor(..._args: any[]) {}
  [key: string]: any;
}
export class WorkspaceGitService {
  constructor(..._args: any[]) {}
  [key: string]: any;
}
const KIMI_FILE_SCHEME = 'kimi-file://';
export function parseDaemonFileUrl(url: string): { fileId: string } | undefined {
  if (typeof url !== 'string' || !url.startsWith(KIMI_FILE_SCHEME)) return undefined;
  const rest = url.slice(KIMI_FILE_SCHEME.length);
  const q = rest.indexOf('?');
  const fileId = q === -1 ? rest : rest.slice(0, q);
  return fileId.length > 0 ? { fileId } : undefined;
}
export function daemonFileRefFromPart(
  part: any,
): { kind: 'image' | 'video'; ref: { fileId: string } } | undefined {
  if (!part) return undefined;
  if (part.type === 'image_url' && part.imageUrl?.url) {
    const ref = parseDaemonFileUrl(part.imageUrl.url);
    if (ref) return { kind: 'image', ref };
  }
  if (part.type === 'video_url' && part.videoUrl?.url) {
    const ref = parseDaemonFileUrl(part.videoUrl.url);
    if (ref) return { kind: 'video', ref };
  }
  return undefined;
}
export type ContextUndone = any;
export type CronFired = any;
export type GoalUpdated = any;
export type TurnEnded = any;
export type TurnSteer = any;
export type AgentErrorEvent = any;
export type PluginCommandActivated = any;
export type WarningIssued = any;
export type PromptAccepted = any;
export type PromptQueued = any;
export type SkillActivated = any;
export type TurnStepRetrying = any;
export type AgentStatusUpdated = any;
export type PlanRevision = any;
export type SubagentSuspended = any;
export type AgentActivityUpdated = any;
export type ContextSpliced = any;
export type HookResult = any;
export type StepStartOutcome = any;
export type TurnStepStartedPayload = any;
export type ToolCallExecution = any;
export type HookRegisteredPayload = any;
export type McpOAuthAuthorizedPayload = any;
export type McpServerRegisteredPayload = any;
export type McpServerUnregisteredPayload = any;
export type ToolExecutedPayload = any;
export type ToolExecutionStartingPayload = any;
export type ToolExecutionProgressPayload = any;
export type TurnAbortedPayload = any;
export type TurnEndedPayload = any;
export type TurnResumedPayload = any;
export type TurnStartedPayload = any;
export type GoalUpdatedPayload = any;
export type TaskTerminatedPayload = any;
export type SubagentSpawnedPayload = any;
export type SubagentPhaseChangedPayload = any;
export type SubagentFailedPayload = any;
export type SubagentDetachedPayload = any;
export type SubagentTerminatedPayload = any;
export type UserPromptAddedPayload = any;
export type AssistantTurnCompletedPayload = any;
export type AssistantTextDeltaPayload = any;
export type AssistantThinkingDeltaPayload = any;
export type FileWatchEvent = any;
export type GoalBudgetLimits = any;
export type GoalBudgetReport = any;
export type GoalChange = any;
export type GoalChangeKind = any;
export type GoalChangeStats = any;
export type GoalSnapshot = any;
export type GoalStatus = any;
export type GoalToolResult = any;
export type AssistantDeltaPayload = any;
export type ThinkingDeltaPayload = any;
export type ToolCallDeltaPayload = any;
export type TurnStepCompletedPayload = any;
export type TurnStepInterruptedPayload = any;
export type McpServerStatusEventPayload = any;
export type McpServerStatusPayload = any;
export type ToolListUpdatedPayload = any;
export type ToolListUpdatedReason = any;
export type ShellCompletedPayload = any;
export type ShellOutputPayload = any;
export type ShellStartedPayload = any;
export type ToolCallStartedPayload = any;
export type ToolProgressPayload = any;
export type ToolResultEventPayload = any;
export type SubagentCompletedPayload = any;
export type SubagentStartedPayload = any;
export type QuestionItem = {
  question: string;
  options: readonly QuestionOption[];
  header?: string;
  body?: string;
  multiSelect?: boolean;
  otherLabel?: string;
  otherDescription?: string;
  [key: string]: any;
};
export type QuestionOption = {
  label: string;
  description?: string;
  [key: string]: any;
};
export type QuestionRequest = {
  questions: readonly QuestionItem[];
  turnId?: number;
  toolCallId?: string;
  [key: string]: any;
};
export type QuestionResult = any;
export type ApprovalRequest = any;
export type ApprovalResponse = any;
export type SessionMeta = any;
export type SessionSummary = any;
export type Workspace = any;
export type FileMeta = any;
export type SessionListQuery = any;
export type Page<_T = any> = any;





export interface IScopeHandle {
  readonly id: string;
  readonly accessor: Scope['accessor'];
  [key: string]: any;
}

export interface ISessionScopeHandle {
  readonly id: string;
  readonly accessor: Scope['accessor'];
  [key: string]: any;
}

export interface IAgentScopeHandle {
  readonly id: string;
  readonly accessor: Scope['accessor'];
  [key: string]: any;
}

export interface IDisposable {
  dispose(): void;
  [key: string]: any;
}

export interface Interaction {
  readonly id: string;
  readonly kind: 'approval' | 'question';
  readonly payload: unknown;
  readonly origin: { readonly agentId?: string; readonly turnId?: number };
  readonly createdAt: number;
}
export type InteractionKind = Interaction['kind'];

export interface SessionActivityState {
  readonly busy: boolean;
  readonly mainTurnActive: boolean;
  readonly pendingInteraction: string;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  readonly turn?: { readonly turnId: number; readonly step: number };
  [key: string]: any;
}
export type AgentActivityState = any;





export type ModelRecord = {
  provider: string;
  model?: string;
  maxContextSize: number;
  displayName?: string;
  capabilities?: string[];
  maxOutputSize?: number;
  supportEfforts?: string[];
  adaptiveThinking?: boolean;
  [key: string]: any;
};
export type ProviderConfig = {
  type: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  oauth?: unknown;
  [key: string]: any;
};
export type ModelsSection = Record<string, ModelRecord>;
export type ProvidersSection = Record<string, ProviderConfig>;

export const MODELS_SECTION = 'models';
export const PROVIDERS_SECTION = 'providers';
export const DEFAULT_MODEL_SECTION = 'default_model';
export const DEFAULT_PROVIDER_SECTION = 'default_provider';
export const MODEL_CATALOG_SECTION = 'model_catalog';





export type MarketplaceLocation = { raw: string; kind: string; resolved: string };
export type PluginMarketplaceEntry = {
  id: string;
  version: string;
  tier?: string;
  displayName?: string;
  description?: string;
  homepage?: string;
  keywords?: string[];
  source?: string;
  [key: string]: any;
};
export type PluginMarketplace = {
  plugins: PluginMarketplaceEntry[];
  [key: string]: any;
};

export function computeUpdateStatus(..._args: any[]): { kind: 'up-to-date' | 'update' | 'unknown' } {
  return { kind: 'unknown' };
}
export function parsePluginMarketplace(_raw: string, _location: MarketplaceLocation, _homeDir?: string): PluginMarketplace {
  return { plugins: [] };
}
export async function readPluginMarketplace(..._args: any[]): Promise<{ raw: string; location: MarketplaceLocation }> {
  return { raw: '{}', location: { raw: '', kind: 'local', resolved: '' } };
}
export async function withLatestVersions(_marketplace: PluginMarketplace, _fetchImpl?: unknown): Promise<PluginMarketplace> {
  return _marketplace;
}





export type SkillDefinition = {
  name: string;
  description?: string;
  path?: string;
  source?: string;
  metadata: { type?: string; disableModelInvocation?: boolean; [key: string]: any };
  [key: string]: any;
};
export type ExtraSkillDirsConfig = string[];
export type MergeAllAvailableSkillsConfig = boolean;
export const EXTRA_SKILL_DIRS_SECTION = 'extra_skill_dirs';
export const MERGE_ALL_AVAILABLE_SKILLS_SECTION = 'merge_all_available_skills';
export const SKILL_SOURCE_PRIORITY = { builtin: 0, plugin: 1, extra: 2, user: 3, workspace: 4 };
export const AGENT_WIRE_RECORD_KEY = 'agent_wire_records';

export class InMemorySkillCatalog {
  register(_skill: unknown, _opts?: unknown): void {}
  listSkills(): readonly SkillDefinition[] {
    return [];
  }
  getSkill(_id: string): SkillDefinition | undefined {
    return undefined;
  }
  ready: Promise<void> = Promise.resolve();
  [key: string]: any;
}

export function builtinProductSkillsEnabled(_config: unknown): boolean {
  return false;
}
export function visibleBuiltinSkills(_enabled: boolean, _flags: unknown): readonly SkillDefinition[] {
  return [];
}
export function isUserActivatableSkillType(_type: string): boolean {
  return true;
}
export async function userRoots(..._args: any[]): Promise<string[]> {
  return [];
}
export async function projectRoots(..._args: any[]): Promise<string[]> {
  return [];
}
export async function configuredRoots(..._args: any[]): Promise<string[]> {
  return [];
}





export type PromptHandle = any;
export type PromptQueueSnapshot = any;
export type PromptReservation = any;
export type PromptWithSkillsResult = any;

export function promptMetadataTextFromContentParts(parts?: any[]): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}
export function reservePrompt(promptService: any, requestedPromptId?: string): PromptReservation {
  const id = requestedPromptId ?? ('p_' + Math.random().toString(36).slice(2, 10));
  return {
    promptId: id,
    submit: async (msg: any) => {
      const handle = {
        id,
        userMessageId: id,
        state: 'queued',
        message: msg,
        createdAt: Date.now(),
        launched: Promise.resolve(),
        completion: new Promise(() => {}),
      };
      if (promptService?.enqueue) {
        promptService.enqueue(handle);
      }
      return handle;
    },
  };
}

export async function applyPromptMetadataUpdate(ctx: any, text?: string): Promise<void> {
  if (typeof text === 'string' && text.trim().length > 0) {
    if (ctx.sessionId) {
      let data = sessionDataStore.get(ctx.sessionId);
      if (!data) {
        data = { cronTasks: new Map<string, any>(), recordedPrompts: [] };
        sessionDataStore.set(ctx.sessionId, data);
      }
      data.recordedPrompts = data.recordedPrompts ?? [];
      data.recordedPrompts.push(text);
    }
    const meta = await ctx.metadata?.read?.();
    if (meta && (!meta.title || meta.title.trim().length === 0)) {
      await ctx.metadata?.setTitle?.(text);
      ctx.eventService?.publish?.(
        new SessionMetaUpdated({
          payload: {
            agentId: 'main',
            sessionId: ctx.sessionId,
            title: text,
            patch: { title: text },
          },
        }),
      );
    }
  }
}





export class ProfileError extends Error2 {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'ProfileError';
  }
}

export const FileErrors = {
  codes: {
    NOT_FOUND: 'file.not_found',
    FILE_NOT_FOUND: 'file.not_found',
    TOO_MANY_PARTS: 'file.too_many_parts',
    FILE_TOO_MANY_PARTS: 'file.too_many_parts',
    TOO_LARGE: 'file.too_large',
    FILE_TOO_LARGE: 'file.too_large',
    UNSUPPORTED: 'file.unsupported',
    FILE_UNSUPPORTED: 'file.unsupported',
  },
  notFound: (id: string) => new Error2(40401, `File not found: ${id}`),
};
export function isFileError(_err: unknown, _code?: string): boolean {
  return false;
}

export class HostFolderNotAbsoluteError extends Error2 {
  constructor(message: string) {
    super(40001, message);
    this.name = 'HostFolderNotAbsoluteError';
  }
}
export class HostFolderNotFoundError extends Error2 {
  constructor(message: string) {
    super(40401, message);
    this.name = 'HostFolderNotFoundError';
  }
}
export class HostFolderPermissionError extends Error2 {
  constructor(message: string) {
    super(40002, message);
    this.name = 'HostFolderPermissionError';
  }
}





export type HostFileStat = any;
export type FsChangeEntry = any;
export type FsChangeEvent = any;
export type IWorkspaceFsWatchSubscription = any;
export type FsPullRequest = {
  setup?: unknown;
  remoteUrl?: string;
  branch?: string;
  [key: string]: any;
};

export const FS_BINARY_SAMPLE_BYTES = 8192;

export function buildEtag(st: { mtimeMs?: number; size?: number; ino?: number }): string {
  return [
    Math.floor(st.mtimeMs ?? 0).toString(36),
    (st.size ?? 0).toString(36),
    (st.ino ?? 0).toString(36),
  ].join('-');
}

const EXT_TO_MIME: Readonly<Record<string, string>> = {
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'application/toml',
  '.sh': 'text/x-shellscript',
  '.py': 'text/x-python',
  '.rs': 'text/rust',
  '.go': 'text/x-go',
  '.log': 'text/plain',
  '.txt': 'text/plain',
};

export function guessMime(relPath: string, isBinary: boolean = false): string {
  const ext = extname(relPath).toLowerCase();
  const mapped = EXT_TO_MIME[ext];
  if (mapped !== undefined) return mapped;
  return isBinary ? 'application/octet-stream' : 'text/plain';
}





export type SessionMediaFile = any;
export type AgentTaskInfo = any;
export type ToolInfo = any;
export type ToolSource = any;
export type AgentMeta = any;
export type WireRecord = { type: string; [key: string]: any };
export type ContextTranscript = {
  records: readonly WireRecord[];
  entries: readonly ContextMessage[];
  times: readonly (number | undefined)[];
  foldedLength: number;
};
export interface ContextTranscriptReducer {
  add(record: WireRecord): void;
  result(): ContextTranscript;
}
export function createContextTranscriptReducer(..._args: any[]): ContextTranscriptReducer {
  return {
    add() {},
    result: () => ({ records: [], entries: [], times: [], foldedLength: 0 }),
  };
}
export type ModelCatalogConfig = any;
export type CloudAppender = any;
export type AgentRuntimeBindingSnapshot = { agentId: string; runtimeId: string; [key: string]: any };
export type SessionWorkspaceAssociationSnapshot = { sessionId: string; workspaceId: string; [key: string]: any };
export type WorkspaceInstanceSnapshot = { id: string; root: string; [key: string]: any };
export type WorkspaceInstancesSnapshot = { instances: readonly WorkspaceInstanceSnapshot[] };
export type QuestionAnswers = any;

export function snapshotAgentRuntimeBinding(..._args: any[]): AgentRuntimeBindingSnapshot {
  return { agentId: '', runtimeId: 'local' };
}
export function snapshotSessionWorkspaceAssociation(..._args: any[]): SessionWorkspaceAssociationSnapshot {
  return { sessionId: '', workspaceId: '' };
}
export function reduceContextTranscript(records: readonly unknown[]): { entries: readonly ContextMessage[] } {
  const entries: ContextMessage[] = [];
  const anchors: number[] = [];
  let floor = 0;
  for (const raw of records) {
    const record = raw as { type?: string; count?: unknown; message?: ContextMessage };
    if (record.type === 'context.append_message' && record.message !== undefined) {
      if (isUndoAnchor(record.message)) anchors.push(entries.length);
      entries.push(record.message);
      continue;
    }
    if (record.type === 'context.undo') {
      const count = typeof record.count === 'number' && Number.isSafeInteger(record.count) ? record.count : 0;
      for (let i = 0; i < count && anchors.length > floor; i++) {
        const at = anchors.pop()!;
        if (at < entries.length) entries.length = at;
      }
      continue;
    }
    if (record.type === 'context.clear' || record.type === 'context.apply_compaction') {
      floor = anchors.length;
      continue;
    }
  }
  return { entries };
}
export function createCloudAppender(..._args: any[]): CloudAppender {
  return { flush: async () => {}, dispose: () => {} };
}
export function resolveTowerRepoRoot(_cwd: string): string {
  return _cwd;
}

export class TowerStore {
  constructor(_root: string) {}
  load(): Promise<{ sessionId: string | undefined }> {
    return Promise.resolve({ sessionId: undefined });
  }
  init(_sessionId: string): Promise<void> {
    return Promise.resolve();
  }
  [key: string]: any;
}

export function getScopedServiceDescriptors(scope: LifecycleScope): readonly ScopedEntry[] {
  if (scope === LifecycleScope.App) {
    return Array.from(allDecorators.values()).map((id) => ({ id }) as any);
  }
  return [];
}





type ServiceAlias = AnyService;

export { type AnyService };
export type ISessionApprovalService = ServiceAlias;
export const ISessionApprovalService = createDecorator<ISessionApprovalService>('sessionApprovalService');
export type IAgentFileHistoryService = ServiceAlias;
export const IAgentFileHistoryService = createDecorator<IAgentFileHistoryService>('agentFileHistoryService');
export type IRuntimeResolver = ServiceAlias;
export const IRuntimeResolver = createDecorator<IRuntimeResolver>('runtimeResolver');
export type ISessionContext = ServiceAlias;
export const ISessionContext = createDecorator<ISessionContext>('sessionContext');
export type ISessionWorkspaceContext = ServiceAlias;
export const ISessionWorkspaceContext = createDecorator<ISessionWorkspaceContext>('sessionWorkspaceContext');
export type IStandaloneRuntimeFactory = ServiceAlias;
export const IStandaloneRuntimeFactory = createDecorator<IStandaloneRuntimeFactory>('standaloneRuntimeFactory');
export type IWorkspaceFsService = ServiceAlias;
export const IWorkspaceFsService = createDecorator<IWorkspaceFsService>('workspaceFsService');
export type IWorkspaceInstanceManager = ServiceAlias;
export const IWorkspaceInstanceManager = createDecorator<IWorkspaceInstanceManager>('workspaceInstanceManager');
export type IKosongConfigService = ServiceAlias;
export const IKosongConfigService = createDecorator<IKosongConfigService>('kosongConfigService');
export type IModelCatalog = ServiceAlias;
export const IModelCatalog = createDecorator<IModelCatalog>('modelCatalog');
export type IModelsDevImportService = ServiceAlias;
export const IModelsDevImportService = createDecorator<IModelsDevImportService>('modelsDevImportService');
export type IAgentPermissionModeService = ServiceAlias;
export const IAgentPermissionModeService = createDecorator<IAgentPermissionModeService>('agentPermissionModeService');
export type IAgentProfileService = ServiceAlias;
export const IAgentProfileService = createDecorator<IAgentProfileService>('agentProfileService');
export type IAgentRuntimeBindingService = ServiceAlias;
export const IAgentRuntimeBindingService = createDecorator<IAgentRuntimeBindingService>('agentRuntimeBindingService');
export type IAgentToolPolicyService = ServiceAlias;
export const IAgentToolPolicyService = createDecorator<IAgentToolPolicyService>('agentToolPolicyService');
export type IAgentPromptService = ServiceAlias;
export const IAgentPromptService = createDecorator<IAgentPromptService>('agentPromptService');
export type IAgentSkillService = ServiceAlias;
export const IAgentSkillService = createDecorator<IAgentSkillService>('agentSkillService');
export type IAuthSummaryService = ServiceAlias;
export const IAuthSummaryService = createDecorator<IAuthSummaryService>('authSummaryService');
export type IEventBus = ServiceAlias;
export const IEventBus = createDecorator<IEventBus>('eventBus');
export type ISessionSkillCatalog = ServiceAlias;
export const ISessionSkillCatalog = createDecorator<ISessionSkillCatalog>('sessionSkillCatalog');
export type ISessionQuestionService = ServiceAlias;
export const ISessionQuestionService = createDecorator<ISessionQuestionService>('sessionQuestionService');
export type IAgentGoalService = ServiceAlias;
export const IAgentGoalService = createDecorator<IAgentGoalService>('agentGoalService');
export type IAgentPlanService = ServiceAlias;
export const IAgentPlanService = createDecorator<IAgentPlanService>('agentPlanService');
export type IAgentSwarmService = ServiceAlias;
export const IAgentSwarmService = createDecorator<IAgentSwarmService>('agentSwarmService');
export type IAgentTowerService = ServiceAlias;
export const IAgentTowerService = createDecorator<IAgentTowerService>('agentTowerService');
export type ISessionExportService = ServiceAlias;
export const ISessionExportService = createDecorator<ISessionExportService>('sessionExportService');
export type IAgentContextMemoryService = ServiceAlias;
export const IAgentContextMemoryService = createDecorator<IAgentContextMemoryService>('agentContextMemoryService');
export type IAgentConversationUndoService = ServiceAlias;
export const IAgentConversationUndoService = createDecorator<IAgentConversationUndoService>('agentConversationUndoService');
export type IAgentFullCompactionService = ServiceAlias;
export const IAgentFullCompactionService = createDecorator<IAgentFullCompactionService>('agentFullCompactionService');
export type IAgentLoopService = ServiceAlias;
export const IAgentLoopService = createDecorator<IAgentLoopService>('agentLoopService');
export type ISessionActivityView = any;
export const ISessionActivityView = createDecorator<ISessionActivityView>('sessionActivityView');
export type ISessionBtwService = ServiceAlias;
export const ISessionBtwService = createDecorator<ISessionBtwService>('sessionBtwService');
export type ISessionLegacyService = ServiceAlias;
export const ISessionLegacyService = createDecorator<ISessionLegacyService>('sessionLegacyService');
export type ISessionTitleService = ServiceAlias;
export const ISessionTitleService = createDecorator<ISessionTitleService>('sessionTitleService');
export type IWorkspaceAliases = ServiceAlias;
export const IWorkspaceAliases = createDecorator<IWorkspaceAliases>('workspaceAliases');
export type ISessionTokenCountingService = ServiceAlias;
export const ISessionTokenCountingService = createDecorator<ISessionTokenCountingService>('sessionTokenCountingService');
export type ISessionUsageService = ServiceAlias;
export const ISessionUsageService = createDecorator<ISessionUsageService>('sessionUsageService');
export type IModelService = ServiceAlias;
export const IModelService = createDecorator<IModelService>('modelService');
export type IAgentBlobService = ServiceAlias;
export const IAgentBlobService = createDecorator<IAgentBlobService>('agentBlobService');
export type IAgentScopeContext = ServiceAlias;
export const IAgentScopeContext = createDecorator<IAgentScopeContext>('agentScopeContext');
export type IWireService = ServiceAlias;
export const IWireService = createDecorator<IWireService>('wireService');
export type IAgentMcpService = ServiceAlias;
export const IAgentMcpService = createDecorator<IAgentMcpService>('agentMcpService');
export type IAgentToolRegistryService = ServiceAlias;
export const IAgentToolRegistryService = createDecorator<IAgentToolRegistryService>('agentToolRegistryService');
export type IAgentTaskService = ServiceAlias;
export const IAgentTaskService = createDecorator<IAgentTaskService>('agentTaskService');
export type ISessionTerminalService = ServiceAlias;
export const ISessionTerminalService = createDecorator<ISessionTerminalService>('sessionTerminalService');
export type IAgentRuntimeService = ServiceAlias;
export const IAgentRuntimeService = createDecorator<IAgentRuntimeService>('agentRuntimeService');
export type IWorkspaceSessions = ServiceAlias;
export const IWorkspaceSessions = createDecorator<IWorkspaceSessions>('workspaceSessions');
export type ISkillDiscovery = ServiceAlias;
export const ISkillDiscovery = createDecorator<ISkillDiscovery>('skillDiscovery');
export type IHostFolderBrowser = ServiceAlias;
export const IHostFolderBrowser = createDecorator<IHostFolderBrowser>('hostFolderBrowser');
export type IOAuthToolkit = ServiceAlias;
export const IOAuthToolkit = createDecorator<IOAuthToolkit>('oauthToolkit');

export type IAgentActivityView = any;
export const IAgentActivityView = createDecorator<IAgentActivityView>('agentActivityView');





export type CompactionBlocked = any;
export type CompactionCancelled = any;
export type CompactionCompleted = any;
export type CompactionStarted = any;
export type TurnStepStarted = any;
export type PromptAborted = any;
export type PromptCompleted = any;
export type PromptStarted = any;
export type PromptSteered = any;
export type PromptSubmitted = any;
export type SubagentCompleted = any;
export type SubagentFailed = any;
export type SubagentSpawned = any;
export type SubagentStarted = any;
export type TaskNotified = any;
export type TaskStarted = any;
export type TaskTerminatedNotice = any;
export type ToolCallStarted = any;
export type ToolProgress = any;
export type ToolResultEvent = any;
export type ShellCompleted = any;
export type ShellOutput = any;
export type ShellStarted = any;
export type AssistantDelta = any;
export type ThinkingDelta = any;
export type ToolCallDelta = any;
export type TurnStepCompleted = any;
export type TurnStepInterrupted = any;
export type FiberState = any;
export const FiberState: Record<string, string> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  blocked: 'blocked',
};
export type IGitService = ServiceAlias;
export const IGitService = createDecorator<IGitService>('gitService');





export interface Event<T> {
  (listener: (e: T) => unknown, thisArg?: unknown): IDisposable;
}

export namespace Event {
  export const None: Event<unknown> = () => ({ dispose() {} });
  export function map<A, B>(event: Event<A>, fn: (a: A) => B): Event<B> {
    return (listener) => event((e) => listener(fn(e)));
  }
}

export class Emitter<T> {
  private _listeners = new Set<(e: T) => void>();
  private _disposed = false;
  private _event: Event<T> | undefined;

  constructor(public readonly debugName?: string) {}

  get event(): Event<T> {
    this._event ??= (listener) => {
      if (this._disposed) return { dispose() {} };
      this._listeners.add(listener);
      return {
        dispose: () => {
          if (this._disposed) return;
          this._listeners.delete(listener);
        },
      };
    };
    return this._event;
  }

  get listenerCount(): number {
    return this._listeners.size;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  fire(value: T): void {
    if (this._disposed) return;
    for (const listener of Array.from(this._listeners)) {
      listener(value);
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._listeners.clear();
  }
}





export class TurnStarted extends Event2<any> {
  override readonly time: number;
  readonly origin: any;
  readonly agentId: string;
  readonly turnId: number;
  constructor(
    payload: { agentId?: string; turnId?: number; origin?: unknown; [key: string]: any },
    time = Date.now(),
  ) {
    super({ payload, type: 'turn.started', time });
    this.time = time;
    this.agentId = payload.agentId ?? 'main';
    this.turnId = payload.turnId ?? 1;
    this.origin = payload.origin;
  }
}

export async function closeSessionById(accessor: Scope['accessor'], sessionId: string): Promise<void> {
  const mgr = accessor.get(ISessionManager) as any;
  if (mgr?.closeSession) {
    await mgr.closeSession(sessionId);
  }
}

export function enqueueSessionInteraction(
  agent: unknown,
  req: { kind?: string; question?: string; id?: string; [key: string]: any },
): unknown {
  const service = agent as any;
  if (!service?._interactions) return undefined;
  const id = req.id ?? 'int_' + Math.random().toString(36).slice(2, 10);
  const item: Interaction = {
    id,
    kind: (req.kind as any) ?? 'approval',
    payload: req['payload'] ?? req,
    origin: (req['origin'] as any) ?? { agentId: MAIN_AGENT_ID, turnId: 1 },
    createdAt: Date.now(),
  };
  service._interactions.set(id, item);
  if (typeof service._sessionId === 'string') {
    wireRecordsOf(service._sessionId).push({
      agentId: item.origin?.agentId ?? MAIN_AGENT_ID,
      record: {
        type: 'interaction.request',
        id,
        kind: item.kind,
        request: item.payload,
        time: Date.now(),
      },
    });
  }
  service._pendingChangeEmitter?.fire({ id, kind: item.kind });
  return item;
}

export function respondSessionInteraction(
  agent: unknown,
  id: string,
  resolution: { decision?: string; [key: string]: any },
): unknown {
  const service = agent as any;
  if (!service?._interactions) return undefined;
  const item = service._interactions.get(id);
  if (!item) return undefined;
  service._interactions.delete(id);
  const resolved = { id, response: resolution, resolution, ...resolution, resolvedAt: Date.now() };
  service._recentlyResolved?.set(id, resolved);
  if (typeof service._sessionId === 'string') {
    wireRecordsOf(service._sessionId).push({
      agentId: item.origin?.agentId ?? MAIN_AGENT_ID,
      record: { type: 'interaction.resolved', id, response: resolution, time: Date.now() },
    });
  }
  service._resolveEmitter?.fire(resolved);
  service._pendingChangeEmitter?.fire({ id, kind: item.kind });
  return resolved;
}
export function overrideScopedService(..._args: any[]): void {}
export function getFeatureRecipes(): readonly { name: string; [key: string]: any }[] {
  return [];
}
export function setModelsDevUpstreamForTest(_opts: any): void {}
export function resetModelsDevUpstreamForTest(): void {}
export const agentRuntimeBindingKey = 'agent_runtime_binding';
export function _setTowerFeatureAssembledForTests(_value: boolean): void {}

export const noopTelemetryService = {
  track: () => {},
  withContext: () => ({ track2: () => {} }),
  flush: async () => {},
  shutdown: async () => {},
};

export class TelemetryService {
  addAppender(_appender: any): void {}
  track(_eventName: string, _data?: unknown): void {}
  withContext(): { track2: (...args: any[]) => void } {
    return { track2: () => {} };
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  [key: string]: any;
}

export class InMemoryStorageService {
  async write(_scope: unknown, _key: string, _data: unknown, _options?: unknown): Promise<void> {}
  async read<T>(_scope: unknown, _key: string): Promise<T | undefined> {
    return undefined;
  }
  async delete(_scope: unknown, _key: string): Promise<void> {}
  [key: string]: any;
}

export class Feature {
  contributeService(_scope: LifecycleScope, _id: unknown, _ctor: unknown): void {}
  [key: string]: any;
}

export class Service {
  declare readonly _serviceBrand: undefined;
  [key: string]: any;
}

export function createAppScope(): Scope {
  return {
    accessor: {
      get<T>(_id: ServiceIdentifier<T>): T {
        return undefined as unknown as T;
      },
    },
    get<T>(_id: ServiceIdentifier<T>): T {
      return undefined as unknown as T;
    },
    dispose(): void {},
  };
}

export type IAgentPluginCommandService = ServiceAlias;
export const IAgentPluginCommandService = createDecorator<IAgentPluginCommandService>('agentPluginCommandService');
export type IAgentShellCommandService = ServiceAlias;
export const IAgentShellCommandService = createDecorator<IAgentShellCommandService>('agentShellCommandService');
export type IDebugEventsService = ServiceAlias;
export const IDebugEventsService = createDecorator<IDebugEventsService>('debugEventsService');
export type IInstantiationService = ServiceAlias;
export const IInstantiationService = createDecorator<IInstantiationService>('instantiationService');
export type IAgentInteractionService = ServiceAlias;
export const IAgentInteractionService = createDecorator<IAgentInteractionService>('agentInteractionService');
export type IHostTerminalService = ServiceAlias;
export const IHostTerminalService = createDecorator<IHostTerminalService>('hostTerminalService');
export type ISessionToolPolicy = ServiceAlias;
export const ISessionToolPolicy = createDecorator<ISessionToolPolicy>('sessionToolPolicy');
export type IAgentTitlePromptSource = ServiceAlias;
export const IAgentTitlePromptSource = createDecorator<IAgentTitlePromptSource>('agentTitlePromptSource');
export type IAgentStateService = ServiceAlias;
export const IAgentStateService = createDecorator<IAgentStateService>('agentStateService');
export type IHostRequestHeaders = ServiceAlias;
export const IHostRequestHeaders = createDecorator<IHostRequestHeaders>('hostRequestHeaders');

export type AuthSummary = any;
export type ConfigSectionChangedEvent = any;
export type ManagedUserInfoResult = any;
export type AgentContext = any;
export type InteractionPendingChangedEvent = any;
export interface InteractionRequest<TPayload = any, _TResponse = any> {
  id?: string;
  kind: InteractionKind;
  payload: TPayload;
  origin?: { agentId?: string; turnId?: number; [key: string]: any };
  question?: string;
  [key: string]: any;
}
export type InteractionResolution = any;
export type SessionActivityCause = any;
export type SessionActivityChangedEvent = any;
export type AgentTask = any;
export type ITelemetryAppender = any;
export type Terminal = any;
export type TerminalProcess = any;
export type TerminalSpawnOptions = any;
export type ExecutableTool = any;
export type GlobalMcpServerConfig = any;
export type McpManagedServer = any;
export type McpServerInspection = any;
export type McpServerLocator = any;
export type McpServerTestTarget = any;
export type FsGitStatusResponse = any;
