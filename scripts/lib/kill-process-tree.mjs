export function killProcessTree(pid) {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    Bun.spawnSync(['taskkill', '/pid', String(pid), '/t', '/f'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}
