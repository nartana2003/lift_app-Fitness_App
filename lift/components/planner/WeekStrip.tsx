"use client";

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
import { db, type PlannedDayRow } from "@/lib/offline/db";
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
  undoSkip,
  unmarkGymDay,
  weekDays,
} from "@/lib/planner";
import { listRoutines, type Routine } from "@/lib/routines";
import { isCatchUpRoutine } from "@/lib/catchUp";
import { useSettings } from "@/lib/settings";
import { useSplit, type Split } from "@/lib/splits";
import { lastDoneByRoutine, nextRoutineForDay, routinesForDay, splitDayIds, type LastDone } from "@/lib/splitRoutines";
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

/** This week at a glance: plan a routine per day, or move it. */
export function WeekStrip() {
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
      <h2 className="text-lg font-bold mb-2">Weekly Plan</h2>
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
}: {
  date: string;
  row: PlannedDayRow | null;
  routines: Routine[];
  lastDone?: LastDone;
  plan: Map<string, PlannedDayRow>;
  days: Date[];
  onClose: () => void;
}) {
  const split = useSplit();
  // Catch-up copies belong to their planned day, so the picker leaves them out.
  const pickable = routines.filter((r) => !isCatchUpRoutine(r.name));
  const choices = planChoices(split, pickable, lastDone);
  const [moving, setMoving] = useState(false);
  const [changing, setChanging] = useState(false);
  const label = new Date(date + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
  const routine = row?.routine_id ? routines.find((r) => r.id === row.routine_id) : undefined;
  const options = moveOptions(days, plan, date);

  const picker = (
    <select
      aria-label="Routine"
      className="w-full"
      value=""
      onChange={(e) => {
        if (!e.target.value) return;
        void planDay(date, e.target.value);
        setChanging(false);
      }}
    >
      <option value="">Select a routine</option>
      {choices.groups.length === 0 ? (
        pickable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)
      ) : (
        <>
          {choices.groups.map((g) => (
            <optgroup key={g.dayId} label={g.name}>
              {g.routines.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </optgroup>
          ))}
          {choices.others.length > 0 && (
            <optgroup label="Other routines">
              {choices.others.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </optgroup>
          )}
        </>
      )}
    </select>
  );

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
          Moved to {new Date(row.moved_to + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" })}
          {row.skip_reason ? ` · ${SKIP_LABEL[row.skip_reason]}` : ""}
        </p>
      )}

      {moving ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">Move to which day?</p>
          {options.length === 0 ? (
            <p className="text-sm text-muted">No free days left this week.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {options.map((d) => (
                <button
                  key={dayKey(d)}
                  className="chip text-xs"
                  onClick={async () => {
                    await moveDay(date, dayKey(d));
                    onClose();
                  }}
                >
                  Move to {d.toLocaleDateString(undefined, { weekday: "short" })}
                </button>
              ))}
            </div>
          )}
          <button className="btn-ghost w-full py-2 text-sm" onClick={() => setMoving(false)}>Back</button>
        </div>
      ) : (
        <>
          {routine && changing ? (
            <>
              {picker}
              <button className="btn-ghost w-full mt-2 py-2 text-sm" onClick={() => setChanging(false)}>Cancel</button>
            </>
          ) : routine ? (
            <>
              <div className="pb-3">
                <p className="text-lg font-bold">{routine.name}</p>
                <p className="text-sm text-muted">
                  {routine.exercises.length} {routine.exercises.length === 1 ? "exercise" : "exercises"}
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {row?.status === "planned" && (
                  <button className="btn-ghost py-2 text-sm" onClick={() => setChanging(true)}>Change</button>
                )}
                {row?.status === "planned" && (
                  <button className="btn-ghost py-2 text-sm" onClick={() => setMoving(true)}>Move</button>
                )}
                {(row?.status === "skipped" || row?.status === "moved") && (
                  <button className="btn-ghost py-2 text-sm col-span-3" onClick={() => undoSkip(date)}>Undo</button>
                )}
                {row?.status !== "done" && (
                  <button
                    className={`btn-ghost py-2 text-sm text-bad ${row?.status === "planned" ? "" : "col-span-3"}`}
                    aria-label="Clear this day"
                    onClick={() => clearDay(date)}
                  >
                    Clear
                  </button>
                )}
              </div>
            </>
          ) : routines.length === 0 ? (
            <p className="text-sm text-muted">Create a routine first, then plan it on a day.</p>
          ) : (
            picker
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
