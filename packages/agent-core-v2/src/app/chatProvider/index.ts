/**
 * `chatProvider` domain barrel — re-exports the chat-provider factory contract
 * (`chatProvider`), its scoped service (`chatProviderService`), the Kimi request
 * override helper (`kimiModelOverrides`), and the provider error codes
 * (`errors`). Importing this barrel registers the `IChatProviderFactory` binding
 * and the `ChatProviderErrors` codes into their registries.
 */

export * from './chatProvider';
export * from './chatProviderService';
export * from './errors';
export * from './kimiModelOverrides';
