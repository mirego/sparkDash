import { useEffect, useRef, useState } from "react";
import { fetchRequestActivity } from "../api/client";
import type { RequestActivity } from "../api/types";

const POLL_MS = 3_000;

export function useRequestActivity() {
  const [data, setData] = useState<RequestActivity | null>(null);
  const [loading, setLoading] = useState(true);
  const [clientError, setClientError] = useState(false);
  const [endedSignal, setEndedSignal] = useState(0);
  const previous = useRef<{ eventId: number | null; keys: Set<string> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const load = async () => {
      try {
        const next = await fetchRequestActivity();
        if (cancelled) return;
        const before = previous.current;
        if (before) {
          const eventChanged = next.lastRequestEventId !== before.eventId;
          const rowDisappeared = [...before.keys].some((key) => !next.requests.some((row) => row.key === key));
          if (eventChanged || rowDisappeared) setEndedSignal((n) => n + 1);
        }
        previous.current = { eventId: next.lastRequestEventId, keys: new Set(next.requests.map((row) => row.key)) };
        setData(next);
        setClientError(false);
      } catch {
        if (!cancelled) setClientError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const stop = () => {
      if (timer != null) clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      if (timer == null) timer = setInterval(() => void load(), POLL_MS);
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        void load();
        start();
      }
    };

    void load();
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return { data, loading, clientError, endedSignal };
}
