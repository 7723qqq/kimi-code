/**
 * Scenario: the **plan** slice — an entity-like domain backed by the append-log
 * record layer.
 *
 * Concept taught: `goal`, `plan`, and `todoList` are entity-like domains whose
 * durable state is carried by records on the append-log (`IAgentRecordService`),
 * not by private fields alone. Each lifecycle change is persisted with
 * `record.append({ type: '...' })`, and the same record both broadcasts the
 * change live and rebuilds the entity on resume through its `resume` facet.
 *
 * We demonstrate the pattern on `plan` because it is the lightest domain that
 * actually emits to the record log: `enter` appends a `plan_mode.enter` record,
 * `status` reads the entity, and `exit` appends a `plan_mode.exit` record.
 * `goal` follows the same append-log pattern (`goal.create` / `goal.update` /
 * `goal.clear`); `todoList` stores its items in the tool store rather than the
 * record log, so it is not re-wired here.
 *
 * Wiring: the real composition root (`_harness`) provides every collaborator,
 * including the real `IAgentRecordService`. We spy on the record service's
 * `append` / `define` to observe the records and to capture the `resume` facet,
 * so the slice runs end-to-end for real with no hand-rolled stub list.
 *
 * Prerequisites: example 01 (container & scope tree).
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/goals-plans-todos.example.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAgentPlanService } from '#/agent/plan';
import { IAgentRecordService } from '#/agent/record';

import { createSliceHost, type SliceHost } from './_harness';

describe('goals-plans-todos slice (append-log CRUD via plan)', () => {
  let host: SliceHost;
  afterEach(() => host?.dispose());

  function setUp() {
    host = createSliceHost({ homeDir: process.env['KIMI_CODE_HOME']! });
    // Resolve the real record service first and instrument it; the plan service
    // is constructed lazily and will pick up the same singleton.
    const records = host.agent.accessor.get(IAgentRecordService);
    const appended: Array<{ type: string; id?: string }> = [];
    const facets = new Map<string, { resume?: (r: { type: string; id?: string }) => unknown }>();
    vi.spyOn(records, 'append').mockImplementation((r) => {
      appended.push(r as { type: string; id?: string });
    });
    vi.spyOn(records, 'define').mockImplementation((type, facet) => {
      facets.set(type as string, facet as { resume?: (r: { type: string; id?: string }) => unknown });
      return { dispose: () => facets.delete(type as string) };
    });
    const plan = host.agent.accessor.get(IAgentPlanService);
    return { plan, appended, facets };
  }

  it('entering plan mode activates the plan and appends a plan_mode.enter record', async () => {
    const { plan, appended } = setUp();

    await plan.enter('ship-v2');

    expect(appended.map((r) => r.type)).toContain('plan_mode.enter');
    const status = await plan.status();
    expect(status?.id).toBe('ship-v2');
  });

  it('exiting plan mode appends a plan_mode.exit record and deactivates the plan', async () => {
    const { plan, appended } = setUp();

    await plan.enter('ship-v2');
    plan.exit('ship-v2');

    expect(appended.map((r) => r.type)).toEqual(['plan_mode.enter', 'plan_mode.exit']);
    expect(await plan.status()).toBeNull();
  });

  it('cancelling plan mode appends a plan_mode.cancel record', async () => {
    const { plan, appended } = setUp();

    await plan.enter('scratch');
    plan.cancel('scratch');

    expect(appended.map((r) => r.type)).toEqual(['plan_mode.enter', 'plan_mode.cancel']);
    expect(await plan.status()).toBeNull();
  });

  it('replays records through their resume facets to rebuild plan state', async () => {
    const { plan, facets } = setUp();

    // Wake the lazy service so its constructor registers the resume facets.
    expect(await plan.status()).toBeNull();
    expect(facets.has('plan_mode.enter')).toBe(true);

    await facets.get('plan_mode.enter')!.resume!({ type: 'plan_mode.enter', id: 'restored' });
    expect((await plan.status())?.id).toBe('restored');

    await facets.get('plan_mode.exit')!.resume!({ type: 'plan_mode.exit' });
    expect(await plan.status()).toBeNull();
  });
});
