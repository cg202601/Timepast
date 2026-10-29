import { emitTo, listen } from "@tauri-apps/api/event";
import { getAllWindows } from "@tauri-apps/api/window";

type FlushResult = { token: string; label: string; error?: string };

export async function flushDesktopNotes() {
  const labels = (await getAllWindows()).map((item) => item.label).filter((label) => label.startsWith("note-"));
  if (!labels.length) return;

  const token = `${Date.now()}-${Math.random()}`;
  const waiting = new Set(labels);
  let resolveResults!: () => void;
  let rejectResults!: (error: Error) => void;
  const results = new Promise<void>((resolve, reject) => {
    resolveResults = resolve;
    rejectResults = reject;
  });
  void results.catch(() => undefined);
  const unlisten = await listen<FlushResult>("note-flush-result", ({ payload }) => {
    if (payload.token !== token || !waiting.has(payload.label)) return;
    if (payload.error) {
      rejectResults(new Error(`${payload.label} 保存失败：${payload.error}`));
      return;
    }
    waiting.delete(payload.label);
    if (!waiting.size) resolveResults();
  });
  let timer: number | undefined;
  try {
    const timeout = new Promise<void>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error("桌面便签保存超时，请重试退出")), 15000);
    });
    await Promise.all(labels.map((label) => emitTo(label, "note-flush-request", { token })));
    await Promise.race([results, timeout]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    unlisten();
  }
}
