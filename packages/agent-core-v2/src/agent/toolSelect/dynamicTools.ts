import type { ContextMessage } from '#/agent/contextMemory/types';
import { isMcpToolName, toolDefinitionSchemaSignature, type ToolInfo } from '#/tool/toolContract';
import type { ToolDescription } from '#human/llm/message';

export const DYNAMIC_TOOL_SCHEMA_VARIANT = 'dynamic_tool_schema';

export const LOADABLE_TOOLS_VARIANT = 'loadable-tools';

export const RETRIEVED_TOOLS_VARIANT = 'retrieved-tools';

export function isDynamicToolSchemaMessage(message: ContextMessage): boolean {
  return message.tools !== undefined && message.tools.length > 0;
}

export function isRetrievedToolsAnnouncement(message: ContextMessage): boolean {
  const origin = message.origin;
  if (origin?.kind === 'injection') return origin.variant === RETRIEVED_TOOLS_VARIANT;
  return origin?.kind === 'system_trigger' && origin.name === RETRIEVED_TOOLS_VARIANT;
}

export function isLoadableToolsAnnouncement(message: ContextMessage): boolean {
  return isRetrievedToolsAnnouncement(message) || isAddedRemovedAnnouncement(message);
}

function isAddedRemovedAnnouncement(message: ContextMessage): boolean {
  const origin = message.origin;
  if (origin?.kind === 'injection') return origin.variant === LOADABLE_TOOLS_VARIANT;
  return origin?.kind === 'system_trigger' && origin.name === LOADABLE_TOOLS_VARIANT;
}

export function stripDynamicToolContext(
  history: readonly ContextMessage[],
): readonly ContextMessage[] {
  if (!history.some((m) => isDynamicToolSchemaMessage(m) || isLoadableToolsAnnouncement(m))) {
    return history;
  }
  const out: ContextMessage[] = [];
  for (const message of history) {
    if (isLoadableToolsAnnouncement(message)) continue;
    if (isDynamicToolSchemaMessage(message)) {
      const { tools: _tools, ...rest } = message;
      void _tools;
      if (rest.content.length === 0 && rest.toolCalls.length === 0) continue;
      out.push(rest);
      continue;
    }
    out.push(message);
  }
  return out;
}

export function collectLoadedDynamicTools(
  history: readonly ContextMessage[],
  current: readonly ToolInfo[],
): ReadonlyMap<string, ToolDescription> {
  const loaded = new Map<string, ToolDescription>();
  for (const message of history) {
    if (isLoadableToolsAnnouncement(message)) {
      const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
      for (const name of matchToolNameBlocks(text, TOOLS_REMOVED_BLOCK)) loaded.delete(name);
      continue;
    }
    if (!isDynamicToolSchemaMessage(message)) continue;
    for (const tool of message.tools ?? []) loaded.set(tool.name, tool);
  }
  const currentByName = new Map(current.map((tool) => [tool.name, tool]));
  for (const [name, schema] of loaded) {
    const currentTool = currentByName.get(name);
    if (
      (currentTool === undefined && !isMcpToolName(name)) ||
      (currentTool !== undefined &&
        toolDefinitionSchemaSignature(schema) !== toolDefinitionSchemaSignature(currentTool))
    ) {
      loaded.delete(name);
    }
  }
  return loaded;
}

export function collectLoadedDynamicToolNames(
  history: readonly ContextMessage[],
  current: readonly ToolInfo[],
): Set<string> {
  return new Set(collectLoadedDynamicTools(history, current).keys());
}

const TOOLS_ADDED_BLOCK = /<tools_added>\n?([\s\S]*?)\n?<\/tools_added>/g;
const TOOLS_REMOVED_BLOCK = /<tools_removed>\n?([\s\S]*?)\n?<\/tools_removed>/g;

export function foldAnnouncedToolNames(history: readonly ContextMessage[]): Set<string> {
  const announced = new Set<string>();
  for (const message of history) {
    if (!isLoadableToolsAnnouncement(message)) continue;
    const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    for (const name of matchToolNameBlocks(text, TOOLS_REMOVED_BLOCK)) {
      announced.delete(name);
    }
    for (const name of matchToolNameBlocks(text, TOOLS_ADDED_BLOCK)) {
      announced.add(name);
    }
  }
  return announced;
}

function matchToolNameBlocks(text: string, pattern: RegExp): string[] {
  const names: string[] = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const body = match[1] ?? '';
    for (const line of body.split('\n')) {
      const name = line.trim();
      if (name.length > 0) names.push(name);
    }
  }
  return names;
}

export function renderRetrievedToolsAnnouncement(
  entries: readonly { readonly name: string; readonly description: string }[],
  totalLoadable: number,
): string {
  const lines = entries.map((entry) => {
    const description = oneLine(entry.description).slice(0, 120);
    return description.length === 0 ? entry.name : `${entry.name} — ${description}`;
  });
  const block =
    lines.length === 0
      ? '<tools_relevant>\nNo tool descriptions matched the current request.\n</tools_relevant>'
      : `<tools_relevant>\n${lines.join('\n')}\n</tools_relevant>`;
  const guidance =
    entries.length === 0
      ? `${totalLoadable} tools are loadable. Call select_tools with a query to search by capability, then call it again with exact names to load tools.`
      : `These are the ${entries.length} most relevant of ${totalLoadable} loadable tools. Call select_tools with exact names to load them. If the capability you need is not listed, call select_tools with a query to search all loadable tools; search results are candidates until you load them by exact name.`;
  return `${block}\n\n${guidance} A newer <tools_relevant> block replaces older ones.`;
}

export function stripStaleRetrievedToolsAnnouncements(
  messages: readonly ContextMessage[],
): readonly ContextMessage[] {
  let last = -1;
  let count = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined || !isRetrievedToolsAnnouncement(message)) continue;
    last = index;
    count += 1;
  }
  if (count <= 1) return messages;
  return messages.filter(
    (message, index) => index === last || !isRetrievedToolsAnnouncement(message),
  );
}

function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

export function renderLoadableToolsAnnouncement(
  added: readonly string[],
  removed: readonly string[],
  hasLoadableTools = true,
): string {
  const sections: string[] = [];
  if (added.length > 0) {
    sections.push(`<tools_added>\n${added.join('\n')}\n</tools_added>`);
  }
  if (removed.length > 0) {
    sections.push(`<tools_removed>\n${removed.join('\n')}\n</tools_removed>`);
  }
  if (!hasLoadableTools) {
    sections.push(
      'No tools are currently available for dynamic loading in this session. ' +
        'Do not call select_tools or guess tool names; use the tools you already have. ' +
        'Only a later <tools_added> announcement can make new tools loadable.',
    );
    return sections.join('\n\n');
  }
  sections.push(
    'Use the select_tools tool with exact names to load full definitions of the ' +
      'announced tools before calling them. ' +
      'Only the announced names are loadable — tools you already have available are called ' +
      'directly, never passed to select_tools; plugin, skill, or category names do not work. ' +
      'Names listed as removed are no longer loadable — do not select them. ' +
      'Fold all announcements in this conversation in order to get the current list.',
  );
  return sections.join('\n\n');
}
