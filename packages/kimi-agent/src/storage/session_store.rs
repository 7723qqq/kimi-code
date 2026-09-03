//! Append-only JSONL session storage for crash resilience.

use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use crate::rpc::types::TokenUsage;
use crate::turn_loop::types::LLMMessage;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub timestamp_ms: u64,
    pub turn_id: String,
    pub user_message: LLMMessage,
    pub assistant_message: Option<LLMMessage>,
    pub usage: TokenUsage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummary {
    pub session_id: String,
    pub turns_count: usize,
    pub last_updated_ms: u64,
    pub total_usage: TokenUsage,
}

pub struct SessionStore {
    sessions_dir: PathBuf,
}

impl SessionStore {
    /// Create (or open) the session store under an explicit directory.
    /// Tests use this directly; production resolves the directory through
    /// [`for_workspace`].
    pub fn for_dir(sessions_dir: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(&sessions_dir)?;
        Ok(Self { sessions_dir })
    }

    /// Create (or open) the session store for a workspace, under the
    /// engine-local root: `~/.kimi-code/engine-state/<workspace-key>/sessions/`.
    pub fn for_workspace(workspace_root: &Path) -> io::Result<Self> {
        Self::for_dir(super::paths::engine_state_dir(workspace_root)?.join("sessions"))
    }

    fn session_file(&self, session_id: &str) -> PathBuf {
        let safe_id = session_id.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
        self.sessions_dir.join(format!("{safe_id}.jsonl"))
    }

    /// Append a turn record to the session's JSONL file.
    pub fn append_turn(
        &self,
        session_id: &str,
        turn_id: &str,
        user_message: &LLMMessage,
        assistant_message: Option<&LLMMessage>,
        usage: &TokenUsage,
    ) -> io::Result<()> {
        let path = self.session_file(session_id);
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let record = SessionRecord {
            timestamp_ms: now_ms,
            turn_id: turn_id.to_string(),
            user_message: user_message.clone(),
            assistant_message: assistant_message.cloned(),
            usage: usage.clone(),
        };

        let json = serde_json::to_string(&record)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        writeln!(file, "{json}")?;
        file.flush()?;
        Ok(())
    }

    /// Load full conversation history from a session.
    pub fn load_history(&self, session_id: &str) -> io::Result<Vec<LLMMessage>> {
        let path = self.session_file(session_id);
        if !path.is_file() {
            return Ok(Vec::new());
        }

        let file = File::open(path)?;
        let reader = BufReader::new(file);
        let mut messages = Vec::new();

        for line in reader.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(record) = serde_json::from_str::<SessionRecord>(&line) {
                messages.push(record.user_message);
                if let Some(assistant) = record.assistant_message {
                    messages.push(assistant);
                }
            }
        }

        Ok(messages)
    }

    /// List all available sessions in this workspace.
    pub fn list_sessions(&self) -> io::Result<Vec<SessionSummary>> {
        let mut summaries = Vec::new();
        if !self.sessions_dir.is_dir() {
            return Ok(summaries);
        }

        for entry in fs::read_dir(&self.sessions_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("jsonl")
                && let Some(stem) = path.file_stem().and_then(|s| s.to_str())
            {
                let file = File::open(&path)?;
                let reader = BufReader::new(file);
                let mut turns_count = 0;
                let mut last_updated_ms = 0;
                let mut total_usage = TokenUsage::default();

                for line in reader.lines() {
                    let line = line?;
                    if line.trim().is_empty() {
                        continue;
                    }
                    if let Ok(rec) = serde_json::from_str::<SessionRecord>(&line) {
                        turns_count += 1;
                        last_updated_ms = rec.timestamp_ms;
                        total_usage.input_tokens += rec.usage.input_tokens;
                        total_usage.output_tokens += rec.usage.output_tokens;
                        total_usage.total_tokens += rec.usage.total_tokens;
                    }
                }

                summaries.push(SessionSummary {
                    session_id: stem.to_string(),
                    turns_count,
                    last_updated_ms,
                    total_usage,
                });
            }
        }

        summaries.sort_by_key(|s| std::cmp::Reverse(s.last_updated_ms));
        Ok(summaries)
    }

    /// Delete a session.
    pub fn delete_session(&self, session_id: &str) -> io::Result<bool> {
        let path = self.session_file(session_id);
        if path.is_file() {
            fs::remove_file(path)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_session_append_and_load() {
        let tmp = TempDir::new().unwrap();
        let store = SessionStore::for_dir(tmp.path().join("sessions")).unwrap();

        let u1 = LLMMessage {
            role: "user".into(),
            content: "hello".into(),
            ..Default::default()
        };
        let a1 = LLMMessage {
            role: "assistant".into(),
            content: "hi there".into(),
            ..Default::default()
        };
        let usage = TokenUsage {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_cache_read: 0,
            input_cache_creation: 0,
        };

        store
            .append_turn("sess-1", "turn-1", &u1, Some(&a1), &usage)
            .unwrap();

        let history = store.load_history("sess-1").unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].content, "hello");
        assert_eq!(history[1].content, "hi there");

        let sessions = store.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "sess-1");
        assert_eq!(sessions[0].turns_count, 1);
        assert_eq!(sessions[0].total_usage.total_tokens, 15);

        assert!(store.delete_session("sess-1").unwrap());
        assert_eq!(store.load_history("sess-1").unwrap().len(), 0);
    }
}
