import { api } from "./api";
import type { StickyNote } from "./types";
import { NoteSaveQueue } from "./saveQueue";

export { NoteSaveQueue } from "./saveQueue";

const appNoteQueues = new Map<number, NoteSaveQueue<StickyNote>>();

export function appNoteQueue(id: number) {
  let queue = appNoteQueues.get(id);
  if (!queue) {
    queue = new NoteSaveQueue<StickyNote>((note) => api.saveNote(note));
    appNoteQueues.set(id, queue);
  }
  return queue;
}

export async function flushAppNotes() {
  await Promise.all([...appNoteQueues.values()].map((queue) => {
    queue.prepareFlush?.();
    return queue.flush();
  }));
}

export async function removeAppNoteQueue(id: number) {
  const queue = appNoteQueues.get(id);
  if (queue) await queue.flush();
  appNoteQueues.delete(id);
}
