import { IAgentTowerService } from '#/features/tower/tower';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { newTowerStore, runTowerTool } from '../support';
import type { ITowerPlanTool } from './plan';
import { TowerPlanToolInputSchema, type TowerPlanToolInput } from './plan';
import DESCRIPTION from './plan.md?raw';

export class TowerPlanTool implements ITowerPlanTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerPlan' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerPlanToolInputSchema);

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentTowerService private readonly tower: IAgentTowerService,
  ) {}

  resolveExecution(args: TowerPlanToolInput): ToolExecution {
    return {
      description: `Planning ${String(args.missions.length)} tower mission(s)`,
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          if (!this.tower.isActive) {
            return {
              output: 'tower mode is not active — run TowerInit first',
              isError: true,
            };
          }
          const store = newTowerStore(this.sessionContext);
          const missions = await store.plan(args.missions);
          const rows = missions.map(
            (m) =>
              `| ${m.id} | ${m.title} | ${m.kind} | ${m.branch} | ${m.worktree} | ${m.scope.join(', ')} |`,
          );
          return {
            output: [
              `planned ${String(missions.length)} mission(s):`,
              '',
              '| ID | Mission | Kind | Branch | Worktree | Scope |',
              '| -- | ------- | ---- | ------ | -------- | ----- |',
              ...rows,
              '',
              'Next: TowerSpawn one worker per mission (workers get their worktree path and mission briefing automatically), plus reviewers for the branches. Survey missions need no reviewer — they close with a zero-diff TowerMerge.',
            ].join('\n'),
          };
        }),
    };
  }
}
