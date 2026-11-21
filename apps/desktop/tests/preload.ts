import '../../../packages/vite-preset/test/preload-assets';
import { plugin } from 'bun';

plugin({
  name: 'desktop-test-icons',
  setup(builder) {
    builder.onResolve({ filter: /^~icons\// }, ({ path }) => ({ path, namespace: 'kimi-icon' }));
  },
});
