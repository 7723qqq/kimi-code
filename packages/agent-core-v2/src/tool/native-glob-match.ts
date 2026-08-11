let nativeModule: Record<string, unknown> | null | undefined;

function getNative(): Record<string, unknown> | undefined {
  if (nativeModule === null) return undefined;
  if (nativeModule !== undefined) return nativeModule;
  try {
    nativeModule = require('@moonshot-ai/kimi-native-tools') as Record<string, unknown>;
    return nativeModule ?? undefined;
  } catch {
    nativeModule = null;
    return undefined;
  }
}

function simpleGlobMatch(value: string, pattern: string, nocase = false): boolean {
  if (pattern === '*') return true;
  if (nocase) {
    value = value.toLowerCase();
    pattern = pattern.toLowerCase();
  }
  if (!pattern.includes('*') && !pattern.includes('?')) return value === pattern;

  const reStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  try {
    return new RegExp(`^${reStr}$`, nocase ? 'i' : undefined).test(value);
  } catch {
    return false;
  }
}

export function tryNativeGlobMatch(
  value: string,
  pattern: string,
  options?: { nocase?: boolean },
): boolean {
  // The native matcher is case-sensitive; when nocase semantics are requested,
  // fall back to the case-insensitive JS matcher instead of dropping the flag.
  const m = getNative();
  const fn = m?.['nativeGlobMatchesAny'];
  if (typeof fn === 'function' && options?.nocase !== true) {
    try {
      return (fn as (globs: string[], path: string) => boolean)([pattern], value);
    } catch {
      // fall through
    }
  }
  return simpleGlobMatch(value, pattern, options?.nocase);
}
