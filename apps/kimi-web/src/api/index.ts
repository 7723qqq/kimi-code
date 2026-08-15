// apps/kimi-web/src/api/index.ts
// Singleton factory for the KimiWebApi daemon client.

import { readKimiApiConfig } from './config';
import { DaemonKimiWebApi } from './daemon/client';
import type { KimiWebApi } from './types';

let singleton: KimiWebApi | undefined;

export function getKimiWebApi(): KimiWebApi {
  singleton ??= new DaemonKimiWebApi(readKimiApiConfig());
  return singleton;
}
