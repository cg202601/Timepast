fn main() {
    const COMMANDS: &[&str] = &[
        "list_event_types", "save_event_type", "archive_event_type", "delete_event_type",
        "list_time_entries", "save_time_entry", "delete_time_entry",
        "list_notes", "get_note", "save_note", "delete_note", "set_autostart",
        "exit_app", "save_window_geometry", "set_main_window_mode", "open_note_window",
        "set_note_always_on_top", "get_shortcut_status", "set_global_shortcut",
        "get_performance_settings", "preview_performance_retention", "save_performance_settings",
        "list_work_types", "save_work_type", "list_cycle_goals", "save_cycle_goal",
        "save_work_output", "delete_work_output", "set_work_day_override",
        "list_work_day_overrides", "list_work_days",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    ).expect("failed to build Tauri command permissions");
}
