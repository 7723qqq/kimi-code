import { beforeEach, onTestFinished, test, type TestOptions } from 'bun:test';

import { createTestHome, type TestHome } from '../fixtures/home';
import { installNetworkGuard, type NetworkGuardOptions } from '../fixtures/network';
import { startKap, type KapHarness, type KapLaunchOptions, type KapRunningServer, type StartKapOptions } from '../kap/harness';
import { createFakeModel, type FakeModel, type FakeModelOptions } from '../model/fake-model';

export interface FixtureContext {
  readonly task: { readonly name: string };
  onTestFailed(callback: () => void): void;
}

export type FixtureDefinitions<T> = {
  readonly [K in keyof T]: FixtureDefinition<T & FixtureContext, T[K]>;
};

let reportFixtureFailure: (() => void) | undefined;

export async function runFixtures<T>(
  name: string,
  definitions: FixtureDefinitions<T>,
  body: (context: T) => unknown,
): Promise<void> {
  const failed: (() => void)[] = [];
  let reported = false;
  const report = (): void => {
    if (reported) return;
    reported = true;
    for (const callback of failed) callback();
  };
  reportFixtureFailure = report;
  const context = {
    task: { name },
    onTestFailed: (callback: () => void) => failed.push(callback),
  } as T & FixtureContext;
  const entries = Object.entries(definitions) as [
    keyof T,
    FixtureDefinition<T & FixtureContext, T[keyof T]>,
  ][];
  const use = async (index: number): Promise<void> => {
    const entry = entries[index];
    if (entry === undefined) {
      await body(context);
      return;
    }
    const [key, define] = entry;
    let used = false;
    await define(context, async (value) => {
      if (used) throw new Error(`Fixture ${String(key)} called use more than once`);
      used = true;
      (context as T)[key] = value;
      await use(index + 1);
    });
    if (!used) throw new Error(`Fixture ${String(key)} never called use`);
  };
  try {
    await use(0);
  } catch (error) {
    report();
    throw error;
  }
}

export function fixtureTest<T>(definitions: FixtureDefinitions<T>) {
  return (name: string, body: (context: T) => unknown, options?: number | TestOptions): void => {
    test(name, () => runFixtures(name, definitions, body), options);
  };
}

export type Use<T> = (value: T) => Promise<void>;

export type FixtureDefinition<Context, Value> = (context: Context, use: Use<Value>) => Promise<void>;

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

export interface KapFixtureDefinitions<S extends KapRunningServer> extends ModelFixtureDefinitions {
  readonly kap: FixtureDefinition<ModelFixtures, KapHarness<S>>;
}

export interface KapFixtureOptions<O extends KapLaunchOptions, S extends KapRunningServer> extends Omit<StartKapOptions<O, S>, 'model'> {
  readonly modelOptions?: FakeModelOptions;
  readonly createServerLogger?: (options: { level: 'info'; stream: { write(line: string): void } }) => O['logger'];
}

const verifiedModels = new WeakSet<FakeModel>();
const kapDiagnostics = new WeakMap<FakeModel, () => string>();

function verifyOnce(model: FakeModel): void {
  if (verifiedModels.has(model)) return;
  verifiedModels.add(model);
  model.verify();
}

export function modelFixtures(options: FakeModelOptions = {}): ModelFixtureDefinitions {
  return {
    model: async (context, use) => {
      const { task } = context;
      const model = createFakeModel(options);
      context.onTestFailed(() => {
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

export function kapFixtures<O extends KapLaunchOptions, S extends KapRunningServer>(options: KapFixtureOptions<O, S>): KapFixtureDefinitions<S> {
  const { modelOptions, createServerLogger, ...kapOptions } = options;
  return {
    ...modelFixtures(modelOptions),
    kap: async ({ model }, use) => {
      const frames: string[] = [];
      const logs: string[] = [];
      let modelBeforeShutdown: string | undefined;
      const capture = kapOptions.serverOptions?.logger === undefined && kapOptions.serverOptions?.logLevel === undefined ? createServerLogger : undefined;
      const logger = capture?.({ level: 'info', stream: { write: (line) => appendDiagnostic(logs, summarizeLog(line)) } });
      kapDiagnostics.set(model, () => {
        const emptyLogs = logger === undefined ? '(no diagnostic logger configured)' : '(none received)';
        return [
          modelBeforeShutdown ?? describeModel(model),
          'KAP WebSocket frames:', frames.join('\n') || '(none received)',
          'KAP server logs:', logs.join('\n') || emptyLogs,
        ].join('\n');
      });
      const kap = await startKap({
        ...kapOptions,
        model,
        startServer: (launch: O) => kapOptions.startServer(logger === undefined ? launch : { ...launch, logger }),
        onFrame(frame) {
          const { type, session_id, agent_id, turn_id, item_id, code } = frame;
          appendDiagnostic(frames, JSON.stringify({ type, session_id, agent_id, turn_id, item_id, code }));
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

function appendDiagnostic(lines: string[], line: string): void {
  if (lines.length === 32) lines.shift();
  lines.push(line.slice(0, 500));
}

function summarizeLog(line: string): string {
  try {
    const { level, msg, reqId } = JSON.parse(line) as { level?: number; msg?: string; reqId?: string };
    return JSON.stringify({ level, msg, reqId });
  } catch {
    return '(unstructured log entry)';
  }
}

export function useNetworkGuard(options: NetworkGuardOptions = {}): void {
  beforeEach(() => {
    reportFixtureFailure = undefined;
    const guard = installNetworkGuard(options);
    onTestFinished(() => {
      try {
        guard.assertNoViolations();
      } catch (error) {
        reportFixtureFailure?.();
        throw error;
      } finally {
        guard.uninstall();
        reportFixtureFailure = undefined;
      }
    });
  });
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
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `testkit-${cleaned.slice(0, 40) || 'test'}`;
}
