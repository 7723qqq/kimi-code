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
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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

    /// Add or update an entry dynamically. Returns true if parsed and added.
    pub fn add_entry(&mut self, entry: CronEntry) -> bool {
        if let Ok(parsed) = parse(&entry.cron) {
            if let Some(pos) = self.entries.iter().position(|s| s.entry.id == entry.id) {
                self.entries[pos] = ScheduledEntry { entry, parsed };
            } else {
                self.entries.push(ScheduledEntry { entry, parsed });
            }
            true
        } else {
            false
        }
    }

    /// Remove an entry by ID. Returns true if removed, false if not found.
    pub fn remove_entry(&mut self, id: &str) -> bool {
        let before = self.entries.len();
        self.entries.retain(|s| s.entry.id != id);
        self.entries.len() < before
    }

    /// List all currently scheduled entries.
    pub fn list_entries(&self) -> Vec<CronEntry> {
        self.entries.iter().map(|s| s.entry.clone()).collect()
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
        // 09:00 is earlier than 14:30 on 2024-06-01 (at(540) vs at(870)).
        assert_eq!(sched.next_fire_at(T0), Some(at(540)));
        // After 09:00 passes, earliest fire becomes 14:30.
        assert_eq!(sched.next_fire_at(at(540)), Some(at(870)));
        // After 14:30 passes, earliest fire wraps to next day at 09:00 (at(540 + 1440)).
        assert_eq!(sched.next_fire_at(at(870)), Some(at(1980)));

        // Both entries remain accurately retained.
        assert_eq!(
            sched.list_entries(),
            vec![
                entry("a", "30 14 * * *", "afternoon", true),
                entry("b", "0 9 * * *", "morning", true),
            ]
        );

        // Empty scheduler: nothing to fire.
        assert_eq!(CronScheduler::new(vec![], 0).next_fire_at(T0), None);
    }

    #[test]
    fn next_fire_at_respects_tz_offset() {
        let entries = vec![
            entry("a", "30 14 * * *", "afternoon", true),
            entry("b", "0 9 * * *", "morning", true),
        ];

        // UTC+8 (+480 min): 09:00 local = 01:00Z (60 min after T0), 14:30 local = 06:30Z (390 min after T0).
        let sched_east = CronScheduler::new(entries.clone(), 480);
        assert_eq!(sched_east.next_fire_at(T0), Some(at(60)));

        // UTC-5 (-300 min): 09:00 local = 14:00Z (840 min after T0), 14:30 local = 19:30Z (1170 min after T0).
        let sched_west = CronScheduler::new(entries, -300);
        assert_eq!(sched_west.next_fire_at(T0), Some(at(840)));
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
        // Must return full CronEntry structs in strict fire-time order (5 min, 10 min, 20 min).
        assert_eq!(
            fired,
            vec![
                entry("b", "5 * * * *", "five", true),
                entry("a", "10 * * * *", "ten", true),
                entry("c", "20 * * * *", "twenty", true),
            ]
        );
        // All entries are recurring: all 3 entries remain armed in the scheduler.
        assert_eq!(
            sched.list_entries(),
            vec![
                entry("a", "10 * * * *", "ten", true),
                entry("b", "5 * * * *", "five", true),
                entry("c", "20 * * * *", "twenty", true),
            ]
        );
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
        assert_eq!(fired, vec![entry("one", "5 * * * *", "once", false)]);
        // The one-shot is removed from entries; the recurring entry is still present and armed.
        assert_eq!(
            sched.list_entries(),
            vec![entry("rec", "10 * * * *", "repeat", true)]
        );
        assert_eq!(sched.next_fire_at(at(5)), Some(at(10)));

        let fired = sched.tick(at(5), at(10));
        assert_eq!(fired, vec![entry("rec", "10 * * * *", "repeat", true)]);
        // Recurring entry remains present in entries after firing.
        assert_eq!(
            sched.list_entries(),
            vec![entry("rec", "10 * * * *", "repeat", true)]
        );
        assert_eq!(sched.next_fire_at(at(10)), Some(at(70)));

        // An isolated one-shot entry leaves the scheduler empty after firing.
        let mut solo = CronScheduler::new(vec![entry("lone", "5 * * * *", "solo", false)], 0);
        let fired_solo = solo.tick(T0, at(5));
        assert_eq!(fired_solo, vec![entry("lone", "5 * * * *", "solo", false)]);
        assert!(solo.list_entries().is_empty());
        assert_eq!(solo.next_fire_at(at(5)), None);
    }

    #[test]
    fn tick_recurring_keeps_firing() {
        let expected_task = entry("r", "*/5 * * * *", "tick", true);
        let mut sched = CronScheduler::new(vec![expected_task.clone()], 0);
        for minute in [5, 10, 15] {
            let fired = sched.tick(at(minute - 5), at(minute));
            assert_eq!(
                fired,
                vec![expected_task.clone()],
                "fire at +{minute} min must return full entry"
            );
            assert_eq!(sched.list_entries(), vec![expected_task.clone()]);
        }
        assert_eq!(sched.next_fire_at(at(15)), Some(at(20)));
    }

    #[test]
    fn tick_skips_entries_not_yet_due() {
        let expected_task = entry("d", "30 14 * * *", "daily", true);
        let mut sched = CronScheduler::new(vec![expected_task.clone()], 0);

        // Before 14:30 (at(10)): does not fire, list remains unchanged.
        assert_eq!(sched.tick(T0, at(10)), vec![]);
        assert_eq!(sched.list_entries(), vec![expected_task.clone()]);
        assert_eq!(sched.next_fire_at(at(10)), Some(at(870)));

        // Exactly at 14:30 (at(870)): fires.
        let fired = sched.tick(at(10), at(870));
        assert_eq!(fired, vec![expected_task.clone()]);
        // Recurring task stays in entries and advances to next day.
        assert_eq!(sched.list_entries(), vec![expected_task]);
        assert_eq!(sched.next_fire_at(at(870)), Some(at(870 + 1440)));
    }

    #[test]
    fn tick_late_wake_coalesces_multiple_fires_to_single_fire() {
        // Business requirement: Each entry fires at most once per tick.
        // A late wake spanning multiple scheduled intervals catches up with a single fire, not a burst.
        let task = entry("r", "*/5 * * * *", "tick", true);
        let mut sched = CronScheduler::new(vec![task.clone()], 0);

        // 60 minutes elapsed: spans 12 theoretical intervals (5, 10, 15, ..., 60).
        let fired = sched.tick(T0, at(60));
        assert_eq!(
            fired,
            vec![task.clone()],
            "must coalesce to a single fire, never burst"
        );
        // Remains armed for the next fire strictly after at(60) -> at(65).
        assert_eq!(sched.next_fire_at(at(60)), Some(at(65)));
        assert_eq!(sched.list_entries(), vec![task]);
    }

    #[test]
    fn tick_interval_boundary_conditions() {
        // Interval is (from_ms, now_ms] — strictly after from_ms, up to and including now_ms.
        let task = entry("t", "5 * * * *", "test", true);
        let mut sched = CronScheduler::new(vec![task.clone()], 0);

        // 1. now_ms is 1ms before due time: does not fire
        assert_eq!(sched.tick(T0, at(5) - 1), vec![]);
        assert_eq!(sched.next_fire_at(at(5) - 1), Some(at(5)));

        // 2. now_ms is exactly due time: fires
        assert_eq!(sched.tick(T0, at(5)), vec![task]);

        // 3. from_ms == now_ms: interval (from_ms, now_ms] is empty, does not fire
        assert_eq!(sched.tick(at(5), at(5)), vec![]);

        // 4. from_ms > now_ms: inverted interval, does not fire
        assert_eq!(sched.tick(at(10), at(5)), vec![]);
    }

    #[test]
    fn tick_multiple_entries_same_fire_time() {
        let entry1 = entry("e1", "0 9 * * *", "first", true);
        let entry2 = entry("e2", "0 9 * * *", "second", false);
        let mut sched = CronScheduler::new(vec![entry1.clone(), entry2.clone()], 0);

        // Both due at 09:00 (at(540)): both must fire in registered order.
        let fired = sched.tick(T0, at(540));
        assert_eq!(fired, vec![entry1.clone(), entry2]);
        // e2 was one-shot so it was removed; e1 was recurring so it was kept.
        assert_eq!(sched.list_entries(), vec![entry1]);
    }

    #[test]
    fn invalid_or_never_firing_entries_are_skipped() {
        // Unparseable expressions are dropped at construction: list_entries MUST be empty.
        let sched = CronScheduler::new(vec![entry("bad", "not a cron", "x", true)], 0);
        assert!(
            sched.list_entries().is_empty(),
            "unparseable entries must be dropped at construction"
        );
        assert_eq!(sched.next_fire_at(T0), None);

        // Feb 30 never exists: parsed successfully so it IS kept in list_entries, but never fires.
        let never_entry = entry("never", "0 0 30 2 *", "x", true);
        let mut sched = CronScheduler::new(vec![never_entry.clone()], 0);
        assert_eq!(
            sched.list_entries(),
            vec![never_entry],
            "syntactically valid never-firing entries must be retained"
        );
        assert_eq!(sched.next_fire_at(T0), None);
        // Ticking past any duration yields no fires and keeps the entry.
        assert_eq!(sched.tick(T0, at(100_000)), vec![]);
        assert_eq!(sched.list_entries().len(), 1);
    }

    #[tokio::test]
    async fn start_ends_when_nothing_is_schedulable() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        // No entries: background task exits promptly without calling on_fire.
        let fired = Arc::new(AtomicBool::new(false));
        let fired_clone = fired.clone();
        let handle = CronScheduler::start(vec![], 0, move |_| {
            fired_clone.store(true, Ordering::SeqCst);
        });
        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("task should end promptly")
            .expect("task should not panic");
        assert!(!fired.load(Ordering::SeqCst), "callback must not be called when empty");

        // Only never-firing entries: background task exits promptly without calling on_fire.
        let fired = Arc::new(AtomicBool::new(false));
        let fired_clone = fired.clone();
        let handle = CronScheduler::start(
            vec![entry("never", "0 0 30 2 *", "x", true)],
            0,
            move |_| {
                fired_clone.store(true, Ordering::SeqCst);
            },
        );
        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("task should end promptly")
            .expect("task should not panic");
        assert!(!fired.load(Ordering::SeqCst), "callback must not be called for never-firing");

        // Unparseable entries dropped at start: exits promptly without calling on_fire.
        let fired = Arc::new(AtomicBool::new(false));
        let fired_clone = fired.clone();
        let handle = CronScheduler::start(
            vec![entry("bad", "not a cron", "x", true)],
            0,
            move |_| {
                fired_clone.store(true, Ordering::SeqCst);
            },
        );
        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("task should end promptly")
            .expect("task should not panic");
        assert!(!fired.load(Ordering::SeqCst), "callback must not be called for unparseable");
    }

    #[test]
    fn test_dynamic_add_remove_and_list_entries() {
        let entry_a = entry("a", "0 9 * * *", "job a", true);
        let mut sched = CronScheduler::new(vec![entry_a.clone()], 0);
        assert_eq!(sched.list_entries(), vec![entry_a.clone()]);
        assert_eq!(sched.next_fire_at(T0), Some(at(540)));

        // Add valid entry
        let entry_b = entry("b", "30 14 * * *", "job b", true);
        assert!(sched.add_entry(entry_b.clone()));
        assert_eq!(sched.list_entries(), vec![entry_a.clone(), entry_b.clone()]);
        assert_eq!(sched.next_fire_at(T0), Some(at(540)));

        // Add invalid entry fails and does not mutate list
        assert!(!sched.add_entry(entry("c", "invalid cron", "job c", true)));
        assert_eq!(sched.list_entries(), vec![entry_a.clone(), entry_b.clone()]);

        // Attempt to update existing entry with invalid cron fails and leaves entry intact
        assert!(!sched.add_entry(entry("a", "bad cron", "job a corrupt", true)));
        assert_eq!(sched.list_entries(), vec![entry_a, entry_b.clone()]);

        // Update existing entry with valid cron and changed settings
        let entry_a_updated = entry("a", "0 10 * * *", "job a updated", false);
        assert!(sched.add_entry(entry_a_updated.clone()));
        assert_eq!(sched.list_entries(), vec![entry_a_updated, entry_b.clone()]);
        // Earliest fire reflects updated entry: 10:00 (at(600)) vs 14:30 (at(870))
        assert_eq!(sched.next_fire_at(T0), Some(at(600)));

        // Remove non-existent entry returns false
        assert!(!sched.remove_entry("nonexistent"));
        assert_eq!(sched.list_entries().len(), 2);

        // Remove entry 'a'
        assert!(sched.remove_entry("a"));
        assert_eq!(sched.list_entries(), vec![entry_b.clone()]);
        assert_eq!(sched.next_fire_at(T0), Some(at(870)));

        // Removing already removed entry returns false
        assert!(!sched.remove_entry("a"));

        // Remove entry 'b'
        assert!(sched.remove_entry("b"));
        assert!(sched.list_entries().is_empty());
        assert_eq!(sched.next_fire_at(T0), None);
    }

    #[test]
    fn cron_entry_serde() {
        let e = entry("task-1", "0 9 * * *", "hello world", true);
        let json = serde_json::to_string(&e).unwrap();
        let deserialized: CronEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, e);

        // Wire shape with extra fields ignored (createdAt, nextFireAt, stale, humanSchedule)
        let wire_json = r#"{
            "id": "task-2",
            "cron": "*/5 * * * *",
            "prompt": "run check",
            "createdAt": 1717200000000,
            "nextFireAt": "2024-06-01T00:05:00.000Z",
            "stale": false,
            "humanSchedule": "every 5 minutes"
        }"#;
        let from_wire: CronEntry = serde_json::from_str(wire_json).unwrap();
        assert_eq!(
            from_wire,
            CronEntry {
                id: "task-2".into(),
                cron: "*/5 * * * *".into(),
                prompt: "run check".into(),
                recurring: true, // defaults to true when omitted
            }
        );

        // Explicit recurring: false
        let one_shot_json =
            r#"{"id":"task-3","cron":"0 0 1 1 *","prompt":"yearly","recurring":false}"#;
        let one_shot: CronEntry = serde_json::from_str(one_shot_json).unwrap();
        assert!(!one_shot.recurring);
        assert_eq!(one_shot.id, "task-3");
        assert_eq!(one_shot.cron, "0 0 1 1 *");
        assert_eq!(one_shot.prompt, "yearly");
    }
}
