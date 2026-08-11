/**
 * `tools` domain — built-in GitHub tools (table-driven, v2 port).
 *
 * Thin, table-driven tool definitions over the TypeScript GitHub transport
 * (`githubRequest`). Each spec declares an LLM-facing tool: zod schema →
 * JSON-schema, the endpoint (method + path + query/body builders), and how to
 * format the response. Adding a tool = appending one entry to `GITHUB_SPECS`.
 *
 * Auth: config `[github] token` first (mirrors v1's
 * `kimiConfig.experimental.github_token`), then `GITHUB_TOKEN` / `GH_TOKEN`
 * env (resolved in the transport). When unset, the tool returns a helpful
 * error at call time. Registration is gated by the `github_tools` experimental
 * flag (same id as v1) through the contribution `when` predicate. Read-only
 * tools are listed in `GITHUB_READONLY_TOOL_NAMES` and joined into the
 * default-tool-approve policy so they run without a prompt; mutating tools are
 * excluded and therefore prompt for approval in non-auto permission modes.
 *
 * Each tool is registered via `registerAgentToolService(...)` at module load —
 * the same "import = register" pattern used by every agent tool — with one
 * Agent-scope service per tool name. Bound at Agent scope.
 */

import { z } from 'zod';

import { IConfigService } from '#/app/config/config';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tool/rule-match';
import { ToolResultBuilder } from '#/tool/result-builder';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { createDecorator } from '#/_base/di/instantiation';

import {
  GITHUB_CONFIG_SECTION,
  GITHUB_TOOLS_FLAG_ID,
} from './flag';
import { githubRequest, type GitHubRequestOptions } from './github-request';
import { IGitHubTool, type GitHubToolSpec } from './github';

// ── Reusable schema fragments ────────────────────────────────────────────────

const owner = z.string().min(1).describe('Repository owner (user or organization login).');
const repo = z.string().min(1).describe('Repository name.');
const perPage = z.number().int().min(1).max(100).optional().describe('Results per page (1–100).');
const page = z.number().int().min(1).optional().describe('Page number (1-based).');

// ── Tool base class ──────────────────────────────────────────────────────────

export interface GitHubToolDeps {
  readonly config: IConfigService;
  readonly getEnv: (name: string) => string | undefined;
  readonly fetchImpl: typeof fetch;
}

export abstract class GitHubToolBase implements IGitHubTool {
  declare readonly _serviceBrand: undefined;
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;

  protected constructor(
    private readonly spec: GitHubToolSpec,
    private readonly deps: GitHubToolDeps,
  ) {
    this.name = spec.name;
    this.description = spec.description;
    this.parameters = toInputJsonSchema(spec.schema);
  }

  resolveExecution(rawArgs: unknown): ToolExecution {
    const parsed = this.spec.schema.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        isError: true,
        output: `Invalid arguments for ${this.spec.name}: ${parsed.error.message}`,
      };
    }
    const args = parsed.data;
    const subject = this.spec.subject(args);
    return {
      accesses: ToolAccesses.none(),
      description: this.spec.name,
      approvalRule: literalRulePattern(this.spec.name, subject),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, subject),
      execute: (ctx) => this.execute(this.spec, args, ctx),
    };
  }

  private async execute(
    spec: GitHubToolSpec,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: any,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    const query = spec.query?.(args);
    const body = spec.body !== undefined ? spec.body(args) : undefined;
    const token = this.configToken();
    const options: GitHubRequestOptions = {
      ...(query !== undefined ? { query } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(spec.accept !== undefined ? { accept: spec.accept } : {}),
      ...(token !== undefined ? { token } : {}),
    };

    const res = await githubRequest(spec.method, spec.path(args), options, {
      fetchImpl: this.deps.fetchImpl,
      getEnv: this.deps.getEnv,
      signal: ctx.signal,
    });
    if (!res.ok) {
      const detail = res.body ? `\n${res.body.slice(0, 4000)}` : '';
      const status = res.status > 0 ? ` (status ${String(res.status)})` : '';
      return {
        isError: true,
        output: `${res.error ?? 'GitHub request failed'}${status}${detail}`,
      };
    }
    const builder = new ToolResultBuilder({ maxLineLength: null });
    const rate =
      typeof res.rateRemaining === 'number'
        ? `\n\n(GitHub rate limit remaining: ${String(res.rateRemaining)})`
        : '';
    builder.write((res.body || '(empty response)') + rate);
    return builder.ok();
  }

  /** Config token takes precedence; otherwise the transport falls back to env. */
  private configToken(): string | undefined {
    const token = this.deps.config.get<{ token?: string }>(GITHUB_CONFIG_SECTION)?.token;
    return token !== undefined && token.length > 0 ? token : undefined;
  }
}

/**
 * Build the Agent-tool class for one spec. The generated class injects the
 * App-scope config / bootstrap services via decorators and forwards them to
 * the shared base.
 */
export function makeGitHubToolCtor<Input extends z.ZodTypeAny>(
  spec: GitHubToolSpec<Input>,
): new (config: IConfigService, bootstrap: IBootstrapService) => GitHubToolBase {
  class GitHubAgentTool extends GitHubToolBase {
    constructor(
      @IConfigService config: IConfigService,
      @IBootstrapService bootstrap: IBootstrapService,
    ) {
      super(spec, {
        config,
        getEnv: (name) => bootstrap.getEnv(name),
        fetchImpl: globalThis.fetch.bind(globalThis),
      });
    }
  }
  return GitHubAgentTool;
}

const repoBase = (a: { owner: string; repo: string }): string => `${a.owner}/${a.repo}`;

// ── Tool specs ───────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const GITHUB_SPECS: GitHubToolSpec<any>[] = [
  // ── Repositories ──────────────────────────────────────────────────────
  {
    name: 'GitHubGetRepo',
    description: 'Get metadata for a repository (description, default branch, stars, visibility).',
    schema: z.object({ owner, repo }),
    method: 'GET',
    path: (a) => `/repos/${a.owner}/${a.repo}`,
    subject: repoBase,
  },
  {
    name: 'GitHubListBranches',
    description: 'List branches in a repository.',
    schema: z.object({ owner, repo, perPage, page }),
    method: 'GET',
    path: (a) => `/repos/${a.owner}/${a.repo}/branches`,
    query: (a) => ({ per_page: a.perPage, page: a.page }),
    subject: repoBase,
  },
  {
    name: 'GitHubListCommits',
    description: 'List commits on a repository, optionally filtered by branch/sha or path.',
    schema: z.object({
      owner,
      repo,
      sha: z.string().optional().describe('Branch name or commit SHA to start from.'),
      path: z.string().optional().describe('Only commits touching this file path.'),
      perPage,
      page,
    }),
    method: 'GET',
    path: (a) => `/repos/${a.owner}/${a.repo}/commits`,
    query: (a) => ({ sha: a.sha, path: a.path, per_page: a.perPage, page: a.page }),
    subject: repoBase,
  },
  {
    name: 'GitHubGetCommit',
    description: 'Get a single commit, including its diff stats and changed files.',
    schema: z.object({ owner, repo, ref: z.string().min(1).describe('Commit SHA, branch, or tag.') }),
    method: 'GET',
    path: (a) => `/repos/${a.owner}/${a.repo}/commits/${a.ref}`,
    subject: repoBase,
  },
  {
    name: 'GitHubGetFileContents',
    description:
      'Get a file or directory listing. File content is returned base64-encoded in the `content` field.',
    schema: z.object({
      owner,
      repo,
      path: z.string().min(1).describe('Path to the file or directory in the repo.'),
      ref: z.string().optional().describe('Branch, tag, or commit SHA (defaults to the default branch).'),
    }),
    method: 'GET',
    path: (a) => `/repos/${a.owner}/${a.repo}/contents/${a.path}`,
    query: (a) => ({ ref: a.ref }),
    subject: repoBase,
  },
  {
    name: 'GitHubCreateOrUpdateFile',
    description:
      'Create or update a file. Provide plain-text `content` (encoded to base64 automatically). Pass `sha` when updating an existing file.',
    schema: z.object({
      owner,
      repo,
      path: z.string().min(1).describe('Path to the file in the repo.'),
      message: z.string().min(1).describe('Commit message.'),
      content: z.string().describe('Plain (UTF-8) file content.'),
      branch: z.string().optional().describe('Target branch (defaults to the default branch).'),
      sha: z.string().optional().describe('Blob SHA of the file being replaced (required when updating).'),
    }),
    method: 'PUT',
    path: (a) => `/repos/${a.owner}/${a.repo}/contents/${a.path}`,
    body: (a) => ({
      message: a.message,
      content: Buffer.from(a.content, 'utf8').toString('base64'),
      branch: a.branch,
      sha: a.sha,
    }),
    mutating: true,
    subject: repoBase,
  },

  // ── Issues ────────────────────────────────────────────────────────────
  {
    name: 'GitHubListIssues',
    description: 'List issues in a repository (excludes pull requests unless combined with search).',
    schema: z.object({
      owner,
      repo,
      state: z.enum(['open', 'closed', 'all']).optional().describe('Issue state filter.'),
      labels: z.string().optional().describe('Comma-separated label names.'),
      perPage,
      page,
    }),
    method: 'GET',
    path: (a) => `/repos/${a.owner}/${a.repo}/issues`,
    query: (a) => ({ state: a.state, labels: a.labels, per_page: a.perPage, page: a.page }),
    subject: repoBase,
  },
  {
    name: 'GitHubGetIssue',
    description: 'Get a single issue by number.',
    schema: z.object({ owner, repo, issueNumber: z.number().int().describe('Issue number.') }),
    method: 'GET',
    path: (a) => `/repos/${a.owner}/${a.repo}/issues/${String(a.issueNumber)}`,
    subject: repoBase,
  },
  {
    name: 'GitHubCreateIssue',
    description: 'Create a new issue.',
    schema: z.object({
      owner,
      repo,
      title: z.string().min(1).describe('Issue title.'),
      body: z.string().optional().describe('Issue body (Markdown).'),
      labels: z.array(z.string()).optional().describe('Label names to apply.'),
      assignees: z.array(z.string()).optional().describe('User logins to assign.'),
    }),
    method: 'POST',
    path: (a) => `/repos/${a.owner}/${a.repo}/issues`,
    body: (a) => ({ title: a.title, body: a.body, labels: a.labels, assignees: a.assignees }),
    mutating: true,
    subject: repoBase,
  },
  {
    name: 'GitHubUpdateIssue',
    description: 'Update an issue (title, body, state, labels, assignees).',
    schema: z.object({
      owner,
      repo,
      issueNumber: z.number().int().describe('Issue number.'),
      title: z.string().optional(),
      body: z.string().optional(),
      state: z.enum(['open', 'closed']).optional(),
      labels: z.array(z.string()).optional(),
      assignees: z.array(z.string()).optional(),
    }),
    method: 'PATCH',
    path: (a) => `/repos/${a.owner}/${a.repo}/issues/${String(a.issueNumber)}`,
    body: (a) => ({
      title: a.title,
      body: a.body,
      state: a.state,
      labels: a.labels,
      assignees: a.assignees,
    }),
    mutating: true,
    subject: repoBase,
  },
  {
    name: 'GitHubAddIssueComment',
    description: 'Add a comment to an issue or pull request.',
    schema: z.object({
      owner,
      repo,
      issueNumber: z.number().int().describe('Issue or PR number.'),
      body: z.string().min(1).describe('Comment body (Markdown).'),
    }),
    method: 'POST',
    path: (a) => `/repos/${a.owner}/${a.repo}/issues/${String(a.issueNumber)}/comments`,
    body: (a) => ({ body: a.body }),
    mutating: true,
    subject: repoBase,
  },
  {
    name: 'GitHubListIssueComments',
    description: 'List comments on an issue or pull request.',
    schema: z.object({ owner, repo, issueNumber: z.number().int().describe('Issue or PR number.'), perPage, page }),
    method: 'GET',
    path: (a) => `/repos/${a.owner}/${a.repo}/issues/${String(a.issueNumber)}/comments`,
    query: (a) => ({ per_page: a.perPage, page: a.page }),
    subject: repoBase,
  },

  // ── Pull requests ───────────────────────────────────────────────────────
  {
    name: 'GitHubListPRs',
    description: 'List pull requests in a repository.',
    schema: z.object({
      owner,
      repo,
      state: z.enum(['open', 'closed', 'all']).optional(),
      head: z.string().optional().describe('Filter by head branch (user:ref).'),
      base: z.string().optional().describe('Filter by base branch name.'),
      perPage,
      page,
    }),
    method: 'GET',
    path: (a) => `/repos/${a.owner}/${a.repo}/pulls`,
    query: (a) => ({ state: a.state, head: a.head, base: a.base, per_page: a.perPage, page: a.page }),
    subject: repoBase,
  },
  {
    name: 'GitHubGetPR',
    description: 'Get a single pull request by number.',
    schema: z.object({ owner, repo, pullNumber: z.number().int().describe('Pull request number.') }),
    method: 'GET',
    path: (a) => `/repos/${a.owner}/${a.repo}/pulls/${String(a.pullNumber)}`,
    subject: repoBase,
  },
  {
    name: 'GitHubGetPRDiff',
    description: 'Get the unified diff for a pull request.',
    schema: z.object({ owner, repo, pullNumber: z.number().int().describe('Pull request number.') }),
    method: 'GET',
    path: (a) => `/repos/${a.owner}/${a.repo}/pulls/${String(a.pullNumber)}`,
    accept: 'application/vnd.github.diff',
    subject: repoBase,
  },
  {
    name: 'GitHubGetPRFiles',
    description: 'List the files changed in a pull request.',
    schema: z.object({ owner, repo, pullNumber: z.number().int().describe('Pull request number.'), perPage, page }),
    method: 'GET',
    path: (a) => `/repos/${a.owner}/${a.repo}/pulls/${String(a.pullNumber)}/files`,
    query: (a) => ({ per_page: a.perPage, page: a.page }),
    subject: repoBase,
  },
  {
    name: 'GitHubCreatePR',
    description: 'Open a new pull request.',
    schema: z.object({
      owner,
      repo,
      title: z.string().min(1).describe('PR title.'),
      head: z.string().min(1).describe('Source branch (or user:branch for cross-repo).'),
      base: z.string().min(1).describe('Target branch to merge into.'),
      body: z.string().optional().describe('PR description (Markdown).'),
      draft: z.boolean().optional().describe('Open as a draft PR.'),
    }),
    method: 'POST',
    path: (a) => `/repos/${a.owner}/${a.repo}/pulls`,
    body: (a) => ({ title: a.title, head: a.head, base: a.base, body: a.body, draft: a.draft }),
    mutating: true,
    subject: repoBase,
  },
  {
    name: 'GitHubUpdatePR',
    description: 'Update a pull request (title, body, state, base branch).',
    schema: z.object({
      owner,
      repo,
      pullNumber: z.number().int().describe('Pull request number.'),
      title: z.string().optional(),
      body: z.string().optional(),
      state: z.enum(['open', 'closed']).optional(),
      base: z.string().optional().describe('New base branch.'),
    }),
    method: 'PATCH',
    path: (a) => `/repos/${a.owner}/${a.repo}/pulls/${String(a.pullNumber)}`,
    body: (a) => ({ title: a.title, body: a.body, state: a.state, base: a.base }),
    mutating: true,
    subject: repoBase,
  },
  {
    name: 'GitHubMergePR',
    description: 'Merge a pull request.',
    schema: z.object({
      owner,
      repo,
      pullNumber: z.number().int().describe('Pull request number.'),
      commitTitle: z.string().optional().describe('Title for the merge commit.'),
      mergeMethod: z.enum(['merge', 'squash', 'rebase']).optional().describe('Merge strategy.'),
    }),
    method: 'PUT',
    path: (a) => `/repos/${a.owner}/${a.repo}/pulls/${String(a.pullNumber)}/merge`,
    body: (a) => ({ commit_title: a.commitTitle, merge_method: a.mergeMethod }),
    mutating: true,
    subject: repoBase,
  },
  {
    name: 'GitHubCreatePRReview',
    description: 'Submit a review on a pull request (APPROVE, REQUEST_CHANGES, or COMMENT).',
    schema: z.object({
      owner,
      repo,
      pullNumber: z.number().int().describe('Pull request number.'),
      event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']).describe('Review action.'),
      body: z.string().optional().describe('Review summary comment.'),
    }),
    method: 'POST',
    path: (a) => `/repos/${a.owner}/${a.repo}/pulls/${String(a.pullNumber)}/reviews`,
    body: (a) => ({ event: a.event, body: a.body }),
    mutating: true,
    subject: repoBase,
  },
  {
    name: 'GitHubListPRReviewComments',
    description: 'List review comments (inline code comments) on a pull request.',
    schema: z.object({ owner, repo, pullNumber: z.number().int().describe('Pull request number.'), perPage, page }),
    method: 'GET',
    path: (a) => `/repos/${a.owner}/${a.repo}/pulls/${String(a.pullNumber)}/comments`,
    query: (a) => ({ per_page: a.perPage, page: a.page }),
    subject: repoBase,
  },

  // ── Search ────────────────────────────────────────────────────────────
  {
    name: 'GitHubSearchCode',
    description: 'Search code across GitHub. Use qualifiers like `repo:owner/name`, `path:`, `language:`.',
    schema: z.object({ q: z.string().min(1).describe('Search query.'), perPage, page }),
    method: 'GET',
    path: () => '/search/code',
    query: (a) => ({ q: a.q, per_page: a.perPage, page: a.page }),
    subject: (a) => a.q,
  },
  {
    name: 'GitHubSearchRepos',
    description: 'Search repositories. Supports qualifiers like `language:`, `stars:>100`, `user:`.',
    schema: z.object({
      q: z.string().min(1).describe('Search query.'),
      sort: z.enum(['stars', 'forks', 'updated']).optional(),
      perPage,
      page,
    }),
    method: 'GET',
    path: () => '/search/repositories',
    query: (a) => ({ q: a.q, sort: a.sort, per_page: a.perPage, page: a.page }),
    subject: (a) => a.q,
  },
  {
    name: 'GitHubSearchIssues',
    description: 'Search issues and pull requests. Supports qualifiers like `repo:`, `is:pr`, `author:`, `state:`.',
    schema: z.object({
      q: z.string().min(1).describe('Search query.'),
      sort: z.enum(['comments', 'created', 'updated']).optional(),
      perPage,
      page,
    }),
    method: 'GET',
    path: () => '/search/issues',
    query: (a) => ({ q: a.q, sort: a.sort, per_page: a.perPage, page: a.page }),
    subject: (a) => a.q,
  },

  // ── Actions (read-only) ───────────────────────────────────────────────
  {
    name: 'GitHubListWorkflowRuns',
    description: 'List GitHub Actions workflow runs for a repository.',
    schema: z.object({
      owner,
      repo,
      branch: z.string().optional().describe('Filter by branch.'),
      status: z.string().optional().describe('Filter by status/conclusion (e.g. success, failure, in_progress).'),
      perPage,
      page,
    }),
    method: 'GET',
    path: (a) => `/repos/${a.owner}/${a.repo}/actions/runs`,
    query: (a) => ({ branch: a.branch, status: a.status, per_page: a.perPage, page: a.page }),
    subject: repoBase,
  },
  {
    name: 'GitHubGetWorkflowRun',
    description: 'Get a single GitHub Actions workflow run.',
    schema: z.object({ owner, repo, runId: z.number().int().describe('Workflow run id.') }),
    method: 'GET',
    path: (a) => `/repos/${a.owner}/${a.repo}/actions/runs/${String(a.runId)}`,
    subject: repoBase,
  },

  // ── Releases ──────────────────────────────────────────────────────────
  {
    name: 'GitHubListReleases',
    description: 'List releases for a repository.',
    schema: z.object({ owner, repo, perPage, page }),
    method: 'GET',
    path: (a) => `/repos/${a.owner}/${a.repo}/releases`,
    query: (a) => ({ per_page: a.perPage, page: a.page }),
    subject: repoBase,
  },
  {
    name: 'GitHubGetLatestRelease',
    description: 'Get the latest published release for a repository.',
    schema: z.object({ owner, repo }),
    method: 'GET',
    path: (a) => `/repos/${a.owner}/${a.repo}/releases/latest`,
    subject: repoBase,
  },

  // ── Viewer ────────────────────────────────────────────────────────────
  {
    name: 'GitHubGetMe',
    description: 'Get the authenticated user (verifies the configured token).',
    schema: z.object({}),
    method: 'GET',
    path: () => '/user',
    subject: () => 'me',
  },
];

/**
 * Read-only GitHub tool names — added to the default auto-approve allowlist so
 * they run without a prompt (like Read/FetchURL). Mutating tools are excluded
 * and therefore prompt for approval in non-auto permission modes.
 */
export const GITHUB_READONLY_TOOL_NAMES: readonly string[] = GITHUB_SPECS.filter(
  (spec) => spec.mutating !== true,
).map((spec) => spec.name);

/** Mutating GitHub tools (the complement of `GITHUB_READONLY_TOOL_NAMES`). */
export const GITHUB_MUTATING_TOOL_NAMES: readonly string[] = GITHUB_SPECS.filter(
  (spec) => spec.mutating === true,
).map((spec) => spec.name);

// ── Registration ─────────────────────────────────────────────────────────────

for (const spec of GITHUB_SPECS) {
  const id = createDecorator<IGitHubTool>(`gitHubTool:${spec.name}`);
  registerAgentToolService(id, makeGitHubToolCtor(spec), {
    name: spec.name,
    domain: 'github',
    when: (accessor) => accessor.get(IFlagService).enabled(GITHUB_TOOLS_FLAG_ID),
  });
}
