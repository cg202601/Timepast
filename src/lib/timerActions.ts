import { api } from "./api";
import { isoToDateInput, isoToTimeInput } from "./time";
import type { ActiveTimer } from "./types";

export async function finishActiveTimer(
  timer: ActiveTimer,
  setActiveTimer: (value: ActiveTimer | null) => void,
  refresh: () => Promise<void>,
  setStatus: (value: string) => void
) {
  const start = new Date(timer.startedAt);
  const end = new Date();
  if (end.getTime() - start.getTime() < 60000) end.setTime(start.getTime() + 60000);

  await api.saveTimeEntry({
    entryDate: isoToDateInput(start.toISOString()),
    startTime: isoToTimeInput(start.toISOString()),
    endTime: isoToTimeInput(end.toISOString()),
    eventTypeId: timer.eventTypeId,
    note: timer.note || "",
    sourceMode: "timer"
  });
  setActiveTimer(null);
  try {
    await refresh();
    setStatus("半自动打卡已保存");
  } catch (error) {
    setStatus(`打卡已保存，但列表刷新失败：${String(error)}`);
  }
}
