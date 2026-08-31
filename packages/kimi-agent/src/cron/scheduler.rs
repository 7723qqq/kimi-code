//! Local cron scheduler for the standalone REPL (P32 批 2).
//!
//! [`CronScheduler`] owns a list of cron entries and runs a tokio background
//! task that sleeps until the earliest next fire, then hands every due entry
//! to an `on_fire` callback. Recurring entries stay armed for their next
//! fire; one-shot entries are removed after firing. Timezone handling
//! matches [`crate::cron`]: an explicit `tz_offset_minutes` (minutes east of
//! UTC), std-only.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::cron::{ParsedCron, next_fire, parse};

/// A cron job entry, mirroring the wire shape stored in `cron.json`
/// (`id` / `cron` / `prompt` / `recurring`). Extra stored fields
/// (`createdAt` / `nextFireAt` / `stale`) are ignored on deserialization.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct CronEntry {
    pub id: String,
    pub cron: String,
    pub prompt: String,
    #[serde(default = "default_recurring")]
    pub recurring: bool,
}

fn default_recurring() -> bool {
    true
}

/// A parsed entry: the public entry plus its pre-parsed expression.
#[derive(Debug, Clone)]
struct ScheduledEntry {
    entry: CronEntry,
    parsed: ParsedCron,
}

/// Local cron scheduler: holds the entry list and fires due entries from a
/// tokio background task.
#[derive(Debug)]
pub struct CronScheduler {
    entries: Vec<ScheduledEntry>,
    tz_offset_minutes: i32,
}

impl CronScheduler {
    /// Build a scheduler from entries. Entries whose cron expression fails
    /// to parse are dropped; the v2 create path validates before storing, so
    /// this is defensive only.
    pub fn new(entries: Vec<CronEntry>, tz_offset_minutes: i32) -> Self {
        let entries = entries
            .into_iter()
            .filter_map(|entry| {
                parse(&entry.cron)
                    .ok()
                    .map(|parsed| ScheduledEntry { entry, parsed })
            })
            .collect();
        Self {
            entries,
            tz_offset_minutes,
        }
    }

    /// The earliest next fire (epoch ms) across all entries, strictly after
    /// `from_ms`, or `None` when no entry will ever fire again.
    pub fn next_fire_at(&self, from_ms: i64) -> Option<i64> {
        self.entries
            .iter()
            .filter_map(|s| next_fire(&s.parsed, from_ms, self.tz_offset_minutes))
            .min()
    }

    /// Fire every entry whose next fire falls in `(from_ms, now_ms]`, in
    /// fire-time order, and return the fired entries. Recurring entries stay
    /// armed for their next fire; one-shot entries are removed after firing.
    /// Each entry fires at most once per tick: a late wake catches up with a
    /// single fire, not a burst.
    pub fn tick(&mut self, from_ms: i64, now_ms: i64) -> Vec<CronEntry> {
        let mut fired: Vec<(i64, CronEntry)> = Vec::new();
        let mut kept: Vec<ScheduledEntry> = Vec::with_capacity(self.entries.len());
        for s in self.entries.drain(..) {
            let fire = next_fire(&s.parsed, from_ms, self.tz_offset_minutes);
            if let Some(fire) = fire
                && fire <= now_ms
            {
                fired.push((fire, s.entry.clone()));
                if s.entry.recurring {
                    kept.push(s);
                }
            } else {
                kept.push(s);
            }
        }
        self.entries = kept;
        fired.sort_by_key(|(fire, _)| *fire);
        fired.into_iter().map(|(_, entry)| entry).collect()
    }

    /// Spawn the background loop: sleep until the earliest next fire, fire
    /// every entry due by wake-up through `on_fire`, then repeat. The task
    /// ends when no entry has a future fire (all one-shots fired, or nothing
    /// schedulable).
    pub fn start<F>(
        entries: Vec<CronEntry>,
        tz_offset_minutes: i32,
        on_fire: F,
    ) -> tokio::task::JoinHandle<()>
    where
        F: Fn(&CronEntry) + Send + Sync + 'static,
    {
        let mut sched = Self::new(entries, tz_offset_minutes);
        tokio::spawn(async move {
            loop {
                let now = now_ms();
                let Some(next) = sched.next_fire_at(now) else {
                    return;
                };
                let wait = Duration::from_millis((next - now).max(0) as u64);
                tokio::time::sleep(wait).await;
                let fired = sched.tick(now, now_ms());
                for entry in &fired {
                    on_fire(entry);
                }
            }
        })
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2024-06-01T00:00:00Z (a Saturday), the reference instant for tests.
    const T0: i64 = 1_717_200_000_000;

    fn at(minutes: i64) -> i64 {
        T0 + minutes * 60_000
    }

    fn entry(id: &str, cron: &str, prompt: &str, recurring: bool) -> CronEntry {
        CronEntry {
            id: id.into(),
            cron: cron.into(),
            prompt: prompt.into(),
            recurring,
        }
    }

    #[test]
    fn next_fire_at_earliest_across_entries() {
        let sched = CronScheduler::new(
            vec![
                entry("a", "30 14 * * *", "afternoon", true),
                entry("b", "0 9 * * *", "morning", true),
            ],
            0,
        );
        // 09:00 is earlier than 14:30 on 2024-06-01.
        assert_eq!(sched.next_fire_at(T0), Some(at(540)));
        // Empty scheduler: nothing to fire.
        assert_eq!(CronScheduler::new(vec![], 0).next_fire_at(T0), None);
    }

    #[test]
    fn next_fire_at_respects_tz_offset() {
        let sched = CronScheduler::new(
            vec![
                entry("a", "30 14 * * *", "afternoon", true),
                entry("b", "0 9 * * *", "morning", true),
            ],
            480,
        );
        // UTC+8: 09:00 local = 01:00Z (60 min after T0), 14:30 local =
        // 06:30Z (390 min after T0); the earliest fire is 09:00 local.
        assert_eq!(sched.next_fire_at(T0), Some(at(60)));
    }

    #[test]
    fn tick_fires_due_entries_in_fire_order() {
        let mut sched = CronScheduler::new(
            vec![
                entry("a", "10 * * * *", "ten", true),
                entry("b", "5 * * * *", "five", true),
                entry("c", "20 * * * *", "twenty", true),
            ],
            0,
        );
        let fired = sched.tick(T0, at(20));
        assert_eq!(
            fired.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["b", "a", "c"]
        );
        // All recurring: every entry stays armed for its next fire.
        assert_eq!(sched.next_fire_at(at(20)), Some(at(65)));
    }

    #[test]
    fn tick_removes_one_shot_after_firing() {
        let mut sched = CronScheduler::new(
            vec![
                entry("one", "5 * * * *", "once", false),
                entry("rec", "10 * * * *", "repeat", true),
            ],
            0,
        );
        let fired = sched.tick(T0, at(5));
        assert_eq!(
            fired.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["one"]
        );
        // The one-shot is gone; the recurring entry is still armed.
        assert_eq!(sched.next_fire_at(at(5)), Some(at(10)));
        let fired = sched.tick(at(5), at(10));
        assert_eq!(
            fired.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["rec"]
        );
        // The recurring entry keeps firing hourly.
        assert_eq!(sched.next_fire_at(at(10)), Some(at(70)));
    }

    #[test]
    fn tick_recurring_keeps_firing() {
        let mut sched = CronScheduler::new(vec![entry("r", "*/5 * * * *", "tick", true)], 0);
        for minute in [5, 10, 15] {
            let fired = sched.tick(at(minute - 5), at(minute));
            assert_eq!(fired.len(), 1, "fire at +{minute} min");
            assert_eq!(fired[0].id, "r");
        }
        assert_eq!(sched.next_fire_at(at(15)), Some(at(20)));
    }

    #[test]
    fn tick_skips_entries_not_yet_due() {
        let mut sched = CronScheduler::new(vec![entry("d", "30 14 * * *", "daily", true)], 0);
        assert!(sched.tick(T0, at(10)).is_empty());
        assert_eq!(sched.next_fire_at(at(10)), Some(at(870)));
        let fired = sched.tick(at(10), at(870));
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].id, "d");
    }

    #[test]
    fn invalid_or_never_firing_entries_are_skipped() {
        // Unparseable expressions are dropped at construction.
        let sched = CronScheduler::new(vec![entry("bad", "not a cron", "x", true)], 0);
        assert_eq!(sched.next_fire_at(T0), None);
        // Feb 30 never exists: kept but never fires.
        let sched = CronScheduler::new(vec![entry("never", "0 0 30 2 *", "x", true)], 0);
        assert_eq!(sched.next_fire_at(T0), None);
    }

    #[tokio::test]
    async fn start_ends_when_nothing_is_schedulable() {
        // No entries: the background task exits immediately.
        let handle = CronScheduler::start(vec![], 0, |_| {});
        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("task should end promptly")
            .expect("task should not panic");
        // Only never-firing entries: same.
        let handle = CronScheduler::start(vec![entry("never", "0 0 30 2 *", "x", true)], 0, |_| {});
        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("task should end promptly")
            .expect("task should not panic");
    }
}
