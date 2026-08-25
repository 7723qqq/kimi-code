import { describe, expect, it } from 'vitest';

import { commandForExecFile } from '../../../scripts/native/exec.mjs';

describe('commandForExecFile', () => {
  it('returns command as-is on non-Windows', () => {
    const result = commandForExecFile('sign-tool', ['kimi', 'ASSET_BLOB', './blob'], 'darwin');
    expect(result).toEqual({ command: 'sign-tool', args: ['kimi', 'ASSET_BLOB', './blob'] });
  });

  it('returns command as-is on Windows for non-batch files', () => {
    const result = commandForExecFile('sign-tool.exe', ['kimi.exe'], 'win32');
    expect(result).toEqual({ command: 'sign-tool.exe', args: ['kimi.exe'] });
  });

  it('wraps .cmd files through cmd.exe on Windows', () => {
    const result = commandForExecFile('sign-tool.cmd', ['kimi.exe', 'ASSET_BLOB'], 'win32', {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    });
    expect(result.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(result.args).toEqual(['/d', '/s', '/c', '""sign-tool.cmd" "kimi.exe" "ASSET_BLOB""']);
    expect(result.options?.windowsVerbatimArguments).toBe(true);
  });

  it('wraps .bat files through cmd.exe on Windows', () => {
    const result = commandForExecFile('foo.bat', [], 'win32', { ComSpec: 'cmd.exe' });
    expect(result.command).toBe('cmd.exe');
  });

  it('escapes embedded double quotes in args', () => {
    const result = commandForExecFile('foo.cmd', ['hello "world"'], 'win32', {
      ComSpec: 'cmd.exe',
    });
    expect(result.args[3]).toBe('""foo.cmd" "hello ""world""""');
  });

  it('falls back to cmd.exe when ComSpec missing', () => {
    const result = commandForExecFile('foo.cmd', [], 'win32', {});
    expect(result.command).toBe('cmd.exe');
  });
});
