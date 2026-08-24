// Bun compiled entry. The runtime bundle is compiled into the module graph
// at build time: build-bun.mjs stages a shebang-stripped copy of main.cjs
// next to this file, and the import below executes it in place — no runtime
// extraction to /tmp, no dynamic import. Import declarations evaluate
// depth-first in declaration order, so bun-assets.setup.ts populates
// __KIMI_BUN_ASSETS__ before the runtime starts.
import './bun-assets.setup';
import './main.cjs';
