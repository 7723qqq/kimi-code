import type { ToolCall } from '#/kosong/contract/message';
import { describe, expect, it } from 'vitest';

import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { DefaultToolApprovePermissionPolicyService } from '#/agent/permissionPolicy/policies/default-tool-approve';
import { ToolAccesses } from '#/tool/toolContract';

const signal = new AbortController().signal;

function policyContext(toolName: string, args: unknown): ResolvedToolExecutionHookContext {
  return {
    turnId: '0',
    stepNumber: 1,
    signal,
    llm: {},
    args,
    toolCall: {
      type: 'function',
      id: `call_${toolName}`,
      name: toolName,
      arguments: JSON.stringify(args),
    } satisfies ToolCall,
    toolCalls: [
      {
        type: 'function',
        id: `call_${toolName}`,
        name: toolName,
        arguments: JSON.stringify(args),
      },
    ],
    execution: {
      accesses: ToolAccesses.none(),
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  } as unknown as ResolvedToolExecutionHookContext;
}

describe('DefaultToolApprovePermissionPolicyService', () => {
  const policy = new DefaultToolApprovePermissionPolicyService();

  it.each([
    ['Read', { path: '/workspace/notes.md' }],
    ['Grep', { pattern: 'TODO', path: '/workspace' }],
    ['Glob', { pattern: '**/*.ts', path: '/workspace' }],
    ['ReadMediaFile', { path: '/workspace/image.png' }],
    ['SetTodoList', { items: [] }],
    ['TodoList', {}],
    ['TaskList', {}],
    ['TaskOutput', { task_id: 'task_1' }],
    ['CronList', {}],
    ['WebSearch', { query: 'kimi code' }],
    ['FetchURL', { url: 'https://example.com' }],
    ['Agent', { prompt: 'review this' }],
    [
      'AgentSwarm',
      {
        description: 'Check files',
        prompt_template: 'Check {{item}}',
        items: ['a.ts', 'b.ts'],
      },
    ],
    ['AskUserQuestion', { questions: [] }],
    ['Skill', { name: 'test-skill' }],
    ['EnterPlanMode', {}],
    ['ExitPlanMode', {}],
    ['CreateGoal', { title: 'ship it' }],
    ['GetGoal', {}],
    ['SetGoalBudget', { tokenBudget: 1000 }],
    ['UpdateGoal', { status: 'complete' }],
    ['GitHubGetRepo', { owner: 'octo', repo: 'hello' }],
    ['GitHubListBranches', { owner: 'octo', repo: 'hello' }],
    ['GitHubListCommits', { owner: 'octo', repo: 'hello' }],
    ['GitHubGetCommit', { owner: 'octo', repo: 'hello', ref: 'main' }],
    ['GitHubGetFileContents', { owner: 'octo', repo: 'hello', path: 'README.md' }],
    ['GitHubListIssues', { owner: 'octo', repo: 'hello' }],
    ['GitHubGetIssue', { owner: 'octo', repo: 'hello', issueNumber: 1 }],
    ['GitHubListIssueComments', { owner: 'octo', repo: 'hello', issueNumber: 1 }],
    ['GitHubListPRs', { owner: 'octo', repo: 'hello' }],
    ['GitHubGetPR', { owner: 'octo', repo: 'hello', pullNumber: 1 }],
    ['GitHubGetPRDiff', { owner: 'octo', repo: 'hello', pullNumber: 1 }],
    ['GitHubGetPRFiles', { owner: 'octo', repo: 'hello', pullNumber: 1 }],
    ['GitHubListPRReviewComments', { owner: 'octo', repo: 'hello', pullNumber: 1 }],
    ['GitHubSearchCode', { q: 'language:ts' }],
    ['GitHubSearchRepos', { q: 'stars:>100' }],
    ['GitHubSearchIssues', { q: 'is:pr' }],
    ['GitHubListWorkflowRuns', { owner: 'octo', repo: 'hello' }],
    ['GitHubGetWorkflowRun', { owner: 'octo', repo: 'hello', runId: 1 }],
    ['GitHubListReleases', { owner: 'octo', repo: 'hello' }],
    ['GitHubGetLatestRelease', { owner: 'octo', repo: 'hello' }],
    ['GitHubGetMe', {}],
  ] as const)('approves %s', (toolName, args) => {
    expect(policy.evaluate(policyContext(toolName, args))).toEqual({ kind: 'approve' });
  });

  it.each([
    ['Bash', { command: 'printf first', timeout: 60 }],
    ['Write', { path: '/workspace/a.ts', content: 'x' }],
    ['Edit', { path: '/workspace/a.ts', old_string: 'a', new_string: 'b' }],
    ['Custom', { value: 1 }],
    ['CronCreate', { cron: '*/5 * * * *', prompt: 'ping' }],
    ['CronDelete', { id: 'job_1' }],
    ['GitHubCreateOrUpdateFile', { owner: 'octo', repo: 'hello', path: 'a.ts', message: 'm', content: 'x' }],
    ['GitHubCreateIssue', { owner: 'octo', repo: 'hello', title: 't' }],
    ['GitHubUpdateIssue', { owner: 'octo', repo: 'hello', issueNumber: 1, title: 't' }],
    ['GitHubAddIssueComment', { owner: 'octo', repo: 'hello', issueNumber: 1, body: 'b' }],
    ['GitHubCreatePR', { owner: 'octo', repo: 'hello', title: 't', head: 'h', base: 'main' }],
    ['GitHubUpdatePR', { owner: 'octo', repo: 'hello', pullNumber: 1, title: 't' }],
    ['GitHubMergePR', { owner: 'octo', repo: 'hello', pullNumber: 1 }],
    ['GitHubCreatePRReview', { owner: 'octo', repo: 'hello', pullNumber: 1, event: 'APPROVE' }],
  ] as const)('does not approve %s', (toolName, args) => {
    expect(
      policy.evaluate(policyContext(toolName, args)),
    ).toBeUndefined();
  });

  it('does not approve an unknown tool name', () => {
    expect(policy.evaluate(policyContext('UnknownTool', {}))).toBeUndefined();
  });

  it('approves Goal tools (GetGoal, SetGoalBudget, UpdateGoal)', () => {
    expect(policy.evaluate(policyContext('GetGoal', {}))).toEqual({ kind: 'approve' });
    expect(policy.evaluate(policyContext('SetGoalBudget', { tokenBudget: 1000 }))).toEqual({ kind: 'approve' });
    expect(policy.evaluate(policyContext('UpdateGoal', { status: 'complete' }))).toEqual({ kind: 'approve' });
  });
});
