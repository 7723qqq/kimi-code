import { createDecorator } from '../../../di';

export type PlanData = null | {
  readonly id: string;
  readonly content: string;
  readonly path: string;
};

export type PlanFilePath = string | null;

export interface IPlanModeService {
  readonly _serviceBrand: undefined;
  readonly active: boolean;
  readonly isActive: boolean;
  readonly id: string | null;
  readonly planFilePath: PlanFilePath;
  createPlanId(): string;
  enter(id?: string, createFile?: boolean, emitStatus?: boolean): Promise<void>;
  restoreEnter(input: { readonly id: string }): void;
  cancel(id?: string): void;
  clear(): Promise<void>;
  exit(id?: string): void;
  data(): Promise<PlanData>;
  planFilePathFor(id: string): string;
}

declare module '../types' {
  interface WireRecordMap {
    'plan_mode.enter': {
      id: string;
    };
    'plan_mode.cancel': {
      id?: string;
    };
    'plan_mode.exit': {
      id?: string;
    };
  }

  interface AgentEventMap {
    'plan_mode.changed': {
      isActive: boolean;
      planId: string | null;
      planFilePath: PlanFilePath;
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IPlanModeService =
  createDecorator<IPlanModeService>('agentPlanModeService');
