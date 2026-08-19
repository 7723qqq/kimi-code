import { writeSync } from 'node:fs';

const banner = process.env['KIMI_TEST_MCP_STDERR'] ?? 'fatal: missing API token';
writeSync(2, `${banner}\n`);
process.exit(2);
