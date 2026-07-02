/**
 * Scenario: the **model → provider** slice — inspecting the configured LLM
 * providers and model aliases.
 *
 * Concept taught: provider / model configuration is split across two App-scope
 * registries backed by the `providers` and `models` config sections:
 *
 *   - `IProviderService` (App) holds the configured providers (type, baseUrl,
 *     credentials) and emits `onDidChangeProviders` when the set changes.
 *   - `IModelService` (App) holds model aliases (provider + model id + context
 *     limits) and emits `onDidChangeModels`.
 *
 * Both are read/write registries over `IConfigService`: a `set` validates and
 * persists to `config.toml`, and the change event fires so downstream domains
 * react without threading model lists around.
 *
 * Wiring: the real composition root (`_harness`) provides every collaborator.
 * Each test gets its own isolated `config.toml` (a fresh `homeDir`) so writes
 * in one test cannot leak into the next test's default view.
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/model-provider.example.ts
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { IConfigService } from '#/app/config';
import { IModelService } from '#/app/model';
import { IProviderService } from '#/app/provider';

import { createSliceHost, type SliceHost } from './_harness';

describe('model-provider slice (provider + model registries)', () => {
  let caseDir: string;
  let host: SliceHost;

  beforeEach(() => {
    const resolved = process.env['KIMI_CODE_HOME'];
    if (resolved === undefined) {
      throw new Error('KIMI_CODE_HOME is not set; globalSetup should have initialized it');
    }
    // Give every test its own config.toml so provider / model writes in one test
    // cannot leak into the next test's "empty" default view.
    caseDir = join(resolved, randomUUID());
    mkdirSync(caseDir, { recursive: true });
  });

  afterEach(() => host?.dispose());

  test('IProviderService lists configured providers and reflects set/get/delete', async () => {
    host = createSliceHost({ homeDir: caseDir });
    const config = host.app.accessor.get(IConfigService);
    const providers = host.app.accessor.get(IProviderService);
    await config.ready;

    // Default shape: a record with no entry under our (unused) key. We do not
    // assert exact emptiness — env bindings may synthesize a reserved provider.
    expect(typeof providers.list()).toBe('object');
    expect(providers.get('demo-openai')).toBeUndefined();

    const added: string[] = [];
    const removed: string[] = [];
    const sub = providers.onDidChangeProviders((e) => {
      added.push(...e.added);
      removed.push(...e.removed);
    });

    await providers.set('demo-openai', {
      type: 'openai',
      baseUrl: 'https://example.com/v1',
      apiKey: 'YOUR_API_KEY',
    });

    expect(providers.get('demo-openai')).toMatchObject({
      type: 'openai',
      baseUrl: 'https://example.com/v1',
    });
    expect(providers.list()['demo-openai']).toBeDefined();
    expect(added).toContain('demo-openai');

    await providers.delete('demo-openai');
    sub.dispose();

    expect(providers.get('demo-openai')).toBeUndefined();
    expect(removed).toContain('demo-openai');
  });

  test('IModelService lists configured model aliases and reflects set/get/delete', async () => {
    host = createSliceHost({ homeDir: caseDir });
    const config = host.app.accessor.get(IConfigService);
    const models = host.app.accessor.get(IModelService);
    await config.ready;

    expect(typeof models.list()).toBe('object');
    expect(models.get('demo-model')).toBeUndefined();

    const added: string[] = [];
    const removed: string[] = [];
    const sub = models.onDidChangeModels((e) => {
      added.push(...e.added);
      removed.push(...e.removed);
    });

    await models.set('demo-model', {
      provider: 'demo-openai',
      model: 'gpt-demo',
      maxContextSize: 8192,
    });

    expect(models.get('demo-model')).toMatchObject({
      provider: 'demo-openai',
      model: 'gpt-demo',
    });
    expect(models.list()['demo-model']).toBeDefined();
    expect(added).toContain('demo-model');

    await models.delete('demo-model');
    sub.dispose();

    expect(models.get('demo-model')).toBeUndefined();
    expect(removed).toContain('demo-model');
  });
});
