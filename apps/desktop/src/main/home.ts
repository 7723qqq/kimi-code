import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveKimiHome(): string {
  const configured = process.env['KIMI_CODE_HOME'];
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.kimi-code');
}
