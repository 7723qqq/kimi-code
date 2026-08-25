import { BlockList, isIP } from 'node:net';

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

/**
 * Whether an IP address falls into a private, loopback, link-local,
 * CGNAT, or IPv6 unique-local range — the SSRF denylist shared by the
 * URL-fetch and web-search network paths. Accepts bare addresses as well
 * as bracketed or zone-indexed IPv6 forms (`[::1]`, `fe80::1%eth0`).
 */
export function isBlockedIpAddress(address: string): boolean {
  const withoutZone = address.split('%', 1)[0] ?? address;
  const host = withoutZone.startsWith('[') && withoutZone.endsWith(']')
    ? withoutZone.slice(1, -1)
    : withoutZone;
  if (isIP(host) === 4) return PRIVATE_ADDRESS_BLOCKLIST.check(host, 'ipv4');
  return isIP(host) === 6 && PRIVATE_ADDRESS_BLOCKLIST.check(host, 'ipv6');
}
