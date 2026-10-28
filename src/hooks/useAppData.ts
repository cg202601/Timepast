import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import type { EventType, StickyNote, TimeEntry } from "../lib/types";

export function useAppData(onError: (message: string) => void) {
  const [eventTypes, setEventTypes] = useState<EventType[]>([]);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [notes, setNotes] = useState<StickyNote[]>([]);

  const refresh = useCallback(async () => {
    const [events, recorded, stickyNotes] = await Promise.all([
      api.listEventTypes(),
      api.listTimeEntries(),
      api.listNotes()
    ]);
    setEventTypes(events);
    setEntries(recorded);
    setNotes(stickyNotes);
  }, []);

  useEffect(() => {
    refresh().catch((error) => onError(String(error)));
  }, [refresh, onError]);

  useEffect(() => {
    let timer: number;
    const scheduleNextDay = () => {
      const now = new Date();
      const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
      timer = window.setTimeout(() => {
        refresh().catch((error) => onError(String(error)));
        scheduleNextDay();
      }, nextDay.getTime() - now.getTime());
    };
    scheduleNextDay();
    return () => window.clearTimeout(timer);
  }, [refresh, onError]);

  useEffect(() => {
    const pending = listen("note-changed", () => refresh().catch(() => undefined));
    return () => {
      pending.then((off) => off()).catch(() => undefined);
    };
  }, [refresh]);

  return { eventTypes, entries, notes, refresh };
}
