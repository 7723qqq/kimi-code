import { createKimiHarness, type KimiHarness, type KimiHarnessOptions } from '@moonshot-ai/kimi-code-sdk';

const DEFAULT_KAP_SERVER_URL = 'http://127.0.0.1:58627';

export function createTuiHarness(options: Omit<KimiHarnessOptions, 'kap'>): KimiHarness {
  return createKimiHarness({
    ...options,
    kap: { serverUrl: process.env['KIMI_CODE_KAP_URL'] ?? DEFAULT_KAP_SERVER_URL },
  });
}
