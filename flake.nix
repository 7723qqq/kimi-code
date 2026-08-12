{
  description = "Kimi Code CLI";

  inputs = {
    # Pinned to the 25.11 release channel because nixpkgs-unstable currently
    # ships nodejs_24 = 24.14.1, which trips the >= 24.15.0 floor that the
    # kimi-web build enforces (see apps/kimi-web/package.json engines).
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

      pnpmFor =
        pkgs:
        pkgs.pnpm_10.override {
          nodejs = nodejsFor pkgs;
        };

      # -------------------------------------------------------------------
      # Workspace members (kept in sync with pnpm-workspace.yaml).
      #
      # HARD REQUIREMENT: whenever you add or remove a workspace package,
      # you MUST update both lists below. Missing a path will break the Nix
      # build (src fileset silently drops files); missing a name will break
      # pnpmConfigHook (dependencies for that workspace won't be fetched).
      # -------------------------------------------------------------------
      workspacePaths = [
        ./packages/i18n-shared
        ./packages/kimi-native-tools
        ./packages/kimi-agent
        ./packages/kimi-code-rust-bin
        ./packages/server
        ./apps/kimi-code
        ./apps/vscode
        ./apps/kimi-inspect
        ./apps/kimi-web
        ./apps/vis
        ./apps/vis/server
        ./apps/vis/web
        ./docs
      ];

      workspaceNames = [
        "@moonshot-ai/i18n-shared"
        "@moonshot-ai/kimi-native-tools"
        "@moonshot-ai/kimi-agent"
        "@moonshot-ai/kimi-code-rust"
        "@moonshot-ai/server"
        "@moonshot-ai/kimi-code"
        "kimi-code"
        "@moonshot-ai/kimi-inspect"
        "@moonshot-ai/kimi-web"
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
          pnpm = pnpmFor pkgs;
          appPackageJson = builtins.fromJSON (builtins.readFile ./apps/kimi-code/package.json);

          kimi-code = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "kimi-code";
            version = appPackageJson.version;

            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions (
                [
                  ./build
                  ./.npmrc
                  ./.nvmrc
                  ./package.json
                  ./pnpm-lock.yaml
                  ./pnpm-workspace.yaml
                  ./tsconfig.json
                  ./vitest.config.ts
                  ./LICENSE
                  ./Cargo.toml
                  ./Cargo.lock
                  ./crates
                ]
                ++ workspacePaths
              );
            };

            pnpmWorkspaces = [ "." ] ++ workspaceNames;

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src pnpmWorkspaces;
              inherit pnpm;
              fetcherVersion = 3;
              hash = "sha256-+pzJfoWJwVXIUU8oc56LVpfNjSY6MABID5g11Cm92xw=";
            };

            nativeBuildInputs = [
              nodejs
              pnpm
              (pkgs.pnpmConfigHook.override { inherit pnpm; })
              pkgs.makeWrapper
              pkgs.rustc
              pkgs.cargo
            ];

            buildPhase = ''
              runHook preBuild
              # Inject the npm distribution version so `kimi upgrade` compares
              # against the published package correctly.
              export KIMI_CODE_VERSION=${finalAttrs.version}
              cargo build --release -p kimi-cli -p kimi-server-transport --bin kimi-server-serve
              pnpm --filter=@moonshot-ai/kimi-web run build
              node apps/kimi-code/scripts/copy-web-assets.mjs
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              install -Dm755 \
                "target/release/kimi" \
                "$out/bin/kimi"
              install -Dm755 \
                "target/release/kimi-server-serve" \
                "$out/bin/kimi-server-serve"
              mkdir -p "$out/share/kimi-code"
              cp -r apps/kimi-code/dist-web "$out/share/kimi-code/dist-web"

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

      devShells = forAllSystems (pkgs: {
        default =
          let
            nodejs = nodejsFor pkgs;
            pnpm = pnpmFor pkgs;
          in
          pkgs.mkShell {
            packages = [
              nodejs
              pnpm
              pkgs.ripgrep
              pkgs.fd
            ];
          };
      });
    };
}
