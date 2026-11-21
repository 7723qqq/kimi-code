import type { Plugin } from 'vite';
import { FileSystemIconLoader } from 'unplugin-icons/loaders';
import Icons from 'unplugin-icons/vite';

const RAW_ICON_PREFIX = '\0kimi-raw-icon:';

function rawIconPlugin(icons: Plugin): Plugin {
  return {
    name: 'kimi-raw-icons',
    enforce: 'pre',
    resolveId(id) {
      if (/^(?:\/?~icons\/|virtual[:/]icons\/).+[?&]raw(?:[=&]|$)/.test(id)) {
        return `${RAW_ICON_PREFIX}${encodeURIComponent(id)}`;
      }
      return null;
    },
    async load(id) {
      if (!id.startsWith(RAW_ICON_PREFIX) || typeof icons.load !== 'function') return null;
      return icons.load.call(this, decodeURIComponent(id.slice(RAW_ICON_PREFIX.length)));
    },
  };
}

export function kimiIconPlugins(iconsDir: string): Plugin[] {
  const iconPlugins = [
    Icons({
      compiler: 'vue3',
      customCollections: { kimi: FileSystemIconLoader(iconsDir) },
    }),
  ].flat();
  const icons = iconPlugins.find(
    (plugin): plugin is Plugin => plugin.name === 'unplugin-icons' && typeof plugin.load === 'function',
  );
  if (!icons) throw new Error('unplugin-icons did not provide a load hook');
  return [rawIconPlugin(icons), ...iconPlugins];
}
