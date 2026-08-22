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
    .replaceAll(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll(/\*/g, '.*')
    .replaceAll(/\?/g, '.');
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
  const m = getNative();
  const fn = m?.['nativeGlobMatchesAny'];
  if (typeof fn === 'function' && options?.nocase !== true) {
    try {
      return (fn as (globs: string[], path: string) => boolean)([pattern], value);
    } catch {}
  }
  return simpleGlobMatch(value, pattern, options?.nocase);
}
