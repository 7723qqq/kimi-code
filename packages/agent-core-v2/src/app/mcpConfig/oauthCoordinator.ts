import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import {
  McpOAuthCoordinator,
  type McpOAuthCredentialsCoordinator,
} from '#/mcpCore/oauth/coordinator';

export interface IOAuthCredentialsCoordinator extends McpOAuthCredentialsCoordinator {
  readonly _serviceBrand: undefined;
}

export const IOAuthCredentialsCoordinator: ServiceIdentifier<IOAuthCredentialsCoordinator> =
  createDecorator<IOAuthCredentialsCoordinator>('oauthCredentialsCoordinator');

registerScopedService(
  LifecycleScope.App,
  IOAuthCredentialsCoordinator,
  McpOAuthCoordinator,
  ScopeActivation.OnDemand,
  'mcpConfig',
);