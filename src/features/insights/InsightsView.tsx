import { useEffect, useMemo, useState } from "react";
import { addDays, addMonths, addWeeks, format, parseISO, startOfMonth, startOfWeek, subDays } from "date-fns";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { EntryList } from "../entries/EntryList";
import { api } from "../../lib/api";
import { noteTitle } from "../../lib/noteMeta";
import { normalizeStoredRichText } from "../../lib/richText";
import { formatDuration, todayDate } from "../../lib/time";
import type { EventType, StickyNote, TimeEntry } from "../../lib/types";

type Period = "day" | "week" | "month";
type ChartMode = "bars" | "line";
type Part = { id: number; date: string; start: number; end: number; eventTypeId: number; name: string; color: string; note: string };
type Category = { id: number; name: string; color: string; minutes: number };
const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function minutes(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

export function splitEntriesByDay(entries: TimeEntry[]): Part[] {
  return entries.flatMap((entry) => {
    const start = minutes(entry.startTime);
    let end = minutes(entry.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end === start) return [];
    if (end < start) end += 1440;
    const base = { id: entry.id, eventTypeId: entry.eventTypeId, name: entry.eventName, color: entry.eventColor, note: entry.note };
    const first: Part = { ...base, date: entry.entryDate, start, end: Math.min(end, 1440) };
    if (end <= 1440) return [first];
    return [first, { ...base, date: format(addDays(parseISO(entry.entryDate), 1), "yyyy-MM-dd"), start: 0, end: end - 1440 }];
  });
}

function categoriesFor(parts: Part[], events: EventType[]): Category[] {
  const totals = new Map<number, Category>();
  for (const part of parts) {
    const event = events.find((item) => item.id === part.eventTypeId);
    const category = totals.get(part.eventTypeId) ?? { id: part.eventTypeId, name: event?.name ?? part.name, color: event?.color ?? part.color, minutes: 0 };
    category.minutes += part.end - part.start;
    totals.set(part.eventTypeId, category);
  }
  return [...totals.values()].sort((a, b) => b.minutes - a.minutes);
}

function periodDates(period: Period, anchor: Date) {
  const start = period === "week" ? startOfWeek(anchor, { weekStartsOn: 1 }) : period === "month" ? startOfMonth(anchor) : anchor;
  const count = period === "week" ? 7 : period === "month" ? new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate() : 1;
  return Array.from({ length: count }, (_, index) => format(addDays(start, index), "yyyy-MM-dd"));
}

const shortTime = (value: number) => `${String(Math.floor(value / 60) % 24).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;

function plainText(content: string) {
  const node = document.createElement("div");
  node.innerHTML = normalizeStoredRichText(content);
  return (node.textContent || content).replace(/\s+/g, " ").trim();
}

export function InsightsView({ entries, events, notes, onAddEntry, onOpenNotes }: { entries: TimeEntry[]; events: EventType[]; notes: StickyNote[]; onAddEntry: () => void; onOpenNotes: () => void }) {
  const [period, setPeriod] = useState<Period>("day");
  const [chartMode, setChartMode] = useState<ChartMode>("bars");
  const [anchor, setAnchor] = useState(todayDate());
  const [categoryId, setCategoryId] = useState<number | "all">("all");
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  useEffect(() => { api.getEntryRetentionDays().then(setRetentionDays).catch(() => undefined); }, []);
  const dates = useMemo(() => periodDates(period, parseISO(anchor)), [period, anchor]);
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  const cutoff = retentionDays ? format(subDays(new Date(), retentionDays - 1), "yyyy-MM-dd") : null;
  const parts = useMemo(() => splitEntriesByDay(entries), [entries]);
  const visibleParts = useMemo(() => parts.filter((part) => part.date >= firstDate && part.date <= lastDate && (!cutoff || part.date >= cutoff)), [parts, firstDate, lastDate, cutoff]);
  const categories = useMemo(() => categoriesFor(visibleParts, events), [visibleParts, events]);
  const dayEntryIds = new Set(visibleParts.map((part) => part.id));
  const dayEntries = period === "day" ? entries.filter((entry) => dayEntryIds.has(entry.id)) : [];
  const total = categories.reduce((sum, item) => sum + item.minutes, 0);
  const change = (direction: number) => {
    const date = parseISO(anchor);
    const shifted = period === "day" ? addDays(date, direction) : period === "week" ? addWeeks(date, direction) : addMonths(date, direction);
    setAnchor(format(shifted, "yyyy-MM-dd"));
  };
  const label = period === "day" ? format(parseISO(firstDate), "yyyy年M月d日") : period === "week" ? `${format(parseISO(firstDate), "M月d日")}—${format(parseISO(lastDate), "M月d日")}` : format(parseISO(firstDate), "yyyy年M月");
  const canNext = period === "day" ? anchor < todayDate() : period === "week" ? firstDate < format(startOfWeek(new Date(), { weekStartsOn: 1 }), "yyyy-MM-dd") : firstDate < format(startOfMonth(new Date()), "yyyy-MM-dd");

  return <section className="insights-page">
    <div className="panel insights-toolbar">
      <div className="insights-tabs" aria-label="统计周期">{(["day", "week", "month"] as const).map((value) => <button key={value} className={period === value ? "active" : ""} onClick={() => { setPeriod(value); setCategoryId("all"); setChartMode(value === "month" ? "line" : "bars"); }}>{value === "day" ? "日" : value === "week" ? "周" : "月"}</button>)}</div>
      <div className="insights-navigate"><button title="上一段" aria-label="上一段" onClick={() => change(-1)}><ChevronLeft size={18} /></button><strong>{label}</strong><button title="下一段" aria-label="下一段" disabled={!canNext} onClick={() => change(1)}><ChevronRight size={18} /></button><label className="insights-date">跳转日期<input type="date" value={anchor} max={todayDate()} onChange={(event) => { if (event.target.value) setAnchor(event.target.value); }} /></label><button onClick={() => setAnchor(todayDate())}>回到今天</button></div>
    </div>
    <p className="insights-help">{period === "day" ? "当天看 24 小时时间线、分类时长和记录。" : chartMode === "bars" ? "堆叠柱状图：每天一根柱子，颜色表示时间分类；柱子越高，当天记录越久。" : "折线图：每天一个点，连线表示时长变化；点击分类可查看对应走势。"} 跨午夜的记录会分到实际日期。</p>
    <div className="insights-metrics"><div className="panel"><span>已记录时长</span><strong>{formatDuration(total)}</strong></div><div className="panel"><span>{period === "day" ? "时间段" : "有记录的天数"}</span><strong>{period === "day" ? `${dayEntries.length} 段` : `${new Set(visibleParts.map((part) => part.date)).size} 天`}</strong></div><div className="panel"><span>分类数量</span><strong>{categories.length} 类</strong></div></div>
    {period === "day" ? <><DayChart date={firstDate} parts={visibleParts} categories={categories} expired={!!cutoff && firstDate < cutoff} /><div className="grid today-grid"><div className="panel wide"><div className="panel-head"><h2>{firstDate === todayDate() ? "今日记录" : "当天记录"}</h2><button onClick={onAddEntry}><Plus size={16} />记录</button></div><EntryList entries={dayEntries} compact /></div><div className="panel"><div className="panel-head"><h2>便签预览</h2><button onClick={onOpenNotes}>打开</button></div>{notes.slice(0, 4).map((note) => <div className="note-preview" key={note.id} style={{ background: note.color }}><strong>{noteTitle(note)}</strong><div>{plainText(note.content)}</div></div>)}{!notes.length && <div className="insights-empty">还没有便签。</div>}</div></div></> : <TrendChart dates={dates} parts={visibleParts} categories={categories} selected={categoryId} onSelect={setCategoryId} cutoff={cutoff} period={period} mode={chartMode} onModeChange={setChartMode} />}
    <p className="insights-footnote">仅统计当前保留的打卡记录。{retentionDays ? `当前保留最近 ${retentionDays} 天；灰色日期已超出保留期限，不表示当天没有活动。` : "已删除的记录无法恢复到图表。"} 今天之后的日期尚未发生。</p>
  </section>;
}

function DayChart({ date, parts, categories, expired }: { date: string; parts: Part[]; categories: Category[]; expired: boolean }) {
  const total = categories.reduce((sum, item) => sum + item.minutes, 0);
  return <div className="panel insights-chart-panel"><div className="panel-head"><h2>当天时间线</h2><span className="muted">{weekday[parseISO(date).getDay()]}</span></div>
    {expired ? <div className="insights-empty">该日期已超出记录保留期限，无法显示历史数据。</div> : parts.length ? <><div className="day-axis">{[0, 6, 12, 18, 24].map((hour) => <span key={hour}>{String(hour).padStart(2, "0")}:00</span>)}</div><div className="day-rows">{[...parts].sort((a, b) => a.start - b.start).map((part, index) => <div className="day-row" key={`${part.id}-${index}`}><div className="day-row-label"><i style={{ background: part.color }} />{part.name}</div><div className="day-track"><div className="day-block" style={{ left: `${part.start / 14.4}%`, width: `${Math.max(0.35, (part.end - part.start) / 14.4)}%`, background: part.color }} title={`${part.name} ${shortTime(part.start)}—${part.end === 1440 ? "24:00" : shortTime(part.end)} · ${formatDuration(part.end - part.start)}${part.note ? ` · ${part.note}` : ""}`} /></div><span className="day-duration">{formatDuration(part.end - part.start)}</span></div>)}</div></> : <div className="insights-empty">当天没有保存的打卡记录。</div>}
    <div className="insights-category-summary"><h3>分类时长</h3>{categories.map((category) => <div className="category-summary-row" key={category.id}><span><i style={{ background: category.color }} />{category.name}</span><div className="category-summary-track"><div style={{ width: `${total ? category.minutes / total * 100 : 0}%`, background: category.color }} /></div><strong>{formatDuration(category.minutes)}</strong></div>)}</div>
  </div>;
}

function TrendChart({ dates, parts, categories, selected, onSelect, cutoff, period, mode, onModeChange }: { dates: string[]; parts: Part[]; categories: Category[]; selected: number | "all"; onSelect: (id: number | "all") => void; cutoff: string | null; period: Period; mode: ChartMode; onModeChange: (mode: ChartMode) => void }) {
  const categoryIds = new Set(categories.map((item) => item.id));
  const active = selected === "all" || categoryIds.has(selected) ? selected : "all";
  const totals = dates.map((date) => {
    const dayParts = parts.filter((part) => part.date === date);
    const byCategory = new Map<number, number>();
    for (const part of dayParts) byCategory.set(part.eventTypeId, (byCategory.get(part.eventTypeId) ?? 0) + part.end - part.start);
    return { date, byCategory, total: [...byCategory.values()].reduce((sum, value) => sum + value, 0) };
  });
  const peak = Math.max(60, ...totals.map((item) => mode === "bars" || active === "all" ? item.total : item.byCategory.get(active) ?? 0));
  const yMax = Math.ceil(peak / 60) * 60;
  const x0 = 52, x1 = 872, y0 = 22, y1 = 252;
  const step = (x1 - x0) / dates.length;
  const pointX = (index: number) => x0 + step * (index + 0.5);
  const pointY = (value: number) => y1 - value / yMax * (y1 - y0);
  const lineColor = active === "all" ? "#1e293b" : categories.find((item) => item.id === active)?.color ?? "#1e293b";
  const points = totals.map((item, index) => ({ x: pointX(index), y: pointY(active === "all" ? item.total : item.byCategory.get(active) ?? 0), available: (!cutoff || item.date >= cutoff) && item.date <= todayDate() }));
  const paths: string[] = [];
  let current = "";
  for (const point of points) {
    if (!point.available) { if (current) paths.push(current); current = ""; continue; }
    current += `${current ? " L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  }
  if (current) paths.push(current);
  return <div className="panel insights-chart-panel"><div className="panel-head"><div><h2>{period === "week" ? "周内每日分类" : "月内每日分类"}</h2><span className="muted">{mode === "bars" ? "堆叠柱状图 · 比较每天的分类构成" : "折线图 · 查看每日时长走势"}</span></div><div className="insights-chart-switch" aria-label="图表类型"><button className={mode === "bars" ? "active" : ""} onClick={() => onModeChange("bars")}>分类构成 · 柱状图</button><button className={mode === "line" ? "active" : ""} onClick={() => onModeChange("line")}>走势 · 折线图</button></div></div>
    <div className="insights-legend"><button className={active === "all" ? "active" : ""} onClick={() => onSelect("all")}>{mode === "line" ? "总时长" : "全部分类"}</button>{categories.map((category) => <button key={category.id} className={active === category.id ? "active" : ""} onClick={() => onSelect(category.id)}><i style={{ background: category.color }} />{category.name} · {formatDuration(category.minutes)}</button>)}</div>
    <div className="insights-svg-wrap"><svg viewBox="0 0 900 300" role="img" aria-label={`${period === "week" ? "周内" : "月内"}每日分类${mode === "bars" ? "堆叠柱状图" : "折线图"}`}>
      {[0, 0.25, 0.5, 0.75, 1].map((fraction) => <g key={fraction}><line x1={x0} x2={x1} y1={y1 - fraction * (y1 - y0)} y2={y1 - fraction * (y1 - y0)} stroke="#dbe3ee" /><text x={x0 - 8} y={y1 - fraction * (y1 - y0) + 4} textAnchor="end" fontSize="11" fill="#64748b">{Number((yMax * fraction / 60).toFixed(1))}h</text></g>)}
      {totals.map((item, index) => {
        const x = pointX(index), width = Math.max(7, step * 0.62), unavailable = (cutoff && item.date < cutoff) || item.date > todayDate();
        let bottom = y1;
        return <g key={item.date}><title>{item.date} · {unavailable ? item.date > todayDate() ? "尚未发生" : "超出保留期限" : categories.map((category) => `${category.name} ${formatDuration(item.byCategory.get(category.id) ?? 0)}`).join("，") || "无记录"}</title>{unavailable ? <rect x={x - width / 2} y={y0} width={width} height={y1 - y0} fill="#f1f5f9" /> : mode === "bars" ? categories.map((category) => { const value = item.byCategory.get(category.id) ?? 0; const height = value / yMax * (y1 - y0); bottom -= height; return value ? <rect key={category.id} x={x - width / 2} y={bottom} width={width} height={height} fill={category.color} opacity={active === "all" || active === category.id ? 0.88 : 0.35} /> : null; }) : null}{(period === "week" || index % 5 === 0 || index === dates.length - 1) && <text x={x} y={y1 + 20} textAnchor="middle" fontSize="11" fill="#64748b">{period === "week" ? weekday[parseISO(item.date).getDay()] : format(parseISO(item.date), "d日")}</text>}</g>;
      })}
      {mode === "line" && paths.map((path, index) => <path key={index} d={path} fill="none" stroke={lineColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />)}
      {mode === "line" && points.map((point, index) => point.available ? <circle key={dates[index]} cx={point.x} cy={point.y} r={period === "week" ? 4 : 2.5} fill={lineColor}><title>{dates[index]} · {formatDuration(active === "all" ? totals[index].total : totals[index].byCategory.get(active) ?? 0)}</title></circle> : null)}
    </svg></div>
    {!parts.length && <div className="insights-empty">此期间没有保存的打卡记录。</div>}
  </div>;
}
