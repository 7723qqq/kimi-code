/**
 * `mcpConfig` domain — `IMcpOAuthStore`, the App-scope persistence
 * adapter for MCP OAuth credentials.
 *
 * Implements the `mcp` domain's `McpOAuthStore` port over the `persistence`
 * access-pattern store (`IAtomicDocumentStore`) under the `credentials/mcp`
 * scope (`<homeDir>/credentials/mcp/<key>-*.json`). One App-scope instance is
 * shared by every workspace handler's `McpOAuthService`, replacing the
 * per-handler stores they used to build ad hoc; the on-disk layout is
 * unchanged, so credentials stay shared with out-of-engine readers. The
 * {@link createMcpOAuthStore} factory remains exported for those
 * out-of-engine callers, which run an `McpOAuthService` outside the DI
 * container.
 *
 * Security: tokens are encrypted at rest with AES-256-GCM. The key is
 * derived from the host identity (hostname + machine id + username), so the
 * ciphertext is useless on any other machine. This is defense in depth on
 * top of the credential file's 0600 permissions: it protects against
 * disk/backup exfiltration, not against a same-user process that can read
 * the home directory (such a process can read the key material too).
 * Legacy plain-text records are still readable.
 *
 * Read semantics: missing or corrupt JSON resolves to `undefined` (never
 * throws). The provider treats `undefined` as "not stored".
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import type { McpOAuthStore } from '#/mcpCore/oauth/store';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

export interface IMcpOAuthStore extends McpOAuthStore {
  readonly _serviceBrand: undefined;
}

export const IMcpOAuthStore: ServiceIdentifier<IMcpOAuthStore> =
  createDecorator<IMcpOAuthStore>('mcpOAuthStore');

const CREDENTIALS_SCOPE = 'credentials/mcp';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

// ── Host identity for key derivation ─────────────────────────────────────────
// No native registry/Keychain API exists in Node, so the machine id is read
// once via the platform's canonical source and cached. Any failure falls
// back to hostname-only derivation (still better than nothing, and no worse
// than the previous scheme).

let machineIdCache: string | null | undefined; // undefined = not tried yet

function loadMachineId(): string | undefined {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'reg.exe',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf8', timeout: 3000, windowsHide: true },
      );
      return /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/.exec(out)?.[1];
    }
    for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const id = readFileSync(p, 'utf8').trim();
        if (id !== '') return id;
      } catch {
        // try next source
      }
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
        timeout: 3000,
      });
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1];
    }
  } catch {
    // fall back to hostname-only derivation
  }
  return undefined;
}

function hostMachineId(): string | undefined {
  if (machineIdCache === undefined) {
    machineIdCache = loadMachineId() ?? null;
  }
  return machineIdCache ?? undefined;
}

/** Derive a 32-byte encryption key from host identity + fixed salt. */
function deriveKey(): Buffer {
  let username: string;
  try {
    username = userInfo().username;
  } catch {
    username = 'unknown-user';
  }
  const raw = `${hostname()}:${hostMachineId() ?? 'no-machine-id'}:${username}:kimi-code-mcp-oauth-v1`;
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

export class McpOAuthStoreAdapter implements IMcpOAuthStore {
  declare readonly _serviceBrand: undefined;

  private readonly delegate: McpOAuthStore;

  constructor(@IAtomicDocumentStore docs: IAtomicDocumentStore) {
    this.delegate = createMcpOAuthStore(docs);
  }

  read<T>(key: string): Promise<T | undefined> {
    return this.delegate.read<T>(key);
  }

  write(key: string, data: unknown): Promise<void> {
    return this.delegate.write(key, data);
  }

  remove(key: string): Promise<void> {
    return this.delegate.remove(key);
  }
}

registerScopedService(
  LifecycleScope.App,
  IMcpOAuthStore,
  McpOAuthStoreAdapter,
  ScopeActivation.OnDemand,
  'mcpConfig',
);
