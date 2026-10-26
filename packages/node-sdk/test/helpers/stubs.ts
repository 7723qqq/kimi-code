const envOriginals = new Map<string, string | undefined>();

const globalOriginals = new Map<string, PropertyDescriptor | undefined>();

const globalHolder = globalThis as unknown as Record<string, unknown>;

export function setEnv(name: string, value: string | undefined): void {
  if (!envOriginals.has(name)) envOriginals.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export function restoreEnvs(): void {
  for (const [name, original] of envOriginals) {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
  envOriginals.clear();
}

export function setGlobal(name: string, value: unknown): void {
  if (!globalOriginals.has(name)) {
    globalOriginals.set(name, Object.getOwnPropertyDescriptor(globalHolder, name));
  }
  Object.defineProperty(globalHolder, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

export function restoreGlobals(): void {
  for (const [name, descriptor] of globalOriginals) {
    if (descriptor === undefined) delete globalHolder[name];
    else Object.defineProperty(globalHolder, name, descriptor);
  }
  globalOriginals.clear();
}
