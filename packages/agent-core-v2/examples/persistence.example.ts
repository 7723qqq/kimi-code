/**
 * Scenario: the **persistence** module — how the `storage` domain's Services
 * compose into a complete call chain (Store → Storage → backend), shown
 * through the real files that make up `~/.kimi-code`.
 *
 * Instead of writing to a made-up scope, each access pattern is demonstrated
 * against the actual on-disk path a real Domain Service persists to, so the
 * resulting files mirror a real `~/.kimi-code` tree:
 *
 *  - `config.toml` — an **atomic document** (TOML codec), written through
 *    `IAtomicTomlDocumentStore` (the same Store `config` uses).
 *  - `sessions/<workspace>/<session>/session-meta/state.json` — an **atomic
 *    document** (JSON codec), written through `IAtomicDocumentStore` (the same
 *    Store `session-metadata` uses).
 *  - `wire/<hash>.jsonl` — an **append log** (JSONL framing), written through
 *    `IAppendLogStore` (the same Store `wireRecord` uses). `wireRecord` keys the
 *    log by a hash of the home dir; this example writes one record stream under
 *    the same `wire/` scope.
 *
 * For each, a typed value goes through the Store and is then read back as raw
 * bytes through the Storage token beneath it, exposing the codec / framing the
 * Store hides. All three Stores sit on distinct tokens of the same
 * `IStorageService` interface (`IStorageService`, `IAtomicDocumentStorage`,
 * `IAppendLogStorage`); `bootstrap` routes each to its own `FileStorageService`
 * here, and a server profile could route any one of them to a different backend
 * — that is the composition-root routing these distinct tokens enable.
 *
 * All Services come from `src/`; nothing here defines a new Service.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, test } from 'vitest';

import type { Scope } from '#/_base/di/scope';
import { bootstrap } from '#/bootstrap/bootstrap';
import {
  IAppendLogStorage,
  IAppendLogStore,
  IAtomicDocumentStorage,
  IAtomicDocumentStore,
  IAtomicTomlDocumentStore,
  IStorageService,
} from '#/storage';
import '#/storage/index';

const textDecoder = new TextDecoder();

function decode(bytes: Uint8Array | undefined): string {
  return bytes === undefined ? '(undefined)' : textDecoder.decode(bytes);
}

const WIRE_KEY = 'example';

describe('persistence module (Store → Storage → backend, real ~/.kimi-code files)', () => {
  let homeDir: string;
  let app: Scope;

  beforeEach(() => {
    const resolved = process.env['KIMI_CODE_HOME'];
    if (resolved === undefined) {
      throw new Error('KIMI_CODE_HOME is not set; globalSetup should have initialized it');
    }
    homeDir = resolved;
    mkdirSync(homeDir, { recursive: true });
    app = bootstrap({ homeDir }).app;
  });

  afterEach(() => {
    app.dispose();
  });

  test('typed Store → raw Storage bytes → real file path', async () => {
    // 1) Atomic document, TOML codec → config.toml
    const tomlDocs = app.accessor.get(IAtomicTomlDocumentStore);
    const configBytes = app.accessor.get(IStorageService);
    const configValue = { theme: 'dark', telemetry: { enabled: true } };
    await tomlDocs.set('', 'config.toml', configValue);
    console.log('1) config.toml (atomic doc, TOML):');
    console.log('   typed get :', await tomlDocs.get('', 'config.toml'));
    console.log('   raw bytes :');
    for (const line of decode(await configBytes.read('', 'config.toml')).trim().split('\n')) {
      console.log('     ', line);
    }
    console.log('   path      :', join(homeDir, 'config.toml'));

    // 2) Atomic document, JSON codec → sessions/.../session-meta/state.json
    const docs = app.accessor.get(IAtomicDocumentStore);
    const docBytes = app.accessor.get(IAtomicDocumentStorage);
    const metaScope = 'sessions/example/s-example/session-meta';
    const meta = {
      id: 's-example',
      title: 'example session',
      createdAt: 1_000,
      updatedAt: 2_000,
      archived: false,
    };
    await docs.set(metaScope, 'state.json', meta);
    console.log('2) state.json (atomic doc, JSON):');
    console.log('   typed get :', await docs.get(metaScope, 'state.json'));
    console.log('   raw bytes :', decode(await docBytes.read(metaScope, 'state.json')).trim());
    console.log('   path      :', join(homeDir, metaScope, 'state.json'));

    // 3) Append log, JSONL framing → wire/<hash>.jsonl
    const logs = app.accessor.get(IAppendLogStore);
    const logBytes = app.accessor.get(IAppendLogStorage);
    const key = WIRE_KEY;
    logs.append('wire', key, { type: 'metadata', protocol_version: '1.5' });
    logs.append('wire', key, { type: 'swarm_mode.enter', trigger: 'manual' });
    logs.append('wire', key, { type: 'swarm_mode.exit' });
    await logs.flush();

    const readBack: unknown[] = [];
    for await (const record of logs.read('wire', key)) {
      readBack.push(record);
    }
    console.log('3) wire/<hash>.jsonl (append log, JSONL):');
    console.log('   typed read:', readBack);
    console.log('   raw bytes :');
    for (const line of decode(await logBytes.read('wire', key)).trim().split('\n')) {
      console.log('     ', line);
    }
    console.log('   path      :', join(homeDir, 'wire', `${key}.jsonl`));
  });
});
