const savedEnvs = new Map<string, string | undefined>();
const savedDescriptors = new Map<string, PropertyDescriptor | undefined>();

const globalHolder = globalThis as unknown as Record<string, unknown>;

export function setEnv(name: string, value: string | undefined): void {
  if (!savedEnvs.has(name)) savedEnvs.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export function restoreEnvs(): void {
  for (const [name, value] of savedEnvs) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnvs.clear();
}

export function setGlobal(name: string, value: unknown): void {
  if (!savedDescriptors.has(name)) {
    savedDescriptors.set(name, Object.getOwnPropertyDescriptor(globalHolder, name));
  }
  Object.defineProperty(globalHolder, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

export function restoreGlobals(): void {
  for (const [name, descriptor] of savedDescriptors) {
    if (descriptor === undefined) delete globalHolder[name];
    else Object.defineProperty(globalHolder, name, descriptor);
  }
  savedDescriptors.clear();
}
