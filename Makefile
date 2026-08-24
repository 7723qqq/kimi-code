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

rust-build:
	cargo build --release -p kimi-agent

rust-check:
	cargo check -p kimi-agent

rust-test:
	cargo test -p kimi-agent
	cargo run -p kimi-agent -- --test

## vis

vis:
	bun run vis
