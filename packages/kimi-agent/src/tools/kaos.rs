//! Execution environment abstraction for command execution (Kaos alignment).
//!
//! Provides execution adapters for:
//! - Local shell execution
//! - Docker container execution (`docker exec`)
//! - Remote SSH execution (`ssh`)

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecutionEnvironment {
    /// Local machine environment using the configured shell.
    #[default]
    Local,
    /// Docker container environment.
    Docker {
        container_id: String,
        #[serde(default)]
        workdir: Option<String>,
    },
    /// Remote host over SSH.
    Ssh {
        host: String,
        #[serde(default)]
        user: Option<String>,
        #[serde(default)]
        port: Option<u16>,
        #[serde(default)]
        identity_file: Option<String>,
    },
}

impl ExecutionEnvironment {
    /// Build a configured `tokio::process::Command` for this execution environment.
    pub fn build_command(
        &self,
        shell: &str,
        working_dir: &Path,
        command: &str,
    ) -> tokio::process::Command {
        match self {
            Self::Local => {
                let mut cmd = tokio::process::Command::new(shell);
                let shell_lower = shell.to_ascii_lowercase();
                if shell_lower.ends_with("cmd.exe") || shell_lower == "cmd" {
                    cmd.arg("/c").arg(command);
                } else if shell_lower.contains("powershell") || shell_lower.contains("pwsh") {
                    cmd.arg("-NoProfile")
                        .arg("-NonInteractive")
                        .arg("-Command")
                        .arg(command);
                } else {
                    cmd.arg("-c").arg(command);
                }
                cmd.current_dir(working_dir)
                    .stdin(std::process::Stdio::null())
                    .env("NO_COLOR", "1")
                    .env("TERM", "dumb")
                    .env("GIT_TERMINAL_PROMPT", "0")
                    .env("SHELL", shell);
                cmd
            }
            Self::Docker {
                container_id,
                workdir,
            } => {
                let mut cmd = tokio::process::Command::new("docker");
                cmd.arg("exec").arg("-i");
                if let Some(wd) = workdir {
                    cmd.arg("-w").arg(wd);
                } else if let Some(wd_str) = working_dir.to_str() {
                    cmd.arg("-w").arg(wd_str);
                }
                cmd.arg(container_id).arg(shell).arg("-c").arg(command);
                cmd.stdin(std::process::Stdio::null())
                    .env("NO_COLOR", "1")
                    .env("TERM", "dumb")
                    .env("GIT_TERMINAL_PROMPT", "0");
                cmd
            }
            Self::Ssh {
                host,
                user,
                port,
                identity_file,
            } => {
                let mut cmd = tokio::process::Command::new("ssh");
                if let Some(p) = port {
                    cmd.arg("-p").arg(p.to_string());
                }
                if let Some(id) = identity_file {
                    cmd.arg("-i").arg(id);
                }
                cmd.arg("-o").arg("BatchMode=yes");
                cmd.arg("-o").arg("StrictHostKeyChecking=accept-new");

                let destination = match user {
                    Some(u) => format!("{u}@{host}"),
                    None => host.clone(),
                };
                cmd.arg(destination);

                let remote_cmd = if let Some(wd_str) = working_dir.to_str() {
                    format!("cd \"{wd_str}\" && {command}")
                } else {
                    command.to_string()
                };
                cmd.arg(remote_cmd);
                cmd.stdin(std::process::Stdio::null())
                    .env("NO_COLOR", "1")
                    .env("TERM", "dumb")
                    .env("GIT_TERMINAL_PROMPT", "0");
                cmd
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_local_command_builder() {
        let env = ExecutionEnvironment::Local;
        let cmd = env.build_command("bash", Path::new("/tmp"), "echo hello");
        assert_eq!(cmd.as_std().get_program(), "bash");
    }

    #[test]
    fn test_local_command_builder_cmd_and_powershell() {
        let env = ExecutionEnvironment::Local;

        // CMD flavor
        let cmd_cmd = env.build_command("cmd.exe", Path::new("C:\\"), "dir");
        assert_eq!(cmd_cmd.as_std().get_program(), "cmd.exe");
        let args_cmd: Vec<&str> = cmd_cmd
            .as_std()
            .get_args()
            .map(|a| a.to_str().unwrap())
            .collect();
        assert_eq!(args_cmd, ["/c", "dir"]);

        // PowerShell flavor
        let cmd_pwsh = env.build_command("pwsh", Path::new("C:\\"), "Get-Process");
        assert_eq!(cmd_pwsh.as_std().get_program(), "pwsh");
        let args_pwsh: Vec<&str> = cmd_pwsh
            .as_std()
            .get_args()
            .map(|a| a.to_str().unwrap())
            .collect();
        assert_eq!(
            args_pwsh,
            ["-NoProfile", "-NonInteractive", "-Command", "Get-Process"]
        );
    }

    #[test]
    fn test_docker_command_builder() {
        let env = ExecutionEnvironment::Docker {
            container_id: "my-container".into(),
            workdir: Some("/app".into()),
        };
        let cmd = env.build_command("bash", Path::new("/workspace"), "ls -la");
        assert_eq!(cmd.as_std().get_program(), "docker");
        let args: Vec<&str> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_str().unwrap())
            .collect();
        assert!(args.contains(&"exec"));
        assert!(args.contains(&"my-container"));
        assert!(args.contains(&"-w"));
        assert!(args.contains(&"/app"));
    }

    #[test]
    fn test_ssh_command_builder() {
        let env = ExecutionEnvironment::Ssh {
            host: "example.com".into(),
            user: Some("ubuntu".into()),
            port: Some(2222),
            identity_file: Some("/keys/id_rsa".into()),
        };
        let cmd = env.build_command("bash", Path::new("/home/ubuntu/project"), "git status");
        assert_eq!(cmd.as_std().get_program(), "ssh");
        let args: Vec<&str> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_str().unwrap())
            .collect();
        assert!(args.contains(&"-p"));
        assert!(args.contains(&"2222"));
        assert!(args.contains(&"ubuntu@example.com"));
    }
}
