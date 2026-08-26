/**
 * TUI2 approval adapter — mirrors the v1 regression coverage
 * (test/tui/reverse-rpc/approval-adapter.test.ts) for the tui2 module.
 *
 * The Bash-gate case pins the v1 semantics the tui2 adapter had dropped:
 * only `toolName === 'Bash'` gets shell styling + danger scanning, so an
 * MCP tool that legitimately carries a `command` arg is never rendered as
 * a shell block.
 */

import { describe, expect, it } from 'vitest'

import { adaptApprovalRequest } from '@/tui2/reverse-rpc/approval/adapter'

describe('approval adapter', () => {
  it('renders a shell block with danger scanning for Bash generic args', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-1',
      toolName: 'Bash',
      action: 'run',
      display: {
        kind: 'generic',
        summary: 'run',
        detail: {
          command: 'sudo rm -rf /tmp/cache',
          cwd: '/tmp',
        },
      },
    });

    expect(adapted.display).toEqual([
      {
        type: 'shell',
        language: 'bash',
        command: 'sudo rm -rf /tmp/cache',
        cwd: '/tmp',
        danger: 'recursive delete',
      },
    ]);
  });

  // MCP tools can legitimately own a `command` arg of their own; only the
  // builtin shell family is rendered as a shell block with danger scanning.
  it('does not render a shell block or danger label when an MCP tool args contain command', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-mcp-command',
      toolName: 'mcp__example__deploy',
      action: 'deploy',
      display: {
        kind: 'generic',
        summary: 'deploy',
        detail: {
          command: 'sudo rm -rf /tmp/cache',
          cwd: '/tmp',
        },
      },
    });

    expect(adapted.display).toEqual([]);
  });

  it('emits a diff block for Edit old_string/new_string args', () => {
    const adapted = adaptApprovalRequest({
      toolCallId: 'tc-edit',
      toolName: 'Edit',
      action: 'edit',
      display: {
        kind: 'generic',
        summary: 'edit',
        detail: {
          file_path: 'src/foo.ts',
          old_string: 'a\nb\nc',
          new_string: 'a\nB\nc',
        },
      },
    });

    expect(adapted.display).toEqual([
      { type: 'diff', path: 'src/foo.ts', old_text: 'a\nb\nc', new_text: 'a\nB\nc' },
    ]);
  });
});
