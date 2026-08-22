import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { promisify } from 'node:util';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import type { McpOAuthStore } from '#/mcpCore/oauth/store';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

const execFileAsync = promisify(execFile);

export interface IMcpOAuthStore extends McpOAuthStore {
  readonly _serviceBrand: undefined;
}

export const IMcpOAuthStore: ServiceIdentifier<IMcpOAuthStore> =
  createDecorator<IMcpOAuthStore>('mcpOAuthStore');

const CREDENTIALS_SCOPE = 'credentials/mcp';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

let machineIdPromise: Promise<string | null> | undefined;

async function loadMachineId(): Promise<string | undefined> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'reg.exe',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf8', timeout: 3000, windowsHide: true },
      );
      return /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/.exec(stdout)?.[1];
    }
    for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const id = readFileSync(p, 'utf8').trim();
        if (id !== '') return id;
      } catch {
      }
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
        timeout: 3000,
      });
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)?.[1];
    }
  } catch {
  }
  return undefined;
}

function hostMachineId(): Promise<string | undefined> {
  machineIdPromise ??= loadMachineId().then(
    (id) => id ?? null,
    () => null,
  );
  return machineIdPromise.then((id) => id ?? undefined);
}

async function deriveKey(): Promise<Buffer> {
  let username: string;
  try {
    username = userInfo().username;
  } catch {
    username = 'unknown-user';
  }
  const machineId = await hostMachineId();
  const raw = `${hostname()}:${machineId ?? 'no-machine-id'}:${username}:kimi-code-mcp-oauth-v1`;
  return createHash('sha256').update(raw).digest();
}

interface EncryptedBlob {
  iv: string;
  tag: string;
  data: string;
}

async function encrypt(value: string): Promise<EncryptedBlob> {
  const key = await deriveKey();
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

async function decrypt(blob: EncryptedBlob): Promise<string> {
  const key = await deriveKey();
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
        if (
          typeof raw === 'object' &&
          raw !== null &&
          'iv' in raw &&
          'tag' in raw &&
          'data' in raw
        ) {
          return JSON.parse(await decrypt(raw as EncryptedBlob)) as T;
        }
        return raw as T;
      } catch {
        return undefined;
      }
    },
    async write(key, data) {
      const encrypted = await encrypt(JSON.stringify(data));
      return docs.set(CREDENTIALS_SCOPE, key, encrypted);
    },
    remove(key) {
      return docs.delete(CREDENTIALS_SCOPE, key);
    },
    async list(suffix) {
      const keys = await docs.list(CREDENTIALS_SCOPE);
      return keys.filter((key) => key.endsWith(suffix));
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

  list(suffix: string): Promise<readonly string[]> {
    return this.delegate.list(suffix);
  }
}

registerScopedService(
  LifecycleScope.App,
  IMcpOAuthStore,
  McpOAuthStoreAdapter,
  ScopeActivation.OnDemand,
  'mcpConfig',
);
