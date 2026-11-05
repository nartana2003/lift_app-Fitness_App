"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
  type PointerSensorOptions,
} from "@dnd-kit/core";
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
import { canDrag, dropAction, isGymDay } from "@/lib/autofill";

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

const longDay = (key: string) =>
  new Date(key + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric" });

/**
 * Pointer drag (mouse, pen and touch). Same as dnd-kit's PointerSensor but,
 * like the old pointer-event drag, only a non-primary button is refused.
 */
class DayPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent }: React.PointerEvent, { onActivation }: PointerSensorOptions) => {
        if (nativeEvent.button > 0) return false;
        onActivation?.({ event: nativeEvent });
        return true;
      },
    },
  ];
}

/** Pointer drags drop on the day under the pointer; keyboard drags on the closest day. */
const dayCollision: CollisionDetection = (args) => {
  if (!args.pointerCoordinates) return closestCenter(args);
  const key = dayAt(args.pointerCoordinates.x, args.pointerCoordinates.y);
  const c = key ? args.droppableContainers.find((x) => x.id === key) : undefined;
  return c ? [{ id: c.id, data: { droppableContainer: c, value: 0 } }] : [];
};

/** Left and right arrow keys jump the dragged day to the previous or next day. */
const dayKeys: KeyboardCoordinateGetter = (event, { context, currentCoordinates }) => {
  if (event.code !== "ArrowRight" && event.code !== "ArrowLeft") return undefined;
  const w = context.collisionRect?.width ?? 0;
  const h = context.collisionRect?.height ?? 0;
  const cur = currentCoordinates.x + w / 2;
  const rects = [...context.droppableRects.values()].sort((a, b) => a.left - b.left);
  const mid = (r: { left: number; width: number }) => r.left + r.width / 2;
  const next =
    event.code === "ArrowRight" ? rects.find((r) => mid(r) > cur + 1) : rects.reverse().find((r) => mid(r) < cur - 1);
  return next ? { x: mid(next) - w / 2, y: next.top + next.height / 2 - h / 2 } : undefined;
};

const KEYBOARD_CODES = {
  // Space picks a day up; Enter still opens the day panel.
  start: ["Space"],
  cancel: ["Escape"],
  end: ["Space", "Enter", "Tab"],
};

const ANNOUNCEMENTS: Announcements = {
  onDragStart: ({ active }) => `Picked up ${longDay(String(active.id))}.`,
  onDragOver: ({ over }) => (over ? `Over ${longDay(String(over.id))}.` : undefined),
  onDragEnd: ({ active, over }) =>
    over && over.id !== active.id ? `Dropped on ${longDay(String(over.id))}.` : "Dropped.",
  onDragCancel: () => "Drag cancelled.",
};

const INSTRUCTIONS = {
  draggable:
    "To move a planned day, press space, use the left and right arrow keys to choose a day, then press space to drop it, or escape to cancel.",
};

const EMPTY: { routines: Routine[]; planRows: PlannedDayRow[] } = { routines: [], planRows: [] };

/** This week at a glance: plan a routine per day, skip with a reason, or move it. */
export function WeekStrip() {
  const router = useRouter();
  const { weekStart } = useSettings();
  // Routines and plan rows load in one live query, so a planned day never shows
  // before its routine (e.g. the unmark confirm always has the routine's name).
  const { routines, planRows } = useLiveQuery(
    async () => {
      const [r, p] = await Promise.all([listRoutines(), db.planned_days.toArray()]);
      return { routines: r, planRows: p };
    },
    [],
    EMPTY,
  );
  // LINK-03: when each routine was last done, so the longest-ago linked routine goes first.
  const workoutRows = useLiveQuery(() => db.workouts.toArray(), [], []);
  const lastDone = lastDoneByRoutine(workoutRows);
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [drag, setDrag] = useState<{ from: string; over: string | null } | null>(null);
  // DND-01: drag runs on @dnd-kit. A press becomes a drag after DRAG_START px;
  // dnd-kit then swallows the click the browser fires after the drop.
  const dndId = useId();
  const sensors = useSensors(
    useSensor(DayPointerSensor, { activationConstraint: { distance: DRAG_START } }),
    useSensor(KeyboardSensor, { keyboardCodes: KEYBOARD_CODES, coordinateGetter: dayKeys }),
  );

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
      <h2 className="text-lg font-bold mb-2">This Week</h2>
      <DndContext
        id={dndId}
        sensors={sensors}
        collisionDetection={dayCollision}
        accessibility={{ announcements: ANNOUNCEMENTS, screenReaderInstructions: INSTRUCTIONS }}
        onDragStart={({ active }) => setDrag({ from: String(active.id), over: null })}
        onDragOver={({ active, over }) => setDrag({ from: String(active.id), over: over ? String(over.id) : null })}
        onDragEnd={({ active, over }) => {
          setDrag(null);
          if (over) void reschedule(String(active.id), String(over.id));
        }}
        onDragCancel={() => setDrag(null)}
      >
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
                <DayCircle
                  day={k}
                  draggable={draggable}
                  label={`${longName}, ${state}`}
                  pressed={gym}
                  onClick={() => {
                    if (open === k) {
                      setOpen(null);
                      return;
                    }
                    setOpen(k);
                    // Tapping an unmarked date from today on marks it as a gym day.
                    // A failed write leaves the date unmarked (the live query shows the truth),
                    // so it is caught here rather than left as an unhandled rejection.
                    if (!p && !isPast) markGymDay(k).catch(() => {});
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
                </DayCircle>
              </li>
            );
          })}
        </ul>
      </DndContext>

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

/** One round day tile: a drop target always, draggable only when a routine is planned on it. */
function DayCircle({
  day,
  draggable,
  label,
  pressed,
  className,
  onClick,
  children,
}: {
  day: string;
  draggable: boolean;
  label: string;
  pressed: boolean;
  className: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const drag = useDraggable({ id: day, disabled: !draggable });
  const drop = useDroppable({ id: day });
  return (
    <button
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      data-day={day}
      aria-label={label}
      aria-pressed={pressed}
      aria-describedby={draggable ? drag.attributes["aria-describedby"] : undefined}
      style={draggable ? { touchAction: "pan-y" } : undefined}
      {...drag.listeners}
      onClick={onClick}
      className={className}
    >
      {children}
    </button>
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
        <button
          className="size-8 shrink-0 rounded-full bg-surface-2 grid place-items-center text-muted"
          onClick={onClose}
          aria-label="Close"
        >
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
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
              <p className="text-sm font-medium mb-2">Plan a routine</p>
              {choices.groups.length === 0 ? (
                <RoutineChoices routines={routines} onPick={(id) => planDay(date, id)} />
              ) : (
                <div className="space-y-3">
                  {choices.groups.map((g) => (
                    <div key={g.dayId} role="group" aria-label={`${g.name} routines`}>
                      <p className="text-[11px] text-muted mb-1">{g.name}</p>
                      <RoutineChoices routines={g.routines} onPick={(id) => planDay(date, id)} />
                    </div>
                  ))}
                  {choices.others.length > 0 && (
                    <div role="group" aria-label="Other routines">
                      <p className="text-[11px] text-muted mb-1">Other routines</p>
                      <RoutineChoices routines={choices.others} onPick={(id) => planDay(date, id)} />
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {!routine && row?.status === "planned" && (
            <button
              className="btn-ghost w-full mt-3 py-2.5 text-sm gap-2 text-bad"
              onClick={() => void unmarkGymDay(date)}
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5L18 7M9 7V4.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V7" />
              </svg>
              Remove gym day
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Routines as a simple vertical list; tapping one plans it on the day. */
function RoutineChoices({ routines, onPick }: { routines: { id: string; name: string }[]; onPick: (id: string) => void }) {
  return (
    <div className="space-y-1.5">
      {routines.map((r) => (
        <button
          key={r.id}
          className="w-full text-left rounded-xl border border-border px-3 py-2.5 text-sm font-medium"
          onClick={() => onPick(r.id)}
        >
          {r.name}
        </button>
      ))}
    </div>
  );
}
