"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type ActiveExercise } from "@/lib/offline/db";
import type { Exercise } from "@/lib/exercises";
import { exerciseSessions, lastSession, type ExerciseSession } from "@/lib/history";
import { formatSets, parseRepRange, suggest, type RepRange, type Suggestion } from "@/lib/overload";
import type { Goals } from "@/lib/goals";
import { EQUIPMENT, MUSCLE_GROUPS } from "@/lib/muscles";
import { dayKey } from "@/lib/planner";
import { PR_LABEL, type PrType } from "@/lib/prs";
import { restTimer } from "@/lib/restTimer";
import {
  addSet,
  getRestSec,
  moveExercise,
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

export const RIR_OPTIONS = [
  { v: 3, emoji: "😎", label: "Easy" },
  { v: 2, emoji: "💪", label: "Good" },
  { v: 1, emoji: "😤", label: "Hard" },
  { v: 0, emoji: "🔥", label: "Failure" },
];

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
  const { unit } = useSettings();
  const [menu, setMenu] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const name = info?.name ?? ex.exercise_id;

  const lastWork = last?.sets.filter((s) => !s.is_warmup) ?? [];
  const range = parseRepRange(repTarget ?? ex.target_reps);
  const sug = last ? suggest(last.sets, range, info?.equipment ?? "Other") : null;
  const allDone = ex.sets.every((s) => s.done);
  const ai = useAiRefinement(ex.exercise_id, range, info?.equipment ?? null, !!sug && !allDone);
  // Ask for effort on the most recently ticked working set, until it's rated.
  const lastDone = ex.sets.findLast((s) => s.done && !s.is_warmup);
  const rateSet = lastDone?.rir === null ? lastDone : undefined;

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
        <Link href={`/exercises/${ex.exercise_id}`}>
          <ExerciseDemo urls={info?.image_urls.slice(0, 1) ?? []} alt={name} small />
        </Link>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold leading-tight">{name}</h3>
          <p className="text-xs text-muted mt-0.5">
            {lastWork.length ? `Last time: ${formatSets(lastWork, unit)}` : "First time — set a baseline"}
          </p>
        </div>
        <button className="p-1 text-muted text-xl leading-none" onClick={() => setMenu(!menu)} aria-label="Options">
          ⋯
        </button>
      </div>

      {menu && (
        <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <button className="btn-ghost py-2" onClick={() => moveExercise(ex.id, -1)}>↑ Move up</button>
          <button className="btn-ghost py-2" onClick={() => moveExercise(ex.id, 1)}>↓ Move down</button>
          <label className="btn-ghost py-2 col-span-2">
            Rest
            <select
              className="bg-transparent"
              value={rest}
              onChange={(e) => setRestSec(ex.exercise_id, Number(e.target.value))}
            >
              {[30, 45, 60, 75, 90, 120, 150, 180, 240, 300].map((s) => (
                <option key={s} value={s}>{fmtClock(s)}</option>
              ))}
            </select>
          </label>
          <button
            className="btn-ghost py-2 col-span-2"
            onClick={() => {
              setMenu(false);
              setSwapping(true);
            }}
          >
            ⇄ Swap exercise
          </button>
          <button className="btn-ghost py-2 col-span-2 text-bad" onClick={() => removeExercise(ex.id)}>
            Remove exercise
          </button>
        </div>
      )}

      {sug && !allDone && (
        <button onClick={() => applySuggestion()} className="mt-3 w-full text-left rounded-xl bg-accent/10 border border-accent/30 px-3 py-2">
          <p className="text-xs text-accent font-semibold">
            Today: {sug.sets}×{sug.reps} @ {fmtWeight(sug.weight, unit)} <span className="text-muted font-normal">· tap to use</span>
          </p>
          <p className="text-[11px] text-muted">{sug.reason}</p>
        </button>
      )}

      {sug && !allDone && ai && (
        <button
          onClick={() => applySuggestion(ai)}
          className="mt-2 w-full text-left rounded-xl border border-border px-3 py-2"
        >
          <p className="text-xs font-semibold">
            AI refined: {ai.sets}×{ai.reps} @ {fmtWeight(ai.weight, unit)}{" "}
            <span className="text-muted font-normal">· tap to use</span>
          </p>
          <p className="text-[11px] text-muted">{ai.reason}</p>
        </button>
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
            <div
              key={s.id}
              className={`grid grid-cols-[2rem_1fr_4.5rem_4rem_2.75rem] gap-2 items-center rounded-lg px-1 py-1 ${
                s.done ? "bg-good/10" : ""
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
          );
        })}
      </div>

      {rateSet && (
        <div className="mt-2 rounded-xl bg-surface-2 p-2">
          <p className="text-xs text-muted mb-1.5 px-1">How did the last reps feel?</p>
          <div className="grid grid-cols-4 gap-1.5">
            {RIR_OPTIONS.map((o) => (
              <button
                key={o.v}
                className="rounded-lg bg-surface border border-border py-1.5 text-xs"
                onClick={() => updateSet(ex.id, rateSet.id, { rir: o.v })}
              >
                <span className="block text-base">{o.emoji}</span>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2 mt-2">
        <button className="btn-ghost flex-1 py-2 text-sm" onClick={() => addSet(ex.id)}>+ Add set</button>
        {ex.sets.some((s) => !s.done) && ex.sets.length > 1 && (
          <button
            className="btn-ghost py-2 px-3 text-sm text-muted"
            onClick={() => {
              const undone = ex.sets.findLast((s) => !s.done);
              if (undone) void removeSet(ex.id, undone.id);
            }}
          >
            − Set
          </button>
        )}
      </div>

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
