import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const SNAPSHOT_LIST_TOOL_NAME = 'SnapshotList' as const;

export interface SnapshotListInput {
  path: string;
}

export const SnapshotListInputSchema: z.ZodType<SnapshotListInput> = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'File path whose recorded versions to list, as written in the tool call or absolute. The newest version comes first.',
    ),
});

export interface ISnapshotListTool extends AgentTool<SnapshotListInput> {
  readonly _serviceBrand: undefined;
}
export const ISnapshotListTool = createDecorator<ISnapshotListTool>('snapshotListTool');
