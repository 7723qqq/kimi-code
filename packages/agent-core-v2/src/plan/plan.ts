import { createDecorator } from "#/_base/di";

export type PlanData = null | {
  readonly id: string;
  readonly content: string;
  readonly path: string;
};

export type PlanFilePath = string | null;

export interface IPlanService {
  readonly _serviceBrand: undefined;
  enter(id?: string, createFile?: boolean): Promise<void>;
  cancel(id?: string): void;
  clear(): Promise<void>;
  exit(id?: string): void;
  status(): Promise<PlanData>;
}

declare module '#/wireRecord' {
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

}

export const IPlanService =
  createDecorator<IPlanService>('agentPlanService');
