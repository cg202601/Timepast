import { useEffect, useMemo, useState } from "react";
import { addDays, addWeeks, format, parseISO, startOfWeek, subDays } from "date-fns";
import { api } from "../../lib/api";
import { cycleFor, datesBetween, quantity } from "../../lib/performance";
import { formatDuration, todayDate } from "../../lib/time";
import type { CycleGoal, DayMode, PerformanceSettings, WorkDay, WorkDayOverride, WorkType } from "../../lib/types";

type Period = "day" | "week" | "cycle";
type Span = { start: string; end: string; dates: string[] };

function spanFor(period: Period, anchor: string, startDay: number): Span {
  if (period === "day") return { start: anchor, end: anchor, dates: [anchor] };
  if (period === "cycle") { const cycle = cycleFor(anchor, startDay); return { start: cycle.start, end: cycle.end, dates: datesBetween(cycle.start, cycle.end) }; }
  const start = format(startOfWeek(parseISO(anchor), { weekStartsOn: 1 }), "yyyy-MM-dd");
  const end = format(addDays(parseISO(start), 6), "yyyy-MM-dd");
  return { start, end, dates: datesBetween(start, end) };
}

const matchGoal = (goals: CycleGoal[], typeId: number, date: string) => goals.find((goal) => goal.workTypeId === typeId && goal.cycleStart <= date && goal.cycleEnd >= date);
const matchDay = (days: WorkDay[], typeId: number, date: string) => days.find((day) => day.workTypeId === typeId && day.date === date);
const matchOverride = (items: WorkDayOverride[], typeId: number, date: string) => items.find((item) => item.workTypeId === typeId && item.date === date);

function dayFactor(type: WorkType, date: string, override?: WorkDayOverride): number {
  if (override?.mode === "rest") return 0;
  if (override?.mode === "half") return 0.5;
  if (override?.mode === "normal" || override?.mode === "custom") return 1;
  return type.weekFactors[(parseISO(date).getDay() + 6) % 7] ?? 1;
}

export function PerformanceView({ setStatus }: { setStatus: (message: string) => void }) {
  const [period, setPeriod] = useState<Period>("cycle");
  const [anchor, setAnchor] = useState(todayDate());
  const [settings, setSettings] = useState<PerformanceSettings | null>(null);
  const [types, setTypes] = useState<WorkType[]>([]);
  const [goals, setGoals] = useState<CycleGoal[]>([]);
  const [days, setDays] = useState<WorkDay[]>([]);
  const [overrides, setOverrides] = useState<WorkDayOverride[]>([]);
  const [revision, setRevision] = useState(0);
  const [loadedKey, setLoadedKey] = useState("");
  const [loadError, setLoadError] = useState("");
  const [selectedTypeId, setSelectedTypeId] = useState<number | null>(null);
  useEffect(() => { Promise.all([api.getPerformanceSettings(), api.listWorkTypes()]).then(([s, t]) => { setSettings(s); setTypes(t); }).catch((error) => setStatus(`读取工作效率失败：${String(error)}`)); }, []);
  useEffect(() => {
    const active = types.filter((item) => !item.archived);
    setSelectedTypeId((previous) => previous !== null && active.some((item) => item.id === previous) ? previous : active[0]?.id ?? null);
  }, [types]);
  const span = useMemo(() => settings ? spanFor(period, anchor, settings.cycleStartDay) : null, [period, anchor, settings]);
  useEffect(() => {
    if (!span) return;
    let cancelled = false;
    setLoadedKey("");
    setLoadError("");
    Promise.all([api.listCycleGoals(span.start, span.end), api.listWorkDays(span.start, span.end), api.listWorkDayOverrides(span.start, span.end)])
      .then(([g, d, o]) => { if (!cancelled) { setGoals(g); setDays(d); setOverrides(o); setLoadedKey(`${span.start}/${span.end}/${revision}`); } })
      .catch((error) => { if (!cancelled) { setLoadError(String(error)); setStatus(`读取工作量记录失败：${String(error)}`); } });
    return () => { cancelled = true; };
  }, [span?.start, span?.end, revision]);
  const changed = () => setRevision((value) => value + 1);
  const move = (direction: number) => {
    if (!span || !settings) return;
    if (period === "day") setAnchor(format(addDays(parseISO(anchor), direction), "yyyy-MM-dd"));
    else if (period === "week") setAnchor(format(addWeeks(parseISO(anchor), direction), "yyyy-MM-dd"));
    else setAnchor(format(addDays(parseISO(direction < 0 ? span.start : span.end), direction), "yyyy-MM-dd"));
  };
  if (!settings || !span) return <div className="panel">正在读取工作效率…</div>;
  const cutoff = format(subDays(new Date(), settings.summaryRetentionDays - 1), "yyyy-MM-dd");
  const expired = span.start < cutoff;
  const label = period === "day" ? span.start : `${span.start} — ${span.end}`;
  const activeTypes = types.filter((item) => !item.archived);
  const selectedType = activeTypes.find((item) => item.id === selectedTypeId);
  const ready = loadedKey === `${span.start}/${span.end}/${revision}`;
  return <section className="performance-view">
    <div className="panel performance-toolbar"><div className="insights-tabs">{(["day", "week", "cycle"] as const).map((value) => <button key={value} className={period === value ? "active" : ""} onClick={() => setPeriod(value)}>{value === "day" ? "日" : value === "week" ? "周" : "业绩周期"}</button>)}</div><div className="insights-navigate"><button onClick={() => move(-1)}>上一段</button><strong>{label}</strong><button onClick={() => move(1)} disabled={span.end >= todayDate()}>下一段</button><label className="insights-date">跳转日期<input type="date" value={anchor} onChange={(event) => setAnchor(event.target.value)} /></label><button onClick={() => setAnchor(todayDate())}>回到今天</button></div></div>
    {expired && <p className="performance-warning">部分日期已超出工作量汇总保留期，历史统计不完整；缺失日期不按零产出计算。</p>}
    {!activeTypes.length && <div className="panel insights-empty">先在“设置 → 工作类型”中添加工作，再回来设定周期目标。</div>}
    {ready && activeTypes.length > 0 && <>
      <div className="performance-overview-grid" aria-label="工作项目概览">{activeTypes.map((type) => <WorkOverview key={type.id} type={type} period={period} span={span} days={days} goals={goals} cutoff={cutoff} selected={selectedTypeId === type.id} onSelect={() => setSelectedTypeId(selectedTypeId === type.id ? null : type.id)} />)}</div>
      {selectedType && <WorkReport key={selectedType.id} type={selectedType} period={period} span={span} days={days} goals={goals} overrides={overrides} cutoff={cutoff} expired={expired} changed={changed} setStatus={setStatus} />}
    </>}
    {!ready && activeTypes.length > 0 && <div className="panel insights-empty">{loadError ? `读取工作量失败：${loadError}` : "正在读取工作量…"}</div>}
    <p className="insights-footnote">已完成量由你按天填写；工作时长自动读取关联的打卡分类。不同单位单独比较，不合并为总分。</p>
  </section>;
}

function WorkOverview({ type, period, span, days, goals, cutoff, selected, onSelect }: { type: WorkType; period: Period; span: Span; days: WorkDay[]; goals: CycleGoal[]; cutoff: string; selected: boolean; onSelect: () => void }) {
  const today = todayDate();
  const dates = span.dates.filter((date) => date >= cutoff);
  const actual = dates.filter((date) => date <= today).reduce((sum, date) => sum + (matchDay(days, type.id, date)?.output ?? 0), 0);
  const minutes = dates.filter((date) => date <= today).reduce((sum, date) => sum + (matchDay(days, type.id, date)?.minutes ?? 0), 0);
  const missing = dates.filter((date) => date <= today && (matchDay(days, type.id, date)?.minutes ?? 0) > 0 && matchDay(days, type.id, date)?.output == null).length;
  const goal = period === "cycle" ? goals.find((item) => item.workTypeId === type.id && item.cycleStart === span.start) : undefined;
  const hasAnyGoal = period !== "cycle" && dates.some((date) => !!matchGoal(goals, type.id, date));
  const completePlan = period !== "cycle" && dates.length > 0 && dates.every((date) => !!matchGoal(goals, type.id, date));
  const target = period === "cycle" ? goal?.target : completePlan ? dates.reduce((sum, date) => sum + (matchDay(days, type.id, date)?.planned ?? 0), 0) : undefined;
  const incomplete = span.start < cutoff;
  const progress = !incomplete && target && target > 0 ? actual / target * 100 : null;
  return <button type="button" className={`performance-overview-card${selected ? " selected" : ""}`} style={{ borderLeftColor: type.color }} aria-pressed={selected} onClick={onSelect}>
    <span className="performance-overview-title"><i className="performance-dot" style={{ background: type.color }} /><strong>{type.name}</strong><small>{selected ? "收起详情" : "查看详情"}</small></span>
    <span className="performance-overview-value"><strong>{quantity(actual, type.decimals)} {type.unit}</strong><small>{target === undefined ? hasAnyGoal ? "部分日期未设目标" : "未设目标" : target === 0 ? "休息日" : `/ ${quantity(target, period === "cycle" ? type.decimals : 2)} ${type.unit}`}</small></span>
    <span className="performance-overview-track"><i style={{ width: `${Math.min(100, progress ?? 0)}%`, background: type.color }} /></span>
    <span className="performance-overview-meta">{incomplete ? "历史统计不完整" : progress === null ? "可查看完成量" : `完成 ${quantity(progress, 1)}%`}{` · 投入 ${formatDuration(minutes)}`}{missing > 0 ? ` · ${missing} 天待填写` : ""}</span>
  </button>;
}

function WorkReport({ type, period, span, days, goals, overrides, cutoff, expired, changed, setStatus }: { type: WorkType; period: Period; span: Span; days: WorkDay[]; goals: CycleGoal[]; overrides: WorkDayOverride[]; cutoff: string; expired: boolean; changed: () => void; setStatus: (message: string) => void }) {
  const today = todayDate();
  const records = span.dates.map((date) => ({ date, data: matchDay(days, type.id, date), goal: matchGoal(goals, type.id, date), override: matchOverride(overrides, type.id, date) }));
  const actual = records.filter((row) => row.date >= cutoff && row.date <= today).reduce((sum, row) => sum + (row.data?.output ?? 0), 0);
  const planned = records.filter((row) => row.date >= cutoff).reduce((sum, row) => sum + (row.data?.planned ?? 0), 0);
  const minutes = records.filter((row) => row.date >= cutoff && row.date <= today).reduce((sum, row) => sum + (row.data?.minutes ?? 0), 0);
  const cycleGoal = period === "cycle" ? goals.find((goal) => goal.workTypeId === type.id && goal.cycleStart === span.start) : undefined;
  const plannedDates = records.filter((row) => row.date >= cutoff);
  const missingGoals = plannedDates.some((row) => !row.goal);
  const hasGoal = plannedDates.some((row) => !!row.goal);
  const target = period === "cycle" ? cycleGoal?.target : hasGoal ? planned : undefined;
  const remaining = target === undefined || expired || missingGoals ? null : Math.max(0, target - actual);
  const futureWeight = records.filter((row) => row.date > today && row.date >= cutoff).reduce((sum, row) => sum + dayFactor(type, row.date, row.override), 0);
  const pendingOutputs = records.filter((row) => row.date >= cutoff && row.date <= today && (row.data?.minutes ?? 0) > 0 && (row.data?.output === null || row.data?.output === undefined)).length;
  const hourly = minutes > 0 && pendingOutputs === 0 ? actual / (minutes / 60) : null;
  const rate = hourly === null ? null : hourly / (cycleGoal?.hourlyTarget ?? type.hourlyTarget) * 100;
  return <div className="panel performance-report">
    <div className="panel-head"><div><h2><i className="performance-dot" style={{ background: type.color }} />{type.name}</h2><span className="muted">单位：{type.unit} · 关联 {type.eventTypeIds.length} 个打卡分类</span></div>{period === "cycle" && <GoalEditor type={type} goal={cycleGoal} anchor={span.start} changed={changed} setStatus={setStatus} />}</div>
    <div className="performance-metrics"><div><span>已完成</span><strong>{quantity(actual, type.decimals)} {type.unit}</strong></div><div><span>{period === "cycle" ? "周期目标" : period === "week" ? "本周计划" : "当日计划"}</span><strong>{target === undefined ? "未设置" : `${quantity(target, period === "cycle" ? type.decimals : 2)} ${type.unit}`}</strong>{period !== "cycle" && missingGoals && <small>部分日期未设目标</small>}</div><div><span>尚差</span><strong>{remaining === null ? "—" : `${quantity(remaining, 2)} ${type.unit}`}</strong></div><div><span>投入时间 / 效率</span><strong>{formatDuration(minutes)}</strong><small>{pendingOutputs > 0 ? `${pendingOutputs} 天有打卡但未填完成量` : hourly === null ? "缺少打卡时长" : `${quantity(hourly, 2)} ${type.unit}/小时 · 效率目标 ${Math.round(rate ?? 0)}%`}</small></div></div>
    {period === "day" && !expired && target !== undefined && target > 0 && <p className="performance-pace">当日目标完成率 {records[0].data?.output === null || records[0].data?.output === undefined ? "待填写完成量" : `${quantity(actual / target * 100, 1)}%`}</p>}
    {period === "cycle" && cycleGoal && !expired && <p className="performance-pace">周期完成率 {quantity(actual / cycleGoal.target * 100, 1)}%；{remaining === 0 ? "已完成周期目标" : futureWeight ? `剩余计划工作日平均每正常日需完成 ${quantity((remaining ?? 0) / futureWeight, 2)} ${type.unit}，半天约一半。` : "没有剩余计划工作日，请调整后续安排。"}</p>}
    {period === "day" ? <DayEditor type={type} date={span.start} days={days} goals={goals} overrides={overrides} cutoff={cutoff} changed={changed} setStatus={setStatus} /> : <>
      <CumulativeTrend type={type} rows={records} cutoff={cutoff} />
      <details className="performance-daily-details"><summary><strong>每日明细与填写</strong><span>已记录 {records.filter((row) => row.date >= cutoff && row.date <= today && row.data?.output != null).length} 天 · 点击展开</span></summary>
        <div className="performance-daily-content"><div className="performance-day-list">{records.map((row) => { const unavailable = row.date < cutoff; const future = row.date > today; const rest = dayFactor(type, row.date, row.override) === 0 && !row.override?.customTarget; const value = row.data?.output; const plan = row.data?.planned; return <div className="performance-day-row" key={row.date}><span>{row.date.slice(5)}</span><span>{unavailable ? "已超期" : future ? "未到日期" : rest ? "休息" : value === null || value === undefined ? "未填写" : plan === null || plan === undefined ? "未设目标" : value >= plan ? "已达标" : "未达标"}</span><span>{unavailable ? "—" : value === null || value === undefined ? "—" : `${quantity(value, type.decimals)} ${type.unit}`}</span><span>计划 {plan === null || plan === undefined ? "—" : `${quantity(plan, 2)} ${type.unit}`}</span><button onClick={() => { document.getElementById(`performance-day-${type.id}`)?.scrollIntoView({ behavior: "smooth" }); window.dispatchEvent(new CustomEvent("performance-select-day", { detail: row.date })); }}>查看 / 填写</button></div>; })}</div>
        <div id={`performance-day-${type.id}`}><DayEditor type={type} date={span.start} days={days} goals={goals} overrides={overrides} cutoff={cutoff} changed={changed} setStatus={setStatus} selectable={span.dates} /></div></div>
      </details>
    </>}
  </div>;
}

function GoalEditor({ type, goal, anchor, changed, setStatus }: { type: WorkType; goal?: CycleGoal; anchor: string; changed: () => void; setStatus: (message: string) => void }) {
  const [draft, setDraft] = useState(goal?.target.toString() ?? "");
  useEffect(() => setDraft(goal?.target.toString() ?? ""), [goal?.target, anchor]);
  const save = async () => { try { await api.saveCycleGoal(type.id, anchor, Number(draft)); changed(); setStatus(`${type.name} 的周期目标已保存`); } catch (error) { setStatus(`保存周期目标失败：${String(error)}`); } };
  return <div className="performance-goal-edit"><label>本周期目标<input type="number" min="0.01" step={10 ** -type.decimals} value={draft} placeholder={`填写${type.unit}数`} onChange={(event) => setDraft(event.target.value)} /></label><button className="primary" disabled={!draft || Number(draft) <= 0} onClick={() => void save()}>保存目标</button></div>;
}

function DayEditor({ type, date, days, goals, overrides, cutoff, changed, setStatus, selectable }: { type: WorkType; date: string; days: WorkDay[]; goals: CycleGoal[]; overrides: WorkDayOverride[]; cutoff: string; changed: () => void; setStatus: (message: string) => void; selectable?: string[] }) {
  const [selected, setSelected] = useState(date);
  useEffect(() => setSelected(date), [date]);
  useEffect(() => { const handler = (event: Event) => { const next = (event as CustomEvent<string>).detail; if (selectable?.includes(next)) setSelected(next); }; window.addEventListener("performance-select-day", handler); return () => window.removeEventListener("performance-select-day", handler); }, [selectable?.join(",")]);
  const current = matchDay(days, type.id, selected);
  const goal = matchGoal(goals, type.id, selected);
  const override = matchOverride(overrides, type.id, selected);
  const [output, setOutput] = useState(current?.output?.toString() ?? "");
  const [mode, setMode] = useState<DayMode>(override?.mode ?? "default");
  const [custom, setCustom] = useState(override?.customTarget?.toString() ?? "");
  useEffect(() => { setOutput(current?.output?.toString() ?? ""); setMode(override?.mode ?? "default"); setCustom(override?.customTarget?.toString() ?? ""); }, [selected, current?.output, override?.mode, override?.customTarget]);
  const saveOutput = async () => { try { if (output.trim() === "") await api.deleteWorkOutput(type.id, selected); else await api.saveWorkOutput(type.id, selected, Number(output)); changed(); setStatus(`${type.name} ${selected} 的完成量已保存`); } catch (error) { setStatus(`保存完成量失败：${String(error)}`); } };
  const saveMode = async () => { try { await api.setWorkDayOverride(type.id, selected, mode, mode === "custom" ? Number(custom) : null); changed(); setStatus("当天安排已更新，剩余日期的目标已重新分配"); } catch (error) { setStatus(`调整日目标失败：${String(error)}`); } };
  return <div className="performance-day-editor"><h3>{selected} · {type.name}</h3>{selectable && <label>选择日期<select value={selected} onChange={(event) => setSelected(event.target.value)}>{selectable.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}
    {selected < cutoff ? <p className="muted">已超出工作量汇总保留期限。</p> : <><div className="performance-setting-grid"><label>完成量（{type.unit}）<input type="number" min="0" step={10 ** -type.decimals} value={output} placeholder="未填写" onChange={(event) => setOutput(event.target.value)} /></label><label>当天安排<select value={mode} onChange={(event) => setMode(event.target.value as DayMode)}><option value="default">按每周惯例</option><option value="normal">正常</option><option value="half">半天</option><option value="rest">休息</option><option value="custom">自定义目标</option></select></label>{mode === "custom" && <label>当天目标（{type.unit}）<input type="number" min="0" step={10 ** -type.decimals} value={custom} onChange={(event) => setCustom(event.target.value)} /></label>}</div><div className="performance-actions"><button className="primary" disabled={selected > todayDate()} onClick={() => void saveOutput()}>保存完成量</button><button disabled={selected < todayDate()} onClick={() => void saveMode()}>保存当天安排</button></div>{selected < todayDate() && <p className="muted">过去日期的计划已固定；完成量仍可补录。</p>}<p className="muted">投入 {formatDuration(current?.minutes ?? 0)} · 计划 {current?.planned === null || current?.planned === undefined ? "未设置" : `${quantity(current.planned, 2)} ${type.unit}`} {goal && `· 周期目标 ${quantity(goal.target, type.decimals)} ${type.unit}`}</p></>}
  </div>;
}

function CumulativeTrend({ type, rows, cutoff }: { type: WorkType; rows: Array<{ date: string; data?: WorkDay; goal?: CycleGoal }>; cutoff: string }) {
  let actual = 0, planned = 0;
  const points = rows.map((row, index) => { if (row.date >= cutoff && row.date <= todayDate()) actual += row.data?.output ?? 0; if (row.date >= cutoff) planned += row.data?.planned ?? 0; return { x: 48 + index * 810 / Math.max(1, rows.length - 1), actual, planned, date: row.date, available: row.date >= cutoff && row.date <= todayDate() }; });
  const max = Math.max(1, ...points.map((point) => Math.max(point.actual, point.planned)));
  const y = (value: number) => 158 - value / max * 124;
  const actualLine = points.filter((point) => point.available).map((point) => `${point.x},${y(point.actual)}`).join(" ");
  const planLine = points.filter((point) => point.date >= cutoff).map((point) => `${point.x},${y(point.planned)}`).join(" ");
  return <div className="performance-chart"><div className="performance-chart-legend"><span><i style={{ background: type.color }} />累计已完成</span><span><i style={{ background: "#94a3b8" }} />累计计划</span></div><svg viewBox="0 0 900 190" role="img" aria-label={`${type.name}累计已完成量与累计计划量走势`}><line x1="48" y1="158" x2="858" y2="158" stroke="#cbd5e1" /><line x1="48" y1="34" x2="48" y2="158" stroke="#cbd5e1" /><text x="40" y="38" textAnchor="end" fontSize="11" fill="#64748b">{quantity(max, type.decimals)}</text><text x="40" y="160" textAnchor="end" fontSize="11" fill="#64748b">0</text>{planLine && <polyline points={planLine} fill="none" stroke="#94a3b8" strokeWidth="2.5" strokeDasharray="6 4" />}{actualLine && <polyline points={actualLine} fill="none" stroke={type.color} strokeWidth="3" />}{points.map((point, index) => index === 0 || index === points.length - 1 || rows.length <= 7 || index % 5 === 0 ? <text key={point.date} x={point.x} y="182" textAnchor="middle" fontSize="10" fill="#64748b">{point.date.slice(5)}</text> : null)}</svg></div>;
}
