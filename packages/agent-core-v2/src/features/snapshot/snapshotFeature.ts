import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { ISnapshotService } from './snapshot';
import { ISnapshotListTool, SNAPSHOT_LIST_TOOL_NAME } from './snapshotList';
import { SnapshotListTool } from './snapshotListTool';
import { SnapshotService } from './snapshotService';

export class SnapshotFeature extends Feature {
  static override readonly name = 'snapshot';

  constructor() {
    super();
    this.contributeAgentService(ISnapshotService, SnapshotService);
    this.contributeTool(ISnapshotListTool, SnapshotListTool, {
      name: SNAPSHOT_LIST_TOOL_NAME,
      domain: 'snapshot',
    });
  }
}

registerFeature(SnapshotFeature);
