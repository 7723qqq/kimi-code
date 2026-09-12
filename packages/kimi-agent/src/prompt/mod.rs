//! System prompt and profile catalog generation for Kimi Agent.
//!
//! Provides native prompt templating, dynamic environment disclosure (OS/Shell/cwd tree),
//! AGENTS.md cascading and byte budget control, skills catalog markdown rendering,
//! and standard role profile definitions (agent, coder, explore, plan).

pub mod agents_md;
pub mod builder;
pub mod environment;
pub mod init;
pub mod profiles;
pub mod skills_renderer;

pub use builder::SystemPromptBuilder;
pub use environment::collect_environment;
pub use init::{DEFAULT_INIT_PROMPT, init_completion_reminder};
pub use profiles::{AgentProfile, ProfileCatalog};
