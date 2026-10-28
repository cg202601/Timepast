use super::{now, with_conn, AppError, Db};
use chrono::{Datelike, Duration, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

const SETTINGS_DAY: &str = "performance_cycle_start_day";
const SETTINGS_SUMMARY: &str = "performance_summary_retention_days";
const SETTINGS_MODE: &str = "entry_retention_mode";
const SETTINGS_DAYS: &str = "entry_retention_days";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PerformanceSettings {
    cycle_start_day: i64,
    summary_retention_days: i64,
    entry_retention_mode: String,
    entry_retention_days: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkType {
    id: i64,
    name: String,
    unit: String,
    decimals: i64,
    color: String,
    hourly_target: f64,
    archived: bool,
    event_type_ids: Vec<i64>,
    week_factors: Vec<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkTypeInput {
    id: Option<i64>,
    name: String,
    unit: String,
    decimals: i64,
    color: String,
    hourly_target: f64,
    archived: bool,
    event_type_ids: Vec<i64>,
    week_factors: Vec<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CycleGoal {
    work_type_id: i64,
    cycle_start: String,
    cycle_end: String,
    target: f64,
    hourly_target: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkDay {
    work_type_id: i64,
    date: String,
    output: Option<f64>,
    minutes: i64,
    planned: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkDayOverride { work_type_id: i64, date: String, mode: String, custom_target: Option<f64> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ExpiredCounts { entries: i64, summary_days: i64 }

fn setting(conn: &Connection, key: &str) -> Result<Option<String>, AppError> {
    Ok(conn.query_row("SELECT value FROM app_settings WHERE key = ?1", params![key], |row| row.get(0)).optional()?)
}

fn put_setting(conn: &Connection, key: &str, value: &str) -> Result<(), AppError> {
    conn.execute("INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value])?;
    Ok(())
}

fn parse_day(value: &str) -> Result<NaiveDate, AppError> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| AppError::Invalid("日期格式必须是 YYYY-MM-DD".into()))
}

fn day_string(date: NaiveDate) -> String { date.format("%Y-%m-%d").to_string() }

fn anchor(year: i32, month: u32, requested_day: u32) -> NaiveDate {
    let next = if month == 12 { NaiveDate::from_ymd_opt(year + 1, 1, 1).unwrap() }
        else { NaiveDate::from_ymd_opt(year, month + 1, 1).unwrap() };
    let last = next.pred_opt().unwrap().day();
    NaiveDate::from_ymd_opt(year, month, requested_day.min(last)).unwrap()
}

pub(super) fn cycle_for(date: NaiveDate, start_day: i64) -> (NaiveDate, NaiveDate) {
    let this = anchor(date.year(), date.month(), start_day as u32);
    let start = if date >= this { this } else if date.month() == 1 { anchor(date.year() - 1, 12, start_day as u32) }
        else { anchor(date.year(), date.month() - 1, start_day as u32) };
    let next = if start.month() == 12 { anchor(start.year() + 1, 1, start_day as u32) }
        else { anchor(start.year(), start.month() + 1, start_day as u32) };
    (start, next.pred_opt().unwrap())
}

fn valid_settings(value: &PerformanceSettings) -> Result<(), AppError> {
    if !(1..=31).contains(&value.cycle_start_day) { return Err(AppError::Invalid("周期起始日只能是 1–31 日".into())); }
    if ![31, 90, 180, 365].contains(&value.summary_retention_days) { return Err(AppError::Invalid("汇总保留期只能是 31、90、180 或 365 天".into())); }
    if !(1..=365).contains(&value.entry_retention_days) { return Err(AppError::Invalid("打卡明细保留期只能是 1–365 天".into())); }
    if !["cycle", "custom", "off"].contains(&value.entry_retention_mode.as_str()) { return Err(AppError::Invalid("无效的明细保留方式".into())); }
    Ok(())
}

fn load_settings(conn: &Connection) -> Result<PerformanceSettings, AppError> {
    let value = PerformanceSettings {
        cycle_start_day: setting(conn, SETTINGS_DAY)?.unwrap_or_else(|| "1".into()).parse().map_err(|_| AppError::Invalid("无效的周期起始日".into()))?,
        summary_retention_days: setting(conn, SETTINGS_SUMMARY)?.unwrap_or_else(|| "365".into()).parse().map_err(|_| AppError::Invalid("无效的汇总保留期".into()))?,
        entry_retention_mode: setting(conn, SETTINGS_MODE)?.unwrap_or_else(|| "off".into()),
        entry_retention_days: setting(conn, SETTINGS_DAYS)?.unwrap_or_else(|| "31".into()).parse().map_err(|_| AppError::Invalid("无效的打卡保留期".into()))?,
    };
    valid_settings(&value)?;
    Ok(value)
}

pub(super) fn init_db(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS work_types (id INTEGER PRIMARY KEY, name TEXT NOT NULL, unit TEXT NOT NULL, decimals INTEGER NOT NULL DEFAULT 0, color TEXT NOT NULL, hourly_target REAL NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS work_type_events (work_type_id INTEGER NOT NULL REFERENCES work_types(id) ON DELETE CASCADE, event_type_id INTEGER NOT NULL, PRIMARY KEY(work_type_id, event_type_id));
         CREATE TABLE IF NOT EXISTS work_week_schedule (work_type_id INTEGER NOT NULL REFERENCES work_types(id) ON DELETE CASCADE, weekday INTEGER NOT NULL, factor REAL NOT NULL, PRIMARY KEY(work_type_id, weekday));
         CREATE TABLE IF NOT EXISTS work_cycle_goals (work_type_id INTEGER NOT NULL REFERENCES work_types(id) ON DELETE CASCADE, cycle_start TEXT NOT NULL, cycle_end TEXT NOT NULL, target REAL NOT NULL, hourly_target REAL NOT NULL, PRIMARY KEY(work_type_id, cycle_start));
         CREATE TABLE IF NOT EXISTS work_day_overrides (work_type_id INTEGER NOT NULL REFERENCES work_types(id) ON DELETE CASCADE, day TEXT NOT NULL, mode TEXT NOT NULL, custom_target REAL, PRIMARY KEY(work_type_id, day));
         CREATE TABLE IF NOT EXISTS work_day_plans (work_type_id INTEGER NOT NULL REFERENCES work_types(id) ON DELETE CASCADE, day TEXT NOT NULL, target REAL NOT NULL, PRIMARY KEY(work_type_id, day));
         CREATE TABLE IF NOT EXISTS work_outputs (work_type_id INTEGER NOT NULL REFERENCES work_types(id) ON DELETE CASCADE, day TEXT NOT NULL, quantity REAL NOT NULL, PRIMARY KEY(work_type_id, day));
         CREATE TABLE IF NOT EXISTS work_time_days (work_type_id INTEGER NOT NULL REFERENCES work_types(id) ON DELETE CASCADE, day TEXT NOT NULL, archived_minutes INTEGER NOT NULL DEFAULT 0, live_minutes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(work_type_id, day));
         CREATE INDEX IF NOT EXISTS idx_work_outputs_day ON work_outputs(day);
         CREATE INDEX IF NOT EXISTS idx_work_time_days_day ON work_time_days(day);
         CREATE INDEX IF NOT EXISTS idx_work_day_plans_day ON work_day_plans(day);"
    )?;
    if setting(conn, SETTINGS_MODE)?.is_none() {
        let legacy = setting(conn, SETTINGS_DAYS)?;
        let entries: i64 = conn.query_row("SELECT COUNT(*) FROM time_entries", [], |row| row.get(0))?;
        let mode = match legacy.as_deref() {
            Some("30") => "cycle",
            Some(_) => "custom",
            None if entries == 0 => "cycle",
            None => "off",
        };
        put_setting(conn, SETTINGS_MODE, mode)?;
    }
    if setting(conn, SETTINGS_DAYS)?.is_none() { put_setting(conn, SETTINGS_DAYS, "31")?; }
    if setting(conn, SETTINGS_DAY)?.is_none() { put_setting(conn, SETTINGS_DAY, "1")?; }
    if setting(conn, SETTINGS_SUMMARY)?.is_none() { put_setting(conn, SETTINGS_SUMMARY, "365")?; }
    load_settings(conn)?;
    Ok(())
}

pub(super) fn entry_cutoff(conn: &Connection) -> Result<Option<String>, AppError> {
    let settings = load_settings(conn)?;
    let today = chrono::Local::now().date_naive();
    let cutoff = match settings.entry_retention_mode.as_str() {
        "cycle" => Some(cycle_for(today, settings.cycle_start_day).0),
        "custom" => Some(today - Duration::days(settings.entry_retention_days - 1)),
        _ => None,
    };
    Ok(cutoff.map(day_string))
}

fn summary_cutoff(settings: &PerformanceSettings) -> String {
    day_string(chrono::Local::now().date_naive() - Duration::days(settings.summary_retention_days - 1))
}

pub(super) fn purge_summaries(conn: &Connection) -> Result<(), AppError> {
    let cutoff = summary_cutoff(&load_settings(conn)?);
    for table in ["work_outputs", "work_time_days", "work_day_plans", "work_day_overrides"] {
        conn.execute(&format!("DELETE FROM {table} WHERE day < ?1"), params![cutoff])?;
    }
    Ok(())
}

fn split_entry(day: &str, start: &str, end: &str) -> Result<Vec<(String, i64)>, AppError> {
    let date = parse_day(day)?;
    let parse_minutes = |time: &str| -> Result<i64, AppError> {
        let parts: Vec<_> = time.split(':').collect();
        if parts.len() != 2 { return Err(AppError::Invalid("无效的打卡时间".into())); }
        let hours: i64 = parts[0].parse().map_err(|_| AppError::Invalid("无效的打卡时间".into()))?;
        let minutes: i64 = parts[1].parse().map_err(|_| AppError::Invalid("无效的打卡时间".into()))?;
        Ok(hours * 60 + minutes)
    };
    let from = parse_minutes(start)?;
    let mut to = parse_minutes(end)?;
    if to < from { to += 1440; }
    if to <= 1440 { Ok(vec![(day.into(), to - from)]) }
    else { Ok(vec![(day.into(), 1440 - from), (day_string(date.succ_opt().unwrap()), to - 1440)]) }
}

fn event_work_types(conn: &Connection) -> Result<HashMap<i64, Vec<i64>>, AppError> {
    let mut result: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut stmt = conn.prepare("SELECT work_type_id, event_type_id FROM work_type_events")?;
    for row in stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))? {
        let (work, event) = row?;
        result.entry(event).or_default().push(work);
    }
    Ok(result)
}

pub(super) fn refresh_live_minutes(conn: &Connection) -> Result<(), AppError> {
    conn.execute("UPDATE work_time_days SET live_minutes = 0", [])?;
    let mapping = event_work_types(conn)?;
    let mut stmt = conn.prepare("SELECT entry_date, start_time, end_time, event_type_id FROM time_entries")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?)))?;
    for row in rows {
        let (day, start, end, event) = row?;
        if let Some(types) = mapping.get(&event) {
            for (date, minutes) in split_entry(&day, &start, &end)? {
                for work in types {
                    conn.execute("INSERT INTO work_time_days (work_type_id, day, live_minutes) VALUES (?1, ?2, ?3) ON CONFLICT(work_type_id, day) DO UPDATE SET live_minutes = live_minutes + excluded.live_minutes", params![work, date, minutes])?;
                }
            }
        }
    }
    Ok(())
}

fn purge_entries_inner(conn: &Connection) -> Result<usize, AppError> {
    let Some(cutoff) = entry_cutoff(conn)? else { return Ok(0); };
    let mapping = event_work_types(conn)?;
    let mut stmt = conn.prepare("SELECT entry_date, start_time, end_time, event_type_id FROM time_entries WHERE entry_date < ?1")?;
    let rows = stmt.query_map(params![cutoff], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?)))?;
    for row in rows {
        let (day, start, end, event) = row?;
        if let Some(types) = mapping.get(&event) {
            for (date, minutes) in split_entry(&day, &start, &end)? {
                for work in types {
                    conn.execute("INSERT INTO work_time_days (work_type_id, day, archived_minutes) VALUES (?1, ?2, ?3) ON CONFLICT(work_type_id, day) DO UPDATE SET archived_minutes = archived_minutes + excluded.archived_minutes", params![work, date, minutes])?;
                }
            }
        }
    }
    drop(stmt);
    let deleted = conn.execute("DELETE FROM time_entries WHERE entry_date < ?1", params![cutoff])?;
    if deleted > 0 { refresh_live_minutes(conn)?; }
    purge_summaries(conn)?;
    Ok(deleted)
}

pub(super) fn purge_entries(conn: &Connection) -> Result<usize, AppError> {
    let tx = conn.unchecked_transaction()?;
    let deleted = purge_entries_inner(&tx)?;
    tx.commit()?;
    Ok(deleted)
}

fn work_type(conn: &Connection, id: i64) -> Result<WorkType, AppError> {
    let mut item = conn.query_row(
        "SELECT id, name, unit, decimals, color, hourly_target, archived FROM work_types WHERE id = ?1",
        params![id],
        |row| Ok(WorkType { id: row.get(0)?, name: row.get(1)?, unit: row.get(2)?, decimals: row.get(3)?, color: row.get(4)?, hourly_target: row.get(5)?, archived: row.get(6)?, event_type_ids: Vec::new(), week_factors: vec![1.0; 7] }),
    ).optional()?.ok_or_else(|| AppError::Invalid("工作类型不存在".into()))?;
    let mut stmt = conn.prepare("SELECT event_type_id FROM work_type_events WHERE work_type_id = ?1 ORDER BY event_type_id")?;
    item.event_type_ids = stmt.query_map(params![id], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()?;
    let mut stmt = conn.prepare("SELECT weekday, factor FROM work_week_schedule WHERE work_type_id = ?1")?;
    for row in stmt.query_map(params![id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?)))? {
        let (weekday, factor) = row?;
        if (0..7).contains(&weekday) { item.week_factors[weekday as usize] = factor; }
    }
    Ok(item)
}

#[tauri::command]
pub(super) fn list_work_types(db: State<Db>) -> Result<Vec<WorkType>, AppError> {
    with_conn(&db, |conn| {
        let mut stmt = conn.prepare("SELECT id FROM work_types ORDER BY archived, id")?;
        let ids = stmt.query_map([], |row| row.get::<_, i64>(0))?.collect::<Result<Vec<_>, _>>()?;
        ids.into_iter().map(|id| work_type(conn, id)).collect()
    })
}

fn valid_quantity(value: f64, decimals: i64) -> bool {
    if !value.is_finite() || value < 0.0 { return false; }
    let scale = 10f64.powi(decimals as i32);
    ((value * scale).round() - value * scale).abs() < 0.00001
}

#[tauri::command]
pub(super) fn save_work_type(db: State<Db>, item: WorkTypeInput) -> Result<i64, AppError> {
    if item.name.trim().is_empty() || item.unit.trim().is_empty() || item.name.chars().count() > 40 || item.unit.chars().count() > 12 {
        return Err(AppError::Invalid("请填写工作名称和单位，名称最多40字，单位最多12字".into()));
    }
    if !(0..=2).contains(&item.decimals) || !item.hourly_target.is_finite() || item.hourly_target <= 0.0 {
        return Err(AppError::Invalid("每小时基准必须大于0，小数位为0至2位".into()));
    }
    if item.week_factors.len() != 7 || item.week_factors.iter().any(|factor| ![0.0, 0.5, 1.0].contains(factor)) {
        return Err(AppError::Invalid("请设置周一至周日的正常、半天或休息安排".into()));
    }
    with_conn(&db, |conn| {
        let tx = conn.unchecked_transaction()?;
        let id = if let Some(id) = item.id.filter(|id| *id > 0) {
            let old: Option<(String, i64)> = tx.query_row("SELECT unit, decimals FROM work_types WHERE id = ?1", params![id], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
            let (old_unit, old_decimals) = old.ok_or_else(|| AppError::Invalid("工作类型不存在".into()))?;
            if old_unit != item.unit || old_decimals != item.decimals {
                let count: i64 = tx.query_row("SELECT COUNT(*) FROM work_outputs WHERE work_type_id = ?1", params![id], |row| row.get(0))?;
                if count > 0 { return Err(AppError::Invalid("已有产出记录的单位和小数位不能修改；请另建工作类型".into())); }
            }
            tx.execute("UPDATE work_types SET name = ?1, unit = ?2, decimals = ?3, color = ?4, hourly_target = ?5, archived = ?6 WHERE id = ?7", params![item.name.trim(), item.unit.trim(), item.decimals, item.color, item.hourly_target, item.archived, id])?;
            id
        } else {
            tx.execute("INSERT INTO work_types (name, unit, decimals, color, hourly_target, archived, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", params![item.name.trim(), item.unit.trim(), item.decimals, item.color, item.hourly_target, item.archived, now()])?;
            tx.last_insert_rowid()
        };
        tx.execute("DELETE FROM work_type_events WHERE work_type_id = ?1", params![id])?;
        for event in &item.event_type_ids {
            let exists: i64 = tx.query_row("SELECT COUNT(*) FROM event_types WHERE id = ?1", params![event], |row| row.get(0))?;
            if exists == 0 { return Err(AppError::Invalid("关联的事件分类不存在".into())); }
            tx.execute("INSERT OR IGNORE INTO work_type_events (work_type_id, event_type_id) VALUES (?1, ?2)", params![id, event])?;
        }
        tx.execute("DELETE FROM work_week_schedule WHERE work_type_id = ?1", params![id])?;
        for (weekday, factor) in item.week_factors.iter().enumerate() {
            tx.execute("INSERT INTO work_week_schedule (work_type_id, weekday, factor) VALUES (?1, ?2, ?3)", params![id, weekday as i64, factor])?;
        }
        refresh_live_minutes(&tx)?;
        let mut stmt = tx.prepare("SELECT cycle_start FROM work_cycle_goals WHERE work_type_id = ?1 AND cycle_end >= date('now','localtime')")?;
        let starts = stmt.query_map(params![id], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        for start in starts { allocate_plan(&tx, id, &start)?; }
        tx.commit()?;
        Ok(id)
    })
}

fn goal_for_day(conn: &Connection, work_type_id: i64, date: &str) -> Result<Option<CycleGoal>, AppError> {
    Ok(conn.query_row(
        "SELECT work_type_id, cycle_start, cycle_end, target, hourly_target FROM work_cycle_goals WHERE work_type_id = ?1 AND cycle_start <= ?2 AND cycle_end >= ?2 ORDER BY cycle_start DESC LIMIT 1",
        params![work_type_id, date],
        |row| Ok(CycleGoal { work_type_id: row.get(0)?, cycle_start: row.get(1)?, cycle_end: row.get(2)?, target: row.get(3)?, hourly_target: row.get(4)? }),
    ).optional()?)
}

fn allocate_plan(conn: &Connection, work_type_id: i64, start: &str) -> Result<(), AppError> {
    let goal: CycleGoal = conn.query_row("SELECT work_type_id, cycle_start, cycle_end, target, hourly_target FROM work_cycle_goals WHERE work_type_id = ?1 AND cycle_start = ?2", params![work_type_id, start], |row| Ok(CycleGoal { work_type_id: row.get(0)?, cycle_start: row.get(1)?, cycle_end: row.get(2)?, target: row.get(3)?, hourly_target: row.get(4)? }))?;
    let item = work_type(conn, work_type_id)?;
    let mut existing = HashMap::new();
    let mut stmt = conn.prepare("SELECT day, target FROM work_day_plans WHERE work_type_id = ?1 AND day BETWEEN ?2 AND ?3")?;
    for row in stmt.query_map(params![work_type_id, goal.cycle_start, goal.cycle_end], |row| Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?)))? {
        let (day, target) = row?;
        existing.insert(day, target);
    }
    drop(stmt);
    let mut overrides: HashMap<String, (String, Option<f64>)> = HashMap::new();
    let mut stmt = conn.prepare("SELECT day, mode, custom_target FROM work_day_overrides WHERE work_type_id = ?1 AND day BETWEEN ?2 AND ?3")?;
    for row in stmt.query_map(params![work_type_id, goal.cycle_start, goal.cycle_end], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<f64>>(2)?)))? {
        let (day, mode, value) = row?;
        overrides.insert(day, (mode, value));
    }
    drop(stmt);
    let today = chrono::Local::now().date_naive();
    let mut date = parse_day(&goal.cycle_start)?;
    let end = parse_day(&goal.cycle_end)?;
    let mut locked = 0.0;
    let mut candidates: Vec<(String, f64)> = Vec::new();
    let mut fixed: Vec<(String, f64)> = Vec::new();
    while date <= end {
        let key = day_string(date);
        let override_value = overrides.get(&key);
        if let Some((mode, value)) = override_value {
            if mode == "custom" {
                let amount = value.unwrap_or(0.0);
                locked += amount;
                fixed.push((key, amount));
                date = date.succ_opt().unwrap();
                continue;
            }
        }
        if date < today {
            if let Some(value) = existing.get(&key) {
                locked += value;
                fixed.push((key, *value));
                date = date.succ_opt().unwrap();
                continue;
            }
        }
        let weekday = date.weekday().num_days_from_monday() as usize;
        let factor = match override_value.map(|(mode, _)| mode.as_str()) {
            Some("normal") => 1.0,
            Some("half") => 0.5,
            Some("rest") => 0.0,
            _ => item.week_factors[weekday],
        };
        if factor > 0.0 { candidates.push((key, factor)); }
        date = date.succ_opt().unwrap();
    }
    // Daily pace may be fractional even when completed items must be whole numbers.
    let scale = 100.0;
    let total_units = (goal.target * scale).round() as i64;
    let locked_units = (locked * scale).round() as i64;
    if locked_units > total_units { return Err(AppError::Invalid("月目标小于已锁定的过去或自定义日目标".into())); }
    let remaining = total_units - locked_units;
    let weight_sum: f64 = candidates.iter().map(|(_, weight)| weight).sum();
    if remaining > 0 && weight_sum == 0.0 { return Err(AppError::Invalid("此周期没有可分配目标的工作日".into())); }
    let mut allocations: Vec<(String, i64, f64)> = candidates.iter().map(|(day, weight)| {
        let exact = if weight_sum > 0.0 { remaining as f64 * weight / weight_sum } else { 0.0 };
        (day.clone(), exact.floor() as i64, exact.fract())
    }).collect();
    let assigned: i64 = allocations.iter().map(|(_, units, _)| *units).sum();
    let mut order: Vec<usize> = (0..allocations.len()).collect();
    order.sort_by(|left, right| allocations[*right].2.total_cmp(&allocations[*left].2).then(left.cmp(right)));
    for index in order.into_iter().take((remaining - assigned) as usize) { allocations[index].1 += 1; }
    conn.execute("DELETE FROM work_day_plans WHERE work_type_id = ?1 AND day BETWEEN ?2 AND ?3", params![work_type_id, goal.cycle_start, goal.cycle_end])?;
    for (day, value) in fixed { conn.execute("INSERT INTO work_day_plans (work_type_id, day, target) VALUES (?1, ?2, ?3)", params![work_type_id, day, value])?; }
    for (day, units, _) in allocations { conn.execute("INSERT INTO work_day_plans (work_type_id, day, target) VALUES (?1, ?2, ?3)", params![work_type_id, day, units as f64 / scale])?; }
    Ok(())
}

#[tauri::command]
pub(super) fn get_performance_settings(db: State<Db>) -> Result<PerformanceSettings, AppError> {
    with_conn(&db, load_settings)
}

fn proposed_cutoff(settings: &PerformanceSettings) -> Option<String> {
    let today = chrono::Local::now().date_naive();
    match settings.entry_retention_mode.as_str() {
        "cycle" => Some(day_string(cycle_for(today, settings.cycle_start_day).0)),
        "custom" => Some(day_string(today - Duration::days(settings.entry_retention_days - 1))),
        _ => None,
    }
}

fn expired_counts(conn: &Connection, settings: &PerformanceSettings) -> Result<ExpiredCounts, AppError> {
    let entries = if let Some(cutoff) = proposed_cutoff(settings) {
        conn.query_row("SELECT COUNT(*) FROM time_entries WHERE entry_date < ?1", params![cutoff], |row| row.get(0))?
    } else { 0 };
    let cutoff = summary_cutoff(settings);
    let summary_days = conn.query_row(
        "SELECT COUNT(*) FROM (SELECT day FROM work_outputs WHERE day < ?1 UNION SELECT day FROM work_time_days WHERE day < ?1)",
        params![cutoff], |row| row.get(0)
    )?;
    Ok(ExpiredCounts { entries, summary_days })
}

#[tauri::command]
pub(super) fn preview_performance_retention(db: State<Db>, settings: PerformanceSettings) -> Result<ExpiredCounts, AppError> {
    valid_settings(&settings)?;
    with_conn(&db, |conn| expired_counts(conn, &settings))
}

#[tauri::command]
pub(super) fn save_performance_settings(db: State<Db>, settings: PerformanceSettings) -> Result<ExpiredCounts, AppError> {
    valid_settings(&settings)?;
    if settings.entry_retention_mode == "off" { return Err(AppError::Invalid("请选择完整周期或自定义天数".into())); }
    with_conn(&db, |conn| {
        let counts = expired_counts(conn, &settings)?;
        let tx = conn.unchecked_transaction()?;
        put_setting(&tx, SETTINGS_DAY, &settings.cycle_start_day.to_string())?;
        put_setting(&tx, SETTINGS_SUMMARY, &settings.summary_retention_days.to_string())?;
        put_setting(&tx, SETTINGS_MODE, &settings.entry_retention_mode)?;
        put_setting(&tx, SETTINGS_DAYS, &settings.entry_retention_days.to_string())?;
        purge_entries_inner(&tx)?;
        tx.commit()?;
        Ok(counts)
    })
}

#[tauri::command]
pub(super) fn list_cycle_goals(db: State<Db>, from: String, to: String) -> Result<Vec<CycleGoal>, AppError> {
    let from_day = parse_day(&from)?;
    let to_day = parse_day(&to)?;
    if to_day < from_day || (to_day - from_day).num_days() > 800 { return Err(AppError::Invalid("查询日期范围无效".into())); }
    with_conn(&db, |conn| {
        let mut stmt = conn.prepare("SELECT work_type_id, cycle_start, cycle_end, target, hourly_target FROM work_cycle_goals WHERE cycle_start <= ?2 AND cycle_end >= ?1 ORDER BY cycle_start, work_type_id")?;
        let rows = stmt.query_map(params![from, to], |row| Ok(CycleGoal { work_type_id: row.get(0)?, cycle_start: row.get(1)?, cycle_end: row.get(2)?, target: row.get(3)?, hourly_target: row.get(4)? }))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::Db)
    })
}

#[tauri::command]
pub(super) fn save_cycle_goal(db: State<Db>, work_type_id: i64, anchor_date: String, target: f64) -> Result<CycleGoal, AppError> {
    let date = parse_day(&anchor_date)?;
    with_conn(&db, |conn| {
        let item = work_type(conn, work_type_id)?;
        if !valid_quantity(target, item.decimals) || target <= 0.0 { return Err(AppError::Invalid("周期目标必须大于0，并符合工作类型的小数位".into())); }
        let settings = load_settings(conn)?;
        let (start, end) = cycle_for(date, settings.cycle_start_day);
        let start_str = day_string(start);
        let end_str = day_string(end);
        let overlapping: i64 = conn.query_row("SELECT COUNT(*) FROM work_cycle_goals WHERE work_type_id = ?1 AND cycle_start < ?3 AND cycle_end > ?2 AND cycle_start != ?2", params![work_type_id, start_str, end_str], |row| row.get(0))?;
        if overlapping > 0 { return Err(AppError::Invalid("新周期与已有目标重叠，请选择未配置的周期".into())); }
        let tx = conn.unchecked_transaction()?;
        tx.execute("INSERT INTO work_cycle_goals (work_type_id, cycle_start, cycle_end, target, hourly_target) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(work_type_id, cycle_start) DO UPDATE SET target = excluded.target, hourly_target = excluded.hourly_target", params![work_type_id, start_str, end_str, target, item.hourly_target])?;
        allocate_plan(&tx, work_type_id, &start_str)?;
        tx.commit()?;
        Ok(CycleGoal { work_type_id, cycle_start: start_str, cycle_end: end_str, target, hourly_target: item.hourly_target })
    })
}

#[tauri::command]
pub(super) fn save_work_output(db: State<Db>, work_type_id: i64, date: String, quantity: f64) -> Result<(), AppError> {
    let day = parse_day(&date)?;
    if day > chrono::Local::now().date_naive() { return Err(AppError::Invalid("不能提前填写未来日期的完成量".into())); }
    with_conn(&db, |conn| {
        let item = work_type(conn, work_type_id)?;
        if !valid_quantity(quantity, item.decimals) { return Err(AppError::Invalid("完成量不能为负数，且必须符合小数位".into())); }
        if day_string(day) < summary_cutoff(&load_settings(conn)?) { return Err(AppError::Invalid("日期已超出工作量汇总保留期".into())); }
        conn.execute("INSERT INTO work_outputs (work_type_id, day, quantity) VALUES (?1, ?2, ?3) ON CONFLICT(work_type_id, day) DO UPDATE SET quantity = excluded.quantity", params![work_type_id, date, quantity])?;
        Ok(())
    })
}

#[tauri::command]
pub(super) fn delete_work_output(db: State<Db>, work_type_id: i64, date: String) -> Result<(), AppError> {
    parse_day(&date)?;
    with_conn(&db, |conn| {
        conn.execute("DELETE FROM work_outputs WHERE work_type_id = ?1 AND day = ?2", params![work_type_id, date])?;
        Ok(())
    })
}

#[tauri::command]
pub(super) fn list_work_day_overrides(db: State<Db>, from: String, to: String) -> Result<Vec<WorkDayOverride>, AppError> {
    let from_day = parse_day(&from)?;
    let to_day = parse_day(&to)?;
    if to_day < from_day || (to_day - from_day).num_days() > 800 { return Err(AppError::Invalid("查询日期范围无效".into())); }
    with_conn(&db, |conn| {
        let mut stmt = conn.prepare("SELECT work_type_id, day, mode, custom_target FROM work_day_overrides WHERE day BETWEEN ?1 AND ?2")?;
        let rows = stmt.query_map(params![from, to], |row| Ok(WorkDayOverride { work_type_id: row.get(0)?, date: row.get(1)?, mode: row.get(2)?, custom_target: row.get(3)? }))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::Db)
    })
}

#[tauri::command]
pub(super) fn set_work_day_override(db: State<Db>, work_type_id: i64, date: String, mode: String, custom_target: Option<f64>) -> Result<(), AppError> {
    parse_day(&date)?;
    if !["normal", "half", "rest", "custom", "default"].contains(&mode.as_str()) { return Err(AppError::Invalid("无效的单日安排".into())); }
    with_conn(&db, |conn| {
        let item = work_type(conn, work_type_id)?;
        if mode == "custom" && !custom_target.is_some_and(|value| valid_quantity(value, item.decimals)) {
            return Err(AppError::Invalid("自定义日目标必须符合工作类型的小数位".into()));
        }
        let tx = conn.unchecked_transaction()?;
        if mode == "default" { tx.execute("DELETE FROM work_day_overrides WHERE work_type_id = ?1 AND day = ?2", params![work_type_id, date])?; }
        else { tx.execute("INSERT INTO work_day_overrides (work_type_id, day, mode, custom_target) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(work_type_id, day) DO UPDATE SET mode = excluded.mode, custom_target = excluded.custom_target", params![work_type_id, date, mode, if mode == "custom" { custom_target } else { None }])?; }
        tx.execute("DELETE FROM work_day_plans WHERE work_type_id = ?1 AND day = ?2", params![work_type_id, date])?;
        if let Some(goal) = goal_for_day(&tx, work_type_id, &date)? { allocate_plan(&tx, work_type_id, &goal.cycle_start)?; }
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub(super) fn list_work_days(db: State<Db>, from: String, to: String) -> Result<Vec<WorkDay>, AppError> {
    let from_day = parse_day(&from)?;
    let to_day = parse_day(&to)?;
    if to_day < from_day || (to_day - from_day).num_days() > 800 { return Err(AppError::Invalid("查询日期范围无效".into())); }
    with_conn(&db, |conn| {
        let mut days: HashMap<(i64, String), WorkDay> = HashMap::new();
        let mut stmt = conn.prepare("SELECT work_type_id, day, quantity FROM work_outputs WHERE day BETWEEN ?1 AND ?2")?;
        for row in stmt.query_map(params![from, to], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, f64>(2)?)))? {
            let (id, date, value) = row?;
            days.entry((id, date.clone())).or_insert_with(|| WorkDay { work_type_id: id, date, output: None, minutes: 0, planned: None }).output = Some(value);
        }
        drop(stmt);
        let mut stmt = conn.prepare("SELECT work_type_id, day, archived_minutes + live_minutes FROM work_time_days WHERE day BETWEEN ?1 AND ?2")?;
        for row in stmt.query_map(params![from, to], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)))? {
            let (id, date, value) = row?;
            days.entry((id, date.clone())).or_insert_with(|| WorkDay { work_type_id: id, date, output: None, minutes: 0, planned: None }).minutes = value;
        }
        drop(stmt);
        let mut stmt = conn.prepare("SELECT work_type_id, day, target FROM work_day_plans WHERE day BETWEEN ?1 AND ?2")?;
        for row in stmt.query_map(params![from, to], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, f64>(2)?)))? {
            let (id, date, value) = row?;
            days.entry((id, date.clone())).or_insert_with(|| WorkDay { work_type_id: id, date, output: None, minutes: 0, planned: None }).planned = Some(value);
        }
        let mut result: Vec<_> = days.into_values().collect();
        result.sort_by(|a, b| a.date.cmp(&b.date).then(a.work_type_id.cmp(&b.work_type_id)));
        Ok(result)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::init_db(&conn).unwrap();
        conn
    }

    #[test]
    fn cycles_cover_short_long_and_leap_months() {
        let period = |day, start| {
            let (from, to) = cycle_for(parse_day(day).unwrap(), start);
            (day_string(from), day_string(to))
        };
        assert_eq!(period("2026-10-09", 10), ("2026-09-10".into(), "2026-10-09".into()));
        assert_eq!(period("2026-10-10", 10), ("2026-10-10".into(), "2026-11-09".into()));
        assert_eq!(period("2026-02-28", 31), ("2026-02-28".into(), "2026-03-30".into()));
        assert_eq!(period("2028-02-29", 31), ("2028-02-29".into(), "2028-03-30".into()));
        assert_eq!(period("2026-09-30", 1), ("2026-09-01".into(), "2026-09-30".into()));
        assert_eq!(period("2026-10-31", 1), ("2026-10-01".into(), "2026-10-31".into()));
    }

    #[test]
    fn old_thirty_day_setting_becomes_complete_cycle() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO app_settings VALUES ('entry_retention_days', '30');").unwrap();
        crate::init_db(&conn).unwrap();
        assert_eq!(setting(&conn, SETTINGS_MODE).unwrap().as_deref(), Some("cycle"));
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO app_settings VALUES ('entry_retention_days', '15');").unwrap();
        crate::init_db(&conn).unwrap();
        assert_eq!(setting(&conn, SETTINGS_MODE).unwrap().as_deref(), Some("custom"));
    }

    #[test]
    fn changing_rest_days_keeps_cycle_total_exact() {
        let conn = database();
        conn.execute("INSERT INTO work_types (id, name, unit, decimals, color, hourly_target, created_at) VALUES (1, '美工', '张', 0, '#2563eb', 2, 'now')", []).unwrap();
        for weekday in 0..7 { conn.execute("INSERT INTO work_week_schedule VALUES (1, ?1, ?2)", params![weekday, if weekday == 5 { 0.5 } else if weekday == 6 { 0.0 } else { 1.0 }]).unwrap(); }
        let future = chrono::Local::now().date_naive() + Duration::days(90);
        let (start, end) = cycle_for(future, 10);
        let start = day_string(start);
        let end = day_string(end);
        conn.execute("INSERT INTO work_cycle_goals VALUES (1, ?1, ?2, 100, 2)", params![start, end]).unwrap();
        allocate_plan(&conn, 1, &start).unwrap();
        let total: f64 = conn.query_row("SELECT SUM(target) FROM work_day_plans WHERE work_type_id = 1", [], |row| row.get(0)).unwrap();
        assert!((total - 100.0).abs() < 0.00001);
        conn.execute("INSERT INTO work_day_overrides VALUES (1, ?1, 'rest', NULL)", params![start]).unwrap();
        allocate_plan(&conn, 1, &start).unwrap();
        let total: f64 = conn.query_row("SELECT SUM(target) FROM work_day_plans WHERE work_type_id = 1", [], |row| row.get(0)).unwrap();
        assert!((total - 100.0).abs() < 0.00001);
        let first: i64 = conn.query_row("SELECT COUNT(*) FROM work_day_plans WHERE work_type_id = 1 AND day = ?1", params![start], |row| row.get(0)).unwrap();
        assert_eq!(first, 0);
    }

    #[test]
    fn expired_overnight_entry_keeps_both_daily_time_summaries() {
        let conn = database();
        conn.execute("INSERT INTO work_types (id, name, unit, decimals, color, hourly_target, created_at) VALUES (1, '剪辑', '分钟', 0, '#2563eb', 5, 'now')", []).unwrap();
        conn.execute("INSERT INTO work_type_events VALUES (1, 1)", []).unwrap();
        let date = chrono::Local::now().date_naive() - Duration::days(5);
        conn.execute("INSERT INTO time_entries (entry_date, start_time, end_time, event_type_id, note, source_mode, created_at) VALUES (?1, '23:30', '00:30', 1, '', 'timer', 'now')", params![day_string(date)]).unwrap();
        refresh_live_minutes(&conn).unwrap();
        put_setting(&conn, SETTINGS_MODE, "custom").unwrap();
        put_setting(&conn, SETTINGS_DAYS, "1").unwrap();
        assert_eq!(purge_entries(&conn).unwrap(), 1);
        for day in [date, date.succ_opt().unwrap()] {
            let minutes: i64 = conn.query_row("SELECT archived_minutes + live_minutes FROM work_time_days WHERE work_type_id = 1 AND day = ?1", params![day_string(day)], |row| row.get(0)).unwrap();
            assert_eq!(minutes, 30);
        }
    }
}
