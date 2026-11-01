import { readFileSync } from 'node:fs';

let cached: string | undefined;

export function getServerVersion(): string {
  if (cached !== undefined) return cached;
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    const raw = readFileSync(Bun.fileURLToPath(pkgUrl), 'utf-8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    cached = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
