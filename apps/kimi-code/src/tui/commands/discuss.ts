import { t } from '#/i18n';

import { getLlmNotSetMessage, getNoActiveSessionMessage } from '../constant/kimi-tui';
import type { SlashCommandHost } from './dispatch';

/**
 * Parse `/discuss <topic> with <role1>,<role2>,...`
 *
 * Returns `{ topic, roles }` or an error string.
 */
function parseDiscussArgs(args: string): { topic: string; roles: string[] } | string {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return 'Usage: /discuss <topic> with <role1>,<role2>,...';
  }

  // Split on " with " (case-insensitive)
  const match = trimmed.match(/^(.+?)\s+with\s+(.+)$/i);
  if (match === null) {
    // No "with" found — treat the whole thing as a topic with default roles
    return { topic: trimmed, roles: ['researcher', 'architect', 'engineer'] };
  }

  const topic = match[1]!.trim();
  const roles = match[2]!.split(',').map((r) => r.trim()).filter(Boolean);

  if (topic.length === 0) {
    return 'Please provide a discussion topic.';
  }
  if (roles.length < 2) {
    return 'Please specify at least 2 roles for the discussion.';
  }

  return { topic, roles };
}

export async function handleDiscussCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  if (host.session === undefined) {
    host.showError(getNoActiveSessionMessage());
    return;
  }

  if (host.state.appState.model.trim().length === 0) {
    host.showError(getLlmNotSetMessage());
    return;
  }

  const parsed = parseDiscussArgs(args);
  if (typeof parsed === 'string') {
    host.showError(parsed);
    return;
  }

  const { topic, roles } = parsed;

  // Enable swarm mode so SwarmDiscussion can auto-approve
  try {
    await host.requireSession().setSwarmMode(true, 'task');
  } catch (error) {
    host.showError(t('tui.messages.discussSwarmEnableFailed', { error: String(error) }));
    return;
  }
  host.setAppState({ swarmMode: true });

  // Build participant configs
  const participants = roles.map((role) => {
    const safeName = role.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_');
    return `{ profileName: "coder", roleDescription: "You are a ${role} participating in a roundtable discussion." }`;
  }).join(',\n      ');

  const prompt = [
    `Start a roundtable discussion on the following topic:`,
    ``,
    `Topic: ${topic}`,
    ``,
    `Participants: ${roles.join(', ')}`,
    ``,
    `Participant configs:`,
    `      ${participants}`,
    ``,
    `Use the SwarmDiscussion tool to start this discussion. `,
    `Pass the topic, participants with their role descriptions, `,
    `and set maxRounds to ${Math.max(3, roles.length)}.`,
  ].join('\n');

  host.sendNormalUserInput(prompt);
}