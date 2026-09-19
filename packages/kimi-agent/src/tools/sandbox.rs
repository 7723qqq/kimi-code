//! Native Sandbox Guard Policy — a fork-original feature (P155) with no v2
//! counterpart. The `agent-core-v2` sandbox cited in earlier revisions of the
//! roadmap was fork-authored (f007fc9f71) and never existed upstream, so there
//! is no upstream behaviour to align with; this module is its own reference.
//!
//! Provides fail-closed boundary enforcement for mutating tools (`Write`, `Edit`),
//! code execution and shell commands according to the active `SandboxMode`:
//! - `Off`: Confinement disabled;
//! - `ReadOnly`: Blocks all writes and code execution;
//! - `WorkspaceWrite`: Allows writes inside the authorized roots (the workspace
//!   plus any host-authorized `additionalDirs`), blocks writes outside — for
//!   path-gated tools *and* for shell redirection / mutating commands, which
//!   would otherwise be an open bypass.

use serde::{Deserialize, Serialize};

/// File-effect modes for confined executions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    #[default]
    Off,
    ReadOnly,
    WorkspaceWrite,
}

impl SandboxMode {
    /// Parses a string into `SandboxMode`. Returns `SandboxMode::Off` for unknown values.
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "read-only" | "readonly" => SandboxMode::ReadOnly,
            "workspace-write" | "workspacewrite" => SandboxMode::WorkspaceWrite,
            _ => SandboxMode::Off,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            SandboxMode::Off => "off",
            SandboxMode::ReadOnly => "read-only",
            SandboxMode::WorkspaceWrite => "workspace-write",
        }
    }
}

/// Execution policy defining the sandbox mode and allowed workspace boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SandboxExecutionPolicy {
    pub mode: SandboxMode,
    pub workspace_root: String,
    /// Additional host-authorized roots (`/add-dir` → `additionalDirs`). A write
    /// target inside any of these is authorized exactly like one inside
    /// `workspace_root`. Empty for callers that only ever pass the workspace.
    #[serde(default)]
    pub extra_roots: Vec<String>,
}

impl SandboxExecutionPolicy {
    pub fn new(mode: SandboxMode, workspace_root: impl Into<String>) -> Self {
        Self {
            mode,
            workspace_root: workspace_root.into(),
            extra_roots: Vec::new(),
        }
    }

    pub fn off(workspace_root: impl Into<String>) -> Self {
        Self::new(SandboxMode::Off, workspace_root)
    }

    pub fn read_only(workspace_root: impl Into<String>) -> Self {
        Self::new(SandboxMode::ReadOnly, workspace_root)
    }

    pub fn workspace_write(workspace_root: impl Into<String>) -> Self {
        Self::new(SandboxMode::WorkspaceWrite, workspace_root)
    }

    /// Authorize additional roots. Entries are normalized the same way as
    /// `workspace_root`, so separator and `..` differences cannot smuggle a
    /// path past [`Self::is_path_authorized`].
    pub fn with_extra_roots<I, S>(mut self, roots: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.extra_roots = roots
            .into_iter()
            .map(Into::into)
            .filter(|root| !normalize_path_for_comparison(root).is_empty())
            .collect();
        self
    }

    /// Every authorized root, primary first.
    pub fn authorized_roots(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.workspace_root.as_str())
            .chain(self.extra_roots.iter().map(String::as_str))
    }

    /// Whether an absolute target path lands inside any authorized root.
    pub fn is_path_authorized(&self, target_path: &str) -> bool {
        self.authorized_roots()
            .any(|root| is_path_within_workspace(target_path, root))
    }

    /// Human-readable root list for denial messages. Keeps the historical
    /// single-root wording when no extra roots are configured.
    fn roots_summary(&self) -> String {
        if self.extra_roots.is_empty() {
            return format!("\"{}\"", self.workspace_root);
        }
        self.authorized_roots()
            .map(|root| format!("\"{root}\""))
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// Fail-closed guard for tool paths that write to the filesystem (`Write`, `Edit`).
    /// Returns an error explanation when the configured sandbox mode blocks the operation,
    /// or `None` when it is allowed.
    pub fn sandbox_write_guard(&self, target_path: &str) -> Option<String> {
        if self.mode == SandboxMode::Off {
            return None;
        }

        if self.mode == SandboxMode::ReadOnly {
            return Some(format!(
                "Sandbox mode \"{}\" blocks writes to the filesystem. Set `[sandbox] mode = \"off\"` (or \"workspace-write\") to allow writes.",
                self.mode.as_str()
            ));
        }

        if !self.is_path_authorized(target_path) {
            return Some(if self.extra_roots.is_empty() {
                format!(
                    "Sandbox mode \"{}\" blocks writes outside the workspace root \"{}\". Target path \"{}\" is outside it.",
                    self.mode.as_str(),
                    self.workspace_root,
                    target_path
                )
            } else {
                format!(
                    "Sandbox mode \"{}\" blocks writes outside the authorized roots ({}). Target path \"{}\" is outside them.",
                    self.mode.as_str(),
                    self.roots_summary(),
                    target_path
                )
            });
        }

        None
    }

    /// Guard for code execution when the working directory is known.
    ///
    /// `ReadOnly` keeps blocking all code execution (see
    /// [`Self::sandbox_code_execution_guard`]). `WorkspaceWrite` additionally
    /// requires the shell's working directory to sit inside an authorized root —
    /// otherwise a shell could simply start outside and write relatively, which
    /// [`Self::sandbox_write_guard`] would never see.
    pub fn sandbox_code_execution_guard_for(&self, cwd: Option<&str>) -> Option<String> {
        if let Some(denial) = self.sandbox_code_execution_guard() {
            return Some(denial);
        }
        if self.mode != SandboxMode::WorkspaceWrite {
            return None;
        }
        let cwd = cwd.map(str::trim).filter(|cwd| !cwd.is_empty())?;
        if !self.is_path_authorized(cwd) {
            return Some(format!(
                "Sandbox mode \"{}\" blocks running code with a working directory outside the authorized roots ({}). cwd \"{}\" is outside them.",
                self.mode.as_str(),
                self.roots_summary(),
                cwd
            ));
        }
        None
    }

    /// Guard for shell commands, which can write through redirection or through a
    /// mutating command's file arguments without ever touching a path-gated tool.
    ///
    /// `Write`/`Edit` go through [`Self::sandbox_write_guard`]; without an
    /// equivalent check on the shell, `Bash("echo x > /outside/f")` bypassed a
    /// `workspace-write` sandbox completely. This scans the command text for
    /// *absolute* write targets — shell redirections (`>`, `>>`, `n>`), `tee`,
    /// `dd of=`, the file arguments of the common mutating commands, and `cd`
    /// targets — and denies the ones outside the authorized roots.
    ///
    /// Relative targets are accepted, because the working directory is confined
    /// separately by [`Self::sandbox_code_execution_guard_for`].
    ///
    /// # Coverage limits (documented, not silent)
    /// This is a lexical scan, not a shell parse. It does not model a command
    /// that writes from inside an interpreter or script file
    /// (`python -c "open('/outside/f','w')"`, `./script.sh`, `make`), and it does
    /// not resolve symlinks that point outside a root. Those remain holes in
    /// `workspace-write`; closing them needs OS-level confinement, not string
    /// inspection.
    pub fn sandbox_bash_write_guard(&self, command: &str) -> Option<String> {
        if self.mode == SandboxMode::Off {
            return None;
        }
        if self.mode == SandboxMode::ReadOnly {
            // Already refused by the execution guard before we get here.
            return None;
        }
        for target in collect_absolute_write_targets(command) {
            if !self.is_path_authorized(&target) {
                return Some(format!(
                    "Sandbox mode \"{}\" blocks shell writes outside the authorized roots ({}). Target path \"{}\" is outside them.",
                    self.mode.as_str(),
                    self.roots_summary(),
                    target
                ));
            }
        }
        None
    }

    /// Guard for code execution (e.g. run_code / bash execution checks).
    pub fn sandbox_code_execution_guard(&self) -> Option<String> {
        if self.mode == SandboxMode::ReadOnly {
            return Some(format!(
                "Sandbox mode \"{}\" blocks code execution (run_code / Bash). Set `[sandbox] mode = \"off\"` to allow it.",
                self.mode.as_str()
            ));
        }
        None
    }
}

/// Commands whose every path argument is created, mutated or removed.
const WRITE_ALL_ARGS_COMMANDS: &[&str] = &[
    "rm", "rmdir", "unlink", "touch", "mkdir", "truncate", "chmod", "chown", "chgrp", "shred",
    "setfacl", "tee",
];

/// Commands that both consume and mutate every path argument (a move removes the
/// source), so every argument is a write target.
const WRITE_ALL_ARGS_MOVING_COMMANDS: &[&str] = &["mv"];

/// Commands where only the final path argument is written.
const WRITE_LAST_ARG_COMMANDS: &[&str] = &["cp", "ln", "install", "rsync"];

/// Commands that change the shell's working directory.
const CHDIR_COMMANDS: &[&str] = &["cd", "pushd"];

/// Shells that can run an inline program, whose body must be scanned even inside
/// quotes (otherwise `bash -c "echo x > /outside/f"` slips through).
const NESTED_SHELLS: &[&str] = &[
    "sh",
    "bash",
    "dash",
    "zsh",
    "ksh",
    "ash",
    "cmd",
    "powershell",
    "pwsh",
];

/// Paths that accept writes without touching user data.
const SAFE_WRITE_SINKS: &[&str] = &[
    "/dev/null",
    "/dev/stdout",
    "/dev/stderr",
    "/dev/zero",
    "/dev/tty",
    "nul",
];

/// True for a path that can be resolved without knowing the working directory:
/// POSIX absolute, `~`-rooted, or an explicit Windows drive/UNC path. Relative
/// paths return `false` and are therefore not path-checked here.
fn is_absolute_like(path: &str) -> bool {
    let bytes = path.as_bytes();
    if path.starts_with('/') || path.starts_with('~') || path.starts_with('$') {
        return true;
    }
    // Windows drive (C:\ / C:/) or UNC (\\server\share).
    (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || path.starts_with("\\\\")
        || path.starts_with("//")
}

/// Drops the quoting characters a shell would strip, so `"/outside/f"` and
/// `/outside/f` compare equal.
fn unquote(token: &str) -> &str {
    let token = token.trim();
    let token = token
        .strip_prefix('"')
        .and_then(|t| t.strip_suffix('"'))
        .unwrap_or(token);
    token
        .strip_prefix('\'')
        .and_then(|t| t.strip_suffix('\''))
        .unwrap_or(token)
}

fn is_safe_write_sink(path: &str) -> bool {
    let normalized = normalize_path_for_comparison(path).to_ascii_lowercase();
    if SAFE_WRITE_SINKS.iter().any(|sink| *sink == normalized) {
        return true;
    }
    normalized.starts_with("/dev/fd/")
        || normalized.starts_with("/proc/self/fd/")
        || normalized.starts_with("/proc/")
}

/// Reads the path token that follows `rest`, skipping leading whitespace. Returns
/// the token (unquoted) and how many bytes of `rest` were consumed.
fn read_path_token(rest: &str) -> Option<(String, usize)> {
    let mut consumed = 0;
    for ch in rest.chars() {
        if ch.is_whitespace() {
            consumed += ch.len_utf8();
        } else {
            break;
        }
    }
    let tail = &rest[consumed..];
    // A file-descriptor duplication (`>&2`, `> &1`) targets no file.
    if tail.starts_with('&') {
        return None;
    }
    let mut token = String::new();
    for ch in tail.chars() {
        if ch.is_whitespace() || matches!(ch, ';' | '|' | '&' | '<' | '>') {
            break;
        }
        consumed += ch.len_utf8();
        token.push(ch);
    }
    let token = unquote(&token).to_string();
    if token.is_empty() {
        return None;
    }
    Some((token, consumed))
}

/// Blank out quoted regions so a `>` inside a commit message or a grep pattern
/// is not mistaken for a redirection. Quoting is restored by scanning the raw
/// text when a nested shell is present.
fn strip_quoted_regions(command: &str) -> String {
    let mut out = String::with_capacity(command.len());
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in command.chars() {
        match quote {
            Some(active) => {
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == active {
                    quote = None;
                    out.push(' ');
                }
            }
            None => {
                if ch == '"' || ch == '\'' {
                    quote = Some(ch);
                    out.push(' ');
                } else {
                    out.push(ch);
                }
            }
        }
    }
    out
}

/// Whether the command invokes a shell with an inline program (`sh -c "…"`,
/// `powershell -Command "…"`). Those bodies are worth scanning through quotes.
fn nested_shell_present(segments: &[String]) -> bool {
    segments.iter().any(|segment| {
        let words: Vec<&str> = segment.split_whitespace().collect();
        let Some(first) = words.first() else {
            return false;
        };
        let name = unquote(first);
        let name = name.rsplit(['/', '\\']).next().unwrap_or(name);
        NESTED_SHELLS.contains(&name)
            && words[1..].iter().any(|word| {
                let word = unquote(word);
                word.starts_with('-') && word.contains('c') && !word.starts_with("--")
            })
    })
}

/// Extracts every absolute filesystem target the command writes to.
///
/// Redirections are scanned over the raw text when a nested shell is present (so
/// `bash -c "echo x > /outside/f"` is caught) and over quote-stripped text
/// otherwise (so `git commit -m "fix > /tmp/x"` is not).
fn collect_absolute_write_targets(command: &str) -> Vec<String> {
    let mut targets: Vec<String> = Vec::new();
    let mut push = |candidate: &str| {
        let candidate = unquote(candidate);
        if candidate.is_empty() || !is_absolute_like(candidate) || is_safe_write_sink(candidate) {
            return;
        }
        if !targets.iter().any(|existing| existing == candidate) {
            targets.push(candidate.to_string());
        }
    };

    let segments = split_shell_segments(command);
    let redirect_text = if nested_shell_present(&segments) {
        command.to_string()
    } else {
        strip_quoted_regions(command)
    };

    // 1. Redirections.
    let bytes = redirect_text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'>' {
            index += 1;
            continue;
        }
        // `=>` is an operator or argument, not a redirection.
        if index > 0 && bytes[index - 1] == b'=' {
            index += 1;
            continue;
        }
        // `>>` appends: consume both characters so the operator is visited once.
        let mut cursor = index + 1;
        if cursor < bytes.len() && bytes[cursor] == b'>' {
            cursor += 1;
        }
        if let Some((token, _)) = read_path_token(&redirect_text[cursor..]) {
            push(&token);
        }
        index = cursor;
    }

    // 2. Command arguments, per segment split on shell separators.
    for segment in &segments {
        let words: Vec<&str> = segment.split_whitespace().collect();
        if words.is_empty() {
            continue;
        }
        let command_name = unquote(words[0]);
        let command_name = command_name
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(command_name);
        let args: Vec<&str> = words[1..]
            .iter()
            .copied()
            .filter(|word| !word.starts_with('-'))
            .collect();
        if args.is_empty() {
            continue;
        }

        if CHDIR_COMMANDS.contains(&command_name) {
            // Only the directory argument matters; `&&`-joined tails are separate segments.
            for arg in args {
                push(arg);
            }
            continue;
        }
        // `dd of=/path` names its output explicitly.
        if command_name == "dd" {
            for word in &words[1..] {
                if let Some(target) = unquote(word).strip_prefix("of=") {
                    push(target);
                }
            }
            continue;
        }
        if WRITE_ALL_ARGS_COMMANDS.contains(&command_name)
            || WRITE_ALL_ARGS_MOVING_COMMANDS.contains(&command_name)
        {
            for arg in args {
                push(arg);
            }
            continue;
        }
        if WRITE_LAST_ARG_COMMANDS.contains(&command_name)
            && let Some(last) = args.last()
        {
            push(last);
        }
    }

    targets
}

/// Splits a command line on `;`, `&&`, `||`, `|` and newlines, ignoring
/// separators inside quotes so a quoted message is not cut apart.
fn split_shell_segments(command: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut chars = command.chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(active) = quote {
            current.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == active {
                quote = None;
            }
            continue;
        }
        match ch {
            '"' | '\'' => {
                quote = Some(ch);
                current.push(ch);
            }
            ';' | '\n' | '|' => {
                // Collapse `&&` / `||`.
                while matches!(chars.peek(), Some('&') | Some('|')) {
                    chars.next();
                }
                segments.push(std::mem::take(&mut current));
            }
            '&' => {
                while matches!(chars.peek(), Some('&')) {
                    chars.next();
                }
                segments.push(std::mem::take(&mut current));
            }
            _ => current.push(ch),
        }
    }
    segments.push(current);
    segments
}

/// Normalizes path for boundary comparison:
/// Replaces backslashes with slashes, strips trailing slashes,
/// and on Windows drives (`^[a-zA-Z]:/`) normalizes drive letter to lowercase.
pub fn normalize_path_for_comparison(path: &str) -> String {
    let replaced = path.replace('\\', "/");
    let has_leading_slash = replaced.starts_with('/');

    // Handle Windows drive prefix like C: or c:
    let (prefix, rest) = if replaced.len() >= 2
        && replaced.as_bytes()[0].is_ascii_alphabetic()
        && replaced.as_bytes()[1] == b':'
    {
        let drive = (replaced.as_bytes()[0] as char).to_ascii_lowercase();
        (format!("{drive}:"), &replaced[2..])
    } else {
        (String::new(), replaced.as_str())
    };

    let mut segments = Vec::new();
    for part in rest.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            segments.pop();
        } else {
            segments.push(part);
        }
    }

    let joined = segments.join("/");
    if !prefix.is_empty() {
        if joined.is_empty() {
            prefix
        } else {
            format!("{prefix}/{joined}")
        }
    } else if has_leading_slash {
        format!("/{joined}")
    } else {
        joined
    }
}

/// Checks whether `target_path` is located within or equals `workspace_root`.
pub fn is_path_within_workspace(target_path: &str, workspace_root: &str) -> bool {
    let norm_target = normalize_path_for_comparison(target_path);
    let norm_root = normalize_path_for_comparison(workspace_root);
    if norm_root.is_empty() {
        return false;
    }
    if norm_target == norm_root {
        return true;
    }
    let prefix = format!("{}/", norm_root);
    norm_target.starts_with(&prefix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sandbox_mode_parsing() {
        assert_eq!(SandboxMode::parse("off"), SandboxMode::Off);
        assert_eq!(SandboxMode::parse("read-only"), SandboxMode::ReadOnly);
        assert_eq!(SandboxMode::parse("readonly"), SandboxMode::ReadOnly);
        assert_eq!(
            SandboxMode::parse("workspace-write"),
            SandboxMode::WorkspaceWrite
        );
        assert_eq!(
            SandboxMode::parse("workspacewrite"),
            SandboxMode::WorkspaceWrite
        );
        assert_eq!(SandboxMode::parse("unknown"), SandboxMode::Off);
    }

    #[test]
    fn test_sandbox_write_guard_modes() {
        let root = "/home/user/project";
        let off_policy = SandboxExecutionPolicy::off(root);
        assert!(
            off_policy
                .sandbox_write_guard("/home/user/project/file.txt")
                .is_none()
        );
        assert!(off_policy.sandbox_write_guard("/etc/passwd").is_none());

        let ro_policy = SandboxExecutionPolicy::read_only(root);
        let ro_err = ro_policy.sandbox_write_guard("/home/user/project/file.txt");
        assert_eq!(
            ro_err.as_deref(),
            Some(
                "Sandbox mode \"read-only\" blocks writes to the filesystem. Set `[sandbox] mode = \"off\"` (or \"workspace-write\") to allow writes."
            )
        );

        let ww_policy = SandboxExecutionPolicy::workspace_write(root);
        assert!(
            ww_policy
                .sandbox_write_guard("/home/user/project/file.txt")
                .is_none()
        );
        assert!(
            ww_policy
                .sandbox_write_guard("/home/user/project/sub/file.txt")
                .is_none()
        );

        let out_err = ww_policy.sandbox_write_guard("/etc/passwd");
        assert_eq!(
            out_err.as_deref(),
            Some(
                "Sandbox mode \"workspace-write\" blocks writes outside the workspace root \"/home/user/project\". Target path \"/etc/passwd\" is outside it."
            )
        );

        // Sibling dir check
        let sibling_err = ww_policy.sandbox_write_guard("/home/user/project2/file.txt");
        assert_eq!(
            sibling_err.as_deref(),
            Some(
                "Sandbox mode \"workspace-write\" blocks writes outside the workspace root \"/home/user/project\". Target path \"/home/user/project2/file.txt\" is outside it."
            )
        );

        // Path traversal / escape check
        let traversal_err = ww_policy.sandbox_write_guard("/home/user/project/../sibling.txt");
        assert_eq!(
            traversal_err.as_deref(),
            Some(
                "Sandbox mode \"workspace-write\" blocks writes outside the workspace root \"/home/user/project\". Target path \"/home/user/project/../sibling.txt\" is outside it."
            )
        );
    }

    #[test]
    fn test_windows_drive_case_normalization() {
        let ww_policy = SandboxExecutionPolicy::workspace_write("C:/workspace/root");
        assert!(
            ww_policy
                .sandbox_write_guard("c:/workspace/root/src/main.rs")
                .is_none()
        );
        assert!(
            ww_policy
                .sandbox_write_guard("C:\\workspace\\root\\src\\lib.rs")
                .is_none()
        );
        let d_err = ww_policy.sandbox_write_guard("D:/other/file.txt");
        assert_eq!(
            d_err.as_deref(),
            Some(
                "Sandbox mode \"workspace-write\" blocks writes outside the workspace root \"C:/workspace/root\". Target path \"D:/other/file.txt\" is outside it."
            )
        );
    }

    /// The sandbox must not be bypassable by shelling out: a `workspace-write`
    /// policy that blocks `Write("/etc/passwd")` must block
    /// `Bash("echo x > /etc/passwd")` too.
    #[test]
    fn test_workspace_write_blocks_shell_redirect_outside() {
        let policy = SandboxExecutionPolicy::workspace_write("/home/user/project");

        for command in [
            "echo x > /etc/passwd",
            "echo x >> /etc/passwd",
            "echo x > /tmp/outside.txt",
            "echo x &> /outside/f",
            "echo x | tee /outside/f",
            "cat a > /outside/f",
        ] {
            assert!(
                policy.sandbox_bash_write_guard(command).is_some(),
                "must block: {command}"
            );
        }

        // A nested shell body is scanned through its quotes.
        assert!(
            policy
                .sandbox_bash_write_guard("bash -c 'echo x > /outside/f'")
                .is_some(),
            "must block a redirect inside a nested shell"
        );

        for allowed in [
            "echo x > out.txt",
            "echo x > ./nested/out.txt",
            "echo x 2>/dev/null",
            "cargo build > target.log",
            "printf 'a > b'",
        ] {
            assert!(
                policy.sandbox_bash_write_guard(allowed).is_none(),
                "must allow: {allowed}"
            );
        }
    }

    #[test]
    fn test_workspace_write_blocks_mutating_commands_outside() {
        let policy = SandboxExecutionPolicy::workspace_write("/home/user/project");

        for command in [
            "rm -rf /etc",
            "rm /home/user/other/file",
            "mv /outside/a .",
            "cp a /etc/b",
            "mkdir -p /outside/dir",
            "truncate -s 0 /etc/passwd",
            "dd if=/dev/zero of=/outside.img",
            "cd /outside && ls",
            "pushd /etc",
        ] {
            assert!(
                policy.sandbox_bash_write_guard(command).is_some(),
                "must block: {command}"
            );
        }

        for allowed in [
            // Relative targets are fine: the working directory is confined separately.
            "chmod 755 file.txt",
            "cp a b",
            "rm -rf target",
            "mkdir -p src/nested",
            "cd src && cargo build",
            "grep 'a > b' file.txt",
        ] {
            assert!(
                policy.sandbox_bash_write_guard(allowed).is_none(),
                "must allow: {allowed}"
            );
        }

        // Inside the workspace root is always allowed.
        assert!(
            policy
                .sandbox_bash_write_guard("echo x > /home/user/project/out.txt")
                .is_none()
        );
    }

    #[test]
    fn test_off_mode_never_blocks_shell_or_cwd() {
        let policy = SandboxExecutionPolicy::off("/home/user/project");
        assert!(
            policy
                .sandbox_bash_write_guard("echo x > /etc/passwd")
                .is_none()
        );
        assert!(
            policy
                .sandbox_code_execution_guard_for(Some("/etc"))
                .is_none()
        );
    }

    #[test]
    fn test_code_execution_guard_confines_cwd() {
        let policy = SandboxExecutionPolicy::workspace_write("/home/user/project");
        assert!(
            policy
                .sandbox_code_execution_guard_for(Some("/home/user/project"))
                .is_none()
        );
        assert!(
            policy
                .sandbox_code_execution_guard_for(Some("/home/user/project/src"))
                .is_none()
        );
        let err = policy
            .sandbox_code_execution_guard_for(Some("/etc"))
            .expect("cwd outside the workspace must be refused");
        assert!(
            err.contains("working directory outside the authorized roots"),
            "{err}"
        );
        // No cwd information → nothing extra to check, and no false denial.
        assert!(policy.sandbox_code_execution_guard_for(None).is_none());

        // ReadOnly still refuses code execution outright, cwd or not.
        let ro = SandboxExecutionPolicy::read_only("/home/user/project");
        assert!(ro.sandbox_code_execution_guard_for(None).is_some());
        assert!(
            ro.sandbox_code_execution_guard_for(Some("/home/user/project"))
                .is_some()
        );
    }

    /// Host-authorized `additionalDirs` must be honored by the guards; wiring
    /// them only into a `Sandbox` that never participates in a decision made
    /// writes into an authorized directory fail for no reason.
    #[test]
    fn test_extra_roots_are_authorized() {
        let policy = SandboxExecutionPolicy::workspace_write("/home/user/project")
            .with_extra_roots(["/home/user/shared", "C:\\shared\\dir"]);

        assert!(
            policy
                .sandbox_write_guard("/home/user/shared/file.txt")
                .is_none()
        );
        assert!(
            policy
                .sandbox_write_guard("c:/shared/dir/file.txt")
                .is_none()
        );
        assert!(
            policy
                .sandbox_bash_write_guard("echo x > /home/user/shared/out.txt")
                .is_none()
        );
        assert!(
            policy
                .sandbox_code_execution_guard_for(Some("/home/user/shared"))
                .is_none()
        );

        // Still confined everywhere else, and sibling prefixes do not leak in.
        let err = policy
            .sandbox_write_guard("/home/user/shared2/file.txt")
            .expect("sibling dir must stay outside");
        assert!(err.contains("authorized roots"), "{err}");
        assert!(policy.sandbox_write_guard("/etc/passwd").is_some());
        assert!(
            policy
                .sandbox_bash_write_guard("echo x > /home/user/other/out.txt")
                .is_some()
        );
    }

    #[test]
    fn test_write_target_extraction_ignores_quoted_prose() {
        // A `>` in a message is not a redirection when no nested shell is involved.
        assert!(
            SandboxExecutionPolicy::workspace_write("/home/user/project")
                .sandbox_bash_write_guard("git commit -m 'fix > /tmp/x'")
                .is_none()
        );
        // But an explicitly quoted path argument is still a write target.
        assert!(
            SandboxExecutionPolicy::workspace_write("/home/user/project")
                .sandbox_bash_write_guard("rm \"/etc/passwd\"")
                .is_some()
        );
    }
}
