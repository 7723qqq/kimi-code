use chrono::Local;

pub const TOWER_ROOT: &str = ".tower";
pub const COMMS_DIR: &str = ".tower/comms";
pub const INBOX_DIR: &str = ".tower/comms/inbox";
pub const FINDINGS_DIR: &str = ".tower/comms/findings";
pub const REVIEWS_DIR: &str = ".tower/comms/reviews";
pub const MISSIONS_DIR: &str = ".tower/comms/missions";
pub const LOG_DIR: &str = ".tower/comms/log";
pub const WORKTREES_DIR: &str = ".tower/worktrees";

pub const STATE_FILE: &str = ".tower/comms/state.json";
pub const ACTIVITY_LOG: &str = ".tower/comms/log/activity.log";
pub const MISSIONS_INDEX: &str = ".tower/comms/MISSIONS.md";

pub const TOWER_NAME: &str = "tower";
pub const BROADCAST_NAME: &str = "all";

pub fn date_stamp() -> String {
    Local::now().format("%Y%m%d").to_string()
}

pub fn date_dash() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

pub fn slugify(text: &str, max_length: usize) -> String {
    let lower = text.to_lowercase();
    let mut slug = String::new();
    let mut last_was_dash = false;

    for c in lower.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
            last_was_dash = false;
        } else if !last_was_dash && !slug.is_empty() {
            slug.push('-');
            last_was_dash = true;
        }
    }

    let trimmed = slug.trim_matches('-');
    let end_idx = trimmed
        .char_indices()
        .map(|(i, _)| i)
        .take(max_length)
        .last()
        .map_or(trimmed.len(), |i| {
            trimmed[i..]
                .chars()
                .next()
                .map_or(trimmed.len(), |c| i + c.len_utf8())
        });
    let sliced = &trimmed[..end_idx.min(trimmed.len())];
    let final_slug = sliced.trim_matches('-');
    if final_slug.is_empty() {
        "item".to_string()
    } else {
        final_slug.to_string()
    }
}

pub fn target_slug(target: &str) -> String {
    let cleaned = target.trim().strip_prefix('#').unwrap_or(target.trim());
    let replaced = cleaned.replace(['/', '#'], "-");
    slugify(&replaced, 60)
}

pub fn inbox_file_name(from: &str, to: &str, subject: &str) -> String {
    format!(
        "{}-{}-{}-{}.md",
        date_stamp(),
        slugify(from, 30),
        slugify(to, 30),
        slugify(subject, 60)
    )
}

pub fn finding_file_name(agent: &str, finding_type: &str, slug: &str) -> String {
    format!(
        "{}-{}-{}-{}.md",
        date_stamp(),
        slugify(agent, 30),
        slugify(finding_type, 12),
        slugify(slug, 60)
    )
}

pub fn mission_file_name(id: &str, slug: &str) -> String {
    format!("{}-{}.md", id.to_lowercase(), slugify(slug, 40))
}

pub fn review_file_name(target: &str, reviewer: &str, round: u32) -> String {
    format!(
        "review-{}-{}-round{}.md",
        target_slug(target),
        slugify(reviewer, 30),
        round
    )
}

pub fn resolve_tower_repo_root(cwd: &str) -> String {
    let normalized = cwd.replace('\\', "/");
    let marker = format!("/{WORKTREES_DIR}/");
    if let Some(pos) = normalized.find(&marker) {
        cwd[..pos].to_string()
    } else {
        cwd.to_string()
    }
}
