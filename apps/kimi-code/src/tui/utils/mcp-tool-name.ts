// Decodes the `mcp__<server>__<tool>` qualified names produced by kimi-core's
// `qualifyMcpToolName`. Returns null for non-MCP tools and for hash-truncated
// qualified names (where the trailing `__<tool>` segment has been collapsed).
export function decodeMcpToolName(
  name: string,
): { readonly serverName: string; readonly toolName: string } | null {
  const PREFIX = 'mcp__';
  if (!name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  const sep = rest.indexOf('__');
  // `sep < 0` is the not-found case, `sep === 0` an empty server name, and
  // `sep + 2 === rest.length` an empty tool name. The not-found check is spelled
  // out rather than left to the `<= 0` fold because a bare `indexOf` result is
  // compared against a length below, and `-1` silently satisfying that is the
  // kind of thing a reader has to stop and re-derive.
  if (sep < 0 || sep === 0 || sep + 2 === rest.length) return null;
  return {
    serverName: rest.slice(0, sep),
    toolName: rest.slice(sep + 2),
  };
}
