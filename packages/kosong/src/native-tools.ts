/**
 * Lazy-loaded bindings to the Rust native tools (`@moonshot-ai/kimi-native-tools`)
 * for token estimation only.
 *
 * Mirrors the pattern in agent-core-v2's `_base/native-tools.ts` but scoped to
 * the two functions `tokens.ts` needs, so the shared contract layer can use
 * the native fast path without depending on the engine. Best-effort: when the
 * addon is unavailable or the call throws, wrappers return `undefined` and the
 * TypeScript fallback runs.
 */
import { createRequire } from 'node:module';

const requireNative = createRequire(import.meta.url);

// Three-state cache: undefined = not tried, null = tried & failed, object = loaded.
let nativeModule: Record<string, unknown> | null | undefined;

function getNativeModule(): Record<string, unknown> | undefined {
  if (process.env['KIMI_NATIVE_TOOLS_FORCE_JS']) return undefined;
  if (nativeModule === null) return undefined;
  if (nativeModule !== undefined) return nativeModule;
  try {
    nativeModule = requireNative('@moonshot-ai/kimi-native-tools') as Record<string, unknown>;
    return nativeModule ?? undefined;
  } catch {
    nativeModule = null;
    return undefined;
  }
}

function callNativeSync<T>(name: string, args: unknown[]): T | undefined {
  const mod = getNativeModule();
  if (!mod) return undefined;
  const fn = mod[name];
  if (typeof fn !== 'function') return undefined;
  try {
    const result = (fn as (...callArgs: unknown[]) => unknown)(...args);
    return (result as T) ?? undefined;
  } catch {
    return undefined;
  }
}

export function tryNativeEstimateTokens(text: string): number | undefined {
  return callNativeSync<number>('nativeEstimateTokens', [text]);
}

export function tryNativeEstimateTokensBatch(texts: readonly string[]): number | undefined {
  return callNativeSync<number>('nativeEstimateTokensBatch', [[...texts]]);
}
