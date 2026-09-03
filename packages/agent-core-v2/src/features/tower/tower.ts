import { createDecorator } from "#/_base/di/instantiation";

export const TOWER_TOOL_NAMES = [
  'TowerPlan',
  'TowerSpawn',
  'TowerMerge',
  'TowerTeardown',
  'TowerSend',
  'TowerInbox',
  'TowerFinding',
  'TowerReview',
  'TowerMission',
  'TowerStatus',
] as const;

export const TOWER_WORKER_PROFILE = 'tower-worker';

export const TOWER_FLAG_ID = 'tower';

export interface IAgentTowerService {
  readonly _serviceBrand: undefined;

  /**
   * Effective tower-mode state: the persisted state gated by the tower
   * experimental flag, App-scope feature assembly, and the main-agent
   * invariant — `false` while the flag is disabled, the feature was not
   * assembled this process (a live `/experiments` flip needs a restart), or
   * on a non-main agent even when the persisted state says active (legacy
   * records replay past `enter()`'s guards), so projections never report a
   * mode whose feature is inert.
   */
  readonly isActive: boolean;
  readonly requestedBase: string | undefined;
  enter(base?: string): Promise<void>;
  exit(): void;
}

export const IAgentTowerService = createDecorator<IAgentTowerService>('agentTowerService');
