import type { HardRule, MemoryCode } from '../types';

const CREDENTIAL_PATTERN =
  '(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,})';

const PRIVATE_KEY_PATTERN = '-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----';

export const DEFAULT_HARD_RULES: readonly HardRule[] = [
  {
    id: 'credential',
    pattern: CREDENTIAL_PATTERN,
    regex: true,
    action: 'block_write',
    scope: 'note',
    reason: 'credential-like secret',
  },
  {
    id: 'private-key',
    pattern: PRIVATE_KEY_PATTERN,
    regex: true,
    action: 'block_write',
    scope: 'note',
    reason: 'private key block',
  },
];

export const DEFAULT_GUIDANCE =
  'Never store credentials, private keys, or other secrets. When the user explicitly asks to remember something, treat it as high priority. When two memories conflict, prefer what the user stated explicitly over an inference, and newer over older. Do not surface a memory the code forbids.';

export const DEFAULT_CODE: MemoryCode = {
  rules: DEFAULT_HARD_RULES,
  guidance: DEFAULT_GUIDANCE,
};
