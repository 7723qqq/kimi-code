# Darwin native prebuilds

Provides modifier-key state and asynchronous text/image clipboard access using AppKit.

## Building

On macOS, run from the repository root:

```sh
bash packages/pi-tui/native/darwin/build.sh
```

The build uses Apple clang and the macOS SDK found through `xcrun`. Either Intel or Apple Silicon can build both targets: arm64 (macOS 11+) and x64 (macOS 10.15+).

Cross-building requires a Darwin toolchain with a macOS SDK and Mach-O linker, such as osxcross:

```sh
CC=/path/to/osxcross/clang SDKROOT=/path/to/MacOSX.sdk \
  bash packages/pi-tui/native/darwin/build.sh
```

The SDK must be obtained and used under Apple's license. Plain clang or Zig alone is not sufficient.
