import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { Bold, CheckSquare, ChevronDown, ChevronUp, Highlighter, Minus, Palette, Pin, Plus, Type, X } from "lucide-react";
import { api } from "./lib/api";
import { isDesktopNoteCollapsed, noteTitle, withNoteTitle, writeNoteMeta } from "./lib/noteMeta";
import { NoteSaveQueue } from "./lib/noteSaveQueue";
import { insertHtmlAtSelection, insertSanitizedDrop, normalizeStoredRichText, sanitizeClipboardHtml } from "./lib/richText";
import type { StickyNote as NoteType } from "./lib/types";
import "./styles.css";

const noteColors = [
  { bg: "#fff7c2", name: "柠檬黄" },
  { bg: "#dbeafe", name: "天空蓝" },
  { bg: "#dcfce7", name: "薄荷绿" },
  { bg: "#fde2e2", name: "玫瑰粉" },
  { bg: "#f3e8ff", name: "薰衣紫" },
  { bg: "#f8fafc", name: "银灰" }
];


function NoteWindow() {
  const noteId = Number(new URLSearchParams(window.location.search).get("noteId") ?? 0);
  const [note, setNote] = useState<NoteType | null>(null);
  const [error, setError] = useState(noteId > 0 ? "" : "便签编号无效");
  const [showColors, setShowColors] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const [textColor, setTextColor] = useState("#273244");
  const [title, setTitle] = useState("便签");
  const [editingTitle, setEditingTitle] = useState(false);
  const [desktopCollapsed, setDesktopCollapsed] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const ignoreNextSyncRef = useRef(false);
  const latestNoteRef = useRef<NoteType | null>(null);
  const titleRef = useRef(title);
  titleRef.current = title;
  const closingRef = useRef(false);
  const allowCloseRef = useRef(false);
  const saveQueueRef = useRef<NoteSaveQueue<NoteType> | null>(null);
  if (!saveQueueRef.current) {
    saveQueueRef.current = new NoteSaveQueue<NoteType>(async (next) => {
      ignoreNextSyncRef.current = true;
      try {
        await api.saveNote(next);
      } catch (error) {
        ignoreNextSyncRef.current = false;
        throw error;
      }
    });
  }

  function rangeIsInEditor(range: Range) {
    const editor = editorRef.current;
    return !!editor && editor.contains(range.commonAncestorContainer);
  }

  function rememberSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (rangeIsInEditor(range)) savedRangeRef.current = range.cloneRange();
  }

  function restoreSelection() {
    const range = savedRangeRef.current;
    const editor = editorRef.current;
    if (!range || !editor || !rangeIsInEditor(range)) return null;
    editor.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return range.cloneRange();
  }

  function activeRange() {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (rangeIsInEditor(range)) {
        savedRangeRef.current = range.cloneRange();
        return range.cloneRange();
      }
    }
    return restoreSelection();
  }

  function schedulePersist(next: NoteType, statusDelay = 360) {
    latestNoteRef.current = next;
    setSaveStatus("保存中");
    saveQueueRef.current!.schedule(next, statusDelay);
  }

  async function flushCurrentNote() {
    const current = latestNoteRef.current;
    if (current) {
      const content = editorRef.current?.innerHTML ?? current.content;
      const title = titleRef.current;
      if (content !== current.content || title !== noteTitle(current)) {
        const next = {
          ...current,
          content,
          styleJson: withNoteTitle(current, title)
        };
        latestNoteRef.current = next;
        saveQueueRef.current!.schedule(next, 0);
      }
    }
    await saveQueueRef.current!.flush();
  }

  async function applyLoadedNote(found: NoteType) {
    const normalized = { ...found, content: normalizeStoredRichText(found.content) };
    const collapsed = isDesktopNoteCollapsed(normalized);
    latestNoteRef.current = normalized;
    setNote(normalized);
    setTitle(noteTitle(normalized));
    setDesktopCollapsed(collapsed);
    await getCurrentWindow().setSize(new LogicalSize(normalized.width, collapsed ? 42 : normalized.height)).catch(() => undefined);
    requestAnimationFrame(() => {
      if (editorRef.current && editorRef.current.innerHTML !== normalized.content) {
        editorRef.current.innerHTML = normalized.content;
      }
    });
  }

  useEffect(() => {
    if (noteId <= 0) {
      emit("note-ready").catch(() => undefined);
      return;
    }

    api
      .getNote(noteId)
      .then(async (found) => {
        await applyLoadedNote(found);
        emit("note-ready").catch(() => undefined);
      })
      .catch((err) => {
        setError(String(err));
        emit("note-ready").catch(() => undefined);
      });
  }, [noteId]);

  useEffect(() => {
    const unlisten = listen<number>("note-changed", (event) => {
      if (event.payload !== noteId) return;
      if (ignoreNextSyncRef.current) {
        ignoreNextSyncRef.current = false;
        return;
      }
      api.getNote(noteId).then(applyLoadedNote).catch(() => undefined);
    });

    return () => {
      unlisten.then((fn) => fn()).catch(() => undefined);
    };
  }, [noteId]);

  useEffect(() => {
    const queue = saveQueueRef.current!;
    queue.onSaved = () => {
      setSaveStatus("已保存");
      window.setTimeout(() => setSaveStatus(""), 800);
    };
    queue.onError = () => setSaveStatus("保存失败");
    const closeListener = getCurrentWindow().onCloseRequested((event) => {
      if (allowCloseRef.current) return;
      event.preventDefault();
      void closeWindow();
    });
    const flushListener = listen<{ token: string }>("note-flush-request", async ({ payload }) => {
      try {
        await flushCurrentNote();
        await emitTo("main", "note-flush-result", { token: payload.token, label: getCurrentWindow().label });
      } catch (error) {
        await emitTo("main", "note-flush-result", { token: payload.token, label: getCurrentWindow().label, error: String(error) });
      }
    });
    return () => {
      closeListener.then((off) => off()).catch(() => undefined);
      flushListener.then((off) => off()).catch(() => undefined);
    };
  }, []);

  const savePatch = useCallback((patch: Partial<NoteType>) => {
    const current = latestNoteRef.current;
    if (!current) return;
    const next = { ...current, ...patch };
    latestNoteRef.current = next;
    setNote(next);
    schedulePersist(next);
  }, []);

  function saveEditorContent() {
    const current = latestNoteRef.current;
    if (!current) return;
    const next = { ...current, content: editorRef.current?.innerHTML ?? "" };
    latestNoteRef.current = next;
    schedulePersist(next, 480);
  }

  function keepSelection(event: React.MouseEvent<HTMLElement>) {
    event.preventDefault();
    restoreSelection();
  }

  function selectAfter(node: Node) {
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    savedRangeRef.current = range.cloneRange();
  }

  function applyTextColor(color: string) {
    restoreSelection();
    document.execCommand("foreColor", false, color);
    saveEditorContent();
  }
  function formatSelection(command: "bold" | "hiliteColor", value?: string) {
    const editor = editorRef.current;
    if (!editor) return;
    activeRange();
    restoreSelection();
    document.execCommand(command, false, value);
    saveEditorContent();
  }

  function handlePaste(event: React.ClipboardEvent<HTMLDivElement>) {
    const editor = editorRef.current;
    if (!editor) return;
    event.preventDefault();
    const html = event.clipboardData.getData("text/html");
    const text = event.clipboardData.getData("text/plain");
    restoreSelection();
    insertHtmlAtSelection(editor, html ? sanitizeClipboardHtml(html, text) : sanitizeClipboardHtml("", text));
    rememberSelection();
    saveEditorContent();
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const editor = editorRef.current;
    if (!editor) return;
    if (insertSanitizedDrop(editor, event.dataTransfer, event.clientX, event.clientY)) {
      rememberSelection();
      saveEditorContent();
    }
  }

  async function togglePin() {
    const current = latestNoteRef.current;
    if (!current) return;
    const nextPinned = !current.pinned;
    savePatch({ pinned: nextPinned });
    await api.setNoteAlwaysOnTop(noteId, nextPinned).catch(() => undefined);
  }

  async function toggleCollapse() {
    const current = latestNoteRef.current;
    if (!current) return;
    const collapsed = !desktopCollapsed;
    setDesktopCollapsed(collapsed);
    savePatch({ styleJson: writeNoteMeta(current, { desktopCollapsed: collapsed }) });
    await getCurrentWindow().setSize(new LogicalSize(current.width, collapsed ? 42 : current.height)).catch(() => undefined);
  }

  function finishTitleEdit() {
    if (!note) return;
    savePatch({ styleJson: withNoteTitle(note, title) });
    setEditingTitle(false);
  }

  async function closeWindow() {
    if (closingRef.current) return;
    closingRef.current = true;
    setSaveStatus("保存中");
    try {
      await flushCurrentNote();
      allowCloseRef.current = true;
      await getCurrentWindow().close();
    } catch (error) {
      allowCloseRef.current = false;
      closingRef.current = false;
      setSaveStatus(`保存失败：${String(error)}`);
    }
  }

  function insertTodoCheck() {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const line = document.createElement("div");
    line.className = "todo-line";
    const checkbox = document.createElement("span");
    checkbox.className = "todo-check";
    checkbox.contentEditable = "false";
    const label = document.createElement("span");
    label.textContent = "待办";
    line.append(checkbox, label);
    editor.appendChild(line);
    selectAfter(label);
    saveEditorContent();
  }

  function handleEditorKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Backspace") return;
    const selection = window.getSelection();
    if (!selection?.isCollapsed || selection.anchorOffset !== 0) return;
    const node = selection.anchorNode;
    const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node as HTMLElement | null;
    const line = element?.closest(".todo-line");
    if (!line) return;
    event.preventDefault();
    line.remove();
    saveEditorContent();
  }
  function handleEditorClick(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const checkbox = target.closest(".todo-check");
    if (!checkbox) return;
    event.preventDefault();
    checkbox.classList.toggle("checked");
    saveEditorContent();
  }

  if (error) return <div className="desktop-note loading">{error}</div>;
  if (!note) return <div className="desktop-note loading">加载便签...</div>;

  return (
    <div className={desktopCollapsed ? "desktop-note collapsed" : "desktop-note"} style={{ background: note.color }}>
      <div className="desktop-note-head" data-tauri-drag-region>
        <div className="desktop-note-head-left" data-tauri-drag-region>
          {editingTitle ? <input className="desktop-note-title" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} onBlur={finishTitleEdit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setTitle(noteTitle(note)); setEditingTitle(false); } }} aria-label="便签名称" /> : <span className={`desktop-note-title-display ${title.trim() ? "" : "untitled"}`} title="双击修改名称" onDoubleClick={() => setEditingTitle(true)}>{title.trim() || "未命名便签"}</span>}
          {saveStatus && <span className="desktop-note-status">{saveStatus}</span>}
        </div>
        <div className="desktop-note-head-actions">
          <button onMouseDown={keepSelection} onClick={toggleCollapse} title={desktopCollapsed ? "展开便签" : "收缩便签"}>
            {desktopCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
          <button onMouseDown={keepSelection} onClick={togglePin} className={note.pinned ? "active" : ""} title={note.pinned ? "取消置顶" : "置顶"}>
            <Pin size={14} className={note.pinned ? "filled" : ""} />
          </button>
          <button onMouseDown={keepSelection} onClick={closeWindow} title="关闭" className="close-btn">
            <X size={14} />
          </button>
        </div>
      </div>

      <div
        ref={editorRef}
        className="desktop-note-editor rich-editor"
        contentEditable
        suppressContentEditableWarning
        onInput={saveEditorContent}
        onBlur={saveEditorContent}
        onClick={handleEditorClick}
        onPaste={handlePaste}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
        onDrop={handleDrop}
        onMouseUp={rememberSelection}
        onKeyUp={rememberSelection}
        onKeyDown={handleEditorKeyDown}
        data-placeholder="在这里写便签..."
        style={{ fontSize: note.fontSize }}
      />

      <div className="desktop-note-toolbar">
        <div className="desktop-note-tools-left">
          <button onMouseDown={keepSelection} onClick={() => savePatch({ fontSize: Math.max(12, note.fontSize - 1) })} title="缩小字体">
            <Type size={14} /><Minus size={11} />
          </button>
          <span className="font-size-display">{note.fontSize}</span>
          <button onMouseDown={keepSelection} onClick={() => savePatch({ fontSize: Math.min(24, note.fontSize + 1) })} title="放大字体">
            <Type size={14} /><Plus size={11} />
          </button>
          <span className="tool-divider" />
          <button onMouseDown={keepSelection} onClick={() => formatSelection("bold")} title="加粗">
            <Bold size={14} />
          </button>
          <button onMouseDown={keepSelection} onClick={() => formatSelection("hiliteColor", "#fff59d")} title="标注重点">
            <Highlighter size={14} />
          </button>
          <label className="font-color" title="字体颜色">
            <Palette size={14} />
            <input
              type="color"
              value={textColor}
              onMouseDown={keepSelection}
              onChange={(event) => {
                setTextColor(event.target.value);
                applyTextColor(event.target.value);
              }}
            />
          </label>
          <button onMouseDown={(event) => { keepSelection(event); insertTodoCheck(); }} title="另起一行添加待办">
            <CheckSquare size={14} />
          </button>
        </div>

        <div className="desktop-note-tools-right">
          <div className="color-picker-wrap">
            <button onMouseDown={keepSelection} className="color-trigger" onClick={() => setShowColors((value) => !value)} title="更换颜色">
              <Palette size={14} />
              <span className="color-dot" style={{ background: note.color }} />
            </button>
            {showColors && (
              <div className="color-popup">
                {noteColors.map((color) => (
                  <button
                    key={color.bg}
                    onMouseDown={keepSelection}
                    className={`swatch ${note.color === color.bg ? "active" : ""}`}
                    style={{ background: color.bg }}
                    onClick={() => {
                      savePatch({ color: color.bg });
                      setShowColors(false);
                    }}
                    title={color.name}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("note-root")!).render(<NoteWindow />);






