/**
 * `lsp` domain — one language server process instance.
 *
 * Spawns the server through `ISessionProcessRunner`, performs the
 * initialize/initialized handshake (rejecting non-UTF-16 position encodings),
 * and serves queries serially: each query opens the target file, issues the
 * semantic request, and closes the file again. Aborted queries send
 * `$/cancelRequest` and, after a grace period, tear the instance down so a
 * stuck server cannot wedge the session. `dispose` walks the teardown ladder
 * (shutdown request → SIGTERM → SIGKILL).
 */

import { basename } from 'pathe';

import { Error2, ErrorCodes } from '#/errors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IProcess, ISessionProcessRunner } from '#/session/process/processRunner';

import type { LspServerConfig } from './configSection';
import type { LspProviderQuery, LspQueryResult } from './lsp';
import { LspConnection } from './lspConnection';
import type {
  LspHoverResponse,
  LspInitializeResult,
  LspReferencesResponse,
  LspTextDocumentPositionParams,
} from './protocol';
import { normalizeHoverResponse, normalizeLocationsResponse, pathToUri } from './translate';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
const DEFAULT_KILL_GRACE_MS = 2000;
const DEFAULT_CANCEL_GRACE_MS = 2000;

export class LspInstance {
  private readonly process: IProcess;
  private readonly connection: LspConnection;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;

  private constructor(
    process: IProcess,
    connection: LspConnection,
    private readonly config: LspServerConfig,
    private readonly hostFs: IHostFileSystem,
    private readonly workspaceRoot: string,
  ) {
    this.process = process;
    this.connection = connection;
  }

  static async create(
    config: LspServerConfig,
    processRunner: ISessionProcessRunner,
    hostFs: IHostFileSystem,
    workspaceRoot: string,
  ): Promise<LspInstance> {
    const process = await processRunner.exec([config.command, ...(config.args ?? [])], {
      cwd: workspaceRoot,
      env: config.env,
    });
    const connection = new LspConnection(process, serverRequestHandler);
    const instance = new LspInstance(process, connection, config, hostFs, workspaceRoot);
    await instance.initialize();
    return instance;
  }

  get isClosed(): boolean {
    return this.disposed;
  }

  query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult> {
    const run = this.tail.then(() => this.doQuery(request, signal));
    this.tail = run.catch(() => {});
    return run;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await withTimeout(
        this.connection.request('shutdown'),
        this.config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      );
      this.connection.notify('exit');
    } catch {
      // Server did not answer shutdown; fall through to force-kill.
    }
    this.connection.dispose();
    await this.killLadder();
  }

  private async initialize(): Promise<void> {
    const result = await this.connection.request<LspInitializeResult>('initialize', {
      processId: null,
      rootUri: pathToUri(this.workspaceRoot),
      workspaceFolders: [
        { uri: pathToUri(this.workspaceRoot), name: basename(this.workspaceRoot) },
      ],
      capabilities: {
        textDocument: { hover: { contentFormat: ['plaintext', 'markdown'] } },
        workspace: { configuration: true },
      },
      ...(this.config.initializationOptions === undefined
        ? {}
        : { initializationOptions: this.config.initializationOptions }),
    });
    const positionEncoding = result.capabilities.positionEncoding;
    if (positionEncoding !== undefined && positionEncoding !== 'utf-16') {
      throw new Error2(
        ErrorCodes.LSP_UNSUPPORTED_OPERATION,
        `LSP server "${this.config.command}" uses position encoding "${positionEncoding}"; only utf-16 is supported`,
      );
    }
    this.connection.notify('initialized');
  }

  private async doQuery(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult> {
    const uri = pathToUri(request.filePath);
    const content = await this.hostFs.readText(request.filePath);
    this.connection.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: request.languageId,
        version: 1,
        text: content,
      },
    });
    let cancelTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      cancelTimer = setTimeout(() => {
        void this.dispose();
      }, this.config.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
    };
    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const params: LspTextDocumentPositionParams = {
        textDocument: { uri },
        position: request.position,
      };
      const response = await this.requestOperation(request, params, signal);
      return translateResponse(request, response);
    } finally {
      if (cancelTimer !== undefined) clearTimeout(cancelTimer);
      if (signal !== undefined) {
        signal.removeEventListener('abort', onAbort);
      }
      this.connection.notify('textDocument/didClose', { textDocument: { uri } });
    }
  }

  private requestOperation(
    request: LspProviderQuery,
    params: LspTextDocumentPositionParams,
    signal?: AbortSignal,
  ): Promise<unknown> {
    switch (request.operation) {
      case 'goToDefinition':
        return this.connection.request('textDocument/definition', params, signal);
      case 'findReferences':
        return this.connection.request(
          'textDocument/references',
          { ...params, context: { includeDeclaration: true } },
          signal,
        );
      case 'goToImplementation':
        return this.connection.request('textDocument/implementation', params, signal);
      case 'hover':
        return this.connection.request('textDocument/hover', params, signal);
    }
  }

  private async killLadder(): Promise<void> {
    try {
      await this.process.kill('SIGTERM');
    } catch {
      // Process already gone.
    }
    const exited = await Promise.race([
      this.process.wait().then(() => true),
      sleep(this.config.killGraceMs ?? DEFAULT_KILL_GRACE_MS).then(() => false),
    ]);
    if (!exited) {
      try {
        await this.process.kill('SIGKILL');
      } catch {
        // Process already gone.
      }
    }
  }
}

function translateResponse(request: LspProviderQuery, response: unknown): LspQueryResult {
  switch (request.operation) {
    case 'goToDefinition':
    case 'goToImplementation':
      return { kind: 'locations', locations: normalizeLocationsResponse(response) };
    case 'findReferences':
      return {
        kind: 'locations',
        locations: normalizeLocationsResponse(response as LspReferencesResponse),
      };
    case 'hover':
      return { kind: 'hover', hover: normalizeHoverResponse(response as LspHoverResponse) };
  }
}

async function serverRequestHandler(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case 'workspace/configuration':
      return configurationResponse(params);
    case 'client/registerCapability':
    case 'client/unregisterCapability':
    case 'workspace/didChangeConfiguration':
      return null;
    case 'workspace/applyEdit':
      throw new Error('workspace/applyEdit is not supported');
    default:
      return null;
  }
}

function configurationResponse(params: unknown): unknown[] {
  if (typeof params !== 'object' || params === null) return [];
  const items = (params as { readonly items?: readonly { readonly section?: string }[] }).items;
  if (items === undefined) return [];
  return items.map(() => null);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error('LSP shutdown timed out');
    }),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
