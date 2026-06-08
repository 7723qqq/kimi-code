<!-- apps/kimi-web/src/components/Markdown.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { marked, Renderer } from 'marked';
import type { Tokens } from 'marked';
import { useI18n } from 'vue-i18n';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import yaml from 'highlight.js/lib/languages/yaml';
import markdownLang from 'highlight.js/lib/languages/markdown';
import sql from 'highlight.js/lib/languages/sql';
import diff from 'highlight.js/lib/languages/diff';

const { t } = useI18n();

const props = defineProps<{ text: string }>();

// ---------------------------------------------------------------------------
// highlight.js: register only a curated set of common languages to keep the
// bundle reasonable. tsx/jsx/html/vue are mapped onto existing grammars.
// Registration runs once at module load (idempotent across instances).
// ---------------------------------------------------------------------------

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('markdown', markdownLang);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('diff', diff);

// Aliases for fence languages our chats commonly use.
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' });
hljs.registerAliases(['sh', 'zsh'], { languageName: 'bash' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['rs'], { languageName: 'rust' });
hljs.registerAliases(['html', 'vue', 'htm'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['md', 'markdown'], { languageName: 'markdown' });

// ---------------------------------------------------------------------------
// Configure marked: GFM on, raw HTML escaped (sanitized)
// ---------------------------------------------------------------------------

// Create a custom renderer that escapes raw HTML blocks/inline
const safeRenderer = new Renderer();

// HTML-escape helper (used for plain/unknown code blocks)
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Custom code-block renderer: syntax-highlight known languages via hljs, and
// special-case ```diff so added/removed lines get coloured gutters.
// hljs operates on the raw (un-escaped) code text and returns escaped, safe
// markup; unknown/plain blocks fall back to manual escaping.
safeRenderer.code = function (token: Tokens.Code): string {
  const raw = token.text ?? '';
  const lang = (token.lang ?? '').trim().split(/\s+/)[0] ?? '';
  const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : '';

  if (lang === 'diff') {
    return `<pre><code${langClass}>${renderDiff(raw)}</code></pre>\n`;
  }

  if (lang && hljs.getLanguage(lang)) {
    try {
      const out = hljs.highlight(raw, { language: lang, ignoreIllegals: true });
      return `<pre><code${langClass}>${out.value}</code></pre>\n`;
    } catch {
      /* fall through to plain escaping */
    }
  }

  return `<pre><code${langClass}>${escapeHtml(raw)}</code></pre>\n`;
};

// Render a ```diff block: wrap each line in a span keyed by +/- so CSS can
// colour added/removed lines with a subtle left gutter. Content is escaped.
function renderDiff(code: string): string {
  return code
    .split('\n')
    .map((line) => {
      const escaped = escapeHtml(line);
      if (/^\+(?!\+\+)/.test(line)) return `<span class="diff-add">${escaped}</span>`;
      if (/^-(?!--)/.test(line)) return `<span class="diff-del">${escaped}</span>`;
      if (/^@@/.test(line)) return `<span class="diff-hunk">${escaped}</span>`;
      return `<span class="diff-ctx">${escaped}</span>`;
    })
    .join('\n');
}

// Escape raw HTML blocks
safeRenderer.html = function (token: Tokens.HTML) {
  return token.text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

// Open all links in new tab
safeRenderer.link = function (token: Tokens.Link) {
  const href = token.href ?? '';
  const title = token.title ? ` title="${token.title}"` : '';
  // token.text is the plain text representation of the link label
  const text = token.text ?? href;
  return `<a href="${href}"${title} target="_blank" rel="noopener noreferrer" class="md-link">${text}</a>`;
};

marked.use({ renderer: safeRenderer, gfm: true, breaks: true });

// ---------------------------------------------------------------------------
// Copy-button state per code block (keyed by index)
// ---------------------------------------------------------------------------

const copiedIndex = ref<number | null>(null);

function copyCode(code: string, idx: number) {
  navigator.clipboard.writeText(code).then(() => {
    copiedIndex.value = idx;
    setTimeout(() => { copiedIndex.value = null; }, 1400);
  }).catch(() => {/* ignore */});
}

// ---------------------------------------------------------------------------
// Render: parse markdown, then inject copy buttons into <pre><code> blocks
// ---------------------------------------------------------------------------

const rendered = computed<{ html: string; codeBlocks: string[] }>(() => {
  const html = marked.parse(props.text, { gfm: true, breaks: true }) as string;

  // Extract raw code content from pre>code blocks for copy buttons
  const codeBlocks: string[] = [];
  const injected = html.replace(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g, (_match, attrs, content) => {
    const idx = codeBlocks.length;
    // Strip hljs/diff token <span> wrappers, then decode HTML entities to
    // recover the raw code text for the clipboard. &amp; is decoded last so
    // sequences like "&amp;lt;" are not double-decoded.
    const raw = content
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    codeBlocks.push(raw);

    // Detect language from class e.g. class="language-ts"
    const langMatch = attrs.match(/class="language-([^"]+)"/);
    const lang = langMatch ? langMatch[1] : '';
    const langLabel = lang ? `<span class="cb-lang">${lang}</span>` : '';

    return `<div class="cb-wrap"><div class="cb-bar">${langLabel}<button class="cb-copy" data-idx="${idx}" title="${t('filePreview.copyCode')}">⧉</button></div><pre><code${attrs}>${content}</code></pre></div>`;
  });

  return { html: injected, codeBlocks };
});

// Handle copy-button clicks via event delegation on the root element
function handleClick(e: MouseEvent) {
  const btn = (e.target as Element).closest('[data-idx]') as HTMLElement | null;
  if (!btn) return;
  const idx = parseInt(btn.dataset.idx ?? '', 10);
  if (!isNaN(idx) && rendered.value.codeBlocks[idx] !== undefined) {
    copyCode(rendered.value.codeBlocks[idx]!, idx);
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = '⧉'; }, 1400);
  }
}
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="md" v-html="rendered.html" @click="handleClick" />
</template>

<style scoped>
/* Base prose */
.md {
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.65;
  color: var(--text);
  word-break: break-word;
}

/* Headings */
.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4) {
  color: var(--ink);
  font-weight: 700;
  margin: 0.85em 0 0.35em;
  line-height: 1.3;
}
.md :deep(h1) { font-size: 15px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
.md :deep(h2) { font-size: 14px; }
.md :deep(h3) { font-size: 13px; }
.md :deep(h4) { font-size: 12.5px; color: var(--dim); }

/* Paragraphs */
.md :deep(p) {
  margin: 0.4em 0;
}

/* Lists */
.md :deep(ul),
.md :deep(ol) {
  padding-left: 1.4em;
  margin: 0.4em 0;
}
.md :deep(li) {
  margin: 0.15em 0;
}

/* Inline code */
.md :deep(code) {
  font-family: var(--mono);
  font-size: 12px;
  background: var(--panel2);
  color: var(--blue2);
  padding: 1px 5px;
  border-radius: 3px;
  border: 1px solid var(--line);
}

/* Code block wrapper injected by JS */
.md :deep(.cb-wrap) {
  position: relative;
  margin: 0.6em 0;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel);
  overflow: hidden;
}

.md :deep(.cb-bar) {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  padding: 3px 8px;
  background: var(--panel2);
  border-bottom: 1px solid var(--line);
}

.md :deep(.cb-lang) {
  font-size: 10px;
  color: var(--muted);
  margin-right: auto;
  letter-spacing: 0.04em;
}

.md :deep(.cb-copy) {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--muted);
  font-size: 13px;
  padding: 0 2px;
  line-height: 1;
  font-family: var(--mono);
}
.md :deep(.cb-copy:hover) {
  color: var(--blue);
}

/* Fenced code blocks: pre>code inside cb-wrap */
.md :deep(.cb-wrap pre) {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  background: var(--panel);
}
.md :deep(.cb-wrap pre code) {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink);
  background: none;
  border: none;
  padding: 0;
  border-radius: 0;
}

/* ---------------------------------------------------------------------------
   highlight.js — LIGHT token palette (github-light-ish), Terminal Pro tones.
   Tokens lean muted with Kimi-blue keywords; never a dark code theme.
--------------------------------------------------------------------------- */
.md :deep(.hljs-comment),
.md :deep(.hljs-quote) { color: var(--muted); font-style: italic; }

.md :deep(.hljs-keyword),
.md :deep(.hljs-selector-tag),
.md :deep(.hljs-built_in),
.md :deep(.hljs-literal),
.md :deep(.hljs-doctag),
.md :deep(.hljs-meta-keyword) { color: var(--blue); }

.md :deep(.hljs-name),
.md :deep(.hljs-section),
.md :deep(.hljs-selector-id),
.md :deep(.hljs-selector-class),
.md :deep(.hljs-title) { color: var(--blue2); }

.md :deep(.hljs-string),
.md :deep(.hljs-regexp),
.md :deep(.hljs-symbol),
.md :deep(.hljs-meta .hljs-string) { color: var(--ok); }

.md :deep(.hljs-number),
.md :deep(.hljs-bullet),
.md :deep(.hljs-attr),
.md :deep(.hljs-attribute),
.md :deep(.hljs-variable),
.md :deep(.hljs-template-variable),
.md :deep(.hljs-type),
.md :deep(.hljs-class .hljs-title) { color: var(--warn); }

.md :deep(.hljs-tag),
.md :deep(.hljs-punctuation),
.md :deep(.hljs-meta) { color: var(--dim); }

.md :deep(.hljs-deletion) { color: var(--err); }
.md :deep(.hljs-addition) { color: var(--ok); }
.md :deep(.hljs-emphasis) { font-style: italic; }
.md :deep(.hljs-strong) { font-weight: 700; }

/* ```diff fences — coloured +/- lines with a subtle left gutter */
.md :deep(.cb-wrap pre code .diff-add),
.md :deep(.cb-wrap pre code .diff-del),
.md :deep(.cb-wrap pre code .diff-ctx),
.md :deep(.cb-wrap pre code .diff-hunk) {
  display: block;
  padding-left: 8px;
  border-left: 2px solid transparent;
  margin-left: -12px;
  padding-right: 12px;
}
.md :deep(.cb-wrap pre code .diff-add) {
  color: var(--ok);
  background: rgba(14, 122, 56, 0.07);
  border-left-color: var(--ok);
}
.md :deep(.cb-wrap pre code .diff-del) {
  color: var(--err);
  background: rgba(185, 28, 28, 0.06);
  border-left-color: var(--err);
}
.md :deep(.cb-wrap pre code .diff-hunk) {
  color: var(--blue);
}
.md :deep(.cb-wrap pre code .diff-ctx) {
  color: var(--dim);
}

/* Links */
.md :deep(.md-link) {
  color: var(--blue);
  text-decoration: none;
}
.md :deep(.md-link:hover) {
  text-decoration: underline;
}

/* Blockquote */
.md :deep(blockquote) {
  margin: 0.5em 0;
  padding: 4px 12px;
  border-left: 3px solid var(--line);
  color: var(--dim);
}

/* HR */
.md :deep(hr) {
  border: none;
  border-top: 1px solid var(--line);
  margin: 0.8em 0;
}

/* Tables */
.md :deep(table) {
  border-collapse: collapse;
  font-size: 12px;
  margin: 0.5em 0;
}
.md :deep(th),
.md :deep(td) {
  border: 1px solid var(--line);
  padding: 4px 10px;
  text-align: left;
}
.md :deep(th) {
  background: var(--panel2);
  color: var(--ink);
  font-weight: 600;
}
</style>
