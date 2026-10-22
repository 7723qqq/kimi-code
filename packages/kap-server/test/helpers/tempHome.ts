import { rm } from 'node:fs/promises';

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);

export async function removeTempHome(home: string | undefined): Promise<void> {
  if (home === undefined) return;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(home, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !RETRYABLE.has(code)) throw error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25 * (attempt + 1));
      });
    }
  }
}
