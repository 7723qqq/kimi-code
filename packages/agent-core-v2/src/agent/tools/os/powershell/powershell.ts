import * as nodePath from 'node:path';

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { ProbeShellNotFoundError } from '#/_base/execEnv/environmentProbe';
import {
  findShellPayloadPin,
  resolveShellPayloadHome,
  shellPayloadExePath,
} from '#/_base/execEnv/shellPayload';
import { type AgentTool } from '#/tool/toolContract';

import { MAX_BACKGROUND_TIMEOUT_S, MAX_TIMEOUT_S } from '../bash/bash';

export const POWERSHELL_UTF8_PREAMBLE =
  '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()\n' +
  '$OutputEncoding=[System.Text.UTF8Encoding]::new()\n' +
  "$ProgressPreference='SilentlyContinue'";

export const PowerShellInputSchema = z
  .object({
    command: z
      .string()
      .min(1, 'Command cannot be empty.')
      .describe('The PowerShell script to execute.'),
    cwd: z
      .string()
      .optional()
      .describe(
        "The working directory in which to run the script. When omitted, the script runs in the session's working directory.",
      ),
    timeout: z
      .number()
      .int()
      .positive()
      .describe('Optional timeout in seconds for the script to execute.')
      .optional(),
    description: z
      .string()
      .optional()
      .describe(
        'A short description for the background task. Required when run_in_background is true.',
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe('Whether to run the script as a background task.'),
    disable_timeout: z
      .boolean()
      .optional()
      .describe(
        'If true, do not apply a timeout to the script. Only applies when run_in_background is true.',
      ),
  })
  .superRefine((val, ctx) => {
    if (val.timeout === undefined) return;
    const maxSeconds = val.run_in_background === true ? MAX_BACKGROUND_TIMEOUT_S : MAX_TIMEOUT_S;
    if (val.timeout > maxSeconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['timeout'],
        message: `timeout must be ≤ ${String(maxSeconds)}s`,
      });
    }
  });

export type PowerShellInput = z.infer<typeof PowerShellInputSchema>;

export interface IPowerShellTool extends AgentTool<PowerShellInput> {
  readonly _serviceBrand: undefined;
}
export const IPowerShellTool = createDecorator<IPowerShellTool>('powerShellTool');

export interface PowerShellResolveDeps {
  readonly env: Record<string, string | undefined>;
  readonly osHomeDir: string;
  readonly isFile: (path: string) => Promise<boolean>;
}

export type PowerShellExecutableKind = 'pwsh' | 'windows-powershell';

export interface PowerShellExecutable {
  readonly path: string;
  readonly kind: PowerShellExecutableKind;
}

export function encodePowerShellScript(script: string): string {
  return Buffer.from(`${POWERSHELL_UTF8_PREAMBLE}\n${script}`, 'utf16le').toString('base64');
}

export function buildPowerShellArgs(script: string): readonly string[] {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellScript(script)];
}

export function normalizePowerShellOutput(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

export async function resolvePowerShellExecutable(
  deps: PowerShellResolveDeps,
): Promise<PowerShellExecutable> {
  const checked: string[] = [];

  const override = deps.env['KIMI_PWSH_PATH']?.trim();
  if (override !== undefined && override.length > 0) {
    checked.push(override);
    if (await deps.isFile(override)) return { path: override, kind: 'pwsh' };
  }

  for (const candidate of pwshPathCandidates(deps.env)) {
    checked.push(candidate);
    if (await deps.isFile(candidate)) return { path: candidate, kind: 'pwsh' };
  }

  const pin = findShellPayloadPin('pwsh');
  if (pin !== undefined) {
    const payloadExe = shellPayloadExePath(resolveShellPayloadHome(deps.env, deps.osHomeDir), pin);
    checked.push(payloadExe);
    if (await deps.isFile(payloadExe)) return { path: payloadExe, kind: 'pwsh' };
  }

  for (const candidate of windowsPowerShellCandidates(deps.env)) {
    checked.push(candidate);
    if (await deps.isFile(candidate)) {
      return { path: candidate, kind: 'windows-powershell' };
    }
  }

  throw new ProbeShellNotFoundError(
    'PowerShell was not found on this Windows host. Run `kimi shells provision --pwsh` to install the bundled pwsh payload, or install PowerShell 7 from https://github.com/PowerShell/PowerShell, or set KIMI_PWSH_PATH to a pwsh.exe.',
    checked,
  );
}

function pwshPathCandidates(env: Record<string, string | undefined>): readonly string[] {
  const candidates: string[] = [];
  const pathValue = env['PATH'] ?? '';
  for (const dir of pathValue.split(';')) {
    const trimmed = dir.trim();
    if (trimmed.length > 0) candidates.push(nodePath.win32.join(trimmed, 'pwsh.exe'));
  }
  candidates.push(nodePath.win32.join('C:\\Program Files\\PowerShell\\7', 'pwsh.exe'));
  candidates.push(nodePath.win32.join('C:\\Program Files\\PowerShell\\7-preview', 'pwsh.exe'));
  return dedupeWinPaths(candidates);
}

function windowsPowerShellCandidates(env: Record<string, string | undefined>): readonly string[] {
  const systemRoot = env['SystemRoot']?.trim() ?? 'C:\\Windows';
  return [
    nodePath.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
}

function dedupeWinPaths(paths: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(path);
  }
  return result;
}
