"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type PlannedDayRow, type SkipReason } from "@/lib/offline/db";
import {
  clearDay,
  dayKey,
  markGymDay,
  moveDay,
  moveOptions,
  planDay,
  rescheduleDay,
  SKIP_LABEL,
  swapDays,
  SKIP_REASONS,
  skipDay,
  undoSkip,
  unmarkGymDay,
  weekDays,
} from "@/lib/planner";
import { listRoutines, type Routine } from "@/lib/routines";
import { useSettings } from "@/lib/settings";
import { useSplit, type Split } from "@/lib/splits";
import { lastDoneByRoutine, nextRoutineForDay, routinesForDay, splitDayIds, type LastDone } from "@/lib/splitRoutines";
import { startWorkout } from "@/lib/workout";
import {
  autoFillPlan,
  canDrag,
  defaultPickedDays,
  dropAction,
  isGymDay,
  markedOpenDates,
  splitRoutineOrder,
  weekdayOf,
} from "@/lib/autofill";

const DOW = ["S", "M", "T", "W", "T", "F", "S"];

/** Pointer travel (px) before a press on a planned day becomes a drag. */
const DRAG_START = 8;

const shortDay = (key: string) => new Date(key + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" });

/**
 * Classes for one day circle (round, equal width and height, no box around it).
 * Monochrome: outlined when unmarked, solid black when a gym day, a heavier
 * ring for today, dashed outline for a valid drop target, muted when past.
 */
export function circleClass(s: {
  gym: boolean;
  isToday: boolean;
  isPast: boolean;
  open: boolean;
  target: boolean;
  over: boolean;
  dragging: boolean;
}): string {
  const base =
    "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold select-none " +
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
  let look: string;
  if (s.target) {
    look = `border-2 border-dashed border-accent text-text ${s.over ? "bg-surface-2" : "bg-transparent"}`;
  } else if (s.gym) {
    look = `border border-accent bg-accent text-accent-ink${s.isToday ? " ring-2 ring-accent ring-offset-2 ring-offset-bg" : ""}`;
  } else if (s.isToday) {
    look = "border-2 border-accent bg-surface-2 text-text";
  } else {
    look = `border ${s.open ? "border-accent" : "border-border"} bg-transparent text-text`;
  }
  const muted = s.isPast && !s.target ? " opacity-50" : "";
  const drag = s.dragging ? " opacity-40" : "";
  return `${base} ${look}${muted}${drag}`;
}

/**
 * LINK-03: routines to offer when planning a day. Each split day with linked
 * routines comes first, in split order, with its next routine (done longest
 * ago) first; every other routine follows in its existing order. With no
 * links there are no groups and `others` is the list as given.
 */
export function planChoices<R extends { id: string; created_at: string; kind?: "routine" | "mini"; split_day_id?: string | null }>(
  split: Pick<Split, "days">,
  routines: readonly R[],
  lastDone: LastDone = new Map(),
): { groups: { dayId: string; name: string; routines: R[] }[]; others: R[] } {
  const groups: { dayId: string; name: string; routines: R[] }[] = [];
  const ids = splitDayIds(split);
  const seen = new Set<string>();
  split.days.forEach((d, i) => {
    if (!d.id || seen.has(d.id)) return;
    seen.add(d.id);
    // Mini routines linked to the day are listed too (they are never picked automatically).
    const linked = routinesForDay(routines, d.id, { includeMini: true });
    if (linked.length === 0) return;
    const next = nextRoutineForDay(linked, d.id, lastDone);
    const ordered = next ? [next, ...linked.filter((r) => r.id !== next.id)] : linked;
    groups.push({ dayId: d.id, name: d.name.trim() || `Day ${i + 1}`, routines: ordered });
  });
  const others = routines.filter((r) => !r.split_day_id || !ids.has(r.split_day_id));
  return { groups, others };
}

/** The day cell under a screen point, if any. */
function dayAt(x: number, y: number): string | null {
  if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") return null;
  const el = document.elementFromPoint(x, y);
  const cell = el?.closest<HTMLElement>("[data-day]");
  return cell?.dataset.day ?? null;
}

/** This week at a glance: plan a routine per day, skip with a reason, or move it. */
export function WeekStrip() {
  const router = useRouter();
  const { weekStart } = useSettings();
  const routines = useLiveQuery(() => listRoutines(), [], []);
  const planRows = useLiveQuery(() => db.planned_days.toArray(), [], []);
  // LINK-03: when each routine was last done, so the longest-ago linked routine goes first.
  const workoutRows = useLiveQuery(() => db.workouts.toArray(), [], []);
  const lastDone = lastDoneByRoutine(workoutRows);
  const [open, setOpen] = useState<string | null>(null);
  const [filling, setFilling] = useState(false);
  const [notice, setNotice] = useState("");
  const [drag, setDrag] = useState<{ from: string; over: string | null } | null>(null);
  const press = useRef<{ from: string; x: number; y: number; id: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);

  const days = weekDays(weekStart);
  const plan = new Map(planRows.map((p) => [p.date, p]));
  const today = dayKey(new Date());
  const selected = open ? (plan.get(open) ?? null) : null;
  const nameOf = (id: string | null | undefined) => routines.find((r) => r.id === id)?.name ?? "Workout";
  const anyDraggable = days.some((d) => canDrag(plan.get(dayKey(d))));

  /** Drop a dragged day onto another: move it to a free day or swap two planned days. */
  async function reschedule(from: string, to: string) {
    const action = dropAction(from, to, plan, today);
    const src = plan.get(from);
    if (!action || !src?.routine_id) return;
    // Each helper writes both days in one transaction (no half-finished move or swap).
    if (action === "move") {
      if (!(await rescheduleDay(from, to))) return;
      setNotice(`Moved ${nameOf(src.routine_id)} to ${shortDay(to)}.`);
    } else {
      if (!(await swapDays(from, to))) return;
      setNotice(`Swapped ${shortDay(from)} and ${shortDay(to)}.`);
    }
    if (open === from || open === to) setOpen(null);
  }

  return (
    <section className="mt-5">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h2 className="text-lg font-bold">This Week</h2>
        <button
          className="text-xs font-medium text-muted underline underline-offset-2"
          aria-expanded={filling}
          onClick={() => {
            setFilling(!filling);
            setOpen(null);
            setNotice("");
          }}
        >
          Auto-fill from my split
        </button>
      </div>
      <ul className="grid grid-cols-7 gap-1">
        {days.map((d) => {
          const k = dayKey(d);
          const p = plan.get(k);
          const isToday = k === today;
          const routine = p?.routine_id ? routines.find((r) => r.id === p.routine_id) : undefined;
          const draggable = canDrag(p);
          const dragging = drag?.from === k;
          const target = drag && drag.from !== k ? dropAction(drag.from, k, plan, today) : null;
          const gym = isGymDay(p);
          const isPast = k < today;
          const longName = `${d.toLocaleDateString(undefined, { weekday: "long" })} ${d.getDate()}`;
          const state = gym
            ? "gym day, tap to change"
            : p?.status === "skipped"
              ? "skipped, tap to change"
              : p?.status === "moved"
                ? "moved, tap to change"
                : isPast
                  ? "not a gym day"
                  : "not a gym day, tap to mark";
          return (
            <li key={k} className="flex justify-center pt-4 pb-5">
              <button
                data-day={k}
                aria-label={`${longName}, ${state}`}
                aria-pressed={gym}
                style={draggable ? { touchAction: "pan-y" } : undefined}
                onPointerDown={(e) => {
                  if (!draggable || e.button > 0) return;
                  press.current = { from: k, x: e.clientX, y: e.clientY, id: e.pointerId, active: false };
                }}
                onPointerMove={(e) => {
                  const s = press.current;
                  if (!s || s.id !== e.pointerId) return;
                  if (!s.active) {
                    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < DRAG_START) return;
                    s.active = true;
                    try {
                      e.currentTarget.setPointerCapture?.(e.pointerId);
                    } catch {
                      // capture is best-effort (not every environment supports it)
                    }
                  }
                  setDrag({ from: s.from, over: dayAt(e.clientX, e.clientY) });
                }}
                onPointerUp={(e) => {
                  const s = press.current;
                  press.current = null;
                  if (!s?.active) return;
                  // The browser fires a click after a drag; ignore that one.
                  suppressClick.current = true;
                  setTimeout(() => {
                    suppressClick.current = false;
                  }, 0);
                  setDrag(null);
                  const to = dayAt(e.clientX, e.clientY);
                  if (to) void reschedule(s.from, to);
                }}
                onPointerCancel={() => {
                  press.current = null;
                  setDrag(null);
                }}
                onClick={() => {
                  if (suppressClick.current) return;
                  setFilling(false);
                  if (open === k) {
                    setOpen(null);
                    return;
                  }
                  setOpen(k);
                  // Tapping an unmarked date from today on marks it as a gym day.
                  if (!p && !isPast) void markGymDay(k);
                }}
                className={circleClass({
                  gym,
                  isToday,
                  isPast,
                  open: open === k,
                  target: !!target,
                  over: !!target && drag?.over === k,
                  dragging,
                })}
              >
                {/* Weekday letter above and status marker below sit outside the circle. */}
                <span aria-hidden className="pointer-events-none absolute -top-4 left-1/2 -translate-x-1/2 text-[10px] font-normal leading-3 text-muted">
                  {DOW[d.getDay()]}
                </span>
                <span>{d.getDate()}</span>
                <span aria-hidden className="pointer-events-none absolute -bottom-5 left-1/2 h-4 -translate-x-1/2 text-[13px] font-normal leading-4 text-text">
                  {p?.status === "done" ? "✓" : p?.status === "skipped" ? "–" : p?.status === "moved" ? "→" : routine ? "•" : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {anyDraggable && !drag && <p className="mt-1 text-[11px] text-muted">Drag a planned day to move it.</p>}
      {drag && (
        <p className="mt-1 text-[11px] text-muted">
          {drag.over && drag.over !== drag.from && dropAction(drag.from, drag.over, plan, today)
            ? `Drop to ${dropAction(drag.from, drag.over, plan, today) === "swap" ? "swap with" : "move to"} ${shortDay(drag.over)}`
            : "Drop on a free day, or on a planned day to swap"}
        </p>
      )}
      <p role="status" aria-live="polite" className="mt-1 text-xs text-muted empty:hidden">
        {notice}
      </p>

      {filling && (
        <AutoFillPanel
          days={days.map(dayKey)}
          routines={routines}
          lastDone={lastDone}
          plan={plan}
          today={today}
          onClose={() => setFilling(false)}
          onDone={(n) => {
            setFilling(false);
            setNotice(n === 1 ? "Planned 1 day." : `Planned ${n} days.`);
          }}
        />
      )}

      {open && (
        <DayPanel
          date={open}
          row={selected}
          routines={routines}
          lastDone={lastDone}
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
  lastDone,
  plan,
  days,
  onClose,
  onStart,
}: {
  date: string;
  row: PlannedDayRow | null;
  routines: Routine[];
  lastDone?: LastDone;
  plan: Map<string, PlannedDayRow>;
  days: Date[];
  onClose: () => void;
  onStart: (routineId: string) => void;
}) {
  const split = useSplit();
  const choices = planChoices(split, routines, lastDone);
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

      <GymDayToggle date={date} row={row} routineName={routine?.name} isPast={isPast} />

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
              {choices.groups.length === 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {routines.map((r) => (
                    <button key={r.id} className="chip text-xs" onClick={() => planDay(date, r.id)}>
                      {r.name}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {choices.groups.map((g) => (
                    <div key={g.dayId} role="group" aria-label={`${g.name} routines`}>
                      <p className="text-[11px] text-muted mb-1">{g.name}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {g.routines.map((r) => (
                          <button key={r.id} className="chip text-xs" onClick={() => planDay(date, r.id)}>
                            {r.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {choices.others.length > 0 && (
                    <div role="group" aria-label="Other routines">
                      <p className="text-[11px] text-muted mb-1">Other routines</p>
                      <div className="flex flex-wrap gap-1.5">
                        {choices.others.map((r) => (
                          <button key={r.id} className="chip text-xs" onClick={() => planDay(date, r.id)}>
                            {r.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * "Gym day: on/off" at the top of the day panel. Turning it off removes a
 * planned date (asking first when a routine is planned on it); done, skipped
 * and moved dates cannot be unmarked, and past dates cannot be marked.
 */
function GymDayToggle({
  date,
  row,
  routineName,
  isPast,
}: {
  date: string;
  row: PlannedDayRow | null;
  routineName: string | undefined;
  isPast: boolean;
}) {
  const on = isGymDay(row ?? undefined);
  const locked = !!row && row.status !== "planned";
  const disabled = locked || (!row && isPast);
  const hint = locked
    ? row?.status === "done"
      ? "Trained days stay marked."
      : "Undo the skip or move to change this day."
    : !row && isPast
      ? "Past days cannot be marked."
      : "";

  async function toggle() {
    if (disabled) return;
    if (!row) {
      await markGymDay(date);
      return;
    }
    if (row.routine_id) {
      const name = routineName ?? "the planned routine";
      if (!confirm(`Unmark this gym day? This also removes ${name} from it.`)) return;
    }
    await unmarkGymDay(date);
  }

  return (
    <div className="mb-2">
      <button
        className={`${on ? "chip-on" : "chip"} text-xs disabled:opacity-40`}
        aria-pressed={on}
        disabled={disabled}
        onClick={() => void toggle()}
      >
        {on ? "Gym day: on" : "Gym day: off"}
      </button>
      {hint && <p className="mt-1 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

/** Lay the split's routines across chosen gym days of this week, filling free days only. */
function AutoFillPanel({
  days,
  routines,
  lastDone,
  plan,
  today,
  onClose,
  onDone,
}: {
  days: string[];
  routines: Routine[];
  lastDone?: LastDone;
  plan: Map<string, PlannedDayRow>;
  today: string;
  onClose: () => void;
  onDone: (planned: number) => void;
}) {
  const split = useSplit();
  const [picked, setPicked] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Linked routines come first (LINK-01); lastDone picks the one done longest ago.
  const order = splitRoutineOrder(split, routines, lastDone);
  // Dates already marked as gym days (no routine yet) are filled first and set the default pick.
  const marked = markedOpenDates(days, plan, today);
  const gymDays = picked ?? defaultPickedDays(marked, split.days.length || 3);
  const fills = autoFillPlan({ days, gymDays, plan, today, routineIds: order, marked });
  const nameOf = (id: string) => routines.find((r) => r.id === id)?.name ?? "Workout";

  const toggle = (wd: number) =>
    setPicked(gymDays.includes(wd) ? gymDays.filter((x) => x !== wd) : [...gymDays, wd]);

  return (
    <div className="card p-3 mt-2">
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="font-semibold">Auto-fill from my split</p>
        <button className="text-muted text-sm" onClick={onClose}>Cancel</button>
      </div>

      {order.length === 0 ? (
        <p className="text-sm text-muted">Create a routine first to auto-fill your week.</p>
      ) : (
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium mb-1.5">Gym days</p>
            <div className="flex flex-wrap gap-1.5">
              {days.map((k) => {
                const wd = weekdayOf(k);
                const on = gymDays.includes(wd);
                return (
                  <button key={k} aria-pressed={on} className={on ? "chip-on text-xs" : "chip text-xs"} onClick={() => toggle(wd)}>
                    {new Date(k + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" })}
                  </button>
                );
              })}
            </div>
          </div>

          <p className="text-xs text-muted">
            {split.days.length === 0 ? "No split set, so your routines are used in order: " : "Order: "}
            {order.map(nameOf).join(", ")}
          </p>

          {fills.length === 0 ? (
            <p className="text-sm text-muted">No free gym days left this week.</p>
          ) : (
            <div className="text-sm space-y-0.5">
              {fills.map((f) => (
                <p key={f.date} className="flex justify-between gap-2">
                  <span className="text-muted">
                    {new Date(f.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "long" })}
                  </span>
                  <span className="font-medium">{nameOf(f.routine_id)}</span>
                </p>
              ))}
            </div>
          )}

          <button
            className="btn-primary w-full py-2 text-sm disabled:opacity-40"
            disabled={fills.length === 0 || busy}
            onClick={async () => {
              setBusy(true);
              try {
                for (const f of fills) await planDay(f.date, f.routine_id);
                onDone(fills.length);
              } finally {
                setBusy(false);
              }
            }}
          >
            {fills.length === 1 ? "Fill 1 day" : `Fill ${fills.length} days`}
          </button>
          <p className="text-[11px] text-muted">Only free days from today on are filled. Planned, trained and skipped days stay as they are.</p>
        </div>
      )}
    </div>
  );
}
