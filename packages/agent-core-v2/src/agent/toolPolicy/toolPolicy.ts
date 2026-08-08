/**
 * `toolPolicy` domain — Agent-scope tool authorization contract.
 *
 * Combines profile, global configuration, and Session-owned restrictions into
 * one policy used by both provider schema projection and executor preflight.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { ToolSource } from '#/tool/toolContract';

import type { ToolActivationPolicy } from './evaluate';

export interface IAgentToolPolicyService {
  readonly _serviceBrand: undefined;

  isToolActive(name: string, source?: ToolSource): boolean;
  isToolActiveForDisclosure(name: string, source?: ToolSource): boolean;
  isToolActiveForProfile(
    profile: ToolActivationPolicy,
    name: string,
    source?: ToolSource,
  ): boolean;
  /**
   * Snapshot the composed tool activation policy and return a checker
   * closure. Callers that check many tools per step (e.g. tool selection)
   * should prefer this over calling `isToolActive` in a loop, which
   * re-allocates profile data and re-reads config per tool.
   */
  createToolActiveChecker(): (name: string, source?: ToolSource) => boolean;
  setSessionDisabledTools(names: readonly string[]): Promise<void>;
}

export const IAgentToolPolicyService =
  createDecorator<IAgentToolPolicyService>('agentToolPolicyService');
