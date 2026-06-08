<!-- apps/kimi-web/src/components/WorkspaceRail.vue -->
<!-- Variant B workspace rail: a narrow (~52px) vertical column of workspace -->
<!-- chips, an add-workspace button, and (at the bottom) the account avatar with -->
<!-- its popover. Light only, monospace-forward, Kimi blue #1565C0, no emoji. -->
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { WorkspaceView } from '../types';
import LanguageSwitcher from './LanguageSwitcher.vue';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    workspaces: WorkspaceView[];
    activeId: string | null;
    attentionByWorkspace?: Record<string, number>;
    authReady?: boolean;
    accountModel?: string | null;
    /** Expanded (wide, named) rail vs collapsed (52px icon) rail. */
    expanded?: boolean;
  }>(),
  {
    activeId: null,
    attentionByWorkspace: () => ({}),
    authReady: false,
    accountModel: null,
    expanded: false,
  },
);

const emit = defineEmits<{
  select: [workspaceId: string];
  addWorkspace: [];
  login: [];
  logout: [];
  toggleExpand: [];
}>();

/** First letter of a workspace name, uppercased, for the chip glyph. */
function initial(w: WorkspaceView): string {
  const ch = (w.name || w.root).trim().charAt(0);
  return ch ? ch.toUpperCase() : '·';
}

/** Tooltip = full name + root path. */
function chipTitle(w: WorkspaceView): string {
  return `${w.name}\n${w.root}`;
}

function attentionFor(id: string): number {
  return props.attentionByWorkspace[id] ?? 0;
}

// ---------------------------------------------------------------------------
// Account popover (bottom of the rail)
// ---------------------------------------------------------------------------
const acctMenuOpen = ref(false);

function toggleAccount(): void {
  acctMenuOpen.value = !acctMenuOpen.value;
}

function close(): void {
  acctMenuOpen.value = false;
}

function onLogin(): void {
  acctMenuOpen.value = false;
  emit('login');
}

function onLogout(): void {
  acctMenuOpen.value = false;
  emit('logout');
}

defineExpose({ close });
</script>

<template>
  <nav
    class="rail"
    :class="{ expanded }"
    :aria-label="t('workspace.railLabel')"
    @click.stop
  >
    <!-- Expand / collapse toggle (rail top) -->
    <button
      type="button"
      class="railtoggle"
      :title="expanded ? t('workspace.collapse') : t('workspace.expand')"
      :aria-label="expanded ? t('workspace.collapse') : t('workspace.expand')"
      :aria-expanded="expanded"
      @click="emit('toggleExpand')"
    >
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <template v-if="expanded">
          <path d="M9.5 4 5.5 8l4 4" />
          <path d="M12.5 4 8.5 8l4 4" />
        </template>
        <template v-else>
          <path d="M6.5 4l4 4-4 4" />
          <path d="M3.5 4l4 4-4 4" />
        </template>
      </svg>
    </button>

    <!-- Workspace chips -->
    <button
      v-for="w in workspaces"
      :key="w.id"
      type="button"
      class="wschip"
      :class="{ on: w.id === activeId }"
      :title="chipTitle(w)"
      @click="emit('select', w.id)"
    >
      <span class="chip-glyph">
        {{ initial(w) }}
        <span
          v-if="attentionFor(w.id) > 0"
          class="badge"
          :title="t('workspace.attentionTitle', attentionFor(w.id))"
        >{{ attentionFor(w.id) }}</span>
      </span>
      <template v-if="expanded">
        <span class="chip-name" :title="chipTitle(w)">{{ w.name }}</span>
        <span class="chip-count">{{ w.sessionCount }}</span>
      </template>
    </button>

    <!-- Add workspace -->
    <button
      type="button"
      class="railadd"
      :title="t('workspace.addWorkspace')"
      :aria-label="t('workspace.addWorkspace')"
      @click="emit('addWorkspace')"
    >
      <span class="chip-glyph">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </span>
      <span v-if="expanded" class="chip-name">{{ t('workspace.addWorkspace') }}</span>
    </button>

    <div class="railsp"></div>

    <!-- Account avatar + popover -->
    <div class="acct-wrap">
      <button
        type="button"
        class="avachip"
        :class="{ off: !authReady }"
        :title="authReady ? t('sidebar.signedIn') : t('sidebar.notSignedIn')"
        :aria-label="authReady ? t('sidebar.signedIn') : t('sidebar.notSignedIn')"
        @click="toggleAccount"
      >
        <span class="chip-glyph">
          <!-- Settings gear -->
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </span>
        <span v-if="expanded" class="chip-name">{{ t('workspace.settings') }}</span>
      </button>

      <div v-if="acctMenuOpen" class="acct-menu" :class="{ expanded }" @click.stop>
        <template v-if="authReady">
          <div class="am-head">
            <div class="am-prov">managed:kimi-code</div>
            <div v-if="accountModel" class="am-model" :title="accountModel">{{ accountModel }}</div>
          </div>
          <div class="am-lang">
            <span class="am-lang-label">{{ t('sidebar.language') }}</span>
            <LanguageSwitcher />
          </div>
          <button type="button" class="am-item danger" @click="onLogout">{{ t('sidebar.signOut') }}</button>
        </template>
        <template v-else>
          <div class="am-head">
            <div class="am-prov">{{ t('sidebar.notSignedIn') }}</div>
          </div>
          <div class="am-lang">
            <span class="am-lang-label">{{ t('sidebar.language') }}</span>
            <LanguageSwitcher />
          </div>
          <button type="button" class="am-item signin" @click="onLogin">{{ t('sidebar.signIn') }}</button>
        </template>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.rail {
  width: 52px;
  flex: none;
  border-right: 1px solid var(--line);
  background: var(--panel2);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  gap: 8px;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
  overflow-x: visible;
}
/* Expanded rail — wider, left-aligned, full-width rows */
.rail.expanded {
  width: 190px;
  align-items: stretch;
  padding: 8px;
}

/* Expand/collapse toggle — chevron line glyph at the rail top */
.railtoggle {
  flex: none;
  width: 34px;
  height: 28px;
  border-radius: 8px;
  background: none;
  border: none;
  color: var(--faint);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  align-self: center;
}
.rail.expanded .railtoggle {
  align-self: flex-end;
  width: 28px;
}
.railtoggle:hover { background: var(--soft); color: var(--blue); }

/* Shared glyph cell — the 34px square that holds the initial/icon. Stays a
   fixed square so collapsed and expanded modes line up. */
.chip-glyph {
  width: 34px;
  height: 34px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

/* Workspace chip — rounded 34px square, first letter or muted glyph */
.wschip {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 9px;
  background: var(--bg);
  border: 1px solid var(--line);
  color: var(--muted);
  font-family: var(--mono);
  font-weight: 700;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  position: relative;
  padding: 0;
}
.wschip:hover { border-color: var(--bd); color: var(--ink); }
/* Active chip — filled ink bg, white text, left blue accent stub */
.wschip.on {
  background: var(--ink);
  border-color: var(--ink);
  color: #fff;
}
.wschip.on::before {
  content: "";
  position: absolute;
  left: -9px;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 3px;
  background: var(--blue);
}

/* Attention badge — small warn dot/count, top-right of the glyph */
.badge {
  position: absolute;
  top: -3px;
  right: -3px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  box-sizing: border-box;
  border-radius: 7px;
  background: var(--warn);
  color: #fff;
  font-family: var(--mono);
  font-size: 8.5px;
  font-weight: 700;
  line-height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Add-workspace — dashed square */
.railadd {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 9px;
  border: 1px dashed var(--faint);
  background: none;
  color: var(--faint);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}
.railadd:hover { border-color: var(--blue); color: var(--blue); }

.railsp { flex: 1; min-height: 8px; }

/* Account avatar + popover */
.acct-wrap { position: relative; flex: none; }
.avachip {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: none;
  color: var(--muted);
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}
.avachip.off { color: var(--faint); }
.avachip:hover { background: var(--soft); color: var(--ink); }

/* ---------------------------------------------------------------------------
   Expanded-mode row layout: glyph + name + count. Each control becomes a
   full-width left-aligned row; the active workspace gets the soft-blue tint
   like the session rows.
   --------------------------------------------------------------------------- */
.rail.expanded .wschip,
.rail.expanded .railadd {
  width: 100%;
  height: 36px;
  justify-content: flex-start;
  gap: 6px;
  padding: 0;
  background: none;
  border: 1px solid transparent;
  border-radius: 7px;
}
.rail.expanded .acct-wrap { align-self: stretch; }
.rail.expanded .avachip {
  width: 100%;
  height: 36px;
  justify-content: flex-start;
  gap: 6px;
  border-radius: 7px;
}
.rail.expanded .wschip:hover,
.rail.expanded .avachip:hover { background: var(--soft); }
.rail.expanded .railadd:hover { background: var(--soft); border-color: transparent; }
.rail.expanded .wschip.on {
  background: rgba(21, 101, 192, 0.07);
  border-color: transparent;
  color: var(--ink);
}
.rail.expanded .wschip.on::before { left: -8px; }
/* Keep the active glyph itself filled-ink like the collapsed chip. */
.rail.expanded .wschip .chip-glyph {
  border-radius: 8px;
}
.rail.expanded .wschip.on .chip-glyph {
  background: var(--ink);
  color: #fff;
}

.chip-name {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 500;
  color: var(--ink);
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.railadd .chip-name { color: var(--muted); }
.avachip .chip-name { color: var(--muted); }
.chip-count {
  flex: none;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--faint);
  padding-right: 6px;
}

/* Popover anchored at the rail account avatar. position:fixed so it escapes the
   rail's overflow-y:auto clip and floats above the session column. */
.acct-menu {
  position: fixed;
  left: 58px;
  bottom: 10px;
  width: 220px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  padding: 4px;
  z-index: 200;
}
/* Expanded rail: the gear row sits at the bottom of a 190px column, so anchor
   the popover near the rail's left edge and let it open above the gear. */
.acct-menu.expanded {
  left: 12px;
  bottom: 52px;
}
.am-head {
  padding: 6px 8px 7px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 4px;
}
.am-prov { color: var(--ink); font-size: 11.5px; }
.am-model {
  color: var(--muted);
  font-size: 10.5px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.am-item {
  display: block;
  width: 100%;
  text-align: left;
  border: 0;
  background: none;
  font: inherit;
  font-size: 11.5px;
  color: var(--ink);
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 5px;
}
.am-item:hover { background: var(--hover, rgba(0, 0, 0, 0.04)); }
.am-item.danger { color: #c0392b; }
.am-item.danger:hover { background: rgba(192, 57, 43, 0.08); }
.am-item.signin { color: var(--blue2); }
.am-item.signin:hover { background: var(--soft); }

.am-lang {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
}
.am-lang-label { color: var(--muted); font-size: 11px; }
</style>
