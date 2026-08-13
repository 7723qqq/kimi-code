/**
 * `auth` domain (cross-cutting) — public-URL validation for the ported
 * `fetchWebContent` engine, mirroring open-websearch's
 * `utils/urlSafety.js` without the `fakeIpCidrs` config knob: http(s)
 * schemes only, and IP literals / hostnames in loopback, RFC1918,
 * link-local, CGNAT and ULA ranges are refused — including IPv4-mapped
 * IPv6 forms. `assertPublicHttpUrlResolved` additionally DNS-resolves the
 * hostname and rejects private answers. Failures throw `Error2`
 * (`WEB_INVALID_URL` / `WEB_PRIVATE_ADDRESS`).
 */

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import { Error2, ErrorCodes } from '#/errors';

const PRIVATE_ADDRESS_BLOCKLIST = (() => {
  const list = new BlockList();
  list.addSubnet('0.0.0.0', 8, 'ipv4');
  list.addSubnet('10.0.0.0', 8, 'ipv4');
  list.addSubnet('100.64.0.0', 10, 'ipv4');
  list.addSubnet('127.0.0.0', 8, 'ipv4');
  list.addSubnet('169.254.0.0', 16, 'ipv4');
  list.addSubnet('172.16.0.0', 12, 'ipv4');
  list.addSubnet('192.168.0.0', 16, 'ipv4');
  list.addSubnet('::', 128, 'ipv6');
  list.addSubnet('::1', 128, 'ipv6');
  list.addSubnet('fc00::', 7, 'ipv6');
  list.addSubnet('fe80::', 10, 'ipv6');
  return list;
})();

// `URL.hostname` keeps the brackets of IPv6 literals (`[::1]`), which break
// `isIP` and `dns.lookup`. Strip them once here.
function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function isBlockedAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address.split('%', 1)[0] ?? address);
  if (isIP(normalized) === 4) return PRIVATE_ADDRESS_BLOCKLIST.check(normalized, 'ipv4');
  return isIP(normalized) === 6 && PRIVATE_ADDRESS_BLOCKLIST.check(normalized, 'ipv6');
}

export function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname.trim().toLowerCase());
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  if (isIP(host) === 0) {
    return false;
  }
  return isBlockedAddress(host);
}

export function isPublicHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    return !isPrivateOrLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function assertPublicHttpUrl(url: string | URL, label = 'URL'): void {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error2(ErrorCodes.WEB_INVALID_URL, `${label} must use HTTP or HTTPS`, {
      details: { url: parsed.toString(), protocol: parsed.protocol },
    });
  }
  if (isPrivateOrLocalHostname(parsed.hostname)) {
    throw new Error2(
      ErrorCodes.WEB_PRIVATE_ADDRESS,
      `${label} points to a private or local network target, which is not allowed`,
      { details: { host: parsed.hostname } },
    );
  }
}

export async function assertPublicHttpUrlResolved(url: string | URL, label = 'URL'): Promise<void> {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  assertPublicHttpUrl(parsed, label);
  const host = stripIpv6Brackets(parsed.hostname);
  if (isIP(host) !== 0) {
    return;
  }
  let resolved;
  try {
    resolved = await lookup(host, { all: true });
  } catch (error) {
    throw new Error2(ErrorCodes.WEB_PRIVATE_ADDRESS, `${label} could not be resolved`, {
      cause: error,
      details: { host },
    });
  }
  if (resolved.some((entry) => isPrivateOrLocalHostname(entry.address))) {
    throw new Error2(
      ErrorCodes.WEB_PRIVATE_ADDRESS,
      `${label} resolves to a private or local network target, which is not allowed`,
      { details: { host } },
    );
  }
}
