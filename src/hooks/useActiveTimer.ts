import { useCallback, useRef, useState } from "react";
import type { ActiveTimer } from "../lib/types";

const storageKey = "timepast.activeTimer";

export function useActiveTimer() {
  const [activeTimer, setTimer] = useState<ActiveTimer | null>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const activeTimerRef = useRef(activeTimer);

  const setActiveTimer = useCallback((value: ActiveTimer | null) => {
    activeTimerRef.current = value;
    if (value) localStorage.setItem(storageKey, JSON.stringify(value));
    else localStorage.removeItem(storageKey);
    setTimer(value);
  }, []);

  return [activeTimer, setActiveTimer, activeTimerRef] as const;
}
