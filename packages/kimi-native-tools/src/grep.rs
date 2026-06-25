/// Grep tool — content search via the `regex` crate.
///
/// Pure-Rust grep implementation. Supports regex patterns, case-insensitive
/// search, context lines, output modes (content/files_with_matches/count),
/// glob filtering, head_limit, and offset.
///
/// Mirrors `packages/agent-core/src/tools/builtin/file/grep.ts`.
use ignore::WalkBuilder;
use napi_derive::napi;
use regex::RegexBuilder;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::file_type::is_sensitive_file;

/// Default head limit for grep output.
pub const DEFAULT_HEAD_LIMIT: usize = 250;
/// Maximum stdout bytes before truncation.
pub const MAX_OUTPUT_BYTES: usize = 512 * 1024;
/// Default timeout for grep searches (milliseconds). Mirrors the TS tool's
/// `DEFAULT_TIMEOUT_MS = 20_000` cap so a runaway walk does not stall the agent.
pub const DEFAULT_TIMEOUT_MS: u64 = 20_000;

/// VCS metadata directories excluded from every grep walk, regardless of
/// `.gitignore`. Mirrors the TS `VCS_DIRECTORIES_TO_EXCLUDE` list.
const VCS_DIRECTORIES_TO_EXCLUDE: &[&str] = &[".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

/// Result of a grep operation.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct GrepResult {
    pub content: String,
    pub error: Option<String>,
    pub match_count: i32,
    pub file_count: i32,
    /// Sensitive files that matched but were redacted from the output.
    pub filtered_sensitive: Vec<String>,
    /// True if the search terminated because the configured timeout fired.
    pub timed_out: bool,
}

/// Output mode for grep results.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
    Content,
    FilesWithMatches,
    CountMatches,
}

/// Grep configuration.
pub struct GrepConfig {
    pub pattern: String,
    pub path: Option<String>,
    pub glob: Option<String>,
    /// Ripgrep-style file type filter (`ts`, `py`, `rust`, ...). Resolved
    /// against a built-in extension table — see `file_type_to_globs`.
    pub file_type: Option<String>,
    pub output_mode: OutputMode,
    pub case_insensitive: bool,
    pub line_numbers: bool,
    pub after_context: usize,
    pub before_context: usize,
    pub context: usize,
    pub head_limit: usize,
    pub offset: usize,
    pub multiline: bool,
    /// Skip files excluded by `.gitignore` and friends. Defaults to false
    /// (i.e. ignore rules apply) to mirror the TS default.
    pub include_ignored: bool,
    /// Hard wall-clock timeout. `None` disables the deadline.
    pub timeout_ms: Option<u64>,
}

impl Default for GrepConfig {
    fn default() -> Self {
        Self {
            pattern: String::new(),
            path: None,
            glob: None,
            file_type: None,
            output_mode: OutputMode::FilesWithMatches,
            case_insensitive: false,
            line_numbers: true,
            after_context: 0,
            before_context: 0,
            context: 0,
            head_limit: DEFAULT_HEAD_LIMIT,
            offset: 0,
            multiline: false,
            include_ignored: false,
            timeout_ms: Some(DEFAULT_TIMEOUT_MS),
        }
    }
}

/// A single match result.
struct MatchEntry {
    file: PathBuf,
    line_no: usize,
    line: String,
}

/// Search for a pattern in files under the given path.
pub fn grep_search(config: &GrepConfig) -> GrepResult {
    let pattern_str = if config.case_insensitive {
        format!("(?i){}", config.pattern)
    } else {
        config.pattern.clone()
    };

    let regex = match RegexBuilder::new(&pattern_str)
        .multi_line(!config.multiline)
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            return GrepResult {
                content: String::new(),
                error: Some(format!("Invalid regex pattern: {}", e)),
                match_count: 0,
                file_count: 0,
                filtered_sensitive: Vec::new(),
                timed_out: false,
            };
        }
    };

    let search_path = config
        .path
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));

    if !search_path.exists() {
        return GrepResult {
            content: String::new(),
            error: Some(format!("Path does not exist: {}", search_path.display())),
            match_count: 0,
            file_count: 0,
            filtered_sensitive: Vec::new(),
            timed_out: false,
        };
    }

    // If search_path is a file, search just that file.
    if search_path.is_file() {
        return search_single_file(&search_path, &regex, config);
    }

    // Build walker with ignore rules (respects .gitignore, etc.).
    // `include_ignored=true` mirrors `rg --no-ignore`: disable .gitignore /
    // .ignore / parent rules entirely, but VCS metadata + sensitive-file
    // guards stay on because we apply them ourselves below.
    let mut builder = WalkBuilder::new(&search_path);
    builder.hidden(false); // Search hidden files
    if config.include_ignored {
        builder.git_ignore(false);
        builder.git_exclude(false);
        builder.git_global(false);
        builder.ignore(false);
        builder.parents(false);
    } else {
        builder.git_ignore(true);
        builder.git_exclude(true);
    }

    // Apply glob filter (user-supplied).
    let glob_filter = config
        .glob
        .as_deref()
        .and_then(|g| globset::GlobBuilder::new(g).build().ok())
        .map(|g| g.compile_matcher());

    // Apply file-type filter (`type=ts` → match `*.ts`, `*.tsx`, etc.).
    // Mirrors the TS `--type` flag forwarded to ripgrep.
    let file_type_globs: Vec<globset::GlobMatcher> = config
        .file_type
        .as_deref()
        .map(file_type_to_globs)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|pat| globset::GlobBuilder::new(&pat).build().ok())
        .map(|g| g.compile_matcher())
        .collect();

    let effective_before = if config.context > 0 {
        config.context
    } else {
        config.before_context
    };
    let effective_after = if config.context > 0 {
        config.context
    } else {
        config.after_context
    };
    let needs_context = effective_before > 0 || effective_after > 0;

    // Collect results.
    let mut file_matches: BTreeMap<PathBuf, usize> = BTreeMap::new();
    let mut line_matches: Vec<MatchEntry> = Vec::new();
    let mut total_matches: usize = 0;
    let mut output_bytes: usize = 0;
    let mut filtered_sensitive: Vec<String> = Vec::new();
    let mut timed_out = false;
    let deadline = config
        .timeout_ms
        .map(|ms| Instant::now() + Duration::from_millis(ms));

    'walker: for entry in builder.build() {
        // Cooperative timeout check at the start of every yielded entry so a
        // pathologically deep tree cannot block forever.
        if let Some(d) = deadline {
            if Instant::now() >= d {
                timed_out = true;
                break;
            }
        }

        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        // Skip VCS metadata directories entirely. `ignore`'s
        // `git_ignore=true` only honours rules inside the working tree,
        // so we still need to gate these manually — and they must stay
        // gated even when `include_ignored=true`.
        if entry
            .path()
            .components()
            .any(|c| matches!(c.as_os_str().to_str(), Some(name) if VCS_DIRECTORIES_TO_EXCLUDE.contains(&name)))
        {
            continue;
        }

        if !entry.file_type().is_some_and(|ft| ft.is_file()) {
            continue;
        }

        let path = entry.path();

        // Apply user glob filter.
        if let Some(ref matcher) = glob_filter {
            if !matcher.is_match(path) {
                continue;
            }
        }

        // Apply file-type filter when present.
        if !file_type_globs.is_empty() && !file_type_globs.iter().any(|m| m.is_match(path)) {
            continue;
        }

        // Sensitive-file guard. Files matching `.env`, `id_rsa`,
        // `.aws/credentials`, etc. are *recorded* as redacted (so callers
        // can surface the filter notice) but their contents never reach
        // the result content.
        let path_str = path.to_string_lossy();
        if is_sensitive_file(&path_str) {
            filtered_sensitive.push(relativize(path, &search_path));
            continue;
        }

        // Read file content.
        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue, // Skip binary or unreadable files
        };

        // Count matches in this file.
        let file_match_count = regex.find_iter(&content).count();

        if file_match_count == 0 {
            continue;
        }

        file_matches.insert(path.to_path_buf(), file_match_count);
        total_matches += file_match_count;

        // For content mode, collect individual matches.
        if config.output_mode == OutputMode::Content || needs_context {
            let lines: Vec<&str> = content.split('\n').collect();
            let matched_lines: Vec<usize> = lines
                .iter()
                .enumerate()
                .filter(|(_, line)| regex.is_match(line))
                .map(|(i, _)| i)
                .collect();

            for &line_idx in &matched_lines {
                // Per-line deadline check inside large files.
                if let Some(d) = deadline {
                    if Instant::now() >= d {
                        timed_out = true;
                        break 'walker;
                    }
                }

                // Collect context lines.
                let start = if effective_before > 0 {
                    line_idx.saturating_sub(effective_before)
                } else {
                    line_idx
                };
                let end = if effective_after > 0 {
                    (line_idx + effective_after + 1).min(lines.len())
                } else {
                    line_idx + 1
                };

                for (ctx_idx, line_content) in lines.iter().enumerate().take(end).skip(start) {
                    let line_no = ctx_idx + 1;
                    let entry = MatchEntry {
                        file: path.to_path_buf(),
                        line_no,
                        line: line_content.to_string(),
                    };

                    let entry_bytes = format_entry_bytes(&entry, config, &search_path);
                    if output_bytes + entry_bytes > MAX_OUTPUT_BYTES {
                        break;
                    }
                    output_bytes += entry_bytes;
                    line_matches.push(entry);
                }
            }
        }

        if output_bytes > MAX_OUTPUT_BYTES {
            break;
        }
    }

    // Format output.
    let content = match config.output_mode {
        OutputMode::FilesWithMatches => {
            let files: Vec<String> = file_matches
                .keys()
                .skip(config.offset)
                .take(config.head_limit)
                .map(|p| relativize(p, &search_path))
                .collect();
            files.join("\n")
        }
        OutputMode::CountMatches => {
            let mut lines = Vec::new();
            for (path, count) in &file_matches {
                lines.push(format!("{}:{}", relativize(path, &search_path), count));
            }
            lines.join("\n")
        }
        OutputMode::Content => {
            let mut rendered = Vec::new();
            let mut prev_file: Option<PathBuf> = None;

            for entry in &line_matches {
                // Add separator between files.
                if prev_file.as_ref() != Some(&entry.file) {
                    if prev_file.is_some() {
                        rendered.push("--".to_string());
                    }
                    prev_file = Some(entry.file.clone());
                }

                let rel_path = relativize(&entry.file, &search_path);
                if config.line_numbers {
                    rendered.push(format!("{}:{}:{}", rel_path, entry.line_no, entry.line));
                } else {
                    rendered.push(format!("{}:{}", rel_path, entry.line));
                }
            }

            rendered.join("\n")
        }
    };

    GrepResult {
        content,
        error: None,
        match_count: total_matches as i32,
        file_count: file_matches.len() as i32,
        filtered_sensitive,
        timed_out,
    }
}

fn search_single_file(path: &Path, regex: &regex::Regex, config: &GrepConfig) -> GrepResult {
    // Sensitive-file guard: a caller pointing grep directly at `.env`
    // (or similar) should not be able to bypass the redaction the
    // directory walk applies.
    let path_str = path.to_string_lossy();
    if is_sensitive_file(&path_str) {
        return GrepResult {
            content: String::new(),
            error: None,
            match_count: 0,
            file_count: 0,
            filtered_sensitive: vec![path.display().to_string()],
            timed_out: false,
        };
    }

    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            return GrepResult {
                content: String::new(),
                error: Some(format!("Failed to read {}: {}", path.display(), e)),
                match_count: 0,
                file_count: 0,
                filtered_sensitive: Vec::new(),
                timed_out: false,
            };
        }
    };

    let lines: Vec<&str> = content.split('\n').collect();
    let matched_lines: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| regex.is_match(line))
        .map(|(i, _)| i)
        .collect();

    let match_count = matched_lines.len();

    let effective_before = if config.context > 0 {
        config.context
    } else {
        config.before_context
    };
    let effective_after = if config.context > 0 {
        config.context
    } else {
        config.after_context
    };

    let content = match config.output_mode {
        OutputMode::FilesWithMatches => {
            if match_count > 0 {
                path.display().to_string()
            } else {
                String::new()
            }
        }
        OutputMode::CountMatches => {
            format!("{}:{}", path.display(), match_count)
        }
        OutputMode::Content => {
            let mut rendered = Vec::new();
            let mut shown_lines: std::collections::HashSet<usize> = std::collections::HashSet::new();

            for &line_idx in &matched_lines {
                let start = line_idx.saturating_sub(effective_before);
                let end = (line_idx + effective_after + 1).min(lines.len());

                for (ctx_idx, line_content) in lines.iter().enumerate().take(end).skip(start) {
                    if shown_lines.contains(&ctx_idx) {
                        continue;
                    }
                    shown_lines.insert(ctx_idx);
                    let line_no = ctx_idx + 1;
                    if config.line_numbers {
                        rendered.push(format!("{}:{}", line_no, line_content));
                    } else {
                        rendered.push(line_content.to_string());
                    }
                }
            }

            rendered.join("\n")
        }
    };

    GrepResult {
        content,
        error: None,
        match_count: match_count as i32,
        file_count: if match_count > 0 { 1 } else { 0 },
        filtered_sensitive: Vec::new(),
        timed_out: false,
    }
}

fn format_entry_bytes(entry: &MatchEntry, config: &GrepConfig, base: &Path) -> usize {
    let rel = relativize(&entry.file, base);
    if config.line_numbers {
        rel.len() + 1 + 10 + 1 + entry.line.len() + 1 // path:line_no:line\n
    } else {
        rel.len() + 1 + entry.line.len() + 1 // path:line\n
    }
}

fn relativize(path: &Path, base: &Path) -> String {
    path.strip_prefix(base)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| path.display().to_string())
}

/// Map a ripgrep-style file type name to a list of glob patterns.
///
/// Only the most common languages are covered. Unknown types return an
/// empty list, which makes the search match nothing — same behaviour as
/// `rg --type unknown`, which exits with an error. We choose to fall
/// through silently and rely on the caller's empty result to signal the
/// mismatch, because the agent loop has no UI to escalate a malformed
/// type name into an actionable error.
fn file_type_to_globs(name: &str) -> Vec<String> {
    let lower = name.to_lowercase();
    let exts: &[&str] = match lower.as_str() {
        "ts" => &["ts", "tsx", "cts", "mts"],
        "tsx" => &["tsx"],
        "js" => &["js", "jsx", "cjs", "mjs"],
        "jsx" => &["jsx"],
        "py" | "python" => &["py", "pyi", "pyx"],
        "rs" | "rust" => &["rs"],
        "go" => &["go"],
        "java" => &["java"],
        "kt" | "kotlin" => &["kt", "kts"],
        "rb" | "ruby" => &["rb", "rake", "gemspec"],
        "c" => &["c", "h"],
        "cpp" | "cxx" | "c++" => &["cpp", "cxx", "cc", "hpp", "hxx", "hh", "h"],
        "cs" | "csharp" => &["cs"],
        "swift" => &["swift"],
        "php" => &["php", "phtml"],
        "sh" | "shell" | "bash" => &["sh", "bash", "zsh", "fish"],
        "md" | "markdown" => &["md", "markdown"],
        "json" => &["json"],
        "yaml" | "yml" => &["yaml", "yml"],
        "toml" => &["toml"],
        "xml" => &["xml"],
        "html" => &["html", "htm"],
        "css" => &["css", "scss", "sass", "less"],
        "sql" => &["sql"],
        "lua" => &["lua"],
        "vue" => &["vue"],
        "svelte" => &["svelte"],
        _ => &[],
    };
    exts.iter().map(|ext| format!("**/*.{}", ext)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn setup_test_dir() -> TempDir {
        let dir = TempDir::new().unwrap();
        let file1 = dir.path().join("test1.txt");
        let file2 = dir.path().join("test2.txt");
        let file3 = dir.path().join("subdir").join("test3.txt");

        fs::create_dir_all(file3.parent().unwrap()).unwrap();

        let mut f1 = fs::File::create(&file1).unwrap();
        writeln!(f1, "hello world").unwrap();
        writeln!(f1, "foo bar baz").unwrap();
        writeln!(f1, "hello again").unwrap();

        let mut f2 = fs::File::create(&file2).unwrap();
        writeln!(f2, "nothing here").unwrap();
        writeln!(f2, "some HELLO text").unwrap();

        let mut f3 = fs::File::create(&file3).unwrap();
        writeln!(f3, "nested hello").unwrap();

        dir
    }

    #[test]
    fn test_grep_files_with_matches() {
        let dir = setup_test_dir();
        let result = grep_search(&GrepConfig {
            pattern: "hello".to_string(),
            path: Some(dir.path().to_str().unwrap().to_string()),
            output_mode: OutputMode::FilesWithMatches,
            ..Default::default()
        });
        assert!(result.error.is_none());
        assert!(result.match_count >= 3);
        assert!(result.file_count >= 2);
    }

    #[test]
    fn test_grep_content_mode() {
        let dir = setup_test_dir();
        let result = grep_search(&GrepConfig {
            pattern: "hello".to_string(),
            path: Some(dir.path().to_str().unwrap().to_string()),
            output_mode: OutputMode::Content,
            line_numbers: true,
            ..Default::default()
        });
        assert!(result.error.is_none());
        assert!(result.content.contains("1:hello world"));
    }

    #[test]
    fn test_grep_case_insensitive() {
        let dir = setup_test_dir();
        let result = grep_search(&GrepConfig {
            pattern: "hello".to_string(),
            path: Some(dir.path().to_str().unwrap().to_string()),
            output_mode: OutputMode::Content,
            case_insensitive: true,
            ..Default::default()
        });
        assert!(result.error.is_none());
        assert!(result.content.contains("HELLO"));
    }

    #[test]
    fn test_grep_count_mode() {
        let dir = setup_test_dir();
        let result = grep_search(&GrepConfig {
            pattern: "hello".to_string(),
            path: Some(dir.path().to_str().unwrap().to_string()),
            output_mode: OutputMode::CountMatches,
            case_insensitive: true,
            ..Default::default()
        });
        assert!(result.error.is_none());
        assert!(result.match_count >= 4);
    }

    #[test]
    fn test_grep_invalid_regex() {
        let dir = setup_test_dir();
        let result = grep_search(&GrepConfig {
            pattern: "[invalid".to_string(),
            path: Some(dir.path().to_str().unwrap().to_string()),
            ..Default::default()
        });
        assert!(result.error.is_some());
        assert!(result.error.unwrap().contains("Invalid regex"));
    }

    #[test]
    fn test_grep_nonexistent_path() {
        let result = grep_search(&GrepConfig {
            pattern: "test".to_string(),
            path: Some("/nonexistent/path".to_string()),
            ..Default::default()
        });
        assert!(result.error.is_some());
        assert!(result.error.unwrap().contains("does not exist"));
    }

    #[test]
    fn test_grep_single_file() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("test.txt");
        let mut f = fs::File::create(&file).unwrap();
        writeln!(f, "line one").unwrap();
        writeln!(f, "line two").unwrap();
        writeln!(f, "line three").unwrap();

        let result = grep_search(&GrepConfig {
            pattern: "two".to_string(),
            path: Some(file.to_str().unwrap().to_string()),
            output_mode: OutputMode::Content,
            ..Default::default()
        });
        assert!(result.error.is_none());
        assert_eq!(result.match_count, 1);
        assert!(result.content.contains("line two"));
    }

    #[test]
    fn test_grep_with_context() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("test.txt");
        let mut f = fs::File::create(&file).unwrap();
        writeln!(f, "line 1").unwrap();
        writeln!(f, "line 2").unwrap();
        writeln!(f, "MATCH HERE").unwrap();
        writeln!(f, "line 4").unwrap();
        writeln!(f, "line 5").unwrap();

        let result = grep_search(&GrepConfig {
            pattern: "MATCH".to_string(),
            path: Some(file.to_str().unwrap().to_string()),
            output_mode: OutputMode::Content,
            context: 1,
            ..Default::default()
        });
        assert!(result.error.is_none());
        assert!(result.content.contains("line 2"));
        assert!(result.content.contains("MATCH HERE"));
        assert!(result.content.contains("line 4"));
    }
}
