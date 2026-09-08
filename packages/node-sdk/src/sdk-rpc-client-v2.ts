/**
 * v2-compatible client facade, fully routed through the native Rust engine.
 * Eliminates legacy agent-core-v2 runtime dependency while preserving the public SDK interface.
 */

import {
  SDKRpcClientNative,
  type SDKRpcClientNativeOptions,
  createKimiHarnessNative,
} from './native/sdk-rpc-client-native.js';
import type { KimiHarness } from './kimi-harness.js';

export type SDKRpcClientV2Options = SDKRpcClientNativeOptions;

export class SDKRpcClientV2 extends SDKRpcClientNative {}

export function createKimiHarnessV2(options: SDKRpcClientV2Options): KimiHarness {
  return createKimiHarnessNative(options);
}

export const createKimiHarness = createKimiHarnessV2;
