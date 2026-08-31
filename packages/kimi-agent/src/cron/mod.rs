//! Pure cron expression parsing, next-fire computation, and human-readable
//! rendering, ported from the v2 cron feature
//! (`agent-core-v2/src/features/cron/internal/cron-expr.ts`). Error messages
//! and rendered output are aligned with v2. The time-dependent functions
//! take an explicit local-timezone offset (minutes east of UTC) because std
//! has no local-time API; the caller supplies the host's offset.

pub mod scheduler;

use std::collections::BTreeSet;
use std::error::Error;
use std::fmt;

/// A parsed 5-field cron expression, mirroring v2 `ParsedCronExpression`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCron {
    pub raw: String,
    pub minutes: BTreeSet<u8>,
    pub hours: BTreeSet<u8>,
    pub days_of_month: BTreeSet<u8>,
    pub months: BTreeSet<u8>,
    pub days_of_week: BTreeSet<u8>,
    pub days_of_month_wildcard: bool,
    pub days_of_week_wildcard: bool,
}

/// Cron expression validation error; the message mirrors v2 `Error2` text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronError(pub String);

impl fmt::Display for CronError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Error for CronError {}

/// One-shot cap: a one-shot cron whose first fire is more than 350 days out
/// is refused (v2 `ONE_SHOT_MAX_FUTURE_MS`).
pub const ONE_SHOT_MAX_FUTURE_MS: i64 = 350 * 24 * 60 * 60 * 1000;

/// Prompt byte cap for cron jobs (v2 `MAX_PROMPT_BYTES`).
pub const MAX_PROMPT_BYTES: usize = 8 * 1024;

const MS_PER_MINUTE: i64 = 60_000;
const HARD_ITERATION_CAP: i64 = 10_000_000;
const FIVE_YEAR_WINDOW_MINUTES: i64 = 5 * 366 * 24 * 60;

const MONTH_NAMES: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

const DAY_NAMES: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

/// Parse a 5-field cron expression ("minute hour day-of-month month
/// day-of-week"), mirroring v2 `parseCronExpression`: comma lists, `*`,
/// `N`, `N-M` ranges, and `/step` suffixes; day-of-week 7 is normalized to
/// 0 (Sunday).
pub fn parse(expr: &str) -> Result<ParsedCron, CronError> {
    let trimmed = expr.trim();
    if trimmed.is_empty() {
        return Err(CronError("cron expression is empty".into()));
    }
    let fields: Vec<&str> = trimmed.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(CronError(format!(
            "cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week); got {}",
            fields.len()
        )));
    }
    let minutes = parse_field(fields[0], 0, 59, "minute")?;
    let hours = parse_field(fields[1], 0, 23, "hour")?;
    let days_of_month = parse_field(fields[2], 1, 31, "day-of-month")?;
    let months = parse_field(fields[3], 1, 12, "month")?;
    let dow_raw = parse_field(fields[4], 0, 7, "day-of-week")?;
    let days_of_week = dow_raw
        .into_iter()
        .map(|v| if v == 7 { 0 } else { v })
        .collect();
    Ok(ParsedCron {
        raw: trimmed.to_string(),
        minutes,
        hours,
        days_of_month,
        months,
        days_of_week,
        days_of_month_wildcard: fields[2] == "*",
        days_of_week_wildcard: fields[4] == "*",
    })
}

fn parse_field(field: &str, min: u8, max: u8, name: &str) -> Result<BTreeSet<u8>, CronError> {
    if field.is_empty() {
        return Err(CronError(format!("cron {name} field is empty")));
    }
    let mut out = BTreeSet::new();
    for term in field.split(',') {
        if term.is_empty() {
            return Err(CronError(format!(
                "cron {name} field has empty term in list"
            )));
        }
        add_term(&mut out, term, min, max, name)?;
    }
    if out.is_empty() {
        return Err(CronError(format!("cron {name} field matches no values")));
    }
    Ok(out)
}

fn parse_cron_int(raw: &str, name: &str, role: &str) -> Result<i64, CronError> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(CronError(format!(
            "cron {name} {role} must be a non-negative integer with digits only (got \"{raw}\")"
        )));
    }
    // Overflowing digit strings fail the caller's range check, matching v2
    // where a huge parse result is rejected as out of range.
    Ok(raw.parse::<i64>().unwrap_or(i64::MAX))
}

fn add_term(
    out: &mut BTreeSet<u8>,
    term: &str,
    min: u8,
    max: u8,
    name: &str,
) -> Result<(), CronError> {
    let mut range_part = term;
    let mut step: i64 = 1;
    if let Some(slash) = term.find('/') {
        range_part = &term[..slash];
        let step_str = &term[slash + 1..];
        if step_str.is_empty() {
            return Err(CronError(format!(
                "cron {name} step is empty in \"{term}\""
            )));
        }
        let parsed_step = parse_cron_int(step_str, name, "step")?;
        if parsed_step <= 0 {
            return Err(CronError(format!(
                "cron {name} step must be a positive integer (got \"{step_str}\")"
            )));
        }
        step = parsed_step;
        if range_part.is_empty() {
            return Err(CronError(format!(
                "cron {name} step needs a range or \"*\" before \"/\" in \"{term}\""
            )));
        }
    }

    let (lo, hi): (i64, i64);
    if range_part == "*" {
        lo = i64::from(min);
        hi = i64::from(max);
    } else if let Some(dash) = range_part.find('-') {
        let lo_str = &range_part[..dash];
        let hi_str = &range_part[dash + 1..];
        let lo_v = parse_cron_int(lo_str, name, "range lower bound")?;
        let hi_v = parse_cron_int(hi_str, name, "range upper bound")?;
        if lo_v < i64::from(min) || hi_v > i64::from(max) || lo_v > hi_v {
            return Err(CronError(format!(
                "cron {name} range {lo_v}-{hi_v} out of bounds (must be {min}..{max}, ascending)"
            )));
        }
        lo = lo_v;
        hi = hi_v;
    } else {
        let single = parse_cron_int(range_part, name, "value")?;
        if single < i64::from(min) || single > i64::from(max) {
            return Err(CronError(format!(
                "cron {name} value {single} out of range {min}..{max}"
            )));
        }
        if term.contains('/') {
            lo = single;
            hi = i64::from(max);
        } else {
            out.insert(single as u8);
            return Ok(());
        }
    }

    let mut v = lo;
    while v <= hi {
        out.insert(v as u8);
        v = v.saturating_add(step);
    }
    Ok(())
}

/// Compute the next fire time (epoch ms) strictly after `from_ms`, mirroring
/// v2 `computeNextCronRun`: the scan starts at the next minute boundary in
/// the given timezone and stops after a 5-year (366-day years) window.
/// `tz_offset_minutes` is the local offset east of UTC (e.g. UTC+8 = 480).
pub fn next_fire(expr: &ParsedCron, from_ms: i64, tz_offset_minutes: i32) -> Option<i64> {
    next_run_within_minutes(expr, from_ms, tz_offset_minutes, FIVE_YEAR_WINDOW_MINUTES)
}

/// Whether the expression fires at least once within `years` (366-day
/// years), mirroring v2 `hasFireWithinYears`.
pub fn has_fire_within_years(
    expr: &ParsedCron,
    years: u32,
    from_ms: i64,
    tz_offset_minutes: i32,
) -> bool {
    let cap = (i64::from(years) * 366 * 24 * 60).max(1);
    next_run_within_minutes(expr, from_ms, tz_offset_minutes, cap).is_some()
}

fn next_run_within_minutes(
    expr: &ParsedCron,
    from_ms: i64,
    tz_offset_minutes: i32,
    cap_minutes: i64,
) -> Option<i64> {
    let mut civil = epoch_ms_to_civil(from_ms, tz_offset_minutes);
    advance_minute(&mut civil);
    let deadline_ms = from_ms + cap_minutes * MS_PER_MINUTE;
    let mut iterations: i64 = 0;
    while civil_to_epoch_ms(&civil, tz_offset_minutes) <= deadline_ms
        && iterations < HARD_ITERATION_CAP
    {
        iterations += 1;
        if !expr.months.contains(&(civil.month as u8)) {
            advance_month(&mut civil);
            continue;
        }
        if !day_matches(expr, &civil) {
            advance_day(&mut civil);
            continue;
        }
        if !expr.hours.contains(&(civil.hour as u8)) {
            advance_hour(&mut civil);
            continue;
        }
        if !expr.minutes.contains(&(civil.minute as u8)) {
            advance_minute(&mut civil);
            continue;
        }
        return Some(civil_to_epoch_ms(&civil, tz_offset_minutes));
    }
    None
}

/// Validate that a prompt fits within `max_bytes` UTF-8 bytes, mirroring the
/// v2 CronCreate byte cap check.
pub fn validate_prompt_bytes(prompt: &str, max_bytes: usize) -> Result<(), CronError> {
    let len = prompt.len();
    if len > max_bytes {
        return Err(CronError(format!(
            "Prompt exceeds {max_bytes} bytes (got {len})."
        )));
    }
    Ok(())
}

/// Validate the one-shot cap: the first fire must be within
/// [`ONE_SHOT_MAX_FUTURE_MS`] of `from_ms`; returns the first fire on
/// success, mirroring the v2 CronCreate one-shot check.
pub fn validate_one_shot(
    expr: &ParsedCron,
    from_ms: i64,
    tz_offset_minutes: i32,
) -> Result<i64, CronError> {
    let Some(first_fire) = next_fire(expr, from_ms, tz_offset_minutes) else {
        return Err(CronError(format!(
            "Cron expression \"{}\" has no fire within 5 years; refusing to schedule.",
            expr.raw
        )));
    };
    if first_fire - from_ms > ONE_SHOT_MAX_FUTURE_MS {
        return Err(CronError(format!(
            "One-shot cron \"{}\" would not fire until {} (more than a year out). If you meant \"today\" or a near date, the pinned day/month has already passed this year — pick a future date or use wildcards.",
            expr.raw,
            format_local_iso_with_offset(first_fire, tz_offset_minutes)
        )));
    }
    Ok(first_fire)
}

/// Format an epoch-ms timestamp as local ISO 8601 with a numeric offset,
/// mirroring v2 `formatLocalIsoWithOffset`.
pub fn format_local_iso_with_offset(ms: i64, tz_offset_minutes: i32) -> String {
    let civil = epoch_ms_to_civil(ms, tz_offset_minutes);
    let sign = if tz_offset_minutes >= 0 { '+' } else { '-' };
    let abs_offset = tz_offset_minutes.abs();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}{}{:02}:{:02}",
        civil.year,
        civil.month,
        civil.day,
        civil.hour,
        civil.minute,
        ms.div_euclid(1000).rem_euclid(60),
        ms.rem_euclid(1000),
        sign,
        abs_offset / 60,
        abs_offset % 60,
    )
}

/// Render a human-readable schedule description, mirroring v2
/// `cronToHuman`; falls back to the raw expression when no pattern matches.
pub fn to_human(expr: &ParsedCron) -> String {
    let all_min = is_full_range(&expr.minutes, 0, 59);
    let all_hour = is_full_range(&expr.hours, 0, 23);
    let all_dom = expr.days_of_month_wildcard;
    let all_month = is_full_range(&expr.months, 1, 12);
    let all_dow = expr.days_of_week_wildcard;

    if all_hour && all_dom && all_month && all_dow {
        if let Some(step) = detect_step(&expr.minutes, 0, 59)
            && step > 1
        {
            return format!("every {step} minutes");
        }
        if all_min {
            return "every minute".to_string();
        }
        if expr.minutes.len() == 1 {
            let m = *expr.minutes.iter().next().unwrap();
            return format!("at minute {m} of every hour");
        }
    }

    if expr.minutes.len() == 1 && all_dom && all_month && all_dow {
        let m = *expr.minutes.iter().next().unwrap();
        if let Some(step) = detect_step(&expr.hours, 0, 23)
            && step > 1
        {
            return format!("every {step} hours at minute {}", pad(m));
        }
    }

    if expr.minutes.len() == 1 && expr.hours.len() == 1 && all_dom && all_month {
        let h = *expr.hours.iter().next().unwrap();
        let m = *expr.minutes.iter().next().unwrap();
        if all_dow {
            return format!("at {}:{} every day", pad(h), pad(m));
        }
        if let Some(dow_str) = format_dows(&expr.days_of_week) {
            return format!("at {}:{} on {dow_str}", pad(h), pad(m));
        }
    }

    if expr.minutes.len() == 1
        && expr.hours.len() == 1
        && expr.days_of_month.len() == 1
        && !expr.days_of_month_wildcard
        && expr.months.len() == 1
        && all_dow
    {
        let h = *expr.hours.iter().next().unwrap();
        let m = *expr.minutes.iter().next().unwrap();
        let d = *expr.days_of_month.iter().next().unwrap();
        let mo = *expr.months.iter().next().unwrap();
        return format!(
            "at {}:{} on day {d} of {}",
            pad(h),
            pad(m),
            MONTH_NAMES[(mo - 1) as usize]
        );
    }

    expr.raw.clone()
}

fn is_full_range(set: &BTreeSet<u8>, min: u8, max: u8) -> bool {
    if set.len() != usize::from(max - min + 1) {
        return false;
    }
    (min..=max).all(|v| set.contains(&v))
}

fn detect_step(set: &BTreeSet<u8>, min: u8, max: u8) -> Option<u8> {
    let values: Vec<u8> = set.iter().copied().collect();
    if values.len() < 2 {
        return None;
    }
    if values[0] != min {
        return None;
    }
    let step = values[1] - values[0];
    if step == 0 {
        return None;
    }
    let mut expected = min;
    for &v in &values {
        if v != expected {
            return None;
        }
        expected += step;
    }
    if expected - step > max {
        return None;
    }
    Some(step)
}

fn format_dows(set: &BTreeSet<u8>) -> Option<String> {
    let values: Vec<u8> = set.iter().copied().collect();
    if values.is_empty() {
        return None;
    }
    if values.len() == 5 && values.iter().enumerate().all(|(i, &v)| v == i as u8 + 1) {
        return Some("weekdays".to_string());
    }
    if values.len() == 2 && values[0] == 0 && values[1] == 6 {
        return Some("weekends".to_string());
    }
    Some(
        values
            .iter()
            .map(|&v| DAY_NAMES[v as usize])
            .collect::<Vec<_>>()
            .join(", "),
    )
}

fn pad(n: u8) -> String {
    if n < 10 {
        format!("0{n}")
    } else {
        n.to_string()
    }
}

/// A civil (wall-clock) datetime in a fixed-offset timezone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Civil {
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
}

fn day_matches(expr: &ParsedCron, c: &Civil) -> bool {
    let dom = c.day as u8;
    let dow = weekday(c);
    let dom_ok = expr.days_of_month.contains(&dom);
    let dow_ok = expr.days_of_week.contains(&dow);
    if expr.days_of_month_wildcard && expr.days_of_week_wildcard {
        return true;
    }
    if expr.days_of_month_wildcard {
        return dow_ok;
    }
    if expr.days_of_week_wildcard {
        return dom_ok;
    }
    dom_ok || dow_ok
}

fn weekday(c: &Civil) -> u8 {
    (days_from_civil(c.year, c.month, c.day) + 4).rem_euclid(7) as u8
}

fn advance_month(c: &mut Civil) {
    c.day = 1;
    c.hour = 0;
    c.minute = 0;
    c.month += 1;
    if c.month > 12 {
        c.month = 1;
        c.year += 1;
    }
}

fn advance_day(c: &mut Civil) {
    c.hour = 0;
    c.minute = 0;
    c.day += 1;
    if c.day > days_in_month(c.year, c.month) {
        c.day = 1;
        c.month += 1;
        if c.month > 12 {
            c.month = 1;
            c.year += 1;
        }
    }
}

fn advance_hour(c: &mut Civil) {
    c.minute = 0;
    c.hour += 1;
    if c.hour >= 24 {
        c.hour = 0;
        advance_day(c);
    }
}

fn advance_minute(c: &mut Civil) {
    c.minute += 1;
    if c.minute >= 60 {
        c.minute = 0;
        advance_hour(c);
    }
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap_year(year) {
                29
            } else {
                28
            }
        }
        _ => unreachable!("month is always 1..=12"),
    }
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn epoch_ms_to_civil(ms: i64, tz_offset_minutes: i32) -> Civil {
    let shifted = ms + i64::from(tz_offset_minutes) * MS_PER_MINUTE;
    let days = shifted.div_euclid(86_400_000);
    let rem = shifted.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    Civil {
        year,
        month,
        day,
        hour: (rem / 3_600_000) as u32,
        minute: ((rem % 3_600_000) / 60_000) as u32,
    }
}

fn civil_to_epoch_ms(c: &Civil, tz_offset_minutes: i32) -> i64 {
    days_from_civil(c.year, c.month, c.day) * 86_400_000
        + i64::from(c.hour) * 3_600_000
        + i64::from(c.minute) * 60_000
        - i64::from(tz_offset_minutes) * MS_PER_MINUTE
}

/// Days since 1970-01-01 for a proleptic Gregorian civil date (Hinnant's
/// `days_from_civil`).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + i64::from(doy);
    era * 146_097 + doe - 719_468
}

/// Inverse of [`days_from_civil`] (Hinnant's `civil_from_days`).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    (year, month as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(values: &[u8]) -> BTreeSet<u8> {
        values.iter().copied().collect()
    }

    fn ms_utc(year: i64, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
        days_from_civil(year, month, day) * 86_400_000
            + i64::from(hour) * 3_600_000
            + i64::from(minute) * 60_000
    }

    #[test]
    fn parse_full_wildcard() {
        let p = parse("* * * * *").unwrap();
        assert_eq!(p.raw, "* * * * *");
        assert_eq!(p.minutes, set(&(0..=59).collect::<Vec<_>>()));
        assert_eq!(p.hours, set(&(0..=23).collect::<Vec<_>>()));
        assert_eq!(p.days_of_month, set(&(1..=31).collect::<Vec<_>>()));
        assert_eq!(p.months, set(&(1..=12).collect::<Vec<_>>()));
        assert_eq!(p.days_of_week, set(&(0..=6).collect::<Vec<_>>()));
        assert!(p.days_of_month_wildcard);
        assert!(p.days_of_week_wildcard);
    }

    #[test]
    fn parse_step_list_range() {
        let p = parse("*/5 * * * *").unwrap();
        assert_eq!(
            p.minutes,
            set(&[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
        );

        let p = parse("1/5 * * * *").unwrap();
        assert_eq!(
            p.minutes,
            set(&[1, 6, 11, 16, 21, 26, 31, 36, 41, 46, 51, 56])
        );

        let p = parse("*/15 9-17 * * *").unwrap();
        assert_eq!(p.hours, set(&(9..=17).collect::<Vec<_>>()));

        let p = parse("5,10,15 * * * *").unwrap();
        assert_eq!(p.minutes, set(&[5, 10, 15]));

        let p = parse("0 9 * * 1-5").unwrap();
        assert_eq!(p.days_of_week, set(&[1, 2, 3, 4, 5]));
        assert!(!p.days_of_week_wildcard);
    }

    #[test]
    fn parse_dow_seven_normalizes_to_zero() {
        let p = parse("0 0 * * 7").unwrap();
        assert_eq!(p.days_of_week, set(&[0]));
        assert!(!p.days_of_week_wildcard);

        let p = parse("0 0 * * 0,7").unwrap();
        assert_eq!(p.days_of_week, set(&[0]));
    }

    #[test]
    fn parse_trims_and_keeps_raw() {
        // v2 trims the expression but preserves internal whitespace.
        let p = parse("  */5   * * * *  ").unwrap();
        assert_eq!(p.raw, "*/5   * * * *");
        assert_eq!(
            p.minutes,
            set(&[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
        );
    }

    #[test]
    fn parse_pinned_date() {
        let p = parse("30 14 28 2 *").unwrap();
        assert_eq!(p.minutes, set(&[30]));
        assert_eq!(p.hours, set(&[14]));
        assert_eq!(p.days_of_month, set(&[28]));
        assert_eq!(p.months, set(&[2]));
        assert!(!p.days_of_month_wildcard);
    }

    #[test]
    fn parse_errors() {
        assert_eq!(parse("").unwrap_err().0, "cron expression is empty");
        assert_eq!(parse("   ").unwrap_err().0, "cron expression is empty");
        assert_eq!(
            parse("1 2 3 4").unwrap_err().0,
            "cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week); got 4"
        );
        assert_eq!(
            parse("1 2 3 4 5 6").unwrap_err().0,
            "cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week); got 6"
        );
        assert_eq!(
            parse("1,,2 * * * *").unwrap_err().0,
            "cron minute field has empty term in list"
        );
        assert_eq!(
            parse("1, * * * *").unwrap_err().0,
            "cron minute field has empty term in list"
        );
        assert_eq!(
            parse("-1 * * * *").unwrap_err().0,
            "cron minute range lower bound must be a non-negative integer with digits only (got \"\")"
        );
        assert_eq!(
            parse("1a * * * *").unwrap_err().0,
            "cron minute value must be a non-negative integer with digits only (got \"1a\")"
        );
        assert_eq!(
            parse("60 * * * *").unwrap_err().0,
            "cron minute value 60 out of range 0..59"
        );
        assert_eq!(
            parse("* 24 * * *").unwrap_err().0,
            "cron hour value 24 out of range 0..23"
        );
        assert_eq!(
            parse("* * 0 * *").unwrap_err().0,
            "cron day-of-month value 0 out of range 1..31"
        );
        assert_eq!(
            parse("* * 32 * *").unwrap_err().0,
            "cron day-of-month value 32 out of range 1..31"
        );
        assert_eq!(
            parse("* * * 13 *").unwrap_err().0,
            "cron month value 13 out of range 1..12"
        );
        assert_eq!(
            parse("* * * * 8").unwrap_err().0,
            "cron day-of-week value 8 out of range 0..7"
        );
        assert_eq!(
            parse("*/0 * * * *").unwrap_err().0,
            "cron minute step must be a positive integer (got \"0\")"
        );
        assert_eq!(
            parse("*/ * * * *").unwrap_err().0,
            "cron minute step is empty in \"*/\""
        );
        assert_eq!(
            parse("/5 * * * *").unwrap_err().0,
            "cron minute step needs a range or \"*\" before \"/\" in \"/5\""
        );
        assert_eq!(
            parse("5-2 * * * *").unwrap_err().0,
            "cron minute range 5-2 out of bounds (must be 0..59, ascending)"
        );
        assert_eq!(
            parse("5-60 * * * *").unwrap_err().0,
            "cron minute range 5-60 out of bounds (must be 0..59, ascending)"
        );
        assert_eq!(
            parse("5- * * * *").unwrap_err().0,
            "cron minute range upper bound must be a non-negative integer with digits only (got \"\")"
        );
    }

    #[test]
    fn next_fire_every_minute() {
        let p = parse("* * * * *").unwrap();
        let from = ms_utc(2024, 6, 1, 10, 30) + 45_500;
        assert_eq!(next_fire(&p, from, 0), Some(ms_utc(2024, 6, 1, 10, 31)));
        // Exactly on a minute boundary: strictly after.
        assert_eq!(
            next_fire(&p, ms_utc(2024, 6, 1, 10, 30), 0),
            Some(ms_utc(2024, 6, 1, 10, 31))
        );
    }

    #[test]
    fn next_fire_pinned_time() {
        let p = parse("30 14 * * *").unwrap();
        let from = ms_utc(2024, 6, 1, 10, 30);
        assert_eq!(next_fire(&p, from, 0), Some(ms_utc(2024, 6, 1, 14, 30)));
        // Already past today's 14:30: next day.
        assert_eq!(
            next_fire(&p, ms_utc(2024, 6, 1, 14, 30), 0),
            Some(ms_utc(2024, 6, 2, 14, 30))
        );
    }

    #[test]
    fn next_fire_weekdays() {
        // 2024-06-01 is a Saturday; next weekday 09:00 is Monday 06-03.
        let p = parse("0 9 * * 1-5").unwrap();
        let from = ms_utc(2024, 6, 1, 0, 0);
        assert_eq!(next_fire(&p, from, 0), Some(ms_utc(2024, 6, 3, 9, 0)));
    }

    #[test]
    fn next_fire_leap_day() {
        let p = parse("0 0 29 2 *").unwrap();
        // 2024-02-29 already passed; next is 2028-02-29.
        assert_eq!(
            next_fire(&p, ms_utc(2024, 3, 1, 0, 0), 0),
            Some(ms_utc(2028, 2, 29, 0, 0))
        );
        // Exactly on a fire: strictly after.
        assert_eq!(
            next_fire(&p, ms_utc(2024, 2, 29, 0, 0), 0),
            Some(ms_utc(2028, 2, 29, 0, 0))
        );
    }

    #[test]
    fn next_fire_year_boundary() {
        let p = parse("0 0 1 1 *").unwrap();
        assert_eq!(
            next_fire(&p, ms_utc(2024, 6, 1, 0, 0), 0),
            Some(ms_utc(2025, 1, 1, 0, 0))
        );
        let p = parse("59 23 31 12 *").unwrap();
        assert_eq!(
            next_fire(&p, ms_utc(2024, 6, 1, 0, 0), 0),
            Some(ms_utc(2024, 12, 31, 23, 59))
        );
    }

    #[test]
    fn next_fire_never_matches() {
        // Feb 30 and Apr 31 never exist: no fire within the 5-year window.
        let p = parse("0 0 30 2 *").unwrap();
        assert_eq!(next_fire(&p, ms_utc(2024, 6, 1, 0, 0), 0), None);
        let p = parse("0 0 31 4 *").unwrap();
        assert_eq!(next_fire(&p, ms_utc(2024, 6, 1, 0, 0), 0), None);
    }

    #[test]
    fn next_fire_timezone_offset() {
        let p = parse("30 14 * * *").unwrap();
        let from = ms_utc(2024, 6, 1, 6, 30);
        // UTC: 14:30 same day. UTC+8: 14:30 local is 06:30Z (already past),
        // so the next fire is tomorrow 14:30 local = 06:30Z.
        assert_eq!(next_fire(&p, from, 0), Some(ms_utc(2024, 6, 1, 14, 30)));
        assert_eq!(next_fire(&p, from, 480), Some(ms_utc(2024, 6, 2, 6, 30)));
    }

    #[test]
    fn next_fire_dow_seven_equals_zero() {
        let from = ms_utc(2024, 6, 1, 0, 0); // Saturday
        let p0 = parse("0 0 * * 0").unwrap();
        let p7 = parse("0 0 * * 7").unwrap();
        let expected = ms_utc(2024, 6, 2, 0, 0); // Sunday
        assert_eq!(next_fire(&p0, from, 0), Some(expected));
        assert_eq!(next_fire(&p7, from, 0), Some(expected));
    }

    #[test]
    fn has_fire_within_years_check() {
        let p = parse("0 0 29 2 *").unwrap();
        let from = ms_utc(2024, 3, 1, 0, 0);
        assert!(!has_fire_within_years(&p, 1, from, 0));
        assert!(has_fire_within_years(&p, 5, from, 0));

        let p = parse("* * * * *").unwrap();
        assert!(has_fire_within_years(&p, 1, from, 0));

        let p = parse("0 0 30 2 *").unwrap();
        assert!(!has_fire_within_years(&p, 5, from, 0));
    }

    #[test]
    fn to_human_patterns() {
        assert_eq!(to_human(&parse("* * * * *").unwrap()), "every minute");
        assert_eq!(to_human(&parse("*/5 * * * *").unwrap()), "every 5 minutes");
        assert_eq!(to_human(&parse("*/7 * * * *").unwrap()), "every 7 minutes");
        assert_eq!(
            to_human(&parse("1 * * * *").unwrap()),
            "at minute 1 of every hour"
        );
        assert_eq!(
            to_human(&parse("0 */2 * * *").unwrap()),
            "every 2 hours at minute 00"
        );
        assert_eq!(
            to_human(&parse("30 14 * * *").unwrap()),
            "at 14:30 every day"
        );
        assert_eq!(
            to_human(&parse("0 9 * * 1-5").unwrap()),
            "at 09:00 on weekdays"
        );
        assert_eq!(
            to_human(&parse("0 9 * * 0,6").unwrap()),
            "at 09:00 on weekends"
        );
        assert_eq!(
            to_human(&parse("0 9 * * 1,3").unwrap()),
            "at 09:00 on Monday, Wednesday"
        );
        assert_eq!(
            to_human(&parse("30 14 28 2 *").unwrap()),
            "at 14:30 on day 28 of February"
        );
        assert_eq!(
            to_human(&parse("0 0 1 1 *").unwrap()),
            "at 00:00 on day 1 of January"
        );
        assert_eq!(to_human(&parse("0 0 * * 7").unwrap()), "at 00:00 on Sunday");
        // detectStep on a partial set matches v2.
        assert_eq!(
            to_human(&parse("0,5,10,15 * * * *").unwrap()),
            "every 5 minutes"
        );
        // A dom wildcard with a pinned time renders "every day" (v2 parity).
        assert_eq!(to_human(&parse("0 0 * * *").unwrap()), "at 00:00 every day");
    }

    #[test]
    fn to_human_falls_back_to_raw() {
        assert_eq!(to_human(&parse("5,10 9 * * *").unwrap()), "5,10 9 * * *");
        assert_eq!(to_human(&parse("0 0 1,15 * *").unwrap()), "0 0 1,15 * *");
        assert_eq!(to_human(&parse("0 0 1 1,6 *").unwrap()), "0 0 1 1,6 *");
    }

    #[test]
    fn validate_prompt_bytes_boundary() {
        assert!(validate_prompt_bytes(&"x".repeat(8192), MAX_PROMPT_BYTES).is_ok());
        assert_eq!(
            validate_prompt_bytes(&"x".repeat(8193), MAX_PROMPT_BYTES)
                .unwrap_err()
                .0,
            "Prompt exceeds 8192 bytes (got 8193)."
        );
        // Multi-byte UTF-8: "你" is 3 bytes.
        assert!(validate_prompt_bytes(&"你".repeat(2730), MAX_PROMPT_BYTES).is_ok());
        assert_eq!(
            validate_prompt_bytes(&"你".repeat(2731), MAX_PROMPT_BYTES)
                .unwrap_err()
                .0,
            "Prompt exceeds 8192 bytes (got 8193)."
        );
    }

    #[test]
    fn validate_one_shot_cap() {
        let p = parse("0 0 1 1 *").unwrap();
        // From 2024-01-01 the next Jan 1 is 366 days out (> 350): refused.
        let err = validate_one_shot(&p, ms_utc(2024, 1, 1, 0, 0), 0).unwrap_err();
        assert!(
            err.0.starts_with(
                "One-shot cron \"0 0 1 1 *\" would not fire until 2025-01-01T00:00:00.000+00:00"
            ),
            "unexpected message: {err}"
        );
        // From 2024-06-01 the next Jan 1 is 214 days out: allowed.
        let first = validate_one_shot(&p, ms_utc(2024, 6, 1, 0, 0), 0).unwrap();
        assert_eq!(first, ms_utc(2025, 1, 1, 0, 0));
        // Never-firing expressions are refused.
        let p = parse("0 0 30 2 *").unwrap();
        assert_eq!(
            validate_one_shot(&p, ms_utc(2024, 6, 1, 0, 0), 0)
                .unwrap_err()
                .0,
            "Cron expression \"0 0 30 2 *\" has no fire within 5 years; refusing to schedule."
        );
    }

    #[test]
    fn format_iso_with_offset() {
        let ms = ms_utc(2024, 6, 1, 6, 30) + 45_123;
        assert_eq!(
            format_local_iso_with_offset(ms, 0),
            "2024-06-01T06:30:45.123+00:00"
        );
        assert_eq!(
            format_local_iso_with_offset(ms, 480),
            "2024-06-01T14:30:45.123+08:00"
        );
        assert_eq!(
            format_local_iso_with_offset(ms, -300),
            "2024-06-01T01:30:45.123-05:00"
        );
    }

    #[test]
    fn civil_roundtrip() {
        for (year, month, day) in [
            (2024, 1, 1),
            (2024, 2, 29),
            (2024, 12, 31),
            (2023, 2, 28),
            (2000, 2, 29),
            (2100, 2, 28),
            (1970, 1, 1),
            (1969, 12, 31),
        ] {
            let days = days_from_civil(year, month, day);
            assert_eq!(civil_from_days(days), (year, month, day));
        }
        // 1970-01-01 was a Thursday.
        assert_eq!(
            weekday(&Civil {
                year: 1970,
                month: 1,
                day: 1,
                hour: 0,
                minute: 0
            }),
            4
        );
        // 2024-06-01 was a Saturday.
        assert_eq!(
            weekday(&Civil {
                year: 2024,
                month: 6,
                day: 1,
                hour: 0,
                minute: 0
            }),
            6
        );
    }
}
