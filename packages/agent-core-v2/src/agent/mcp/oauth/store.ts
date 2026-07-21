/**
 * `mcp` domain (L5) — MCP OAuth credential store.
 *
 * Persists OAuth tokens, registered DCR client info, and discovery state for
 * MCP HTTP servers through the `storage` access-pattern store
 * (`IAtomicDocumentStore`) under the `credentials/mcp` scope
 * (`<homeDir>/credentials/mcp/<key>-*.json`). One logical record per
 * `(serverName, serverUrl)` identity, addressed by {@link mcpOAuthStoreKey}.
 *
 * Read semantics: missing or corrupt JSON resolves to `undefined` (never
 * throws). The provider treats `undefined` as "not stored".
 *
 * Security: tokens are encrypted at rest with AES-256-GCM, keyed from the
 * host machine identity. Legacy plain-text records are still readable.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

import { basename } from 'pathe';

import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

const CREDENTIALS_SCOPE = 'credentials/mcp';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

/** Derive a 32-byte encryption key from hostname + fixed salt. */
function deriveKey(): Buffer {
  const raw = `${hostname()}:kimi-code-mcp-oauth-v1`;
  return createHash('sha256').update(raw).digest();
}

interface EncryptedBlob {
  iv: string;
  tag: string;
  data: string;
}

function encrypt(value: string): EncryptedBlob {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  };
}

function decrypt(blob: EncryptedBlob): string {
  const key = deriveKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(blob.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(blob.data, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function sanitizeStoreKey(name: string): string {
  const safe = basename(name).replaceAll(/[^a-zA-Z0-9_-]/g, '_').replaceAll(/_+/g, '_');
  if (safe.length === 0 || safe.startsWith('.')) {
    throw new Error(`Invalid MCP OAuth store key: "${name}"`);
  }
  return safe;
}

export function canonicalMcpOAuthResource(serverUrl: string | URL): string {
  const url = new URL(serverUrl);
  url.hash = '';
  return url.toString();
}

export function mcpOAuthStoreKey(serverName: string, serverUrl: string | URL): string {
  const safeName = sanitizeStoreKey(serverName);
  const resource = canonicalMcpOAuthResource(serverUrl);
  const digest = createHash('sha256')
    .update(serverName)
    .update('\0')
    .update(resource)
    .digest('hex')
    .slice(0, 24);
  return `${safeName}-${digest}`;
}

export interface McpOAuthStore {
  read<T>(key: string): Promise<T | undefined>;
  write(key: string, data: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export function createMcpOAuthStore(docs: IAtomicDocumentStore): McpOAuthStore {
  return {
    async read<T>(key: string): Promise<T | undefined> {
      try {
        const raw = await docs.get<EncryptedBlob | T>(CREDENTIALS_SCOPE, key);
        if (raw === undefined) return undefined;
        // Support both encrypted (new) and plain (legacy) storage.
        if (typeof raw === 'object' && raw !== null && 'iv' in raw && 'tag' in raw && 'data' in raw) {
          return JSON.parse(decrypt(raw as EncryptedBlob)) as T;
        }
        return raw as T;
      } catch {
        return undefined;
      }
    },
    write(key, data) {
      const encrypted = encrypt(JSON.stringify(data));
      return docs.set(CREDENTIALS_SCOPE, key, encrypted);
    },
    remove(key) {
      return docs.delete(CREDENTIALS_SCOPE, key);
    },
  };
}