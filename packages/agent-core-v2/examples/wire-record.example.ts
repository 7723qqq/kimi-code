/**
 * Scenario: the **wire-record** module — a durable-record + replay chain built
 * on the append-log Store.
 *
 * Shows how a real Domain Service (`IAgentWireRecordService` / `AgentWireRecordService`)
 * aggregates the `IAppendLogStore` access pattern into a complete engine call
 * chain: `append` stamps and persists records (writing a `metadata` header
 * first), and `restore` reads the log back and replays each record through the
 * `register`-ed resumers so domain state can be rebuilt after a restart. The
 * record types (`swarm_mode.enter` / `swarm_mode.exit`) come from the real
 * `swarm` domain's `WireRecordMap` declaration merge.
 *
 * Persistence is gated on the `homedir` option: the scoped-registered
 * `IAgentWireRecordService` passes no options and is therefore in-memory only, so this
 * scenario constructs the real `AgentWireRecordService` with `createInstance(...,
 * { homedir })` — the same way production wires a persisting wire record —
 * resolving its `IAppendLogStore` dependency from the container. The resumers
 * are small side callbacks (not Services). All resolved Services come from
 * `src/`; nothing here defines a new Service.
 */

import { mkdirSync } from 'node:fs';

import { afterEach, beforeEach, describe, test } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IAppendLogStorage } from '#/persistence/interface/storage';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { AgentWireRecordService, type IAgentWireRecordService } from '#/agent/wireRecord';
import '#/agent/swarm/swarm';

const textDecoder = new TextDecoder();

describe('wire-record module (durable record + replay over IAppendLogStore)', () => {
  let homeDir: string;
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    const resolved = process.env['KIMI_CODE_HOME'];
    if (resolved === undefined) {
      throw new Error('KIMI_CODE_HOME is not set; globalSetup should have initialized it');
    }
    homeDir = resolved;
    mkdirSync(homeDir, { recursive: true });

    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IAppendLogStorage, new FileStorageService(homeDir));
        reg.define(IAppendLogStore, AppendLogStore);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  test('appends to a JSONL log, then restores and replays through resumers', async () => {
    const logBytes = ix.get(IAppendLogStorage);

    // --- writer side: append records, which persist to wire/<hash>.jsonl ---
    const writer: IAgentWireRecordService = ix.createInstance(AgentWireRecordService, { homedir: homeDir });

    writer.append({ type: 'swarm_mode.enter', trigger: 'manual' });
    writer.append({ type: 'swarm_mode.exit' });
    await writer.flush();

    const [logKey] = await logBytes.list('wire');
    const raw = textDecoder.decode((await logBytes.read('wire', logKey)) ?? new Uint8Array());
    console.log('1) persisted log key:', logKey);
    console.log('2) raw JSONL (metadata header + appended records):');
    for (const line of raw.trim().split('\n')) {
      console.log('    ', line);
    }

    // --- reader side: a fresh instance on the same log replays the records ---
    const replayed: string[] = [];
    const reader: IAgentWireRecordService = ix.createInstance(AgentWireRecordService, { homedir: homeDir });
    reader.register('swarm_mode.enter', (rec) => {
      replayed.push(`enter(trigger=${rec.trigger})`);
    });
    reader.register('swarm_mode.exit', () => {
      replayed.push('exit');
    });

    const result = await reader.restore();
    console.log('3) restore result:', result);
    console.log('4) resumers replayed (in order):', replayed);
  });
});
