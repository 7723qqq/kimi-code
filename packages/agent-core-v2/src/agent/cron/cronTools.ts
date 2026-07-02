/**
 * `cronTools` domain (L4) — `IAgentCronToolsService` registration contract.
 *
 * Marker service: its implementation registers the built-in cron tools
 * (CronCreate / CronList / CronDelete) into the agent `IAgentToolRegistryService`
 * on construction. Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentCronToolsService {
  readonly _serviceBrand: undefined;
}

export const IAgentCronToolsService: ServiceIdentifier<IAgentCronToolsService> =
  createDecorator<IAgentCronToolsService>('agentCronToolsService');
