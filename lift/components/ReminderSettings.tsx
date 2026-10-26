"use client";

import { useState } from "react";
import { useSettings } from "@/lib/settings";
import {
  DAY_SHORT,
  formatNext,
  isSkippedToday,
  isSnoozed,
  isValidTime,
  localDateKey,
  nextReminder,
  orderedDays,
  SNOOZE_OPTIONS,
  suggestedReminderTime,
  toggleDayIn,
  toggleSkipToday,
  toggleSnooze,
  updateReminders,
  useMarkedGymDates,
  useRecentWorkoutStarts,
  useReminders,
  type SnoozeMin,
} from "@/lib/reminders";

export const PUSH_UNAVAILABLE =
  "Push notifications are not set up yet. Your reminder schedule is saved on this device and will be used once they are.";

const snoozeLabel = (m: number) => (m < 60 ? `${m} min` : `${m / 60} h`);

/** Profile → Reminders: gym days, time, nudges and Skip / Snooze. Saves on change. */
export function ReminderSettings() {
  const r = useReminders();
  const { weekStart } = useSettings();
  const [notice, setNotice] = useState<string | null>(null);
  const now = new Date();
  const marked = useMarkedGymDates(localDateKey(now));
  const next = nextReminder(r, now, marked);
  const skipped = isSkippedToday(r, now);
  const snoozed = isSnoozed(r, now);
  const suggested = suggestedReminderTime(r, useRecentWorkoutStarts(), now);

  return (
    <div className="space-y-3.5">
      <p className="text-sm text-muted">Reminders follow the days you mark on the This Week strip.</p>
      <div>
        <span className="font-semibold block">Gym days</span>
        <span className="text-xs text-muted block mb-2">Optional usual days, reminded every week as well.</span>
        <div className="grid grid-cols-7 gap-1.5" role="group" aria-label="Gym days">
          {orderedDays(weekStart).map((d) => {
            const on = r.days.includes(d);
            return (
              <button
                key={d}
                type="button"
                role="checkbox"
                aria-checked={on}
                className={on ? "chip-on justify-center px-0 py-2" : "chip justify-center px-0 py-2"}
                onClick={() => void updateReminders((cur) => ({ ...cur, days: toggleDayIn(cur.days, d) }))}
              >
                {DAY_SHORT[d]}
              </button>
            );
          })}
        </div>
      </div>

      <label className="flex items-center justify-between gap-3">
        <span className="font-semibold">Reminder time</span>
        <input
          className="field w-auto"
          type="time"
          value={r.time}
          onChange={(e) => {
            const t = e.target.value;
            if (isValidTime(t)) void updateReminders((cur) => ({ ...cur, time: t }));
          }}
        />
      </label>
      {suggested && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5">
          <span className="text-sm">
            You usually start around <span className="font-semibold">{suggested}</span>.
          </span>
          <button
            type="button"
            className="chip shrink-0 py-1.5"
            onClick={() => void updateReminders((cur) => ({ ...cur, time: suggested }))}
          >
            Use {suggested}
          </button>
        </div>
      )}

      <Switch
        label="You're behind nudge"
        hint="If you're under your weekly sessions goal by Thursday"
        on={r.behindNudge}
        onChange={(v) => void updateReminders((cur) => ({ ...cur, behindNudge: v }))}
      />
      <Switch
        label="Smart reminders"
        hint="Learns your usual training time and nudges an hour after it"
        on={r.smart}
        onChange={(v) => void updateReminders((cur) => ({ ...cur, smart: v }))}
      />

      <label className="flex items-center justify-between gap-3">
        <span className="font-semibold">Snooze length</span>
        <select
          className="field w-auto"
          value={r.snoozeMin}
          onChange={(e) => {
            const v = Number(e.target.value) as SnoozeMin;
            void updateReminders((cur) => ({ ...cur, snoozeMin: v }));
          }}
        >
          {SNOOZE_OPTIONS.map((m) => (
            <option key={m} value={m}>{snoozeLabel(m)}</option>
          ))}
        </select>
      </label>

      <div>
        <span className="font-semibold block mb-2">Today</span>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            aria-pressed={skipped}
            className={skipped ? "chip-on justify-center py-2" : "chip justify-center py-2"}
            onClick={() => void updateReminders((cur) => toggleSkipToday(cur, new Date()))}
          >
            Skip today
          </button>
          <button
            type="button"
            aria-pressed={snoozed}
            className={snoozed ? "chip-on justify-center py-2" : "chip justify-center py-2"}
            onClick={() => void updateReminders((cur) => toggleSnooze(cur, new Date()))}
          >
            Snooze {snoozeLabel(r.snoozeMin)}
          </button>
        </div>
      </div>

      <p className="text-sm" aria-live="polite">
        {r.days.length === 0 && marked.length === 0 ? (
          <span className="text-muted">Pick at least one gym day to get reminders.</span>
        ) : next ? (
          <>
            Next reminder <span className="font-semibold">{formatNext(next, now)}</span>
          </>
        ) : (
          <span className="text-muted">No reminder in the next week.</span>
        )}
      </p>

      <button type="button" className="btn-ghost w-full" onClick={() => setNotice(PUSH_UNAVAILABLE)}>
        Enable notifications
      </button>
      {notice && (
        <p className="text-xs text-muted" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}

function Switch({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>
        <span className="font-semibold block">{label}</span>
        <span className="text-xs text-muted">{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        className={`shrink-0 w-11 h-6 rounded-full border border-border relative transition-colors ${on ? "bg-accent" : "bg-surface-2"}`}
        onClick={() => onChange(!on)}
      >
        <span className={`absolute top-0.5 size-[18px] rounded-full shadow transition-all ${on ? "left-[22px] bg-accent-ink" : "left-0.5 bg-muted"}`} />
      </button>
    </div>
  );
}
