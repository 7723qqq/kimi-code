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

          # Fixed-output derivation: populate Bun's package cache from the
          # registry (the only place network access is allowed). The main
          # derivation replays the install offline from this cache.
          bunDeps = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "kimi-code-bun-deps";
            inherit version;

            src = kimi-code-src;

            impureEnvVars = lib.fetchers.proxyImpureEnvVars;

            nativeBuildInputs = [ bun ];

            dontConfigure = true;
            dontBuild = true;

            installPhase = ''
              runHook preInstall
              export HOME=$TMPDIR
              export BUN_INSTALL_CACHE_DIR=$out
              bun install --frozen-lockfile --ignore-scripts
              runHook postInstall
            '';

            # Update via the fake-hash dance: set to lib.fakeSha256, build,
            # paste the "got:" hash reported by Nix.
            outputHashMode = "recursive";
            outputHashAlgo = "sha256";
            outputHash = "sha256-/l9+6gLtsShbsVCDuf/zHzNbzM16K+IwwNLRykbBX4w=";
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
              export BUN_INSTALL_CACHE_DIR=${bunDeps}
              export npm_config_nodedir=${nodejs}
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
              # Replay the install offline from the FOD cache; this pass runs
              # the trusted lifecycle scripts (node-pty/esbuild native builds).
              bun install --frozen-lockfile
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
