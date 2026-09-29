/**
 * Lazy-loaded bindings to the Rust native tools (`@moonshot-ai/kimi-agent/native`)
 * for token estimation only.
 *
 * Mirrors the pattern in agent-core-v2's `_base/native-tools.ts` but scoped to
 * the two functions `tokens.ts` needs, so the shared contract layer gets the
 * native fast path without *blocking* on the engine: the addon is optional at
 * runtime and the pure-TypeScript estimator is the fallback. Best-effort: when
 * the addon is unavailable or the call throws, wrappers return `undefined` and
 * the TypeScript fallback runs.
 *
 * **This is a real build-time dependency, not a soft one.** The package declares
 * `@moonshot-ai/kimi-agent` in `dependencies`, and `architecture.json` lists
 * `kimi-agent` among kosong's deps for the same reason. This comment used to
 * claim the opposite — that the shared contract layer could reach the native
 * path "without depending on the engine" — while the line below required it.
 * The *runtime* dependency is soft; the *build* dependency is not, and
 * conflating them is part of why the edge stayed invisible to
 * `check:architecture` (which never read a `workspace:^` manifest entry).
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
    nativeModule = requireNative('@moonshot-ai/kimi-agent/native') as Record<string, unknown>;
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
  } catch (error) {
    // A thrown native call is never silently treated as "module missing" —
    // the JS fallback still runs, and callers that surface the failure
    // (e.g. the Bash tool's onThrown callback) report it through their own
    // channel. The stderr note is opt-in: a raw write mid-frame corrupts an
    // interactive TUI's differential screen model, so it is gated behind
    // KIMI_NATIVE_TOOLS_DEBUG=1.
    if (process.env['KIMI_NATIVE_TOOLS_DEBUG'] !== '1') return undefined;
    const message = error instanceof Error ? error.message : String(error);
    try {
      process.stderr.write(`[native-tools] native ${name} threw: ${message}\n`);
    } catch {
      // stderr itself failed — nothing sensible left to do.
    }
    return undefined;
  }
}

export function tryNativeEstimateTokens(text: string): number | undefined {
  return callNativeSync<number>('nativeEstimateTokens', [text]);
}

export function tryNativeEstimateTokensBatch(texts: readonly string[]): number | undefined {
  return callNativeSync<number>('nativeEstimateTokensBatch', [[...texts]]);
}
