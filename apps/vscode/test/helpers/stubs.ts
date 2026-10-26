const savedEnvs = new Map<string, string | undefined>();
const savedGlobals = new Map<string, unknown>();

export function setEnv(name: string, value: string): void {
  if (!savedEnvs.has(name)) savedEnvs.set(name, process.env[name]);
  process.env[name] = value;
}

export function restoreEnvs(): void {
  for (const [name, value] of savedEnvs) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnvs.clear();
}

export function setGlobal(name: string, value: unknown): void {
  const holder = globalThis as unknown as Record<string, unknown>;
  if (!savedGlobals.has(name)) savedGlobals.set(name, holder[name]);
  holder[name] = value;
}

export function restoreGlobals(): void {
  const holder = globalThis as unknown as Record<string, unknown>;
  for (const [name, value] of savedGlobals) holder[name] = value;
  savedGlobals.clear();
}
