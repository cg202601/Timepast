import React, { useEffect, useRef, useState } from "react";
import { currentMonitor, getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { Check, Maximize2, Pin, Play, Plus, Square, StickyNote } from "lucide-react";
import { api } from "../lib/api";
import type { ActiveTimer, EventType } from "../lib/types";

type MiniBarProps = {
  events: EventType[]; activeTimer: ActiveTimer | null; alwaysOnTop: boolean; edgeHide: boolean; opacity: number;
  onAlwaysOnTopChange: (value: boolean) => void; onEdgeHideChange: (value: boolean) => void; onOpacityChange: (value: number) => void;
  onStart: (event: EventType, note: string) => void; onStop: () => void; onNote: () => void; onAddEvent: (name: string) => Promise<number>; onExpand: () => void;
};
type Edge = "top" | "right" | "bottom" | "left";
type WorkArea = { x: number; y: number; width: number; height: number };
const edgeThreshold = 18;
const revealSize = 14;

export function MiniBar({ events, activeTimer, alwaysOnTop, edgeHide, opacity, onAlwaysOnTopChange, onEdgeHideChange, onOpacityChange, onStart, onStop, onNote, onAddEvent, onExpand }: MiniBarProps) {
  const [selectedId, setSelectedId] = useState(0);
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false);
  const [newEventName, setNewEventName] = useState("");
  const [addError, setAddError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const hiddenRef = useRef(false);
  const edgeHideRef = useRef(edgeHide);
  const restorePositionRef = useRef<PhysicalPosition | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const suppressHideUntilRef = useRef(0);
  const menuOpenRef = useRef(false);

  useEffect(() => {
    edgeHideRef.current = edgeHide;
    if (!edgeHide && hiddenRef.current) void revealFromEdge();
  }, [edgeHide]);
  useEffect(() => {
    menuOpenRef.current = menuOpen;
    if (menuOpen) clearHideTimer();
  }, [menuOpen]);
  useEffect(() => {
    if (!events.some((item) => item.id === selectedId)) setSelectedId(events[0]?.id || 0);
  }, [events, selectedId]);
  useEffect(() => {
    const windowRef = getCurrentWindow();
    const pending = windowRef.onMoved(async () => {
      if (hiddenRef.current) return;
      const position = await windowRef.outerPosition();
      const size = await windowRef.outerSize();
      const area = await workArea();
      if (area && !nearestEdge(position, size, area)) {
        restorePositionRef.current = null;
        suppressHideUntilRef.current = Date.now() + 800;
        clearHideTimer();
      }
      await api.saveWindowGeometry("mini-window", position.x, position.y, size.width, size.height);
    });
    return () => { clearHideTimer(); pending.then((off) => off()).catch(() => undefined); };
  }, []);

  const selected = events.find((item) => item.id === selectedId);
  const drag = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!(event.target as HTMLElement).closest("button,select,input,label,.mini-context-menu")) getCurrentWindow().startDragging().catch(() => undefined);
  };
  const saveNewEvent = async () => {
    if (!newEventName.trim()) { setAddError("请输入事件名称"); return; }
    try {
      const id = await onAddEvent(newEventName);
      setSelectedId(id); setNewEventName(""); setAddError(""); setAdding(false);
    } catch (error) { setAddError(String(error).replace(/^Error:\s*/, "") || "保存失败"); }
  };
  const workArea = async (): Promise<WorkArea | null> => {
    const monitor = await currentMonitor().catch(() => null);
    return monitor ? { x: monitor.workArea.position.x, y: monitor.workArea.position.y, width: monitor.workArea.size.width, height: monitor.workArea.size.height } : null;
  };
  const nearestEdge = (position: PhysicalPosition, size: { width: number; height: number }, area: WorkArea): Edge | null => {
    const distances: Array<[Edge, number]> = [["top", Math.abs(position.y - area.y)], ["right", Math.abs(area.x + area.width - (position.x + size.width))], ["bottom", Math.abs(area.y + area.height - (position.y + size.height))], ["left", Math.abs(position.x - area.x)]];
    const [edge, distance] = distances.sort((left, right) => left[1] - right[1])[0];
    return distance <= edgeThreshold ? edge : null;
  };
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  const hiddenPosition = (edge: Edge, position: PhysicalPosition, size: { width: number; height: number }, area: WorkArea) => {
    const x = clamp(position.x, area.x, area.x + area.width - size.width);
    const y = clamp(position.y, area.y, area.y + area.height - size.height);
    if (edge === "top") return new PhysicalPosition(x, area.y - size.height + revealSize);
    if (edge === "right") return new PhysicalPosition(area.x + area.width - revealSize, y);
    if (edge === "bottom") return new PhysicalPosition(x, area.y + area.height - revealSize);
    return new PhysicalPosition(area.x - size.width + revealSize, y);
  };
  function clearHideTimer() { if (hideTimerRef.current !== null) { window.clearTimeout(hideTimerRef.current); hideTimerRef.current = null; } }
  function scheduleHideToEdge() {
    clearHideTimer();
    if (!edgeHideRef.current || adding || menuOpenRef.current) return;
    const delay = Math.max(260, suppressHideUntilRef.current - Date.now() + 260);
    hideTimerRef.current = window.setTimeout(hideToEdge, delay);
  }
  async function hideToEdge() {
    if (!edgeHideRef.current || hiddenRef.current || adding || menuOpenRef.current || Date.now() < suppressHideUntilRef.current) return;
    const area = await workArea();
    if (!area) return;
    const windowRef = getCurrentWindow();
    const position = await windowRef.outerPosition();
    const size = await windowRef.outerSize();
    const edge = nearestEdge(position, size, area);
    if (!edge) return;
    restorePositionRef.current = position; hiddenRef.current = true;
    await api.saveWindowGeometry("mini-window", position.x, position.y, size.width, size.height).catch(() => undefined);
    await windowRef.setPosition(hiddenPosition(edge, position, size, area)).catch(() => undefined);
  }
  async function revealFromEdge() {
    clearHideTimer();
    const position = restorePositionRef.current;
    if (!hiddenRef.current || !position) return;
    suppressHideUntilRef.current = Date.now() + 800; hiddenRef.current = false;
    await getCurrentWindow().setPosition(position).catch(() => undefined);
  }

  return <div className="mini-bar" style={{ opacity: opacity / 100 }} data-tauri-drag-region onMouseDown={drag} onMouseEnter={() => void revealFromEdge()} onMouseLeave={scheduleHideToEdge} onContextMenu={(event) => { event.preventDefault(); clearHideTimer(); setMenuOpen(true); }}>
    <div className="mini-brand">T</div>
    {adding ? <input className="mini-add-input" autoFocus value={newEventName} placeholder="事件名称" title={addError || "事件名称"} onChange={(event) => { setNewEventName(event.target.value); setAddError(""); }} onKeyDown={(event) => { if (event.key === "Enter") void saveNewEvent(); if (event.key === "Escape") setAdding(false); }} /> : <select value={selectedId} disabled={!!activeTimer} onChange={(event) => setSelectedId(Number(event.target.value))}>{events.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
    <input className="mini-note-input" value={note} disabled={!!activeTimer || adding} placeholder="备注" aria-label="打卡备注" onChange={(event) => setNote(event.target.value)} />
    {adding ? <button className="primary" title="保存事件" onClick={() => void saveNewEvent()}><Check size={15} /></button> : <button title="添加事件" onClick={() => setAdding(true)} disabled={!!activeTimer}><Plus size={15} /></button>}
    {activeTimer ? <button className="danger" title="结束打卡" onClick={onStop}><Square size={15} /></button> : <button className="primary" title="开始打卡" disabled={!selected || adding} onClick={() => selected && onStart(selected, note)}><Play size={15} /></button>}
    <button title="新建桌面便签" onClick={onNote}><StickyNote size={15} /></button>
    <button className={alwaysOnTop ? "active" : ""} title={alwaysOnTop ? "取消小条置顶" : "小条置顶"} onClick={() => onAlwaysOnTopChange(!alwaysOnTop)}><Pin size={15} className={alwaysOnTop ? "filled" : ""} /></button>
    <button title="展开主程序" onClick={onExpand}><Maximize2 size={15} /></button>
    {menuOpen && <div className="mini-context-menu" role="menu" onMouseDown={(event) => event.stopPropagation()}><label>透明度<input type="range" min="45" max="100" value={opacity} onChange={(event) => onOpacityChange(Number(event.target.value))} /></label><label><input type="checkbox" checked={edgeHide} onChange={(event) => onEdgeHideChange(event.target.checked)} />贴边隐藏</label><button type="button" onClick={() => setMenuOpen(false)}>完成</button></div>}
  </div>;
}
