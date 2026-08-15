/**
 * `mcpCore` domain — SSE transport MCP client.
 */

import { Client, SSEClientTransport, SseError } from '@modelcontextprotocol/client';
import type { OAuthClientProvider } from '@modelcontextprotocol/client';
import { t } from '@moonshot-ai/kimi-i18n';

import { ErrorCodes, Error2 } from '#/errors';

import { buildMcpRemoteHeaders } from './client-remote';
import {
  buildRequestOptions,
  KIMI_MCP_CLIENT_NAME,
  KIMI_MCP_CLIENT_VERSION,
  MCP_LIVENESS_PROBE_TIMEOUT_MS,
  toMcpToolDefinition,
  toMcpToolResult,
  type UnexpectedCloseListener,
  type UnexpectedCloseReason,
} from './client-shared';
import type { McpServerSseConfig } from './config-schema';
import { createMcpOAuthFetch } from './oauth/provider';
import type { MCPClient, MCPToolDefinition, MCPToolResult } from './types';

export interface SseMcpClientOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly startupTimeoutMs?: number;
  readonly toolCallTimeoutMs?: number;
  readonly envLookup?: (name: string) => string | undefined;
  readonly fetch?: typeof fetch;
  readonly oauthProvider?: OAuthClientProvider;
}

export class SseMcpClient implements MCPClient {
  private readonly client: Client;
  private readonly config: McpServerSseConfig;
  private readonly envLookup: (name: string) => string | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly authProvider: OAuthClientProvider | undefined;
  private readonly startupTimeoutMs?: number;
  private readonly toolCallTimeoutMs?: number;
  private transport: SSEClientTransport | undefined;
  private started = false;
  private closed = false;
  private ready = false;
  private hooksInstalled = false;
  private unexpectedCloseListener: UnexpectedCloseListener | undefined;
  private lastTransportError: Error | undefined;
  private pendingUnexpectedClose: UnexpectedCloseReason | undefined;
  private unexpectedCloseFired = false;

  constructor(config: McpServerSseConfig, options: SseMcpClientOptions = {}) {
    this.config = config;
    this.envLookup = options.envLookup ?? ((name) => process.env[name]);
    this.fetchImpl = options.fetch;
    this.authProvider = options.oauthProvider;
    this.client = new Client({
      name: options.clientName ?? KIMI_MCP_CLIENT_NAME,
      version: options.clientVersion ?? KIMI_MCP_CLIENT_VERSION,
    });
    this.startupTimeoutMs = options.startupTimeoutMs;
    this.toolCallTimeoutMs = options.toolCallTimeoutMs;
  }

  private async ensureTransport(): Promise<SSEClientTransport> {
    if (this.transport !== undefined) return this.transport;
    const headers = await buildMcpRemoteHeaders(this.config, this.envLookup);
    this.transport = new SSEClientTransport(new URL(this.config.url), {
      requestInit: headers !== undefined ? { headers } : undefined,
      fetch: createMcpOAuthFetch(this.authProvider, this.fetchImpl),
      authProvider: this.authProvider,
    });
    return this.transport;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error2(ErrorCodes.MCP_STARTUP_FAILED, t('v2Errors.mcpSseClientClosed'));
    }
    if (this.started) return;
    this.started = true;
    this.installTransportHooks();
    try {
      await this.client.connect(
        await this.ensureTransport(),
        buildRequestOptions(this.startupTimeoutMs),
      );
    } catch (error) {
      await this.closeStartedClient();
      throw error;
    }
    if (this.closed) {
      await this.closeStartedClient();
      throw new Error2(
        ErrorCodes.MCP_STARTUP_FAILED,
        t('v2Errors.mcpSseClientClosedDuringStartup'),
      );
    }
    this.ready = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.closeStartedClient();
  }

  onUnexpectedClose(listener: UnexpectedCloseListener): void {
    this.unexpectedCloseListener = listener;
    const pending = this.pendingUnexpectedClose;
    if (pending !== undefined) {
      this.pendingUnexpectedClose = undefined;
      listener(pending);
    }
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    const result = await this.client.listTools(
      undefined,
      buildRequestOptions(this.startupTimeoutMs),
    );
    return result.tools.map(toMcpToolDefinition);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPToolResult> {
    const requestOptions = buildRequestOptions(this.toolCallTimeoutMs, signal);
    const result = await this.client.callTool({ name, arguments: args }, requestOptions);
    return toMcpToolResult(result);
  }

  async ping(signal?: AbortSignal): Promise<void> {
    await this.client.ping(buildRequestOptions(MCP_LIVENESS_PROBE_TIMEOUT_MS, signal));
  }

  private async closeStartedClient(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.client.close();
  }

  private installTransportHooks(): void {
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    this.client.onclose = () => {
      if (this.closed) return;
      if (!this.ready) return;
      this.fireUnexpectedClose({ error: this.lastTransportError });
    };
    this.client.onerror = (error) => {
      this.lastTransportError = error;
      if (this.closed) return;
      if (!this.ready) return;
      if (isTerminalSseTransportError(error)) {
        this.fireUnexpectedClose({ error });
      }
    };
  }

  private fireUnexpectedClose(reason: UnexpectedCloseReason): void {
    if (this.unexpectedCloseFired) return;
    this.unexpectedCloseFired = true;
    const listener = this.unexpectedCloseListener;
    if (listener !== undefined) {
      listener(reason);
    } else {
      this.pendingUnexpectedClose = reason;
    }
  }
}

export function isTerminalSseTransportError(error: Error): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'UnauthorizedError') return true;
  return error instanceof SseError && error.code !== undefined && error.code >= 400;
}
