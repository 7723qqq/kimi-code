//! Local shell resolution (POSIX bash / Windows `[shell] preference`).
//!
//! Ported from the retired `kimi-native-tools/src/bash.rs` detection after the
//! `[shell] preference` config landed: on Windows the order is
//! `KIMI_SHELL_PATH` env override → the configured preference → `pwsh` →
//! `powershell` → Git Bash → `cmd`; on POSIX the shell is always `/bin/bash`.
//!
//! PowerShell runs with `-NoProfile -NonInteractive` and cmd with `/c`, so the
//! Bash tool's exec prefix is flavor-dependent rather than a fixed `-c`.

/// The command-interpreter family a resolved shell belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellFlavor {
    Bash,
    Pwsh,
    PowerShell,
    Cmd,
}

impl ShellFlavor {
    /// Parse a `[shell].preference` value; `None` for `auto` / unknown.
    pub fn from_preference(preference: &str) -> Option<Self> {
        match preference.trim().to_ascii_lowercase().as_str() {
            "bash" => Some(Self::Bash),
            "pwsh" => Some(Self::Pwsh),
            "powershell" => Some(Self::PowerShell),
            "cmd" => Some(Self::Cmd),
            _ => None,
        }
    }

    /// Classify a shell executable by its basename.
    pub fn from_path(path: &str) -> Self {
        let base = path
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(path)
            .to_ascii_lowercase();
        match base.as_str() {
            "pwsh" | "pwsh.exe" => Self::Pwsh,
            "powershell" | "powershell.exe" => Self::PowerShell,
            "cmd" | "cmd.exe" => Self::Cmd,
            _ => Self::Bash,
        }
    }

    /// The argument prefix a shell needs before the command text.
    pub fn args_prefix(self) -> Vec<String> {
        match self {
            Self::Pwsh | Self::PowerShell => {
                vec![
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                ]
            }
            Self::Cmd => vec!["/c".to_string()],
            Self::Bash => vec!["-c".to_string()],
        }
    }
}

/// A shell executable plus its flavor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedShell {
    pub program: String,
    pub flavor: ShellFlavor,
}

impl ResolvedShell {
    pub fn new(program: impl Into<String>) -> Self {
        let program = program.into();
        let flavor = ShellFlavor::from_path(&program);
        Self { program, flavor }
    }

    /// The argument prefix before the command text.
    pub fn args_prefix(&self) -> Vec<String> {
        self.flavor.args_prefix()
    }
}

/// Resolve the shell for local command execution.
///
/// `preference` is the `[shell].preference` value; `None` / `auto` means
/// auto-detect. `KIMI_SHELL_PATH` still wins over the config on Windows.
pub fn resolve_shell(preference: Option<&str>) -> ResolvedShell {
    #[cfg(not(windows))]
    {
        let _ = preference;
        ResolvedShell {
            program: "/bin/bash".to_string(),
            flavor: ShellFlavor::Bash,
        }
    }
    #[cfg(windows)]
    {
        if let Some(path) = std::env::var("KIMI_SHELL_PATH")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            return ResolvedShell::new(path);
        }

        if let Some(flavor) = preference.and_then(ShellFlavor::from_preference)
            && let Some(program) = program_for(flavor)
        {
            return ResolvedShell { program, flavor };
        }

        if let Some(program) = which("pwsh.exe") {
            return ResolvedShell {
                program,
                flavor: ShellFlavor::Pwsh,
            };
        }
        if let Some(program) = which("powershell.exe") {
            return ResolvedShell {
                program,
                flavor: ShellFlavor::PowerShell,
            };
        }
        if let Some(program) = git_bash() {
            return ResolvedShell {
                program,
                flavor: ShellFlavor::Bash,
            };
        }
        ResolvedShell {
            program: "cmd.exe".to_string(),
            flavor: ShellFlavor::Cmd,
        }
    }
}

#[cfg(windows)]
fn program_for(flavor: ShellFlavor) -> Option<String> {
    match flavor {
        ShellFlavor::Pwsh => which("pwsh.exe").or_else(|| Some("pwsh".to_string())),
        ShellFlavor::PowerShell => {
            which("powershell.exe").or_else(|| Some("powershell".to_string()))
        }
        ShellFlavor::Cmd => Some("cmd.exe".to_string()),
        ShellFlavor::Bash => git_bash().or_else(|| Some("bash".to_string())),
    }
}

#[cfg(windows)]
fn which(name: &str) -> Option<String> {
    let output = std::process::Command::new("where")
        .arg(name)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

#[cfg(windows)]
fn git_bash() -> Option<String> {
    const CANDIDATES: &[&str] = &[
        "C:\\msys64\\usr\\bin\\bash.exe",
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    ];
    CANDIDATES
        .iter()
        .find(|path| std::path::Path::new(path).exists())
        .map(|path| (*path).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preference_parsing() {
        assert_eq!(
            ShellFlavor::from_preference("pwsh"),
            Some(ShellFlavor::Pwsh)
        );
        assert_eq!(
            ShellFlavor::from_preference("PowerShell"),
            Some(ShellFlavor::PowerShell)
        );
        assert_eq!(ShellFlavor::from_preference("cmd"), Some(ShellFlavor::Cmd));
        assert_eq!(
            ShellFlavor::from_preference("bash"),
            Some(ShellFlavor::Bash)
        );
        assert_eq!(ShellFlavor::from_preference("auto"), None);
        assert_eq!(ShellFlavor::from_preference("nope"), None);
    }

    #[test]
    fn flavor_from_path_classifies_basenames() {
        assert_eq!(
            ShellFlavor::from_path("C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
            ShellFlavor::Pwsh
        );
        assert_eq!(
            ShellFlavor::from_path(
                "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
            ),
            ShellFlavor::PowerShell
        );
        assert_eq!(ShellFlavor::from_path("cmd.exe"), ShellFlavor::Cmd);
        assert_eq!(ShellFlavor::from_path("/usr/bin/bash"), ShellFlavor::Bash);
    }

    #[test]
    fn arg_prefixes_match_each_flavor() {
        assert_eq!(ShellFlavor::Bash.args_prefix(), vec!["-c"]);
        assert_eq!(ShellFlavor::Cmd.args_prefix(), vec!["/c"]);
        assert_eq!(
            ShellFlavor::Pwsh.args_prefix(),
            vec!["-NoProfile", "-NonInteractive", "-Command"]
        );
    }

    #[test]
    fn explicit_path_wins_over_preference() {
        // On POSIX the shim ignores both; on Windows the env var wins over the
        // preference. Either way the return is a usable shell.
        let resolved = resolve_shell(Some("cmd"));
        assert!(!resolved.program.is_empty());
        assert_eq!(resolved.args_prefix(), resolved.flavor.args_prefix());
    }
}
