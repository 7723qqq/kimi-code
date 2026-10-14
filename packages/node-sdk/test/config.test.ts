import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseConfigString } from '#/config/index';
import { createKimiConfigRpc, createKimiHarness } from '#/index';

import { TEST_IDENTITY } from './test-identity';

const toPosix = (p: string): string => p.replaceAll('\\', '/');

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-config-'));
  tempDirs.push(dir);
  return dir;
}

describe('SDK config TOML', () => {
  it('resolves config paths through the config RPC wrapper', async () => {
    const dir = await makeTempDir();
    const rpc = createKimiConfigRpc();

    await expect(rpc.resolveConfigPath({ homeDir: dir })).resolves.toBe(
      toPosix(join(dir, 'config.toml')),
    );
  });

  it('returns structured validation issues through the config RPC wrapper', async () => {
    const rpc = createKimiConfigRpc();

    await expect(
      rpc.validateConfigToml({
        text: `
[providers.kimi]
type = "kimi"

[models.kimi]
provider = "kimi"
model = "kimi"
max_context_size = "large"
`,
        filePath: 'broken.toml',
      }),
    ).rejects.toMatchObject({
      details: {
        validationIssues: [
          {
            path: ['models', 'kimi', 'maxContextSize'],
          },
        ],
      },
    });
  });

  it('parses a provider api_key_env into camelCase apiKeyEnv', async () => {
    const rpc = createKimiConfigRpc();
    const text = `
[providers.acme]
type = "openai"
api_key_env = "ACME_API_KEY"
`;

    await expect(rpc.validateConfigToml({ text })).resolves.toBeUndefined();
    expect(parseConfigString(text).providers['acme']?.apiKeyEnv).toBe('ACME_API_KEY');
  });

  it('reads back github and extraAgentDirs through getConfig', async () => {
    const homeDir = await makeTempDir();
    await writeFile(
      join(homeDir, 'config.toml'),
      `
extra_agent_dirs = ["/tmp/extra-agents"]

[github]
token = "ghp_test_token"
base_url = "https://ghe.example.test/api/v3"
`,
      'utf-8',
    );
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    try {
      const config = await harness.getConfig();
      expect(config.github).toEqual({
        token: 'ghp_test_token',
        baseUrl: 'https://ghe.example.test/api/v3',
      });
      expect(config.extraAgentDirs).toEqual(['/tmp/extra-agents']);
    } finally {
      await harness.close();
    }
  });
});
