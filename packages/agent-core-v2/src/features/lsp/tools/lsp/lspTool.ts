/**
 * `lsp` domain — `ILspTool` implementation (the `lsp` tool).
 *
 * Converts the one-based model-facing position to the zero-based protocol
 * position, resolves the workspace root from the session cwd, and renders
 * the query result as text: locations grouped by file as
 * `path:line:character` (one-based), hover as its text content. Output is
 * capped (`maxLocations` / `maxResultChars`) so a noisy result cannot flood
 * the model. Bound at Agent scope — contributed by `LspFeature`.
 */

import type { ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { Error2, ErrorCodes } from '#/errors';
import { ILspService, type LspQueryResult } from '#/features/lsp/lsp';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { LspHover, LspHoverContents, LspLocation } from '#/features/lsp/protocol';
import { uriToPath } from '#/features/lsp/translate';

import DESCRIPTION from './lsp.md?raw';
import type { ILspTool} from './lsp';
import { LspInputSchema, type LspInput } from './lsp';

const MAX_LOCATIONS = 100;
const MAX_RESULT_CHARS = 16000;

export class LspTool implements ILspTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'lsp' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(LspInputSchema);

  constructor(
    @ILspService private readonly lsp: ILspService,
    @ISessionContext private readonly sessionCtx: ISessionContext,
  ) {}

  resolveExecution(args: LspInput): ToolExecution {
    return {
      description: `Running LSP ${args.operation} at ${args.file_path}:${args.line}:${args.character}`,
      approvalRule: this.name,
      execute: async (ctx) => {
        try {
          const workspaceRoot = this.sessionCtx.cwd;
          if (workspaceRoot === '') {
            throw new Error2(
              ErrorCodes.LSP_WORKSPACE_REQUIRED,
              'the session has no workspace root; the lsp tool needs a workspace to start a language server',
            );
          }
          const result = await this.lsp.query(
            {
              operation: args.operation,
              filePath: args.file_path,
              position: { line: args.line - 1, character: args.character - 1 },
              workspaceRoot,
            },
            ctx.signal,
          );
          return { isError: false, output: renderResult(result) };
        } catch (error) {
          if (error instanceof Error2) {
            return { isError: true, output: error.message };
          }
          throw error;
        }
      },
    };
  }
}

export function renderResult(result: LspQueryResult): string {
  if (result.kind === 'hover') {
    return renderHover(result.hover);
  }
  return renderLocations(result.locations);
}

function renderLocations(locations: readonly LspLocation[]): string {
  if (locations.length === 0) {
    return 'No locations found.';
  }
  const byFile = new Map<string, string[]>();
  for (const location of locations.slice(0, MAX_LOCATIONS)) {
    const path = uriToPath(location.uri);
    const line = location.range.start.line + 1;
    const character = location.range.start.character + 1;
    const entries = byFile.get(path) ?? [];
    entries.push(`${path}:${line}:${character}`);
    byFile.set(path, entries);
  }
  const lines: string[] = [];
  for (const [path, entries] of byFile) {
    lines.push(`${path}:`);
    for (const entry of entries) {
      lines.push(`  ${entry}`);
    }
  }
  if (locations.length > MAX_LOCATIONS) {
    lines.push(`… ${locations.length - MAX_LOCATIONS} more locations omitted`);
  }
  return truncate(lines.join('\n'));
}

function renderHover(hover: LspHover | null): string {
  if (hover === null) {
    return 'No hover information available at this position.';
  }
  return truncate(hoverText(hover.contents));
}

function hoverText(contents: LspHoverContents): string {
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) {
    return contents.map((entry) => hoverText(entry)).join('\n');
  }
  if ('value' in contents) {
    return contents.value;
  }
  return '';
}

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n… output truncated (${text.length - MAX_RESULT_CHARS} more characters)`;
}
