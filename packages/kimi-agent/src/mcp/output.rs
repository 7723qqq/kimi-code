//! MCP tool-result conversion (v2 `agent/mcp/output.ts`, upstream #3688).
//!
//! Every block an MCP server returns is accounted for. Text reaches the model
//! as text; media reaches it as a [`ContentBlock::MediaRef`], so the request
//! resolver decides per model what can actually be taken (inline base64, a
//! provider reference, or a `<image path="...">` tag); and the original bytes
//! are preserved in the attachment store *before* the block is capped or
//! dropped, so a result the model never saw is still retrievable by `Read`.
//!
//! The notice text is bounded (v2 `MCP_MAX_INLINE_NOTICES_CHARS`): a list too
//! long to inline is itself saved as an attachment and replaced by a pointer,
//! so a server returning fifty images cannot flood the context with paths.

use std::fmt::Write as _;

use sha2::{Digest, Sha256};

use super::types::{McpContent, McpToolCallResult};
use crate::llm::media_resolver::KIMI_FILE_SCHEME;
use crate::rpc::types::{ContentBlock, MediaKind};
use crate::server::files::FileStore;

/// v2 `MCP_MAX_BINARY_PART_BYTES`: one binary part larger than this is not
/// delivered inline, but it is still preserved.
pub const MCP_MAX_BINARY_PART_BYTES: usize = 10 * 1024 * 1024;
/// The same cap expressed in base64 characters (the wire carries text).
const MCP_MAX_BINARY_PART_CHARS: usize = (MCP_MAX_BINARY_PART_BYTES * 4).div_ceil(3);
/// v2 `MCP_MAX_INLINE_NOTICES_CHARS`: above this the attachment list is
/// spilled to a file and replaced by a pointer.
const MCP_MAX_INLINE_NOTICES_CHARS: usize = 4096;

/// One preserved original: where it lives, how to reference it, and where it
/// would sit in a session's media directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedAttachment {
    /// The store id, which is what a [`ContentBlock::MediaRef`] carries.
    pub file_id: String,
    pub path: Option<String>,
    pub reference: String,
    pub relative_path: String,
}

/// The finished tool-result body.
#[derive(Debug, Clone)]
pub struct McpOutput {
    /// Model-facing text: the server's own text plus the attachment notices.
    pub content: String,
    /// Media the model should receive, as references the resolver can inline.
    pub delivery: Vec<ContentBlock>,
    /// `true` when an original was withheld from the model but preserved (or
    /// could not be preserved) — the caller marks the result truncated.
    pub truncated: bool,
}

/// The extension to save `mime_type` under. v2 derives it from the text/media
/// extension tables; the daemon serves by content type, so this only has to be
/// a useful hint for a path-based tool.
fn extension_for_mime(mime_type: &str, bytes: &[u8]) -> &'static str {
    match mime_type {
        "application/pdf" => ".pdf",
        "image/svg+xml" => {
            if bytes.starts_with(&[0x1f, 0x8b]) {
                ".svgz"
            } else {
                ".svg"
            }
        }
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/bmp" => ".bmp",
        "image/heic" => ".heic",
        "image/heif" => ".heif",
        "audio/mpeg" => ".mp3",
        "audio/wav" | "audio/x-wav" => ".wav",
        "audio/ogg" => ".ogg",
        "video/mp4" => ".mp4",
        "video/webm" => ".webm",
        "application/json" => ".json",
        "text/markdown" => ".md",
        "text/csv" => ".csv",
        "text/html" => ".html",
        "text/plain" => ".txt",
        _ => ".bin",
    }
}

/// Normalize a MIME type the way v2 does: parameters dropped, lowercased.
fn normalize_mime(mime_type: &str) -> String {
    mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

/// The media family a MIME type belongs to, when it is one this engine
/// delivers.
fn media_kind_of(mime_type: &str) -> Option<MediaKind> {
    if mime_type.starts_with("image/") {
        Some(MediaKind::Image)
    } else if mime_type.starts_with("audio/") {
        Some(MediaKind::Audio)
    } else if mime_type.starts_with("video/") {
        Some(MediaKind::Video)
    } else {
        None
    }
}

/// The `data:` URL a raw block carries, when it carries one.
fn data_url(mime_type: &str, base64: &str) -> String {
    format!("data:{mime_type};base64,{base64}")
}

/// Split a `data:<mime>;base64,<payload>` URL. `None` for any other URL —
/// a remote link is not ours to preserve.
fn parse_data_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    let meta = meta.strip_suffix(";base64").unwrap_or(meta);
    let mime = if meta.trim().is_empty() {
        "application/octet-stream".to_string()
    } else {
        normalize_mime(meta)
    };
    Some((mime, payload.to_string()))
}

/// Preserve `bytes` under a content-addressed id, so the same original saved
/// twice occupies one blob (v2 `saveAttachment`, output.ts:214-236).
pub fn save_attachment(
    bytes: &[u8],
    mime_type: &str,
    files: &FileStore,
) -> Result<SavedAttachment, String> {
    let mime = normalize_mime(mime_type);
    let mut hasher = Sha256::new();
    hasher.update(mime.as_bytes());
    hasher.update([0u8]);
    hasher.update(bytes);
    let id = format!("f_mcp_{:x}", hasher.finalize());
    let ext = extension_for_mime(&mime, bytes);
    files
        .save_with_id(&id, &format!("attachment{ext}"), &mime, None, bytes)
        .map_err(|(_, _, message)| message)?;
    Ok(SavedAttachment {
        path: files
            .blob_path(&id)
            .map(|path| path.to_string_lossy().to_string()),
        reference: format!("{KIMI_FILE_SCHEME}{id}"),
        relative_path: format!("media/{id}{ext}"),
        file_id: id,
    })
}

/// The notice the model reads for one preserved original (v2
/// `attachmentNotice`, output.ts:205-212): where it is, how to reference it,
/// and which tools can open it.
pub fn attachment_notice(saved: &SavedAttachment, mime_type: &str, size: usize) -> String {
    let mime = normalize_mime(mime_type);
    let mut notice = String::new();
    if let Some(path) = &saved.path {
        let _ = writeln!(notice, "Original attachment saved at: {path:?}");
    }
    let _ = writeln!(notice, "Attachment reference: {:?}", saved.reference);
    let _ = writeln!(
        notice,
        "Session-relative attachment: {:?}",
        saved.relative_path
    );
    let _ = write!(
        notice,
        "MIME: {mime:?}; size: {size} bytes. Pass the attachment reference to Read or \
         ReadMediaFile in the current session. For other binary formats, Read reports the \
         resolved local path for a converter."
    );
    notice
}

fn binary_part_too_large_notice(kind: &str, url_length: usize) -> String {
    let approx_mb = url_length as f64 * 3.0 / 4.0 / (1024.0 * 1024.0);
    let cap_mb = MCP_MAX_BINARY_PART_BYTES / (1024 * 1024);
    format!(
        "[{kind}_url dropped: ~{approx_mb:.1} MB exceeds {cap_mb} MB per-part limit. \
         Try a smaller resource.]"
    )
}

fn dropped_block_notice(reason: &str) -> String {
    format!("[MCP content dropped: {reason}]")
}

/// What one content block became.
struct ConvertedBlock {
    text: Option<String>,
    media: Option<ContentBlock>,
    /// The `data:` URL this block carried, when it carried one — what the
    /// caller preserves.
    inline_url: Option<(String, String)>,
    /// An original worth preserving even though the block was not delivered.
    undelivered: Option<(Vec<u8>, String)>,
}

impl ConvertedBlock {
    fn text_only(text: String) -> Self {
        Self {
            text: Some(text),
            media: None,
            inline_url: None,
            undelivered: None,
        }
    }
}

/// Decode a base64 payload, rejecting anything that is not canonical base64.
fn decode_base64(payload: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    let compact: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(compact.as_bytes())
        .map_err(|e| format!("Invalid base64 attachment: {e}"))
}

/// Convert one MCP content block (v2 `convertMCPContentBlock`, output.ts:50-118).
fn convert_block(block: &McpContent, provider_type: Option<&str>) -> ConvertedBlock {
    let mime = block.mime_type.clone();
    match block.content_type.as_str() {
        "text" | "string" => {
            if let Some(text) = block.text.clone() {
                return ConvertedBlock::text_only(text);
            }
            ConvertedBlock::text_only(dropped_block_notice("text block carried no text"))
        }
        "image" | "audio" | "video" if block.data.is_some() => {
            let default = match block.content_type.as_str() {
                "image" => "image/png",
                "audio" => "audio/mpeg",
                _ => "video/mp4",
            };
            let mime_type = mime.as_deref().unwrap_or(default);
            let payload = block.data.clone().unwrap_or_default();
            let url = data_url(mime_type, &payload);
            ConvertedBlock {
                text: None,
                media: None,
                inline_url: Some((mime_type.to_string(), payload)),
                undelivered: None,
            }
            .with_url(url, mime_type, provider_type)
        }
        "resource" => match block.resource.as_ref() {
            Some(resource) => {
                if let Some(text) = resource.get("text").and_then(|v| v.as_str()) {
                    return ConvertedBlock::text_only(text.to_string());
                }
                let uri = resource
                    .get("uri")
                    .and_then(|v| v.as_str())
                    .unwrap_or("<missing uri>");
                let blob = resource.get("blob").and_then(|v| v.as_str());
                let blob_mime = resource
                    .get("mimeType")
                    .and_then(|v| v.as_str())
                    .unwrap_or("application/octet-stream");
                let Some(blob) = blob else {
                    return ConvertedBlock::text_only(dropped_block_notice(&format!(
                        "resource (uri: {uri}) carried no text or blob payload."
                    )));
                };
                let normalized = normalize_mime(blob_mime);
                if media_kind_of(&normalized).is_some() {
                    return ConvertedBlock {
                        text: None,
                        media: None,
                        inline_url: Some((normalized.clone(), blob.to_string())),
                        undelivered: None,
                    }
                    .with_url(
                        data_url(&normalized, blob),
                        blob_mime,
                        provider_type,
                    );
                }
                // Not a media family this engine delivers: keep the notice and
                // hand the bytes over for preservation anyway.
                let approx_mb = blob.len() as f64 * 3.0 / 4.0 / (1024.0 * 1024.0);
                ConvertedBlock {
                    text: Some(dropped_block_notice(&format!(
                        "resource blob with unsupported mimeType \"{blob_mime}\" \
                         (~{approx_mb:.1} MB, uri: {uri}) was not delivered."
                    ))),
                    media: None,
                    inline_url: None,
                    undelivered: decode_base64(blob).ok().map(|bytes| (bytes, normalized)),
                }
            }
            None => ConvertedBlock::text_only(dropped_block_notice("resource with empty payload")),
        },
        "resource_link" => {
            let uri = block
                .resource
                .as_ref()
                .and_then(|r| r.get("uri"))
                .and_then(|v| v.as_str())
                .or(block.text.as_deref())
                .unwrap_or_default()
                .to_string();
            let mime_type = mime.as_deref().unwrap_or("application/octet-stream");
            let normalized = normalize_mime(mime_type);
            match media_kind_of(&normalized) {
                Some(kind) => ConvertedBlock {
                    text: None,
                    // A `data:` URI on the link carries the bytes: it is
                    // preserved like an inline part (v2 preserves the converted
                    // part's URL, which is this same string).
                    inline_url: parse_data_url(&uri),
                    media: Some(match kind {
                        MediaKind::Image => ContentBlock::ImageUrl {
                            url: uri,
                            id: None,
                            name: None,
                        },
                        // Audio and video are not part of the model-facing
                        // block set yet; they are preserved, not inlined.
                        _ => ContentBlock::Text {
                            text: format!("MCP {} link: {uri}", kind.as_str()),
                        },
                    }),
                    undelivered: None,
                },
                None => ConvertedBlock::text_only(dropped_block_notice(&format!(
                    "resource_link with unsupported mimeType \"{mime_type}\" was not \
                     delivered. Fetch it directly if needed: {uri}"
                ))),
            }
        }
        other => ConvertedBlock::text_only(dropped_block_notice(&format!(
            "content block of unsupported type \"{other}\" was not delivered."
        ))),
    }
}

impl ConvertedBlock {
    /// Attach the inline URL, applying the per-part cap: an oversized part is
    /// not delivered but its URL is still preserved.
    fn with_url(mut self, url: String, mime_type: &str, _provider_type: Option<&str>) -> Self {
        let kind = {
            let normalized = normalize_mime(mime_type);
            match media_kind_of(&normalized) {
                Some(kind) => kind.as_str().to_string(),
                None => "image".to_string(),
            }
        };
        if url.len() > MCP_MAX_BINARY_PART_CHARS {
            self.text = Some(binary_part_too_large_notice(&kind, url.len()));
            self.media = None;
        } else {
            self.media = Some(match normalize_mime(mime_type).as_str() {
                m if m.starts_with("image/") => ContentBlock::ImageUrl {
                    url,
                    id: None,
                    name: None,
                },
                m if m.starts_with("audio/") => ContentBlock::Text {
                    text: "[audio attachment delivered as a reference]".to_string(),
                },
                _ => ContentBlock::Text {
                    text: "[video attachment delivered as a reference]".to_string(),
                },
            });
        }
        self
    }
}

/// Convert a whole MCP result into the model-facing body plus the media the
/// model should receive (v2 `mcpResultToExecutableOutput`, output.ts:126-191).
///
/// `files` is the attachment store. Without one the conversion still accounts
/// for every block (media is delivered inline when the wire allows it) but
/// nothing is preserved, which is what a host with no session store gets.
pub fn mcp_result_to_output(
    result: &McpToolCallResult,
    files: Option<&FileStore>,
    provider_type: Option<&str>,
    cancelled: Option<&(dyn Fn() -> bool + Sync)>,
) -> McpOutput {
    let aborted = || cancelled.is_some_and(|is_cancelled| is_cancelled());
    let mut texts: Vec<String> = Vec::new();
    let mut delivery: Vec<ContentBlock> = Vec::new();
    let mut notices: Vec<String> = Vec::new();
    // payload -> the id it was preserved under, so a repeat of the same
    // original reuses the stored copy instead of sending the bytes again.
    let mut preserved: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut omitted = false;

    for block in &result.content {
        if aborted() {
            break;
        }
        let mut converted = convert_block(block, provider_type);

        // Preserve the original before anything below can cap or drop it.
        let mut media_ref: Option<ContentBlock> = None;
        if let Some((mime, payload)) = converted.inline_url.take() {
            let mime = normalize_mime(&mime);
            let already_saved = preserved.get(&payload).cloned();
            if let Some(file_id) = already_saved {
                media_ref =
                    media_kind_of(&mime).map(|kind| ContentBlock::MediaRef { file_id, kind });
                if media_ref.is_none() {
                    media_ref = converted.media.take();
                }
            } else {
                match files {
                    Some(files) => match decode_base64(&payload)
                        .and_then(|bytes| save_attachment(&bytes, &mime, files).map(|s| (bytes, s)))
                    {
                        Ok((bytes, saved)) => {
                            notices.push(attachment_notice(&saved, &mime, bytes.len()));
                            if let Some(kind) = media_kind_of(&mime) {
                                preserved.insert(payload.clone(), saved.file_id.clone());
                                media_ref = Some(ContentBlock::MediaRef {
                                    file_id: saved.file_id.clone(),
                                    kind,
                                });
                            }
                        }
                        Err(reason) => {
                            omitted = true;
                            notices.push(format!(
                                "Original attachment could not be saved ({mime:?}): {reason}. \
                                 No readable original path is available; original attachment \
                                 preservation is incomplete. Do not repeat the MCP call \
                                 automatically."
                            ));
                        }
                    },
                    None => {
                        // No store: the media can still ride inline for the
                        // families the wire carries as a URL.
                        media_ref = converted.media.take();
                    }
                }
            }
        }
        if let Some((bytes, mime)) = converted.undelivered.take() {
            omitted = true;
            match files {
                Some(files) => match save_attachment(&bytes, &mime, files) {
                    Ok(saved) => notices.push(attachment_notice(&saved, &mime, bytes.len())),
                    Err(reason) => notices.push(format!(
                        "Original attachment could not be saved ({mime:?}): {reason}."
                    )),
                },
                None => notices.push(format!(
                    "Original attachment ({mime:?}, {} bytes) was not preserved: session \
                     attachment storage is unavailable.",
                    bytes.len()
                )),
            }
        }

        if let Some(text) = converted.text {
            texts.push(text);
        }
        if let Some(block) = media_ref.or(converted.media) {
            delivery.push(block);
        }
    }

    let (notice_text, notice_spilled) = bound_notices(&notices, files, &aborted);
    if !notice_text.is_empty() {
        texts.push(notice_text);
    }
    if notice_spilled {
        omitted = true;
    }

    McpOutput {
        content: texts.join("\n"),
        delivery,
        truncated: omitted,
    }
}

/// Bound the attachment list (v2 `attachmentDetails`, output.ts:158-186):
/// inline while it fits, otherwise saved as an attachment and replaced by a
/// pointer the model can hand back to `Read`.
fn bound_notices(
    notices: &[String],
    files: Option<&FileStore>,
    aborted: &(dyn Fn() -> bool + Sync),
) -> (String, bool) {
    let mut seen = std::collections::HashSet::new();
    let content: Vec<&String> = notices.iter().filter(|n| seen.insert(n.as_str())).collect();
    let joined = content
        .iter()
        .map(|n| n.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if joined.len() <= MCP_MAX_INLINE_NOTICES_CHARS {
        return (joined, false);
    }
    let Some(files) = files else {
        let suffix = "The complete MCP attachment list could not be saved separately. \
                      Attachment details are included in the tool output and may be \
                      truncated. Do not repeat the MCP call automatically.";
        return (format!("{joined}\n{suffix}"), true);
    };
    if aborted() {
        return (joined, true);
    }
    match save_attachment(joined.as_bytes(), "text/plain", files) {
        Ok(saved) => {
            let mut pointer = Vec::new();
            if let Some(path) = &saved.path {
                pointer.push(format!("MCP attachment details saved at: {path:?}"));
            }
            pointer.push(format!(
                "Attachment details reference: {:?}",
                saved.reference
            ));
            pointer.push(format!(
                "Session-relative attachment details: {:?}",
                saved.relative_path
            ));
            pointer.push(
                "Pass the attachment details reference to Read to retrieve all original \
                 attachment references and compression details in the current session."
                    .to_string(),
            );
            (pointer.join("\n"), true)
        }
        Err(_) => {
            let suffix = "The complete MCP attachment list could not be saved separately. \
                          Attachment details are included in the tool output and may be \
                          truncated. Do not repeat the MCP call automatically.";
            (format!("{joined}\n{suffix}"), true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use serde_json::json;

    fn store() -> (tempfile::TempDir, FileStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::with_root(dir.path().to_path_buf());
        (dir, store)
    }

    fn png_block(byte: u8) -> McpContent {
        let payload = base64::engine::general_purpose::STANDARD.encode([byte; 64]);
        McpContent {
            content_type: "image".into(),
            text: None,
            mime_type: Some("image/png".into()),
            data: Some(payload),
            resource: None,
        }
    }

    fn result_with(content: Vec<McpContent>) -> McpToolCallResult {
        McpToolCallResult {
            content,
            is_error: false,
            structured_content: None,
            meta: None,
        }
    }

    /// Text reaches the model unchanged and nothing is preserved.
    #[test]
    fn text_blocks_pass_through() {
        let (_dir, files) = store();
        let result = result_with(vec![McpContent {
            content_type: "text".into(),
            text: Some("hello".into()),
            ..Default::default()
        }]);

        let output = mcp_result_to_output(&result, Some(&files), None, None);
        assert_eq!(output.content, "hello");
        assert!(output.delivery.is_empty());
        assert!(!output.truncated);
    }

    /// An inline image is preserved before it is delivered, and the model is
    /// handed a reference the resolver can inline (v2 #3688).
    #[test]
    fn inline_image_is_preserved_and_delivered_as_a_reference() {
        let (_dir, files) = store();
        let output =
            mcp_result_to_output(&result_with(vec![png_block(7)]), Some(&files), None, None);

        assert!(
            output.content.contains("Original attachment saved at:"),
            "{}",
            output.content
        );
        assert!(
            output
                .content
                .contains("Attachment reference: \"kimi-file://f_mcp_"),
            "{}",
            output.content
        );
        let mut file_ids = Vec::new();
        for block in &output.delivery {
            if let ContentBlock::MediaRef { file_id, kind } = block {
                assert_eq!(*kind, MediaKind::Image);
                file_ids.push(file_id.clone());
            }
        }
        assert_eq!(file_ids.len(), 1, "the image must ride as one MediaRef");

        let (_, path) = files
            .get(&file_ids[0])
            .expect("the original is in the store");
        assert!(path.is_file());
        assert_eq!(std::fs::read(&path).unwrap(), vec![7u8; 64]);
        assert_eq!(files.list().unwrap().len(), 1);
    }

    /// The same bytes preserved twice occupy one blob and produce one notice.
    #[test]
    fn the_same_original_is_preserved_once() {
        let (_dir, files) = store();
        let output = mcp_result_to_output(
            &result_with(vec![png_block(7), png_block(7)]),
            Some(&files),
            None,
            None,
        );

        assert_eq!(
            output
                .content
                .matches("Original attachment saved at:")
                .count(),
            1,
            "{}",
            output.content
        );
        assert_eq!(files.list().unwrap().len(), 1);
        // Both occurrences ride as the same reference: the model sees the
        // media twice, the request carries the bytes once.
        let ids: Vec<&String> = output
            .delivery
            .iter()
            .filter_map(|block| match block {
                ContentBlock::MediaRef { file_id, .. } => Some(file_id),
                _ => None,
            })
            .collect();
        assert_eq!(ids.len(), 2, "{:?}", output.delivery);
        assert_eq!(ids[0], ids[1]);
    }

    /// A part over the per-part cap is not delivered, but it is still
    /// preserved: the notice says so and the blob exists.
    #[test]
    fn oversized_part_is_preserved_but_not_delivered() {
        let (_dir, files) = store();
        let payload =
            base64::engine::general_purpose::STANDARD
                .encode(vec![3u8; MCP_MAX_BINARY_PART_BYTES + 1024]);
        let result = result_with(vec![McpContent {
            content_type: "image".into(),
            text: None,
            mime_type: Some("image/png".into()),
            data: Some(payload),
            resource: None,
        }]);

        let output = mcp_result_to_output(&result, Some(&files), None, None);
        assert!(
            output.content.contains("image_url dropped"),
            "{}",
            output.content
        );
        assert!(
            output.content.contains("Original attachment saved at:"),
            "{}",
            output.content
        );
        assert_eq!(files.list().unwrap().len(), 1);
    }

    /// A resource blob whose mime this engine does not deliver is preserved
    /// instead of vanishing, and the result is marked truncated.
    #[test]
    fn undelivered_resource_blob_is_preserved() {
        let (_dir, files) = store();
        let blob = base64::engine::general_purpose::STANDARD.encode(b"zip-ish bytes");
        let result = result_with(vec![McpContent {
            content_type: "resource".into(),
            resource: Some(json!({
                "uri": "file:///tmp/archive.zip",
                "mimeType": "application/zip",
                "blob": blob,
            })),
            ..Default::default()
        }]);

        let output = mcp_result_to_output(&result, Some(&files), None, None);
        assert!(
            output.content.contains("unsupported mimeType"),
            "{}",
            output.content
        );
        assert!(output.truncated);
        assert_eq!(files.list().unwrap().len(), 1);
    }

    /// A long attachment list is spilled and replaced by a pointer, so fifty
    /// images cannot flood the context (v2 `attachmentDetails`).
    #[test]
    fn a_long_notice_list_is_replaced_by_a_pointer() {
        let (_dir, files) = store();
        let blocks: Vec<McpContent> = (0..40u8).map(png_block).collect();
        let output = mcp_result_to_output(&result_with(blocks), Some(&files), None, None);

        assert!(
            output
                .content
                .contains("Pass the attachment details reference to Read"),
            "{}",
            output.content
        );
        assert!(output.truncated);
        // 40 originals plus the spilled details document.
        assert_eq!(files.list().unwrap().len(), 41);
    }

    /// Without a store the conversion still accounts for every block: media
    /// rides inline where the wire allows it and nothing claims to be
    /// preserved.
    #[test]
    fn without_a_store_media_stays_inline() {
        let output = mcp_result_to_output(&result_with(vec![png_block(7)]), None, None, None);

        assert!(!output.content.contains("Original attachment saved at:"));
        assert!(!output.truncated);
        assert!(matches!(
            output.delivery.first(),
            Some(ContentBlock::ImageUrl { .. })
        ));
    }

    /// A request the turn aborted stops converting where it stands.
    #[test]
    fn cancellation_stops_the_conversion() {
        let (_dir, files) = store();
        let cancelled = || true;
        let output = mcp_result_to_output(
            &result_with(vec![png_block(7)]),
            Some(&files),
            None,
            Some(&cancelled),
        );
        assert!(output.delivery.is_empty());
        assert!(files.list().unwrap().is_empty());
    }
}
