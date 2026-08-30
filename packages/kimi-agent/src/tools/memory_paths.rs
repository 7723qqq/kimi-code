//! Memory file-layout pure functions, ported from the v2 memory feature
//! (`agent-core-v2/src/app/memory/memoryPaths.ts`, plus the
//! `sanitizeFileName` / `buildRelPath` helpers from
//! `agent-core-v2/src/app/memory/tools/memoryTool.ts`). All functions are
//! side-effect free and mirror v2 semantics: the project id is derived from
//! the cwd via SHA-256, memory types are detected from markdown frontmatter
//! or headings, titles come from the first H1 (or the file name), snippets
//! are built around the first case-insensitive query hit, and relative
//! paths follow the `memory/global|projects|sessions/` layout.
//!
//! SHA-256 (FIPS 180-4) is implemented inline because the crate has no
//! crypto dependency; it is only used for the 12-hex project id.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;

/// Memory scope, mirroring v2 `MemoryScope`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryScope {
    Global,
    Project,
    Session,
}

impl MemoryScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project => "project",
            Self::Session => "session",
        }
    }
}

/// Memory entry type, mirroring v2 `MemoryType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryType {
    Note,
    Decision,
    Pattern,
    Lesson,
    Reference,
}

impl MemoryType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Decision => "decision",
            Self::Pattern => "pattern",
            Self::Lesson => "lesson",
            Self::Reference => "reference",
        }
    }

    pub fn parse_type(s: &str) -> Option<Self> {
        match s {
            "note" => Some(Self::Note),
            "decision" => Some(Self::Decision),
            "pattern" => Some(Self::Pattern),
            "lesson" => Some(Self::Lesson),
            "reference" => Some(Self::Reference),
            _ => None,
        }
    }
}

/// Parsed relative memory path, mirroring v2 `parseMemoryPath`'s return
/// shape: `global/foo.md` → global with file name `foo.md`,
/// `projects/abc123/foo.md` → project with scope id `abc123`, and
/// `sessions/xyz/foo.md` → session with scope id `xyz`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedMemoryPath {
    pub scope: MemoryScope,
    pub scope_id: String,
    pub file_name: String,
}

/// Derive the project id from a cwd: the first 12 hex chars of the SHA-256
/// digest of the cwd (v2 `projectIdFromCwd`).
pub fn project_id_from_cwd(cwd: &str) -> String {
    sha256_hex(cwd)[..12].to_string()
}

/// The memory root directory under a home dir (v2 `memoryDir`).
pub fn memory_dir(home_dir: &Path) -> PathBuf {
    home_dir.join("memory")
}

/// The scope directory under a memory base (v2 `scopeDir`): `global/` for
/// the global scope, `projects/<scopeId>/` for projects, and
/// `sessions/<scopeId>/` for sessions.
pub fn scope_dir(base: &Path, scope: MemoryScope, scope_id: &str) -> PathBuf {
    match scope {
        MemoryScope::Global => base.join("global"),
        MemoryScope::Project => base.join("projects").join(scope_id),
        MemoryScope::Session => base.join("sessions").join(scope_id),
    }
}

/// Parse a relative memory path into scope components (v2
/// `parseMemoryPath`). Returns `None` for paths that do not start with a
/// known scope root or that lack the required scope id segment.
pub fn parse_memory_path(rel_path: &str) -> Option<ParsedMemoryPath> {
    let parts: Vec<&str> = rel_path.split('/').collect();
    if parts.len() < 2 {
        return None;
    }
    match parts[0] {
        "global" => Some(ParsedMemoryPath {
            scope: MemoryScope::Global,
            scope_id: String::new(),
            file_name: parts[1..].join("/"),
        }),
        "projects" if parts.len() >= 3 => Some(ParsedMemoryPath {
            scope: MemoryScope::Project,
            scope_id: parts[1].to_string(),
            file_name: parts[2..].join("/"),
        }),
        "sessions" if parts.len() >= 3 => Some(ParsedMemoryPath {
            scope: MemoryScope::Session,
            scope_id: parts[1].to_string(),
            file_name: parts[2..].join("/"),
        }),
        _ => None,
    }
}

/// Extract a title from markdown content — the first H1 heading, or the
/// file name with a trailing `.md` stripped (v2 `extractTitle`). The H1
/// regex mirrors JS semantics: `.` excludes `\r` / `\u2028` / `\u2029`,
/// and a trailing `\r` (CRLF) is allowed before the line end.
pub fn extract_title(body: &str, file_name: &str) -> String {
    static H1_RE: OnceLock<Regex> = OnceLock::new();
    let re = H1_RE.get_or_init(|| {
        Regex::new(r"(?m)^#\s+([^\r\n\u{2028}\u{2029}]+)\r?$").expect("static H1 regex")
    });
    if let Some(caps) = re.captures(body)
        && let Some(m) = caps.get(1)
    {
        return m.as_str().trim().to_string();
    }
    strip_md_suffix(file_name).to_string()
}

/// Detect the memory type from markdown frontmatter (`type:` key) or a
/// `## <type>` heading; falls back to `note` (v2 `detectType`). The
/// frontmatter match is case-sensitive and the heading match is
/// case-insensitive, exactly like v2.
pub fn detect_type(body: &str) -> MemoryType {
    static FM_RE: OnceLock<Regex> = OnceLock::new();
    let fm = FM_RE.get_or_init(|| {
        Regex::new(r"(?m)^---[\s\S]*?type:\s*([A-Za-z0-9_]+)").expect("static frontmatter regex")
    });
    if let Some(caps) = fm.captures(body)
        && let Some(t) = caps.get(1).and_then(|m| MemoryType::parse_type(m.as_str()))
    {
        return t;
    }
    static H_RE: OnceLock<Regex> = OnceLock::new();
    let h = H_RE.get_or_init(|| {
        Regex::new(r"(?im)^##\s+(decision|pattern|lesson|reference)").expect("static heading regex")
    });
    if let Some(caps) = h.captures(body)
        && let Some(t) = caps
            .get(1)
            .and_then(|m| MemoryType::parse_type(&m.as_str().to_lowercase()))
    {
        return t;
    }
    MemoryType::Note
}

/// Build a snippet from the body around the first case-insensitive query
/// hit: 40 chars before and 80 after, with `...` markers at the cut edges
/// (v2 `buildSnippet` with the default `maxLen = 200`).
pub fn build_snippet(body: &str, query: &str) -> String {
    build_snippet_with_max_len(body, query, 200)
}

/// [`build_snippet`] with an explicit max length for the no-match fallback
/// (v2 `buildSnippet(body, query, maxLen)`).
pub fn build_snippet_with_max_len(body: &str, query: &str, max_len: usize) -> String {
    let lower_body = body.to_lowercase();
    let lower_query = query.to_lowercase();
    let Some(idx) = lower_body.find(&lower_query) else {
        return body
            .chars()
            .take(max_len)
            .collect::<String>()
            .trim()
            .to_string();
    };
    // Byte offsets into `lower_body` are applied to `body`; for ASCII
    // content (the realistic case) they coincide with v2's code-unit
    // offsets. The boundaries are clamped so a length-changing lowercase
    // (e.g. `İ` → `i̇`) can never panic mid-char.
    let start = floor_char_boundary(body, idx.saturating_sub(40));
    let end = floor_char_boundary(body, (idx + lower_query.len() + 80).min(body.len()));
    let mut snippet = body[start..end].trim().to_string();
    if start > 0 {
        snippet.insert_str(0, "...");
    }
    if end < body.len() {
        snippet.push_str("...");
    }
    snippet
}

/// Sanitize a user-supplied file name: trim, reject empty names and any
/// name containing `/`, `\`, or `..`, and append `.md` unless already
/// present (v2 `sanitizeFileName` + `normalizeFileName`).
pub fn sanitize_file_name(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
    {
        return None;
    }
    Some(normalize_file_name(trimmed))
}

/// Build the relative memory path for a scope (v2 `buildRelPath`).
pub fn build_rel_path(scope: MemoryScope, scope_id: &str, file_name: &str) -> String {
    match scope {
        MemoryScope::Global => format!("global/{file_name}"),
        MemoryScope::Project => format!("projects/{scope_id}/{file_name}"),
        MemoryScope::Session => format!("sessions/{scope_id}/{file_name}"),
    }
}

fn normalize_file_name(name: &str) -> String {
    if name.ends_with(".md") {
        name.to_string()
    } else {
        format!("{name}.md")
    }
}

/// Strip a trailing `.md` case-insensitively, mirroring v2's
/// `fileName.replace(/\.md$/i, '')`.
fn strip_md_suffix(file_name: &str) -> &str {
    if file_name.len() >= 3 && file_name[file_name.len() - 3..].eq_ignore_ascii_case(".md") {
        &file_name[..file_name.len() - 3]
    } else {
        file_name
    }
}

fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

/// SHA-256 (FIPS 180-4), implemented inline because the crate has no crypto
/// dependency. Only used to derive the 12-hex project id from a cwd.
fn sha256(input: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut state: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let bit_len = (input.len() as u64).wrapping_mul(8);
    let mut msg = Vec::with_capacity(input.len() + 72);
    msg.extend_from_slice(input);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    for block in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, chunk) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
        state[5] = state[5].wrapping_add(f);
        state[6] = state[6].wrapping_add(g);
        state[7] = state[7].wrapping_add(h);
    }
    let mut out = [0u8; 32];
    for (i, word) in state.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn sha256_hex(input: &str) -> String {
    sha256(input.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sha256_known_vectors() {
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        assert_eq!(
            sha256_hex(&"a".repeat(64)),
            "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"
        );
        assert_eq!(
            sha256_hex(&"a".repeat(65)),
            "635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0"
        );
    }

    #[test]
    fn test_project_id_from_cwd_golden() {
        assert_eq!(project_id_from_cwd("G:/kimi/kimi-code"), "28c0fe7f6661");
        assert_eq!(project_id_from_cwd("/home/user/project"), "9dad1e4e08b0");
    }

    #[test]
    fn test_project_id_shape_and_uniqueness() {
        let id = project_id_from_cwd("/some/cwd");
        assert_eq!(id.len(), 12);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(project_id_from_cwd("/some/cwd"), id);
        assert_ne!(
            project_id_from_cwd("/some/cwd"),
            project_id_from_cwd("/some/other")
        );
    }

    #[test]
    fn test_memory_dir() {
        assert_eq!(
            memory_dir(Path::new("/home/user")),
            PathBuf::from("/home/user/memory")
        );
    }

    #[test]
    fn test_scope_dir() {
        let base = Path::new("/home/user/memory");
        assert_eq!(
            scope_dir(base, MemoryScope::Global, ""),
            PathBuf::from("/home/user/memory/global")
        );
        assert_eq!(
            scope_dir(base, MemoryScope::Project, "abc123"),
            PathBuf::from("/home/user/memory/projects/abc123")
        );
        assert_eq!(
            scope_dir(base, MemoryScope::Session, "xyz"),
            PathBuf::from("/home/user/memory/sessions/xyz")
        );
    }

    #[test]
    fn test_parse_memory_path_global() {
        let p = parse_memory_path("global/foo.md").unwrap();
        assert_eq!(p.scope, MemoryScope::Global);
        assert_eq!(p.scope_id, "");
        assert_eq!(p.file_name, "foo.md");
        let p = parse_memory_path("global/a/b.md").unwrap();
        assert_eq!(p.file_name, "a/b.md");
    }

    #[test]
    fn test_parse_memory_path_project_and_session() {
        let p = parse_memory_path("projects/abc123/foo.md").unwrap();
        assert_eq!(p.scope, MemoryScope::Project);
        assert_eq!(p.scope_id, "abc123");
        assert_eq!(p.file_name, "foo.md");
        let p = parse_memory_path("projects/abc123/a/b.md").unwrap();
        assert_eq!(p.file_name, "a/b.md");
        let p = parse_memory_path("sessions/xyz/foo.md").unwrap();
        assert_eq!(p.scope, MemoryScope::Session);
        assert_eq!(p.scope_id, "xyz");
        assert_eq!(p.file_name, "foo.md");
    }

    #[test]
    fn test_parse_memory_path_invalid() {
        assert!(parse_memory_path("").is_none());
        assert!(parse_memory_path("global").is_none());
        assert!(parse_memory_path("projects").is_none());
        assert!(parse_memory_path("projects/abc123").is_none());
        assert!(parse_memory_path("sessions/xyz").is_none());
        assert!(parse_memory_path("foo/bar.md").is_none());
        assert!(parse_memory_path("PROJECTS/abc/foo.md").is_none());
        assert!(parse_memory_path("/global/foo.md").is_none());
    }

    #[test]
    fn test_parse_memory_path_edge_segments() {
        let p = parse_memory_path("projects//foo.md").unwrap();
        assert_eq!(p.scope_id, "");
        let p = parse_memory_path("global/").unwrap();
        assert_eq!(p.file_name, "");
    }

    #[test]
    fn test_extract_title_h1() {
        assert_eq!(extract_title("# Title\nbody", "file.md"), "Title");
        assert_eq!(extract_title("body\n# Second", "file.md"), "Second");
        assert_eq!(extract_title("## Not H1\n# Real", "file.md"), "Real");
        assert_eq!(extract_title("#  Spaced  \nbody", "file.md"), "Spaced");
        assert_eq!(extract_title("# Title\r\nbody", "file.md"), "Title");
    }

    #[test]
    fn test_extract_title_falls_back_to_file_name() {
        assert_eq!(extract_title("no heading", "file.md"), "file");
        assert_eq!(extract_title("no heading", "file.MD"), "file");
        assert_eq!(extract_title("no heading", "file"), "file");
        assert_eq!(extract_title("#", "file.md"), "file");
        assert_eq!(extract_title("## h2 only", "file.md"), "file");
    }

    #[test]
    fn test_detect_type_frontmatter() {
        assert_eq!(
            detect_type("---\ntype: decision\n---\nbody"),
            MemoryType::Decision
        );
        assert_eq!(
            detect_type("---\ntitle: x\ntype: lesson\n---"),
            MemoryType::Lesson
        );
        assert_eq!(detect_type("---\ntype:note\n---"), MemoryType::Note);
        assert_eq!(detect_type("x\n---\ntype: pattern"), MemoryType::Pattern);
    }

    #[test]
    fn test_detect_type_frontmatter_invalid_falls_through() {
        assert_eq!(
            detect_type("---\ntype: invalid\n---\n## decision"),
            MemoryType::Decision
        );
        assert_eq!(detect_type("---\ntype: Decision\n---"), MemoryType::Note);
        assert_eq!(detect_type("---\nType: decision\n---"), MemoryType::Note);
    }

    #[test]
    fn test_detect_type_heading() {
        assert_eq!(detect_type("## decision\nbody"), MemoryType::Decision);
        assert_eq!(detect_type("## Decision"), MemoryType::Decision);
        assert_eq!(detect_type("## pattern"), MemoryType::Pattern);
        assert_eq!(detect_type("## lesson"), MemoryType::Lesson);
        assert_eq!(detect_type("## reference"), MemoryType::Reference);
        assert_eq!(detect_type("## decision-making"), MemoryType::Decision);
        assert_eq!(detect_type("## decision\r\nbody"), MemoryType::Decision);
    }

    #[test]
    fn test_detect_type_falls_back_to_note() {
        assert_eq!(detect_type("plain body"), MemoryType::Note);
        assert_eq!(detect_type("## note"), MemoryType::Note);
        assert_eq!(detect_type("### decision"), MemoryType::Note);
        assert_eq!(detect_type("##decision"), MemoryType::Note);
    }

    #[test]
    fn test_build_snippet_match_with_ellipses() {
        let body = format!("{}needle{}", "x".repeat(100), "y".repeat(100));
        let snippet = build_snippet(&body, "needle");
        assert!(snippet.starts_with("..."));
        assert!(snippet.ends_with("..."));
        assert!(snippet.contains("needle"));
        assert_eq!(snippet.len(), 3 + 40 + 6 + 80 + 3);
    }

    #[test]
    fn test_build_snippet_match_at_edges() {
        let body = "needle at the start with a long tail ".repeat(3);
        let snippet = build_snippet(&body, "needle");
        assert!(!snippet.starts_with("..."));
        assert!(snippet.ends_with("..."));
        let body = format!("{}needle", "x".repeat(100));
        let snippet = build_snippet(&body, "needle");
        assert!(snippet.starts_with("..."));
        assert!(!snippet.ends_with("..."));
    }

    #[test]
    fn test_build_snippet_no_match() {
        let body = "  short body without the query  ";
        assert_eq!(build_snippet(body, "zzz"), "short body without the query");
        let body = "x".repeat(300);
        let snippet = build_snippet(&body, "zzz");
        assert_eq!(snippet.len(), 200);
        assert_eq!(snippet, "x".repeat(200));
    }

    #[test]
    fn test_build_snippet_case_insensitive_and_empty_query() {
        let body = "The quick brown FOX jumps over the lazy dog";
        assert!(build_snippet(body, "fox").contains("FOX"));
        let body = "x".repeat(100);
        let snippet = build_snippet(&body, "");
        assert_eq!(snippet.len(), 83); // 80 chars + "..."
    }

    #[test]
    fn test_build_snippet_max_len_zero() {
        assert_eq!(build_snippet_with_max_len("abc", "zzz", 0), "");
    }

    #[test]
    fn test_build_snippet_non_ascii_no_panic() {
        let body = "记忆：决策记录\n# 标题\nneedle 内容";
        let snippet = build_snippet(body, "needle");
        assert!(snippet.contains("needle"));
    }

    #[test]
    fn test_sanitize_file_name() {
        assert_eq!(sanitize_file_name("foo"), Some("foo.md".to_string()));
        assert_eq!(sanitize_file_name("foo.md"), Some("foo.md".to_string()));
        assert_eq!(sanitize_file_name(" foo "), Some("foo.md".to_string()));
        assert_eq!(sanitize_file_name("foo.md "), Some("foo.md".to_string()));
        assert_eq!(sanitize_file_name("FOO.MD"), Some("FOO.MD.md".to_string()));
    }

    #[test]
    fn test_sanitize_file_name_rejects() {
        assert_eq!(sanitize_file_name(""), None);
        assert_eq!(sanitize_file_name("   "), None);
        assert_eq!(sanitize_file_name("a/b.md"), None);
        assert_eq!(sanitize_file_name("a\\b.md"), None);
        assert_eq!(sanitize_file_name(".."), None);
        assert_eq!(sanitize_file_name("a..b"), None);
        assert_eq!(sanitize_file_name("../x"), None);
    }

    #[test]
    fn test_build_rel_path() {
        assert_eq!(
            build_rel_path(MemoryScope::Global, "", "foo.md"),
            "global/foo.md"
        );
        assert_eq!(
            build_rel_path(MemoryScope::Project, "abc123", "foo.md"),
            "projects/abc123/foo.md"
        );
        assert_eq!(
            build_rel_path(MemoryScope::Session, "xyz", "foo.md"),
            "sessions/xyz/foo.md"
        );
    }
}
