//! Media reference resolution (v2 `AgentMediaResolverService`).
//!
//! The host hands the engine a [`ContentBlock::MediaRef`] — a file id, not
//! bytes. This module turns that reference into what the active model can
//! actually take, at request time: inline base64, a provider-side `ms://`
//! reference, or a `<image path="…">` tag when the model cannot take the
//! media at all.
//!
//! Resolving here rather than inlining at the host boundary is what lets the
//! decision follow the model, and what gives the request media budget a
//! stable per-file identity to key on.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use sha2::{Digest, Sha256};

use crate::llm::files_upload::UploadError;
use crate::llm::media_budget::Entry;
use crate::rpc::types::{ContentBlock, MediaKind};
use crate::server::files::FileStore;
use crate::turn_loop::types::LLMMessage;

/// v2 `IMAGE_UNAVAILABLE_TEXT` / `VIDEO_UNAVAILABLE_TEXT`: what a reference
/// becomes when its blob is gone (expired, pruned, or never stored).
pub const IMAGE_UNAVAILABLE_TEXT: &str =
    "[image omitted: the uploaded file is no longer available]";
pub const VIDEO_UNAVAILABLE_TEXT: &str =
    "[video omitted: the uploaded file is no longer available]";
pub const AUDIO_UNAVAILABLE_TEXT: &str =
    "[audio omitted: the uploaded file is no longer available]";

/// The placeholder for a reference whose bytes cannot be read.
pub fn unavailable_text(kind: MediaKind) -> &'static str {
    match kind {
        MediaKind::Image => IMAGE_UNAVAILABLE_TEXT,
        MediaKind::Video => VIDEO_UNAVAILABLE_TEXT,
        MediaKind::Audio => AUDIO_UNAVAILABLE_TEXT,
    }
}

/// The `state_entries` domain the persisted upload tier lives in (v2's blob
/// store `image-upload-cache` scope).
pub const UPLOAD_CACHE_DOMAIN: &str = "media_upload_cache";

/// v2 `escapeMediaAttribute`.
fn escape_media_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// v2 `buildMediaPathTag`: the tag a model reads to re-open the file itself.
pub fn build_media_path_tag(kind: MediaKind, path: &str) -> String {
    format!(
        "<{} path=\"{}\"></{}>",
        kind.as_str(),
        escape_media_attribute(path),
        kind.as_str()
    )
}

/// What the resolver needs to know about the model behind an LLM (v2
/// `ModelRequester.model`): which media it accepts, and — for a provider that
/// takes media by reference — where the upload goes.
#[derive(Debug, Clone, Default)]
pub struct MediaTarget {
    /// Wire protocol (`"openai"` / `"anthropic"`), for the upload route.
    pub protocol: String,
    /// API base URL, for the upload route.
    pub base_url: String,
    /// The provider identity the upload cache is keyed by.
    pub provider_key: String,
    /// The model takes images (`capabilities.image_in`).
    pub image_in: bool,
    /// The model takes video (`capabilities.video_in`).
    pub video_in: bool,
    /// The model takes audio (`capabilities.audio_in`).
    pub audio_in: bool,
    /// The provider takes media by reference (v2's `modelSource ===
    /// 'oauth-catalog'` gate): the resolver uploads instead of inlining.
    pub uploads_media: bool,
}

impl MediaTarget {
    /// Whether the model accepts this media family. An unknown target accepts
    /// everything — a turn with no model metadata (a test stub, a host-proxy
    /// transport) must not silently drop the user's media.
    fn accepts(&self, kind: MediaKind) -> bool {
        match kind {
            MediaKind::Image => self.image_in,
            MediaKind::Video => self.video_in,
            MediaKind::Audio => self.audio_in,
        }
    }
}

/// The daemon file id a block references, with the media family the
/// submitting part claimed.
pub fn media_ref_of(block: &ContentBlock) -> Option<(&str, MediaKind)> {
    match block {
        ContentBlock::MediaRef { file_id, kind } => Some((file_id.as_str(), *kind)),
        _ => None,
    }
}

/// The daemon file scheme a client uses to reference an uploaded file
/// (v2 `KIMI_FILE_SCHEME`).
pub const KIMI_FILE_SCHEME: &str = "kimi-file://";

/// The file id a `kimi-file://<id>` URL names (v2 `parseDaemonFileUrl`). A
/// `?query` suffix is dropped: the engine's prompt intake appends the saved
/// path there, and the id is what identifies the file.
pub fn parse_daemon_file_url(url: &str) -> Option<&str> {
    let rest = url.strip_prefix(KIMI_FILE_SCHEME)?;
    let file_id = rest.split('?').next().unwrap_or("");
    (!file_id.is_empty()).then_some(file_id)
}

/// Rewrite `kimi-file://` URL blocks into [`ContentBlock::MediaRef`].
///
/// The client submits a reference as an ordinary media URL; the engine is the
/// side that knows it is a daemon file. Converting at intake is what keeps the
/// reference from reaching a provider as an unfetchable `kimi-file://` URL.
pub fn normalize_media_refs(blocks: Vec<ContentBlock>) -> Vec<ContentBlock> {
    blocks
        .into_iter()
        .map(|block| {
            let (url, kind) = match &block {
                ContentBlock::ImageUrl { url, .. } => (url, MediaKind::Image),
                ContentBlock::VideoUrl { url, .. } => (url, MediaKind::Video),
                ContentBlock::AudioUrl { url, .. } => (url, MediaKind::Audio),
                _ => return block,
            };
            match parse_daemon_file_url(url) {
                Some(file_id) => ContentBlock::MediaRef {
                    file_id: file_id.to_string(),
                    kind,
                },
                None => block,
            }
        })
        .collect()
}

/// Whether any block in the list still carries an unresolved reference.
pub fn has_media_refs(messages: &[LLMMessage]) -> bool {
    messages
        .iter()
        .any(|message| message.blocks.iter().any(|b| media_ref_of(b).is_some()))
}

/// `data:` plus `;base64,` — what an inline image's wire URL adds to its
/// base64 payload.
const DATA_URL_PREFIX_BYTES: usize = 13;

/// The bytes one resolved block costs on the wire (v2 `inlinePartBytes`): a
/// data URL's length, and nothing for a provider-side reference.
fn inline_bytes(block: &ContentBlock) -> usize {
    match block {
        ContentBlock::Image {
            media_type, data, ..
        } => DATA_URL_PREFIX_BYTES + media_type.len() + data.len(),
        ContentBlock::ImageUrl { url, .. }
        | ContentBlock::AudioUrl { url, .. }
        | ContentBlock::VideoUrl { url, .. }
            if url.starts_with("data:") =>
        {
            url.len()
        }
        _ => 0,
    }
}

/// The budget entries a history carries with no store behind it: inline
/// payloads only, since a reference cannot be read without one.
pub fn inline_entries(messages: &[LLMMessage]) -> Vec<Entry> {
    let mut entries = Vec::new();
    for (message_index, message) in messages.iter().enumerate() {
        for (block_index, block) in message.blocks.iter().enumerate() {
            if let Some((kind, bytes, key)) = inline_budget(block) {
                entries.push(Entry {
                    message_index,
                    block_index,
                    key,
                    file_id: None,
                    path: None,
                    kind,
                    bytes,
                });
            }
        }
    }
    entries
}

/// The budget identity of a block that carries its own bytes (v2
/// `inlineMediaBudgetEntry`): a payload with no file behind it is keyed by a
/// hash of what it carries, so identical payloads share one budget item.
fn inline_budget(block: &ContentBlock) -> Option<(MediaKind, usize, String)> {
    let (kind, bytes, pieces): (MediaKind, usize, Vec<&str>) = match block {
        ContentBlock::Image {
            media_type, data, ..
        } => (
            MediaKind::Image,
            DATA_URL_PREFIX_BYTES + media_type.len() + data.len(),
            vec![media_type, data],
        ),
        ContentBlock::ImageUrl { url, .. } if url.starts_with("data:") => {
            (MediaKind::Image, url.len(), vec![url])
        }
        ContentBlock::VideoUrl { url, .. } if url.starts_with("data:") => {
            (MediaKind::Video, url.len(), vec![url])
        }
        ContentBlock::AudioUrl { url, .. } if url.starts_with("data:") => {
            (MediaKind::Audio, url.len(), vec![url])
        }
        _ => return None,
    };
    let mut hasher = Sha256::new();
    hasher.update(kind.as_str().as_bytes());
    hasher.update([0u8]);
    for piece in pieces {
        hasher.update(piece.as_bytes());
        hasher.update([0u8]);
    }
    Some((kind, bytes, format!("inline\0{:x}", hasher.finalize())))
}

/// A request after media resolution: the messages to send, plus the media the
/// budget must weigh.
///
/// The entries are built here because this is the side that knows which file
/// a block came from — the resolved block itself no longer says.
pub struct ResolvedRequest<'a> {
    pub messages: Cow<'a, [LLMMessage]>,
    pub entries: Vec<Entry>,
}

/// Resolves [`ContentBlock::MediaRef`] blocks against the daemon file store.
///
/// One resolver serves a session: the memo it keeps is what stops a media
/// item from being re-read — or re-uploaded — on every step of a turn.
pub struct MediaResolver {
    store: FileStore,
    /// Resolved blocks, keyed by `(file id, provider key)`. v2 keeps the same
    /// map in agent state (`media.resolved`).
    resolved: Mutex<HashMap<String, ContentBlock>>,
    /// Providers that answered an upload with "no such route" (v2
    /// `imageUploadUnsupported`): the resolver stops trying for them.
    upload_unsupported: Mutex<std::collections::HashSet<String>>,
    /// The persisted upload tier (v2's blob-store `image-upload-cache`
    /// scope): `(file id, provider key)` → provider file id, so a daemon
    /// restart reuses the provider-side upload instead of repeating it.
    /// `None` keeps the memo process-only (tests, store-less hosts).
    upload_cache: Option<Arc<crate::session::sqlite_store::SqliteSessionStore>>,
}

impl Default for MediaResolver {
    fn default() -> Self {
        Self::new()
    }
}

impl MediaResolver {
    /// A resolver over the daemon's own file store.
    pub fn new() -> Self {
        Self::with_store(FileStore::new())
    }

    /// A resolver over an explicit store (tests).
    pub fn with_store(store: FileStore) -> Self {
        Self {
            store,
            resolved: Mutex::new(HashMap::new()),
            upload_unsupported: Mutex::new(std::collections::HashSet::new()),
            upload_cache: None,
        }
    }

    /// Persist successful uploads through `store` (v2's `image-upload-cache`
    /// scope): a later resolver over the same store reuses the provider-side
    /// file instead of uploading again.
    pub fn with_upload_cache(
        mut self,
        store: Arc<crate::session::sqlite_store::SqliteSessionStore>,
    ) -> Self {
        self.upload_cache = Some(store);
        self
    }

    /// Every media entry of `messages`, in message order — the reference
    /// entries (with their saved paths) plus the inline ones. The degrade /
    /// strip recoveries run on the *unresolved* messages, where a reference
    /// still names its file, so this is the entry list they transform by.
    pub fn media_entries(&self, messages: &[LLMMessage]) -> Vec<Entry> {
        let mut entries = Vec::new();
        for (message_index, message) in messages.iter().enumerate() {
            for (block_index, block) in message.blocks.iter().enumerate() {
                if let Some((file_id, kind)) = media_ref_of(block) {
                    entries.push(Entry {
                        message_index,
                        block_index,
                        key: file_id.to_string(),
                        file_id: Some(file_id.to_string()),
                        path: self.display_path(file_id),
                        kind,
                        bytes: 0,
                    });
                } else if let Some((kind, bytes, key)) = inline_budget(block) {
                    entries.push(Entry {
                        message_index,
                        block_index,
                        key,
                        file_id: None,
                        path: None,
                        kind,
                        bytes,
                    });
                }
            }
        }
        entries
    }

    /// Rewrite every reference in `messages` into a request-ready block, and
    /// collect the media the budget must weigh.
    ///
    /// `credential` is the provider credential an upload would authenticate
    /// with; `None` inlines instead. A history with neither references nor
    /// inline media is returned borrowed, so a text-only turn costs nothing.
    ///
    /// `Err` carries a rejected upload credential and nothing else (v2
    /// `isMediaUploadAuthError` → throw, mediaResolverService.ts:356): the
    /// user's login is broken, so the request fails with the upload's own
    /// error instead of degrading the media and letting the chat request
    /// report a different failure.
    pub async fn resolve<'a>(
        &self,
        messages: &'a [LLMMessage],
        target: Option<&MediaTarget>,
        credential: Option<&str>,
    ) -> Result<ResolvedRequest<'a>, UploadError> {
        let mut entries = Vec::new();
        let mut out: Option<Vec<LLMMessage>> = None;
        for (message_index, message) in messages.iter().enumerate() {
            let mut blocks: Option<Vec<ContentBlock>> = None;
            for (block_index, block) in message.blocks.iter().enumerate() {
                match media_ref_of(block) {
                    Some((file_id, kind)) => {
                        let (resolved, path) =
                            self.resolve_one(file_id, kind, target, credential).await?;
                        entries.push(Entry {
                            message_index,
                            block_index,
                            key: file_id.to_string(),
                            file_id: Some(file_id.to_string()),
                            path,
                            kind,
                            bytes: inline_bytes(&resolved),
                        });
                        // The blocks before this one are carried over as they
                        // were; only the reference is replaced.
                        blocks
                            .get_or_insert_with(|| message.blocks[..block_index].to_vec())
                            .push(resolved);
                    }
                    None => {
                        if let Some((kind, bytes, key)) = inline_budget(block) {
                            entries.push(Entry {
                                message_index,
                                block_index,
                                key,
                                file_id: None,
                                path: None,
                                kind,
                                bytes,
                            });
                        }
                        if let Some(blocks) = blocks.as_mut() {
                            blocks.push(block.clone());
                        }
                    }
                }
            }
            match blocks {
                Some(blocks) => {
                    out.get_or_insert_with(|| messages[..message_index].to_vec())
                        .push(LLMMessage {
                            blocks,
                            ..message.clone()
                        });
                }
                None => {
                    if let Some(out) = out.as_mut() {
                        out.push(message.clone());
                    }
                }
            }
        }
        Ok(ResolvedRequest {
            messages: match out {
                Some(messages) => Cow::Owned(messages),
                None => Cow::Borrowed(messages),
            },
            entries,
        })
    }

    /// The saved path of one referenced file, for a caller that wants to show
    /// it (v2 `displayPaths`).
    pub fn display_path(&self, file_id: &str) -> Option<String> {
        self.store
            .get(file_id)
            .ok()
            .map(|(_, path)| path.to_string_lossy().into_owned())
    }

    async fn resolve_one(
        &self,
        file_id: &str,
        kind: MediaKind,
        target: Option<&MediaTarget>,
        credential: Option<&str>,
    ) -> Result<(ContentBlock, Option<String>), UploadError> {
        let cache_key = format!(
            "{file_id}\0{}",
            target.map(|t| t.provider_key.as_str()).unwrap_or("")
        );
        if let Some(hit) = self
            .resolved
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&cache_key)
        {
            return Ok((hit.clone(), self.display_path(file_id)));
        }
        // The persisted upload tier (v2 `image-upload-cache`): a provider
        // file id recorded by an earlier process answers without an upload.
        // Only upload results live here — an inline block is bytes, not an
        // identity, and re-reading the blob is cheaper than storing it.
        if let Some(provider_file_id) = self.cached_upload(file_id, target) {
            let block = reference_block(kind, &provider_file_id);
            self.resolved
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(cache_key, block.clone());
            return Ok((block, self.display_path(file_id)));
        }
        let block = self
            .resolve_uncached(file_id, kind, target, credential)
            .await?;
        self.resolved
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(cache_key, block.clone());
        Ok((block, self.display_path(file_id)))
    }

    /// The provider file id an earlier process uploaded this file as, for
    /// this provider (v2's cache scope read).
    fn cached_upload(&self, file_id: &str, target: Option<&MediaTarget>) -> Option<String> {
        let store = self.upload_cache.as_ref()?;
        let key = format!(
            "{file_id}\0{}",
            target.map(|t| t.provider_key.as_str()).unwrap_or("")
        );
        store
            .get_state(UPLOAD_CACHE_DOMAIN, &key)
            .ok()
            .flatten()
            .and_then(|value| value.as_str().map(str::to_string))
            .filter(|id| !id.is_empty())
    }

    /// Record a successful upload for later processes (v2's cache scope
    /// write). A failed write costs the next process one re-upload, so it is
    /// logged, not propagated.
    fn remember_upload(&self, file_id: &str, target: &MediaTarget, provider_file_id: &str) {
        let Some(store) = self.upload_cache.as_ref() else {
            return;
        };
        let key = format!("{file_id}\0{}", target.provider_key);
        if let Err(error) = store.put_state(
            UPLOAD_CACHE_DOMAIN,
            &key,
            &serde_json::json!(provider_file_id),
        ) {
            tracing::warn!(
                file_id,
                provider_key = %target.provider_key,
                %error,
                "failed to persist the media upload cache entry"
            );
        }
    }

    async fn resolve_uncached(
        &self,
        file_id: &str,
        kind: MediaKind,
        target: Option<&MediaTarget>,
        credential: Option<&str>,
    ) -> Result<ContentBlock, UploadError> {
        let Ok((meta, path)) = self.store.get(file_id) else {
            return Ok(ContentBlock::Text {
                text: unavailable_text(kind).to_string(),
            });
        };
        let path = path.to_string_lossy().into_owned();
        // A model that cannot take this media family still gets the path: the
        // tag is what lets it re-open the file with its own tools.
        if target.is_some_and(|t| !t.accepts(kind)) {
            return Ok(ContentBlock::Text {
                text: build_media_path_tag(kind, &path),
            });
        }
        let Ok(bytes) = std::fs::read(&path) else {
            return Ok(ContentBlock::Text {
                text: unavailable_text(kind).to_string(),
            });
        };
        let media_type = if meta.media_type.is_empty() {
            crate::server::infer_media_type(std::path::Path::new(&path))
        } else {
            meta.media_type.clone()
        };
        let name = (!meta.name.is_empty()).then(|| meta.name.clone());
        if let Some(uploaded) = self
            .upload(file_id, kind, target, credential, &media_type, &bytes)
            .await?
        {
            return Ok(uploaded);
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(match kind {
            MediaKind::Image => ContentBlock::Image {
                media_type,
                data: encoded,
                name,
            },
            MediaKind::Video => ContentBlock::VideoUrl {
                url: format!("data:{media_type};base64,{encoded}"),
                id: None,
                name,
            },
            MediaKind::Audio => ContentBlock::AudioUrl {
                url: format!("data:{media_type};base64,{encoded}"),
                id: None,
                name,
            },
        })
    }

    /// The provider-side reference for one file, when the provider takes media
    /// that way (v2 `uploadImagePart` / `resolveVideoPart`). `Ok(None)` means
    /// the caller inlines instead; `Err` carries a rejected credential, which
    /// v2 throws rather than degrading (mediaResolverService.ts:356).
    async fn upload(
        &self,
        file_id: &str,
        kind: MediaKind,
        target: Option<&MediaTarget>,
        credential: Option<&str>,
        media_type: &str,
        bytes: &[u8],
    ) -> Result<Option<ContentBlock>, UploadError> {
        let Some(target) = target else {
            return Ok(None);
        };
        if !target.uploads_media {
            return Ok(None);
        }
        let Some(credential) = credential else {
            return Ok(None);
        };
        if self
            .upload_unsupported
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&target.provider_key)
        {
            return Ok(None);
        }
        let purpose = match kind {
            MediaKind::Image => "image",
            MediaKind::Video => "video",
            // The files API has no audio purpose; audio stays inline.
            MediaKind::Audio => return Ok(None),
        };
        let filename = crate::llm::files_upload::upload_filename(media_type);
        match crate::llm::files_upload::upload_media(
            &target.base_url,
            &target.protocol,
            credential,
            purpose,
            &filename,
            media_type,
            bytes,
        )
        .await
        {
            Ok(id) => {
                self.remember_upload(file_id, target, &id);
                Ok(Some(reference_block(kind, &id)))
            }
            Err(crate::llm::files_upload::UploadError::Unsupported(_)) => {
                self.upload_unsupported
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(target.provider_key.clone());
                Ok(None)
            }
            // v2 `isMediaUploadAuthError` → throw: the user's login is
            // broken, so the request fails with the upload's own error
            // instead of degrading the media to a path tag and letting the
            // chat request report a different failure (ROADMAP #17 ③).
            Err(error @ crate::llm::files_upload::UploadError::Auth(_)) => Err(error),
            Err(crate::llm::files_upload::UploadError::Other(_)) => Ok(None),
        }
    }
}

/// The `ms://<id>` block a successful upload becomes (v2 `uploadImage` /
/// `uploadVideo`).
fn reference_block(kind: MediaKind, id: &str) -> ContentBlock {
    let url = format!("ms://{id}");
    match kind {
        MediaKind::Image => ContentBlock::ImageUrl {
            url,
            id: Some(id.to_string()),
            name: None,
        },
        MediaKind::Video => ContentBlock::VideoUrl {
            url,
            id: Some(id.to_string()),
            name: None,
        },
        MediaKind::Audio => ContentBlock::AudioUrl {
            url,
            id: Some(id.to_string()),
            name: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::files::FileStore;

    fn store_with(name: &str, media_type: &str, bytes: &[u8]) -> (FileStore, String) {
        let dir = std::env::temp_dir().join(format!("kimi-media-resolver-{}", fastrand::u64(..)));
        let store = FileStore::with_root(dir);
        let meta = store.save(name, media_type, None, bytes).unwrap();
        (store, meta.id)
    }

    fn ref_message(file_id: &str, kind: MediaKind) -> LLMMessage {
        LLMMessage {
            role: "user".into(),
            content: String::new(),
            blocks: vec![ContentBlock::MediaRef {
                file_id: file_id.to_string(),
                kind,
            }],
            tool_calls: Vec::new(),
            tool_call_id: None,
            prompt_id: None,
        }
    }

    fn accepting() -> MediaTarget {
        MediaTarget {
            image_in: true,
            video_in: true,
            audio_in: true,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn test_a_reference_inlines_when_the_model_takes_the_media() {
        let (store, file_id) = store_with("a.png", "image/png", b"PNGDATA");
        let resolver = MediaResolver::with_store(store);

        let messages = [ref_message(&file_id, MediaKind::Image)];
        let out = resolver
            .resolve(&messages, Some(&accepting()), None)
            .await
            .unwrap();

        assert_eq!(
            out.messages[0].blocks[0],
            ContentBlock::Image {
                media_type: "image/png".into(),
                data: base64::engine::general_purpose::STANDARD.encode(b"PNGDATA"),
                name: Some("a.png".into()),
            }
        );
        assert_eq!(out.entries.len(), 1);
        assert_eq!(out.entries[0].key, file_id);
        assert_eq!(out.entries[0].file_id.as_deref(), Some(file_id.as_str()));
        assert!(out.entries[0].path.is_some(), "the saved path is known");
        assert!(out.entries[0].bytes > 0, "an inlined image costs bytes");
    }

    #[tokio::test]
    async fn test_a_model_that_cannot_take_the_media_gets_the_saved_path() {
        let (store, file_id) = store_with("a.png", "image/png", b"PNGDATA");
        let resolver = MediaResolver::with_store(store);
        let target = MediaTarget {
            image_in: false,
            ..accepting()
        };

        let messages = [ref_message(&file_id, MediaKind::Image)];
        let out = resolver
            .resolve(&messages, Some(&target), None)
            .await
            .unwrap();

        let ContentBlock::Text { text } = &out.messages[0].blocks[0] else {
            panic!("expected a path tag, got {:?}", out.messages[0].blocks[0]);
        };
        assert!(text.starts_with("<image path=\""), "{text}");
        assert!(text.ends_with("\"></image>"), "{text}");
        assert!(text.contains(&file_id), "{text}");
        assert_eq!(out.entries[0].bytes, 0, "a path tag costs no request bytes");
    }

    #[tokio::test]
    async fn test_a_missing_blob_becomes_the_unavailable_placeholder() {
        let dir = std::env::temp_dir().join(format!("kimi-media-gone-{}", fastrand::u64(..)));
        let resolver = MediaResolver::with_store(FileStore::with_root(dir));

        let messages = [ref_message("f_missing", MediaKind::Video)];
        let out = resolver
            .resolve(&messages, Some(&accepting()), None)
            .await
            .unwrap();

        assert_eq!(
            out.messages[0].blocks[0],
            ContentBlock::Text {
                text: VIDEO_UNAVAILABLE_TEXT.into()
            }
        );
        assert_eq!(out.entries[0].bytes, 0);
    }

    #[tokio::test]
    async fn test_a_history_without_media_is_returned_borrowed() {
        let resolver = MediaResolver::new();
        let messages = vec![LLMMessage::new("user", "hello")];

        let out = resolver
            .resolve(&messages, Some(&accepting()), None)
            .await
            .unwrap();

        assert!(matches!(out.messages, Cow::Borrowed(_)));
        assert!(out.entries.is_empty());
    }

    #[tokio::test]
    async fn test_inline_media_is_budgeted_without_a_file_behind_it() {
        let resolver = MediaResolver::new();
        let messages = vec![LLMMessage {
            role: "user".into(),
            content: String::new(),
            blocks: vec![ContentBlock::Image {
                media_type: "image/png".into(),
                data: "AAAA".into(),
                name: None,
            }],
            tool_calls: Vec::new(),
            tool_call_id: None,
            prompt_id: None,
        }];

        let out = resolver
            .resolve(&messages, Some(&accepting()), None)
            .await
            .unwrap();

        assert!(matches!(out.messages, Cow::Borrowed(_)));
        assert_eq!(out.entries.len(), 1);
        assert!(out.entries[0].key.starts_with("inline\0"));
        assert_eq!(out.entries[0].file_id, None);
        assert_eq!(out.entries[0].bytes, DATA_URL_PREFIX_BYTES + 9 + 4);
    }

    #[tokio::test]
    async fn test_a_remote_url_is_not_budgeted() {
        let resolver = MediaResolver::new();
        let messages = vec![LLMMessage {
            role: "user".into(),
            content: String::new(),
            blocks: vec![ContentBlock::ImageUrl {
                url: "https://example.test/huge.png".into(),
                id: None,
                name: None,
            }],
            tool_calls: Vec::new(),
            tool_call_id: None,
            prompt_id: None,
        }];

        let out = resolver
            .resolve(&messages, Some(&accepting()), None)
            .await
            .unwrap();

        assert!(
            out.entries.is_empty(),
            "a remote URL costs no request bytes"
        );
    }

    #[tokio::test]
    async fn test_the_resolved_block_is_memoized_per_file_and_provider() {
        let (store, file_id) = store_with("a.png", "image/png", b"PNGDATA");
        let resolver = MediaResolver::with_store(store);
        let message = ref_message(&file_id, MediaKind::Image);

        let first_messages = [message.clone()];
        let first = resolver
            .resolve(&first_messages, Some(&accepting()), None)
            .await
            .unwrap();
        // The blob is gone, but the memo still answers: the file was already
        // read once for this provider.
        let second_messages = [message];
        let second = resolver
            .resolve(&second_messages, Some(&accepting()), None)
            .await
            .unwrap();

        assert_eq!(first.messages[0].blocks[0], second.messages[0].blocks[0]);
    }

    /// v2 keeps the upload result in the blob store's `image-upload-cache`
    /// scope, so a daemon restart reuses the provider-side file instead of
    /// uploading again (ROADMAP #17 ①). The fork's tier is a `state_entries`
    /// domain keyed by `(file id, provider key)`; a fresh resolver over the
    /// same store must answer from it without a second request.
    #[tokio::test]
    async fn an_upload_survives_a_resolver_restart_through_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let files = FileStore::with_root(dir.path().join("files"));
        let png = files.save("a.png", "image/png", None, b"PNGDATA").unwrap();
        let sqlite =
            Arc::new(crate::session::sqlite_store::SqliteSessionStore::in_memory().unwrap());
        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (base_url, server) = spawn_counting_files_server(Arc::clone(&requests)).await;
        let target = MediaTarget {
            protocol: "openai".into(),
            base_url,
            provider_key: "kimi".into(),
            uploads_media: true,
            ..accepting()
        };
        let messages = [ref_message(&png.id, MediaKind::Image)];

        let first = MediaResolver::with_store(files.clone())
            .with_upload_cache(sqlite.clone())
            .resolve(&messages, Some(&target), Some("token"))
            .await
            .unwrap();
        assert_eq!(
            first.messages[0].blocks[0],
            ContentBlock::ImageUrl {
                url: "ms://file-abc".into(),
                id: Some("file-abc".into()),
                name: None,
            }
        );

        // A fresh resolver (the restart) answers from the persisted tier: the
        // same reference, and the files API saw exactly one request.
        let second = MediaResolver::with_store(files)
            .with_upload_cache(sqlite)
            .resolve(&messages, Some(&target), Some("token"))
            .await
            .unwrap();
        assert_eq!(second.messages[0].blocks[0], first.messages[0].blocks[0]);
        assert_eq!(requests.load(std::sync::atomic::Ordering::SeqCst), 1);
        server.await.unwrap();
    }

    /// A mock files API that counts its requests and always answers with a
    /// file id. It serves exactly one connection and returns: a wrong second
    /// upload attempt is then refused, which fails the block assertion — the
    /// counter is the diagnostic for which side went wrong.
    async fn spawn_counting_files_server(
        requests: Arc<std::sync::atomic::AtomicUsize>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            requests.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let mut buf = vec![0u8; 65536];
            let _ = sock.read(&mut buf).await;
            let body = "{\"id\":\"file-abc\"}";
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\
                 content-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.flush().await;
        });
        (format!("http://{addr}"), server)
    }

    /// A mock files API: one request, answered with `status` and `body`.
    async fn spawn_files_server(
        status: u16,
        body: &'static str,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 65536];
            let _ = sock.read(&mut buf).await;
            let head = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n\
                 content-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(head.as_bytes()).await;
            let _ = sock.flush().await;
        });
        (format!("http://{addr}"), server)
    }

    #[tokio::test]
    async fn test_an_upload_capable_provider_gets_a_reference_instead_of_bytes() {
        let (store, file_id) = store_with("a.png", "image/png", b"PNGDATA");
        let resolver = MediaResolver::with_store(store);
        let (base_url, server) = spawn_files_server(200, "{\"id\":\"file-abc\"}").await;
        let target = MediaTarget {
            protocol: "openai".into(),
            base_url,
            provider_key: "kimi".into(),
            uploads_media: true,
            ..accepting()
        };
        let messages = [ref_message(&file_id, MediaKind::Image)];

        let out = resolver
            .resolve(&messages, Some(&target), Some("token"))
            .await
            .unwrap();

        assert_eq!(
            out.messages[0].blocks[0],
            ContentBlock::ImageUrl {
                url: "ms://file-abc".into(),
                id: Some("file-abc".into()),
                name: None,
            }
        );
        assert_eq!(
            out.entries[0].bytes, 0,
            "a provider-side reference costs no request bytes"
        );
        server.await.unwrap();
    }

    /// v2 `isMediaUploadAuthError` → throw (mediaResolverService.ts:356): a
    /// rejected credential fails the resolve with the upload's own error
    /// instead of degrading the media to a path tag and letting the chat
    /// request report a different failure (ROADMAP #17 ③).
    #[tokio::test]
    async fn test_a_rejected_upload_credential_fails_the_resolve() {
        let (store, file_id) = store_with("a.png", "image/png", b"PNGDATA");
        let resolver = MediaResolver::with_store(store);
        let (base_url, server) = spawn_files_server(401, "unauthorized").await;
        let target = MediaTarget {
            protocol: "openai".into(),
            base_url,
            provider_key: "kimi".into(),
            uploads_media: true,
            ..accepting()
        };
        let messages = [ref_message(&file_id, MediaKind::Image)];

        let error = resolver
            .resolve(&messages, Some(&target), Some("bad-token"))
            .await
            .err()
            .expect("a rejected credential fails the resolve");

        assert!(matches!(error, UploadError::Auth(_)), "{error:?}");
        assert!(error.message().contains("401"), "{}", error.message());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn test_an_upload_capable_provider_without_a_credential_inlines() {
        let (store, file_id) = store_with("a.png", "image/png", b"PNGDATA");
        let resolver = MediaResolver::with_store(store);
        let target = MediaTarget {
            protocol: "openai".into(),
            base_url: "http://127.0.0.1:1".into(),
            provider_key: "kimi".into(),
            uploads_media: true,
            ..accepting()
        };
        let messages = [ref_message(&file_id, MediaKind::Image)];

        let out = resolver
            .resolve(&messages, Some(&target), None)
            .await
            .unwrap();

        assert!(
            matches!(&out.messages[0].blocks[0], ContentBlock::Image { .. }),
            "no credential means no upload: {:?}",
            out.messages[0].blocks[0]
        );
    }

    #[test]
    fn test_a_path_tag_escapes_the_attribute() {
        assert_eq!(
            build_media_path_tag(MediaKind::Image, "/a\"b&c<d>"),
            "<image path=\"/a&quot;b&amp;c&lt;d&gt;\"></image>"
        );
    }

    #[test]
    fn test_a_daemon_file_url_is_recognized_and_its_query_dropped() {
        assert_eq!(parse_daemon_file_url("kimi-file://f_abc"), Some("f_abc"));
        assert_eq!(
            parse_daemon_file_url("kimi-file://f_abc?path=/tmp/x.png"),
            Some("f_abc")
        );
        assert_eq!(parse_daemon_file_url("kimi-file://"), None);
        assert_eq!(parse_daemon_file_url("https://example.test/a.png"), None);
    }

    #[test]
    fn test_normalize_turns_a_daemon_url_into_a_reference() {
        let blocks = vec![
            ContentBlock::ImageUrl {
                url: "kimi-file://f_abc".into(),
                id: None,
                name: None,
            },
            ContentBlock::VideoUrl {
                url: "ms://provider-id".into(),
                id: Some("provider-id".into()),
                name: None,
            },
        ];

        let out = normalize_media_refs(blocks);

        assert_eq!(
            out[0],
            ContentBlock::MediaRef {
                file_id: "f_abc".into(),
                kind: MediaKind::Image,
            }
        );
        assert!(
            matches!(&out[1], ContentBlock::VideoUrl { url, .. } if url == "ms://provider-id"),
            "a provider reference is not a daemon file"
        );
    }
}
