import { useNetworkGuard } from '#/bun/index';

if (process.env['KIMI_TESTKIT_NETWORK_GUARD'] !== '0') useNetworkGuard();
