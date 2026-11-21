export { TestkitError, WaitTimeoutError } from '../errors';
export { CONVERSATION_FRAME_TYPES, isConversationFrame, turnsFromFrames, type KapFrame, type KapItem, type KapTurn } from './frames';
export {
  KapHarness,
  startKap,
  TESTKIT_HOST_IDENTITY,
  type CreateSessionOptions,
  type KapAuthTokenService,
  type KapHostIdentity,
  type KapLaunchOptions,
  type KapRunningServer,
  type PromptOptions,
  type StartKapOptions,
  type WaitIdleOptions,
} from './harness';
export { KapEnvelopeError, KapRest, type KapRequest, type QueryValue } from './rest';
export { KapCommandError, KapSocket, WS_BEARER_PROTOCOL_PREFIX, type FrameWaitOptions, type SubscribeOptions } from './socket';
export type * from './types';
