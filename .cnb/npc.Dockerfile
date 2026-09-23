# Custom NPC image for kimicode.all/kimicode.
#
# Layered on top of the platform NPC image rather than rebuilt from a bare distro:
# the base already carries the NPC runtime (node, @cnbcool/cnb-cli, skills, the
# preset skill set under /root/.agents/skills) and the `/workspace` conventions
# `npc:go` expects. Rebuilding from a bare distro would make this image a moving
# target for platform changes.
#
# Why this image exists — two defects in `cnbcool/default-npc:latest`, both
# measured inside the NPC container and neither of them repository code:
#
#   1. The image ships ripgrep 13.0.0 (169 file types), while
#      packages/kimi-agent/src/tools/grep_types.rs transcribes the ripgrep
#      15.0.0 table (217 file types). The reconciliation test reports
#      "73 of 217 types disagree".
#
#   2. It carries no Rust toolchain. The NPC agent installs cargo/rustc/gcc from
#      scratch on every run — setup alone costs 30-50 s, and the cold build's
#      long silent phases are what tripped the default 10-minute no-output
#      timeout, the actual cause of the `cnb-91b-1k37mvioj` abort.
#
# A third candidate was investigated and rejected. The old `.cnb.yml` also
# disabled `commit.gpgsign` on the theory that `/root/.gitconfig` breaks
# `git commit` in temporary test repositories. That does not reproduce:
# `cnb-gpgsign` is present and signs fine, and a `git commit` in a fresh
# `git init` repo returns 0 with that config in place. So nothing here touches
# signing — turning it off would only hide the real cause if those tests fail
# again.
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
