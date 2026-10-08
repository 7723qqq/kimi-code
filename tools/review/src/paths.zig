const std = @import("std");

/// Directory names no check descends into. Vendored dependencies, build
/// output and the reference-material scratch tree all live here, and every
/// check must agree on them: a check that walks `dist/` reports on generated
/// code, and one that walks `node_modules/` reports on other people's.
pub const SKIP_DIRS = [_][]const u8{
    "node_modules", "dist", "dist-web", "dist-native", "coverage",
    ".git",         ".zig-cache", "zig-out", "target", "参考目录",
};

/// A file under `packages/` or `apps/`, the two trees the checks reason about.
///
/// `scripts/`, `tools/` and the docs are deliberately outside: they are not
/// product source, and the questions the checks ask (is this export reachable,
/// does this tool name resolve) only have meaning inside a package.
pub fn isPackageOrApp(rel: []const u8) bool {
    return std.mem.startsWith(u8, rel, "packages/") or std.mem.startsWith(u8, rel, "apps/");
}

/// A TypeScript declaration file, which the lexer-based checks skip: it
/// declares shapes rather than behaviour, so an export here is a signature
/// other code is expected to satisfy, not a function to call.
pub fn isDeclaration(rel: []const u8) bool {
    return std.mem.endsWith(u8, rel, ".d.ts");
}

/// A file under a `src/` directory.
pub fn isUnderSrc(rel: []const u8) bool {
    return std.mem.indexOf(u8, rel, "/src/") != null;
}

/// A test file, by directory or by suffix. Both shapes appear: some packages
/// keep a top-level `test/` tree, others colocate `*.test.ts` beside the code.
pub fn isTestSource(rel: []const u8) bool {
    if (std.mem.indexOf(u8, rel, "/test/") != null) return true;
    if (std.mem.endsWith(u8, rel, ".test.ts") or std.mem.endsWith(u8, rel, ".test.tsx")) return true;
    if (std.mem.endsWith(u8, rel, ".spec.ts") or std.mem.endsWith(u8, rel, ".spec.tsx")) return true;
    return false;
}

/// Production source: `packages/*/src/**` or `apps/*/src/**`, tests excluded.
///
/// Used by the checks whose question is "does the shipped code reach this".
/// A symbol its own test calls is still unused by the product, so counting the
/// test reference would answer a different question.
pub fn isProductionSource(rel: []const u8) bool {
    if (!isPackageOrApp(rel)) return false;
    if (!isUnderSrc(rel)) return false;
    if (isTestSource(rel)) return false;
    if (isDeclaration(rel)) return false;
    return true;
}

/// Every TypeScript file in a package or app, tests included.
///
/// The orphan-export check needs this shape rather than `isProductionSource`:
/// it counts what the tests reference, so narrowing to `/src/` would drop the
/// package-root `test/` directories and with them the entire signal.
pub fn isTypeScriptSource(rel: []const u8) bool {
    if (!isPackageOrApp(rel)) return false;
    if (isDeclaration(rel)) return false;
    return true;
}

/// `src/` source that may itself contain tests.
///
/// `silent-catch` reads this rather than `isProductionSource` because a bare
/// `catch {}` swallows errors wherever it sits, test helper or not. Kept as a
/// named predicate so the difference from the other checks is visible instead
/// of accidental.
pub fn isSrcSourceIncludingTests(rel: []const u8) bool {
    if (!isPackageOrApp(rel)) return false;
    if (!isUnderSrc(rel)) return false;
    if (isDeclaration(rel)) return false;
    return true;
}

const testing = std.testing;

test "isPackageOrApp accepts packages and apps and rejects the rest" {
    try testing.expect(isPackageOrApp("packages/kosong/src/index.ts"));
    try testing.expect(isPackageOrApp("apps/kimi-code/src/main.ts"));
    try testing.expect(!isPackageOrApp("scripts/thing.ts"));
    try testing.expect(!isPackageOrApp("tools/review/src/main.zig"));
    try testing.expect(!isPackageOrApp("docs/en/index.md"));
}

test "isTestSource reads both the directory and the suffix shape" {
    try testing.expect(isTestSource("packages/kosong/test/foo.ts"));
    try testing.expect(isTestSource("packages/kosong/src/foo.test.ts"));
    try testing.expect(isTestSource("packages/kosong/src/foo.test.tsx"));
    try testing.expect(isTestSource("packages/kosong/src/foo.spec.ts"));
    try testing.expect(isTestSource("packages/kosong/src/foo.spec.tsx"));
    try testing.expect(!isTestSource("packages/kosong/src/foo.ts"));
    // `latest/` is not a test directory; the match is on the whole segment.
    try testing.expect(!isTestSource("packages/kosong/src/latest/foo.ts"));
}

test "isProductionSource keeps src TypeScript and drops tests and declarations" {
    try testing.expect(isProductionSource("packages/kosong/src/index.ts"));
    try testing.expect(isProductionSource("apps/kimi-code/src/main.tsx"));

    try testing.expect(!isProductionSource("packages/kosong/test/foo.ts"));
    try testing.expect(!isProductionSource("packages/kosong/src/foo.test.ts"));
    try testing.expect(!isProductionSource("packages/kosong/src/foo.spec.ts"));
    try testing.expect(!isProductionSource("packages/kosong/src/types.d.ts"));
    try testing.expect(!isProductionSource("scripts/thing.ts"));
    try testing.expect(!isProductionSource("packages/kosong/README.md"));
}

test "isTypeScriptSource keeps package tests, which the orphan check counts" {
    try testing.expect(isTypeScriptSource("packages/kosong/src/index.ts"));
    try testing.expect(isTypeScriptSource("packages/kosong/test/foo.ts"));
    try testing.expect(!isTypeScriptSource("packages/kosong/src/types.d.ts"));
    try testing.expect(!isTypeScriptSource("scripts/thing.ts"));
}

test "isSrcSourceIncludingTests differs from isProductionSource only on tests" {
    try testing.expect(isSrcSourceIncludingTests("packages/kosong/src/index.ts"));
    try testing.expect(isProductionSource("packages/kosong/src/index.ts"));

    // The whole point of the predicate: a test file under src is in scope here.
    try testing.expect(isSrcSourceIncludingTests("packages/kosong/src/foo.test.ts"));
    try testing.expect(!isProductionSource("packages/kosong/src/foo.test.ts"));

    // Both reject what is outside a package's src.
    try testing.expect(!isSrcSourceIncludingTests("packages/kosong/test/foo.ts"));
    try testing.expect(!isSrcSourceIncludingTests("scripts/thing.ts"));
    try testing.expect(!isSrcSourceIncludingTests("packages/kosong/src/types.d.ts"));
}

test "SKIP_DIRS covers the vendor and build trees" {
    for ([_][]const u8{ "node_modules", "dist", "dist-web", "dist-native", "coverage", ".git", ".zig-cache", "zig-out", "target", "参考目录" }) |name| {
        var found = false;
        for (SKIP_DIRS) |entry| {
            if (std.mem.eql(u8, entry, name)) found = true;
        }
        try testing.expect(found);
    }
}
