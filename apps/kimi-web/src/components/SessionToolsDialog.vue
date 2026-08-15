<!-- apps/kimi-web/src/components/SessionToolsDialog.vue -->
<!-- Session tool surfaces opened from the chat header: the MCP server
     connection view (status + per-server tool list + reconnect) and the
     session's cron task set (list + create + delete). Self-contained — pulls
     everything through getKimiWebApi(), no shared client state. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { getKimiWebApi } from '../api';
import { isDaemonApiError } from '../api/errors';
import type { AppCronTask, AppMcpServer, AppMcpServerDetail, AppMcpTool } from '../api/types';
import Dialog from './ui/Dialog.vue';
import Icon from './ui/Icon.vue';
import Spinner from './ui/Spinner.vue';
import Switch from './ui/Switch.vue';

const props = defineProps<{
  /** Session whose MCP servers and cron tasks are shown. */
  sessionId?: string;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  close: [];
}>();

const { t } = useI18n();

const open = ref(false);
const emitOpen = (v: boolean) => {
  open.value = v;
  emit('update:open', v);
  if (!v) emit('close');
};

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

const servers = ref<AppMcpServer[] | null>(null);
const serversLoading = ref(false);
const serversError = ref<string | null>(null);
const reconnecting = ref<Set<string>>(new Set());
const reconnectError = ref<string | null>(null);

/** Server detail cache: name → detail (loaded on row expand). */
const serverDetails = ref<Record<string, AppMcpServerDetail | null>>({});
const detailLoading = ref<Set<string>>(new Set());
const detailError = ref<Record<string, string>>({});

async function loadServers(): Promise<void> {
  const sid = props.sessionId;
  if (!sid) return;
  serversLoading.value = true;
  serversError.value = null;
  try {
    const { servers: list } = await getKimiWebApi().listMcpServers(sid);
    servers.value = list;
  } catch (err) {
    serversError.value = isDaemonApiError(err) ? err.message : String(err);
  } finally {
    serversLoading.value = false;
  }
}

async function toggleServerDetail(server: AppMcpServer): Promise<void> {
  const sid = props.sessionId;
  if (!sid) return;
  const name = server.name;
  const current = serverDetails.value[name];
  if (current !== undefined) {
    // Toggle closed.
    const next = { ...serverDetails.value };
    delete next[name];
    serverDetails.value = next;
    return;
  }
  detailLoading.value = new Set(detailLoading.value).add(name);
  try {
    const detail = await getKimiWebApi().getMcpServerDetail(sid, name);
    serverDetails.value = { ...serverDetails.value, [name]: detail };
  } catch (err) {
    detailError.value = {
      ...detailError.value,
      [name]: isDaemonApiError(err) ? err.message : String(err),
    };
    // Keep the row collapsed on failure — a retry is one click away.
    serverDetails.value = { ...serverDetails.value, [name]: null };
  } finally {
    const rest = new Set(detailLoading.value);
    rest.delete(name);
    detailLoading.value = rest;
  }
}

async function reconnect(name: string): Promise<void> {
  const sid = props.sessionId;
  if (!sid) return;
  reconnecting.value = new Set(reconnecting.value).add(name);
  reconnectError.value = null;
  try {
    await getKimiWebApi().reconnectMcpServer(sid, name);
    await loadServers();
  } catch (err) {
    reconnectError.value = isDaemonApiError(err) ? err.message : String(err);
  } finally {
    const rest = new Set(reconnecting.value);
    rest.delete(name);
    reconnecting.value = rest;
  }
}

const MCP_STATUS_CLASS: Record<AppMcpServer['status'], string> = {
  pending: 'st-pending',
  'pending-approval': 'st-pending-approval',
  connected: 'st-connected',
  failed: 'st-failed',
  disabled: 'st-disabled',
  'needs-auth': 'st-needs-auth',
  removed: 'st-disabled',
};

function statusLabel(status: AppMcpServer['status']): string {
  switch (status) {
    case 'pending':
      return t('status.mcpStatusPending');
    case 'pending-approval':
      return t('status.mcpStatusPendingApproval');
    case 'connected':
      return t('status.mcpStatusConnected');
    case 'failed':
      return t('status.mcpStatusFailed');
    case 'disabled':
      return t('status.mcpStatusDisabled');
    case 'needs-auth':
      return t('status.mcpStatusNeedsAuth');
    case 'removed':
      return t('status.mcpStatusRemoved');
  }
}

function canReconnect(server: AppMcpServer): boolean {
  return (
    server.status === 'failed' || server.status === 'needs-auth' || server.status === 'pending'
  );
}

function toolRowKey(tool: AppMcpTool): string {
  return tool.name + '|' + tool.description;
}

// ---------------------------------------------------------------------------
// Cron tasks
// ---------------------------------------------------------------------------

const cronTasks = ref<AppCronTask[] | null>(null);
const cronLoading = ref(false);
const cronError = ref<string | null>(null);
const deletingIds = ref<Set<string>>(new Set());

// Create form
const showCronForm = ref(false);
const cronExpr = ref('');
const cronPrompt = ref('');
const cronRecurring = ref(true);
const cronSubmitting = ref(false);
const cronFormError = ref<string | null>(null);

/** Loose client-side shape check (5 fields); the daemon parser is authoritative. */
function cronExprLooksValid(expr: string): boolean {
  const trimmed = expr.trim();
  if (trimmed === '') return false;
  return trimmed.split(/\s+/).length === 5;
}

async function loadCron(): Promise<void> {
  const sid = props.sessionId;
  if (!sid) return;
  cronLoading.value = true;
  cronError.value = null;
  try {
    const { tasks } = await getKimiWebApi().listCronTasks(sid);
    cronTasks.value = tasks;
  } catch (err) {
    cronError.value = isDaemonApiError(err) ? err.message : String(err);
  } finally {
    cronLoading.value = false;
  }
}

async function submitCron(): Promise<void> {
  const sid = props.sessionId;
  if (!sid) return;
  const expr = cronExpr.value.trim();
  const prompt = cronPrompt.value.trim();
  cronFormError.value = null;
  if (!cronExprLooksValid(expr)) {
    cronFormError.value = t('status.cronExprInvalid');
    return;
  }
  if (prompt === '') {
    cronFormError.value = t('status.cronPromptRequired');
    return;
  }
  cronSubmitting.value = true;
  try {
    const created = await getKimiWebApi().createCronTask(sid, {
      cron: expr,
      prompt,
      recurring: cronRecurring.value,
    });
    cronTasks.value = [created, ...(cronTasks.value ?? [])];
    cronExpr.value = '';
    cronPrompt.value = '';
    cronRecurring.value = true;
    showCronForm.value = false;
  } catch (err) {
    cronFormError.value = isDaemonApiError(err) ? err.message : String(err);
  } finally {
    cronSubmitting.value = false;
  }
}

async function deleteCron(taskId: string): Promise<void> {
  const sid = props.sessionId;
  if (!sid) return;
  deletingIds.value = new Set(deletingIds.value).add(taskId);
  try {
    await getKimiWebApi().deleteCronTask(sid, taskId);
    cronTasks.value = (cronTasks.value ?? []).filter((task) => task.id !== taskId);
  } catch (err) {
    cronError.value = isDaemonApiError(err) ? err.message : String(err);
  } finally {
    const rest = new Set(deletingIds.value);
    rest.delete(taskId);
    deletingIds.value = rest;
  }
}

function formatNextFire(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number') return null;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function refreshAll(): void {
  void loadServers();
  void loadCron();
}

const busy = computed(() => serversLoading.value || cronLoading.value);
</script>

<template>
  <Dialog :open="open" size="lg" height="fixed" close-on-overlay @update:open="emitOpen">
    <template #head>
      <div class="st-head">
        <div>
          <div class="st-title">{{ t('status.sessionToolsTitle') }}</div>
        </div>
        <button type="button" class="st-refresh" :disabled="busy" @click="refreshAll">
          {{ t('status.mcpRefresh') }}
        </button>
      </div>
    </template>

    <div class="st-body">
      <!-- MCP servers -->
      <section class="st-sec">
        <h3 class="st-sec-title">{{ t('status.mcpTitle') }}</h3>
        <div v-if="serversLoading && servers === null" class="st-loading">
          <Spinner size="sm" />
          <span>{{ t('status.mcpLoading') }}</span>
        </div>
        <template v-else>
          <div v-if="servers && servers.length === 0" class="st-empty">
            <p>{{ t('status.mcpEmpty') }}</p>
            <p class="st-hint">{{ t('status.mcpEmptyHint') }}</p>
          </div>
          <div v-else-if="servers" class="st-list">
            <div v-for="server in servers" :key="server.name" class="st-row">
              <div
                class="st-row-main"
                role="button"
                :tabindex="0"
                @click="toggleServerDetail(server)"
                @keydown.enter="toggleServerDetail(server)"
                @keydown.space.prevent="toggleServerDetail(server)"
              >
                <div class="st-row-line1">
                  <span class="st-name" :title="server.name">{{ server.name }}</span>
                  <span class="st-transport">{{ server.transport }}</span>
                  <span class="st-tools">{{
                    t('status.mcpTools', { count: String(server.toolCount) })
                  }}</span>
                </div>
                <div v-if="server.error" class="st-row-error" :title="server.error">
                  {{ server.error }}
                </div>
              </div>
              <span class="st-badge" :class="MCP_STATUS_CLASS[server.status]">
                {{ statusLabel(server.status) }}
              </span>
              <button
                v-if="canReconnect(server)"
                type="button"
                class="st-action"
                :disabled="reconnecting.has(server.name)"
                @click="reconnect(server.name)"
              >
                {{
                  reconnecting.has(server.name)
                    ? t('status.mcpReconnecting')
                    : t('status.mcpReconnect')
                }}
              </button>
              <Icon
                class="st-chevron"
                :class="{ open: serverDetails[server.name] !== undefined }"
                name="chevron-right"
                size="sm"
              />
            </div>
            <!-- Expanded server detail: resolved tools -->
            <template v-for="server in servers" :key="'d' + server.name">
              <div v-if="serverDetails[server.name] !== undefined" class="st-detail">
                <div v-if="detailLoading.has(server.name)" class="st-loading st-inline">
                  <Spinner size="sm" />
                </div>
                <div
                  v-else-if="serverDetails[server.name] === null && detailError[server.name]"
                  class="st-error"
                >
                  {{ detailError[server.name] }}
                </div>
                <template v-else-if="serverDetails[server.name]">
                  <div
                    v-if="serverDetails[server.name]!.tools.length === 0"
                    class="st-empty st-inline"
                  >
                    {{ t('status.mcpNoTools') }}
                  </div>
                  <div v-else class="st-tools-list">
                    <div
                      v-for="tool in serverDetails[server.name]!.tools"
                      :key="toolRowKey(tool)"
                      class="st-tool"
                    >
                      <span class="st-tool-name" :title="tool.description">{{ tool.name }}</span>
                      <span class="st-tool-desc">{{ tool.description }}</span>
                    </div>
                  </div>
                </template>
              </div>
            </template>
          </div>
          <div v-if="serversError" class="st-error">{{ serversError }}</div>
          <div v-if="reconnectError" class="st-error">{{ reconnectError }}</div>
        </template>
      </section>

      <!-- Cron tasks -->
      <section class="st-sec">
        <h3 class="st-sec-title">{{ t('status.cronTitle') }}</h3>
        <div class="st-sec-tools">
          <button type="button" class="st-action" @click="showCronForm = !showCronForm">
            {{ showCronForm ? t('status.cronHideForm') : t('status.cronAdd') }}
          </button>
        </div>
        <div v-if="showCronForm" class="st-cron-form">
          <label class="st-field">
            <span class="st-field-label">{{ t('status.cronExprLabel') }}</span>
            <input
              v-model="cronExpr"
              class="st-input st-input-mono"
              type="text"
              placeholder="0 9 * * 1-5"
              @keydown.enter="submitCron"
            />
          </label>
          <label class="st-field">
            <span class="st-field-label">{{ t('status.cronPromptLabel') }}</span>
            <textarea
              v-model="cronPrompt"
              class="st-input st-textarea"
              rows="2"
              @keydown.enter.prevent="submitCron"
            />
          </label>
          <div class="st-form-row">
            <label class="st-check">
              <Switch v-model="cronRecurring" size="sm" />
              <span>{{ t('status.cronRecurringLabel') }}</span>
            </label>
            <button
              type="button"
              class="st-action st-action-primary"
              :disabled="cronSubmitting"
              @click="submitCron"
            >
              {{ cronSubmitting ? t('status.mcpLoading') : t('status.cronCreate') }}
            </button>
          </div>
          <div v-if="cronFormError" class="st-error">{{ cronFormError }}</div>
        </div>

        <div v-if="cronLoading && cronTasks === null" class="st-loading">
          <Spinner size="sm" />
          <span>{{ t('status.mcpLoading') }}</span>
        </div>
        <template v-else>
          <div v-if="cronTasks && cronTasks.length === 0" class="st-empty">
            {{ t('status.cronEmpty') }}
          </div>
          <div v-else-if="cronTasks" class="st-list">
            <div v-for="task in cronTasks" :key="task.id" class="st-row">
              <Icon name="calendar-schedule" size="sm" class="st-row-icon" />
              <div class="st-row-main">
                <div class="st-row-line1">
                  <span class="st-cron" :title="task.cron">{{ task.cron }}</span>
                  <span v-if="task.humanSchedule" class="st-transport">{{
                    task.humanSchedule
                  }}</span>
                  <span class="st-transport">{{
                    task.recurring === false ? t('status.cronOneShot') : t('status.cronRecurring')
                  }}</span>
                </div>
                <div class="st-cron-prompt" :title="task.prompt">{{ task.prompt }}</div>
                <div v-if="formatNextFire(task.nextFireAt)" class="st-cron-next">
                  {{ t('status.cronNextFire', { time: formatNextFire(task.nextFireAt)! }) }}
                </div>
              </div>
              <button
                type="button"
                class="st-action st-action-danger"
                :disabled="deletingIds.has(task.id)"
                @click="deleteCron(task.id)"
              >
                {{ t('status.cronDelete') }}
              </button>
            </div>
          </div>
          <div v-if="cronError" class="st-error">{{ cronError }}</div>
        </template>
      </section>
    </div>
  </Dialog>
</template>

<style scoped>
.st-head {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.st-title {
  font-size: var(--text-lg);
  font-weight: 500;
  color: var(--color-text);
  line-height: var(--leading-tight);
}
.st-refresh {
  flex: none;
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  padding: 3px 10px;
  cursor: pointer;
}
.st-refresh:hover:not(:disabled) {
  border-color: var(--color-line-strong);
  color: var(--color-text);
}
.st-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}

.st-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 0 0 6px;
}
.st-sec {
  min-width: 0;
}
.st-sec-title {
  margin: 0 0 8px;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
}
.st-sec-tools {
  display: flex;
  justify-content: flex-end;
  margin: -30px 0 6px;
}

.st-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 0;
  color: var(--color-text-muted);
  font-size: var(--text-base);
}
.st-inline {
  padding: 6px 0;
}
.st-empty {
  padding: 14px 0;
  color: var(--color-text-faint);
  font-size: var(--text-base);
}
.st-hint {
  margin: 6px 0 0;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  max-width: 480px;
  line-height: 1.5;
}
.st-error {
  padding: 8px 0;
  color: var(--color-danger);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}

.st-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.st-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  min-width: 0;
}
.st-row + .st-row {
  border-top: 1px solid var(--color-line);
}
.st-row-icon {
  flex: none;
  color: var(--color-text-faint);
}
.st-row-main {
  flex: 1;
  min-width: 0;
}
.st-row > .st-row-main[role='button'] {
  cursor: pointer;
  border-radius: var(--radius-xs);
  padding: 1px 2px;
  outline: none;
}
.st-row > .st-row-main[role='button']:hover {
  background: var(--color-surface-sunken);
}
.st-row > .st-row-main[role='button']:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -1px;
}
.st-row-line1 {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.st-name {
  font-family: var(--font-mono);
  font-size: var(--text-base);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.st-cron {
  font-family: var(--font-mono);
  font-size: var(--text-base);
  color: var(--color-text);
}
.st-transport {
  flex: none;
  font-family: var(--font-mono);
  font-size: calc(var(--text-xs) - 1px);
  color: var(--color-text-faint);
  white-space: nowrap;
}
.st-tools {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.st-row-error {
  margin-top: 2px;
  font-size: var(--text-xs);
  color: var(--color-danger);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.st-cron-prompt {
  margin-top: 2px;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.st-cron-next {
  margin-top: 2px;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}

.st-chevron {
  flex: none;
  color: var(--color-text-faint);
  transition: transform 0.12s;
}
.st-chevron.open {
  transform: rotate(90deg);
}

/* Expanded server detail: resolved tools */
.st-detail {
  padding: 2px 12px 10px 34px;
  border-top: 1px solid var(--color-line);
}
.st-tools-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.st-tool {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 3px 8px;
  border-radius: var(--radius-xs);
  min-width: 0;
}
.st-tool:hover {
  background: var(--color-surface-sunken);
}
.st-tool-name {
  flex: none;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text);
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.st-tool-desc {
  flex: 1;
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.st-badge {
  flex: none;
  font-size: calc(var(--text-xs) - 1px);
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--color-line);
  color: var(--color-text-muted);
  background: var(--color-surface-sunken);
}
.st-badge.st-connected {
  color: var(--color-success);
  border-color: var(--color-success-bd);
  background: var(--color-success-soft);
}
.st-badge.st-failed {
  color: var(--color-danger);
  border-color: var(--color-danger-bd);
  background: var(--color-danger-soft);
}
.st-badge.st-pending-approval {
  color: var(--color-warning);
  border-color: color-mix(in srgb, var(--color-warning) 30%, var(--color-line));
  background: color-mix(in srgb, var(--color-warning) 10%, transparent);
}
.st-badge.st-needs-auth {
  color: var(--color-warning);
  border-color: color-mix(in srgb, var(--color-warning) 30%, var(--color-line));
  background: color-mix(in srgb, var(--color-warning) 10%, transparent);
}
.st-badge.st-pending {
  color: var(--color-text-muted);
}
.st-badge.st-disabled {
  color: var(--color-text-faint);
}

.st-action {
  flex: none;
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  padding: 2px 10px;
  cursor: pointer;
}
.st-action:hover:not(:disabled) {
  border-color: var(--color-line-strong);
  color: var(--color-text);
}
.st-action:disabled {
  opacity: 0.5;
  cursor: default;
}
.st-action-primary {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-bg);
}
.st-action-primary:hover:not(:disabled) {
  background: var(--color-accent-hover);
  border-color: var(--color-accent-hover);
  color: var(--color-bg);
}
.st-action-danger {
  color: var(--color-danger);
}
.st-action-danger:hover:not(:disabled) {
  border-color: var(--color-danger-bd);
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

/* Cron create form */
.st-cron-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
}
.st-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.st-field-label {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.st-input {
  background: var(--color-bg);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-xs);
  color: var(--color-text);
  font-size: var(--text-base);
  padding: 5px 8px;
  outline: none;
}
.st-input:focus {
  border-color: var(--color-accent);
}
.st-input-mono {
  font-family: var(--font-mono);
}
.st-textarea {
  resize: vertical;
  font-family: var(--font-ui);
}
.st-form-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.st-check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  cursor: pointer;
}
</style>
