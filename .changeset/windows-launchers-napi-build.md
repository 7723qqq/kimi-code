---
"@moonshot-ai/kimi-code": patch
---

Both Windows launchers (`start-native.bat` and `start-desktop.bat`) now build `kimi-native-tools` through `bun run build` (the napi-rs pipeline that emits a proper `.node`), replacing the retired `cargo build --release` + manual DLL-rename path. This matches the `_native-build.yml` release pipeline and stops the two launchers from racing to write the same artifact with a bare cargo DLL that bypasses the napi binding layer (and would otherwise get packed into the desktop bundle by `build:native:bun`).

Because the napi build depends on `node_modules/@napi-rs/cli` (a devDependency), a clean checkout that has not run `bun install` would previously fail with a misleading error pointing at rustup / VS Build Tools. Both scripts now guard the build branch and print an actionable message asking you to run `bun install` at the repo root first.
