const MAX_TRACKED_LINES = 1024;
const MAX_TRACKED_SESSIONS = 32;
const rendered = new Map<string, Set<string>>();

export function lineFingerprint(line: string): string {
  return new Bun.CryptoHasher('sha256')
    .update(line.trim().toLowerCase())
    .digest('hex')
    .slice(0, 16);
}

function setFor(sessionKey: string): Set<string> {
  let set = rendered.get(sessionKey);
  if (set === undefined) {
    set = new Set();
    rendered.set(sessionKey, set);
    while (rendered.size > MAX_TRACKED_SESSIONS) {
      const oldest = rendered.keys().next().value;
      if (oldest === undefined) break;
      rendered.delete(oldest);
    }
  }
  return set;
}

export function alreadyRendered(sessionKey: string, line: string): boolean {
  return rendered.get(sessionKey)?.has(lineFingerprint(line)) ?? false;
}

export function markRendered(sessionKey: string, lines: readonly string[]): void {
  const set = setFor(sessionKey);
  for (const line of lines) {
    set.add(lineFingerprint(line));
    if (set.size <= MAX_TRACKED_LINES) continue;
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

export function resetRendered(sessionKey?: string): void {
  if (sessionKey === undefined) rendered.clear();
  else rendered.delete(sessionKey);
}
