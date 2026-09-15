//! Anti-herd jitter for cron fire times, ported from the retired v2
//! `features/cron/internal/jitter.ts`.
//!
//! Without jitter every client whose clock agrees fires `0 9 * * *` at the
//! same millisecond and hammers the provider together. The offset is
//! deterministic per task id (djb2 hash, with an 8-hex fast path), so a given
//! task always fires at the same shifted instant — no coordination needed.
//!
//! The tool description (`CronCreate`) promises this behavior; before this
//! module the engine fired at the ideal time and `nextFireAt` was hardcoded
//! null on the local path.

use crate::cron::{ParsedCron, next_fire};

/// v2 `DEFAULT_CRON_JITTER_CONFIG`.
pub const RECURRING_MAX_FRACTION_OF_PERIOD: f64 = 0.1;
/// v2 `recurringMaxMs`: 15 minutes.
pub const RECURRING_MAX_MS: i64 = 15 * 60_000;
/// v2 `oneShotMaxMs`: 90 seconds.
pub const ONE_SHOT_MAX_MS: i64 = 90_000;

const MS_PER_DAY: i64 = 24 * 60 * 60_000;
const MS_PER_MINUTE: i64 = 60_000;
/// v2 `STALE_THRESHOLD_MS`: a recurring task older than this is stale.
pub const STALE_THRESHOLD_MS: i64 = 7 * 24 * 60 * 60_000;
/// v2 `MAX_COALESCE_ITERATIONS`: caps the catch-up walk.
pub const MAX_COALESCE_ITERATIONS: u32 = 10_000;

/// Deterministic [0, 1) fraction from a task id (v2 `fractionFromId`): an
/// 8-hex id parses directly, anything else falls back to djb2.
pub fn fraction_from_id(id: &str) -> f64 {
    if id.len() == 8
        && id.chars().all(|c| c.is_ascii_hexdigit())
        && let Ok(n) = u32::from_str_radix(id, 16)
    {
        #[allow(clippy::cast_precision_loss)]
        return f64::from(n) / 4_294_967_296.0;
    }
    let mut hash: i32 = 5381;
    for byte in id.bytes() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_add(hash)
            .wrapping_add(byte as i32);
    }
    #[allow(clippy::cast_precision_loss, clippy::cast_sign_loss)]
    {
        (hash as u32 as f64) / 4_294_967_296.0
    }
}

/// Jittered next fire for a recurring task (v2 `jitteredNextCronRunMs`):
/// the ideal fire shifted forward by at most min(10% of the period, 15 min).
/// `no_jitter` is the v2 opt-out; the engine has no `[cron]` config surface,
/// so callers pass false (the tool description promises jitter).
pub fn jittered_next_run_ms(
    task_id: &str,
    parsed: &ParsedCron,
    ideal_ms: i64,
    tz_offset_minutes: i32,
    no_jitter: bool,
) -> i64 {
    if no_jitter {
        return ideal_ms;
    }
    let period = match next_fire(parsed, ideal_ms, tz_offset_minutes) {
        Some(next) if next > ideal_ms => next - ideal_ms,
        _ => MS_PER_DAY,
    };
    #[allow(clippy::cast_precision_loss)]
    let period_cap = period as f64 * RECURRING_MAX_FRACTION_OF_PERIOD;
    let cap = period_cap.min(RECURRING_MAX_MS as f64) as i64;
    if cap <= 0 {
        return ideal_ms;
    }
    #[allow(clippy::cast_possible_truncation)]
    let offset = (cap as f64 * fraction_from_id(task_id)) as i64;
    ideal_ms + offset
}

/// Jittered fire for a one-shot task (v2 `oneShotJitteredNextCronRunMs`):
/// shifted *backward* by at most 90 s, but only when the ideal fire lands
/// exactly on :00 or :30 in the runtime zone — and never before the task was
/// created.
pub fn one_shot_jittered_run_ms(
    task_id: &str,
    created_at_ms: Option<i64>,
    ideal_ms: i64,
    tz_offset_minutes: i32,
    no_jitter: bool,
) -> i64 {
    if no_jitter {
        return ideal_ms;
    }
    if ideal_ms % MS_PER_MINUTE != 0 {
        return ideal_ms;
    }
    let minute_of_hour =
        ((ideal_ms + i64::from(tz_offset_minutes) * MS_PER_MINUTE) / MS_PER_MINUTE % 60 + 60) % 60;
    if minute_of_hour != 0 && minute_of_hour != 30 {
        return ideal_ms;
    }
    #[allow(clippy::cast_possible_truncation)]
    let offset = -(ONE_SHOT_MAX_MS as f64 * fraction_from_id(task_id)) as i64;
    let shifted = ideal_ms + offset;
    if let Some(created) = created_at_ms
        && shifted < created
    {
        return ideal_ms;
    }
    shifted
}

/// Whether a recurring task is stale at `now_ms` (v2 `isStaleAt`): older
/// than 7 days. One-shots are never stale (they are removed after firing).
pub fn is_stale_at(created_at_ms: Option<i64>, now_ms: i64, no_stale: bool) -> bool {
    if no_stale {
        return false;
    }
    match created_at_ms {
        Some(created) => now_ms.saturating_sub(created) >= STALE_THRESHOLD_MS,
        // No creation timestamp: cannot prove staleness, keep the task.
        None => false,
    }
}

/// Count how many ideal fires (with jitter applied) have passed by `now_ms`,
/// starting from `first_fire_ms` (v2 `countCoalesced`). Returns
/// `(count, last_due_ms)` with count >= 1.
pub fn count_coalesced(
    task_id: &str,
    recurring: bool,
    created_at_ms: Option<i64>,
    parsed: &ParsedCron,
    first_fire_ms: i64,
    now_ms: i64,
    tz_offset_minutes: i32,
) -> (u32, i64) {
    let mut count: u32 = 1;
    let mut cursor = first_fire_ms;
    let mut last_due_ms = first_fire_ms;
    while count < MAX_COALESCE_ITERATIONS {
        let Some(next) = next_fire(parsed, cursor, tz_offset_minutes) else {
            break;
        };
        if next > now_ms {
            break;
        }
        let jittered = if recurring {
            jittered_next_run_ms(task_id, parsed, next, tz_offset_minutes, false)
        } else {
            one_shot_jittered_run_ms(task_id, created_at_ms, next, tz_offset_minutes, false)
        };
        if jittered > now_ms {
            break;
        }
        count += 1;
        cursor = next;
        last_due_ms = next;
    }
    (count, last_due_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cron::parse;

    #[test]
    fn fraction_from_id_matches_v2_vectors() {
        // 8-hex fast path: 0x00000000 -> 0, 0x80000000 -> 0.5, 0xffffffff -> ~1.
        assert_eq!(fraction_from_id("00000000"), 0.0);
        assert_eq!(fraction_from_id("80000000"), 0.5);
        assert!(fraction_from_id("ffffffff") > 0.99);
        // djb2("a") = 177670 -> 177670 / 2^32.
        let djb2_a = 177670f64 / 4_294_967_296.0;
        assert!((fraction_from_id("a") - djb2_a).abs() < 1e-12);
        // Deterministic across calls.
        assert_eq!(
            fraction_from_id("some-task-id"),
            fraction_from_id("some-task-id")
        );
        // Always in [0, 1).
        for id in ["", "x", "M1", "01ABCDEFGHJKMNPQRSTVWXYZ", "zzz-999"] {
            let f = fraction_from_id(id);
            assert!((0.0..1.0).contains(&f), "{id} -> {f}");
        }
    }

    fn hourly() -> ParsedCron {
        parse("0 * * * *").unwrap()
    }

    #[test]
    fn recurring_jitter_shifts_forward_within_cap() {
        // Hourly period: cap = min(10% of 1h, 15min) = 6 min.
        let parsed = hourly();
        let ideal = 1_717_200_000_000; // a Saturday 00:00Z; minute 0
        let jittered = jittered_next_run_ms("task-1", &parsed, ideal, 0, false);
        assert!(jittered >= ideal, "recurring jitter never shifts backward");
        assert!(
            jittered < ideal + 6 * 60_000,
            "bounded by 10% of the hourly period: {jittered} vs {ideal}"
        );
        // Deterministic per id, distinct across ids (with overwhelming odds).
        assert_eq!(
            jittered_next_run_ms("task-1", &parsed, ideal, 0, false),
            jittered
        );
        // Opt-out returns the ideal untouched.
        assert_eq!(
            jittered_next_run_ms("task-1", &parsed, ideal, 0, true),
            ideal
        );
    }

    #[test]
    fn one_shot_jitter_only_on_hour_and_half_hour() {
        // Ideal at :00 shifts backward by at most 90 s.
        let midnight = 1_717_200_000_000;
        let shifted = one_shot_jittered_run_ms("task-1", None, midnight, 0, false);
        assert!(shifted <= midnight, "one-shot jitter never shifts forward");
        assert!(shifted > midnight - 90_000, "bounded by 90 s");
        // The :00/:30 gate is evaluated in the runtime zone: UTC :00 is
        // :30 in +5:30, still a shifting boundary; UTC :15 is :45 there.
        assert_eq!(
            one_shot_jittered_run_ms("task-1", None, midnight, 330, false),
            one_shot_jittered_run_ms("task-1", None, midnight, 0, false),
            "whole- and half-hour zones agree on :00/:30 boundaries"
        );
        // Ideal at :15 is untouched.
        let quarter_past = midnight + 15 * 60_000;
        assert_eq!(
            one_shot_jittered_run_ms("task-1", None, quarter_past, 0, false),
            quarter_past
        );
        // Never shifted before creation.
        assert_eq!(
            one_shot_jittered_run_ms("task-1", Some(midnight), midnight, 0, false),
            midnight
        );
        // Opt-out returns the ideal untouched.
        assert_eq!(
            one_shot_jittered_run_ms("task-1", None, midnight, 0, true),
            midnight
        );
    }

    #[test]
    fn stale_threshold_is_seven_days() {
        let now = 1_717_200_000_000;
        assert!(!is_stale_at(Some(now - 6 * 24 * 60 * 60_000), now, false));
        assert!(is_stale_at(Some(now - 8 * 24 * 60 * 60_000), now, false));
        assert!(!is_stale_at(Some(now - 8 * 24 * 60 * 60_000), now, true));
        assert!(!is_stale_at(None, now, false));
    }

    #[test]
    fn coalesce_counts_missed_fires() {
        // Every 5 minutes; from T0, now is 12 minutes later: ideals at +5 and
        // +10 have passed (jitter only shifts forward by <=30 s here, so both
        // jittered fires are also past).
        let parsed = parse("*/5 * * * *").unwrap();
        let first = 1_717_200_000_000 + 5 * 60_000;
        let (count, _) =
            count_coalesced("task-1", true, None, &parsed, first, first + 7 * 60_000, 0);
        assert_eq!(count, 2, "two ideal fires passed");
        let (single, _) = count_coalesced("task-1", true, None, &parsed, first, first + 60_000, 0);
        assert_eq!(single, 1, "nothing else passed yet");
    }
}
