export { BridgeClientAPI } from './coreProcess/coreProcessClient';
export type { CoreProcessClientDeps } from './coreProcess/coreProcessClient';
export {
  ICoreProcessService,
  type CoreProcessServiceOptions,
} from './coreProcess/coreProcess';
export { CoreProcessService } from './coreProcess/coreProcessService';

export { IEventService } from './event/event';
export { EventService } from './event/eventService';

export { IApprovalService } from './approval/approval';
export type { ApprovalRequest, ApprovalResponse } from './approval/approval';
export {
  toAgentCoreResponse as approvalToAgentCoreResponse,
  toBrokerRequest as approvalToBrokerRequest,
  type ToBrokerRequestParams as ApprovalToBrokerRequestParams,
} from './approval/approval';

export { IQuestionService } from './question/question';
export type { QuestionRequest, QuestionResult } from './question/question';
export {
  toAgentCoreResponse as questionToAgentCoreResponse,
  toBrokerRequest as questionToBrokerRequest,
  dismissedResult as questionDismissedResult,
  type QuestionToBrokerRequestParams,
} from './question/question';

export { IEnvironmentService } from './environment/environment';

export {
  IAuthSummaryService,
  AuthProvisioningRequiredError,
  AuthTokenMissingError,
  AuthTokenUnauthorizedError,
  AuthModelNotResolvedError,
} from './authSummary/authSummary';
export { AuthSummaryService } from './authSummary/authSummaryService';

export { IOAuthService } from './oauth/oauth';
export { OAuthService } from './oauth/oauthService';

export {
  IModelCatalogService,
  ModelNotFoundError,
  ProviderNotFoundError,
  modelIdsForProvider,
  toProtocolModel,
  toProtocolProvider,
} from './modelCatalog/modelCatalog';
export type { ProviderCredentialState } from './modelCatalog/modelCatalog';
export { ModelCatalogService } from './modelCatalog/modelCatalogService';

export {
  ISessionService,
  SessionNotFoundError,
  SessionUndoUnavailableError,
  toProtocolSession,
} from './session/session';
export type { SessionListQuery } from './session/session';
export { SessionService } from './session/sessionService';

export {
  IMessageService,
  MessageNotFoundError,
  deriveMessageId,
  parseMessageId,
  toProtocolMessage,
} from './message/message';
export type { MessageListQuery } from './message/message';
export { MessageService } from './message/messageService';

export {
  IPromptService,
  PromptAlreadyCompletedError,
  PromptNotFoundError,
  SessionBusyError,
} from './prompt/prompt';
export type {
  AgentStateSnapshot,
  PromptAbortResult,
  PromptDispatchLogEntry,
  SyntheticPromptAbortedEvent,
  SyntheticPromptCompletedEvent,
  SyntheticPromptSteeredEvent,
} from './prompt/prompt';
export { PromptService } from './prompt/promptService';

export {
  IToolService,
  toProtocolTool,
  type AgentCoreToolInfoLike,
} from './tool/tool';
export { ToolService } from './tool/toolService';

export {
  IMcpService,
  McpServerNotFoundError,
  toProtocolMcpServer,
} from './mcp/mcp';
export { McpService } from './mcp/mcpService';

export {
  ITaskService,
  TaskAlreadyFinishedError,
  TaskNotFoundError,
  toProtocolTask,
  isTerminalStatus,
} from './task/task';
export type { TaskListQuery } from './task/task';
export { TaskService } from './task/taskService';
