import { describe, expect, it } from 'vitest';

import { decodeMcpToolName } from '#/tui/utils/mcp-tool-name';

describe('decodeMcpToolName', () => {
  it('splits a qualified name into its server and tool', () => {
    expect(decodeMcpToolName('mcp__github__create_issue')).toEqual({
      serverName: 'github',
      toolName: 'create_issue',
    });
    // The separator inside the server name wins: the split is at the first `__`,
    // which is what the qualifier format guarantees.
    expect(decodeMcpToolName('mcp__a__b__c')).toEqual({
      serverName: 'a',
      toolName: 'b__c',
    });
  });

  it('returns null for a name that is not a qualified MCP tool', () => {
    for (const name of [
      'read_file',
      '',
      'mcp_github__tool',
      'notmcp__github__tool',
    ]) {
      expect(decodeMcpToolName(name)).toBeNull();
    }
  });

  it('returns null when either half would be empty', () => {
    // The not-found case is `-1`, and a length comparison against it is exactly
    // the shape that reads as "found" if the guard is folded into `<= 0` — so
    // each of these is pinned separately.
    for (const name of [
      'mcp____tool',
      'mcp__server__',
      'mcp__',
      'mcp__nope',
      'mcp__server',
    ]) {
      expect(decodeMcpToolName(name)).toBeNull();
    }
  });
});
