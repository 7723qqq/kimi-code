import { pathToFileURL } from 'node:url';
import { win32 } from 'node:path';

export function localFileAddressUrl(address: string, platform: NodeJS.Platform = process.platform): string | null {
  const input = address.trim();
  if (/^file:/i.test(input)) {
    try {
      return new URL(input).href;
    } catch {
      return null;
    }
  }
  if (input.includes('\0')) return null;
  const windows = platform === 'win32';
  const absolute = windows ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(input) && win32.isAbsolute(input) : input.startsWith('/');
  return absolute ? pathToFileURL(input, { windows }).href : null;
}
