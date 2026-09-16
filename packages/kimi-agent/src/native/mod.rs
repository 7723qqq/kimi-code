#![cfg_attr(
    not(feature = "napi"),
    allow(dead_code, unused_imports, unused_variables)
)]

mod bash;
mod bash_spawn;
mod compaction;
mod edit;
mod encoding;
mod escape;
mod fetch_url;
mod file_cache;
pub mod file_type;
mod glob;
pub mod goal;
mod grep;
pub mod image_compress;
mod line_endings;
pub mod list_directory;
mod llm_stream;
#[cfg(feature = "napi")]
mod napi_bindings;
mod output_truncate;
pub(crate) mod path_access;
mod permission;
mod read;
pub mod shell;
pub(crate) mod shell_path_bridge;
mod tokens;
mod tool_access;
pub(crate) mod tool_naming;
mod translation;
/// Synchronous DuckDuckGo search. Shared by the `native_search` binding and by
/// the workflow runtime's `search()` primitive (which takes a sync provider).
pub mod web_search;
mod workspace_index;
mod write;

pub mod event_store;
pub mod lsp;
pub mod permission_engine;

pub use list_directory::{ListDirectoryConfig, ListDirectoryResult, list_directory};

/// Shared with the engine's own HTTP transport (`llm::http`) so the two paths
/// cannot disagree about what an in-band provider error frame looks like, what a
/// non-SSE body means, or how a captured frame is truncated for a message.
pub(crate) use llm_stream::{
    NOT_AN_SSE_ENDPOINT_PREFIX, empty_stream_error, extract_in_band_error, truncate_for_diagnosis,
};

pub fn native_list_directory(
    path: Option<String>,
    collapse_hidden_dirs: Option<bool>,
) -> ListDirectoryResult {
    list_directory::list_directory(&ListDirectoryConfig {
        path,
        collapse_hidden_dirs: collapse_hidden_dirs.unwrap_or(false),
    })
}

#[cfg(feature = "napi")]
pub use napi_bindings::*;
