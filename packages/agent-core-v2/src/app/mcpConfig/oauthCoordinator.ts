/**
 * `mcpConfig` domain — `IOAuthCredentialsCoordinator`, the App-scope
 * notification seam for MCP OAuth credential changes.
 *
 * One instance per engine app, shared by every workspace handler's
 * `McpOAuthService`: when one service saves or invalidates credentials, every
 * workspace's MCP manager is told so live sessions flip to `needs-auth` or
 * reconnect instead of keeping doomed connections.
 */

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