export { KimiHarness } from '#/kimi-harness';
export { Session } from '#/session';
export {
  BirpcSDKRpcClient,
  createBirpcKimiHarness,
  type BirpcKimiHarnessOptions,
  type BirpcSDKRpcClientChannelOptions,
  type BirpcSDKRpcClientOptions,
} from '#/birpc-client';
export {
  ErrorCodes,
  KIMI_ERROR_INFO,
  type KimiErrorCode,
  type KimiErrorInfo,
} from '@moonshot-ai/agent-core/errors/codes';
export {
  KimiError,
  type KimiErrorOptions,
} from '@moonshot-ai/agent-core/errors/classes';

export type {
  ApprovalHandler,
  ApprovalRequest,
  ApprovalResponse,
  Event,
  QuestionHandler,
  QuestionRequest,
  QuestionResult,
} from '#/events';
export type {
  CoreAPI,
  SDKAPI,
  SDKRPCClient,
} from '@moonshot-ai/agent-core';
export type {
  KimiConfig,
  KimiHostIdentity,
  SessionStatus,
} from '#/types';
