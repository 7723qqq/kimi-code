{
  description = "Kimi Code CLI";

  inputs = {
    # Pinned to the 25.11 release channel because nixpkgs-unstable currently
    # ships nodejs_24 = 24.14.1, which trips the >= 24.15.0 floor that the
    # native SEA build enforces (see apps/kimi-code/scripts/native/build.mjs).
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
      bunVersion = "1.4.0";
      bunSources = {
        "aarch64-darwin" = {
          url = "bun-darwin-aarch64.zip";
          sourceRoot = "bun-darwin-aarch64";
          hash = "sha256-xmnpf2Fk4cluBwF0jbmN+ndJKQjL2DlMdVcTSnNd44E=";
        };
        "x86_64-darwin" = {
          url = "bun-darwin-x64-baseline.zip";
          sourceRoot = "bun-darwin-x64-baseline";
          hash = "sha256-2pufG0unZsbymXEfON+qmGI+HtnECJaqU9uAPFLsH6A=";
        };
        "aarch64-linux" = {
          url = "bun-linux-aarch64.zip";
          sourceRoot = null;
          hash = "sha256-SxozLuhhmD65O8/m93D/+U4+MbLDiL2uo8jtNeWO7Q4=";
        };
        "x86_64-linux" = {
          url = "bun-linux-x64.zip";
          sourceRoot = null;
          hash = "sha256-LQP7X7g6yLVnrKCigbLOGhoZ1Ij1bClo2Iw/Jekv5FI=";
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
        ./packages/kaos
        ./packages/kap-server
        ./packages/kimi-native-tools
        ./packages/kimi-agent
        ./packages/klient
        ./packages/kosong
        ./packages/migration-legacy
        ./packages/minidb
        ./packages/node-sdk
        ./packages/oauth
        ./packages/pi-tui
        ./packages/protocol
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
                ./patches
                ./tsconfig.json
                ./vitest.config.ts
                ./LICENSE
              ]
              ++ workspacePaths
            );
          };

          # Fixed-output derivation: materialize the project's node_modules
          # from the npm registry and the Rust crate vendor directory for
          # kimi-native-tools from crates.io (the FOD is the only place
          # network access is allowed).
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

            impureEnvVars = lib.fetchers.proxyImpureEnvVars;

            nativeBuildInputs = [
              bun
              nodejs
              # cargo vendor needs a CA bundle for crates.io and may fall
              # back to the git index protocol.
              pkgs.cacert
              pkgs.git
              pkgs.cargo
              pkgs.rustc
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
              mv node_modules $out/node_modules
              # Vendor the Rust crates for both napi packages so the main
              # derivation can compile offline (CARGO_NET_OFFLINE=true).
              # NOTE: do NOT let cargo write its suggested config here —
              # with an absolute $out target it would embed this store
              # path, which FOD outputs must never reference. The main
              # derivation generates the config itself.
              cd packages/kimi-native-tools
              cargo vendor --locked $out/vendor > /dev/null
              cd ../kimi-agent
              cargo vendor --locked $out/vendor-agent > /dev/null
              cd -
              runHook postInstall
            '';
              runHook postInstall
            '';

            # Update via the fake-hash dance: set to lib.fakeSha256, build,
            # paste the "got:" hash reported by Nix.
            outputHashMode = "recursive";
            outputHashAlgo = "sha256";
            outputHash = "sha256-Ktv53GfKGM7DyP4JyIdK1Uc3c5zAl+42nQgZq1JZk8Q=";
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
              # kimi-native-tools' .node addon is compiled from source in
              # the sandbox (napi-rs → cargo); the SEA asset collector
              # refuses to proceed without it.
              pkgs.cargo
              pkgs.rustc
            ]
            # node-gyp (node-pty's install script) compiles against the
            # headers shipped with the pinned Node instead of downloading
            # them from nodejs.org (no network outside the FOD).
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
              # Wire the vendored crates for the offline napi build: the
              # main derivation may reference store paths, so point cargo
              # at the FOD's vendor dir with an absolute path.
              mkdir -p packages/kimi-native-tools/.cargo
              cat > packages/kimi-native-tools/.cargo/config.toml <<EOF
[source.crates-io]
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "${bunDeps}/vendor"
EOF
              mkdir -p packages/kimi-agent/.cargo
              cat > packages/kimi-agent/.cargo/config.toml <<EOF
[source.crates-io]
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "${bunDeps}/vendor-agent"
EOF
              export CARGO_NET_OFFLINE=true
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
                substituteInPlace apps/kimi-code/scripts/native/build.mjs \
                  --replace-fail \
                    "await runVerifyStep({ requireGatekeeper: false });" \
                    "// runVerifyStep skipped in nix sandbox (sigtool lacks -dv)"
              ''}
              # Build the Rust native addon from source: its .node is a
              # required SEA asset (collected by assets.mjs below). Invoke
              # napi's JS entry directly — its bin shim uses
              # `#!/usr/bin/env`, absent in the sandbox.
              (cd packages/kimi-native-tools && node ../../node_modules/@napi-rs/cli/dist/cli.js build --platform --release --dts target/napi-generated.d.ts)
              # kimi-agent is the second napi addon collected as a SEA asset.
              (cd packages/kimi-agent && node ../../node_modules/@napi-rs/cli/dist/cli.js build --platform --release --dts target/napi-generated.d.ts)
              # Run the one lifecycle script whose output the artifact
              # needs: node-pty's prebuild/native build (the FOD installed
              # with --ignore-scripts). node-gyp compiles against the
              # pinned Node's own headers and comes from the hoisted root
              # node_modules/.bin. esbuild resolves its binary from the
              # hoisted @esbuild/<platform> package without a script;
              # protobufjs/ssh2 work scriptless.
              export PATH="$PWD/node_modules/.bin:$PATH"
              # Call node-gyp's JS entry directly: its bin shim uses
              # `#!/usr/bin/env node`, and /usr/bin/env does not exist in
              # the sandbox.
              (cd node_modules/node-pty && node ../../node_modules/node-gyp/bin/node-gyp.js rebuild)
              (cd node_modules/node-pty && node scripts/post-install.js)
              # The SEA blob step embeds the Kimi web assets from
              # apps/kimi-code/dist-web and fails if that directory is
              # missing. The bundle is committed (synced from the code-app
              # repo) — verify it is in place before producing the binary.
              node apps/kimi-code/scripts/check-web-assets.mjs
              (cd apps/kimi-code && bun run build:native:sea)
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
        in
        pkgs.mkShell {
          packages = [
            nodejs
            bun
            pkgs.ripgrep
            pkgs.fd
          ];
        }
      );
    };
}
