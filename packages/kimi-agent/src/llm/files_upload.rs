//! Provider-side media upload (v2 `KimiFiles`).
//!
//! A provider that takes media by reference is sent `ms://<file id>` instead
//! of inline base64: the bytes go up once through the provider's files API and
//! every later request names the upload. v2 gates this on the provider being
//! OAuth-managed (`modelSource === 'oauth-catalog'`); the engine gates it on
//! `NativeLlmConfig.auth_provider`, which is the same set.

use crate::rpc::types::BoxFuture;

/// Why an upload did not produce a file id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadError {
    /// The credential was rejected. The caller must surface this rather than
    /// silently inlining: the user's login is broken, not the upload.
    Auth(String),
    /// The provider serves no files API (v2 `ImageUploadUnsupportedError`).
    /// The caller remembers this and stops trying for the provider.
    Unsupported(String),
    /// Anything else — a network failure, a malformed response. The caller
    /// falls back to inlining.
    Other(String),
}

impl UploadError {
    pub fn message(&self) -> &str {
        match self {
            Self::Auth(message) | Self::Unsupported(message) | Self::Other(message) => message,
        }
    }
}

/// v2 `kimiFilesBaseUrl`: the anthropic route strips the `/v1` segment for the
/// Messages API, but the files API lives under it.
pub fn files_base_url(base_url: &str, protocol: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if protocol != "anthropic" || base.ends_with("/v1") {
        return base.to_string();
    }
    format!("{base}/v1")
}

/// The multipart body one upload sends (v2 `KimiFiles._upload`).
///
/// Hand-rolled rather than pulling in `reqwest`'s `multipart` feature: the
/// daemon already parses the same format by hand on the receiving side
/// (`server::files::parse_multipart`), so the two stay symmetric.
pub fn multipart_body(
    boundary: &str,
    filename: &str,
    media_type: &str,
    purpose: &str,
    bytes: &[u8],
) -> Vec<u8> {
    let mut body = Vec::with_capacity(bytes.len() + 512);
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n\
             Content-Type: {media_type}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Disposition: form-data; name=\"purpose\"\r\n\r\n");
    body.extend_from_slice(purpose.as_bytes());
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

/// A filename the provider can place the upload by (v2 `guessFilename`).
pub fn upload_filename(media_type: &str) -> String {
    let extension = match media_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "video/mp4" => "mp4",
        "video/mpeg" => "mpeg",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "video/x-matroska" => "mkv",
        "video/x-msvideo" => "avi",
        _ => "bin",
    };
    format!("upload.{extension}")
}

/// The provider's file id, when the response carries one.
fn file_id_of(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

/// Classify a non-success status (v2 `isMediaUploadAuthError` +
/// `ImageUploadUnsupportedError`).
fn classify_status(status: u16, body: &str) -> UploadError {
    let message = format!("media upload failed with status {status}: {body}");
    match status {
        401 | 403 => UploadError::Auth(message),
        404 | 405 | 501 => UploadError::Unsupported(message),
        _ => UploadError::Other(message),
    }
}

/// `POST {base}/files` with `purpose=image|video`; returns the provider's file
/// id (v2 `KimiFiles._upload`).
pub async fn upload_media(
    base_url: &str,
    protocol: &str,
    credential: &str,
    purpose: &str,
    filename: &str,
    media_type: &str,
    bytes: &[u8],
) -> Result<String, UploadError> {
    let boundary = format!("----kimi{:016x}", fastrand::u64(..));
    let body = multipart_body(&boundary, filename, media_type, purpose, bytes);
    let url = format!("{}/files", files_base_url(base_url, protocol));
    let mut request = crate::llm::http::SHARED_HTTP_CLIENT
        .post(&url)
        .header(
            "content-type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body);
    // The files API authenticates the same way the chat route does: a bearer
    // token for OpenAI-compatible providers, `x-api-key` for Anthropic.
    request = if protocol == "anthropic" {
        request.header("x-api-key", credential)
    } else {
        request.bearer_auth(credential)
    };
    let response = request
        .send()
        .await
        .map_err(|error| UploadError::Other(format!("media upload failed: {error}")))?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(classify_status(status, &text));
    }
    file_id_of(&text)
        .ok_or_else(|| UploadError::Other(format!("media upload returned no file id: {text}")))
}

/// The credential an upload authenticates with, when the transport has one.
pub type CredentialFuture<'a> = BoxFuture<'a, Result<String, String>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_the_anthropic_route_gets_its_version_segment_back() {
        assert_eq!(
            files_base_url("https://api.example.test", "anthropic"),
            "https://api.example.test/v1"
        );
        assert_eq!(
            files_base_url("https://api.example.test/v1", "anthropic"),
            "https://api.example.test/v1"
        );
        assert_eq!(
            files_base_url("https://api.example.test/v1/", "anthropic"),
            "https://api.example.test/v1"
        );
        // The openai route already carries whatever version it needs.
        assert_eq!(
            files_base_url("https://api.example.test/v1", "openai"),
            "https://api.example.test/v1"
        );
    }

    #[test]
    fn test_the_multipart_body_carries_the_file_and_the_purpose() {
        let body = multipart_body("BOUND", "a.png", "image/png", "image", b"PNG");
        let text = String::from_utf8_lossy(&body);

        assert!(text.starts_with("--BOUND\r\n"), "{text}");
        assert!(
            text.contains("Content-Disposition: form-data; name=\"file\"; filename=\"a.png\""),
            "{text}"
        );
        assert!(text.contains("Content-Type: image/png"), "{text}");
        assert!(text.contains("PNG"), "{text}");
        assert!(
            text.contains("Content-Disposition: form-data; name=\"purpose\"\r\n\r\nimage\r\n"),
            "{text}"
        );
        assert!(text.ends_with("--BOUND--\r\n"), "{text}");
    }

    #[test]
    fn test_a_binary_payload_survives_the_body() {
        let bytes: Vec<u8> = (0u8..=255).collect();
        let body = multipart_body("B", "a.bin", "application/octet-stream", "image", &bytes);

        let at = body
            .windows(bytes.len())
            .position(|window| window == bytes.as_slice())
            .expect("the payload is embedded verbatim");
        assert!(at > 0);
    }

    #[test]
    fn test_the_filename_follows_the_media_type() {
        assert_eq!(upload_filename("image/png"), "upload.png");
        assert_eq!(upload_filename("video/quicktime"), "upload.mov");
        assert_eq!(upload_filename("application/pdf"), "upload.bin");
    }

    #[test]
    fn test_the_response_file_id_is_read() {
        assert_eq!(
            file_id_of(r#"{"id":"file-abc","object":"file"}"#).as_deref(),
            Some("file-abc")
        );
        assert_eq!(file_id_of(r#"{"id":""}"#), None);
        assert_eq!(file_id_of("not json"), None);
    }

    #[test]
    fn test_a_rejected_credential_is_not_a_fallback() {
        assert!(matches!(classify_status(401, "nope"), UploadError::Auth(_)));
        assert!(matches!(classify_status(403, "nope"), UploadError::Auth(_)));
        assert!(matches!(
            classify_status(404, "no such route"),
            UploadError::Unsupported(_)
        ));
        assert!(matches!(
            classify_status(500, "boom"),
            UploadError::Other(_)
        ));
    }
}
