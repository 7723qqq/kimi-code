/**
 * `mcpCore` domain — MCP server configuration schemas.
 *
 * Owns the `McpServerConfig` schema and its transport variants. These describe
 * the shape of MCP server entries as they appear in configuration (whether in
 * `config.toml` or an MCP-specific config file).
 *
 * Remote variants accept `auth: "oauth"`, mirroring v1: OAuth is still
 * discovered from a remote server's 401 response; the flag records that the
 * user explicitly chose OAuth, so static `headers` on the same entry are
 * treated as plain request headers (capability/identity declarations) rather
 * than as the server's credentials.
 */

import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { z } from 'zod';

const StringRecordSchema = z.record(z.string(), z.string());

export const MAX_MCP_TIMEOUT_MS = 2_147_483_647;
export const McpTimeoutMsSchema = z.number().int().min(1).max(MAX_MCP_TIMEOUT_MS);

const McpServerCommonFields = {
  enabled: z.boolean().optional(),
  startupTimeoutMs: McpTimeoutMsSchema.optional(),
  toolTimeoutMs: McpTimeoutMsSchema.optional(),
  enabledTools: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
} as const;

export const McpServerStdioConfigSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: StringRecordSchema.optional(),
  cwd: z.string().optional(),
  executor: z.enum(['local', 'kaos']).optional(),
  ...McpServerCommonFields,
});

export type McpServerStdioConfig = z.infer<typeof McpServerStdioConfigSchema>;

export const McpServerHttpConfigSchema = z.object({
  transport: z.literal('http'),
  url: z.string().url(),
  headers: StringRecordSchema.optional(),
  auth: z.literal('oauth').optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  ...McpServerCommonFields,
});

export type McpServerHttpConfig = z.infer<typeof McpServerHttpConfigSchema>;

export const McpServerSseConfigSchema = z.object({
  transport: z.literal('sse'),
  url: z.string().url(),
  headers: StringRecordSchema.optional(),
  auth: z.literal('oauth').optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  ...McpServerCommonFields,
});

export type McpServerSseConfig = z.infer<typeof McpServerSseConfigSchema>;
export type McpRemoteServerConfig = McpServerHttpConfig | McpServerSseConfig;

const McpServerConfigDiscriminatedSchema = z.discriminatedUnion('transport', [
  McpServerStdioConfigSchema,
  McpServerHttpConfigSchema,
  McpServerSseConfigSchema,
]);

export const McpServerConfigSchema = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if ('transport' in obj) return obj;
  if (typeof obj['command'] === 'string') return { ...obj, transport: 'stdio' };
  if (typeof obj['url'] === 'string') return { ...obj, transport: 'http' };
  return obj;
}, McpServerConfigDiscriminatedSchema);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * Reject URLs that would let a configured MCP server exfiltrate bearer
 * tokens to internal networks or cloud metadata services. Literal IPs are
 * checked directly; hostnames are DNS-resolved (`all: true`) and every
 * resolved address must pass the same checks before the URL is allowed.
 * Resolution failure fails closed.
 */
export async function isSafeMcpRemoteUrl(value: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost') return true;
  if (isPrivateOrLoopbackIPv4(host)) return false;
  if (isPrivateOrLoopbackIPv6(host)) return false;
  if (looksLikeObfuscatedLoopback(host)) return false;
  if (isIP(host) !== 0) return true;
  let addresses: readonly LookupAddress[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return false;
  }
  for (const { address } of addresses) {
    const normalized = ipv4MappedToV4(address) ?? address;
    if (isPrivateOrLoopbackIPv4(normalized)) return false;
    if (isPrivateOrLoopbackIPv6(normalized)) return false;
  }
  return true;
}

function isPrivateOrLoopbackIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return false;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateOrLoopbackIPv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  if (h.startsWith('::ffff:')) {
    const v4 = ipv4MappedToV4(h);
    if (v4 !== undefined && isPrivateOrLoopbackIPv4(v4)) return true;
  }
  return false;
}

/**
 * Extract the embedded IPv4 from an IPv4-mapped IPv6 literal
 * (`::ffff:a.b.c.d` or the hex `::ffff:7f00:1` form), normalized to dotted
 * decimal. Returns undefined for anything else so the caller can run its
 * regular checks on the original value.
 */
function ipv4MappedToV4(host: string): string | undefined {
  const h = host.toLowerCase();
  const dotted = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (dotted !== null) return `${dotted[1]}.${dotted[2]}.${dotted[3]}.${dotted[4]}`;
  const hexed = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hexed !== null) {
    const value = Number.parseInt(hexed[1]!, 16) * 0x10000 + Number.parseInt(hexed[2]!, 16);
    return `${(value >>> 24) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`;
  }
  return undefined;
}

function looksLikeObfuscatedLoopback(host: string): boolean {
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (n === 2130706433 || n === 0) return true;
  }
  if (/^0x[0-9a-f]+$/i.test(host)) return true;
  if (/^0[0-7]+(\.[0-7]+)*$/.test(host)) return true;
  return false;
}
