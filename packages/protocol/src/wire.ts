import { createHash } from 'node:crypto';
import { basename } from 'node:path';

/**
 * Wire protocol contract shared by every engine generation.
 *
 * `WIRE_PROTOCOL_VERSION` versions the on-disk `wire.jsonl` journal layout;
 * the migration chain for older journals lives in the consumer (vis keeps its
 * own frozen copy). MCP OAuth credential naming is also an on-disk contract
 * (the `<home>/credentials/mcp/<key>[-tokens].json` layout both the engine and
 * the SDK's test fixtures must agree on).
 */

export const WIRE_PROTOCOL_VERSION = '1.5';

/** Whether a read journal version is newer than the current protocol. */
export function isNewerWireVersion(readVersion: string): boolean {
  return compareWireVersions(readVersion, WIRE_PROTOCOL_VERSION) > 0;
}

/** Lexicographic dotted-version comparison (like `1.10` > `1.9`). */
export function compareWireVersions(a: string, b: string): number {
  const partsA = a.split('.');
  const partsB = b.split('.');
  const maxLength = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < maxLength; i++) {
    const diff = Number(partsA[i] ?? '0') - Number(partsB[i] ?? '0');
    if (diff !== 0) return diff;
  }
  return 0;
}

export const MCP_OAUTH_META_SUFFIX = '-meta.json';
export const MCP_OAUTH_TOKENS_SUFFIX = '-tokens.json';

export interface McpOAuthStoreMeta {
  readonly serverName: string;
  readonly serverUrl: string;
}

export interface McpOAuthStore {
  read<T>(key: string): Promise<T | undefined>;
  write(key: string, data: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  list(prefix?: string): Promise<readonly string[]>;
}

/** File-name-safe server id: basename, non-alnum runs folded to `_`. */
export function sanitizeMcpStoreKey(name: string): string {
  const safe = basename(name)
    .replaceAll(/[^a-zA-Z0-9_-]/g, '_')
    .replaceAll(/_+/g, '_');
  if (safe.length === 0 || safe.startsWith('.')) {
    throw new Error(`Invalid MCP OAuth store key: "${name}"`);
  }
  return safe;
}

/** Normalize a server URL for OAuth identity: hash and query stripped. */
export function canonicalMcpOAuthResource(serverUrl: string | URL): string {
  const url = new URL(serverUrl);
  url.hash = '';
  return url.toString();
}

/**
 * Deterministic credential-document key for one MCP server: the sanitized
 * server name plus a 24-hex digest of `serverName\0canonicalUrl`. The engine
 * persists `<key>-tokens.json` / `<key>-meta.json` under
 * `<home>/credentials/mcp`; fixtures pre-write the same names.
 */
export function mcpOAuthStoreKey(serverName: string, serverUrl: string | URL): string {
  const safeName = sanitizeMcpStoreKey(serverName);
  const resource = canonicalMcpOAuthResource(serverUrl);
  const digest = createHash('sha256')
    .update(serverName)
    .update('\0')
    .update(resource)
    .digest('hex')
    .slice(0, 24);
  return `${safeName}-${digest}`;
}