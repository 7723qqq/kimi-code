import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type ToolExecution } from '#/tool/toolContract';

import { ISnapshotService, type SnapshotRecord } from './snapshot';
import DESCRIPTION from './snapshot-list.md?raw';
import {
  ISnapshotListTool,
  SNAPSHOT_LIST_TOOL_NAME,
  SnapshotListInputSchema,
  type SnapshotListInput,
} from './snapshotList';

const HASH_PREFIX = 12;

export const SNAPSHOT_LIST_EMPTY_OUTPUT = 'No recorded versions of';

function ownerOf(record: SnapshotRecord): string {
  const parts: string[] = [];
  if (record.sessionId !== undefined) parts.push(`session=${record.sessionId}`);
  if (record.agentId !== undefined) parts.push(`agent=${record.agentId}`);
  return parts.join(' ');
}

function contentOf(record: SnapshotRecord): string {
  if (record.hash === '')
    return record.skipped === undefined ? 'no content' : `skipped:${record.skipped}`;
  return record.hash.slice(0, HASH_PREFIX);
}

export function formatSnapshotVersion(record: SnapshotRecord, index: number): string {
  const owner = ownerOf(record);
  const head = `${index + 1}. ${record.at}  ${record.tool}  ${record.size} B  ${contentOf(record)}`;
  return owner === '' ? head : `${head}  ${owner}`;
}

export class SnapshotListTool implements ISnapshotListTool {
  declare readonly _serviceBrand: undefined;
  readonly name = SNAPSHOT_LIST_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SnapshotListInputSchema);

  constructor(@ISnapshotService private readonly snapshot: ISnapshotService) {}

  resolveExecution(args: SnapshotListInput): ToolExecution {
    const path = args.path;
    return {
      accesses: ToolAccesses.none(),
      description: 'Listing the recorded versions of a file',
      approvalRule: this.name,
      execute: async () => {
        const records = await this.snapshot.list(path);
        if (records.length === 0) {
          return { isError: true, output: `${SNAPSHOT_LIST_EMPTY_OUTPUT} ${path}.` };
        }
        const lines = [
          `${records.length} recorded version(s) of ${path}, newest first`,
          ...records.map(formatSnapshotVersion),
        ];
        return { output: lines.join('\n') };
      },
    };
  }
}
