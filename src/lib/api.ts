import { invoke } from "@tauri-apps/api/core";
import type {
  EventType,
  StickyNote,
  StickyNoteInput,
  TimeEntry,
  TimeEntryInput
} from "./types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const memory = {
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
      return memory.entries as T;
    case "save_time_entry": {
      const input = args?.entry as TimeEntryInput;
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
  listEventTypes: () => call<EventType[]>("list_event_types"),
  saveEventType: (event: EventType) => call<number>("save_event_type", { event }),
  archiveEventType: (id: number) => call<void>("archive_event_type", { id }),
  deleteEventType: (id: number) => call<void>("delete_event_type", { id }),
  listTimeEntries: () => call<TimeEntry[]>("list_time_entries"),
  saveTimeEntry: (entry: TimeEntryInput) => call<number>("save_time_entry", { entry }),
  deleteTimeEntry: (id: number) => call<void>("delete_time_entry", { id }),
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


