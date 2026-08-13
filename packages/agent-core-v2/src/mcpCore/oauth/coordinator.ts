/**
 * `mcpCore` domain — `McpOAuthCredentialsCoordinator`, the cross-domain
 * notification seam for MCP OAuth credential changes.
 *
 * `McpOAuthService` reports credential updates/invalidations through the
 * coordinator; the workspace MCP service subscribes and reconnects the
 * affected server once its current connection settles. One coordinator per
 * engine app, shared by every `McpOAuthService` instance.
 */

import { canonicalMcpOAuthResource } from './store';

export interface McpOAuthCredentialsChangedEvent {
  readonly serverName: string;
  readonly serverUrl: string;
  readonly kind: 'updated' | 'invalidated';
}

export interface McpOAuthCredentialsCoordinator {
  notifyCredentialsChanged(serverName: string, serverUrl: string | URL): void;
  notifyCredentialsInvalidated(serverName: string, serverUrl: string | URL): void;
  onCredentialsChanged(listener: (event: McpOAuthCredentialsChangedEvent) => void): () => void;
}

export class McpOAuthCoordinator implements McpOAuthCredentialsCoordinator {
  private readonly listeners = new Set<(event: McpOAuthCredentialsChangedEvent) => void>();

  notifyCredentialsChanged(serverName: string, serverUrl: string | URL): void {
    const event = {
      serverName,
      serverUrl: canonicalMcpOAuthResource(serverUrl),
      kind: 'updated' as const,
    };
    for (const listener of this.listeners) listener(event);
  }

  notifyCredentialsInvalidated(serverName: string, serverUrl: string | URL): void {
    const event = {
      serverName,
      serverUrl: canonicalMcpOAuthResource(serverUrl),
      kind: 'invalidated' as const,
    };
    for (const listener of this.listeners) listener(event);
  }

  onCredentialsChanged(listener: (event: McpOAuthCredentialsChangedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
