use chrono::{Local, NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Emitter, Listener, LogicalSize, Manager, PhysicalPosition,
    Position, Size, State, WindowEvent,
};
use thiserror::Error;


#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
struct WindowGeometry { x: i32, y: i32, width: u32, height: u32 }

#[derive(Debug, Error)]
enum AppError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid input: {0}")]
    Invalid(String),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where S: serde::Serializer,
    { serializer.serialize_str(&self.to_string()) }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EventType { id: i64, name: String, color: String, sort_order: i64, pinned: bool, archived: bool }

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimeEntry { id: i64, entry_date: String, start_time: String, end_time: String, event_type_id: i64, event_name: String, event_color: String, note: String, source_mode: String, created_at: String }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimeEntryInput { id: Option<i64>, entry_date: String, start_time: String, end_time: String, event_type_id: i64, note: String, source_mode: String }

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Note { id: i64, content: String, color: String, x: i64, y: i64, width: i64, height: i64, collapsed: bool, pinned: bool, font_size: i64, style_json: String, created_at: String, updated_at: String }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteInput { id: Option<i64>, content: String, color: String, x: i64, y: i64, width: i64, height: i64, collapsed: bool, pinned: bool, font_size: i64, style_json: String }
type Db = Arc<Mutex<Connection>>;

fn db_path(app: &tauri::App) -> Result<PathBuf, AppError> {
    let dir = app.path().app_data_dir().map_err(|e| AppError::Invalid(e.to_string()))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("timepast.sqlite"))
}

fn init_db(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS event_types (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            color TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            pinned INTEGER NOT NULL DEFAULT 0,
            archived INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS time_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_date TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL,
            event_type_id INTEGER NOT NULL,
            note TEXT NOT NULL DEFAULT '',
            source_mode TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(event_type_id) REFERENCES event_types(id)
        );
        CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            color TEXT NOT NULL,
            x INTEGER NOT NULL,
            y INTEGER NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            collapsed INTEGER NOT NULL DEFAULT 0,
            pinned INTEGER NOT NULL DEFAULT 0,
            font_size INTEGER NOT NULL DEFAULT 15,
            style_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )?;

    // Existing users must choose a retention period before old records are removed.
    // A fresh database starts with the longest supported period.
    if retention_days(conn)?.is_none() {
        let existing_entries: i64 = conn.query_row("SELECT COUNT(*) FROM time_entries", [], |row| row.get(0))?;
        if existing_entries == 0 {
            conn.execute("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('entry_retention_days', '30')", [])?;
        }
    }
    purge_expired_entries(conn)?;

    merge_legacy_overnight_entries(conn)?;

    let count: i64 = conn.query_row("SELECT COUNT(*) FROM event_types", [], |row| row.get(0))?;
    if count == 0 {
        let defaults = [
            ("深度工作", "#3b82f6", 1, 1),
            ("学习", "#10b981", 2, 1),
            ("会议", "#f59e0b", 3, 1),
            ("杂事", "#8b5cf6", 4, 0),
        ];
        for (name, color, sort_order, pinned) in defaults {
            conn.execute(
                "INSERT INTO event_types (name, color, sort_order, pinned) VALUES (?1, ?2, ?3, ?4)",
                params![name, color, sort_order, pinned],
            )?;
        }
    }
    Ok(())
}

fn merge_legacy_overnight_entries(conn: &Connection) -> Result<(), AppError> {
    let pairs = {
        let mut stmt = conn.prepare(
            r#"
            SELECT previous.id, following.id, following.end_time
            FROM time_entries AS previous
            JOIN time_entries AS following
              ON following.entry_date = date(previous.entry_date, '+1 day')
             AND following.event_type_id = previous.event_type_id
             AND following.note = previous.note
             AND following.source_mode = 'timer'
             AND following.start_time = '00:00'
            WHERE previous.source_mode = 'timer'
              AND previous.end_time = '23:59'
            ORDER BY previous.id, following.id
            "#,
        )?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };

    for (previous_id, following_id, end_time) in pairs {
        let merged = conn.execute(
            "UPDATE time_entries SET end_time = ?1 WHERE id = ?2 AND end_time = '23:59'",
            params![end_time, previous_id],
        )?;
        if merged == 1 {
            conn.execute("DELETE FROM time_entries WHERE id = ?1", params![following_id])?;
        }
    }
    Ok(())
}
fn now() -> String {
    Utc::now().to_rfc3339()
}

fn bool_i(value: bool) -> i64 {
    if value { 1 } else { 0 }
}

fn parse_time(value: &str) -> Result<(u8, u8), AppError> {
    if value.len() != 5 || !value.is_char_boundary(2) || &value[2..3] != ":" {
        return Err(AppError::Invalid("time must use HH:MM".to_string()));
    }
    let hour = value[..2].parse::<u8>().map_err(|_| AppError::Invalid("invalid hour".to_string()))?;
    let minute = value[3..].parse::<u8>().map_err(|_| AppError::Invalid("invalid minute".to_string()))?;
    if hour > 23 || minute > 59 {
        return Err(AppError::Invalid("time is out of range".to_string()));
    }
    Ok((hour, minute))
}

fn normalize_entry_date(value: &str) -> Result<String, AppError> {
    let normalized = value.trim().replace('/', "-");
    let date = NaiveDate::parse_from_str(&normalized, "%Y-%m-%d")
        .map_err(|_| AppError::Invalid("entry date must use YYYY-MM-DD".to_string()))?;
    Ok(date.format("%Y-%m-%d").to_string())
}

fn validate_retention_days(days: i64) -> Result<(), AppError> {
    if matches!(days, 7 | 15 | 25 | 30) { Ok(()) }
    else { Err(AppError::Invalid("retention must be 7, 15, 25, or 30 days".into())) }
}

fn retention_cutoff_on(today: NaiveDate, days: i64) -> Result<String, AppError> {
    validate_retention_days(days)?;
    Ok((today - chrono::Duration::days(days - 1)).format("%Y-%m-%d").to_string())
}

fn retention_cutoff(days: i64) -> Result<String, AppError> {
    retention_cutoff_on(Local::now().date_naive(), days)
}

fn retention_days(conn: &Connection) -> Result<Option<i64>, AppError> {
    let stored: Option<String> = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'entry_retention_days'", [], |row| row.get(0)
    ).optional()?;
    stored.map(|value| {
        let days = value.parse::<i64>().map_err(|_| AppError::Invalid("invalid stored retention setting".into()))?;
        validate_retention_days(days)?;
        Ok(days)
    }).transpose()
}

fn purge_expired_entries(conn: &Connection) -> Result<usize, AppError> {
    let Some(days) = retention_days(conn)? else { return Ok(0); };
    Ok(conn.execute("DELETE FROM time_entries WHERE entry_date < ?1", params![retention_cutoff(days)?])?)
}

#[tauri::command]
fn get_entry_retention_days(db: State<Db>) -> Result<Option<i64>, AppError> {
    with_conn(&db, retention_days)
}

#[tauri::command]
fn count_expired_entries(db: State<Db>, days: i64) -> Result<i64, AppError> {
    let cutoff = retention_cutoff(days)?;
    with_conn(&db, |conn| Ok(conn.query_row(
        "SELECT COUNT(*) FROM time_entries WHERE entry_date < ?1", params![cutoff], |row| row.get(0)
    )?))
}

#[tauri::command]
fn set_entry_retention_days(db: State<Db>, days: i64) -> Result<usize, AppError> {
    let cutoff = retention_cutoff(days)?;
    with_conn(&db, |conn| {
        let transaction = conn.unchecked_transaction()?;
        transaction.execute(
            "INSERT INTO app_settings (key, value) VALUES ('entry_retention_days', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![days.to_string()],
        )?;
        let deleted = transaction.execute("DELETE FROM time_entries WHERE entry_date < ?1", params![cutoff])?;
        transaction.commit()?;
        Ok(deleted)
    })
}

fn validate_time_entry(entry: &TimeEntryInput) -> Result<(), AppError> {
    let start = parse_time(&entry.start_time)?;
    let end = parse_time(&entry.end_time)?;
    if start == end {
        return Err(AppError::Invalid("start and end time must differ".to_string()));
    }
    normalize_entry_date(&entry.entry_date)?;
    if entry.note.chars().count() > 4_000 {
        return Err(AppError::Invalid("note is too long".to_string()));
    }
    if !matches!(entry.source_mode.as_str(), "manual" | "timer" | "pomodoro") {
        return Err(AppError::Invalid("unsupported entry source".to_string()));
    }
    Ok(())
}
fn with_conn<T>(db: &State<Db>, f: impl FnOnce(&Connection) -> Result<T, AppError>) -> Result<T, AppError> {
    let conn = db.lock().map_err(|_| AppError::Invalid("database lock poisoned".to_string()))?;
    f(&conn)
}

#[tauri::command]
fn list_event_types(db: State<Db>) -> Result<Vec<EventType>, AppError> {
    with_conn(&db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, color, sort_order, pinned, archived FROM event_types ORDER BY archived, pinned DESC, sort_order, name",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(EventType {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                sort_order: row.get(3)?,
                pinned: row.get::<_, i64>(4)? == 1,
                archived: row.get::<_, i64>(5)? == 1,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::Db)
    })
}

#[tauri::command]
fn save_event_type(db: State<Db>, event: EventType) -> Result<i64, AppError> {
    with_conn(&db, |conn| {
        if event.name.trim().is_empty() {
            return Err(AppError::Invalid("event name is required".to_string()));
        }
        if event.id == 0 {
            conn.execute(
                "INSERT INTO event_types (name, color, sort_order, pinned, archived) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![event.name.trim(), event.color, event.sort_order, bool_i(event.pinned), bool_i(event.archived)],
            )?;
            Ok(conn.last_insert_rowid())
        } else {
            conn.execute(
                "UPDATE event_types SET name = ?1, color = ?2, sort_order = ?3, pinned = ?4, archived = ?5 WHERE id = ?6",
                params![event.name.trim(), event.color, event.sort_order, bool_i(event.pinned), bool_i(event.archived), event.id],
            )?;
            Ok(event.id)
        }
    })
}

#[tauri::command]
fn delete_event_type(db: State<Db>, id: i64) -> Result<(), AppError> {
    with_conn(&db, |conn| {
        let references: i64 = conn.query_row("SELECT COUNT(*) FROM time_entries WHERE event_type_id = ?1", params![id], |row| row.get(0))?;
        if references > 0 {
            let fallback: Option<i64> = conn.query_row(
                "SELECT id FROM event_types WHERE name = '未分类' AND id != ?1 ORDER BY archived, id LIMIT 1",
                params![id],
                |row| row.get(0),
            ).optional()?;
            let fallback_id = match fallback {
                Some(existing) => existing,
                None => {
                    conn.execute(
                        "INSERT INTO event_types (name, color, sort_order, pinned, archived) VALUES ('未分类', '#64748b', 999999, 0, 0)",
                        [],
                    )?;
                    conn.last_insert_rowid()
                }
            };
            conn.execute("UPDATE time_entries SET event_type_id = ?1 WHERE event_type_id = ?2", params![fallback_id, id])?;
        }
        conn.execute("DELETE FROM event_types WHERE id = ?1", params![id])?;
        Ok(())
    })
}
#[tauri::command]
fn archive_event_type(db: State<Db>, id: i64) -> Result<(), AppError> {
    with_conn(&db, |conn| {
        conn.execute("UPDATE event_types SET archived = 1, pinned = 0 WHERE id = ?1", params![id])?;
        Ok(())
    })
}

#[tauri::command]
fn list_time_entries(db: State<Db>) -> Result<Vec<TimeEntry>, AppError> {
    with_conn(&db, |conn| {
        purge_expired_entries(conn)?;
        let mut stmt = conn.prepare(
            r#"
            SELECT te.id, te.entry_date, te.start_time, te.end_time, te.event_type_id,
                   et.name, et.color, te.note, te.source_mode, te.created_at
            FROM time_entries te
            JOIN event_types et ON et.id = te.event_type_id
            ORDER BY te.entry_date DESC, te.start_time ASC, te.id ASC
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(TimeEntry {
                id: row.get(0)?,
                entry_date: row.get(1)?,
                start_time: row.get(2)?,
                end_time: row.get(3)?,
                event_type_id: row.get(4)?,
                event_name: row.get(5)?,
                event_color: row.get(6)?,
                note: row.get(7)?,
                source_mode: row.get(8)?,
                created_at: row.get(9)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::Db)
    })
}

#[tauri::command]
fn save_time_entry(db: State<Db>, entry: TimeEntryInput) -> Result<i64, AppError> {
    validate_time_entry(&entry)?;
    let entry_date = normalize_entry_date(&entry.entry_date)?;
    with_conn(&db, |conn| {
        if let Some(days) = retention_days(conn)? {
            if entry_date < retention_cutoff(days)? {
                return Err(AppError::Invalid(format!("只能保存最近 {days} 天内的打卡记录")));
            }
        }
        if entry.id.unwrap_or(0) == 0 {
            conn.execute(
                "INSERT INTO time_entries (entry_date, start_time, end_time, event_type_id, note, source_mode, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![entry_date.as_str(), entry.start_time, entry.end_time, entry.event_type_id, entry.note, entry.source_mode, now()],
            )?;
            Ok(conn.last_insert_rowid())
        } else {
            let id = entry.id.unwrap_or_default();
            conn.execute(
                "UPDATE time_entries SET entry_date = ?1, start_time = ?2, end_time = ?3, event_type_id = ?4, note = ?5, source_mode = ?6 WHERE id = ?7",
                params![entry_date.as_str(), entry.start_time, entry.end_time, entry.event_type_id, entry.note, entry.source_mode, id],
            )?;
            Ok(id)
        }
    })
}

#[tauri::command]
fn delete_time_entry(db: State<Db>, id: i64) -> Result<(), AppError> {
    with_conn(&db, |conn| {
        conn.execute("DELETE FROM time_entries WHERE id = ?1", params![id])?;
        Ok(())
    })
}

#[tauri::command]
fn list_notes(db: State<Db>) -> Result<Vec<Note>, AppError> {
    with_conn(&db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, content, color, x, y, width, height, collapsed, pinned, font_size, style_json, created_at, updated_at FROM notes ORDER BY pinned DESC, id DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Note {
                id: row.get(0)?,
                content: row.get(1)?,
                color: row.get(2)?,
                x: row.get(3)?,
                y: row.get(4)?,
                width: row.get(5)?,
                height: row.get(6)?,
                collapsed: row.get::<_, i64>(7)? == 1,
                pinned: row.get::<_, i64>(8)? == 1,
                font_size: row.get(9)?,
                style_json: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::Db)
    })
}


#[tauri::command]
fn get_note(db: State<Db>, id: i64) -> Result<Note, AppError> {
    with_conn(&db, |conn| {
        conn.query_row(
            "SELECT id, content, color, x, y, width, height, collapsed, pinned, font_size, style_json, created_at, updated_at FROM notes WHERE id = ?1",
            params![id],
            |row| {
                Ok(Note {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    color: row.get(2)?,
                    x: row.get(3)?,
                    y: row.get(4)?,
                    width: row.get(5)?,
                    height: row.get(6)?,
                    collapsed: row.get::<_, i64>(7)? == 1,
                    pinned: row.get::<_, i64>(8)? == 1,
                    font_size: row.get(9)?,
                    style_json: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                })
            },
        )
        .map_err(AppError::Db)
    })
}
#[tauri::command]
fn save_note(app: AppHandle, db: State<Db>, note: NoteInput) -> Result<i64, AppError> {
    let id = with_conn(&db, |conn| {
        let timestamp = now();
        if note.id.unwrap_or(0) == 0 {
            conn.execute(
                "INSERT INTO notes (content, color, x, y, width, height, collapsed, pinned, font_size, style_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![note.content, note.color, note.x, note.y, note.width, note.height, bool_i(note.collapsed), bool_i(note.pinned), note.font_size, note.style_json, timestamp, timestamp],
            )?;
            Ok(conn.last_insert_rowid())
        } else {
            let id = note.id.unwrap_or_default();
            conn.execute(
                "UPDATE notes SET content = ?1, color = ?2, x = ?3, y = ?4, width = ?5, height = ?6, collapsed = ?7, pinned = ?8, font_size = ?9, style_json = ?10, updated_at = ?11 WHERE id = ?12",
                params![note.content, note.color, note.x, note.y, note.width, note.height, bool_i(note.collapsed), bool_i(note.pinned), note.font_size, note.style_json, timestamp, id],
            )?;
            Ok(id)
        }
    })?;
    // Broadcast note updates so every open window can refresh.
    let _ = app.emit("note-changed", id);
    Ok(id)
}

#[tauri::command]
fn delete_note(db: State<Db>, id: i64) -> Result<(), AppError> {
    with_conn(&db, |conn| {
        conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
        Ok(())
    })
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), AppError> {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    let output = if enabled {
        let executable = std::env::current_exe().map_err(AppError::Io)?;
        Command::new("reg").args(["add", key, "/v", "TimePast", "/t", "REG_SZ", "/d", &executable.to_string_lossy(), "/f"]).output()
    } else {
        Command::new("reg").args(["delete", key, "/v", "TimePast", "/f"]).output()
    }.map_err(AppError::Io)?;
    if !output.status.success() && enabled { return Err(AppError::Invalid("unable to update Windows startup setting".into())); }
    Ok(())
}
fn geometry_path(app: &AppHandle, name: &str) -> Result<PathBuf, AppError> {
    if name != "mini-window" {
        return Err(AppError::Invalid("unsupported window geometry target".to_string()));
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Invalid(e.to_string()))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("{}.json", name)))
}

fn clamp_mini_geometry(mut geometry: WindowGeometry) -> WindowGeometry {
    geometry.x = geometry.x.clamp(32, 1600);
    geometry.y = geometry.y.clamp(32, 900);
    geometry.width = 520;
    geometry.height = 48;
    geometry
}

fn load_geometry(app: &AppHandle, name: &str, fallback: WindowGeometry) -> WindowGeometry {
    let Ok(path) = geometry_path(app, name) else {
        return fallback;
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return fallback;
    };
    let parsed = serde_json::from_str::<WindowGeometry>(&raw).unwrap_or(fallback);
    if name == "mini-window" {
        clamp_mini_geometry(parsed)
    } else {
        parsed
    }
}

#[tauri::command]
fn save_window_geometry(
    app: AppHandle,
    name: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), AppError> {
    let path = geometry_path(&app, &name)?;
    let geometry = if name == "mini-window" {
        clamp_mini_geometry(WindowGeometry { x, y, width, height })
    } else {
        WindowGeometry { x, y, width, height }
    };
    let raw =
        serde_json::to_string_pretty(&geometry).map_err(|e| AppError::Invalid(e.to_string()))?;
    fs::write(path, raw)?;
    Ok(())
}
#[tauri::command]
fn set_main_window_mode(app: AppHandle, mode: String) -> Result<(), AppError> {
    if !matches!(mode.as_str(), "mini" | "full") {
        return Err(AppError::Invalid("unsupported window mode".to_string()));
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::Invalid("main window not found".to_string()))?;
    if mode == "mini" {
        let geometry = load_geometry(
            &app,
            "mini-window",
            WindowGeometry {
                x: 48,
                y: 48,
                width: 520,
                height: 48,
            },
        );
        window
            .set_decorations(false)
            .map_err(|e| AppError::Invalid(e.to_string()))?;
        window
            .set_always_on_top(true)
            .map_err(|e| AppError::Invalid(e.to_string()))?;
        window
            .set_resizable(false)
            .map_err(|e| AppError::Invalid(e.to_string()))?;
        window
            .set_size(Size::Logical(LogicalSize::new(geometry.width as f64, geometry.height as f64)))
            .map_err(|e| AppError::Invalid(e.to_string()))?;
        window
            .set_position(Position::Physical(PhysicalPosition::new(geometry.x, geometry.y)))
            .map_err(|e| AppError::Invalid(e.to_string()))?;
    } else {
        window
            .set_decorations(true)
            .map_err(|e| AppError::Invalid(e.to_string()))?;
        window
            .set_always_on_top(false)
            .map_err(|e| AppError::Invalid(e.to_string()))?;
        window
            .set_resizable(true)
            .map_err(|e| AppError::Invalid(e.to_string()))?;
        window
            .set_size(Size::Logical(LogicalSize::new(1180.0, 760.0)))
            .map_err(|e| AppError::Invalid(e.to_string()))?;
        window
            .set_position(Position::Physical(PhysicalPosition::new(80, 80)))
            .map_err(|e| AppError::Invalid(e.to_string()))?;
    }
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

/// Open a desktop note webview window. The window is hidden until the note page reports ready.
#[tauri::command]
async fn open_note_window(app: AppHandle, db: State<'_, Db>, note_id: i64) -> Result<(), AppError> {
    let label = format!("note-{}", note_id);

    // Focus an existing note window instead of opening duplicates.
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    // Read note layout from SQLite so the desktop note opens at the saved size and position.
    let (x, y, width, height, pinned) = {
        let conn = db.lock().map_err(|_| AppError::Invalid("database lock poisoned".into()))?;
        conn.query_row(
            "SELECT x, y, width, height, pinned FROM notes WHERE id = ?1",
            params![note_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)? == 1,
                ))
            },
        ).map_err(AppError::Db)?
    };

    let url = format!("note.html?noteId={}", note_id);

    // Create the note window hidden first to avoid a blank/black flash.
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(url.into()),
    )
    .title("TimePast 便签")
    .inner_size(width.clamp(280, 560) as f64, height.clamp(220, 460) as f64)
    .position(x.max(32) as f64, y.max(32) as f64)
    .decorations(false)
    .visible(false)
    .skip_taskbar(true)
    .always_on_top(pinned)
    .resizable(true)
    .build()
    .map_err(|e| AppError::Invalid(e.to_string()))?;

    // Show after the note frontend is ready, with a fallback timer below.
    let win_clone = window.clone();
    window.listen("note-ready", move |_| {
        let _ = win_clone.show();
        let _ = win_clone.set_focus();
    });

    let fallback_window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(900));
        let _ = fallback_window.show();
    });

    Ok(())
}

/// Toggle always-on-top for an open desktop note window.
#[tauri::command]
async fn set_note_always_on_top(app: AppHandle, note_id: i64, on_top: bool) -> Result<(), AppError> {
    let label = format!("note-{}", note_id);
    if let Some(window) = app.get_webview_window(&label) {
        window
            .set_always_on_top(on_top)
            .map_err(|e| AppError::Invalid(e.to_string()))?;
    }
    Ok(())
}

fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let open = MenuItem::with_id(app, "open", "Open TimePast", true, None::<&str>)?;
    let note = MenuItem::with_id(app, "note", "New note", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &note, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().expect("missing bundled app icon").clone())
        .menu(&menu)
        .tooltip("TimePast")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "note" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("tray-new-note", ());
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) && window.label() == "main" {
                window.app_handle().exit(0);
            }
        })
        .setup(|app| {
            let path = db_path(app)?;
            let conn = Connection::open(path)?;
            init_db(&conn)?;
            app.manage(Arc::new(Mutex::new(conn)));
            setup_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_event_types,
            save_event_type,
            archive_event_type,
            delete_event_type,
            list_time_entries,
            save_time_entry,
            delete_time_entry,
            get_entry_retention_days,
            count_expired_entries,
            set_entry_retention_days,
            list_notes,
            get_note,
            save_note,
            delete_note,
            set_autostart,
            save_window_geometry,
            set_main_window_mode,
            open_note_window,
            set_note_always_on_top
        ])
        .run(tauri::generate_context!())
        .expect("error while running TimePast");
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retention_includes_today_and_rejects_other_periods() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 28).unwrap();
        assert_eq!(retention_cutoff_on(today, 7).unwrap(), "2026-10-22");
        assert_eq!(retention_cutoff_on(today, 15).unwrap(), "2026-10-14");
        assert_eq!(retention_cutoff_on(today, 25).unwrap(), "2026-10-04");
        assert_eq!(retention_cutoff_on(today, 30).unwrap(), "2026-09-29");
        assert!(retention_cutoff_on(today, 31).is_err());
    }

    #[test]
    fn existing_records_are_not_deleted_before_retention_is_chosen() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE time_entries (id INTEGER PRIMARY KEY, entry_date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, event_type_id INTEGER NOT NULL, note TEXT NOT NULL, source_mode TEXT NOT NULL, created_at TEXT NOT NULL);
             INSERT INTO time_entries (entry_date, start_time, end_time, event_type_id, note, source_mode, created_at) VALUES ('2020-01-01', '09:00', '10:00', 1, '', 'manual', '2020-01-01');"
        ).unwrap();
        init_db(&conn).unwrap();
        assert_eq!(retention_days(&conn).unwrap(), None);
        assert_eq!(purge_expired_entries(&conn).unwrap(), 0);
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM time_entries", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn purge_removes_only_dates_before_the_inclusive_cutoff() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        conn.execute("UPDATE app_settings SET value = '7' WHERE key = 'entry_retention_days'", []).unwrap();
        let today = Local::now().date_naive();
        let expired = (today - chrono::Duration::days(7)).format("%Y-%m-%d").to_string();
        let boundary = retention_cutoff(7).unwrap();
        for date in [&expired, &boundary] {
            conn.execute(
                "INSERT INTO time_entries (entry_date, start_time, end_time, event_type_id, note, source_mode, created_at) VALUES (?1, '09:00', '10:00', 1, '', 'manual', '2026-01-01')",
                params![date],
            ).unwrap();
        }
        assert_eq!(purge_expired_entries(&conn).unwrap(), 1);
        let remaining: String = conn.query_row("SELECT entry_date FROM time_entries", [], |row| row.get(0)).unwrap();
        assert_eq!(remaining, boundary);
    }

    fn entry(start_time: &str, end_time: &str) -> TimeEntryInput {
        TimeEntryInput {
            id: None,
            entry_date: "2026-07-20".to_string(),
            start_time: start_time.to_string(),
            end_time: end_time.to_string(),
            event_type_id: 1,
            note: String::new(),
            source_mode: "timer".to_string(),
        }
    }

    #[test]
    fn accepts_a_cross_midnight_entry() {
        assert!(validate_time_entry(&entry("18:52", "01:12")).is_ok());
    }

    #[test]
    fn accepts_a_slash_separated_entry_date() {
        let mut input = entry("18:52", "01:12");
        input.entry_date = "2026/07/20".to_string();
        assert!(validate_time_entry(&input).is_ok());
        assert_eq!(normalize_entry_date(&input.entry_date).unwrap(), "2026-07-20");
    }

    #[test]
    fn rejects_a_zero_length_entry() {
        assert!(validate_time_entry(&entry("18:52", "18:52")).is_err());
    }
    #[test]
    fn merges_a_legacy_midnight_timer_pair() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE time_entries (
                id INTEGER PRIMARY KEY,
                entry_date TEXT NOT NULL,
                start_time TEXT NOT NULL,
                end_time TEXT NOT NULL,
                event_type_id INTEGER NOT NULL,
                note TEXT NOT NULL,
                source_mode TEXT NOT NULL
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO time_entries (entry_date, start_time, end_time, event_type_id, note, source_mode) VALUES ('2026-07-20', '18:52', '23:59', 1, '01-2', 'timer')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO time_entries (entry_date, start_time, end_time, event_type_id, note, source_mode) VALUES ('2026-07-21', '00:00', '01:12', 1, '01-2', 'timer')",
            [],
        )
        .unwrap();

        merge_legacy_overnight_entries(&conn).unwrap();

        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM time_entries", [], |row| row.get(0)).unwrap();
        let (date, start, end): (String, String, String) = conn
            .query_row("SELECT entry_date, start_time, end_time FROM time_entries", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(rows, 1);
        assert_eq!((date.as_str(), start.as_str(), end.as_str()), ("2026-07-20", "18:52", "01:12"));
    }
}
