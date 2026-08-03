import { format, parseISO } from "date-fns";
import type { TimeEntry } from "./types";

export function todayDate(): string {
  return format(new Date(), "yyyy-MM-dd");
}

export function currentTime(): string {
  return format(new Date(), "HH:mm");
}

export function isoToDateInput(value: string): string {
  return format(parseISO(value), "yyyy-MM-dd");
}

export function isoToTimeInput(value: string): string {
  return format(parseISO(value), "HH:mm");
}

export function normalizeDateInput(value: string): string {
  return value.trim().replace(/\//g, "-");
}

export function copyTextForEntry(entry: TimeEntry): string {
  const note = entry.note.trim();
  return `${entry.startTime}-${entry.endTime}${note ? ` ${note}` : ""}`;
}

export function copyTextForEntries(entries: TimeEntry[]): string {
  return entries.map(copyTextForEntry).join("\n");
}

export function minutesBetween(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const difference = eh * 60 + em - (sh * 60 + sm);
  return difference < 0 ? difference + 24 * 60 : difference;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}
