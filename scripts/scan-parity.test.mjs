import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { rustShellOrder, shellOrderFindings, tsShellOrder } from './scan-parity.mjs';

/**
 * The engine's `resolve_shell`, reduced to the shape the extractor reads.
 *
 * The `#[cfg(not(windows))]` arm matters: it carries a `/bin/bash` of its own,
 * and reading it would put `bash` first. Every assertion below would still see a
 * non-empty list, so only pinning the whole order catches that.
 */
const RUST = `
pub fn resolve_shell(preference: Option<&str>) -> ResolvedShell {
    #[cfg(not(windows))]
    {
        let _ = preference;
        ResolvedShell {
            program: "/bin/bash".to_string(),
            flavor: ShellFlavor::Bash,
        }
    }
    #[cfg(windows)]
    {
        if let Some(path) = std::env::var("KIMI_SHELL_PATH") {
            return ResolvedShell::new(path);
        }
        if let Some(program) = which("pwsh.exe") {
            return ResolvedShell { program, flavor: ShellFlavor::Pwsh };
        }
        if let Some(program) = which("powershell.exe") {
            return ResolvedShell { program, flavor: ShellFlavor::PowerShell };
        }
        if let Some(program) = git_bash() {
            return ResolvedShell { program, flavor: ShellFlavor::Bash };
        }
        ResolvedShell {
            program: "cmd.exe".to_string(),
            flavor: ShellFlavor::Cmd,
        }
    }
}
`;

/** The host's `probeShellPath`, reduced the same way. */
const TS = `
export function probeShellPath(): string | undefined {
  const envShell = process.env['KIMI_SHELL_PATH'];
  if (envShell) {
    return envShell;
  }
  if (process.platform === 'win32') {
    const pwsh = whichOnPath('pwsh.exe');
    if (pwsh !== undefined) return pwsh;
    const powershell = whichOnPath('powershell.exe');
    if (powershell !== undefined) return powershell;
    const candidates = [
      'C:\\\\msys64\\\\usr\\\\bin\\\\bash.exe',
      'C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe',
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }
  return process.env['SHELL'] ?? '/bin/bash';
}
`;

describe('shell order extraction', () => {
  it('reads the engine rungs out of the Windows arm only', () => {
    expect(rustShellOrder(RUST)).toEqual(['pwsh', 'powershell', 'bash', 'cmd']);
  });

  it('reads the host rungs, including the Git Bash candidates it reaches by existsSync', () => {
    expect(tsShellOrder(TS)).toEqual(['pwsh', 'powershell', 'bash']);
  });

  it('returns nothing for a source that does not carry the function', () => {
    expect(rustShellOrder('pub fn other() {}')).toEqual([]);
    expect(tsShellOrder('export function other(): void {}')).toEqual([]);
  });
});

describe('shell order agreement', () => {
  it('accepts the host list when it is a prefix of the engine order', () => {
    expect(shellOrderFindings(RUST, TS)).toEqual([]);
  });

  it('accepts a host that stops even earlier', () => {
    const onlyPwsh = TS.replace(
      /    const powershell = whichOnPath\('powershell\.exe'\);\n    if \(powershell !== undefined\) return powershell;\n/,
      '',
    ).replaceAll(/      'C:.*bash\.exe',\n/g, '');

    expect(shellOrderFindings(RUST, onlyPwsh)).toEqual([]);
  });

  it('fails when the host swaps two rungs', () => {
    const swapped = TS.replace(
      "    const pwsh = whichOnPath('pwsh.exe');\n    if (pwsh !== undefined) return pwsh;\n    const powershell = whichOnPath('powershell.exe');\n    if (powershell !== undefined) return powershell;",
      "    const powershell = whichOnPath('powershell.exe');\n    if (powershell !== undefined) return powershell;\n    const pwsh = whichOnPath('pwsh.exe');\n    if (pwsh !== undefined) return pwsh;",
    );

    const findings = shellOrderFindings(RUST, swapped);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('powershell -> pwsh -> bash');
  });

  it('fails when the host drops a rung the engine ranks above the rest', () => {
    const withoutPwsh = TS.replace(
      "    const pwsh = whichOnPath('pwsh.exe');\n    if (pwsh !== undefined) return pwsh;\n",
      '',
    );

    const findings = shellOrderFindings(RUST, withoutPwsh);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('the host probes powershell -> bash');
  });

  it('fails when the engine renames a rung', () => {
    const renamed = RUST.replaceAll('which("pwsh.exe")', 'which("elvish.exe")');

    const findings = shellOrderFindings(renamed, TS);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('the engine resolves powershell -> bash -> cmd');
  });

  it('fails closed rather than passing vacuously when a source shape moves', () => {
    expect(shellOrderFindings('', TS)).toHaveLength(1);
    expect(shellOrderFindings('', TS)[0]).toContain('resolve_shell');
    expect(shellOrderFindings(RUST, '')).toHaveLength(1);
    expect(shellOrderFindings(RUST, '')[0]).toContain('probeShellPath');
    expect(shellOrderFindings('', '')).toHaveLength(2);
  });
});

describe('shell order against the real tree', () => {
  const repo = join(import.meta.dirname, '..');
  const rust = readFileSync(join(repo, 'packages/kimi-agent/src/native/shell.rs'), 'utf8');
  const ts = readFileSync(
    join(repo, 'packages/node-sdk/src/native/native-llm-resolver.ts'),
    'utf8',
  );

  it('extracts the documented order from both files as they exist', () => {
    expect(rustShellOrder(rust)).toEqual(['pwsh', 'powershell', 'bash', 'cmd']);
    expect(tsShellOrder(ts)).toEqual(['pwsh', 'powershell', 'bash']);
  });

  it('reports no findings for the tree it is run against', () => {
    expect(shellOrderFindings(rust, ts)).toEqual([]);
  });
});
