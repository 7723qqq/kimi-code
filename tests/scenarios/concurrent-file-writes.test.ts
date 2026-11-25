import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import { createTestHome } from '@moonshot-ai/testkit/fixtures';
import { KapProcess } from '@moonshot-ai/testkit/kap';

test(
  'two KAP processes sharing a home cannot both replace the same revision',
  async () => {
    const home = await createTestHome('concurrent-writes');
    const servers: KapProcess[] = [];
    try {
      servers.push(await KapProcess.start({ home }));
      servers.push(await KapProcess.start({ home }));
      expect(servers[0]!.pid).not.toBe(servers[1]!.pid);
      const path = join(home.dataDir, 'AGENTS.md');
      const original = 'a'.repeat(8 * 1024 * 1024);
      await writeFile(path, original);
      const revision = createHash('sha256').update(original).digest('hex');
      const query = new URLSearchParams({ path, revision });
      const results = await Promise.all(
        servers.map(async (server, index) => {
          const body = `saved by writer ${index}`;
          const res = await fetch(`${server.origin}/api/v1/fs:content?${query.toString()}`, {
            method: 'PUT',
            headers: {
              authorization: `Bearer ${server.token}`,
              'content-type': 'text/plain',
            },
            body,
          });
          return { body, status: res.status, envelope: (await res.json()) as { code: number } };
        }),
      );
      expect(results.map((r) => r.status).toSorted()).toEqual([200, 412]);
      expect(results.find((r) => r.status === 412)?.envelope.code).toBe(41201);
      expect(await readFile(path, 'utf8')).toBe(results.find((r) => r.status === 200)?.body);
    } finally {
      await Promise.all(servers.map((server) => server.close()));
      await home.remove();
    }
  },
  90_000,
);
