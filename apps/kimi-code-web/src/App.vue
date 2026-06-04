<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { Event, Session } from '@moonshot-ai/kimi-code-sdk/browser';

import { createKimiWebHarness } from '#/harness';

type WebMessageRole = 'user' | 'assistant' | 'system';

type MutableWebMessage = {
  id: string;
  role: WebMessageRole;
  text: string;
};

const workDir = __KIMI_CODE_WEB_WORK_DIR__;
const PRODUCT_NAME = 'Kimi Code';
const WEB_UI_MODE = 'web';
const sessionId = ref<string>();
const model = ref<string>();
const busy = ref(false);
const error = ref<string>();
const messages = ref<MutableWebMessage[]>([]);
const input = ref('');

let sequence = 0;
let activeTurnId: number | undefined;
let activeAssistantMessageId: string | undefined;
let session: Session | undefined;
let sessionUnsubscribe: (() => void) | undefined;

const harness = createKimiWebHarness();

onMounted(async () => {
  await loadConfig();
});

onBeforeUnmount(() => {
  sessionUnsubscribe?.();
  void harness.close();
});

async function loadConfig(): Promise<void> {
  try {
    const config = await harness.getConfig();
    model.value = config.defaultModel;
  } catch (loadError) {
    fail(errorMessage(loadError));
  }
}

async function submit(): Promise<void> {
  const text = input.value.trim();
  if (text.length === 0 || busy.value) return;

  input.value = '';
  error.value = undefined;
  appendMessage('user', text);
  busy.value = true;
  activeTurnId = undefined;
  activeAssistantMessageId = undefined;

  try {
    const activeSession = await ensureSession();
    await activeSession.prompt(text);
  } catch (submitError) {
    fail(errorMessage(submitError));
  }
}

async function cancel(): Promise<void> {
  if (session === undefined) return;

  try {
    await session.cancel();
  } catch (cancelError) {
    fail(errorMessage(cancelError));
  }
}

async function ensureSession(): Promise<Session> {
  if (session !== undefined) return session;

  session = await harness.createSession({
    workDir,
    model: model.value,
    metadata: {
      uiMode: WEB_UI_MODE,
    },
  });
  sessionId.value = session.id;
  session.setApprovalHandler(async (request) => {
    appendMessage('system', `Approval request cancelled: ${request.toolName}`);
    return {
      decision: 'cancelled',
      feedback: 'Kimi Code Web does not implement approval UI yet.',
    };
  });
  session.setQuestionHandler(async (request) => {
    appendMessage('system', `Question request ignored: ${String(request.questions.length)}`);
    return null;
  });
  sessionUnsubscribe = session.onEvent(handleEvent);

  const status = await session.getStatus();
  model.value = status.model ?? model.value;
  return session;
}

function handleEvent(event: Event): void {
  if (sessionId.value !== undefined && event.sessionId !== sessionId.value) return;

  switch (event.type) {
    case 'turn.started':
      busy.value = true;
      activeTurnId = event.turnId;
      break;
    case 'assistant.delta':
      if (isActiveTurn(event.turnId)) {
        appendAssistantDelta(event.delta);
      }
      break;
    case 'tool.call.started':
      if (isActiveTurn(event.turnId)) {
        appendMessage('system', `Tool: ${event.name}`);
      }
      break;
    case 'tool.result':
      if (isActiveTurn(event.turnId)) {
        appendMessage('system', `Tool result: ${plainToolResult(event.output)}`);
      }
      break;
    case 'turn.ended':
      if (isActiveTurn(event.turnId)) {
        busy.value = false;
        activeTurnId = undefined;
        activeAssistantMessageId = undefined;
      }
      break;
    case 'agent.status.updated':
      model.value = event.model ?? model.value;
      break;
    case 'error':
      fail(`${event.code}: ${event.message}`);
      break;
    case 'warning':
      appendMessage('system', `Warning: ${event.message}`);
      break;
    case 'session.meta.updated':
    case 'thinking.delta':
    case 'hook.result':
    case 'skill.activated':
    case 'turn.step.started':
    case 'turn.step.completed':
    case 'turn.step.retrying':
    case 'turn.step.interrupted':
    case 'tool.call.delta':
    case 'tool.progress':
    case 'tool.list.updated':
    case 'mcp.server.status':
    case 'subagent.spawned':
    case 'subagent.completed':
    case 'subagent.failed':
    case 'compaction.started':
    case 'compaction.blocked':
    case 'compaction.cancelled':
    case 'compaction.completed':
    case 'background.task.started':
    case 'background.task.terminated':
    case 'cron.fired':
      break;
  }
}

function isActiveTurn(turnId: number): boolean {
  return activeTurnId === undefined || activeTurnId === turnId;
}

function appendAssistantDelta(delta: string): void {
  if (activeAssistantMessageId === undefined) {
    const message = appendMessage('assistant', '');
    activeAssistantMessageId = message.id;
  }
  const message = messages.value.find((item) => item.id === activeAssistantMessageId);
  if (message === undefined) return;
  message.text += delta;
}

function appendMessage(role: WebMessageRole, text: string): MutableWebMessage {
  const message: MutableWebMessage = {
    id: `msg-${String(++sequence)}`,
    role,
    text,
  };
  messages.value.push(message);
  return message;
}

function fail(message: string): void {
  error.value = message;
  busy.value = false;
  activeTurnId = undefined;
  activeAssistantMessageId = undefined;
  appendMessage('system', `Error: ${message}`);
}

function plainToolResult(result: unknown): string {
  if (typeof result === 'string') return truncate(result);
  if (result === null || result === undefined) return '';
  try {
    return truncate(JSON.stringify(result));
  } catch {
    return truncate(String(result));
  }
}

function truncate(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 500) return trimmed;
  return `${trimmed.slice(0, 500)}...`;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
</script>

<template>
  <main>
    <h1>{{ PRODUCT_NAME }}</h1>
    <p>Workdir: {{ workDir }}</p>
    <p v-if="sessionId">Session: {{ sessionId }}</p>
    <p v-if="model">Model: {{ model }}</p>
    <p v-if="error">Error: {{ error }}</p>

    <form @submit.prevent="submit">
      <textarea v-model="input" rows="6" cols="80" :disabled="busy"></textarea>
      <br />
      <button type="submit" :disabled="busy || input.trim().length === 0">Send</button>
      <button type="button" :disabled="!busy" @click="cancel">Cancel</button>
    </form>

    <section>
      <article v-for="message in messages" :key="message.id">
        <strong>{{ message.role }}</strong>
        <pre>{{ message.text }}</pre>
      </article>
    </section>
  </main>
</template>
