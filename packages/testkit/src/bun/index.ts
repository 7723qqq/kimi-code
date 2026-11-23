import { afterEach, beforeEach, it } from 'bun:test';

import { createTestHome, type TestHome } from '#/fixtures/home';
import { installNetworkGuard, type NetworkGuardOptions } from '#/fixtures/network';
import {
  startKap,
  type KapHarness,
  type KapLaunchOptions,
  type KapRunningServer,
  type StartKapOptions,
} from '#/kap/harness';
import { createFakeModel, type FakeModel, type FakeModelOptions } from '#/model/fake-model';

export type Use<T> = (value: T) => Promise<void>;

export interface FixtureContext {
  readonly task: { readonly name: string };
  readonly onTestFailed: (hook: (error?: unknown) => void | Promise<void>) => void;
}

export type FixtureDefinition<Context, Value> = (
  context: Context,
  use: Use<Value>,
) => Promise<void>;

export interface ModelFixtures {
  model: FakeModel;
}

export interface HomeFixtures {
  testHome: TestHome;
}

export interface KapFixtures<S extends KapRunningServer> extends ModelFixtures {
  kap: KapHarness<S>;
}

export interface ModelFixtureDefinitions {
  readonly model: FixtureDefinition<FixtureContext, FakeModel>;
}

export interface HomeFixtureDefinitions {
  readonly testHome: FixtureDefinition<FixtureContext, TestHome>;
}

export interface KapFixtureDefinitions<S extends KapRunningServer>
  extends ModelFixtureDefinitions {
  readonly kap: FixtureDefinition<ModelFixtures, KapHarness<S>>;
}

export interface KapFixtureOptions<
  O extends KapLaunchOptions,
  S extends KapRunningServer,
> extends Omit<StartKapOptions<O, S>, 'model'> {
  readonly modelOptions?: FakeModelOptions;
  readonly createServerLogger?: (options: {
    level: 'info';
    stream: { write(line: string): void };
  }) => O['logger'];
}

export interface FixtureContextHandle {
  readonly context: FixtureContext;
  runFailureHooks(error: unknown): Promise<void>;
}

const verifiedModels = new WeakSet<FakeModel>();
const kapDiagnostics = new WeakMap<FakeModel, () => string>();

function verifyOnce(model: FakeModel): void {
  if (verifiedModels.has(model)) return;
  verifiedModels.add(model);
  model.verify();
}

export function createFixtureContext(name: string): FixtureContextHandle {
  const hooks: Array<(error?: unknown) => void | Promise<void>> = [];
  return {
    context: {
      task: { name },
      onTestFailed: (hook) => {
        hooks.push(hook);
      },
    },
    async runFailureHooks(error) {
      for (const hook of hooks) await hook(error);
    },
  };
}

export function modelFixtures(options: FakeModelOptions = {}): ModelFixtureDefinitions {
  return {
    model: async ({ onTestFailed, task }, use) => {
      const model = createFakeModel(options);
      onTestFailed(() => {
        const describeKap = kapDiagnostics.get(model);
        process.stderr.write(`${task.name}\n${describeKap?.() ?? describeModel(model)}\n`);
      });
      try {
        await use(model);
        verifyOnce(model);
      } finally {
        await model.close();
      }
    },
  };
}

export function homeFixtures(): HomeFixtureDefinitions {
  return {
    testHome: async ({ task }, use) => {
      const home = await createTestHome(slug(task.name));
      try {
        await use(home);
      } finally {
        await home.remove();
      }
    },
  };
}

export function kapFixtures<O extends KapLaunchOptions, S extends KapRunningServer>(
  options: KapFixtureOptions<O, S>,
): KapFixtureDefinitions<S> {
  const { modelOptions, createServerLogger, ...kapOptions } = options;
  return {
    ...modelFixtures(modelOptions),
    kap: async ({ model }, use) => {
      const frames: string[] = [];
      const logs: string[] = [];
      let modelBeforeShutdown: string | undefined;
      const capture =
        kapOptions.serverOptions?.logger === undefined &&
        kapOptions.serverOptions?.logLevel === undefined
          ? createServerLogger
          : undefined;
      const logger = capture?.({
        level: 'info',
        stream: { write: (line) => appendDiagnostic(logs, summarizeLog(line)) },
      });
      kapDiagnostics.set(model, () => {
        const emptyLogs = logger === undefined ? '(no diagnostic logger configured)' : '(none received)';
        return [
          modelBeforeShutdown ?? describeModel(model),
          'KAP WebSocket frames:',
          frames.join('\n') || '(none received)',
          'KAP server logs:',
          logs.join('\n') || emptyLogs,
        ].join('\n');
      });
      const kap = await startKap({
        ...kapOptions,
        model,
        startServer: (launch: O) =>
          kapOptions.startServer(logger === undefined ? launch : { ...launch, logger }),
        onFrame(frame) {
          const { type, session_id, agent_id, turn_id, item_id, code } = frame;
          appendDiagnostic(
            frames,
            JSON.stringify({ type, session_id, agent_id, turn_id, item_id, code }),
          );
          kapOptions.onFrame?.(frame);
        },
      });
      try {
        await use(kap);
        verifyOnce(model);
      } finally {
        modelBeforeShutdown = describeModel(model);
        await kap.close();
      }
    },
  };
}

export function modelTest(
  definitions: ModelFixtureDefinitions,
  timeoutMs = 10_000,
): (name: string, fn: (fixtures: ModelFixtures) => void | Promise<void>) => void {
  return (name, fn) => {
    it(
      name,
      async () => {
        const handle = createFixtureContext(name);
        try {
          await definitions.model(handle.context, async (model) => {
            await fn({ model });
          });
        } catch (error) {
          await handle.runFailureHooks(error);
          throw error;
        }
      },
      timeoutMs,
    );
  };
}

export function homeTest(
  definitions: HomeFixtureDefinitions,
  timeoutMs = 10_000,
): (name: string, fn: (fixtures: HomeFixtures) => void | Promise<void>) => void {
  return (name, fn) => {
    it(
      name,
      async () => {
        const handle = createFixtureContext(name);
        try {
          await definitions.testHome(handle.context, async (testHome) => {
            await fn({ testHome });
          });
        } catch (error) {
          await handle.runFailureHooks(error);
          throw error;
        }
      },
      timeoutMs,
    );
  };
}

export function kapTest<S extends KapRunningServer>(
  definitions: KapFixtureDefinitions<S>,
  timeoutMs = 10_000,
): (name: string, fn: (fixtures: KapFixtures<S>) => void | Promise<void>) => void {
  return (name, fn) => {
    it(
      name,
      async () => {
        const handle = createFixtureContext(name);
        try {
          await definitions.model(handle.context, async (model) => {
            await definitions.kap({ model }, async (kap) => {
              await fn({ model, kap });
            });
          });
        } catch (error) {
          await handle.runFailureHooks(error);
          throw error;
        }
      },
      timeoutMs,
    );
  };
}

export async function poll(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw failure;
}

export function useNetworkGuard(options: NetworkGuardOptions = {}): void {
  let guard: ReturnType<typeof installNetworkGuard> | undefined;
  beforeEach(() => {
    guard = installNetworkGuard(options);
  });
  afterEach(() => {
    try {
      guard?.assertNoViolations();
    } finally {
      guard?.uninstall();
      guard = undefined;
    }
  });
}

function appendDiagnostic(lines: string[], line: string): void {
  if (lines.length === 32) lines.shift();
  lines.push(line.slice(0, 500));
}

function summarizeLog(line: string): string {
  try {
    const { level, msg, reqId } = JSON.parse(line) as {
      level?: number;
      msg?: string;
      reqId?: string;
    };
    return JSON.stringify({ level, msg, reqId });
  } catch {
    return '(unstructured log entry)';
  }
}

export function describeModel(model: FakeModel): string {
  const lines = ['testkit fake model state:'];
  for (const request of model.requests()) {
    lines.push(
      `  #${request.index} ${request.lane}[${request.laneIndex}] ${request.protocol} ${request.state} step=${request.step?.label ?? 'none'} first user text=${JSON.stringify(request.firstUserText.slice(0, 120))}`,
    );
  }
  for (const problem of model.problems()) lines.push(`  problem: ${problem}`);
  return lines.join('\n');
}

function slug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `testkit-${cleaned.slice(0, 40) || 'test'}`;
}
