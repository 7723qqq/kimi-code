import {
  getSingletonServiceDescriptors,
  ServiceCollection,
  SyncDescriptor,
} from '@moonshot-ai/agent-core';
import * as Services from '@moonshot-ai/services';
import type { Logger as PinoLogger } from 'pino';

import type { FastifyLike } from '#/services/gateway/restGateway';
import type { DaemonStartOptions } from '../start';

import { ApprovalService } from '#/services/approval/approvalService';
import { IConnectionRegistry } from '#/services/gateway/connectionRegistry';
import { ConnectionRegistry } from '#/services/gateway/connectionRegistryService';
import { IFsService } from '#/services/fs/fs';
import { FsService } from '#/services/fs/fsService';
import { IFsGitService } from '#/services/fs/fsGit';
import { FsGitService } from '#/services/fs/fsGitService';
import { IFsSearchService } from '#/services/fs/fsSearch';
import { FsSearchService } from '#/services/fs/fsSearchService';
import { IFileStore } from '#/services/fileStore/fileStore';
import { FileStore } from '#/services/fileStore/fileStoreService';
import { ILogService } from '#/services/logger/logger';
import { PinoLogger as PinoLoggerAdapter } from '#/services/logger/loggerService';
import { QuestionService } from '#/services/question/questionService';
import { IRestGateway } from '#/services/gateway/restGateway';
import { FastifyRestGateway } from '#/services/gateway/restGatewayService';
import { ISessionClientsService } from '#/services/gateway/sessionClients';
import { SessionClientsService } from '#/services/gateway/sessionClientsService';
import {
  IWorkspaceFsService,
  IWorkspaceRegistry,
  WorkspaceFsService,
  WorkspaceRegistryService,
} from '#/services/workspace';
import { IWSGateway } from '#/services/gateway/wsGateway';
import { WSGateway } from '#/services/gateway/wsGatewayService';
import { IWSBroadcastService } from '#/services/gateway/wsBroadcast';
import { WSBroadcastService } from '#/services/gateway/wsBroadcastService';

export interface DaemonServiceCollectionOptions {
  readonly daemon: DaemonStartOptions;
  readonly app: FastifyLike;
  readonly pinoLogger: PinoLogger;
  readonly envService: Services.IEnvironmentService;
}

export function createDaemonServiceCollection(
  input: DaemonServiceCollectionOptions,
): ServiceCollection {
  const { daemon, app, pinoLogger, envService } = input;

  const services = new ServiceCollection(
    ...getSingletonServiceDescriptors(),
    [IConnectionRegistry, new SyncDescriptor(ConnectionRegistry, [], false)],
    [ISessionClientsService, new SyncDescriptor(SessionClientsService, [], false)],
    [IWSBroadcastService, new SyncDescriptor(WSBroadcastService, [], false)],
    [Services.IApprovalService, new SyncDescriptor(ApprovalService, [], false)],
    [Services.IQuestionService, new SyncDescriptor(QuestionService, [], false)],
    [IFsService, new SyncDescriptor(FsService, [], false)],
    [IFsSearchService, new SyncDescriptor(FsSearchService, [], false)],
    [IFsGitService, new SyncDescriptor(FsGitService, [], false)],
    [IWorkspaceFsService, new SyncDescriptor(WorkspaceFsService, [], false)],
  );

  services.set(ILogService, new PinoLoggerAdapter(pinoLogger));
  services.set(IRestGateway, new FastifyRestGateway(app));
  services.set(Services.IEnvironmentService, envService);

  services.set(
    IWSGateway,
    new SyncDescriptor(WSGateway, [daemon.wsGatewayOptions ?? {}], false),
  );
  services.set(
    Services.ICoreProcessService,
    new SyncDescriptor(Services.CoreProcessService, [daemon.coreProcessOptions ?? {}], false),
  );

  services.set(IFileStore, new SyncDescriptor(FileStore, [], false));
  services.set(IWorkspaceRegistry, new SyncDescriptor(WorkspaceRegistryService, [], false));

  for (const [id, override] of daemon.serviceOverrides ?? []) {
    services.set(id, override);
  }

  return services;
}
