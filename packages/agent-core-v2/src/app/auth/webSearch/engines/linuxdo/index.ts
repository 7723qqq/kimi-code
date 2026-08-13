/**
 * `auth` domain (cross-cutting) — LinuxDo search engine and article fetcher
 * entry, ported from the open-websearch project (`engines/linuxdo`). Request
 * mode only.
 */

export { searchLinuxDo } from './linuxdo';
export { fetchLinuxDoArticle } from './fetchLinuxDoArticle';
