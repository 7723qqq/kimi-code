import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, hostname, release, type } from 'node:os';
import { join } from 'node:path';

import type { DeviceHeaders } from './types';

export const KIMI_CODE_PLATFORM = 'kimi_code_cli';

export interface KimiHostIdentity {
  readonly productName: string;
  readonly version: string;
  readonly platform: string;
  readonly userAgentSuffix?: string | undefined;
}

export interface KimiIdentityOptions extends KimiHostIdentity {
  readonly homeDir: string;
}

export interface CreateKimiDeviceIdOptions {
  readonly onFirstLaunch?: ((id: string) => void) | undefined;
}

/**
 * The host facts `createKimiDeviceHeaders` reports.
 *
 * Production always reads the live host; a caller may override individual
 * entries to describe a host it is not running on (an unsupported platform, a
 * simulated macOS release). Overrides are merged over the real probe, so a test
 * that only cares about the device name still gets a real device id and OS
 * version.
 */
export interface KimiHostProbe {
  readonly hostname: () => string;
  readonly osType: () => string;
  readonly osRelease: () => string;
  readonly osArch: () => string;
  /** Contents of {@link MACOS_SYSTEM_VERSION_PLIST}; throws when unreadable. */
  readonly readMacOsSystemVersion: () => string;
}

export function readKimiDeviceId(homeDir: string): string | null {
  const deviceIdPath = join(homeDir, 'device_id');
  if (!existsSync(deviceIdPath)) return null;
  try {
    const text = readFileSync(deviceIdPath, 'utf-8').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export function createKimiDeviceId(
  homeDir: string,
  options: CreateKimiDeviceIdOptions = {},
): string {
  const existing = readKimiDeviceId(homeDir);
  if (existing !== null) return existing;

  const id = randomUUID();
  try {
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(homeDir, 'device_id'), id, { encoding: 'utf-8', mode: 0o600 });
  } catch {}
  if (options.onFirstLaunch !== undefined) {
    try {
      options.onFirstLaunch(id);
    } catch {}
  }
  return id;
}

export function createKimiDeviceHeaders(options: {
  readonly homeDir: string;
  readonly version: string;
  readonly platform: string;
  /** Host facts to report instead of the live host; see {@link KimiHostProbe}. */
  readonly host?: Partial<KimiHostProbe> | undefined;
}): DeviceHeaders {
  const host: KimiHostProbe = { ...defaultHostProbe, ...options.host };
  return {
    'X-Msh-Platform': requiredAsciiHeader(options.platform, 'Kimi identity platform'),
    'X-Msh-Version': requiredAsciiHeader(options.version, 'Kimi identity version'),
    'X-Msh-Device-Name': asciiHeader(host.hostname()),
    'X-Msh-Device-Model': asciiHeader(deviceModel(host)),
    'X-Msh-Os-Version': asciiHeader(host.osRelease()),
    'X-Msh-Device-Id': createKimiDeviceId(options.homeDir),
  };
}

export function createKimiUserAgent(options: {
  readonly productName: string;
  readonly version: string;
  readonly userAgentSuffix?: string | undefined;
}): string {
  const product = requiredAsciiHeader(options.productName, 'Kimi identity product');
  const version = requiredAsciiHeader(options.version, 'Kimi identity version');
  const suffix =
    options.userAgentSuffix === undefined ? undefined : asciiHeader(options.userAgentSuffix, '');
  return suffix === undefined || suffix.length === 0
    ? `${product}/${version}`
    : `${product}/${version} (${suffix})`;
}

export function replaceUserAgentProduct(userAgent: string, product: string): string {
  const cleaned = requiredAsciiHeader(product, 'Kimi identity product');
  const separator = userAgent.indexOf('/');
  return separator < 0 ? cleaned : `${cleaned}${userAgent.slice(separator)}`;
}

export function createKimiDefaultHeaders(options: KimiIdentityOptions): Record<string, string> {
  return {
    'User-Agent': createKimiUserAgent(options),
    ...createKimiDeviceHeaders({
      homeDir: options.homeDir,
      version: options.version,
      platform: options.platform,
    }),
  };
}

export const KIMI_CODE_CUSTOM_HEADERS_ENV = 'KIMI_CODE_CUSTOM_HEADERS';

export function parseKimiCodeCustomHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const raw = env[KIMI_CODE_CUSTOM_HEADERS_ENV]?.trim();
  if (raw === undefined || raw.length === 0) return {};
  const headers: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (name.length === 0) continue;
    headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

export function assertKimiHostIdentity(identity: KimiHostIdentity | undefined): KimiHostIdentity {
  if (identity === undefined) {
    throw new Error('Kimi host identity is required. Pass the host product name and version.');
  }
  requiredAsciiHeader(identity.productName, 'Kimi identity product');
  requiredAsciiHeader(identity.version, 'Kimi identity version');
  return identity;
}

function deviceModel(host: KimiHostProbe): string {
  const os = host.osType();
  const version = host.osRelease();
  const osArch = host.osArch();
  if (os === 'Darwin') return `macOS ${macOsProductVersion(host) ?? version} ${osArch}`;
  if (os === 'Windows_NT') return `Windows ${version} ${osArch}`;
  return `${os} ${version} ${osArch}`.trim();
}

const MACOS_SYSTEM_VERSION_PLIST = '/System/Library/CoreServices/SystemVersion.plist';

const defaultHostProbe: KimiHostProbe = {
  hostname,
  osType: type,
  osRelease: release,
  osArch: arch,
  readMacOsSystemVersion: () => readFileSync(MACOS_SYSTEM_VERSION_PLIST, 'utf-8'),
};

function macOsProductVersion(host: KimiHostProbe): string | undefined {
  try {
    const plist = host.readMacOsSystemVersion();
    const version = /<key>ProductVersion<\/key>\s*<string>([^<]*)<\/string>/
      .exec(plist)?.[1]
      ?.trim();
    return version !== undefined && version.length > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

function asciiHeader(value: string, fallback = 'unknown'): string {
  const cleaned = value.replaceAll(/[^\u0020-\u007E]/g, '').trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function requiredAsciiHeader(value: string, fieldName: string): string {
  const cleaned = asciiHeader(value, '');
  if (cleaned.length === 0) {
    throw new Error(`${fieldName} must be a non-empty ASCII string.`);
  }
  return cleaned;
}
