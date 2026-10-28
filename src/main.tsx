import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, ChevronDown, Clock3, Edit3, LayoutDashboard, Maximize2, Minimize2, Palette, Pin, Play, Plus, Settings, Square, StickyNote, Trash2 } from "lucide-react";
import { MiniBar } from "./components/MiniBar";
import { EntryList } from "./features/entries/EntryList";
import { useActiveTimer } from "./hooks/useActiveTimer";
import { useAppData } from "./hooks/useAppData";
import { api } from "./lib/api";
import { isAppNoteCollapsed, noteTitle, withAppNoteCollapsed, withNoteTitle } from "./lib/noteMeta";
import { insertHtmlAtSelection, normalizeStoredRichText, sanitizeClipboardHtml } from "./lib/richText";
import { finishActiveTimer } from "./lib/timerActions";
import { currentTime, formatDuration, isoToTimeInput, minutesBetween, normalizeDateInput, todayDate } from "./lib/time";
import type { ActiveTimer, EventType, StickyNote as Note, TimeEntry, TimeEntryInput, ViewKey } from "./lib/types";
import "./styles.css";

const noteColors = ["#fff7c2", "#dbeafe", "#dcfce7", "#fde2e2", "#f3e8ff", "#f8fafc"];
const views: Array<{ key: ViewKey; label: string; icon: React.ReactNode }> = [
  { key: "today", label: "今日", icon: <LayoutDashboard size={18} /> },
  { key: "entries", label: "打卡记录", icon: <Clock3 size={18} /> },
  { key: "notes", label: "桌贴便签", icon: <StickyNote size={18} /> },
  { key: "settings", label: "设置", icon: <Settings size={18} /> }
];

function plainText(content: string) {
  const node = document.createElement("div");
  node.innerHTML = normalizeStoredRichText(content);
  return (node.textContent || content).replace(/\s+/g, " ").trim();
}

function App() {
  const [view, setView] = useState<ViewKey>("today");
  const [mini, setMini] = useState(false);
  const [status, setStatus] = useState("");
  const handleDataError = useCallback((message: string) => setStatus(message), []);
  const { eventTypes, entries, notes, refresh } = useAppData(handleDataError);
  const [theme, setTheme] = useState(() => localStorage.getItem("timepast.theme") || "light");
  const [brightness, setBrightness] = useState(() => Number(localStorage.getItem("timepast.brightness") || "100"));
  const [miniAlwaysOnTop, setMiniAlwaysOnTop] = useState(() => localStorage.getItem("timepast.miniAlwaysOnTop") !== "false");
  const [miniEdgeHide, setMiniEdgeHide] = useState(() => localStorage.getItem("timepast.miniEdgeHide") === "true");
  const [miniOpacity, setMiniOpacity] = useState(() => Math.min(100, Math.max(45, Number(localStorage.getItem("timepast.miniOpacity") || "100"))));
  const [activeTimer, setActiveTimer] = useActiveTimer();
  useEffect(() => {
    let cancelled = false;
    api.setWindowMode(mini ? "mini" : "full")
      .then(() => {
        if (!mini || cancelled) return undefined;
        return getCurrentWindow().setAlwaysOnTop(miniAlwaysOnTop);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [mini, miniAlwaysOnTop]);
  useEffect(() => { localStorage.setItem("timepast.theme", theme); }, [theme]);
  useEffect(() => { localStorage.setItem("timepast.brightness", String(brightness)); }, [brightness]);
  useEffect(() => { localStorage.setItem("timepast.miniAlwaysOnTop", String(miniAlwaysOnTop)); }, [miniAlwaysOnTop]);
  useEffect(() => { localStorage.setItem("timepast.miniEdgeHide", String(miniEdgeHide)); }, [miniEdgeHide]);
  useEffect(() => { localStorage.setItem("timepast.miniOpacity", String(miniOpacity)); }, [miniOpacity]);

  const activeEvents = eventTypes.filter((item) => !item.archived);
  const quickEvents = activeEvents.filter((item) => item.pinned);
  const startTimer = (event: EventType, note = "") => !activeTimer && setActiveTimer({ eventTypeId: event.id, eventName: event.name, eventColor: event.color, startedAt: new Date().toISOString(), note: note.trim() || undefined });
  const createNote = async (desktop = false) => {
    const id = await api.saveNote({ content: "", color: noteColors[notes.length % noteColors.length], x: 80, y: 80, width: 320, height: 280, collapsed: false, pinned: false, fontSize: 15, styleJson: "{}" });
    await refresh();
    if (desktop) await api.openNoteWindow(id);
    return id;
  };
  const addQuickEvent = async (name: string) => {
    if (!name.trim()) throw new Error("请输入事件名称");
    const id = await api.saveEventType({ id: 0, name: name.trim(), color: "#2563eb", sortOrder: eventTypes.length + 1, pinned: true, archived: false });
    await refresh(); setStatus("已添加快捷事件");
    return id;
  };

  useEffect(() => {
    const noteListener = listen("tray-new-note", () => { createNote(true).catch((error) => setStatus(String(error))); });
    return () => { noteListener.then((off) => off()).catch(() => undefined); };
  }, [notes.length]);

  if (mini) return <MiniBar events={quickEvents.length ? quickEvents : activeEvents} activeTimer={activeTimer} alwaysOnTop={miniAlwaysOnTop} edgeHide={miniEdgeHide} opacity={miniOpacity} onAlwaysOnTopChange={setMiniAlwaysOnTop} onEdgeHideChange={setMiniEdgeHide} onOpacityChange={setMiniOpacity} onStart={startTimer} onStop={() => activeTimer && finishActiveTimer(activeTimer, setActiveTimer, refresh, setStatus)} onNote={() => createNote(true)} onAddEvent={addQuickEvent} onExpand={() => setMini(false)} />;

  return <div className="app" data-theme={theme} style={{ filter: `brightness(${brightness}%)` }}>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">T</div><div><strong>TimePast</strong><span>本地效率台</span></div></div>
      <nav>{views.map((item) => <button key={item.key} className={view === item.key ? "active" : ""} onClick={() => setView(item.key)}>{item.icon}{item.label}</button>)}</nav>
      <button className="mini-toggle" onClick={() => setMini(true)}><Minimize2 size={16} />缩成小条</button>
      <div className="timer-card"><span className="muted">当前打卡</span>{activeTimer ? <><strong style={{ color: activeTimer.eventColor }}>{activeTimer.eventName}</strong><span>{isoToTimeInput(activeTimer.startedAt)} 开始</span><button className="primary" onClick={() => finishActiveTimer(activeTimer, setActiveTimer, refresh, setStatus)}><Square size={15} />结束并保存</button></> : <><strong>未开始</strong><span>从常用事件快速启动</span></>}</div>
    </aside>
    <main className="main">
      <header className="topbar"><div><h1>{views.find((item) => item.key === view)?.label}</h1><p>{status || "记录时间、整理便签，数据只保存在本机。"}</p></div><div className="quick-events">{quickEvents.map((item) => <button className="chip" key={item.id} disabled={!!activeTimer} onClick={() => startTimer(item)}><span style={{ background: item.color }} />{item.name}</button>)}<button onClick={() => setMini(true)}><Minimize2 size={16} />小条</button></div></header>
      {view === "today" && <TodayView entries={entries} notes={notes} events={quickEvents} setView={setView} />}
      {view === "entries" && <EntriesView events={activeEvents} entries={entries} activeTimer={activeTimer} setActiveTimer={setActiveTimer} refresh={refresh} setStatus={setStatus} />}
      {view === "notes" && <NotesView notes={notes} refresh={refresh} createNote={createNote} setStatus={setStatus} />}
      {view === "settings" && <SettingsView events={eventTypes} refresh={refresh} theme={theme} setTheme={setTheme} brightness={brightness} setBrightness={setBrightness} setStatus={setStatus} />}
    </main>
  </div>;
}

function TodayView({ entries, notes, events, setView }: { entries: TimeEntry[]; notes: Note[]; events: EventType[]; setView: (value: ViewKey) => void }) {
  const [selectedDate, setSelectedDate] = useState(todayDate());
  const selectedEntries = entries.filter((item) => item.entryDate === selectedDate);
  const total = selectedEntries.reduce((sum, item) => sum + Math.max(0, minutesBetween(item.startTime, item.endTime)), 0);
  const isToday = selectedDate === todayDate();
  return <section className="grid today-grid"><div className="panel wide"><div className="panel-head"><div><h2>{isToday ? "今日时间" : "历史记录"}</h2><label className="history-date">查看日期<input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></label></div><button onClick={() => setView("entries")}><Plus size={16} />记录</button></div><div className="metric-row"><div><strong>{formatDuration(total)}</strong><span>已记录</span></div><div><strong>{selectedEntries.length}</strong><span>时间段</span></div><div><strong>{events.length}</strong><span>快捷事件</span></div></div><EntryList entries={selectedEntries} compact /></div><div className="panel"><div className="panel-head"><h2>便签预览</h2><button onClick={() => setView("notes")}>打开</button></div>{notes.slice(0, 4).map((item) => <div className="note-preview" key={item.id} style={{ background: item.color }}>{plainText(item.content)}</div>)}</div></section>;
}

function EntriesView({ events, entries, activeTimer, setActiveTimer, refresh, setStatus }: { events: EventType[]; entries: TimeEntry[]; activeTimer: ActiveTimer | null; setActiveTimer: (value: ActiveTimer | null) => void; refresh: () => Promise<void>; setStatus: (value: string) => void }) {
  const [form, setForm] = useState<TimeEntryInput>({ entryDate: todayDate(), startTime: "09:00", endTime: currentTime(), eventTypeId: events[0]?.id || 1, note: "", sourceMode: "manual" });
  useEffect(() => { if (!events.some((item) => item.id === form.eventTypeId) && events[0]) setForm((value) => ({ ...value, eventTypeId: events[0].id })); }, [events, form.eventTypeId]);
  const save = async () => { try { const normalizedForm = { ...form, entryDate: normalizeDateInput(form.entryDate) }; await api.saveTimeEntry(normalizedForm); await refresh(); setForm({ ...normalizedForm, id: undefined, note: "", startTime: normalizedForm.endTime, endTime: currentTime() }); setStatus("打卡记录已保存"); } catch (error) { setStatus(String(error)); } };
  return <section className="grid entry-grid"><div className="panel entry-form"><div className="panel-head"><h2>新增记录</h2><span className="badge">手动 / 半自动</span></div><label>日期<input type="date" value={form.entryDate} onChange={(event) => setForm({ ...form, entryDate: event.target.value })} /></label><label>事件<select value={form.eventTypeId} onChange={(event) => setForm({ ...form, eventTypeId: Number(event.target.value) })}>{events.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="split"><label>开始<input type="time" value={form.startTime} onChange={(event) => setForm({ ...form, startTime: event.target.value })} /></label><label>结束<input type="time" value={form.endTime} onChange={(event) => setForm({ ...form, endTime: event.target.value })} /></label></div><label>备注<textarea value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></label><button className="primary" onClick={save}><Plus size={16} />保存记录</button><div className="divider" />{activeTimer ? <button className="danger" onClick={() => finishActiveTimer(activeTimer, setActiveTimer, refresh, setStatus)}><Square size={16} />结束 {activeTimer.note || activeTimer.eventName}</button> : <button onClick={() => { const event = events.find((item) => item.id === form.eventTypeId); if (event) setActiveTimer({ eventTypeId: event.id, eventName: event.name, eventColor: event.color, startedAt: new Date().toISOString() }); }}><Play size={16} />开始当前事件</button>}</div><div className="panel wide"><div className="panel-head"><h2>记录列表</h2><span className="muted">{entries.length} 条</span></div><EntryList entries={entries} events={events} refresh={refresh} /></div></section>;
}

function NotesView({ notes, refresh, createNote, setStatus }: { notes: Note[]; refresh: () => Promise<void>; createNote: (desktop?: boolean) => Promise<number>; setStatus: (value: string) => void }) {
  const [query, setQuery] = useState("");
  const visible = notes.filter((item) => plainText(item.content).toLowerCase().includes(query.toLowerCase()));
  return <section className="panel notes-panel"><div className="panel-head"><h2>便签板</h2><div className="toolbar"><input value={query} placeholder="搜索便签" onChange={(event) => setQuery(event.target.value)} /><button onClick={() => createNote(true).then(() => setStatus("桌面便签已打开"))}><StickyNote size={16} />桌面便签</button><button className="primary" onClick={() => createNote().then(() => setStatus("应用内便签已创建"))}><Plus size={16} />应用内便签</button></div></div><div className="note-board">{visible.map((note) => <NoteCard key={note.id} note={note} refresh={refresh} setStatus={setStatus} />)}{!visible.length && <Empty text="没有匹配的便签。" />}</div></section>;
}

function NoteCard({ note, refresh, setStatus }: { note: Note; refresh: () => Promise<void>; setStatus: (value: string) => void }) {
  const editorRef = useRef<HTMLDivElement>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const timerRef = useRef<number | null>(null);
  const localRef = useRef(note);
  const editingRef = useRef(false);
  const [fontColor, setFontColor] = useState("#273244");
  const [title, setTitle] = useState(() => noteTitle(note));
  useEffect(() => {
    localRef.current = note;
    setTitle(noteTitle(note));
    const normalizedContent = normalizeStoredRichText(note.content);
    if (editingRef.current || !editorRef.current || editorRef.current.innerHTML === normalizedContent) return;
    editorRef.current.innerHTML = normalizedContent;
  }, [note]);
  const persist = (patch: Partial<Note>, delay = 420) => {
    const next = { ...localRef.current, ...patch };
    localRef.current = next;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => api.saveNote(next).then(() => setStatus("便签已保存")).catch((error) => setStatus(String(error))), delay);
  };
  useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current); }, []);
  const rangeIsInEditor = (range: Range) => !!editorRef.current && editorRef.current.contains(range.commonAncestorContainer);
  const rememberSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (rangeIsInEditor(range)) savedRangeRef.current = range.cloneRange();
  };
  const restoreSelection = () => {
    const range = savedRangeRef.current;
    if (!range || !editorRef.current || !rangeIsInEditor(range)) return;
    editorRef.current.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };
  const preserve = (event: React.MouseEvent<HTMLButtonElement | HTMLInputElement>) => { event.preventDefault(); restoreSelection(); };
  const format = (command: "bold" | "hiliteColor" | "foreColor", value?: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    restoreSelection();
    document.execCommand(command, false, value);
    rememberSelection();
    persist({ content: editor.innerHTML }, 0);
  };
  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const editor = editorRef.current;
    if (!editor) return;
    event.preventDefault();
    const html = event.clipboardData.getData("text/html");
    const text = event.clipboardData.getData("text/plain");
    restoreSelection();
    insertHtmlAtSelection(editor, html ? sanitizeClipboardHtml(html, text) : sanitizeClipboardHtml("", text));
    rememberSelection();
    persist({ content: editor.innerHTML }, 0);
  };
  const addTodoLine = () => { const editor = editorRef.current; if (!editor) return; editor.focus(); editor.insertAdjacentHTML("beforeend", '<div class="todo-line"><span class="todo-check" contenteditable="false"></span><span>待办</span></div>'); persist({ content: editor.innerHTML }, 0); };
  const handleTodoBackspace = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Backspace") return;
    const selection = window.getSelection();
    if (!selection?.isCollapsed || selection.anchorOffset !== 0) return;
    const node = selection.anchorNode;
    const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node as HTMLElement | null;
    const line = element?.closest(".todo-line");
    if (!line) return;
    event.preventDefault();
    line.remove();
    persist({ content: editorRef.current?.innerHTML || "" }, 0);
  };
  return <article className="sticky" style={{ background: note.color, width: note.width, minHeight: isAppNoteCollapsed(note) ? 112 : note.height }}><div className="sticky-head"><label className="sticky-title-wrap"><input value={title} onChange={(event) => setTitle(event.target.value)} onBlur={() => persist({ styleJson: withNoteTitle(localRef.current, title) }, 0)} placeholder="便签名称" aria-label="便签名称" /></label><div className="sticky-actions"><button onClick={() => persist({ pinned: !note.pinned }, 0)} title="置顶"><Pin size={15} className={note.pinned ? "filled" : ""} /></button><button onClick={() => persist({ styleJson: withAppNoteCollapsed(note, !isAppNoteCollapsed(note)) }, 0)} title="收缩应用内便签"><ChevronDown size={15} /></button><button onClick={() => api.openNoteWindow(note.id).then(() => setStatus("桌面便签已打开"))} title="打开桌面窗口"><Maximize2 size={15} /></button><button onClick={async () => { await api.deleteNote(note.id); await refresh(); }} title="删除"><Trash2 size={15} /></button></div></div>{!isAppNoteCollapsed(note) && <><div ref={editorRef} className="sticky-editor rich-editor" contentEditable suppressContentEditableWarning data-placeholder="点击这里编辑便签" style={{ fontSize: note.fontSize }} onFocus={() => { editingRef.current = true; }} onBlur={() => { editingRef.current = false; persist({ content: editorRef.current?.innerHTML || "" }); }} onKeyDown={handleTodoBackspace} onPaste={handlePaste} onMouseUp={rememberSelection} onKeyUp={rememberSelection} onInput={() => persist({ content: editorRef.current?.innerHTML || "" })} onClick={(event) => { const check = (event.target as HTMLElement).closest(".todo-check"); if (check) { check.classList.toggle("checked"); persist({ content: editorRef.current?.innerHTML || "" }, 0); } }} /><div className="sticky-tools">{noteColors.map((color) => <button key={color} className="swatch" style={{ background: color }} onClick={() => persist({ color }, 0)} />)}<button onClick={() => persist({ fontSize: Math.max(12, note.fontSize - 1) }, 0)}>A-</button><button onClick={() => persist({ fontSize: Math.min(24, note.fontSize + 1) }, 0)}>A+</button><button onMouseDown={preserve} onClick={() => format("bold")} title="加粗">B</button><button onMouseDown={preserve} onClick={() => format("hiliteColor", "#fff59d")} title="标注"><Edit3 size={14} /></button><label className="font-color" title="字体颜色"><Palette size={14} /><input type="color" value={fontColor} onMouseDown={preserve} onChange={(event) => { setFontColor(event.target.value); format("foreColor", event.target.value); }} /></label><button onMouseDown={preserve} onClick={addTodoLine} title="另起一行添加待办"><Check size={14} /></button></div></>}</article>;
}

function RetentionSettings({ refresh, setStatus }: { refresh: () => Promise<void>; setStatus: (value: string) => void }) {
  const [activeDays, setActiveDays] = useState<number | null | undefined>(undefined);
  const [days, setDays] = useState(30);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getEntryRetentionDays().then((current) => {
      if (cancelled) return;
      setActiveDays(current);
      setDays(current ?? 30);
    }).catch((error) => setStatus(`读取保留期限失败：${String(error)}`));
    return () => { cancelled = true; };
  }, [setStatus]);

  const apply = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const count = await api.countExpiredEntries(days);
      if (count > 0 && !window.confirm(`设置为保留最近 ${days} 天后，将立即永久删除 ${count} 条更早的打卡记录。确定继续吗？`)) return;
      const deleted = await api.setEntryRetentionDays(days);
      setActiveDays(days);
      await refresh();
      setStatus(deleted > 0 ? `已保留最近 ${days} 天的打卡记录，清理了 ${deleted} 条过期记录` : `打卡记录保留期限已设为 ${days} 天`);
    } catch (error) {
      setStatus(`设置保留期限失败：${String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return <div className="panel"><div className="panel-head"><h2>打卡记录保留期限</h2></div>
    <label>保留最近天数<select value={days} disabled={activeDays === undefined || saving} onChange={(event) => setDays(Number(event.target.value))}>
      {[7, 15, 25, 30].map((value) => <option key={value} value={value}>{value} 天</option>)}
    </select></label>
    <p className="muted">按本机日期计算，包含今天。应用启动和读取记录时会自动清理过期打卡；便签不受影响。</p>
    {activeDays === null && <p className="muted">现有记录尚未启用自动清理。选择期限并应用后，才会清理旧记录。</p>}
    <button className="primary" disabled={activeDays === undefined || saving || activeDays === days} onClick={() => void apply()}>{saving ? "正在设置…" : "应用保留期限"}</button>
  </div>;
}

function SettingsView({ events, refresh, theme, setTheme, brightness, setBrightness, setStatus }: { events: EventType[]; refresh: () => Promise<void>; theme: string; setTheme: (value: string) => void; brightness: number; setBrightness: (value: number) => void; setStatus: (value: string) => void }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#3b82f6");
  const [editingEvent, setEditingEvent] = useState<EventType | null>(null);
  const [autostart, setAutostart] = useState(() => localStorage.getItem("timepast.autostart") === "true");
  const themes = [{ id: "light", label: "明亮" }, { id: "night", label: "灰蓝夜间" }, { id: "tech", label: "科技" }, { id: "cute", label: "可爱" }, { id: "industrial", label: "工业" }];
  const changeAutostart = (enabled: boolean) => { setAutostart(enabled); localStorage.setItem("timepast.autostart", String(enabled)); setStatus(enabled ? "正在开启开机自启" : "正在关闭开机自启"); api.setAutostart(enabled).then(() => setStatus(enabled ? "已开启开机自启" : "已关闭开机自启")).catch((error) => { setAutostart(!enabled); localStorage.setItem("timepast.autostart", String(!enabled)); setStatus(`开机自启设置失败：${String(error)}`); }); };
  return <section className="grid settings-grid">
    <div className="panel"><div className="panel-head"><h2>外观与启动</h2></div><label>界面皮肤<select value={theme} onChange={(event) => setTheme(event.target.value)}>{themes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label>界面亮度<input type="range" min="75" max="115" value={brightness} onChange={(event) => setBrightness(Number(event.target.value))} /><span>{brightness}%</span></label><label className="setting-toggle"><input type="checkbox" checked={autostart} onChange={(event) => changeAutostart(event.target.checked)} />开机自动启动 TimePast</label></div>
    <RetentionSettings refresh={refresh} setStatus={setStatus} />
    <div className="panel"><div className="panel-head"><h2>事件类型</h2></div><label>名称<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>颜色<input type="color" value={color} onChange={(event) => setColor(event.target.value)} /></label><button className="primary" onClick={async () => { if (!name.trim()) return; await api.saveEventType({ id: 0, name, color, sortOrder: events.length + 1, pinned: true, archived: false }); setName(""); await refresh(); }}><Plus size={16} />添加事件</button></div>
    <div className="panel wide"><div className="event-list">{events.map((item) => editingEvent?.id === item.id ? <div className="event-row event-edit" key={item.id}><span className="dot" style={{ background: editingEvent.color }} /><input aria-label="事件名称" value={editingEvent.name} onChange={(event) => setEditingEvent({ ...editingEvent, name: event.target.value })} /><input aria-label="事件颜色" type="color" value={editingEvent.color} onChange={(event) => setEditingEvent({ ...editingEvent, color: event.target.value })} /><button className="primary" onClick={async () => { if (!editingEvent.name.trim()) return; await api.saveEventType({ ...editingEvent, name: editingEvent.name.trim() }); setEditingEvent(null); await refresh(); setStatus("事件已更新"); }}>保存</button><button onClick={() => setEditingEvent(null)}>取消</button></div> : <div className="event-row" key={item.id}><span className="dot" style={{ background: item.color }} /><strong>{item.name}</strong><button onClick={() => setEditingEvent(item)}><Edit3 size={15} />编辑</button><button onClick={async () => { const pinned = !item.pinned; const sortOrder = pinned ? Math.min(0, ...events.filter((event) => event.pinned && event.id !== item.id).map((event) => event.sortOrder)) - 1 : item.sortOrder; await api.saveEventType({ ...item, pinned, archived: pinned ? false : item.archived, sortOrder }); await refresh(); }}><Pin size={15} />{item.pinned ? "取消置顶" : "置顶"}</button><button onClick={async () => { await api.archiveEventType(item.id); await refresh(); }}><Trash2 size={15} />隐藏</button><button className="danger-icon" title="删除事件" onClick={async () => { try { await api.deleteEventType(item.id); await refresh(); setStatus("事件已删除"); } catch (error) { setStatus("无法删除已有打卡记录的事件，请使用隐藏。"); } }}><Trash2 size={15} />删除</button></div>)}</div></div>
  </section>;
}
function Empty({ text }: { text: string }) { return <div className="empty"><span>{text}</span></div>; }
createRoot(document.getElementById("root")!).render(<App />);















