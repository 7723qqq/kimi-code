/**
 * `turn` test stubs — shared `ITurnService` stubs for unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or `../turn/stubs`).
 */

import { createHooks } from '#/hooks';
import type { PromptOrigin } from '#/contextMemory';
import type { ITurnService, Turn } from '#/turn';
import type { IToolExecutor } from '#/toolExecutor';

export interface StubTurnOptions {
  /** When set, `getActiveTurn()` returns a synthetic active turn. */
  readonly hasActiveTurn?: boolean;
  /** Synthetic active turn id (defaults to `0`). Kept for call sites that
   *  previously relied on THEIRS-era `currentId`. */
  readonly currentId?: string | number;
}

/**
 * An `ITurnService` stub that also records `launch` origins and exposes the
 * active turn. `prompts` / `steered` are retained as empty arrays for legacy
 * assertions — the HEAD `ITurnService` has no `prompt` / `steer` methods, so
 * tests that used to drive them should be rewritten against `launch` + hooks.
 */
export type StubTurn = ITurnService & {
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

function makeHooks(): ITurnService['hooks'] {
  return createHooks([
    'onLaunched',
    'onEnded',
    'beforeStep',
    'afterStep',
    'onContextOverflow',
  ]) as ITurnService['hooks'];
}

/** A configurable `ITurnService` stub backed by real `OrderedHookSlot`s. */
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
    prompts: [],
    steered: [],
    launches,
  };
}

/**
 * An `ITurnService` stub backed by real `OrderedHookSlot`s. Use when the system
 * under test registers turn-lifecycle hooks (`onLaunched` / `beforeStep` /
 * `afterStep`) in its constructor, or when a test needs to drive those hooks
 * directly. `launch` returns a minimal {@link Turn}; `getActiveTurn` is a no-op.
 */
export function stubTurnWithHooks(): ITurnService {
  const turn = makeTurn(0);
  return {
    _serviceBrand: undefined,
    hooks: makeHooks(),
    launch: () => turn,
    getActiveTurn: () => undefined,
  };
}

/**
 * An `IToolExecutor` stub whose tool-execution hooks (`onWillExecuteTool` /
 * `onDidExecuteTool`) are real `OrderedHookSlot`s, so services that register
 * gate hooks in their constructor (PermissionGate, McpService, …) can be built
 * in tests. `execute` resolves to an empty batch by default.
 */
export function stubToolExecutor(): IToolExecutor {
  return {
    _serviceBrand: undefined,
    execute: async () => [],
    hooks: createHooks([
      'onWillExecuteTool',
      'onDidExecuteTool',
    ]) as IToolExecutor['hooks'],
  };
}
