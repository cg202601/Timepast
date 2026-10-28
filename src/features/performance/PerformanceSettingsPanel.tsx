import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { cycleFor, datesBetween, entryCutoff } from "../../lib/performance";
import { todayDate } from "../../lib/time";
import type { EventType, PerformanceSettings, WorkType } from "../../lib/types";

const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const blank = (): WorkType => ({ id: 0, name: "", unit: "张", decimals: 0, color: "#2563eb", hourlyTarget: 1, archived: false, eventTypeIds: [], weekFactors: [1, 1, 1, 1, 1, 1, 1] });

export function PerformanceSettingsPanel({ events, setStatus }: { events: EventType[]; setStatus: (message: string) => void }) {
  const [settings, setSettings] = useState<PerformanceSettings | null>(null);
  const [saved, setSaved] = useState<PerformanceSettings | null>(null);
  const [types, setTypes] = useState<WorkType[]>([]);
  const [editing, setEditing] = useState<WorkType | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = async () => { const [s, t] = await Promise.all([api.getPerformanceSettings(), api.listWorkTypes()]); setSettings(s); setSaved(s); setTypes(t); };
  useEffect(() => { void refresh().catch((error) => setStatus(`读取工作效率设置失败：${String(error)}`)); }, []);
  const saveSettings = async () => {
    if (!settings || busy) return;
    setBusy(true);
    try {
      const counts = await api.previewPerformanceRetention(settings);
      if ((counts.entries || counts.summaryDays) && !window.confirm(`将删除 ${counts.entries} 条旧打卡明细、${counts.summaryDays} 天旧工作量汇总，无法恢复。确定继续吗？`)) return;
      await api.savePerformanceSettings(settings);
      await refresh();
      setStatus("周期与保留设置已保存");
    } catch (error) { setStatus(`设置失败：${String(error)}`); } finally { setBusy(false); }
  };
  const saveType = async () => {
    if (!editing || busy) return;
    setBusy(true);
    try { await api.saveWorkType(editing); setEditing(null); setTypes(await api.listWorkTypes()); setStatus("工作类型已保存"); }
    catch (error) { setStatus(`保存工作类型失败：${String(error)}`); } finally { setBusy(false); }
  };
  const archive = async (item: WorkType) => {
    try { await api.saveWorkType({ ...item, archived: !item.archived }); setTypes(await api.listWorkTypes()); setStatus(item.archived ? "工作类型已恢复" : "工作类型已归档，历史仍保留"); }
    catch (error) { setStatus(String(error)); }
  };
  const cycle = settings ? cycleFor(todayDate(), settings.cycleStartDay) : null;
  const cutoff = settings ? entryCutoff(settings, todayDate()) : null;
  return <>
    <div className="panel wide performance-settings"><div className="panel-head"><h2>工作效率与保留期限</h2></div>
      {settings ? <>
        <div className="performance-setting-grid">
          <label>每月业绩周期起始日<input type="number" min="1" max="31" value={settings.cycleStartDay} onChange={(event) => setSettings({ ...settings, cycleStartDay: Number(event.target.value) })} /></label>
          <label>工作量汇总保留<select value={settings.summaryRetentionDays} onChange={(event) => setSettings({ ...settings, summaryRetentionDays: Number(event.target.value) as PerformanceSettings["summaryRetentionDays"] })}>{[31, 90, 180, 365].map((days) => <option key={days} value={days}>{days} 天</option>)}</select></label>
          <label>打卡明细保留方式<select value={settings.entryRetentionMode} onChange={(event) => setSettings({ ...settings, entryRetentionMode: event.target.value as PerformanceSettings["entryRetentionMode"] })}>{settings.entryRetentionMode === "off" && <option value="off">尚未启用清理</option>}<option value="cycle">完整当前业绩周期</option><option value="custom">自定义最近天数</option></select></label>
          {settings.entryRetentionMode === "custom" && <label>自定义天数<input type="number" min="1" max="365" value={settings.entryRetentionDays} onChange={(event) => setSettings({ ...settings, entryRetentionDays: Number(event.target.value) })} /></label>}
        </div>
        <p className="muted">当前周期：{cycle?.start} 至 {cycle?.end}，共 {cycle ? datesBetween(cycle.start, cycle.end).length : 0} 天。月底不足所选日期时从月末开始。</p>
        {cutoff && cycle && cutoff > cycle.start && <p className="performance-warning">自定义期限不能覆盖完整周期；较早的打卡明细会清理，每日工作量汇总按独立期限保存。</p>}
        <button className="primary" disabled={busy || JSON.stringify(settings) === JSON.stringify(saved)} onClick={() => void saveSettings()}>{busy ? "正在保存…" : "保存周期与保留设置"}</button>
      </> : <p className="muted">正在读取设置…</p>}
    </div>
    <div className="panel wide performance-settings"><div className="panel-head"><h2>自定义工作类型</h2><button onClick={() => setEditing(blank())}>添加工作类型</button></div>
      <p className="muted">每种类型独立设置单位和关联分类；不同单位不合并。同一分类关联多个类型时，投入时间会分别计入。</p>
      {types.map((item) => <div className="performance-type-row" key={item.id}><i style={{ background: item.color }} /><strong>{item.name}</strong><span>{item.unit} · 每小时基准 {item.hourlyTarget} {item.unit}</span><span>{item.archived ? "已归档" : "使用中"}</span><button onClick={() => setEditing({ ...item, eventTypeIds: [...item.eventTypeIds], weekFactors: [...item.weekFactors] })}>编辑</button><button onClick={() => void archive(item)}>{item.archived ? "恢复" : "归档"}</button></div>)}
      {!types.length && <p className="muted">还没有工作类型。添加后可为每个周期设定目标。</p>}
      {editing && <div className="performance-editor"><h3>{editing.id ? `编辑 ${editing.name}` : "添加工作类型"}</h3>
        <div className="performance-setting-grid">
          <label>名称<input value={editing.name} maxLength={40} placeholder="例如：剪辑" onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
          <label>产出单位<input value={editing.unit} maxLength={12} placeholder="分钟、张、篇…" onChange={(event) => setEditing({ ...editing, unit: event.target.value })} /></label>
          <label>小数位<select value={editing.decimals} onChange={(event) => setEditing({ ...editing, decimals: Number(event.target.value) })}><option value="0">整数</option><option value="1">1 位</option><option value="2">2 位</option></select></label>
          <label>每小时效率基准<input type="number" min="0.01" step="any" value={editing.hourlyTarget} onChange={(event) => setEditing({ ...editing, hourlyTarget: Number(event.target.value) })} /></label>
          <label>颜色<input type="color" value={editing.color} onChange={(event) => setEditing({ ...editing, color: event.target.value })} /></label>
        </div>
        <div><strong>关联打卡分类</strong><div className="performance-choice-list">{events.map((event) => <label key={event.id}><input type="checkbox" checked={editing.eventTypeIds.includes(event.id)} onChange={(change) => setEditing({ ...editing, eventTypeIds: change.target.checked ? [...editing.eventTypeIds, event.id] : editing.eventTypeIds.filter((id) => id !== event.id) })} />{event.name}</label>)}</div></div>
        <div><strong>每周惯例</strong><div className="performance-week-grid">{weekdays.map((label, index) => <label key={label}>{label}<select value={editing.weekFactors[index]} onChange={(event) => setEditing({ ...editing, weekFactors: editing.weekFactors.map((factor, day) => day === index ? Number(event.target.value) : factor) })}><option value="1">正常</option><option value="0.5">半天</option><option value="0">休息</option></select></label>)}</div></div>
        <div className="performance-actions"><button className="primary" disabled={busy} onClick={() => void saveType()}>保存工作类型</button><button onClick={() => setEditing(null)}>取消</button></div>
      </div>}
    </div>
  </>;
}
