//! Request media budget (upstream #3784).
//!
//! A request whose images and videos exceed the budget is not failed: the
//! oldest media are omitted from it and the user is warned. Only media that
//! cost bytes on the wire count — an inline base64 payload does, a
//! provider-side reference does not — so a request carrying nothing but
//! references is never over budget.
//!
//! The entries are built by [`crate::llm::media_resolver`], which is the side
//! that knows which file a block came from: a daemon reference is keyed by its
//! file id, so the same file is one budget item however often it appears, and
//! an omission can name the path the model may re-read.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use crate::llm::media_resolver::{build_media_path_tag, unavailable_text};
use crate::rpc::types::{ContentBlock, MediaKind};
use crate::turn_loop::types::LLMMessage;

/// v2 `REQUEST_MEDIA_BUDGET_BYTES` (agent/media/mediaResolverService.ts:48):
/// above this the request is over budget.
pub const REQUEST_MEDIA_BUDGET_BYTES: usize = 20 * 1024 * 1024;
/// v2 `REQUEST_MEDIA_BUDGET_LOW_BYTES` (mediaResolverService.ts:49): omission
/// stops once the request is back under this, so one over-budget request does
/// not evict every media it carries.
pub const REQUEST_MEDIA_BUDGET_LOW_BYTES: usize = 10 * 1024 * 1024;

/// The `WarningEvent.code` an omission is reported under (v2
/// `media-budget-exceeded`, mediaResolverService.ts:210).
pub const MEDIA_BUDGET_EXCEEDED_CODE: &str = "media-budget-exceeded";

/// One media item that costs request bytes, in message order.
pub struct Entry {
    pub message_index: usize,
    pub block_index: usize,
    /// The budget identity: a daemon file id, or `inline\0<sha256>` for a
    /// payload with no file behind it.
    pub key: String,
    /// The daemon file the entry came from, when it came from one.
    pub file_id: Option<String>,
    /// The saved path, for the tag an omission leaves behind.
    pub path: Option<String>,
    pub kind: MediaKind,
    pub bytes: usize,
}

/// The media keys an earlier request already omitted, shared with the caller
/// so the record outlives one turn (v2 keeps the same set in agent state).
pub type DroppedMedia = std::sync::Arc<std::sync::Mutex<HashSet<String>>>;

/// The media keys an earlier request already omitted.
///
/// v2 keeps this in agent state, so a media item stays omitted even after the
/// conversation shrinks back under the budget. The engine's turn loop is
/// stateless across turns, so the caller hands in a shared record and the
/// budget writes every new omission through to it.
#[derive(Default)]
pub struct MediaBudget {
    dropped: HashSet<String>,
    shared: Option<DroppedMedia>,
}

impl MediaBudget {
    /// A budget that already knows what earlier turns omitted.
    pub fn new(dropped: HashSet<String>) -> Self {
        Self {
            dropped,
            shared: None,
        }
    }

    /// A budget backed by the caller's cross-turn record.
    pub fn shared(shared: DroppedMedia) -> Self {
        let dropped = shared.lock().unwrap_or_else(|e| e.into_inner()).clone();
        Self {
            dropped,
            shared: Some(shared),
        }
    }

    /// The keys omitted so far, for the caller to persist.
    pub fn dropped(&self) -> &HashSet<String> {
        &self.dropped
    }

    /// Apply the budget to a request-scoped view of `messages`.
    ///
    /// The history itself is never rewritten: the caller keeps every block,
    /// so a later request can still see media this one had to omit. Returns
    /// the warning to surface, when this request omitted something new.
    pub fn apply<'a>(
        &mut self,
        messages: &mut Cow<'a, [LLMMessage]>,
        entries: &[Entry],
    ) -> Option<String> {
        if entries.is_empty() {
            return None;
        }
        // Per-key totals in first-appearance order: media repeated across
        // messages cost their bytes once per occurrence and are omitted
        // everywhere.
        let mut pending: Vec<(&str, usize)> = Vec::new();
        let mut seen: HashMap<&str, usize> = HashMap::new();
        for entry in entries {
            if self.dropped.contains(&entry.key) {
                replace_with_media_tag(messages.to_mut(), entry);
                continue;
            }
            match seen.get(entry.key.as_str()) {
                Some(&at) => pending[at].1 += entry.bytes,
                None => {
                    seen.insert(entry.key.as_str(), pending.len());
                    pending.push((entry.key.as_str(), entry.bytes));
                }
            }
        }
        let mut total: usize = pending.iter().map(|(_, bytes)| bytes).sum();
        if total <= REQUEST_MEDIA_BUDGET_BYTES {
            return None;
        }
        let mut dropped_now: HashSet<&str> = HashSet::new();
        for (key, bytes) in &pending {
            if total <= REQUEST_MEDIA_BUDGET_LOW_BYTES {
                break;
            }
            // A reference costs nothing on the wire, so omitting it would
            // free no budget.
            if *bytes == 0 {
                continue;
            }
            dropped_now.insert(key);
            total -= bytes;
        }
        for entry in entries {
            if dropped_now.contains(entry.key.as_str()) {
                replace_with_media_tag(messages.to_mut(), entry);
            }
        }
        self.dropped
            .extend(dropped_now.iter().map(|key| (*key).to_string()));
        if let Some(shared) = &self.shared {
            shared
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .extend(dropped_now.iter().map(|key| (*key).to_string()));
        }
        // v2 only promises the saved paths when every omitted item has one:
        // an inline payload has no file behind it to re-read.
        let has_untracked_inline = entries
            .iter()
            .any(|entry| dropped_now.contains(entry.key.as_str()) && entry.file_id.is_none());
        Some(format!(
            "Conversation media exceeded the {} MB per-request budget; {} older media item(s) were omitted{}",
            REQUEST_MEDIA_BUDGET_BYTES / (1024 * 1024),
            dropped_now.len(),
            if has_untracked_inline {
                "."
            } else {
                " and remain available at their saved paths."
            }
        ))
    }
}

/// What one omitted media item leaves behind (v2 `replaceWithMediaTag`): the
/// saved path when the file is known, the unavailable placeholder when it is
/// known but gone, and the plain budget placeholder when there is no file.
pub(crate) fn replace_with_media_tag(messages: &mut [LLMMessage], entry: &Entry) {
    let Some(block) = messages
        .get_mut(entry.message_index)
        .and_then(|message| message.blocks.get_mut(entry.block_index))
    else {
        return;
    };
    *block = ContentBlock::Text {
        text: match (&entry.file_id, &entry.path) {
            (Some(_), Some(path)) => build_media_path_tag(entry.kind, path),
            (Some(_), None) => unavailable_text(entry.kind).to_string(),
            _ => budget_omitted_media(entry.kind),
        },
    };
}

/// v2 `budgetOmittedMedia`.
pub fn budget_omitted_media(kind: MediaKind) -> String {
    format!(
        "[{} omitted: dropped to fit the request media budget]",
        kind.as_str()
    )
}

/// v2 `MEDIA_DEGRADE_KEEP_RECENT`: a degraded request keeps this many of the
/// newest media parts and replaces the rest.
pub const MEDIA_DEGRADE_KEEP_RECENT: usize = 2;

/// The `WarningEvent.code` a degraded retry reports under (v2's
/// `media-degraded` projection).
pub const MEDIA_DEGRADED_CODE: &str = "media-degraded";

/// The `WarningEvent.code` a stripped retry reports under (v2's
/// `media-stripped` projection).
pub const MEDIA_STRIPPED_CODE: &str = "media-stripped";

/// v2 `APIRequestTooLargeError`: the provider rejected the request as too
/// large — the 413 status, or the rendered text the gateways use. The
/// status alone decides when it is present: a 413 is a 413 whatever the
/// body says, and a body that only says "too large" without the status is
/// not the signal (v2 classifies the coded error, not the prose).
pub fn is_request_too_large(error: &str) -> bool {
    crate::llm::http::llm_http_status(error) == Some(413)
}

/// v2 `isImageFormatError` (`llm-adapter/contract/errors.ts:215`): the
/// provider rejected an image in the request — a 400 whose message names an
/// image format problem, or a media/mime-type field complaint that also
/// names an image. The overflow and too-large classes are excluded: they
/// have their own recoveries, and v2 checks them first.
pub fn is_image_format_error(error: &str) -> bool {
    if crate::llm::http::llm_http_status(error) != Some(400) {
        return false;
    }
    let lower = error.to_lowercase();
    const PATTERNS: [&str; 19] = [
        "unsupported image url",
        "unsupported image format",
        "unsupported image type",
        "does not represent a valid image",
        "could not process image",
        "could not process the image",
        "could not process input image",
        "could not decode image",
        "could not decode the image",
        "could not decode input image",
        "unable to process image",
        "unable to process the image",
        "unable to process input image",
        "failed to decode image",
        "failed to decode the image",
        "invalid image",
        "invalid image data",
        "invalid image type",
        "invalid image format",
    ];
    if PATTERNS.iter().any(|pattern| lower.contains(pattern)) {
        return true;
    }
    // v2's `MEDIA_TYPE_FIELD_PATTERN` (`(?:media|mime)_?type`) plus an
    // explicit mention of an image.
    let names_media_type = lower.contains("media_type")
        || lower.contains("mediatype")
        || lower.contains("mime_type")
        || lower.contains("mimetype");
    names_media_type && lower.contains("image")
}

/// v2 `degradeOlderMediaParts`: replace all but the `keep_recent` newest
/// media parts with what an omission leaves behind — the saved path when
/// the file is known, the unavailable placeholder when it is gone, the
/// plain budget placeholder when there is no file. The entries arrive in
/// message order, so the oldest `len - keep_recent` go and the newest
/// `keep_recent` stay. Returns how many parts were replaced; zero means
/// there was nothing to degrade.
pub fn degrade_older_media(
    messages: &mut [LLMMessage],
    entries: &[Entry],
    keep_recent: usize,
) -> usize {
    let to_degrade = entries.len().saturating_sub(keep_recent);
    for entry in entries.iter().take(to_degrade) {
        replace_with_media_tag(messages, entry);
    }
    to_degrade
}

/// v2 `stripMediaPartsBySnapshot` without the snapshot: every media part
/// becomes what an omission leaves behind. Returns how many were replaced.
pub fn strip_all_media(messages: &mut [LLMMessage], entries: &[Entry]) -> usize {
    let mut replaced = 0;
    for entry in entries {
        replace_with_media_tag(messages, entry);
        replaced += 1;
    }
    replaced
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media_message(block: ContentBlock) -> LLMMessage {
        LLMMessage {
            role: "user".into(),
            content: String::new(),
            blocks: vec![block],
            tool_calls: Vec::new(),
            tool_call_id: None,

            prompt_id: None,
            origin: None,
        }
    }

    fn inline_entry(index: usize, tag: &str, bytes: usize) -> Entry {
        Entry {
            message_index: index,
            block_index: 0,
            key: format!("inline\0{tag}"),
            file_id: None,
            path: None,
            kind: MediaKind::Image,
            bytes,
        }
    }

    fn ref_entry(index: usize, file_id: &str, bytes: usize) -> Entry {
        Entry {
            message_index: index,
            block_index: 0,
            key: file_id.to_string(),
            file_id: Some(file_id.to_string()),
            path: Some(format!("/blobs/files/{file_id}")),
            kind: MediaKind::Image,
            bytes,
        }
    }

    fn omitted_text(message: &LLMMessage) -> Option<&str> {
        match message.blocks.first() {
            Some(ContentBlock::Text { text }) => Some(text.as_str()),
            _ => None,
        }
    }

    /// The budget works on a request-scoped `Cow`; the tests read the result
    /// back out of the same `Vec`.
    fn apply(
        budget: &mut MediaBudget,
        messages: &mut Vec<LLMMessage>,
        entries: &[Entry],
    ) -> Option<String> {
        let mut request = Cow::Owned(std::mem::take(messages));
        let warning = budget.apply(&mut request, entries);
        *messages = request.into_owned();
        warning
    }

    fn inline_image(tag: &str) -> ContentBlock {
        ContentBlock::Image {
            media_type: "image/png".into(),
            data: tag.to_string(),
            name: None,
        }
    }

    /// v2 `degradeOlderMediaParts` / `stripMediaPartsBySnapshot` (the
    /// provider-too-large recovery, ROADMAP #17 ②): the degrade keeps the
    /// two newest media and replaces the rest with their path tags; the
    /// strip replaces every one. Both run on the unresolved messages, where
    /// a reference still names its file.
    #[test]
    fn a_too_large_request_degrades_then_strips_its_media() {
        assert!(is_request_too_large(
            "llm http status 413: request too large"
        ));
        assert!(!is_request_too_large("llm http status 500: boom"));
        assert!(!is_request_too_large("context length exceeded"));

        // v2 `isImageFormatError`: a 400 naming an image format problem, or
        // a media/mime-type complaint that also names an image. The
        // overflow and too-large classes are excluded. (`invalid data url
        // for image` lives only in v2's provider-message branch, not the
        // status branch this port implements.)
        assert!(is_image_format_error(
            "llm http status 400: unsupported image format image/heic"
        ));
        assert!(is_image_format_error(
            "llm http status 400: does not represent a valid image"
        ));
        assert!(is_image_format_error(
            "llm http status 400: media_type image/svg+xml is not supported"
        ));
        assert!(!is_image_format_error(
            "llm http status 400: media_type video/mp4 is not supported"
        ));
        assert!(!is_image_format_error(
            "llm http status 413: unsupported image format"
        ));
        assert!(!is_image_format_error("llm http status 500: boom"));

        let mut messages = vec![
            media_message(inline_image("a")),
            media_message(inline_image("b")),
            media_message(inline_image("c")),
            media_message(inline_image("d")),
        ];
        let entries = vec![
            inline_entry(0, "a", 1024),
            inline_entry(1, "b", 1024),
            inline_entry(2, "c", 1024),
            inline_entry(3, "d", 1024),
        ];

        // Degrade keeps the two newest.
        let degraded = degrade_older_media(&mut messages, &entries, MEDIA_DEGRADE_KEEP_RECENT);
        assert_eq!(degraded, 2);
        assert!(omitted_text(&messages[0]).is_some());
        assert!(omitted_text(&messages[1]).is_some());
        assert!(omitted_text(&messages[2]).is_none());
        assert!(omitted_text(&messages[3]).is_none());

        // Strip takes the rest.
        let stripped = strip_all_media(&mut messages, &entries);
        assert_eq!(stripped, 4);
        assert!(messages.iter().all(|m| omitted_text(m).is_some()));

        // Nothing to degrade is zero, not a silent no-op.
        let mut small = vec![media_message(inline_image("only"))];
        assert_eq!(
            degrade_older_media(
                &mut small,
                &[inline_entry(0, "only", 1024)],
                MEDIA_DEGRADE_KEEP_RECENT
            ),
            0
        );
    }

    /// A degraded reference leaves its saved path, the way the budget
    /// omission does — the model can re-read what was dropped.
    #[test]
    fn a_degraded_reference_leaves_its_saved_path() {
        let mut messages = vec![
            media_message(ContentBlock::MediaRef {
                file_id: "f_old".into(),
                kind: MediaKind::Image,
            }),
            media_message(ContentBlock::MediaRef {
                file_id: "f_new".into(),
                kind: MediaKind::Image,
            }),
            media_message(ContentBlock::MediaRef {
                file_id: "f_newer".into(),
                kind: MediaKind::Image,
            }),
        ];
        let entries = vec![
            ref_entry(0, "f_old", 1024),
            ref_entry(1, "f_new", 1024),
            ref_entry(2, "f_newer", 1024),
        ];

        let degraded = degrade_older_media(&mut messages, &entries, MEDIA_DEGRADE_KEEP_RECENT);

        assert_eq!(degraded, 1);
        assert_eq!(
            omitted_text(&messages[0]),
            Some("<image path=\"/blobs/files/f_old\"></image>")
        );
        assert!(omitted_text(&messages[1]).is_none());
        assert!(omitted_text(&messages[2]).is_none());
    }

    #[test]
    fn test_under_budget_passes_every_media_through() {
        let mut messages = vec![
            media_message(inline_image("a")),
            media_message(inline_image("b")),
        ];
        let entries = vec![inline_entry(0, "a", 1024), inline_entry(1, "b", 2048)];
        let mut budget = MediaBudget::default();

        let warning = apply(&mut budget, &mut messages, &entries);

        assert_eq!(warning, None);
        assert!(omitted_text(&messages[0]).is_none());
        assert!(omitted_text(&messages[1]).is_none());
    }

    #[test]
    fn test_over_budget_omits_the_oldest_media_first() {
        // Three 8 MB payloads: 24 MB is over the 20 MB budget, and dropping
        // the two oldest brings the request to 8 MB — under the 10 MB mark.
        let mut messages = vec![
            media_message(inline_image("a")),
            media_message(inline_image("b")),
            media_message(inline_image("c")),
        ];
        let entries = vec![
            inline_entry(0, "a", 8 * 1024 * 1024),
            inline_entry(1, "b", 8 * 1024 * 1024),
            inline_entry(2, "c", 8 * 1024 * 1024),
        ];
        let mut budget = MediaBudget::default();

        apply(&mut budget, &mut messages, &entries);

        assert_eq!(
            omitted_text(&messages[0]),
            Some("[image omitted: dropped to fit the request media budget]")
        );
        assert_eq!(
            omitted_text(&messages[1]),
            Some("[image omitted: dropped to fit the request media budget]")
        );
        assert!(
            omitted_text(&messages[2]).is_none(),
            "the newest media must survive: {:?}",
            messages[2].blocks
        );
    }

    #[test]
    fn test_an_omitted_reference_leaves_its_saved_path() {
        let mut messages = vec![
            media_message(inline_image("a")),
            media_message(inline_image("b")),
        ];
        let entries = vec![
            ref_entry(0, "f_old", 12 * 1024 * 1024),
            ref_entry(1, "f_new", 9 * 1024 * 1024),
        ];
        let mut budget = MediaBudget::default();

        let warning = apply(&mut budget, &mut messages, &entries);

        assert_eq!(
            omitted_text(&messages[0]),
            Some("<image path=\"/blobs/files/f_old\"></image>")
        );
        assert!(omitted_text(&messages[1]).is_none());
        assert_eq!(
            warning.as_deref(),
            Some(
                "Conversation media exceeded the 20 MB per-request budget; \
                 1 older media item(s) were omitted and remain available at their saved paths."
            )
        );
    }

    #[test]
    fn test_an_omitted_inline_payload_gets_the_plain_placeholder() {
        let mut messages = vec![
            media_message(inline_image("a")),
            media_message(inline_image("b")),
        ];
        let entries = vec![
            inline_entry(0, "a", 12 * 1024 * 1024),
            inline_entry(1, "b", 9 * 1024 * 1024),
        ];
        let mut budget = MediaBudget::default();

        let warning = apply(&mut budget, &mut messages, &entries);

        assert_eq!(
            omitted_text(&messages[0]),
            Some("[image omitted: dropped to fit the request media budget]")
        );
        assert_eq!(
            warning.as_deref(),
            Some(
                "Conversation media exceeded the 20 MB per-request budget; \
                 1 older media item(s) were omitted."
            )
        );
    }

    #[test]
    fn test_omission_stops_at_the_low_mark() {
        // 21 MB is over the budget, but dropping the single oldest 12 MB
        // payload already lands under the 10 MB mark — the second media is
        // kept even though the request would still be over budget without it.
        let mut messages = vec![
            media_message(inline_image("a")),
            media_message(inline_image("b")),
        ];
        let entries = vec![
            inline_entry(0, "a", 12 * 1024 * 1024),
            inline_entry(1, "b", 9 * 1024 * 1024),
        ];
        let mut budget = MediaBudget::default();

        apply(&mut budget, &mut messages, &entries);

        assert!(omitted_text(&messages[0]).is_some());
        assert!(omitted_text(&messages[1]).is_none());
    }

    #[test]
    fn test_omitted_media_stay_omitted_on_the_next_request() {
        let mut messages = vec![
            media_message(inline_image("a")),
            media_message(inline_image("b")),
            media_message(inline_image("c")),
        ];
        let entries = vec![
            inline_entry(0, "a", 8 * 1024 * 1024),
            inline_entry(1, "b", 8 * 1024 * 1024),
            inline_entry(2, "c", 8 * 1024 * 1024),
        ];
        let mut budget = MediaBudget::default();
        assert!(apply(&mut budget, &mut messages, &entries).is_some());

        // The same history, now under the budget once the omissions are
        // counted: the earlier decision must not be undone.
        let mut again = vec![
            media_message(inline_image("a")),
            media_message(inline_image("b")),
            media_message(inline_image("c")),
        ];
        let warning = apply(&mut budget, &mut again, &entries);

        assert!(omitted_text(&again[0]).is_some());
        assert!(omitted_text(&again[1]).is_some());
        assert!(omitted_text(&again[2]).is_none());
        assert_eq!(warning, None, "nothing new was omitted");
    }

    #[test]
    fn test_a_seeded_budget_keeps_an_earlier_turns_omission() {
        let mut messages = vec![
            media_message(inline_image("a")),
            media_message(inline_image("b")),
        ];
        let entries = vec![inline_entry(0, "a", 1024), inline_entry(1, "b", 1024)];
        let mut budget = MediaBudget::new(HashSet::from(["inline\0a".to_string()]));

        let warning = apply(&mut budget, &mut messages, &entries);

        assert!(omitted_text(&messages[0]).is_some());
        assert!(omitted_text(&messages[1]).is_none());
        assert_eq!(warning, None, "the omission was decided by an earlier turn");
    }

    #[test]
    fn test_repeated_media_are_counted_per_occurrence_and_omitted_everywhere() {
        // The same 11 MB image twice costs 22 MB of request, so the request is
        // over budget; one key is dropped and both of its occurrences go with
        // it (v2 counts every occurrence's bytes but drops by key).
        let mut messages = vec![
            media_message(inline_image("a")),
            media_message(inline_image("a")),
        ];
        let entries = vec![
            inline_entry(0, "a", 11 * 1024 * 1024),
            inline_entry(1, "a", 11 * 1024 * 1024),
        ];
        let mut budget = MediaBudget::default();

        let warning = apply(&mut budget, &mut messages, &entries);

        assert!(omitted_text(&messages[0]).is_some());
        assert!(omitted_text(&messages[1]).is_some());
        assert_eq!(
            warning.as_deref(),
            Some(
                "Conversation media exceeded the 20 MB per-request budget; \
                 1 older media item(s) were omitted."
            )
        );
    }

    #[test]
    fn test_a_zero_byte_reference_is_never_omitted() {
        // A provider-side reference costs nothing, so dropping it would free
        // no budget — the loop must skip it and keep going.
        let mut messages = vec![
            media_message(inline_image("ref")),
            media_message(inline_image("a")),
            media_message(inline_image("b")),
        ];
        let entries = vec![
            ref_entry(0, "f_uploaded", 0),
            inline_entry(1, "a", 12 * 1024 * 1024),
            inline_entry(2, "b", 9 * 1024 * 1024),
        ];
        let mut budget = MediaBudget::default();

        apply(&mut budget, &mut messages, &entries);

        assert!(
            omitted_text(&messages[0]).is_none(),
            "a zero-byte reference must survive"
        );
        assert!(omitted_text(&messages[1]).is_some());
    }
}
