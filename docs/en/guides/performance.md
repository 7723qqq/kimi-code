# Startup performance

Kimi Code CLI is distributed as a single executable with its runtime embedded, so every invocation starts a fresh process. Startup time is therefore worth measuring and keeping small.

## What changed

The native executable is now compiled with **bytecode precompilation**. The JavaScript bundle is compiled to bytecode (the runtime's pre-parsed form) at build time instead of being parsed on every start, so the process reaches the first prompt sooner and holds less memory while doing it.

Source code is not obscured: stack traces and errors still point at the original code. Builds remain reproducible.

## Measured results

Measured on Windows 11 (Intel Core Ultra 9 285K, 24 cores, 63 GiB RAM) with a process-time driver that spawns the executable and waits for it to exit. `--version` figures are the median of 30 runs; the other commands use 20. Peak working set reads the OS-recorded process peak rather than a polled sample.

| Scenario | Before bytecode | After bytecode | Change |
|---|---|---|---|
| `kimi --version` | 548 ms | **177 ms** | 3.1× faster |
| 95th percentile | 580 ms | 222 ms | −62% |
| Peak working set (memory in active use) | 233 MiB | **170 MiB** | −27% |
| Executable size | 192.1 MiB | 231.9 MiB | +21% |

The same executable compared with the official Kimi Code 2.5.3 npm package on the same machine (the official package ships no standalone executable; it runs on Node.js 24.9.0 via `node dist/main.mjs`). This build is 2.5.2:

| Scenario | This build | Official 2.5.3 |
|---|---|---|
| `kimi --version` | 176 ms | 605 ms |
| `kimi doctor config` | 174 ms | 597 ms |
| `kimi session list --json` | 308 ms | 754 ms |
| Peak working set (`--version`) | 170 MiB | 276 MiB |

Times vary with hardware, storage, and what else runs on the machine; treat the ratios as the useful part.

## Verify locally

::: code-group

```powershell [Windows]
# Build the executable for this platform
cd apps/kimi-code
bun run build:native:bun

# Warm up once, then take 30 samples and report the median
.\dist-native\bin\win32-x64\kimi.exe --version | Out-Null
1..30 | ForEach-Object {
  (Measure-Command { .\dist-native\bin\win32-x64\kimi.exe --version }).TotalMilliseconds
} | Sort-Object | Select-Object -Index 14
```

```bash [macOS / Linux]
cd apps/kimi-code
bun run build:native:bun

./dist-native/bin/*/kimi --version >/dev/null
for i in $(seq 30); do
  /usr/bin/time -f "%e" ./dist-native/bin/*/kimi --version >/dev/null
done
```

:::

## For contributors

- Bytecode is enabled by default in `apps/kimi-code/scripts/native/build-bun.mjs`.
- Set `KIMI_CODE_BUN_DISABLE_BYTECODE=1` before `bun run build:native:bun` to produce a build without it, for comparison.
- Startup numbers depend on the Bun version that builds the executable, because the runtime is embedded in the binary.
