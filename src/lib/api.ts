import { invoke } from "@tauri-apps/api/core";
import { addDays, format, subDays } from "date-fns";
import { cycleFor, datesBetween, entryCutoff } from "./performance";
import type {
  CycleGoal,
  DayMode,
  EventType,
  ExpiredCounts,
  PerformanceSettings,
  ShortcutAction,
  ShortcutStatus,
  StickyNote,
  StickyNoteInput,
  TimeEntry,
  TimeEntryInput,
  WorkDay,
  WorkDayOverride,
  WorkType
} from "./types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const memory = {
  retentionDays: 30,
  performanceSettings: { cycleStartDay: 1, summaryRetentionDays: 365, entryRetentionMode: "cycle", entryRetentionDays: 31 } as PerformanceSettings,
  workTypes: [] as WorkType[],
  cycleGoals: [] as CycleGoal[],
  workDays: [] as WorkDay[],
  workOverrides: [] as WorkDayOverride[],
  shortcuts: { quickStart: false, newNote: false, quickStartKey: "Ctrl+Alt+T", newNoteKey: "Ctrl+Alt+N" } as ShortcutStatus,
  eventTypes: [
    { id: 1, name: "深度工作", color: "#3b82f6", sortOrder: 1, pinned: true, archived: false },
    { id: 2, name: "学习", color: "#10b981", sortOrder: 2, pinned: true, archived: false },
    { id: 3, name: "会议", color: "#f59e0b", sortOrder: 3, pinned: true, archived: false },
    { id: 4, name: "杂事", color: "#8b5cf6", sortOrder: 4, pinned: false, archived: false }
  ] as EventType[],
  entries: [] as TimeEntry[],
  notes: [] as StickyNote[]
};

let nextId = 100;

function retentionCutoff(days: number): string {
  return format(subDays(new Date(), days - 1), "yyyy-MM-dd");
}

function validateRetentionDays(days: number): void {
  if (![7, 15, 25, 30].includes(days)) throw new Error("保留期限只能是 7、15、25 或 30 天");
}

function purgeExpiredEntries(): number {
  const before = memory.entries.length;
  const cutoff = entryCutoff(memory.performanceSettings, format(new Date(), "yyyy-MM-dd"));
  if (cutoff) memory.entries = memory.entries.filter((item) => item.entryDate >= cutoff);
  return before - memory.entries.length;
}

function memoryPlan(workTypeId: number, start: string) {
  const goal = memory.cycleGoals.find((item) => item.workTypeId === workTypeId && item.cycleStart === start);
  const work = memory.workTypes.find((item) => item.id === workTypeId);
  if (!goal || !work) return;
  const dates = datesBetween(goal.cycleStart, goal.cycleEnd);
  const today = format(new Date(), "yyyy-MM-dd");
  const fixed = dates.map((date) => {
    const override = memory.workOverrides.find((item) => item.workTypeId === workTypeId && item.date === date);
    const prior = memory.workDays.find((item) => item.workTypeId === workTypeId && item.date === date);
    if (override?.mode === "custom") return { date, value: override.customTarget ?? 0 };
    if (date < today && prior?.planned !== null && prior?.planned !== undefined) return { date, value: prior.planned };
    return null;
  });
  const fixedSum = fixed.reduce((sum, item) => sum + (item?.value ?? 0), 0);
  if (fixedSum > goal.target + 1e-8) throw new Error("月目标小于已锁定的日目标");
  const weighted = dates.map((date, index) => {
    if (fixed[index]) return 0;
    const override = memory.workOverrides.find((item) => item.workTypeId === workTypeId && item.date === date);
    const weekday = (new Date(`${date}T12:00:00`).getDay() + 6) % 7;
    return override?.mode === "rest" ? 0 : override?.mode === "half" ? 0.5 : override?.mode === "normal" ? 1 : work.weekFactors[weekday];
  });
  const sumWeight = weighted.reduce((sum, value) => sum + value, 0);
  if (sumWeight === 0 && goal.target > fixedSum) throw new Error("此周期没有可分配目标的工作日");
  const scale = 100;
  const remaining = Math.round((goal.target - fixedSum) * scale);
  const raw = weighted.map((weight) => sumWeight ? remaining * weight / sumWeight : 0);
  const units = raw.map(Math.floor);
  const order = raw.map((value, index) => ({ index, fraction: value - units[index] })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  const remainder = remaining - units.reduce((sum, value) => sum + value, 0);
  for (let i = 0; i < remainder; i++) units[order[i].index] += 1;
  for (let index = 0; index < dates.length; index++) {
    const date = dates[index];
    const previous = memory.workDays.find((item) => item.workTypeId === workTypeId && item.date === date);
    const planned = fixed[index]?.value ?? (weighted[index] ? units[index] / scale : null);
    if (previous) previous.planned = planned;
    else if (planned !== null) memory.workDays.push({ workTypeId, date, output: null, minutes: 0, planned });
  }
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) return invoke<T>(command, args);
  return fallback<T>(command, args);
}

async function fallback<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  switch (command) {
    case "list_event_types":
      return memory.eventTypes as T;
    case "save_event_type": {
      const event = args?.event as EventType;
      if (event.id === 0) {
        event.id = nextId++;
        if (event.pinned) {
          event.sortOrder = Math.min(0, ...memory.eventTypes.filter((item) => item.pinned).map((item) => item.sortOrder)) - 1;
        }
        memory.eventTypes.push(event);
      } else {
        const previous = memory.eventTypes.find((item) => item.id === event.id);
        if (event.pinned && !previous?.pinned) {
          event.sortOrder = Math.min(0, ...memory.eventTypes.filter((item) => item.pinned).map((item) => item.sortOrder)) - 1;
        }
        memory.eventTypes = memory.eventTypes.map((item) => (item.id === event.id ? event : item));
      }
      return event.id as T;
    }
    case "delete_event_type":
      memory.eventTypes = memory.eventTypes.filter((item) => item.id !== args?.id);
      return undefined as T;
    case "archive_event_type":
      memory.eventTypes = memory.eventTypes.map((item) =>
        item.id === args?.id ? { ...item, archived: true, pinned: false } : item
      );
      return undefined as T;
    case "list_time_entries":
      purgeExpiredEntries();
      return memory.entries as T;
    case "get_performance_settings":
      return { ...memory.performanceSettings } as T;
    case "preview_performance_retention": {
      const settings = args?.settings as PerformanceSettings;
      const cutoff = entryCutoff(settings, format(new Date(), "yyyy-MM-dd"));
      const summaryCutoff = format(subDays(new Date(), settings.summaryRetentionDays - 1), "yyyy-MM-dd");
      return { entries: cutoff ? memory.entries.filter((item) => item.entryDate < cutoff).length : 0, summaryDays: new Set(memory.workDays.filter((item) => item.date < summaryCutoff).map((item) => item.date)).size } as T;
    }
    case "save_performance_settings": {
      const settings = args?.settings as PerformanceSettings;
      const counts = await fallback<ExpiredCounts>("preview_performance_retention", { settings });
      memory.performanceSettings = settings;
      purgeExpiredEntries();
      const cutoff = format(subDays(new Date(), settings.summaryRetentionDays - 1), "yyyy-MM-dd");
      memory.workDays = memory.workDays.filter((item) => item.date >= cutoff);
      memory.workOverrides = memory.workOverrides.filter((item) => item.date >= cutoff);
      return counts as T;
    }
    case "list_work_types":
      return memory.workTypes.map((item) => ({ ...item, eventTypeIds: [...item.eventTypeIds], weekFactors: [...item.weekFactors] })) as T;
    case "save_work_type": {
      const item = args?.item as WorkType;
      const id = item.id || nextId++;
      const saved = { ...item, id };
      memory.workTypes = memory.workTypes.filter((existing) => existing.id !== id).concat(saved);
      for (const goal of memory.cycleGoals.filter((goal) => goal.workTypeId === id)) memoryPlan(id, goal.cycleStart);
      return id as T;
    }
    case "list_cycle_goals": {
      const from = args?.from as string, to = args?.to as string;
      return memory.cycleGoals.filter((item) => item.cycleStart <= to && item.cycleEnd >= from) as T;
    }
    case "save_cycle_goal": {
      const workTypeId = args?.workTypeId as number;
      const work = memory.workTypes.find((item) => item.id === workTypeId);
      if (!work) throw new Error("工作类型不存在");
      const cycle = cycleFor(args?.anchorDate as string, memory.performanceSettings.cycleStartDay);
      const goal = { workTypeId, cycleStart: cycle.start, cycleEnd: cycle.end, target: args?.target as number, hourlyTarget: work.hourlyTarget };
      memory.cycleGoals = memory.cycleGoals.filter((item) => item.workTypeId !== workTypeId || item.cycleStart !== cycle.start).concat(goal);
      memoryPlan(workTypeId, cycle.start);
      return goal as T;
    }
    case "save_work_output": {
      const workTypeId = args?.workTypeId as number, date = args?.date as string, output = args?.quantity as number;
      const day = memory.workDays.find((item) => item.workTypeId === workTypeId && item.date === date);
      if (day) day.output = output;
      else memory.workDays.push({ workTypeId, date, output, minutes: 0, planned: null });
      return undefined as T;
    }
    case "delete_work_output": {
      const day = memory.workDays.find((item) => item.workTypeId === args?.workTypeId && item.date === args?.date);
      if (day) day.output = null;
      return undefined as T;
    }
    case "list_work_day_overrides":
      return memory.workOverrides.filter((item) => item.date >= (args?.from as string) && item.date <= (args?.to as string)) as T;
    case "set_work_day_override": {
      const workTypeId = args?.workTypeId as number, date = args?.date as string, mode = args?.mode as DayMode;
      memory.workOverrides = memory.workOverrides.filter((item) => item.workTypeId !== workTypeId || item.date !== date);
      if (mode !== "default") memory.workOverrides.push({ workTypeId, date, mode, customTarget: (args?.customTarget as number | null) ?? null });
      const cycle = memory.cycleGoals.find((goal) => goal.workTypeId === workTypeId && goal.cycleStart <= date && goal.cycleEnd >= date);
      const day = memory.workDays.find((item) => item.workTypeId === workTypeId && item.date === date);
      if (day) day.planned = null;
      if (cycle) memoryPlan(workTypeId, cycle.cycleStart);
      return undefined as T;
    }
    case "list_work_days": {
      const from = args?.from as string, to = args?.to as string;
      const days = memory.workDays.filter((item) => item.date >= from && item.date <= to).map((item) => ({ ...item, minutes: 0 }));
      for (const entry of memory.entries) {
        const start = Number(entry.startTime.slice(0, 2)) * 60 + Number(entry.startTime.slice(3));
        let end = Number(entry.endTime.slice(0, 2)) * 60 + Number(entry.endTime.slice(3));
        if (end < start) end += 1440;
        const parts = [{ date: entry.entryDate, minutes: Math.min(end, 1440) - start }];
        if (end > 1440) parts.push({ date: format(addDays(new Date(`${entry.entryDate}T12:00:00`), 1), "yyyy-MM-dd"), minutes: end - 1440 });
        for (const work of memory.workTypes.filter((item) => item.eventTypeIds.includes(entry.eventTypeId))) for (const part of parts) {
          if (part.date < from || part.date > to) continue;
          let day = days.find((item) => item.workTypeId === work.id && item.date === part.date);
          if (!day) { day = { workTypeId: work.id, date: part.date, output: null, minutes: 0, planned: null }; days.push(day); }
          day.minutes += part.minutes;
        }
      }
      return days as T;
    }
    case "get_entry_retention_days":
      return memory.retentionDays as T;
    case "get_shortcut_status":
      return { ...memory.shortcuts } as T;
    case "set_global_shortcut": {
      const action = args?.action as ShortcutAction;
      const key = args?.shortcut as string;
      if (action !== "quickStart" && action !== "newNote") throw new Error("未知快捷键功能");
      if (key === (action === "quickStart" ? memory.shortcuts.newNoteKey : memory.shortcuts.quickStartKey)) throw new Error("两个功能不能使用相同的快捷键");
      if (action === "quickStart") memory.shortcuts.quickStartKey = key;
      else memory.shortcuts.newNoteKey = key;
      return { ...memory.shortcuts } as T;
    }
    case "count_expired_entries": {
      const days = args?.days as number;
      validateRetentionDays(days);
      return memory.entries.filter((item) => item.entryDate < retentionCutoff(days)).length as T;
    }
    case "set_entry_retention_days": {
      const days = args?.days as number;
      validateRetentionDays(days);
      memory.retentionDays = days;
      return purgeExpiredEntries() as T;
    }
    case "save_time_entry": {
      const input = args?.entry as TimeEntryInput;
      if (input.entryDate < retentionCutoff(memory.retentionDays)) {
        throw new Error(`只能保存最近 ${memory.retentionDays} 天内的打卡记录`);
      }
      const event = memory.eventTypes.find((item) => item.id === input.eventTypeId) ?? memory.eventTypes[0];
      const entry: TimeEntry = {
        id: input.id ?? nextId++,
        entryDate: input.entryDate,
        startTime: input.startTime,
        endTime: input.endTime,
        eventTypeId: input.eventTypeId,
        eventName: event.name,
        eventColor: event.color,
        note: input.note,
        sourceMode: input.sourceMode,
        createdAt: new Date().toISOString()
      };
      memory.entries = input.id
        ? memory.entries.map((item) => (item.id === input.id ? entry : item))
        : [entry, ...memory.entries];
      return entry.id as T;
    }
    case "delete_time_entry":
      memory.entries = memory.entries.filter((item) => item.id !== args?.id);
      return undefined as T;
    case "list_notes":
      return memory.notes as T;
    case "get_note": {
      const note = memory.notes.find((item) => item.id === args?.id);
      if (!note) throw new Error("Note not found");
      return note as T;
    }
    case "save_note": {
      const input = args?.note as StickyNoteInput;
      const existing = input.id ? memory.notes.find((item) => item.id === input.id) : undefined;
      const note: StickyNote = {
        id: input.id ?? nextId++,
        ...input,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      memory.notes = input.id
        ? memory.notes.map((item) => (item.id === input.id ? note : item))
        : [note, ...memory.notes];
      return note.id as T;
    }
    case "delete_note":
      memory.notes = memory.notes.filter((item) => item.id !== args?.id);
      return undefined as T;
    case "set_main_window_mode":
    case "save_window_geometry":
    case "open_note_window":
    case "set_note_always_on_top":
    case "set_autostart":
      return undefined as T;
    default:
      throw new Error(`Unsupported fallback command: ${command}`);
  }
}

export const api = {
  getPerformanceSettings: () => call<PerformanceSettings>("get_performance_settings"),
  previewPerformanceRetention: (settings: PerformanceSettings) => call<ExpiredCounts>("preview_performance_retention", { settings }),
  savePerformanceSettings: (settings: PerformanceSettings) => call<ExpiredCounts>("save_performance_settings", { settings }),
  listWorkTypes: () => call<WorkType[]>("list_work_types"),
  saveWorkType: (item: WorkType) => call<number>("save_work_type", { item }),
  listCycleGoals: (from: string, to: string) => call<CycleGoal[]>("list_cycle_goals", { from, to }),
  saveCycleGoal: (workTypeId: number, anchorDate: string, target: number) => call<CycleGoal>("save_cycle_goal", { workTypeId, anchorDate, target }),
  listWorkDays: (from: string, to: string) => call<WorkDay[]>("list_work_days", { from, to }),
  listWorkDayOverrides: (from: string, to: string) => call<WorkDayOverride[]>("list_work_day_overrides", { from, to }),
  saveWorkOutput: (workTypeId: number, date: string, quantity: number) => call<void>("save_work_output", { workTypeId, date, quantity }),
  deleteWorkOutput: (workTypeId: number, date: string) => call<void>("delete_work_output", { workTypeId, date }),
  setWorkDayOverride: (workTypeId: number, date: string, mode: DayMode, customTarget: number | null) => call<void>("set_work_day_override", { workTypeId, date, mode, customTarget }),
  getShortcutStatus: () => call<ShortcutStatus>("get_shortcut_status"),
  setGlobalShortcut: (action: ShortcutAction, shortcut: string) => call<ShortcutStatus>("set_global_shortcut", { action, shortcut }),
  listEventTypes: () => call<EventType[]>("list_event_types"),
  saveEventType: (event: EventType) => call<number>("save_event_type", { event }),
  archiveEventType: (id: number) => call<void>("archive_event_type", { id }),
  deleteEventType: (id: number) => call<void>("delete_event_type", { id }),
  listTimeEntries: () => call<TimeEntry[]>("list_time_entries"),
  saveTimeEntry: (entry: TimeEntryInput) => call<number>("save_time_entry", { entry }),
  deleteTimeEntry: (id: number) => call<void>("delete_time_entry", { id }),
  getEntryRetentionDays: () => call<number | null>("get_entry_retention_days"),
  countExpiredEntries: (days: number) => call<number>("count_expired_entries", { days }),
  setEntryRetentionDays: (days: number) => call<number>("set_entry_retention_days", { days }),
  listNotes: () => call<StickyNote[]>("list_notes"),
  getNote: (id: number) => call<StickyNote>("get_note", { id }),
  saveNote: (note: StickyNoteInput) => call<number>("save_note", { note }),
  deleteNote: (id: number) => call<void>("delete_note", { id }),
  setWindowMode: (mode: "mini" | "full") => call<void>("set_main_window_mode", { mode }),
  openNoteWindow: (noteId: number) => call<void>("open_note_window", { noteId }),
  saveWindowGeometry: (name: string, x: number, y: number, width: number, height: number) =>
    call<void>("save_window_geometry", { name, x, y, width, height }),
  setNoteAlwaysOnTop: (noteId: number, onTop: boolean) =>
    call<void>("set_note_always_on_top", { noteId, onTop }),
  setAutostart: (enabled: boolean) => call<void>("set_autostart", { enabled })
};


