/**
 * Scenario: the **config** slice — shown through a real consumer,
 * `IModelService`, and how config changes propagate to it.
 *
 * Rather than registering a toy section, this example drives the real
 * `IModelService` (the `models` config-section owner). It registers its section
 * and effective overlay on construction, reads the section through
 * `IConfigService`, and forwards section changes as its own `onDidChange`. The
 * timeline walks three sources of change and shows the service reacting to
 * each:
 *
 *  1. **default** — no `config.toml` yet; `list()` is empty, `inspect` shows
 *     the value coming from the default.
 *  2. **file edit** — write a `[models]` section to `config.toml` and
 *     `reload()`; the service fires `onDidChange` and `get(alias)` reflects the
 *     file value (`inspect` now reports the user layer).
 *  3. **programmatic set** — `modelService.set(...)` writes through config,
 *     fires `onDidChange` again, and persists back to `config.toml` (the raw
 *     file now holds both aliases).
 *
 * All Services come from `src/`; nothing here defines a new Service.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, test } from 'vitest';

import type { Scope } from '#/_base/di/scope';
import { bootstrap } from '#/bootstrap/bootstrap';
import { type ConfigInspectValue, IConfigService } from '#/config/config';
import '#/config/index';
import { logSeed, resolveLoggingConfig } from '#/log/logConfig';
import { IModelService, type ModelAlias, type ModelsSection } from '#/model';
import '#/model/index';
import '#/storage/index';

const kimiK2Thinking: ModelAlias = {
  provider: 'moonshot',
  model: 'kimi-k2-thinking',
  maxContextSize: 262_144,
  reasoningKey: 'reasoning_content',
};

describe('config slice (real consumer: IModelService reacts to change)', () => {
  let homeDir: string;
  let core: Scope;
  let configPath: string;

  beforeEach(() => {
    const resolved = process.env['KIMI_CODE_HOME'];
    if (resolved === undefined) {
      throw new Error('KIMI_CODE_HOME is not set; globalSetup should have initialized it');
    }
    homeDir = resolved;
    mkdirSync(homeDir, { recursive: true });
    configPath = join(homeDir, 'config.toml');
    core = bootstrap({ homeDir }, logSeed(resolveLoggingConfig({ homeDir, env: process.env }))).core;
  });

  afterEach(() => {
    core.dispose();
  });

  test('propagates default → file edit → programmatic set to IModelService', async () => {
    const config = core.accessor.get(IConfigService);
    const models = core.accessor.get(IModelService);
    await config.ready;

    const changes: string[] = [];
    models.onDidChange(() => changes.push(`models changed → ${Object.keys(models.list()).join(',') || '(empty)'}`));

    const inspect = (): ConfigInspectValue<ModelsSection> => config.inspect<ModelsSection>('models');

    // 1) default — nothing persisted yet.
    console.log('1) default:');
    console.log('   list():', models.list());
    console.log('   inspect source layers:', summarizeInspect(inspect()));

    // 2) file edit — write a [models] section and reload.
    writeFileSync(
      configPath,
      [
        '[models.kimi-k2]',
        'provider = "moonshot"',
        'model = "kimi-k2-0905-preview"',
        'max_context_size = 262144',
        '',
      ].join('\n'),
    );
    await config.reload();
    console.log('2) after writing config.toml + reload():');
    console.log('   get("kimi-k2"):', models.get('kimi-k2'));
    console.log('   inspect source layers:', summarizeInspect(inspect()));

    // 3) programmatic set — persists through config and fires another change.
    await models.set('kimi-k2-thinking', kimiK2Thinking);
    console.log('3) after modelService.set("kimi-k2-thinking", ...):');
    console.log('   list() aliases:', Object.keys(models.list()));
    console.log('   config.toml now:');
    for (const line of readFileSync(configPath, 'utf8').trim().split('\n')) {
      console.log('     ', line);
    }

    console.log('change timeline (modelService.onDidChange):');
    changes.forEach((entry, index) => console.log(`   ${index + 1}. ${entry}`));
  });
});

function summarizeInspect(inspect: ConfigInspectValue<ModelsSection>): Record<string, unknown> {
  return {
    hasUserValue: inspect.userValue !== undefined,
    hasMemoryValue: inspect.memoryValue !== undefined,
    aliases: Object.keys(inspect.value ?? {}),
  };
}
