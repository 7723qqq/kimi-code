import * as sdk from '@moonshot-ai/kimi-code-sdk';

// Bun evaluates a mocked module's real body anyway, but the mock factory cannot
// call `import()` on the module it replaces without recursing. The preload
// captures the real namespace first so a factory can spread it and override a
// single export.
export const realSdk = sdk;
