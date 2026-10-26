"use client";

import { fmtClock, restTimer, useRestTimer } from "@/lib/restTimer";
import { useRestTimerPush } from "@/lib/restTimerPushClient";

export function RestTimer() {
  const { timer, remaining } = useRestTimer();
  // Push when rest ends with the app closed (opt-in, Profile > Reminders).
  useRestTimerPush();
  if (!timer) return null;
  const done = remaining === 0;
  const pct = Math.min(100, ((timer.total - remaining) / timer.total) * 100);

  return (
    <div className="fixed inset-x-0 bottom-3 z-30 px-4 pb-safe pointer-events-none">
      <div
        className={`pointer-events-auto max-w-lg mx-auto rounded-2xl border overflow-hidden ${
          done ? "bg-accent text-accent-ink border-accent animate-pulse" : "bg-surface-2 border-border"
        }`}
      >
        <div className="relative">
          {!done && <div className="absolute inset-y-0 left-0 bg-accent/15" style={{ width: `${pct}%` }} />}
          <div className="relative flex items-center gap-2 px-3 py-2.5">
            <div className="flex-1">
              <p className={`text-[11px] uppercase tracking-wide ${done ? "" : "text-muted"}`}>
                {done ? "Rest over — next set!" : timer.label}
              </p>
              <p className="text-2xl font-bold tabular-nums">{fmtClock(remaining)}</p>
            </div>
            {!done && (
              <>
                <button className="chip" onClick={() => restTimer.add(-15)}>−15s</button>
                <button className="chip" onClick={() => restTimer.add(15)}>+15s</button>
              </>
            )}
            <button className={done ? "chip border-accent-ink" : "chip"} onClick={() => restTimer.stop()}>
              {done ? "OK" : "Skip"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
