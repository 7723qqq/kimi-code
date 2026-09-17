//! Session title composition and the managed `chat_title` call.
//!
//! Mirrors v2's `sessionTitleService` + `agentTitlePromptSourceService`: the
//! deterministic sources (`first_turn` / `user_prompts`) derive a title from
//! the history, and `digest` asks the managed platform for one through the
//! `chat_title` tool. The wire shape is the one `packages/oauth`'s
//! `fetchChatTitle` already speaks — `POST {base}/tools` with
//! `{method, params:{chat_content}}` answering `{title}`.
//!
//! The credential comes from the LLM's managed seam
//! ([`crate::turn_loop::types::LLM::media_target`] +
//! [`crate::turn_loop::types::LLM::media_upload_credential`]): both are gated
//! on `auth_provider`, which is the engine's marker for v2's
//! `modelSource === 'oauth-catalog'`, and together they carry exactly what a
//! managed call needs — the base URL and a refreshed bearer token. Media
//! upload is the other caller of that seam; the name is media-shaped but the
//! gate and the payload are the same.

use std::time::Duration;

use crate::turn_loop::types::{LLM, LLMMessage};

/// v2 `MAX_GENERATED_TITLE_LENGTH`.
const MAX_GENERATED_TITLE_LENGTH: usize = 200;
/// v2 `MAX_TITLE_INPUT_LENGTH`.
const MAX_TITLE_INPUT_LENGTH: usize = 1000;
/// v2 `MAX_TITLE_PROMPTS`.
const MAX_TITLE_PROMPTS: usize = 3;
/// v2 `MAX_TITLE_USER_SEGMENT`.
const MAX_TITLE_USER_SEGMENT: usize = 400;
/// v2 `MAX_TITLE_FIRST_TURN_ASSISTANT`.
const MAX_TITLE_FIRST_TURN_ASSISTANT: usize = 300;
/// v2 `MAX_TITLE_DIGEST_USER_SEGMENT`.
const MAX_TITLE_DIGEST_USER_SEGMENT: usize = 200;
/// v2 `MAX_TITLE_DIGEST_ASSISTANT`.
const MAX_TITLE_DIGEST_ASSISTANT: usize = 200;
/// v2 `MAX_TITLE_DIGEST_INPUT_LENGTH`.
const MAX_TITLE_DIGEST_INPUT_LENGTH: usize = 3000;
/// v2 `TITLE_DIGEST_ELISION_MARKER`.
const TITLE_DIGEST_ELISION_MARKER: &str = "...";
/// v2 `fetchChatTitle`'s default request timeout.
const CHAT_TITLE_TIMEOUT: Duration = Duration::from_secs(8);

/// Truncate to at most `max` characters.
///
/// v2 slices by UTF-16 code unit; a character count is the closest safe
/// equivalent. `String::truncate` counts bytes and panics when the cut lands
/// inside a code point, which a CJK prompt reaches immediately.
fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// The indices of the natural-language user prompts in `history`.
///
/// v2's `isNaturalLanguagePrompt` also excludes messages whose origin is not
/// `user`; the fork's tool results carry their own `tool` role, so the role
/// check is the whole predicate here.
fn user_prompt_indexes(history: &[LLMMessage]) -> Vec<usize> {
    history
        .iter()
        .enumerate()
        .filter(|(_, message)| message.role == "user" && !message.content.trim().is_empty())
        .map(|(index, _)| index)
        .collect()
}

/// The last assistant text in `span` (v2 `finalAssistantText`).
fn final_assistant_text(span: &[LLMMessage]) -> Option<String> {
    span.iter()
        .rev()
        .filter(|message| message.role == "assistant")
        .map(|message| message.content.trim())
        .find(|text| !text.is_empty())
        .map(str::to_string)
}

/// The `chat_content` for `source`, or `None` when the history cannot supply
/// one (v2 `composeTitleInput`).
pub fn compose_title_input(history: &[LLMMessage], source: &str) -> Option<String> {
    let prompts = user_prompt_indexes(history);
    match source {
        "first_turn" => {
            let first = *prompts.first()?;
            let span_end = prompts.get(1).copied().unwrap_or(history.len());
            let user = history.get(first)?.content.trim();
            let assistant = final_assistant_text(&history[first + 1..span_end])?;
            Some(format!(
                "user: {}\nassistant: {}",
                truncate_chars(user, MAX_TITLE_USER_SEGMENT),
                truncate_chars(&assistant, MAX_TITLE_FIRST_TURN_ASSISTANT),
            ))
        }
        "digest" => {
            let mut turns: Vec<Vec<String>> = Vec::new();
            for (position, index) in prompts.iter().enumerate() {
                let span_end = prompts.get(position + 1).copied().unwrap_or(history.len());
                let user = history.get(*index)?.content.trim();
                let mut group = vec![format!(
                    "user: {}",
                    truncate_chars(user, MAX_TITLE_DIGEST_USER_SEGMENT)
                )];
                if let Some(assistant) = final_assistant_text(&history[index + 1..span_end]) {
                    group.push(format!(
                        "assistant: {}",
                        truncate_chars(&assistant, MAX_TITLE_DIGEST_ASSISTANT)
                    ));
                }
                turns.push(group);
            }
            elide_digest_turns(&turns)
        }
        _ => {
            if prompts.is_empty() {
                return None;
            }
            let joined = prompts
                .iter()
                .take(MAX_TITLE_PROMPTS)
                .filter_map(|index| history.get(*index))
                .map(|message| {
                    format!(
                        "user: {}",
                        truncate_chars(message.content.trim(), MAX_TITLE_USER_SEGMENT)
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            Some(truncate_chars(&joined, MAX_TITLE_INPUT_LENGTH))
        }
    }
}

/// Keep the head and the tail of a long digest, eliding the middle
/// (v2 `elideTitleDigestTurns`).
fn elide_digest_turns(turns: &[Vec<String>]) -> Option<String> {
    if turns.is_empty() {
        return None;
    }
    let joined = turns
        .iter()
        .flatten()
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    if joined.chars().count() <= MAX_TITLE_DIGEST_INPUT_LENGTH {
        return Some(joined);
    }
    // The marker plus the two newlines that join it to the head and the tail.
    let mut budget = MAX_TITLE_DIGEST_INPUT_LENGTH - TITLE_DIGEST_ELISION_MARKER.len() - 2;
    let mut head: Vec<String> = Vec::new();
    for line in &turns[0] {
        let cost = line.chars().count() + 1;
        if budget < cost {
            break;
        }
        head.push(line.clone());
        budget -= cost;
    }
    let mut tail: Vec<String> = Vec::new();
    for group in turns.iter().skip(1).rev() {
        let cost: usize = group.iter().map(|line| line.chars().count() + 1).sum();
        if budget < cost {
            break;
        }
        for line in group.iter().rev() {
            tail.insert(0, line.clone());
        }
        budget -= cost;
    }
    let mut lines = head;
    lines.push(TITLE_DIGEST_ELISION_MARKER.to_string());
    lines.extend(tail);
    Some(lines.join("\n"))
}

/// The title for `history` (v2 `generateTitle`).
///
/// The deterministic sources derive it; `digest` asks the managed platform.
/// `Ok(None)` means the history cannot supply an input — not a failure.
pub async fn generate_session_title(
    history: &[LLMMessage],
    source: Option<&str>,
    llm: &dyn LLM,
) -> Result<Option<String>, String> {
    let source = source.unwrap_or("user_prompts");
    if source != "digest" {
        return crate::session::sqlite_store::derive_session_title(history, Some(source));
    }
    let Some(input) = compose_title_input(history, "digest") else {
        return Ok(None);
    };
    // v2 gates on `isOAuthCatalogVendor(provider.type) && provider.oauth`; the
    // engine's equivalent is the managed seam, which is absent for a static
    // API key and for a host-proxy transport.
    //
    // v2 `generateAndApply` returns `undefined` for every one of these cases —
    // it does **not** fail the call. A session on a static key simply has no
    // managed title channel, which is a normal outcome, not an error the
    // caller should have to catch.
    let Some(target) = llm.media_target().filter(|target| target.uploads_media) else {
        tracing::debug!(
            "chat_title request unavailable: no managed provider for this session's model"
        );
        return Ok(None);
    };
    let Some(credential) = llm.media_upload_credential() else {
        tracing::debug!("chat_title request unavailable: no managed credential");
        return Ok(None);
    };
    let token = credential.await?;
    fetch_chat_title(&target.base_url, &token, &input)
        .await
        .map(Some)
}

/// Ask the managed platform for a title (v2 `fetchChatTitle`).
pub async fn fetch_chat_title(
    base_url: &str,
    token: &str,
    chat_content: &str,
) -> Result<String, String> {
    let url = format!("{}/tools", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "method": "chat_title",
        "params": { "chat_content": chat_content },
    });
    let response = crate::llm::http::SHARED_HTTP_CLIENT
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .timeout(CHAT_TITLE_TIMEOUT)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to generate session title: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Failed to generate session title: HTTP {}",
            response.status().as_u16()
        ));
    }
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to generate session title: {e}"))?;
    let title = payload
        .get("title")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .ok_or_else(|| "Failed to generate session title: missing title.".to_string())?;
    Ok(truncate_chars(title, MAX_GENERATED_TITLE_LENGTH))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history(pairs: &[(&str, &str)]) -> Vec<LLMMessage> {
        let mut messages = Vec::new();
        for (user, assistant) in pairs {
            messages.push(LLMMessage::user(*user));
            if !assistant.is_empty() {
                messages.push(LLMMessage::assistant(*assistant));
            }
        }
        messages
    }

    #[test]
    fn user_prompts_takes_the_first_three_prompts() {
        let messages = history(&[("one", "a"), ("two", "b"), ("three", "c"), ("four", "d")]);
        assert_eq!(
            compose_title_input(&messages, "user_prompts").as_deref(),
            Some("user: one\nuser: two\nuser: three")
        );
    }

    #[test]
    fn first_turn_needs_both_sides() {
        let with_assistant = history(&[("hello", "hi there")]);
        assert_eq!(
            compose_title_input(&with_assistant, "first_turn").as_deref(),
            Some("user: hello\nassistant: hi there")
        );
        // A prompt with no assistant reply yet cannot title the session.
        let without_assistant = history(&[("hello", "")]);
        assert_eq!(compose_title_input(&without_assistant, "first_turn"), None);
    }

    #[test]
    fn digest_groups_each_prompt_with_its_final_assistant_reply() {
        let messages = vec![
            LLMMessage::user("first"),
            LLMMessage::assistant("draft"),
            LLMMessage::assistant("final"),
            LLMMessage::user("second"),
        ];
        assert_eq!(
            compose_title_input(&messages, "digest").as_deref(),
            Some("user: first\nassistant: final\nuser: second")
        );
    }

    #[test]
    fn digest_elides_the_middle_when_it_overflows() {
        let long = "x".repeat(200);
        let pairs: Vec<(&str, &str)> = (0..40).map(|_| (long.as_str(), long.as_str())).collect();
        let messages = history(&pairs);
        let input = compose_title_input(&messages, "digest").expect("a digest");
        assert!(input.contains(TITLE_DIGEST_ELISION_MARKER));
        assert!(
            input.chars().count() <= MAX_TITLE_DIGEST_INPUT_LENGTH,
            "elided digest is {} chars",
            input.chars().count()
        );
        // The head and the tail both survive.
        assert!(input.starts_with("user: xxx"));
        assert!(input.ends_with(&long));
    }

    #[test]
    fn truncation_never_splits_a_code_point() {
        // 60 bytes of CJK is 20 characters; a byte-wise cut at 60 would land
        // inside the 21st and panic.
        let prompt = "汉".repeat(100);
        let messages = vec![LLMMessage::user(prompt)];
        let title = crate::session::sqlite_store::derive_session_title(&messages, None)
            .expect("a title")
            .expect("a prompt");
        assert_eq!(title.chars().count(), 60);
    }

    #[test]
    fn a_history_without_prompts_has_no_input() {
        let messages = vec![LLMMessage::assistant("only an answer")];
        assert_eq!(compose_title_input(&messages, "digest"), None);
        assert_eq!(compose_title_input(&messages, "user_prompts"), None);
    }

    /// Serve one HTTP response and hand back the base URL plus a handle that
    /// resolves to the request line and headers the client sent.
    async fn serve_once(status: &str, body: &str) -> (String, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let status = status.to_string();
        let body = body.to_string();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0u8; 8192];
            let read = socket.read(&mut buffer).await.unwrap_or(0);
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.flush().await;
            request
        });
        (format!("http://{addr}"), handle)
    }

    #[tokio::test]
    async fn chat_title_posts_the_managed_tool_shape_and_reads_the_title() {
        let (base_url, request) = serve_once("200 OK", r#"{"title":"  A short title  "}"#).await;
        let title = fetch_chat_title(&base_url, "token-123", "user: hello")
            .await
            .expect("a 200 with a title");
        assert_eq!(title, "A short title");

        let request = request.await.unwrap().to_ascii_lowercase();
        assert!(request.starts_with("post /tools "), "{request}");
        assert!(
            request.contains("authorization: bearer token-123"),
            "{request}"
        );
        assert!(request.contains(r#""method":"chat_title""#), "{request}");
        assert!(
            request.contains(r#""chat_content":"user: hello""#),
            "{request}"
        );
    }

    #[tokio::test]
    async fn chat_title_reports_a_missing_title() {
        let (base_url, _request) = serve_once("200 OK", "{}").await;
        let error = fetch_chat_title(&base_url, "t", "user: hi")
            .await
            .expect_err("a payload without a title is a failure");
        assert!(error.contains("missing title"), "{error}");
    }

    #[tokio::test]
    async fn chat_title_reports_a_non_success_status() {
        let (base_url, _request) = serve_once("500 Internal Server Error", "{}").await;
        let error = fetch_chat_title(&base_url, "t", "user: hi")
            .await
            .expect_err("a 500 is a failure");
        assert!(error.contains("HTTP 500"), "{error}");
    }

    /// A provider with no managed seam — a static API key, or a host-proxy
    /// transport.
    ///
    /// v2 `generateAndApply` (sessionTitleService.ts:96-105) returns
    /// `undefined` for exactly this case: a session without the managed channel
    /// simply has no title to fetch. It is not an error, and the engine must
    /// not turn it into one the caller has to catch — this test previously
    /// asserted an `Err` naming the missing seam.
    struct StaticLlm;

    impl LLM for StaticLlm {
        fn system_prompt(&self) -> &str {
            ""
        }
        fn model_name(&self) -> &str {
            "static"
        }
        fn is_retryable_error(&self, _error: &str) -> bool {
            false
        }
        fn chat(
            &self,
            _params: crate::turn_loop::types::LLMChatParams,
        ) -> crate::rpc::types::BoxFuture<
            '_,
            Result<
                crate::turn_loop::types::LLMChatResponse,
                Box<dyn std::error::Error + Send + Sync>,
            >,
        > {
            Box::pin(async { Err("unused in this test".into()) })
        }
    }

    #[tokio::test]
    async fn digest_yields_no_title_without_a_managed_provider() {
        let messages = history(&[("hello", "hi there")]);
        assert_eq!(
            generate_session_title(&messages, Some("digest"), &StaticLlm)
                .await
                .expect("an unmanaged provider is a normal outcome, not a failure"),
            None,
            "a static provider cannot title through chat_title, so there is no title"
        );
    }

    #[tokio::test]
    async fn the_deterministic_sources_never_need_a_provider() {
        let messages = history(&[("hello", "hi there")]);
        assert_eq!(
            generate_session_title(&messages, Some("first_turn"), &StaticLlm)
                .await
                .expect("first_turn is deterministic")
                .as_deref(),
            Some("hello")
        );
    }
}
