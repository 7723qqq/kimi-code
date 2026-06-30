/**
 * `messageLegacy` domain barrel — re-exports the v1 message-history adapter
 * contract and implementation. Importing this barrel registers the
 * `message.not_found` error code and the `IMessageLegacyService` binding.
 */

import './errors';
export * from './messageLegacy';
export * from './messageLegacyService';
