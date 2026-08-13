/**
 * `auth` domain (cross-cutting) — Zhihu search engine and article fetcher
 * entry, ported from the open-websearch project (`engines/zhihu`). Request
 * mode only.
 */

export { searchZhihu } from './zhihu';
export { fetchZhihuArticle } from './fetchZhihuArticle';
