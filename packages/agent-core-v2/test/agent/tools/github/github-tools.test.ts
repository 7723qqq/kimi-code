import { afterEach, describe, expect, it, vi } from 'vitest';

import { getAgentToolContributions } from '#/agent/toolRegistry/toolContribution';
import { GITHUB_CONFIG_SECTION, GITHUB_TOOLS_FLAG_ID } from '#/agent/tools/github/flag';
import { GITHUB_NO_TOKEN_ERROR } from '#/agent/tools/github/github-request';
import type { GitHubToolBase } from '#/agent/tools/github/github-tools';
import {
  GITHUB_MUTATING_TOOL_NAMES,
  GITHUB_READONLY_TOOL_NAMES,
  GITHUB_SPECS,
  makeGitHubToolCtor,
} from '#/agent/tools/github/github-tools';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IConfigService } from '#/app/config/config';
import { getConfigSectionContributions } from '#/app/config/configSectionContributions';
import { getContributedFlags } from '#/app/flag/flagRegistry';
import type { ExecutableToolContext } from '#/tool/toolContract';

const EXPECTED_TOOL_COUNT = 34;
const EXPECTED_READONLY_COUNT = 22;
const EXPECTED_MUTATING_COUNT = 12;

function ctx(): ExecutableToolContext {
  return { turnId: 0, toolCallId: 'call_github', signal: new AbortController().signal };
}

function makeTool(
  name: string,
  deps?: {
    token?: string;
    getEnv?: (envName: string) => string | undefined;
  },
): GitHubToolBase {
  const spec = GITHUB_SPECS.find((entry) => entry.name === name);
  if (spec === undefined) throw new Error(`no spec for ${name}`);
  const config = {
    _serviceBrand: undefined,
    get: (domain: string) =>
      domain === GITHUB_CONFIG_SECTION && deps?.token !== undefined
        ? { token: deps.token }
        : undefined,
  } as unknown as IConfigService;
  const bootstrap = {
    _serviceBrand: undefined,
    getEnv: deps?.getEnv ?? (() => undefined),
  } as unknown as IBootstrapService;
  return new (makeGitHubToolCtor(spec))(config, bootstrap);
}

function mockFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchImpl = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitHub tool table', () => {
  it('registers all GitHub tools with the flag gate', () => {
    const names = getAgentToolContributions()
      .filter((record) => record.options.name.startsWith('GitHub'))
      .map((record) => record.options.name);
    expect(names).toHaveLength(EXPECTED_TOOL_COUNT);
    expect(new Set(names).size).toBe(EXPECTED_TOOL_COUNT);
    expect(names).toEqual(GITHUB_SPECS.map((spec) => spec.name));
  });

  it('splits readonly and mutating tools like v1', () => {
    expect(GITHUB_READONLY_TOOL_NAMES).toHaveLength(EXPECTED_READONLY_COUNT);
    expect(GITHUB_MUTATING_TOOL_NAMES).toHaveLength(EXPECTED_MUTATING_COUNT);
    const all = [...GITHUB_READONLY_TOOL_NAMES, ...GITHUB_MUTATING_TOOL_NAMES];
    expect(new Set(all).size).toBe(EXPECTED_TOOL_COUNT);
    expect(all.toSorted()).toEqual(GITHUB_SPECS.map((spec) => spec.name).toSorted());
    expect(GITHUB_MUTATING_TOOL_NAMES.toSorted()).toEqual(
      [
        'GitHubCreateOrUpdateFile',
        'GitHubCreateBranch',
        'GitHubCreateCommit',
        'GitHubCreateIssue',
        'GitHubCreateTree',
        'GitHubUpdateIssue',
        'GitHubUpdateRef',
        'GitHubAddIssueComment',
        'GitHubCreatePR',
        'GitHubUpdatePR',
        'GitHubMergePR',
        'GitHubCreatePRReview',
      ].toSorted(),
    );
  });

  it('gates activation on the github_tools flag', () => {
    const records = getAgentToolContributions().filter((record) =>
      record.options.name.startsWith('GitHub'),
    );
    expect(records.length).toBe(EXPECTED_TOOL_COUNT);
    for (const record of records) {
      expect(record.options.when).toBeDefined();
      const enabled = { enabled: (id: string) => id === GITHUB_TOOLS_FLAG_ID };
      expect(record.options.when?.({ get: () => enabled } as never)).toBe(true);
      const disabled = { enabled: () => false };
      expect(record.options.when?.({ get: () => disabled } as never)).toBe(false);
    }
  });

  it('registers the github_tools flag and the [github] config section', () => {
    expect(getContributedFlags().some((flag) => flag.id === GITHUB_TOOLS_FLAG_ID)).toBe(true);
    expect(
      getConfigSectionContributions().some((section) => section.domain === GITHUB_CONFIG_SECTION),
    ).toBe(true);
  });
});

describe('GitHub tool execution', () => {
  it('rejects invalid arguments with the v1 error format', () => {
    const tool = makeTool('GitHubGetRepo');
    const execution = tool.resolveExecution({ owner: '' });

    expect(execution.isError).toBe(true);
    if (execution.isError !== true) return;
    expect(execution.output).toContain('Invalid arguments for GitHubGetRepo:');
  });

  it('builds the approval rule from the repo subject', () => {
    const tool = makeTool('GitHubGetRepo');
    const execution = tool.resolveExecution({ owner: 'octo', repo: 'hello' });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.approvalRule).toBe('GitHubGetRepo(octo/hello)');
    expect(execution.matchesRule?.('octo/hello')).toBe(true);
    expect(execution.matchesRule?.('other/repo')).toBe(false);
    expect(execution.matchesRule?.('octo/*')).toBe(true);
  });

  it('uses the search query as the subject for search tools', () => {
    const tool = makeTool('GitHubSearchCode');
    const execution = tool.resolveExecution({ q: 'repo:octo/hello language:ts' });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.approvalRule).toBe('GitHubSearchCode(repo:octo/hello language:ts)');
  });

  it('returns the response body and rate-limit note on success', async () => {
    const fetchImpl = mockFetch(
      jsonResponse({ full_name: 'octo/hello', stargazers_count: 3 }, 200, {
        'x-ratelimit-remaining': '4871',
      }),
    );
    const tool = makeTool('GitHubGetRepo', {
      getEnv: (name) => (name === 'GITHUB_TOKEN' ? 'ghp_t' : undefined),
    });

    const execution = tool.resolveExecution({ owner: 'octo', repo: 'hello' });
    if (execution.isError === true) throw new Error('expected runnable execution');
    const result = await execution.execute(ctx());

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('"full_name":"octo/hello"');
    expect(result.output).toContain('(GitHub rate limit remaining: 4871)');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/octo/hello');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer ghp_t' });
  });

  it('formats API errors like v1 (error + status + body)', async () => {
    mockFetch(jsonResponse({ message: 'Not Found' }, 404));
    const tool = makeTool('GitHubGetRepo', {
      getEnv: (name) => (name === 'GITHUB_TOKEN' ? 'ghp_t' : undefined),
    });

    const execution = tool.resolveExecution({ owner: 'octo', repo: 'missing' });
    if (execution.isError === true) throw new Error('expected runnable execution');
    const result = await execution.execute(ctx());

    expect(result.isError).toBe(true);
    expect(result.output).toBe('GitHub API error 404 (status 404)\n{"message":"Not Found"}');
  });

  it('returns the no-token error without a request', async () => {
    const fetchImpl = mockFetch(jsonResponse({}));
    const tool = makeTool('GitHubGetRepo');

    const execution = tool.resolveExecution({ owner: 'octo', repo: 'hello' });
    if (execution.isError === true) throw new Error('expected runnable execution');
    const result = await execution.execute(ctx());

    expect(result.isError).toBe(true);
    expect(result.output).toBe(GITHUB_NO_TOKEN_ERROR);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('prefers the config token over the environment', async () => {
    const fetchImpl = mockFetch(jsonResponse({}));
    const tool = makeTool('GitHubGetRepo', {
      token: 'ghp_config',
      getEnv: (name) => (name === 'GITHUB_TOKEN' ? 'ghp_env' : undefined),
    });

    const execution = tool.resolveExecution({ owner: 'octo', repo: 'hello' });
    if (execution.isError === true) throw new Error('expected runnable execution');
    await execution.execute(ctx());

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer ghp_config' });
  });

  it('base64-encodes file content for GitHubCreateOrUpdateFile', async () => {
    const fetchImpl = mockFetch(jsonResponse({}));
    const tool = makeTool('GitHubCreateOrUpdateFile', {
      getEnv: (name) => (name === 'GITHUB_TOKEN' ? 'ghp_t' : undefined),
    });

    const execution = tool.resolveExecution({
      owner: 'octo',
      repo: 'hello',
      path: 'README.md',
      message: 'add readme',
      content: 'hello world',
      branch: 'main',
    });
    if (execution.isError === true) throw new Error('expected runnable execution');
    await execution.execute(ctx());

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/octo/hello/contents/README.md');
    expect(JSON.parse(init.body as string)).toEqual({
      message: 'add readme',
      content: Buffer.from('hello world', 'utf8').toString('base64'),
      branch: 'main',
      sha: undefined,
    });
  });

  it('resolves a ref with the Git Data URL shape', async () => {
    const fetchImpl = mockFetch(jsonResponse({ object: { sha: 'abc' } }));
    const tool = makeTool('GitHubGetRef', {
      getEnv: (name) => (name === 'GITHUB_TOKEN' ? 'ghp_t' : undefined),
    });

    const execution = tool.resolveExecution({ owner: 'octo', repo: 'hello', ref: 'heads/main' });
    if (execution.isError === true) throw new Error('expected runnable execution');
    await execution.execute(ctx());

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/octo/hello/git/ref/heads/main');
    expect(init.method).toBe('GET');
  });

  it('creates trees and commits via the Git Data API', async () => {
    const fetchImpl = mockFetch(jsonResponse({}));
    const env = { getEnv: (name: string) => (name === 'GITHUB_TOKEN' ? 'ghp_t' : undefined) };

    const tree = makeTool('GitHubCreateTree', env);
    const treeExecution = tree.resolveExecution({
      owner: 'octo',
      repo: 'hello',
      baseTree: 'base_sha',
      tree: [{ path: 'README.md', content: 'hello world' }],
    });
    if (treeExecution.isError === true) throw new Error('expected runnable execution');
    await treeExecution.execute(ctx());

    const [treeUrl, treeInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(treeUrl).toBe('https://api.github.com/repos/octo/hello/git/trees');
    expect(JSON.parse(treeInit.body as string)).toEqual({
      base_tree: 'base_sha',
      tree: [{ path: 'README.md', content: 'hello world' }],
    });

    const commit = makeTool('GitHubCreateCommit', env);
    const commitExecution = commit.resolveExecution({
      owner: 'octo',
      repo: 'hello',
      message: 'add readme',
      tree: 'tree_sha',
      parents: ['parent_sha'],
    });
    if (commitExecution.isError === true) throw new Error('expected runnable execution');
    await commitExecution.execute(ctx());

    const [, commitInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(commitInit.body as string)).toEqual({
      message: 'add readme',
      tree: 'tree_sha',
      parents: ['parent_sha'],
    });
  });

  it('updates refs and creates branches via the Git Data API', async () => {
    const fetchImpl = mockFetch(jsonResponse({}));
    const env = { getEnv: (name: string) => (name === 'GITHUB_TOKEN' ? 'ghp_t' : undefined) };

    const update = makeTool('GitHubUpdateRef', env);
    const updateExecution = update.resolveExecution({
      owner: 'octo',
      repo: 'hello',
      ref: 'heads/main',
      sha: 'new_sha',
      force: true,
    });
    if (updateExecution.isError === true) throw new Error('expected runnable execution');
    await updateExecution.execute(ctx());

    const [updateUrl, updateInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(updateUrl).toBe('https://api.github.com/repos/octo/hello/git/refs/heads/main');
    expect(updateInit.method).toBe('PATCH');
    expect(JSON.parse(updateInit.body as string)).toEqual({ sha: 'new_sha', force: true });

    const branch = makeTool('GitHubCreateBranch', env);
    const branchExecution = branch.resolveExecution({
      owner: 'octo',
      repo: 'hello',
      branch: 'feature',
      sha: 'new_sha',
    });
    if (branchExecution.isError === true) throw new Error('expected runnable execution');
    await branchExecution.execute(ctx());

    const [branchUrl, branchInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(branchUrl).toBe('https://api.github.com/repos/octo/hello/git/refs');
    expect(branchInit.method).toBe('POST');
    expect(JSON.parse(branchInit.body as string)).toEqual({
      ref: 'refs/heads/feature',
      sha: 'new_sha',
    });
  });

  it('sends the diff accept header for GitHubGetPRDiff', async () => {
    const fetchImpl = mockFetch(new Response('diff --git a/x b/x', { status: 200 }));
    const tool = makeTool('GitHubGetPRDiff', {
      getEnv: (name) => (name === 'GITHUB_TOKEN' ? 'ghp_t' : undefined),
    });

    const execution = tool.resolveExecution({ owner: 'octo', repo: 'hello', pullNumber: 1 });
    if (execution.isError === true) throw new Error('expected runnable execution');
    await execution.execute(ctx());

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Accept: 'application/vnd.github.diff' });
    expect(init.method).toBe('GET');
  });

  it('emits "(empty response)" for an empty success body', async () => {
    mockFetch(new Response('', { status: 200 }));
    const tool = makeTool('GitHubGetMe', {
      getEnv: (name) => (name === 'GITHUB_TOKEN' ? 'ghp_t' : undefined),
    });

    const execution = tool.resolveExecution({});
    if (execution.isError === true) throw new Error('expected runnable execution');
    const result = await execution.execute(ctx());

    expect(result.output).toBe('(empty response)');
  });
});
