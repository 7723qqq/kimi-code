

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

import { Disposable, InstantiationType, registerSingleton } from '@moonshot-ai/agent-core';
import type { FsGitStatusRequest, FsGitStatusResponse } from '@moonshot-ai/protocol';
import { ISessionService } from '../session/session';

import { IFsGitService, FsGitUnavailableError, parsePorcelain } from './fsGit';
import { resolveSafePath } from './fsPathSafety';

export class FsGitService extends Disposable implements IFsGitService {
  readonly _serviceBrand: undefined;

  constructor(@ISessionService protected readonly sessions: ISessionService) {
    super();
  }

  async status(
    sessionId: string,
    req: FsGitStatusRequest,
  ): Promise<FsGitStatusResponse> {
    const session = await this.sessions.get(sessionId);
    const cwd = session.metadata.cwd;
    const realCwd = await fs.realpath(cwd);

    let filterSet: Set<string> | undefined;
    if (req.paths !== undefined && req.paths.length > 0) {
      filterSet = new Set();
      for (const p of req.paths) {
        const safe = await resolveSafePath(realCwd, p);
        filterSet.add(safe.relative);
      }
    }

    const insideRes = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], realCwd);
    if (insideRes.exitCode !== 0 || insideRes.stdout.trim() !== 'true') {
      throw new FsGitUnavailableError(
        realCwd,
        insideRes.stderr.trim() || `git rev-parse exit ${insideRes.exitCode}`,
      );
    }

    const porcRes = await runCommand(
      'git',
      ['status', '--porcelain=v1', '--branch'],
      realCwd,
    );
    if (porcRes.exitCode !== 0) {

      throw new FsGitUnavailableError(
        realCwd,
        porcRes.stderr.trim() || `git status exit ${porcRes.exitCode}`,
      );
    }

    return parsePorcelain(porcRes.stdout, filterSet);
  }
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCommand(
  cmd: string,
  args: readonly string[],
  cwd: string,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    child.once('error', () => {
      resolve({ exitCode: -1, stdout, stderr });
    });
    child.once('close', (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

registerSingleton(IFsGitService, FsGitService, InstantiationType.Delayed);
