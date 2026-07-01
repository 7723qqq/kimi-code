/**
 * Scenario: the **feature-flags** slice — `flag` for real, `config` stubbed.
 *
 * Demonstrates running a slice's real services while stubbing the
 * collaborators outside it. `IFlagService` and `IFlagRegistry` are real, so
 * flag resolution (env → config → default) and `setConfigOverrides` behave
 * exactly as in production; the `config` registry/service and `bootstrap` env
 * lookup are stubbed, because the scenario does not need a real config file or
 * process environment. A flag is contributed inline so the slice is
 * self-contained.
 */

import { afterEach, beforeEach, describe, test } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { FlagService } from '#/app/flag/flagService';
import { type ExperimentalFlagConfig, IFlagService } from '#/app/flag/flag';
import { IFlagRegistry, registerFlagDefinition } from '#/app/flag/flagRegistry';
import { FlagRegistryService } from '#/app/flag/flagRegistryService';

registerFlagDefinition({
  id: 'demo_flag',
  title: 'Demo flag',
  description: 'An example-only experimental flag.',
  env: 'KIMI_CODE_EXPERIMENTAL_DEMO_FLAG',
  default: false,
  surface: 'core',
});

describe('feature-flags slice (flag, with config stubbed)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let configValue: ExperimentalFlagConfig;

  beforeEach(() => {
    disposables = new DisposableStore();
    configValue = {};
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IConfigRegistry, { registerSection: () => {} });
        reg.definePartialInstance(IConfigService, {
          ready: Promise.resolve(),
          get: () => configValue,
          onDidChangeConfiguration: () => toDisposable(() => {}),
        });
        reg.definePartialInstance(IBootstrapService, { getEnv: () => undefined });
        reg.define(IFlagRegistry, FlagRegistryService);
        reg.define(IFlagService, FlagService);
      },
    });
  });
  afterEach(() => {
    disposables.dispose();
  });

  test('resolves a flag from its default, then from a config override', () => {
    const flags = ix.get(IFlagService);

    const initial = flags.explain('demo_flag');
    console.log('initial:', {
      enabled: initial?.enabled,
      source: initial?.source,
      default: initial?.defaultEnabled,
    });

    configValue = { demo_flag: true };
    flags.setConfigOverrides(configValue);
    const overridden = flags.explain('demo_flag');
    console.log('after setConfigOverrides({ demo_flag: true }):', {
      enabled: overridden?.enabled,
      source: overridden?.source,
    });
  });
});
