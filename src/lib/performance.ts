import { addDays, format, parseISO, subDays } from "date-fns";
import type { PerformanceSettings } from "./types";

const dateText = (date: Date) => format(date, "yyyy-MM-dd");

function anchor(year: number, monthIndex: number, startDay: number): Date {
  const last = new Date(year, monthIndex + 1, 0).getDate();
  return new Date(year, monthIndex, Math.min(startDay, last));
}

export function cycleFor(date: string, startDay: number): { start: string; end: string; next: string } {
  const current = parseISO(date);
  const thisAnchor = anchor(current.getFullYear(), current.getMonth(), startDay);
  const start = current >= thisAnchor ? thisAnchor : anchor(current.getFullYear(), current.getMonth() - 1, startDay);
  const next = anchor(start.getFullYear(), start.getMonth() + 1, startDay);
  return { start: dateText(start), end: dateText(subDays(next, 1)), next: dateText(next) };
}

export function datesBetween(start: string, end: string): string[] {
  const result: string[] = [];
  for (let date = parseISO(start); date <= parseISO(end); date = addDays(date, 1)) result.push(dateText(date));
  return result;
}

export function entryCutoff(settings: PerformanceSettings, today: string): string | null {
  if (settings.entryRetentionMode === "off") return null;
  if (settings.entryRetentionMode === "cycle") return cycleFor(today, settings.cycleStartDay).start;
  return dateText(subDays(parseISO(today), settings.entryRetentionDays - 1));
}

export function quantity(value: number, decimals: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: decimals }).format(value);
}
