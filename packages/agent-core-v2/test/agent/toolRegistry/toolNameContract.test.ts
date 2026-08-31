import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CollectionView } from '#/_base/di/collection';
import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import '#/index';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { IFlagService } from '#/app/flag/flag';

import { agentServices, appService, createTestAgent } from '../../harness';
import { stubFlag } from '../../app/flag/stubs';

const contractPath = join(import.meta.dirname, '../../../../kimi-agent/tool-name-contract.json');

interface ToolNameContract {
  v2Native: string[];
  v2Host: string[];
  v2Github: string[];
  unloadedInV2: string[];
}

const IToolNameProbe = createDecorator<ToolNameProbe>('toolNameContractProbe');

class ToolNameProbe extends Service {
  declare readonly _serviceBrand: undefined;
  constructor(
    @AgentToolContribution readonly tools: CollectionView<
      { readonly options: { readonly name: string } }
    >,
  ) {
    super();
  }
}

/**
 * The v2 half of the engine's tool-name contract. The Rust engine decides
 * native execution vs a host round-trip by matching the tool name it is
 * called with (`NativeToolset::handles`); this test derives the v2 side
 * from the real contribution collection — every channel (static
 * `registerAgentToolService` and feature `contributeTool`), with every
 * experimental flag on so flag-gated tools (tower) are counted, and before
 * any `when`/policy gate — not from a hand-maintained list. A newly
 * contributed tool fails here until `tool-name-contract.json` classifies
 * it, and a retired tool fails until its entry is removed. The Rust-side
 * twin (`native_tool_names_match_the_contract_file`) pins the engine's
 * accepted set to the same file.
 */
describe('tool name contract (kimi-agent NativeToolset::handles)', () => {
  it('classifies every registered v2 tool name', async () => {
    const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as ToolNameContract;
    const ctx = createTestAgent(
      appService(IFlagService, stubFlag(() => true)),
      agentServices((reg) => {
        reg.define(IToolNameProbe, ToolNameProbe);
      }),
    );
    try {
      const registered = new Set(ctx.get(IToolNameProbe).tools.items.map((r) => r.options.name));
      const classified = new Set([
        ...contract.v2Native,
        ...contract.v2Host,
        ...contract.v2Github,
      ]);

      const unclassified = [...registered].filter((name) => !classified.has(name));
      expect(
        unclassified,
        'new v2 tool(s) missing from kimi-agent/tool-name-contract.json',
      ).toEqual([]);

      const phantom = [...classified].filter((name) => !registered.has(name));
      expect(phantom, 'contract classifies v2 tools that are no longer registered').toEqual([]);

      const resurrected = contract.unloadedInV2.filter((name) => registered.has(name));
      expect(
        resurrected,
        'unloaded tool(s) are registered again — promote them to v2Native or v2Host in the contract',
      ).toEqual([]);
    } finally {
      await ctx.dispose();
    }
  });
});