{
  description = "Kimi Code CLI";

  inputs = {
    # Pinned to the 25.11 release channel to keep Node.js >= 24.15 available
    # for the test suites and tooling that run alongside the packaging steps.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
  };

  outputs =
    { self, nixpkgs }:
    let
      lib = nixpkgs.lib;

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems =
        f:
        lib.genAttrs systems (
          system:
          f (import nixpkgs {
            inherit system;
          })
        );

      minNodeVersion = "24.15.0";

      # Hardcode to Node.js 24.x; fail the evaluation if the pinned nixpkgs
      # does not offer a new enough 24.x.
      nodejsFor =
        pkgs:
        let
          node = pkgs.nodejs_24;
        in
        if lib.versionAtLeast node.version minNodeVersion then
          node
        else
          throw ''
            Kimi Code requires Node.js >= ${minNodeVersion},
            but nixpkgs only offers ${node.version}.
            Pin a newer nixpkgs revision or update minNodeVersion in flake.nix.
          '';

      # The packaging pipeline requires Bun >= 1.4 while nixpkgs-25.11 ships
      # 1.3.x, so pin the upstream release directly. Same prebuilt-archive
      # derivation shape as nixpkgs' bun package, with the version and source
      # swapped. Hashes are the official sha256 digests published on the
      # GitHub release (SRI form).
      bunVersion = "1.4.4";
      bunSources = {
        "aarch64-darwin" = {
          url = "bun-darwin-aarch64.zip";
          sourceRoot = "bun-darwin-aarch64";
          hash = "sha256-kJh6OhbX21VtiGrD1VHnttPt8KHPQ6yu1iLoZ2vh0S8=";
        };
        "x86_64-darwin" = {
          url = "bun-darwin-x64-baseline.zip";
          sourceRoot = "bun-darwin-x64-baseline";
          hash = "sha256-utW71s8U0JgNEV9ZVMn/kE32GdXplNLaH/zNPzFjALA=";
        };
        "aarch64-linux" = {
          url = "bun-linux-aarch64.zip";
          sourceRoot = null;
          hash = "sha256-VDKLvC2cjgyfiSxUTWbFeoO4QTnjSQnl7oF1jxrI/ac=";
        };
        "x86_64-linux" = {
          url = "bun-linux-x64.zip";
          sourceRoot = null;
          hash = "sha256-NjaPrvdSeHXV/6UuU81IAhdB8qg+tiCKjdZAaNQiqRM=";
        };
      };

      bunFor =
        pkgs:
        let
          source = bunSources.${pkgs.stdenv.hostPlatform.system}
            or (throw "Unsupported system for Bun: ${pkgs.stdenv.hostPlatform.system}");
        in
        pkgs.bun.overrideAttrs (
          finalAttrs: prevAttrs: {
            version = bunVersion;
            inherit (source) sourceRoot;
            src = pkgs.fetchurl {
              url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${source.url}";
              hash = source.hash;
            };
          }
        );

      # The structural review tool (tools/review) needs Zig 0.17; nixpkgs-25.11
      # builds 0.15.x from source, so fetch the official prebuilt tarball
      # instead. Hashes are the sha256 digests published in
      # https://ziglang.org/download/index.json. The Linux binaries are
      # statically linked, so no patchelf pass is needed.
      zigVersion = "0.17.0";
      zigSources = {
        "aarch64-darwin" = {
          file = "zig-aarch64-macos-${zigVersion}.tar.xz";
          hash = "sha256-b607e9b9234790a008116ae5bdb71c6243b84b9fb42a53a9e70fde41c06c536a";
        };
        "x86_64-darwin" = {
          file = "zig-x86_64-macos-${zigVersion}.tar.xz";
          hash = "sha256-4f9a1c5269aa17ebda5e6d3c2b89d6cbf36f7d2b22a0306e9ab98f25f95529c6";
        };
        "aarch64-linux" = {
          file = "zig-aarch64-linux-${zigVersion}.tar.xz";
          hash = "sha256-9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8";
        };
        "x86_64-linux" = {
          file = "zig-x86_64-linux-${zigVersion}.tar.xz";
          hash = "sha256-1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026";
        };
      };

      zigFor =
        pkgs:
        let
          source = zigSources.${pkgs.stdenv.hostPlatform.system}
            or (throw "Unsupported system for Zig: ${pkgs.stdenv.hostPlatform.system}");
        in
        pkgs.stdenv.mkDerivation {
          pname = "zig";
          version = zigVersion;

          src = pkgs.fetchurl {
            url = "https://ziglang.org/download/${zigVersion}/${source.file}";
            inherit (source) hash;
          };

          # The tarball is a prebuilt toolchain: `zig` at the root with the
          # standard library beside it in `lib/`. Zig locates that library
          # relative to the executable, so the two must stay siblings under
          # $out — hence bin/zig and lib/, not lib/zig/.
          nativeBuildInputs = [ pkgs.xz ];
          dontConfigure = true;
          dontBuild = true;

          installPhase = ''
            runHook preInstall
            install -Dm755 zig $out/bin/zig
            cp -a lib $out/lib
            runHook postInstall
          '';

          meta = {
            description = "General-purpose programming language and toolchain";
            homepage = "https://ziglang.org/";
            license = lib.licenses.mit;
            mainProgram = "zig";
            platforms = systems;
          };
        };

      # Workspace members contributing files to the build src (kept in sync
      # with the "workspaces" field of the root package.json).
      #
      # HARD REQUIREMENT: whenever you add or remove a workspace package, you
      # MUST update the list below. Missing a path silently drops files from
      # the Nix build's src fileset. `scripts/check-nix-workspace.mjs`
      # validates this list against package.json.
      workspacePaths = [
        ./packages/acp-server
        ./packages/agent-core-v2
        ./packages/i18n
        ./packages/i18n-shared
        ./packages/kap-server
        ./packages/klient
        ./packages/kosong
        ./packages/migration-legacy
        ./packages/minidb
        ./packages/node-sdk
        ./packages/oauth
        ./packages/pi-tui
        ./packages/product
        ./packages/remote-control
        ./packages/session-import
        ./packages/telemetry
        ./packages/transcript
        ./packages/tree-sitter-bash
        ./apps/kimi-code
        ./apps/vscode
        ./apps/kimi-inspect
        ./apps/vis
        ./apps/vis/server
        ./apps/vis/web
        ./docs
      ];

      workspaceNames = [
        "@moonshot-ai/acp-server"
        "@moonshot-ai/agent-core-v2"
        "@moonshot-ai/kap-server"
        "@moonshot-ai/kosong"
        "@moonshot-ai/migration-legacy"
        "@moonshot-ai/minidb"
        "@moonshot-ai/kimi-code-sdk"
        "@moonshot-ai/kimi-code-oauth"
        "@moonshot-ai/klient"
        "@moonshot-ai/pi-tui"
        "@moonshot-ai/kimi-code-product"
        "@moonshot-ai/remote-control"
        "@moonshot-ai/session-import"
        "@moonshot-ai/kimi-telemetry"
        "@moonshot-ai/transcript"
        "@moonshot-ai/tree-sitter-bash"
        "@moonshot-ai/kimi-code"
        "kimi-code"
        "@moonshot-ai/kimi-inspect"
        "@moonshot-ai/vis"
        "@moonshot-ai/vis-server"
        "@moonshot-ai/vis-web"
        "kimi-code-docs"
      ];
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          nodejs = nodejsFor pkgs;
          bun = bunFor pkgs;
          appPackageJson = builtins.fromJSON (builtins.readFile ./apps/kimi-code/package.json);
          version = appPackageJson.version;
          nativeTarget =
            if pkgs.stdenv.hostPlatform.isLinux && pkgs.stdenv.hostPlatform.isAarch64 then
              "linux-arm64"
            else if pkgs.stdenv.hostPlatform.isLinux then
              "linux-x64"
            else if pkgs.stdenv.hostPlatform.isDarwin && pkgs.stdenv.hostPlatform.isAarch64 then
              "darwin-arm64"
            else if pkgs.stdenv.hostPlatform.isDarwin then
              "darwin-x64"
            else
              throw "Unsupported Kimi Code native target for ${pkgs.stdenv.hostPlatform.system}";

          kimi-code-src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions (
              [
                ./build
                ./.nvmrc
                ./package.json
                ./bun.lock
                ./bunfig.toml
                ./tsconfig.json
                ./LICENSE
              ]
              ++ workspacePaths
            );
          };

          # Fixed-output derivation: materialize the project's node_modules
          # from the npm registry (the FOD is the only place network access is
          # allowed).
          #
          # Bun's internal cache directory is NOT usable as a FOD output —
          # its extracted-package presence and gzip framing vary between
          # runs. The hoisted node_modules tree, by contrast, is fully
          # determined by bun.lock + the registry tarballs. Lifecycle
          # scripts are skipped here (build artifacts would embed sandbox
          # paths); the main derivation runs the ones that matter on the
          # copied tree.
          bunDeps = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "kimi-code-bun-deps";
            inherit version;

            src = kimi-code-src;

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src pnpmWorkspaces;
              inherit pnpm;
              fetcherVersion = 3;
              hash = "sha256-XLjspHl3+xErXYH5fMW8J8fDB5m1ZF8MkATKh11odo0=";
            };

            nativeBuildInputs = [
              bun
              nodejs
              # TLS trust store for the registry fetch.
              pkgs.cacert
            ];

            dontConfigure = true;
            dontBuild = true;
            # node_modules contains relative symlinks to the workspace
            # members (../../packages/*). They dangle inside this FOD's
            # output by construction and resolve once the main derivation
            # copies the tree into the project root, so skip fixup's
            # noBrokenSymlinks check.
            dontFixup = true;

            installPhase = ''
              runHook preInstall
              export HOME=$TMPDIR
              # NIX_SSL_CERT_FILE is exported automatically by stdenv
              # because cacert is in nativeBuildInputs above.
              bun install --frozen-lockfile --ignore-scripts
              install -d $out && mv node_modules $out/node_modules
              runHook postInstall
            '';

            # The outputHash below pins the hoisted node_modules tree. Every
            # input is pinned (bun.lock, the fileset, nixpkgs), so this FOD
            # only needs recomputing when one of them changes — most recently
            # when the Rust addon left the tree. This box cannot compute it:
            # the hash covers a Linux install (win32/macOS trees differ in
            # their optional native packages), so it has to come from a Nix
            # builder. lib.fakeSha256 forces the next build to fail with
            # "got: sha256-…"; paste that value here.
            outputHashMode = "recursive";
            outputHashAlgo = "sha256";
            outputHash = lib.fakeSha256;
          });

          kimi-code = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "kimi-code";
            inherit version;

            src = kimi-code-src;

            nativeBuildInputs = [
              bun
              nodejs
              pkgs.makeWrapper
              pkgs.python3
              pkgs.gnumake
            ]
            ++ lib.optionals pkgs.stdenv.hostPlatform.isDarwin [
              pkgs.darwin.sigtool
            ];

            dontStrip = true;

            configurePhase = ''
              runHook preConfigure
              export HOME=$TMPDIR
              export npm_config_nodedir=${nodejs}
              cp -a ${bunDeps}/node_modules ./node_modules
              chmod -R u+w ./node_modules
              runHook postConfigure
            '';

            buildPhase = ''
              runHook preBuild
              export KIMI_CODE_BUILD_TARGET=${nativeTarget}
              ${lib.optionalString pkgs.stdenv.hostPlatform.isDarwin ''
                # pkgs.darwin.sigtool's codesign supports `--sign -` (ad-hoc)
                # but not the inspection mode (`-dv`) that 05-verify.mjs runs
                # afterwards. Disable the verify step for the Nix build; the
                # release CI keeps it via the unmodified script.
                substituteInPlace apps/kimi-code/scripts/native/build-bun.mjs \
                  --replace-fail \
                    "await runVerifyStep({ requireGatekeeper: false });" \
                    "// runVerifyStep skipped in nix sandbox (sigtool lacks -dv)"
              ''}
              # The Bun build step embeds the Kimi web assets from
              # apps/kimi-code/dist-web and fails if that directory is
              # missing. The bundle is committed (synced from the code-app
              # repo) — verify it is in place before producing the binary.
              node apps/kimi-code/scripts/check-web-assets.mjs
              (cd apps/kimi-code && bun run build:native:bun)
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              install -Dm755 \
                "apps/kimi-code/dist-native/bin/${nativeTarget}/kimi" \
                "$out/bin/kimi"

              runHook postInstall
            '';

            postInstall = ''
              wrapProgram $out/bin/kimi --prefix PATH : ${lib.makeBinPath [ pkgs.ripgrep pkgs.fd ]}
            '';

            meta = {
              description = "Kimi Code CLI";
              homepage = "https://github.com/MoonshotAI/kimi-code";
              license = lib.licenses.mit;
              mainProgram = "kimi";
              platforms = systems;
            };
          });
        in
        {
          inherit kimi-code;
          default = kimi-code;
        }
      );

      apps = forAllSystems (pkgs: {
        kimi-code = {
          type = "app";
          program = "${self.packages.${pkgs.system}.kimi-code}/bin/kimi";
        };
        default = self.apps.${pkgs.system}.kimi-code;
      });

      devShells = forAllSystems (
        pkgs:
        let
          nodejs = nodejsFor pkgs;
          bun = bunFor pkgs;
          zig = zigFor pkgs;
        in
        pkgs.mkShell {
          packages = [
            nodejs
            bun
            zig
            pkgs.ripgrep
            pkgs.fd
          ];
        }
      );
    };
}
