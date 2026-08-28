---
"@moonshot-ai/kimi-code": major
---

Drop `node-pty` and require Bun runtime. Host terminal sessions now use Bun.Terminal exclusively; the previous node-pty fallback for Node.js runtimes is gone. The published package's `engines` is now `bun >= 1.4.0` (was `node >= 22.19.0`).

The published CLI entry (`dist/main.mjs`) now carries a `#!/usr/bin/env bun` shebang, so `bun add -g` works on machines that have no Node.js installed — previously the node shebang made `kimi` fail with `env: node: No such file or directory` for exactly that audience. Note that shebangs are a Unix concept: on Windows, npm still generates a `.cmd` shim that invokes node, so Windows users without Bun keep getting the friendly "requires Bun >= 1.4" message pointing at https://bun.sh. The in-process runtime check is unchanged, so running the entry with node on purpose still fails fast with that same message. The packaged single-file binary path is unchanged.
