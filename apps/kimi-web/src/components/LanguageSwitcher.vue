<!-- apps/kimi-web/src/components/LanguageSwitcher.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { availableLocales, setLocale, type LocaleCode } from '../i18n';

const { locale } = useI18n();

function choose(code: LocaleCode): void {
  if (locale.value === code) return;
  setLocale(code);
}
</script>

<template>
  <div class="lang-switch" role="group" aria-label="Language">
    <button
      v-for="opt in availableLocales"
      :key="opt.code"
      type="button"
      class="lang-opt"
      :class="{ on: locale === opt.code }"
      :aria-pressed="locale === opt.code"
      @click.stop="choose(opt.code)"
    >{{ opt.label }}</button>
  </div>
</template>

<style scoped>
.lang-switch {
  display: inline-flex;
  align-items: center;
  gap: 0;
  border: 1px solid var(--line);
  border-radius: 4px;
  overflow: hidden;
  font-family: var(--mono);
}
.lang-opt {
  appearance: none;
  border: 0;
  background: none;
  cursor: pointer;
  font: inherit;
  font-size: 10.5px;
  line-height: 1;
  color: var(--muted);
  padding: 3px 8px;
}
.lang-opt + .lang-opt {
  border-left: 1px solid var(--line);
}
.lang-opt:hover {
  color: var(--ink);
  background: var(--panel2);
}
.lang-opt.on {
  color: var(--ink);
  background: var(--line2);
  font-weight: 600;
}
</style>
