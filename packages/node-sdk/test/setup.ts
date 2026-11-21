import { vi } from '@moonshot-ai/testkit/vitest';

type Hoisted = <T>(factory: () => T) => T;

const runtimeVi = vi as typeof vi & {
  hoisted?: Hoisted;
  advanceTimersByTimeAsync?: (ms: number) => Promise<void>;
};

if (typeof runtimeVi.hoisted !== 'function') {
  runtimeVi.hoisted = ((factory: () => unknown) => factory()) as Hoisted;
}

if (typeof runtimeVi.advanceTimersByTimeAsync !== 'function') {
  runtimeVi.advanceTimersByTimeAsync = async (ms: number) => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  };
}
