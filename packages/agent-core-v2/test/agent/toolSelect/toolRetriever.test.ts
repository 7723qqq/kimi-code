import { describe, expect, it } from 'bun:test';

import { rankToolsByQuery } from '#/agent/toolSelect/toolRetriever';
import type { ToolInfo } from '#/tool/toolContract';

function tool(
  name: string,
  description: string,
  parameters?: Record<string, unknown>,
): ToolInfo {
  return { name, description, source: 'mcp', parameters };
}

const TOOLS: readonly ToolInfo[] = [
  tool('mcp__db__query', 'Run SQL queries against the analytics database'),
  tool('mcp__fs__read', 'Read a file from the workspace'),
  tool('mcp__web__search', 'Search the web for current information'),
  tool('mcp__doc__compose', 'Compose a document', {
    type: 'object',
    properties: { database: { type: 'string' } },
  }),
];

describe('rankToolsByQuery', () => {
  it('ranks a description match first', () => {
    expect(rankToolsByQuery(TOOLS, 'analytics database', 2)[0]?.name).toBe('mcp__db__query');
  });

  it('ranks a name match first', () => {
    expect(rankToolsByQuery(TOOLS, 'web search', 2)[0]?.name).toBe('mcp__web__search');
  });

  it('matches parameter names', () => {
    expect(rankToolsByQuery(TOOLS, 'database', 4).map((hit) => hit.name)).toContain(
      'mcp__doc__compose',
    );
  });

  it('matches CJK queries through character bigrams', () => {
    const entries = [
      tool('mcp__db__query', '对分析数据库执行查询'),
      tool('mcp__fs__read', '读取工作区文件'),
    ];
    expect(rankToolsByQuery(entries, '查询数据库', 1)[0]?.name).toBe('mcp__db__query');
  });

  it('returns an empty result when nothing matches', () => {
    expect(rankToolsByQuery(TOOLS, 'zzzzzz', 10)).toEqual([]);
  });

  it('returns the first entries for an empty query', () => {
    expect(rankToolsByQuery(TOOLS, '  ', 2).map((hit) => hit.name)).toEqual([
      'mcp__db__query',
      'mcp__fs__read',
    ]);
  });

  it('honors the result limit', () => {
    expect(rankToolsByQuery(TOOLS, 'tool database file web', 2)).toHaveLength(2);
  });
});
