import { isAbsolute, resolve } from 'node:path';

export function resolveSupervisorProgram(
  argv: readonly string[] = process.argv,
  cwd: string = process.cwd(),
  execPath: string = process.execPath,
): string {
  const candidate = argv[1] === 'server' ? execPath : (argv[1] ?? execPath);
  return isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
}
