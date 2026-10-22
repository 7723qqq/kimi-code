import { describe, expect, it, mock, spyOn } from 'bun:test';

import * as environmentProbe from '#/_base/execEnv/environmentProbe';
import { ProbeShellNotFoundError } from '#/_base/execEnv/environmentProbe';
import { HostEnvironmentService } from '#/os/backends/host/hostEnvironmentService';
import { HostProcessError, OsProcessErrors } from '#/os/interface/hostProcess';

spyOn(environmentProbe, 'probeHostEnvironmentFromNode').mockImplementation(() =>
  Promise.reject(
    new ProbeShellNotFoundError('Git Bash missing (stubbed)', [
      'C:\\Program Files\\Git\\bin\\bash.exe',
    ]),
  ),
);

void mock.module('#/_base/execEnv/loginShellPath', () => ({
  applyLoginShellPathFromNode: () => Promise.resolve(),
}));

describe('HostEnvironmentService', () => {
  it('rejects ready with the translated HostProcessError when the probe fails', async () => {
    const service = new HostEnvironmentService();

    await expect(service.ready).rejects.toBeInstanceOf(HostProcessError);
    await expect(service.ready).rejects.toMatchObject({
      code: OsProcessErrors.codes.SHELL_GIT_BASH_NOT_FOUND,
    });
  });

  it('preserves the probe error as cause and checked paths as details', async () => {
    const service = new HostEnvironmentService();

    const rejected: unknown = await service.ready.catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(HostProcessError);
    const hostError = rejected as HostProcessError;
    expect(hostError.details).toEqual({ checkedPaths: ['C:\\Program Files\\Git\\bin\\bash.exe'] });
    expect(hostError.cause).toBeInstanceOf(ProbeShellNotFoundError);
  });

  it('does not surface the ready rejection as an unhandledRejection', async () => {
    const service = new HostEnvironmentService();

    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(service.ready).rejects.toBeInstanceOf(HostProcessError);
  });

  it('throws HostProcessError when reading fields after a failed probe', async () => {
    const service = new HostEnvironmentService();
    await service.ready.catch(() => {});

    expect(() => service.shellPath).toThrow(HostProcessError);
    expect(() => service.osKind).toThrow(HostProcessError);
  });
});
