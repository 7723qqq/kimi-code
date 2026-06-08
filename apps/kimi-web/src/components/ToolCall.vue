<!-- apps/kimi-web/src/components/ToolCall.vue -->
<script setup lang="ts">
import { ref } from 'vue';
import type { ToolCall } from '../types';
import { toolLabel, toolGlyph, toolChip, toolSummary } from '../lib/toolMeta';

const props = defineProps<{ tool: ToolCall }>();
const hasOutput = () => !!props.tool.output && props.tool.output.length > 0;
const open = ref(props.tool.defaultExpanded === true && hasOutput());

function toggle() {
  if (hasOutput()) open.value = !open.value;
}

const mark = () =>
  props.tool.status === 'ok' ? '✓'
  : props.tool.status === 'error' ? '✕'
  : '●';

const label = () => toolLabel(props.tool.name);
const glyph = () => toolGlyph(props.tool.name);
const summary = () => toolSummary(props.tool.name, props.tool.arg);
const chip = () => toolChip({
  name: props.tool.name,
  arg: props.tool.arg,
  output: props.tool.output,
  timing: props.tool.timing,
  status: props.tool.status,
});

const isError = () => props.tool.status === 'error';
</script>

<template>
  <div class="box" :class="{ open, err: isError() }">
    <div class="bh" @click="toggle">
      <span class="car">{{ open ? '▾' : '▸' }}</span>
      <!-- inline SVG glyph -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <span class="gl" v-html="glyph()" aria-hidden="true" />
      <span class="a">{{ label() }}</span>
      <span class="p" :title="summary()">· {{ summary() }}</span>
      <span class="rt">
        <span class="chip" v-if="chip()">{{ chip() }}</span>
        <span :class="tool.status === 'ok' ? 'ok' : tool.status === 'error' ? 'er' : 'run'">{{ mark() }}</span>
        <template v-if="tool.timing && tool.name !== 'bash'"> {{ tool.timing }}</template>
      </span>
    </div>
    <div v-if="open" class="bb">
      <div v-for="(line, i) in tool.output" :key="i">{{ line }}</div>
    </div>
  </div>
</template>

<style scoped>
.box {
  border: 1px solid var(--line);
  margin: 7px 0 7px 33px;
  background: #fff;
  border-radius: 3px;
}
.box.err {
  border-color: #f5c6c6;
}
.bh {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  background: var(--panel);
  cursor: pointer;
  font-size: 12px;
  border-radius: 3px;
}
.box.open .bh {
  border-bottom: 1px solid var(--line);
  border-radius: 3px 3px 0 0;
}
.box.err .bh {
  background: #fff5f5;
}
.bh:hover {
  background: var(--panel2);
}
.box.err .bh:hover {
  background: #ffecec;
}
.car { color: var(--faint); }
.gl {
  display: inline-flex;
  align-items: center;
  color: var(--dim);
  flex: none;
}
.a { color: var(--blue2); font-weight: 700; }
.p { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.rt {
  margin-left: auto;
  color: var(--muted);
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.chip {
  background: var(--panel2);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 0 5px;
  color: var(--dim);
  font-size: 10.5px;
}
.ok { color: var(--ok); font-weight: 700; }
.er { color: var(--err); font-weight: 700; }
.run { color: var(--blue); font-weight: 700; }
.bb {
  padding: 8px 11px;
  color: var(--dim);
  font-size: 11.5px;
  line-height: 1.7;
  font-family: var(--mono);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
