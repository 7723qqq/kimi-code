/**
 * TUI2 AgentSwarm progress — pure result-summary parsing layer.
 *
 * The v1 module is a pi-tui `render(width): string[]` component plus a set
 * of framework-free helpers. The tui2 tree renders swarm progress through
 * the store-backed `agentSwarmData` summary (see
 * `controllers/subagent-event-handler.ts`), so only the parsing helpers are
 * needed here — ported verbatim from v1, with all pi-tui / chalk imports
 * dropped. The component itself has no tui2 counterpart.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

export interface AgentSwarmResultSummary {
  readonly completed: number;
  readonly failed: number;
  readonly aborted: number;
  readonly parsed: boolean;
}

interface AgentSwarmResultStatus {
  readonly index: number;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly completedText?: string;
  readonly failureText?: string;
}

export function agentSwarmResultSummaryFromOutput(output: string): AgentSwarmResultSummary {
  const statuses = parseAgentSwarmResultStatuses(output);
  let completed = 0;
  let failed = 0;
  let aborted = 0;
  for (const status of statuses) {
    if (status.status === 'completed') completed += 1;
    if (status.status === 'failed') failed += 1;
    if (status.status === 'cancelled') aborted += 1;
  }
  return {
    completed,
    failed,
    aborted,
    parsed: statuses.length > 0,
  };
}

function parseAgentSwarmResultStatuses(output: string): AgentSwarmResultStatus[] {
  const xmlStatuses = parseAgentSwarmXmlResultStatuses(output);
  if (xmlStatuses.length > 0) return xmlStatuses;
  return parseAgentSwarmLegacyResultStatuses(output);
}

function forEachSubagentTag<T>(
  output: string,
  callback: (attrs: string, body: string, index: number) => T | undefined,
): T[] {
  const result: T[] = [];
  const tagPattern = /<subagent\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = tagPattern.exec(output)) !== null) {
    const attrs = match[1] ?? '';
    const closeIndex = output.indexOf('</subagent>', tagPattern.lastIndex);
    if (closeIndex < 0) break;
    const body = output.slice(tagPattern.lastIndex, closeIndex);
    index += 1;
    const value = callback(attrs, body, index);
    if (value !== undefined) result.push(value);
    tagPattern.lastIndex = closeIndex + '</subagent>'.length;
  }
  return result;
}

function parseAgentSwarmXmlResultStatuses(output: string): AgentSwarmResultStatus[] {
  return forEachSubagentTag(output, (attrs, body, tagIndex) => {
    const explicitIndex = Number(xmlAttribute(attrs, 'index'));
    const index = Number.isInteger(explicitIndex) && explicitIndex > 0 ? explicitIndex : tagIndex;
    const outcome = xmlAttribute(attrs, 'outcome');
    if (
      outcome !== 'completed' &&
      outcome !== 'failed' &&
      outcome !== 'aborted' &&
      outcome !== 'cancelled'
    ) {
      return undefined;
    }
    return {
      index,
      status: outcome === 'aborted' || outcome === 'cancelled' ? 'cancelled' : outcome,
      completedText: outcome === 'completed' ? body : undefined,
      failureText: outcome === 'failed' ? body : undefined,
    };
  });
}

function xmlAttribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return match?.[1];
}

function forEachAgentBlock<T>(
  output: string,
  callback: (block: string, index: number) => T | undefined,
): T[] {
  const result: T[] = [];
  for (const block of output.split(/\n(?=\[agent \d+\]\n)/)) {
    const indexMatch = /^\[agent (\d+)\]$/m.exec(block);
    if (indexMatch === null) continue;
    const value = callback(block, Number(indexMatch[1]));
    if (value !== undefined) result.push(value);
  }
  return result;
}

function parseAgentSwarmLegacyResultStatuses(output: string): AgentSwarmResultStatus[] {
  return forEachAgentBlock(output, (block, index) => {
    const statusMatch = /^status: (completed|failed|aborted|cancelled)$/m.exec(block);
    if (statusMatch === null) return undefined;
    const status = statusMatch[1] as 'completed' | 'failed' | 'aborted' | 'cancelled';
    return {
      index,
      status: status === 'aborted' || status === 'cancelled' ? 'cancelled' : status,
      completedText: status === 'completed' ? parseAgentSwarmCompletedText(block) : undefined,
      failureText: status === 'failed' ? parseAgentSwarmFailureText(block) : undefined,
    };
  });
}

function parseAgentSwarmCompletedText(block: string): string | undefined {
  const marker = '\n[summary]\n';
  const markerIndex = block.indexOf(marker);
  if (markerIndex < 0) return undefined;
  return normalizeFinalOutputText(block.slice(markerIndex + marker.length));
}

function parseAgentSwarmFailureText(block: string): string | undefined {
  const match = /^subagent error:\s*([\s\S]*)$/m.exec(block);
  if (match === null) return undefined;
  return normalizeFailureText(match[1]);
}

function normalizeFailureText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const nestedFailureText = nestedAgentSwarmFailureText(text);
  const normalized = stripAgentSwarmPrefix(collapseWhitespace(nestedFailureText ?? text));
  return normalized.length > 0 ? normalized : undefined;
}

function nestedAgentSwarmFailureText(text: string): string | undefined {
  const xmlFailureText = nestedAgentSwarmXmlFailureText(text);
  if (xmlFailureText !== undefined)
    return nestedAgentSwarmFailureText(xmlFailureText) ?? xmlFailureText;

  if (!/^\s*agent_swarm:\s*failed\b/m.test(text)) return undefined;
  const match = /^\s*subagent error:\s*([\s\S]*?)(?=\n\[agent \d+\]\n|$)/m.exec(text);
  if (match === null) return undefined;
  const failureText = match[1];
  if (failureText === undefined) return undefined;
  return nestedAgentSwarmFailureText(failureText) ?? failureText;
}

function nestedAgentSwarmXmlFailureText(text: string): string | undefined {
  if (!/<agent_swarm_result\b/.test(text)) return undefined;
  const failed = parseAgentSwarmXmlResultStatuses(text).find((entry) => {
    return entry.status === 'failed' && entry.failureText !== undefined;
  });
  return failed?.failureText;
}

function stripAgentSwarmPrefix(text: string): string {
  return text.replace(/^agent_swarm:\s*(?:failed|completed)?\s*/i, '').trim();
}

function normalizeFinalOutputText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const normalized = collapseWhitespace(text);
  return normalized.length > 0 ? normalized : undefined;
}

function collapseWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}