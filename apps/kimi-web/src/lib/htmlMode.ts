export const HTML_MODE_PROMPT_START = '<kimi-web-html-mode>';
export const HTML_MODE_PROMPT_END = '</kimi-web-html-mode>';
const HTML_MODE_REQUEST_START = '<kimi-web-html-request>';
const HTML_MODE_REQUEST_END = '</kimi-web-html-request>';

export interface HtmlModePrompt {
  text: string;
  isHtmlMode: boolean;
}

export interface HtmlModeSuggestion {
  label: string;
  prompt: string;
}

export function buildHtmlModePrompt(userText: string): string {
  const request = userText.trim() || '生成一个可直接使用的 HTML 页面。';
  return `${HTML_MODE_PROMPT_START}
你正在 Kimi Web 的 HTML 模式中回复用户。请把回答做成一段可以直接放进 iframe 预览的 HTML。

硬性要求：
1. 只输出 HTML，不要输出 Markdown 代码围栏，不要在 HTML 前后解释。
2. 内容必须是用户可见的完整界面：先给结论或主内容，再给细节；必要时提供表格、分区、按钮、表单或可复制内容。
3. 默认浅色、清晰、克制。不要依赖外部 CDN、远程字体或构建工具。
4. 可以使用宿主内置 class：kc-page、kc-card、kc-panel、kc-grid、kc-row-between、kc-btn、kc-btn-primary、kc-badge、kc-table、kc-input、kc-code、kc-callout，以及常见 utility class 如 flex、grid、gap-3、p-4、rounded-md、border、bg-muted、text-muted。
5. 如果提供下一步操作，给按钮或表单加 data-send="要继续发送给模型的文字"。宿主会把它当作下一轮提示词发送。
6. 如果页面是编辑器、看板、调参器、prompt 工具或配置工具，必须提供复制、导出或生成可复用片段的能力。
7. 允许少量内联 <script> 实现有用交互，但不要读取宿主页面、不要访问 cookie/localStorage，不要执行危险操作。

用户需求：
${HTML_MODE_REQUEST_START}
${request}
${HTML_MODE_REQUEST_END}
${HTML_MODE_PROMPT_END}`;
}

export function parseHtmlModePrompt(text: string): HtmlModePrompt {
  if (!text.includes(HTML_MODE_PROMPT_START) || !text.includes(HTML_MODE_PROMPT_END)) {
    return { text, isHtmlMode: false };
  }

  const start = text.indexOf(HTML_MODE_REQUEST_START);
  const end = text.indexOf(HTML_MODE_REQUEST_END);
  if (start === -1 || end === -1 || end < start) {
    return { text, isHtmlMode: true };
  }

  const request = text.slice(start + HTML_MODE_REQUEST_START.length, end).trim();
  return { text: request, isHtmlMode: true };
}

export function stripHtmlModePrompt(text: string): string {
  return parseHtmlModePrompt(text).text;
}

export function isHtmlModePrompt(text: string): boolean {
  return parseHtmlModePrompt(text).isHtmlMode;
}

const HTML_MODE_HOST_CSS = `
*{box-sizing:border-box}
html{min-height:100%;background:#fff;color:#1f2328}
body{min-height:100%;margin:0;background:#fff;color:#1f2328;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}
button,input,textarea,select{font:inherit}
.block{display:block}.inline-block{display:inline-block}.hidden{display:none}.flex{display:flex}.inline-flex{display:inline-flex}.grid{display:grid}
.flex-col{flex-direction:column}.flex-wrap{flex-wrap:wrap}.flex-1{flex:1 1 0%}.items-start{align-items:flex-start}.items-center{align-items:center}.items-end{align-items:flex-end}.items-stretch{align-items:stretch}
.justify-start{justify-content:flex-start}.justify-center{justify-content:center}.justify-end{justify-content:flex-end}.justify-between{justify-content:space-between}
.gap-1{gap:4px}.gap-2{gap:8px}.gap-3{gap:12px}.gap-4{gap:16px}.gap-5{gap:20px}.gap-6{gap:24px}.gap-8{gap:32px}
.grid-cols-1{grid-template-columns:repeat(1,minmax(0,1fr))}.grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}.grid-cols-4{grid-template-columns:repeat(4,minmax(0,1fr))}
.w-full{width:100%}.h-full{height:100%}.min-h-screen{min-height:100vh}.max-w-full{max-width:100%}.max-w-xl{max-width:576px}.max-w-2xl{max-width:672px}.max-w-3xl{max-width:768px}.max-w-4xl{max-width:896px}.mx-auto{margin-left:auto;margin-right:auto}
.m-0{margin:0}.m-2{margin:8px}.m-3{margin:12px}.m-4{margin:16px}.m-6{margin:24px}.m-8{margin:32px}
.mt-1{margin-top:4px}.mt-2{margin-top:8px}.mt-3{margin-top:12px}.mt-4{margin-top:16px}.mt-6{margin-top:24px}.mt-8{margin-top:32px}
.mb-0{margin-bottom:0}.mb-1{margin-bottom:4px}.mb-2{margin-bottom:8px}.mb-3{margin-bottom:12px}.mb-4{margin-bottom:16px}.mb-6{margin-bottom:24px}.mb-8{margin-bottom:32px}
.p-0{padding:0}.p-2{padding:8px}.p-3{padding:12px}.p-4{padding:16px}.p-5{padding:20px}.p-6{padding:24px}.p-8{padding:32px}.p-10{padding:40px}.p-12{padding:48px}
.px-3{padding-left:12px;padding-right:12px}.px-4{padding-left:16px;padding-right:16px}.px-6{padding-left:24px;padding-right:24px}.px-8{padding-left:32px;padding-right:32px}
.py-2{padding-top:8px;padding-bottom:8px}.py-3{padding-top:12px;padding-bottom:12px}.py-4{padding-top:16px;padding-bottom:16px}.py-6{padding-top:24px;padding-bottom:24px}.py-8{padding-top:32px;padding-bottom:32px}
.space-y-2>*+*{margin-top:8px}.space-y-3>*+*{margin-top:12px}.space-y-4>*+*{margin-top:16px}.space-y-6>*+*{margin-top:24px}
.text-xs{font-size:12px;line-height:16px}.text-sm{font-size:13px;line-height:20px}.text-base{font-size:14px;line-height:22px}.text-lg{font-size:16px;line-height:24px}.text-xl{font-size:20px;line-height:28px}.text-2xl{font-size:24px;line-height:32px}.text-3xl{font-size:30px;line-height:38px}
.font-normal{font-weight:400}.font-medium{font-weight:500}.font-semibold{font-weight:600}.font-bold{font-weight:700}.font-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.leading-tight{line-height:1.25}.leading-normal{line-height:1.5}.leading-relaxed{line-height:1.7}.text-left{text-align:left}.text-center{text-align:center}.text-right{text-align:right}
.text-default{color:#1f2328}.text-muted{color:#656d76}.text-subtle{color:#6e7781}.text-accent{color:#0969da}.text-success{color:#1f883d}.text-danger{color:#cf222e}.text-white{color:#fff}
.bg-white{background:#fff}.bg-muted{background:#f6f8fa}.bg-subtle{background:#eaeef2}.bg-accent{background:#0969da}.bg-accent-subtle{background:#ddf4ff}.bg-success{background:#1f883d}.bg-success-subtle{background:#dafbe1}.bg-danger-subtle{background:#ffebe9}
.border{border:1px solid #d0d7de}.border-0{border:0}.border-t{border-top:1px solid #d0d7de}.border-b{border-bottom:1px solid #d0d7de}.border-l{border-left:1px solid #d0d7de}.border-r{border-right:1px solid #d0d7de}
.border-muted{border-color:#d8dee4}.border-accent{border-color:#0969da}.border-success{border-color:#1f883d}.border-danger{border-color:#cf222e}
.rounded{border-radius:4px}.rounded-md{border-radius:6px}.rounded-lg{border-radius:8px}.rounded-xl{border-radius:12px}.rounded-full{border-radius:999px}
.shadow-sm{box-shadow:0 1px 2px rgba(31,35,40,.08)}.shadow{box-shadow:0 8px 24px rgba(31,35,40,.12)}.overflow-hidden{overflow:hidden}.overflow-auto{overflow:auto}.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.break-words{overflow-wrap:break-word}
.divide-y>*+*{border-top:1px solid #d0d7de}
.kc-page{max-width:960px;margin:0 auto;padding:32px 28px 112px;color:#1f2328}
.kc-narrow{max-width:720px}.kc-wide{max-width:1120px}.kc-stack>*+*{margin-top:16px}
.kc-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:20px}
.kc-title{font-size:24px;line-height:1.3;font-weight:650;margin:0}.kc-subtitle{margin:6px 0 0;color:#656d76;font-size:14px;line-height:1.6}
.kc-card{background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:16px;box-shadow:0 1px 2px rgba(31,35,40,.04)}
.kc-panel{background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:14px}.kc-row{display:flex;align-items:center;gap:10px;min-width:0}.kc-row-between{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.kc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.kc-two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.kc-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid #d0d7de;background:#fff;color:#0969da;border-radius:6px;padding:7px 12px;font-weight:600;font-size:13px;line-height:1.3;cursor:pointer;text-decoration:none}
.kc-btn:hover{background:#f6f8fa;border-color:#0969da;text-decoration:none}.kc-btn-primary{background:#1f883d;border-color:#1f883d;color:#fff}.kc-btn-primary:hover{background:#1a7f37;border-color:#1a7f37;color:#fff}
.kc-badge{display:inline-flex;align-items:center;border:1px solid #d0d7de;background:#f6f8fa;color:#656d76;border-radius:999px;padding:2px 8px;font-size:12px;line-height:18px;font-weight:500}
.kc-badge-success{border-color:#2da44e66;background:#dafbe1;color:#1f883d}.kc-badge-danger{border-color:#ff818266;background:#ffebe9;color:#cf222e}
.kc-table{width:100%;border-collapse:collapse;font-size:13px}.kc-table th,.kc-table td{border-bottom:1px solid #d0d7de;padding:8px 10px;text-align:left;vertical-align:top}.kc-table th{background:#f6f8fa;font-weight:600;color:#656d76}
.kc-input{width:100%;border:1px solid #d0d7de;border-radius:6px;background:#fff;color:#1f2328;padding:8px 10px}
.kc-code{background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:12px;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow:auto}
.kc-callout{border-left:3px solid #0969da;background:#ddf4ff;padding:10px 12px;border-radius:0 6px 6px 0;color:#1f2328}
@media(max-width:720px){.kc-page{padding:24px 16px 96px}.kc-hero,.kc-row-between{display:block}.kc-two{grid-template-columns:1fr}.grid-cols-2,.grid-cols-3,.grid-cols-4{grid-template-columns:1fr}}
`;

const HTML_MODE_BRIDGE_SCRIPT = `<script>
(() => {
  const post = (payload) => parent.postMessage({ __kimiHtmlMode: true, ...payload }, '*');
  const send = (text) => {
    const value = String(text || '').trim();
    if (value) post({ type: 'send', text: value });
  };
  window.kimi = { send };
  window.addEventListener('click', (event) => {
    const target = event.target && event.target.closest ? event.target.closest('[data-send]') : null;
    if (!target) return;
    event.preventDefault();
    let text = target.getAttribute('data-send') || target.textContent || '';
    const inputSelector = target.getAttribute('data-send-input');
    if (inputSelector) {
      const input = document.querySelector(inputSelector);
      const value = input && 'value' in input ? input.value : '';
      text = text ? text + ': ' + value : value;
    }
    send(text);
  }, true);
  window.addEventListener('submit', (event) => {
    const form = event.target;
    if (!form || !form.matches || !form.matches('form')) return;
    event.preventDefault();
    const explicit = form.getAttribute('data-send');
    if (explicit) {
      send(explicit);
      return;
    }
    const formData = new FormData(form);
    const parts = [];
    formData.forEach((value, key) => {
      const text = String(value || '').trim();
      if (text) parts.push(key + ': ' + text);
    });
    send(parts.join('\\n'));
  }, true);
})();
</scr` + `ipt>`;

const HOST_STYLE_TAG = `<style data-kimi-html-mode>${HTML_MODE_HOST_CSS}</style>`;

export function extractHtmlFromAssistantText(text: string): string {
  const trimmed = text.trim().replace(/^\uFEFF/, '');
  if (!trimmed) return '';

  const htmlFence = trimmed.match(/```(?:html|HTML)\s*([\s\S]*?)```/);
  if (htmlFence?.[1]) return htmlFence[1].trim();

  const anyFence = trimmed.match(/```\s*([\s\S]*?)```/);
  if (anyFence?.[1] && looksLikeHtml(anyFence[1])) return anyFence[1].trim();

  const start = findHtmlStart(trimmed);
  if (start > 0) return trimmed.slice(start).trim();
  return trimmed;
}

export function createHtmlModeDocument(text: string): string {
  const html = extractHtmlFromAssistantText(text);
  if (!html) return '';

  if (/<html[\s>]/i.test(html) || /<!doctype\s+html/i.test(html)) {
    return ensureFullDocument(injectBridge(injectHostStyle(html)));
  }

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${HOST_STYLE_TAG}</head><body>${html}${HTML_MODE_BRIDGE_SCRIPT}</body></html>`;
}

export function collectHtmlModeSuggestions(text: string, limit = 8): HtmlModeSuggestion[] {
  if (typeof DOMParser === 'undefined') return [];
  const html = extractHtmlFromAssistantText(text);
  if (!html) return [];

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const elements = doc.querySelectorAll<HTMLElement>('[data-send], [data-next]');
  const out: HtmlModeSuggestion[] = [];
  const seen = new Set<string>();

  for (const el of Array.from(elements)) {
    const prompt = (el.getAttribute('data-send') ?? el.getAttribute('data-next') ?? '').trim();
    if (!prompt || seen.has(prompt)) continue;
    seen.add(prompt);
    const label = collapseWhitespace(el.textContent ?? prompt) || prompt;
    out.push({ label: truncate(label, 40), prompt });
    if (out.length >= limit) break;
  }

  return out;
}

export function htmlModeTitle(prompt: string, htmlText: string): string {
  const html = extractHtmlFromAssistantText(htmlText);
  if (typeof DOMParser !== 'undefined' && html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title =
      collapseWhitespace(doc.querySelector('title')?.textContent ?? '')
      || collapseWhitespace(doc.querySelector('h1,h2,[data-title]')?.textContent ?? '');
    if (title) return truncate(title, 48);
  }
  return truncate(collapseWhitespace(prompt), 48);
}

function looksLikeHtml(value: string): boolean {
  return /<\/?(?:!doctype|html|head|body|main|section|article|div|style|script|table|form|button|h1|h2)\b/i.test(value);
}

function findHtmlStart(value: string): number {
  const match = /(?:<!doctype\s+html|<html\b|<head\b|<body\b|<main\b|<section\b|<article\b|<div\b|<style\b|<table\b|<form\b|<h1\b)/i.exec(value);
  return match?.index ?? 0;
}

function injectHostStyle(documentHtml: string): string {
  if (documentHtml.includes('data-kimi-html-mode')) return documentHtml;
  if (/<\/head>/i.test(documentHtml)) {
    return documentHtml.replace(/<\/head>/i, `${HOST_STYLE_TAG}</head>`);
  }
  if (/<html[^>]*>/i.test(documentHtml)) {
    return documentHtml.replace(/<html([^>]*)>/i, `<html$1><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${HOST_STYLE_TAG}</head>`);
  }
  return `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${HOST_STYLE_TAG}</head>${documentHtml}`;
}

function injectBridge(documentHtml: string): string {
  if (documentHtml.includes('__kimiHtmlMode')) return documentHtml;
  if (/<\/body>/i.test(documentHtml)) {
    return documentHtml.replace(/<\/body>/i, `${HTML_MODE_BRIDGE_SCRIPT}</body>`);
  }
  return `${documentHtml}${HTML_MODE_BRIDGE_SCRIPT}`;
}

function ensureFullDocument(documentHtml: string): string {
  if (/<!doctype\s+html/i.test(documentHtml)) return documentHtml;
  return `<!doctype html>${documentHtml}`;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
