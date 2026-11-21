import { vi } from '@moonshot-ai/testkit/vitest';

type RuntimeVi = typeof vi & {
  stubEnv?: (name: string, value: string) => void;
  unstubAllEnvs?: () => void;
};

const runtimeVi = vi as RuntimeVi;
const originals = new Map<string, string | undefined>();

if (typeof runtimeVi.stubEnv !== 'function') {
  runtimeVi.stubEnv = (name: string, value: string) => {
    if (!originals.has(name)) originals.set(name, process.env[name]);
    process.env[name] = value;
  };
}

if (typeof runtimeVi.unstubAllEnvs !== 'function') {
  runtimeVi.unstubAllEnvs = () => {
    for (const [name, value] of originals) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    originals.clear();
  };
}
