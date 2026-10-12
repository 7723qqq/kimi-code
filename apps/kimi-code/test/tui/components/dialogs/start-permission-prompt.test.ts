import { describe, expect, it, vi } from 'vitest';

import { GoalStartPermissionPromptComponent } from '#/tui/components/dialogs/goal-start-permission-prompt';
import { SwarmStartPermissionPromptComponent } from '#/tui/components/dialogs/swarm-start-permission-prompt';
import type { GoalStartPermissionChoice } from '#/tui/components/dialogs/goal-start-permission-prompt';
import type { SwarmStartPermissionChoice } from '#/tui/components/dialogs/swarm-start-permission-prompt';

const ENTER = '\r';

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('start permission prompt initial highlight', () => {
  it('keeps Always Ask on Enter for a manual-mode goal', () => {
    const onSelect = vi.fn<(choice: GoalStartPermissionChoice) => void>();
    const component = new GoalStartPermissionPromptComponent({
      mode: 'manual',
      onSelect,
      onCancel: vi.fn(),
    });

    component.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledWith('manual');
  });

  it('keeps YOLO on Enter for a yolo-mode goal', () => {
    const onSelect = vi.fn<(choice: GoalStartPermissionChoice) => void>();
    const component = new GoalStartPermissionPromptComponent({
      mode: 'yolo',
      onSelect,
      onCancel: vi.fn(),
    });

    component.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledWith('yolo');
  });

  it('keeps Always Ask on Enter for a swarm start', () => {
    const onSelect = vi.fn<(choice: SwarmStartPermissionChoice) => void>();
    const component = new SwarmStartPermissionPromptComponent({
      onSelect,
      onCancel: vi.fn(),
    });

    component.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledWith('manual');
  });

  it('renders the current mode as the highlighted first row', () => {
    const component = new GoalStartPermissionPromptComponent({
      mode: 'manual',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const rendered = stripAnsi(component.render(80).join('\n'));
    const lines = rendered.split('\n');
    const highlightedIndex = lines.findIndex((line) => line.includes('\u276F '));

    expect(highlightedIndex).toBeGreaterThan(-1);
    expect(lines[highlightedIndex]).toContain('Always Ask');
    // Never Ask stays the first row — the highlight moved, the order did not.
    const firstOptionIndex = lines.findIndex((line) => line.trim().length > 0 && line.includes('Never Ask'));
    expect(firstOptionIndex).toBeLessThan(highlightedIndex);
  });

  it('still reaches Never Ask after moving the cursor', () => {
    const onSelect = vi.fn<(choice: GoalStartPermissionChoice) => void>();
    const component = new GoalStartPermissionPromptComponent({
      mode: 'manual',
      onSelect,
      onCancel: vi.fn(),
    });

    // Options are Never Ask / YOLO / Always Ask, so the highlight starts on
    // the third row and two steps up reach the permissive choice.
    component.handleInput('\u001B[A'); // Always Ask -> YOLO
    component.handleInput('\u001B[A'); // YOLO -> Never Ask
    component.handleInput(ENTER);

    expect(onSelect).toHaveBeenCalledWith('auto');
  });
});
