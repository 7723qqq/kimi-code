// apps/kimi-web/src/components/__tests__/FilePreview.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import FilePreview from '../FilePreview.vue';
import type { FileData } from '../FilePreview.vue';

// FilePreview (and the Markdown child) use vue-i18n; default locale is English.
const global = { plugins: [i18n] };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkFile(overrides: Partial<FileData> = {}): FileData {
  return {
    path: 'src/main.ts',
    content: 'const x = 1;\nconst y = 2;',
    encoding: 'utf-8',
    mime: 'text/typescript',
    languageId: 'typescript',
    isBinary: false,
    size: 26,
    lineCount: 2,
    ...overrides,
  };
}

// Tiny 1×1 PNG base64 (same as stub)
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FilePreview', () => {
  it('shows empty state when no file is provided', () => {
    const w = mount(FilePreview, { props: { file: null, loading: false }, global });
    expect(w.text()).toContain('Select a file on the left to preview');
  });

  it('shows loading spinner while loading', () => {
    const w = mount(FilePreview, { props: { file: null, loading: true }, global });
    expect(w.find('.spinner').exists()).toBe(true);
    expect(w.text()).toContain('Loading');
  });

  it('renders markdown via Markdown component', () => {
    const file = mkFile({
      path: 'README.md',
      content: '# Hello\nworld',
      mime: 'text/markdown',
      languageId: 'markdown',
    });
    const w = mount(FilePreview, { props: { file, loading: false }, global });
    // Markdown component renders HTML, so check for the rendered output
    expect(w.findComponent({ name: 'Markdown' }).exists()).toBe(true);
    // The markdown body class should be present
    expect(w.find('.fp-markdown').exists()).toBe(true);
  });

  it('renders code with line numbers for text files', () => {
    const file = mkFile();
    const w = mount(FilePreview, { props: { file, loading: false }, global });
    expect(w.find('.fp-code').exists()).toBe(true);
    const gutters = w.findAll('.fp-gutter');
    expect(gutters.length).toBe(2); // 2 lines
    expect(gutters[0]!.text()).toBe('1');
    expect(gutters[1]!.text()).toBe('2');
  });

  it('pretty-prints JSON files', () => {
    const file = mkFile({
      path: 'package.json',
      content: '{"name":"test","version":"1.0.0"}',
      mime: 'application/json',
      languageId: 'json',
      lineCount: 1,
    });
    const w = mount(FilePreview, { props: { file, loading: false }, global });
    expect(w.find('.fp-code').exists()).toBe(true);
    // Pretty-printed JSON should have more than 1 line
    const gutters = w.findAll('.fp-gutter');
    expect(gutters.length).toBeGreaterThan(1);
  });

  it('falls back to raw text when JSON is invalid', () => {
    const file = mkFile({
      path: 'bad.json',
      content: '{invalid json}',
      mime: 'application/json',
      languageId: 'json',
    });
    const w = mount(FilePreview, { props: { file, loading: false }, global });
    expect(w.find('.fp-code').exists()).toBe(true);
    // Should still render without error
    expect(w.text()).toContain('{invalid json}');
  });

  it('renders image with base64 src for image mime + base64 encoding', () => {
    const file = mkFile({
      path: 'logo.png',
      content: PNG_1X1,
      encoding: 'base64',
      mime: 'image/png',
      languageId: undefined,
      isBinary: true,
    });
    const w = mount(FilePreview, { props: { file, loading: false }, global });
    const img = w.find('img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toContain('data:image/png;base64,');
  });

  it('shows binary card for binary files that are not images', () => {
    const file = mkFile({
      path: 'font.woff2',
      content: 'AABB',
      encoding: 'base64',
      mime: 'font/woff2',
      languageId: undefined,
      isBinary: true,
    });
    const w = mount(FilePreview, { props: { file, loading: false }, global });
    expect(w.find('.fp-binary-card').exists()).toBe(true);
    expect(w.text()).toContain('Binary file');
    expect(w.text()).toContain('preview unavailable');
  });

  it('shows file path in header', () => {
    const file = mkFile({ path: 'src/api/types.ts' });
    const w = mount(FilePreview, { props: { file, loading: false }, global });
    expect(w.text()).toContain('types.ts');
  });

  it('shows line count and size in header for text files', () => {
    const file = mkFile({ lineCount: 42, size: 2048 });
    const w = mount(FilePreview, { props: { file, loading: false }, global });
    expect(w.text()).toContain('42 lines');
    expect(w.text()).toContain('2.0 KB');
  });

  it('shows copy button for text files', () => {
    const file = mkFile();
    const w = mount(FilePreview, { props: { file, loading: false }, global });
    expect(w.find('.fp-copy').exists()).toBe(true);
  });

  it('does not show copy button for binary files', () => {
    const file = mkFile({
      isBinary: true,
      mime: 'font/woff2',
      encoding: 'base64',
    });
    const w = mount(FilePreview, { props: { file, loading: false }, global });
    expect(w.find('.fp-copy').exists()).toBe(false);
  });
});
