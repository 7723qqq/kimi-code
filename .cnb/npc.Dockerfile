# Custom NPC image for kimicode.all/kimicode.
#
# Layered on top of the platform NPC image rather than rebuilt from a bare distro:
# the platform image already carries the NPC runtime (node, @cnbcool/cnb-cli,
# skills, the preset skill set under /root/.agents/skills) and the `/workspace`
# conventions npc:go expects. Rebuilding it from `node:22-bookworm-slim` would
# make the image a moving target for platform changes.
#
# Why this image exists — three defects in `cnbcool/default-npc:latest`, each
# measured inside the NPC container, none of them repository code:
#
#   1. `/root/.gitconfig` sets `commit.gpgsign = true` with
#      `gpg.program = cnb-gpgsign`, a signer that cannot sign in this container.
#      Every `git commit` in a temporary test repository therefore dies with
#      "gpg failed to sign the data". Ten `cargo test --features cli --lib`
#      tests in packages/kimi-agent commit into temp repos and fail on it.
#
#   2. The image ships ripgrep 13.0.0 (169 file types), while
#      packages/kimi-agent/src/tools/grep_types.rs transcribes the ripgrep
#      15.0.0 table (217 file types). The reconciliation test reports
#      "73 of 217 types disagree".
#
#   3. It carries no Rust toolchain. The NPC agent installs cargo/rustc/gcc from
#      scratch on every single run — 30-50 s of the run spent on setup, and the
#      cold build's long silent phases are what trip the default 10-minute
#      no-output timeout (the actual cause of the `cnb-91b-1k37mvioj` abort).
#
# Fixing 1 and 2 here is what makes the `.cnb.yml` `prepare toolchain` stage
# unnecessary; fixing 3 is what gives the run its time back.
#
# Reference: https://docs.cnb.cool/zh/build/npc.md (自定义运行环境)

FROM cnbcool/default-npc:latest

# ripgrep 15.0.0, matching the table in src/tools/grep_types.rs. Installed to
# /usr/bin (not /usr/local/bin) so it replaces the image's 13.0.0 binary in
# place — a shadowing copy would leave `rg --type-list` order/version
# resolution up to PATH precedence.
ARG RIPGREP_VERSION=15.0.0
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) rg_target=x86_64-unknown-linux-musl ;; \
      arm64) rg_target=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/rg.tar.gz \
      "https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-${rg_target}.tar.gz"; \
    tar -xzf /tmp/rg.tar.gz -C /tmp; \
    install -m 0755 "/tmp/ripgrep-${RIPGREP_VERSION}-${rg_target}/rg" /usr/bin/rg; \
    rm -rf /tmp/rg.tar.gz "/tmp/ripgrep-${RIPGREP_VERSION}-${rg_target}"; \
    rg --version | head -1

# Rust toolchain. `packages/kimi-agent` uses `edition = "2024"`, so the floor is
# 1.85; the pinned minor is what the repository is developed against. The
# `rustup` script is run with an explicit toolchain and `--profile minimal`
# (rustc + cargo only) to keep the layer small; `rustfmt`/`clippy` are added
# because `make rust-check` and CI's `cargo clippy` step expect them.
ARG RUST_TOOLCHAIN=1.91.0
ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:$PATH
RUN set -eux; \
    curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh; \
    sh /tmp/rustup-init.sh -y --no-modify-path --profile minimal \
      --default-toolchain "${RUST_TOOLCHAIN}"; \
    rm -f /tmp/rustup-init.sh; \
    rustup component add rustfmt clippy; \
    rustc --version; cargo --version

# gcc/cc, pkg-config and the -dev headers the native crates need. rquickjs
# (the Workflow tool's QuickJS engine) and rusqlite build C sources; on the
# default image the agent had to `apt-get install build-essential` mid-run.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev zlib1g-dev; \
    rm -rf /var/lib/apt/lists/*

# Defect 1. Fixed at the image level instead of per repository, so any test that
# shells out to `git commit` works without the repository knowing about it.
# `--system` writes /etc/gitconfig, which /root/.gitconfig continues to override
# for everything else, so this only turns signing off.
RUN git config --system commit.gpgsign false && \
    git config --system --get commit.gpgsign
