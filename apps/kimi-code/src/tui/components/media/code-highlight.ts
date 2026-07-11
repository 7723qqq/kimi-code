/**
 * Shared syntax-highlighting helpers for code previews
 * (tool-call Write/Edit, approval-panel Write content, etc.).
 *
 * cli-highlight (and its highlight.js dependency) is loaded on first use
 * via dynamic import to keep the startup bundle lean.
 */

import { extname } from 'node:path';

let _highlight: typeof import('cli-highlight') | undefined;
// Fire-and-forget: start loading cli-highlight immediately so it is ready
// by the time the user opens a code preview. If it hasn't loaded yet,
// highlightLines falls back to plain text.
void import('cli-highlight').then((m) => {
  _highlight = m;
});

const EXT_LANG_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  css: 'css',
  html: 'html',
  sql: 'sql',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
};

export function langFromPath(filePath: string): string | undefined {
  const ext = extname(filePath).slice(1).toLowerCase();
  if (ext.length === 0) return undefined;
  const lang = EXT_LANG_MAP[ext] ?? ext;
  if (_highlight === undefined || !_highlight.supportsLanguage(lang)) return undefined;
  return lang;
}

export function highlightLines(code: string, lang: string | undefined): string[] {
  const normalizedLang = lang?.trim().toLowerCase();
  if (_highlight === undefined || !normalizedLang || !_highlight.supportsLanguage(normalizedLang)) {
    return code.split('\n');
  }
  try {
    return _highlight.highlight(code, { language: normalizedLang, ignoreIllegals: true }).split('\n');
  } catch {
    return code.split('\n');
  }
}
