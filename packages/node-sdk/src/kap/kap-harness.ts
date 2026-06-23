import { KimiHarness } from '#/kimi-harness';
import type { KimiHarnessOptions } from '#/types';

import { SDKKapClient } from './kap-client';

export function createKimiKapHarness(
  options: KimiHarnessOptions & { kap: NonNullable<KimiHarnessOptions['kap']> },
): KimiHarness {
  const client = new SDKKapClient(options);
  return new KimiHarness(client, {
    identity: client.identity,
    uiMode: options.uiMode,
    homeDir: client.homeDir,
    configPath: client.configPath,
    auth: client.auth,
    telemetry: client.telemetry,
    ensureConfigFile: () => Promise.resolve(),
    onClose: () => client.close(),
    sessionStartedProperties: options.sessionStartedProperties,
  });
}
