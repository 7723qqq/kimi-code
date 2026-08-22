import { loadHtml, type EngineElement } from '../engine-html';

export interface BaiduSearchResult {
  title: string;
  url: string;
  description: string;
  source: string;
  engine: 'baidu';
}

function textOfAll(element: EngineElement, selector: string): string {
  return element
    .querySelectorAll(selector)
    .map((el) => el.textContent ?? '')
    .join('');
}

export function parseBaiduSearchResults(html: string): BaiduSearchResult[] {
  const $ = loadHtml(html);
  const results: BaiduSearchResult[] = [];
  for (const contentBlock of $('#content_left').toArray()) {
    const children = Array.from(
      (contentBlock as EngineElement & { children?: ArrayLike<EngineElement> }).children ?? [],
    );
    for (const element of children) {
      const titleElement = element.querySelector('h3');
      const linkElement = element.querySelector('a');
      if (titleElement === null || linkElement === null) {
        continue;
      }
      const url = linkElement.getAttribute('href');
      if (url === null || !url.startsWith('http')) {
        continue;
      }
      const snippetBaidu = element.querySelector('.c-font-normal.c-color-text');
      const snippetElement = element.querySelector('.cos-row');
      results.push({
        title: titleElement.textContent ?? '',
        url,
        description:
          snippetBaidu?.getAttribute('aria-label') ?? (snippetElement?.textContent ?? '').trim(),
        source: textOfAll(element, '.cosc-source').trim(),
        engine: 'baidu',
      });
    }
  }
  return results;
}
