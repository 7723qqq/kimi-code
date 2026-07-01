/**
 * `turn` test stubs — shared `IAgentTurnService` stubs for unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or `../turn/stubs`).
 */

import { createHooks } from '#/hooks';
import type { PromptOrigin } from '#/agent/contextMemory';
import type { IAgentLoopService } from '#/agent/loop';
import type { IAgentTurnService, Turn } from '#/agent/turn';
import type { IAgentToolExecutorService } from '#/agent/toolExecutor';

export interface StubTurnOptions {
  /** When set, `getActiveTurn()` returns a synthetic active turn. */
  readonly hasActiveTurn?: boolean;
  /** Synthetic active turn id (defaults to `0`). Kept for call sites that
   *  previously relied on THEIRS-era `currentId`. */
  readonly currentId?: string | number;
}

/**
 * An `IAgentTurnService` stub that also records `launch` origins and exposes the
 * active turn. `prompts` / `steered` are retained as empty arrays for legacy
 * assertions — the HEAD `IAgentTurnService` has no `prompt` / `steer` methods, so
 * tests that used to drive them should be rewritten against `launch` + hooks.
 */
export type StubTurn = IAgentTurnService & {
  readonly prompts: readonly string[];
  readonly steered: readonly string[];
  readonly launches: readonly PromptOrigin[];
};

function makeTurn(id: number): Turn {
  return {
    id,
    abortController: new AbortController(),
    ready: Promise.resolve(),
    result: Promise.resolve({ reason: 'completed' }),
  };
}

function makeHooks(): IAgentTurnService['hooks'] {
  return createHooks([
    'onLaunched',
    'onEnded',
  ]) as IAgentTurnService['hooks'];
}

function makeLoopHooks(): IAgentLoopService['hooks'] {
  return createHooks([
    'beforeStep',
    'onStepUsage',
    'afterStep',
    'onContextOverflow',
  ]) as IAgentLoopService['hooks'];
}

/** A configurable `IAgentTurnService` stub backed by real `OrderedHookSlot`s. */
export function stubTurn(options: StubTurnOptions = {}): StubTurn {
  const launches: PromptOrigin[] = [];
  let activeTurn: Turn | undefined;
  let nextId = typeof options.currentId === 'number' ? options.currentId : 0;
  return {
    _serviceBrand: undefined,
    hooks: makeHooks(),
    launch(origin) {
      launches.push(origin);
      activeTurn = makeTurn(nextId++);
      return activeTurn;
    },
    getActiveTurn() {
      return options.hasActiveTurn ? activeTurn : undefined;
    },
    lastEndedReason: () => undefined,
    prompts: [],
    steered: [],
    launches,
  };
}

/**
 * An `IAgentTurnService` stub backed by real `OrderedHookSlot`s. Use when the system
 * under test registers turn-lifecycle hooks (`onLaunched` / `onEnded`) in its
 * constructor, or when a test needs to drive those hooks directly. `launch`
 * returns a minimal {@link Turn}; `getActiveTurn` is a no-op.
 */
export function stubTurnWithHooks(): IAgentTurnService {
  const turn = makeTurn(0);
  return {
    _serviceBrand: undefined,
    hooks: makeHooks(),
    launch: () => turn,
    getActiveTurn: () => undefined,
    lastEndedReason: () => undefined,
  };
}

/** An `IAgentLoopService` stub backed by real loop lifecycle hook slots. */
export function stubLoopWithHooks(): IAgentLoopService {
  const hooks = makeLoopHooks();
  hooks.beforeStep.register('turn-before-step-event', (_ctx, next) => next());
  return {
    _serviceBrand: undefined,
    hooks,
    runTurn: async () => ({ reason: 'completed' }),
  };
}

/**
 * An `IAgentToolExecutorService` stub whose tool-execution hooks (`onWillExecuteTool` /
 * `onDidExecuteTool`) are real `OrderedHookSlot`s, so services that register
 * gate hooks in their constructor (AgentPermissionGate, AgentMcpService, …) can be built
 * in tests. `execute` resolves to an empty batch by default.
 */
export function stubToolExecutor(): IAgentToolExecutorService {
  return {
    _serviceBrand: undefined,
    execute: async () => [],
    hooks: createHooks([
      'onWillExecuteTool',
      'onDidExecuteTool',
    ]) as IAgentToolExecutorService['hooks'],
  };
}
