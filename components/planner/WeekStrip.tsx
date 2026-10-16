"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type PlannedDayRow, type SkipReason } from "@/lib/offline/db";
import {
  clearDay,
  dayKey,
  moveDay,
  moveOptions,
  planDay,
  SKIP_LABEL,
  SKIP_REASONS,
  skipDay,
  undoSkip,
  weekDays,
} from "@/lib/planner";
import { listRoutines } from "@/lib/routines";
import { useSettings } from "@/lib/settings";
import { startWorkout } from "@/lib/workout";

const DOW = ["S", "M", "T", "W", "T", "F", "S"];

/** This week at a glance: plan a routine per day, skip with a reason, or move it. */
export function WeekStrip() {
  const router = useRouter();
  const { weekStart } = useSettings();
  const routines = useLiveQuery(() => listRoutines(), [], []);
  const planRows = useLiveQuery(() => db.planned_days.toArray(), [], []);
  const [open, setOpen] = useState<string | null>(null);

  const days = weekDays(weekStart);
  const plan = new Map(planRows.map((p) => [p.date, p]));
  const today = dayKey(new Date());
  const selected = open ? (plan.get(open) ?? null) : null;

  return (
    <section className="mt-5">
      <h2 className="text-lg font-bold mb-2">This Week</h2>
      <ul className="grid grid-cols-7 gap-1">
        {days.map((d) => {
          const k = dayKey(d);
          const p = plan.get(k);
          const isToday = k === today;
          const routine = p?.routine_id ? routines.find((r) => r.id === p.routine_id) : undefined;
          return (
            <li key={k}>
              <button
                onClick={() => setOpen(open === k ? null : k)}
                className={`w-full rounded-xl border px-1 py-2 text-center ${
                  open === k ? "border-accent" : "border-border"
                } ${isToday ? "bg-surface-2" : ""}`}
              >
                <span className="block text-[10px] text-muted">{DOW[d.getDay()]}</span>
                <span className={`block text-sm font-semibold ${isToday ? "" : ""}`}>{d.getDate()}</span>
                <span className="block h-4 mt-0.5 text-[13px] leading-4">
                  {p?.status === "done" ? "✓" : p?.status === "skipped" ? "–" : p?.status === "moved" ? "→" : routine ? "•" : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {open && (
        <DayPanel
          date={open}
          row={selected}
          routines={routines}
          plan={plan}
          days={days}
          onClose={() => setOpen(null)}
          onStart={async (routineId) => {
            const r = routines.find((x) => x.id === routineId);
            if (!r) return;
            if (await db.active.get("active")) {
              if (!confirm("You already have a workout in progress. Discard it and start this one?")) return;
            }
            await startWorkout({
              name: r.name,
              routineId: r.id,
              exercises: r.exercises.map((e) => ({ exercise_id: e.exercise_id, target_sets: e.target_sets, target_reps: e.target_reps })),
            });
            router.push("/workout");
          }}
        />
      )}
    </section>
  );
}

function DayPanel({
  date,
  row,
  routines,
  plan,
  days,
  onClose,
  onStart,
}: {
  date: string;
  row: PlannedDayRow | null;
  routines: { id: string; name: string }[];
  plan: Map<string, PlannedDayRow>;
  days: Date[];
  onClose: () => void;
  onStart: (routineId: string) => void;
}) {
  const [skipping, setSkipping] = useState<null | "skip" | "move">(null);
  const [reason, setReason] = useState<SkipReason>("busy");
  const [note, setNote] = useState("");
  const label = new Date(date + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
  const routine = row?.routine_id ? routines.find((r) => r.id === row.routine_id) : undefined;
  const options = moveOptions(days, plan, date);
  const isPast = date < dayKey(new Date());

  return (
    <div className="card p-3 mt-2">
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="font-semibold">{label}</p>
        <button className="text-muted text-sm" onClick={onClose}>Close</button>
      </div>

      {row?.status === "done" && <p className="text-sm text-muted mb-2">Trained ✓</p>}
      {row?.status === "skipped" && (
        <p className="text-sm text-muted mb-2">
          Skipped · {SKIP_LABEL[row.skip_reason ?? "other"]}
          {row.skip_note ? ` — ${row.skip_note}` : ""}
        </p>
      )}
      {row?.status === "moved" && (
        <p className="text-sm text-muted mb-2">
          Moved to {new Date(row.moved_to + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" })} ·{" "}
          {SKIP_LABEL[row.skip_reason ?? "other"]}
        </p>
      )}

      {skipping ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">{skipping === "move" ? "Why move it?" : "Why skip?"}</p>
          <div className="flex flex-wrap gap-1.5">
            {SKIP_REASONS.map((r) => (
              <button key={r.v} className={reason === r.v ? "chip-on text-xs" : "chip text-xs"} onClick={() => setReason(r.v)}>
                {r.label}
              </button>
            ))}
          </div>
          <input className="field py-2 text-sm" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />

          {skipping === "move" ? (
            options.length === 0 ? (
              <p className="text-sm text-muted">No free days left this week.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {options.map((d) => (
                  <button
                    key={dayKey(d)}
                    className="chip text-xs"
                    onClick={async () => {
                      await moveDay(date, dayKey(d), reason, note);
                      onClose();
                    }}
                  >
                    Move to {d.toLocaleDateString(undefined, { weekday: "short" })}
                  </button>
                ))}
              </div>
            )
          ) : (
            <button
              className="btn-primary w-full py-2 text-sm"
              onClick={async () => {
                await skipDay(date, reason, note);
                onClose();
              }}
            >
              Skip this day
            </button>
          )}
          <button className="btn-ghost w-full py-2 text-sm" onClick={() => setSkipping(null)}>Back</button>
        </div>
      ) : (
        <>
          {routine ? (
            <>
              <p className="text-sm mb-2">
                Planned: <span className="font-semibold">{routine.name}</span>
              </p>
              <div className="grid grid-cols-2 gap-2">
                {row?.status === "planned" && !isPast && (
                  <button className="btn-primary py-2 text-sm col-span-2" onClick={() => onStart(routine.id)}>
                    Start
                  </button>
                )}
                {row?.status === "planned" && (
                  <>
                    <button className="btn-ghost py-2 text-sm" onClick={() => setSkipping("skip")}>Skip</button>
                    <button className="btn-ghost py-2 text-sm" onClick={() => setSkipping("move")}>Move</button>
                  </>
                )}
                {(row?.status === "skipped" || row?.status === "moved") && (
                  <button className="btn-ghost py-2 text-sm col-span-2" onClick={() => undoSkip(date)}>Undo</button>
                )}
                {row?.status !== "done" && (
                  <button className="text-xs text-muted col-span-2 py-1" onClick={() => clearDay(date)}>
                    Clear this day
                  </button>
                )}
              </div>
            </>
          ) : routines.length === 0 ? (
            <p className="text-sm text-muted">Create a routine first, then plan it on a day.</p>
          ) : (
            <>
              <p className="text-sm text-muted mb-2">Plan a routine</p>
              <div className="flex flex-wrap gap-1.5">
                {routines.map((r) => (
                  <button key={r.id} className="chip text-xs" onClick={() => planDay(date, r.id)}>
                    {r.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
