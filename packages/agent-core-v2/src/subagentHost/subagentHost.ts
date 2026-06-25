import { createDecorator } from "#/_base/di";
import type { QueuedSubagentTask, SubagentResult } from './subagent-batch';

export interface ISubagentHost {
  readonly _serviceBrand: undefined;
  getSwarmItem(agentId: string): string | undefined;
  startBtw(): Promise<string>;
  generateAgentsMd(): Promise<void>;
  runQueued<T>(tasks: readonly QueuedSubagentTask<T>[]): Promise<Array<SubagentResult<T>>>;
}


// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ISubagentHost = createDecorator<ISubagentHost>('agentSubagentHostService');
