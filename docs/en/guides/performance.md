# Startup performance

Kimi Code CLI is distributed as a single executable with its runtime embedded, so every invocation starts a fresh process. Startup time is therefore worth measuring and keeping small.

## What changed

The native executable is now compiled with **bytecode precompilation**. The JavaScript bundle is compiled to bytecode (the runtime's pre-parsed form) at build time instead of being parsed on every start, so the process reaches the first prompt sooner and holds less memory while doing it.

Source code is not obscured: stack traces and errors still point at the original code. Builds remain reproducible.

## Measured results

Measured on Windows 11 (Intel Core Ultra 9 285K, 24 cores, 63 GiB RAM) with a process-time driver that spawns the executable and waits for it to exit. Each figure is the median of 30 runs.

| Scenario | Before bytecode | After bytecode | Change |
|---|---|---|---|
| `kimi --version` | 604 ms | **283 ms** | 2.1× faster |
| 95th percentile | 633 ms | 305 ms | −52% |
| Peak working set (memory in active use) | 237 MB | **181 MB** | −24% |
| Executable size | 185.5 MiB | 219.4 MiB | +18% |

The same executable compared with the official Kimi Code 2.4.1 release (Node SEA build) on the same machine:

| Scenario | This build | Official 2.4.1 |
|---|---|---|
| `kimi --version` | 277 ms | 471 ms |
| `kimi doctor config` | 280 ms | 488 ms |
| `kimi session list --json` | 476 ms | 576 ms |
| Peak working set (`--version`) | 181 MB | 298 MB |

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
