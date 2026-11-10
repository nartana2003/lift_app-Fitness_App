"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type ActiveExercise } from "@/lib/offline/db";
import type { Exercise } from "@/lib/exercises";
import { exerciseSessions, lastSession, type ExerciseSession } from "@/lib/history";
import { formatSets, parseRepRange, repeatsLast, suggest, type RepRange, type Suggestion } from "@/lib/overload";
import type { Goals } from "@/lib/goals";
import { EQUIPMENT, MUSCLE_GROUPS } from "@/lib/muscles";
import { dayKey } from "@/lib/planner";
import { PR_LABEL, type PrType } from "@/lib/prs";
import { PLATEAU_APPLIED_KEY, activeLighterWeek, lighterWeekSuggestion } from "@/lib/lighterWeek";
import { restTimer } from "@/lib/restTimer";
import {
  addSet,
  getRestSec,
  removeExercise,
  removeSet,
  setRestSec,
  swapExercise,
  toggleSetDone,
  updateSet,
} from "@/lib/workout";
import { ExerciseDemo } from "../ExerciseDemo";
import { SwapSheet } from "./SwapSheet";
import { WeightInput } from "../WeightInput";
import { useSettings } from "@/lib/settings";
import { dispNum, fmtWeight } from "@/lib/units";
import { fmtClock } from "@/lib/restTimer";

export const RIR_OPTIONS = [1, 2, 3, 4, 5];

export function ExerciseCard({
  ex,
  info,
  onPr,
  repTarget,
}: {
  ex: ActiveExercise;
  info?: Exercise;
  onPr: (name: string, prs: PrType[]) => void;
  repTarget?: string;
}) {
  const last = useLiveQuery(() => lastSession(ex.exercise_id), [ex.exercise_id]);
  const rest = useLiveQuery(() => getRestSec(ex.exercise_id), [ex.exercise_id], 90);
  const { unit, suggestions, rirPrompt } = useSettings();
  const [menu, setMenu] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Collapsed by default; tap the title to open the sets.
  const [collapsed, setCollapsed] = useState(true);
  const name = info?.name ?? ex.exercise_id;

  // The options popover closes on a tap outside it or Escape.
  useEffect(() => {
    if (!menu) return;
    const outside = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);

  const lastWork = last?.sets.filter((s) => !s.is_warmup) ?? [];
  const range = parseRepRange(repTarget ?? ex.target_reps);
  // Plateau "Start lighter week": while it runs, Today's suggestion is the lighter one (no AI refinement).
  const applied = useLiveQuery(() => db.meta.get(PLATEAU_APPLIED_KEY), []);
  const lw = activeLighterWeek(applied?.value, ex.exercise_id, new Date());
  const lighter = last && lw ? lighterWeekSuggestion(last.sets, range, info?.equipment ?? "Other", lw) : null;
  // The Suggestions preference hides the regular suggestion; a lighter week the user started still shows.
  const sug = lighter ?? (last && suggestions ? suggest(last.sets, range, info?.equipment ?? "Other") : null);
  const allDone = ex.sets.every((s) => s.done);
  const setsDone = ex.sets.filter((s) => s.done).length;
  const ai = useAiRefinement(ex.exercise_id, range, info?.equipment ?? null, !!sug && !allDone && !lighter);
  // One suggestion: the AI's refinement when it answered, else the rule-based one.
  const pick = sug && !allDone ? (ai ?? sug) : null;
  // Say nothing when the advice is "repeat last time": the Last time line already shows it.
  const shown = pick && last && repeatsLast(pick, last.sets) ? null : pick;
  // With the Rate effort preference on, ask for effort on the most recently ticked working set, until it's rated.
  const lastDone = ex.sets.findLast((s) => s.done && !s.is_warmup);
  const rateSet = rirPrompt && lastDone?.rir === null ? lastDone : undefined;

  async function tick(setId: string, wasDone: boolean) {
    if (!wasDone) restTimer.start(rest ?? 90, `Rest · ${name}`);
    const prs = await toggleSetDone(ex.id, setId);
    if (prs.length) onPr(name, prs);
  }

  function applySuggestion(to: Suggestion | null = sug) {
    if (!to) return;
    for (const s of ex.sets) {
      if (!s.done && !s.is_warmup) void updateSet(ex.id, s.id, { weight: to.weight, reps: to.reps });
    }
  }

  return (
    <section className="card p-3">
      <div className="flex items-start gap-3">
        <Link href={`/exercises/${ex.exercise_id}?from=workout`}>
          <ExerciseDemo urls={info?.image_urls.slice(0, 1) ?? []} alt={name} small />
        </Link>
        <button
          type="button"
          className="flex-1 min-w-0 text-left self-stretch flex items-center justify-between gap-2 outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-lg"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${name}`}
          onClick={() => setCollapsed(!collapsed)}
        >
          <span className="min-w-0">
            <h3 className="font-semibold leading-tight">{name}</h3>
            {!collapsed && (
              <p className="text-xs text-muted mt-0.5">
                {lastWork.length ? `Last time: ${formatSets(lastWork, unit)}` : "First time — set a baseline"}
              </p>
            )}
          </span>
          {collapsed && (
            <span className="shrink-0 text-sm font-semibold tabular-nums text-muted" aria-label={`${setsDone} of ${ex.sets.length} sets done`}>
              {setsDone}/{ex.sets.length}
            </span>
          )}
        </button>
        {!collapsed && (
          <div ref={menuRef} className="relative">
            <button
              className={`size-10 grid place-items-center rounded-full text-text ${menu ? "bg-surface-2" : ""}`}
              onClick={() => setMenu(!menu)}
              aria-label="Options"
              aria-expanded={menu}
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden>
                <circle cx="5" cy="12" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="19" cy="12" r="1.8" />
              </svg>
            </button>
            {menu && (
              <div role="group" aria-label="Exercise options" className="absolute right-0 top-11 z-20 w-64 card p-1.5 shadow-lg">
                <label className="relative flex min-h-12 items-center gap-3 rounded-lg px-2.5 text-[15px] font-semibold">
                  <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <circle cx="12" cy="13" r="8" />
                    <path d="M12 9v4l2.5 2M9.5 3h5" />
                  </svg>
                  <span className="flex-1">Rest timer</span>
                  <span className="text-sm font-medium text-muted" aria-hidden>{fmtClock(rest ?? 90)}</span>
                  <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                  {/* The select sits invisibly over the whole row so a tap anywhere on it opens the picker. */}
                  <select
                    aria-label="Rest timer"
                    className="absolute inset-0 size-full cursor-pointer opacity-0"
                    value={rest}
                    onChange={(e) => setRestSec(ex.exercise_id, Number(e.target.value))}
                  >
                    {[30, 45, 60, 75, 90, 120, 150, 180, 240, 300].map((s) => (
                      <option key={s} value={s}>{fmtClock(s)}</option>
                    ))}
                  </select>
                </label>
                <button
                  className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2.5 text-left text-[15px] font-semibold"
                  onClick={() => {
                    setMenu(false);
                    setSwapping(true);
                  }}
                >
                  <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M7 7h11l-3-3M17 17H6l3 3" />
                  </svg>
                  Swap exercise
                </button>
                <div className="mx-1 my-1.5 h-px bg-border" />
                <button
                  className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2.5 text-left text-[15px] font-semibold text-bad"
                  onClick={() => removeExercise(ex.id)}
                >
                  <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5L18 7M9 7V4.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V7" />
                  </svg>
                  Remove exercise
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {!collapsed && (
        <>

      {shown && !allDone && (
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-border px-3 py-2">
          <div className="flex-1 min-w-0">
            <p className="text-[11px] uppercase tracking-wide text-muted">Suggestion</p>
            <p className="font-semibold tabular-nums">
              {shown.sets}×{shown.reps} @ {fmtWeight(shown.weight, unit)}
            </p>
          </div>
          <button
            className="btn-primary px-5 py-2 text-sm"
            aria-label={`Use suggestion: ${shown.sets}×${shown.reps} @ ${fmtWeight(shown.weight, unit)}`}
            onClick={() => applySuggestion(shown)}
          >
            Use
          </button>
        </div>
      )}

      <div className="mt-3">
        <div className="grid grid-cols-[2rem_1fr_4.5rem_4rem_2.75rem] gap-2 text-[11px] uppercase tracking-wide text-muted px-1 mb-1">
          <span>Set</span>
          <span>Previous</span>
          <span className="text-center">{unit}</span>
          <span className="text-center">Reps</span>
          <span />
        </div>
        {ex.sets.map((s, i) => {
          const prev = lastWork[i];
          const workIndex = ex.sets.slice(0, i + 1).filter((x) => !x.is_warmup).length;
          return (
            <SwipeToDelete key={s.id} onDelete={() => removeSet(ex.id, s.id)}>
            <div
              className={`grid grid-cols-[2rem_1fr_4.5rem_4rem_2.75rem] gap-2 items-center rounded-lg px-1 py-1 ${
                s.done ? "bg-good/10" : "bg-bg"
              }`}
            >
              <button
                className={`text-sm font-semibold ${s.is_warmup ? "text-warn" : ""}`}
                onClick={() => updateSet(ex.id, s.id, { is_warmup: !s.is_warmup })}
                title="Tap to toggle warm-up"
              >
                {s.is_warmup ? "W" : workIndex}
              </button>
              <span className="text-xs text-muted truncate">
                {prev ? `${dispNum(prev.weight, unit)}×${prev.reps}` : "—"}
                {s.pr && <span className="ml-1">🏆</span>}
              </span>
              <WeightInput
                className="field py-1.5 px-1 text-center"
                kg={s.weight}
                unit={unit}
                placeholderKg={prev?.weight}
                onChangeKg={(kg) => updateSet(ex.id, s.id, { weight: kg })}
              />
              <input
                className="field py-1.5 px-1 text-center"
                inputMode="numeric"
                value={s.reps}
                placeholder={prev ? String(prev.reps) : "0"}
                onChange={(e) => updateSet(ex.id, s.id, { reps: e.target.value === "" ? "" : Number(e.target.value) })}
              />
              <button
                onClick={() => tick(s.id, s.done)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void removeSet(ex.id, s.id);
                }}
                className={`h-9 rounded-lg grid place-items-center font-bold ${
                  s.done ? "bg-good text-white" : "bg-surface-2 border border-border text-muted"
                }`}
                aria-label={s.done ? "Undo set" : "Complete set"}
              >
                ✓
              </button>
            </div>
            </SwipeToDelete>
          );
        })}
      </div>

      {rateSet && (
        <div className="mt-2 rounded-xl bg-surface-2 p-2">
          <p className="text-xs text-muted mb-1.5 px-1">How many more reps could you have done?</p>
          <div className="grid grid-cols-5 gap-1.5">
            {RIR_OPTIONS.map((n) => (
              <button
                key={n}
                className="rounded-lg bg-surface border border-border py-2 text-base font-semibold"
                aria-label={`${n} more reps`}
                onClick={() => updateSet(ex.id, rateSet.id, { rir: n })}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2 mt-2">
        <button className="btn-ghost flex-1 py-2 text-sm" onClick={() => addSet(ex.id)}>+ Add set</button>
      </div>
        </>
      )}

      {swapping && info && (
        <SwapSheet
          current={info}
          onClose={() => setSwapping(false)}
          onPick={async (picked) => {
            await swapExercise(ex.id, picked.id);
            setSwapping(false);
          }}
        />
      )}
    </section>
  );
}

const SWIPE_OPEN = 80;

/** Drag a row left to reveal a Delete button behind it; drag back or tap the row to close. */
function SwipeToDelete({ onDelete, children }: { onDelete: () => void; children: React.ReactNode }) {
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ px: number; py: number; from: number; horizontal: boolean } | null>(null);

  return (
    <div className="relative overflow-hidden rounded-lg">
      <button
        className="absolute inset-y-0 right-0 w-20 bg-bad text-white text-sm font-semibold"
        style={{ visibility: x < 0 ? "visible" : "hidden" }}
        tabIndex={x < 0 ? 0 : -1}
        onClick={onDelete}
      >
        Delete
      </button>
      <div
        className={`relative touch-pan-y ${dragging ? "" : "transition-transform duration-150"}`}
        style={{ transform: `translateX(${x}px)` }}
        onPointerDown={(e) => {
          start.current = { px: e.clientX, py: e.clientY, from: x, horizontal: false };
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (!s) return;
          const dx = e.clientX - s.px;
          if (!s.horizontal) {
            if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(e.clientY - s.py)) return;
            s.horizontal = true;
            setDragging(true);
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }
          setX(Math.max(-SWIPE_OPEN, Math.min(0, s.from + dx)));
        }}
        onPointerUp={() => {
          const s = start.current;
          start.current = null;
          setDragging(false);
          if (s?.horizontal) setX((v) => (v < -SWIPE_OPEN / 2 ? -SWIPE_OPEN : 0));
        }}
        onPointerCancel={() => {
          start.current = null;
          setDragging(false);
          setX((v) => (v < -SWIPE_OPEN / 2 ? -SWIPE_OPEN : 0));
        }}
        onClickCapture={(e) => {
          // A tap on an open row closes it instead of acting on the control under it.
          if (x < 0) {
            e.stopPropagation();
            e.preventDefault();
            setX(0);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function prText(prs: PrType[]) {
  return prs.map((p) => PR_LABEL[p]).join(" · ");
}

// ---------------------------------------------------------------------------
// AI refinement (POST /api/ai/overload-suggestion). The rule-based "Today"
// suggestion is always shown as it is; when the route answers with a
// model-refined target, one extra line with its numbers and a one-line reason
// is added under it. Offline, 503 unavailable or any failure adds nothing.
// ---------------------------------------------------------------------------

/** Mirrors the route's limits in lib/ai/overload-suggestion.ts (client code may not import lib/ai). */
export const OVERLOAD_AI = {
  maxSessions: 5,
  maxSetsPerSession: 20,
  maxReps: 100,
  maxWeight: 1000,
  maxRir: 5,
  maxRangeReps: 50,
  maxSets: 10,
  maxReason: 200,
  maxId: 80,
} as const;

const ID_RE = /^[A-Za-z0-9_-]+$/;
const intIn = (n: unknown, lo: number, hi: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;
const numIn = (n: unknown, lo: number, hi: number): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;

export type OverloadGoals = Pick<Goals, "goalType" | "experience" | "sessionsPerWeek" | "focusMuscles">;

/**
 * The request body the overload-suggestion route accepts, built from the
 * exercise's recent sessions (newest first, as exerciseSessions returns them).
 * Out-of-range sets are dropped. Null when the id cannot be sent or the most
 * recent usable session has no working set (then there is nothing to refine).
 */
export function buildOverloadRequest(
  exerciseId: string,
  sessions: ExerciseSession[],
  range: RepRange,
  equipment: string | null,
  goals: OverloadGoals | null,
) {
  const L = OVERLOAD_AI;
  if (exerciseId.length > L.maxId || !ID_RE.test(exerciseId)) return null;
  const out: { date: string; sets: { reps: number; weight: number; rir: number | null; is_warmup: boolean }[] }[] = [];
  for (const s of sessions.slice(0, L.maxSessions)) {
    const sets = s.sets
      .filter((x) => intIn(x.reps, 0, L.maxReps) && numIn(x.weight, 0, L.maxWeight))
      .slice(0, L.maxSetsPerSession)
      .map((x) => ({
        reps: x.reps,
        weight: x.weight,
        rir: intIn(x.rir, 0, L.maxRir) ? x.rir : null,
        is_warmup: x.is_warmup === true,
      }));
    const date = new Date(s.workout.started_at);
    if (sets.length && !Number.isNaN(date.getTime())) out.push({ date: dayKey(date), sets });
  }
  if (!out.length || !out[0].sets.some((x) => !x.is_warmup && x.reps > 0)) return null;
  out.reverse(); // the route wants oldest first
  const rangeOk = intIn(range.min, 1, L.maxRangeReps) && intIn(range.max, 1, L.maxRangeReps) && range.min <= range.max;
  return {
    exercise_id: exerciseId,
    sessions: out,
    ...(equipment && (EQUIPMENT as readonly string[]).includes(equipment) ? { equipment } : {}),
    ...(rangeOk ? { rep_range: { min: range.min, max: range.max } } : {}),
    ...(goals
      ? {
          goals: {
            goalType: goals.goalType,
            experience: goals.experience,
            sessionsPerWeek: Math.max(1, Math.min(7, Math.round(goals.sessionsPerWeek || 3))),
            focusMuscles: goals.focusMuscles.filter((m) => (MUSCLE_GROUPS as readonly string[]).includes(m)),
          },
        }
      : {}),
  };
}

/**
 * The model-refined suggestion from the route's 200 body, or null when the body
 * is unusable, is for another exercise, or carries only the rule-based answer.
 */
export function parseOverloadResponse(json: unknown, exerciseId: string): Suggestion | null {
  const L = OVERLOAD_AI;
  if (typeof json !== "object" || json === null) return null;
  const { exercise_id, suggestion } = json as Record<string, unknown>;
  if (exercise_id !== exerciseId || typeof suggestion !== "object" || suggestion === null) return null;
  const { sets, reps, weight, reason, source } = suggestion as Record<string, unknown>;
  if (source !== "ai" || !intIn(sets, 1, L.maxSets) || !intIn(reps, 1, L.maxReps) || !numIn(weight, 0, L.maxWeight)) {
    return null;
  }
  if (typeof reason !== "string") return null;
  const text = reason.replace(/\s+/g, " ").trim().slice(0, L.maxReason).trim();
  return text ? { sets, reps, weight, reason: text } : null;
}

/** Answers per request body, so remounting a card does not ask again. "none" means no refinement. */
const aiCache = new Map<string, Suggestion | "none">();
/** Set once the route says AI is unavailable; no more requests this page session. */
let aiOff = false;

/** Clears the in-memory AI answers (tests). */
export function resetOverloadAi() {
  aiCache.clear();
  aiOff = false;
}

/** Fetches the refinement in the background, once per distinct request. Null until (and unless) one arrives. */
function useAiRefinement(
  exerciseId: string,
  range: RepRange,
  equipment: string | null,
  enabled: boolean,
): Suggestion | null {
  const data = useLiveQuery(
    async () => ({
      sessions: await exerciseSessions(exerciseId, OVERLOAD_AI.maxSessions),
      // The record lib/goals.ts useGoals() reads; read here so the request is built once, with goals loaded.
      goals: ((await db.meta.get("goals"))?.value as Partial<Goals> | undefined) ?? null,
    }),
    [exerciseId],
  );
  const { min, max } = range;
  const body = useMemo(() => {
    if (!enabled || !data) return null;
    const g = data.goals;
    const goals: OverloadGoals | null =
      g && g.goalType && g.experience
        ? { goalType: g.goalType, experience: g.experience, sessionsPerWeek: g.sessionsPerWeek ?? 3, focusMuscles: g.focusMuscles ?? [] }
        : null;
    const b = buildOverloadRequest(exerciseId, data.sessions, { min, max }, equipment, goals);
    return b ? JSON.stringify(b) : null;
  }, [enabled, data, exerciseId, min, max, equipment]);
  const [result, setResult] = useState<{ key: string; value: Suggestion | null } | null>(null);

  useEffect(() => {
    if (!body || aiOff) return;
    const cached = aiCache.get(body);
    if (cached !== undefined) {
      setResult({ key: body, value: cached === "none" ? null : cached });
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    let live = true;
    void (async () => {
      let value: Suggestion | null = null;
      try {
        const res = await fetch("/api/ai/overload-suggestion", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (res.status === 503) aiOff = true;
        else if (res.ok) value = parseOverloadResponse(await res.json(), exerciseId);
        else return; // other failures: nothing shown, a later mount may try again
      } catch {
        return; // network error: the rule-based suggestion stays as it is
      }
      aiCache.set(body, value ?? "none");
      if (live) setResult({ key: body, value });
    })();
    return () => {
      live = false;
    };
  }, [body, exerciseId]);

  return body && result?.key === body ? result.value : null;
}
