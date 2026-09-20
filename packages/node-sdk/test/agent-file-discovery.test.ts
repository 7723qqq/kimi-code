/**
 * Scenario: agent-file discovery across the documented directory scopes.
 * Responsibilities: scope precedence, the built-in `override` rule, recursive
 *   scanning, the project-root walk, and failure handling.
 * Wiring: real temp directories on disk; no mocks.
 * Run: bunx vitest run test/agent-file-discovery.test.ts
 *
 * Spec: docs/en/customization/agents.md ("Agent Locations", lines 54-82).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverAgentFiles,
  type AgentFileDefinition,
  type DiscoverAgentFilesOptions,
} from '#/agent-file';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix = 'kimi-agent-discovery-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeAgentFile(
  dir: string,
  fileName: string,
  frontmatter: string,
  body = 'Do the thing.',
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  await writeFile(path, `---\n${frontmatter}\n---\n\n${body}\n`, 'utf-8');
  return path;
}

/** An options object with every scope pointed at a fresh, empty temp dir. */
async function isolatedOptions(
  overrides: Partial<DiscoverAgentFilesOptions> = {},
): Promise<DiscoverAgentFilesOptions> {
  return {
    workDir: await makeTempDir('kimi-work-'),
    kimiHome: await makeTempDir('kimi-home-'),
    osHomeDir: await makeTempDir('kimi-os-home-'),
    ...overrides,
  };
}

function byName(
  profiles: readonly AgentFileDefinition[],
  name: string,
): AgentFileDefinition | undefined {
  return profiles.find((profile) => profile.name === name);
}

describe('discoverAgentFiles', () => {
  it('parses a real project-scoped agent file with name, description, and tools', async () => {
    const workDir = await makeTempDir('kimi-work-');
    const kimiHome = await makeTempDir('kimi-home-');
    const osHomeDir = await makeTempDir('kimi-os-home-');
    const dir = join(workDir, '.kimi-code', 'agents');
    await writeAgentFile(
      dir,
      'reviewer.md',
      'name: reviewer\ndescription: Strict code reviewer\ntools:\n  - Read\n  - Grep\n  - mcp__github__*',
    );

    const { profiles } = discoverAgentFiles({ workDir, kimiHome, osHomeDir });

    const reviewer = profiles.find((profile) => profile.name === 'reviewer');
    expect(reviewer).toBeDefined();
    expect(reviewer?.description).toBe('Strict code reviewer');
    expect(reviewer?.tools).toEqual(['Read', 'Grep', 'mcp__github__*']);
    expect(reviewer?.source).toBe('project');
    expect(reviewer?.prompt).toBe('Do the thing.');
    expect(reviewer?.path.endsWith('reviewer.md')).toBe(true);
  });

  it('scans a scope directory recursively for .md files', async () => {
    const workDir = await makeTempDir('kimi-work-');
    const kimiHome = await makeTempDir('kimi-home-');
    const osHomeDir = await makeTempDir('kimi-os-home-');
    const nested = join(workDir, '.kimi-code', 'agents', 'team', 'backend');
    await writeAgentFile(nested, 'deep-agent.md', 'name: deep-agent\ndescription: Nested.');
    await writeAgentFile(
      join(workDir, '.kimi-code', 'agents'),
      'ignored.txt',
      'name: not-an-agent\ndescription: Not markdown.',
    );

    const { profiles } = discoverAgentFiles({ workDir, kimiHome, osHomeDir });

    expect(byName(profiles, 'deep-agent')).toBeDefined();
    expect(byName(profiles, 'ignored')).toBeUndefined();
  });

  it('finds the project root by walking up to the nearest .git directory', async () => {
    const repoRoot = await makeTempDir('kimi-repo-');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    const nested = join(repoRoot, 'packages', 'app', 'src');
    await mkdir(nested, { recursive: true });
    await writeAgentFile(
      join(repoRoot, '.kimi-code', 'agents'),
      'root-agent.md',
      'name: root-agent\ndescription: Lives at the repo root.',
    );

    const { profiles } = discoverAgentFiles({
      workDir: nested,
      kimiHome: await makeTempDir('kimi-home-'),
      osHomeDir: await makeTempDir('kimi-os-home-'),
    });

    expect(byName(profiles, 'root-agent')?.source).toBe('project');
  });

  it('lets a higher-precedence scope win for a name defined in two scopes', async () => {
    const workDir = await makeTempDir('kimi-work-');
    const kimiHome = await makeTempDir('kimi-home-');
    const osHomeDir = await makeTempDir('kimi-os-home-');
    await writeAgentFile(
      join(osHomeDir, '.agents', 'agents'),
      'shared.md',
      'name: shared\ndescription: From the user scope.',
    );
    await writeAgentFile(
      join(workDir, '.kimi-code', 'agents'),
      'shared.md',
      'name: shared\ndescription: From the project scope.',
    );

    const { profiles } = discoverAgentFiles({ workDir, kimiHome, osHomeDir });

    expect(profiles.filter((profile) => profile.name === 'shared')).toHaveLength(1);
    expect(byName(profiles, 'shared')?.description).toBe('From the project scope.');
    expect(byName(profiles, 'shared')?.source).toBe('project');
  });

  it('ranks an explicit --agent-file above every directory scope', async () => {
    const workDir = await makeTempDir('kimi-work-');
    const kimiHome = await makeTempDir('kimi-home-');
    const osHomeDir = await makeTempDir('kimi-os-home-');
    await writeAgentFile(
      join(workDir, '.kimi-code', 'agents'),
      'shared.md',
      'name: shared\ndescription: From the project scope.',
    );
    const explicitDir = await makeTempDir('kimi-explicit-');
    const explicitPath = await writeAgentFile(
      explicitDir,
      'shared.md',
      'name: shared\ndescription: From --agent-file.',
    );

    const { profiles } = discoverAgentFiles({
      workDir,
      kimiHome,
      osHomeDir,
      explicitFiles: [explicitPath],
    });

    expect(byName(profiles, 'shared')?.description).toBe('From --agent-file.');
    expect(byName(profiles, 'shared')?.source).toBe('explicit');
  });

  it('reads extra_agent_dirs between the project and user scopes', async () => {
    const workDir = await makeTempDir('kimi-work-');
    const kimiHome = await makeTempDir('kimi-home-');
    const osHomeDir = await makeTempDir('kimi-os-home-');
    const extraDir = await makeTempDir('kimi-extra-');
    await writeAgentFile(
      extraDir,
      'shared.md',
      'name: shared\ndescription: From the extra scope.',
    );
    await writeAgentFile(
      join(osHomeDir, '.agents', 'agents'),
      'shared.md',
      'name: shared\ndescription: From the user scope.',
    );

    const { profiles } = discoverAgentFiles({
      workDir,
      kimiHome,
      osHomeDir,
      extraDirs: [extraDir],
    });

    expect(byName(profiles, 'shared')?.description).toBe('From the extra scope.');
    expect(byName(profiles, 'shared')?.source).toBe('extra');
  });

  it('expands a leading ~ in extra_agent_dirs against the OS home', async () => {
    const workDir = await makeTempDir('kimi-work-');
    const kimiHome = await makeTempDir('kimi-home-');
    const osHomeDir = await makeTempDir('kimi-os-home-');
    await writeAgentFile(
      join(osHomeDir, 'team-agents'),
      'tilde-agent.md',
      'name: tilde-agent\ndescription: Declared with a ~ path.',
    );

    const { profiles } = discoverAgentFiles({
      workDir,
      kimiHome,
      osHomeDir,
      extraDirs: ['~/team-agents'],
    });

    expect(byName(profiles, 'tilde-agent')?.source).toBe('extra');
  });

  it('keeps the Kimi user scope under KIMI_CODE_HOME and the generic one under the OS home', async () => {
    const workDir = await makeTempDir('kimi-work-');
    const kimiHome = await makeTempDir('kimi-home-');
    const osHomeDir = await makeTempDir('kimi-os-home-');
    await writeAgentFile(
      join(kimiHome, 'agents'),
      'kimi-user.md',
      'name: kimi-user\ndescription: Kimi-specific user scope.',
    );
    await writeAgentFile(
      join(osHomeDir, '.agents', 'agents'),
      'generic-user.md',
      'name: generic-user\ndescription: Generic cross-tool scope.',
    );

    const { profiles } = discoverAgentFiles({ workDir, kimiHome, osHomeDir });

    expect(byName(profiles, 'kimi-user')?.source).toBe('user');
    expect(byName(profiles, 'generic-user')?.source).toBe('user');
  });

  it('refuses to let a discovered file replace a built-in name without override: true', async () => {
    const workDir = await makeTempDir('kimi-work-');
    const kimiHome = await makeTempDir('kimi-home-');
    const osHomeDir = await makeTempDir('kimi-os-home-');
    await writeAgentFile(
      join(workDir, '.kimi-code', 'agents'),
      'coder.md',
      'name: coder\ndescription: A plain project coder override.',
    );

    const { profiles, warnings } = discoverAgentFiles({ workDir, kimiHome, osHomeDir });

    expect(byName(profiles, 'coder')).toBeUndefined();
    expect(warnings.some((warning) => warning.includes('override: true'))).toBe(true);
  });

  it('lets a discovered file replace a built-in name when it declares override: true', async () => {
    const workDir = await makeTempDir('kimi-work-');
    const kimiHome = await makeTempDir('kimi-home-');
    const osHomeDir = await makeTempDir('kimi-os-home-');
    await writeAgentFile(
      join(workDir, '.kimi-code', 'agents'),
      'coder.md',
      'name: coder\noverride: true\ndescription: A project coder override.',
    );

    const { profiles } = discoverAgentFiles({ workDir, kimiHome, osHomeDir });

    expect(byName(profiles, 'coder')?.description).toBe('A project coder override.');
    expect(byName(profiles, 'coder')?.override).toBe(true);
  });

  it('skips a malformed discovered file with a warning instead of failing discovery', async () => {
    const workDir = await makeTempDir('kimi-work-');
    const kimiHome = await makeTempDir('kimi-home-');
    const osHomeDir = await makeTempDir('kimi-os-home-');
    const dir = join(workDir, '.kimi-code', 'agents');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'broken.md'), 'no frontmatter here\n', 'utf-8');
    await writeAgentFile(dir, 'ok.md', 'name: ok-agent\ndescription: Fine.');

    const { profiles, warnings } = discoverAgentFiles({ workDir, kimiHome, osHomeDir });

    expect(byName(profiles, 'ok-agent')).toBeDefined();
    expect(byName(profiles, 'broken')).toBeUndefined();
    expect(warnings.some((warning) => warning.includes('broken.md'))).toBe(true);
  });

  it('fails loudly when an explicit --agent-file cannot be read or parsed', async () => {
    const workDir = await makeTempDir('kimi-work-');
    const kimiHome = await makeTempDir('kimi-home-');
    const osHomeDir = await makeTempDir('kimi-os-home-');

    expect(() =>
      discoverAgentFiles({
        workDir,
        kimiHome,
        osHomeDir,
        explicitFiles: [join(workDir, 'missing-agent.md')],
      }),
    ).toThrow(/Failed to read agent file/);

    const badDir = await makeTempDir('kimi-explicit-');
    await mkdir(badDir, { recursive: true });
    const badPath = join(badDir, 'bad.md');
    await writeFile(badPath, 'no frontmatter\n', 'utf-8');
    expect(() =>
      discoverAgentFiles({ workDir, kimiHome, osHomeDir, explicitFiles: [badPath] }),
    ).toThrow(/Invalid agent file/);
  });

  it('returns nothing when no scope directory exists', async () => {
    const options = await isolatedOptions();
    const { profiles, warnings } = discoverAgentFiles(options);
    expect(profiles).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
