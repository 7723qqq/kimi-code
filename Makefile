.PHONY: prepare build typecheck lint lint-fix lint-pkg sherif test test-watch test-coverage clean changeset version publish release dev vis rust-build rust-check rust-test

## Setup

prepare:
	bun install

## Build

build:
	bun run build

## Quality

typecheck:
	bun run typecheck

lint:
	bun run lint

lint-fix:
	bun run lint:fix

sherif:
	bun run sherif

lint-pkg:
	bun run lint:pkg

## Test

test:
	bun run test

test-watch:
	bun run test:watch

test-coverage:
	bun run test:coverage

## Clean

clean:
	bun run clean

## Release

changeset:
	bun run changeset

version:
	bun run version

publish:
	bun run publish

release: version publish

## Development

dev:
	bun run dev:cli

## Rust binaries

# The `cli` feature gates the kimi-agent-cli binary (it links the napi
# bindings, which only resolve inside a Node process). Every target below
# passes it so the binary is rebuilt rather than left stale.
rust-build:
	cd packages/kimi-agent && cargo build --release --features cli

rust-check:
	cd packages/kimi-agent && cargo check --all-targets --features cli

# `cargo test --features cli` builds the debug binary the integration tests
# spawn; `find_binary` picks the newest artifact, so a bare `cargo test`
# would otherwise exercise whatever was left in target/.
rust-test:
	cd packages/kimi-agent && cargo test --features cli
	cd packages/kimi-agent && cargo run --features cli -- --test

## vis

vis:
	bun run vis
