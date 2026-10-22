"use client";

// "Generate 3-day plan": asks POST /api/ai/generate-routines for three routines
// built from the user's split, equipment and recent history, shows them for
// review, and saves only the days the user keeps (createRoutine, source "ai").
// Any failure (no key, offline, bad answer) shows a short plain message; the
// existing manual routine flow is untouched.
import { useState } from "react";
import { MUSCLE_GROUPS, EQUIPMENT, type Equipment, type MuscleGroup } from "@/lib/muscles";
import { useSplit, type Split } from "@/lib/splits";
import { equipmentForAi, useEquipment } from "@/lib/equipment";
import { loadCatalogue, useCatalogue } from "@/lib/catalogue";
import { workoutsBetween } from "@/lib/history";
import { addDays } from "@/lib/stats";
import { createRoutine } from "@/lib/routines";

export const ROUTE = "/api/ai/generate-routines";
/** History window sent to the route. */
export const HISTORY_DAYS = 90;
/** Same limits the route enforces. */
export const MAX_HISTORY = 100;
export const MAX_SPLIT_DAYS = 7;
export const MAX_NAME = 40;
export const MAX_PER_DAY = 8;
export const MAX_SETS = 6;
const MAX_NOTE = 240;
const MAX_DAYS = 3;
const DEFAULT_REPS = "8-12";

export const MSG_UNAVAILABLE = "AI plans are not available right now. You can still build routines by hand.";
export const MSG_OFFLINE = "You are offline. You can still build routines by hand.";
export const MSG_FAILED = "Could not generate a plan. You can still build routines by hand.";
export const MSG_NO_SPLIT = "Set up your split in Profile first, then generate a plan.";

const ID_RE = /^[A-Za-z0-9_\-]{1,80}$/;
const SAFE_CHAR = /[\p{L}\p{N} &/+\-().,]/u;
const REPS_RE = /^(\d{1,2}(-\d{1,2})?|\d{1,3}s)$/;

export type HistoryEntry = {
  exercise_id: string;
  sessions: number;
  best_weight?: number;
  best_reps?: number;
  last_date?: string;
};

export type PlanExercise = { exercise_id: string; target_sets: number; target_reps: string };
export type PlanDay = { name: string; muscles: MuscleGroup[]; notes: string | null; exercises: PlanExercise[] };

/** Minimal workout shape the history builder reads (WorkoutDetail fits it). */
export type HistoryWorkout = {
  started_at: string;
  exercises: { exercise_id: string; sets: { reps: number; weight: number; is_warmup?: boolean }[] }[];
};

const isMuscle = (v: unknown): v is MuscleGroup => typeof v === "string" && (MUSCLE_GROUPS as readonly string[]).includes(v);
const isEquipment = (v: unknown): v is Equipment => typeof v === "string" && (EQUIPMENT as readonly string[]).includes(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * A name the route will accept: unsupported characters become spaces,
 * whitespace collapses and the length is capped. Empty falls back.
 */
export function safeName(v: string, fallback: string): string {
  const s = [...v.normalize("NFKC")]
    .map((c) => (SAFE_CHAR.test(c) ? c : " "))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME)
    .trim();
  return s || fallback;
}

/**
 * Per-exercise history from finished workouts: how many sessions included it,
 * the heaviest working weight, the most working reps and the last date.
 * Most-done first, capped at MAX_HISTORY. Ids the route would refuse are dropped.
 */
export function buildHistory(workouts: HistoryWorkout[]): HistoryEntry[] {
  const acc = new Map<string, { sessions: number; w: number; r: number; last: string }>();
  for (const w of workouts) {
    const date = new Date(w.started_at);
    if (Number.isNaN(date.getTime())) continue;
    const day = ymd(date);
    const seen = new Set<string>();
    for (const e of w.exercises) {
      if (!ID_RE.test(e.exercise_id)) continue;
      const cur = acc.get(e.exercise_id) ?? { sessions: 0, w: 0, r: 0, last: "" };
      if (!seen.has(e.exercise_id)) {
        cur.sessions++;
        seen.add(e.exercise_id);
      }
      for (const s of e.sets) {
        if (s.is_warmup) continue;
        if (Number.isFinite(s.weight)) cur.w = Math.max(cur.w, s.weight);
        if (Number.isFinite(s.reps)) cur.r = Math.max(cur.r, s.reps);
      }
      if (day > cur.last) cur.last = day;
      acc.set(e.exercise_id, cur);
    }
  }
  return [...acc.entries()]
    .sort((a, b) => b[1].sessions - a[1].sessions || b[1].last.localeCompare(a[1].last))
    .slice(0, MAX_HISTORY)
    .map(([exercise_id, v]) => {
      const entry: HistoryEntry = { exercise_id, sessions: Math.min(10_000, v.sessions) };
      if (v.w > 0) entry.best_weight = Math.min(2000, Math.round(v.w * 100) / 100);
      if (v.r > 0) entry.best_reps = Math.min(1000, Math.round(v.r));
      if (v.last) entry.last_date = v.last;
      return entry;
    });
}

/** True when the split has at least one day with muscles (the route needs one). */
export function hasTrainingDay(split: Split): boolean {
  return split.days.some((d) => d.muscles.some(isMuscle));
}

/** Request body in the route's shape. Names are made safe, unknown values dropped. */
export function buildRequestBody(split: Split, equipment: readonly Equipment[], history: HistoryEntry[]) {
  const days = split.days.slice(0, MAX_SPLIT_DAYS).map((d, i) => ({
    name: safeName(d.name, `Day ${i + 1}`),
    muscles: [...new Set(d.muscles.filter(isMuscle))],
  }));
  return {
    split: { name: safeName(split.name, ""), days },
    equipment: equipmentForAi(equipment.filter(isEquipment)),
    history: history.slice(0, MAX_HISTORY),
  };
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return s || null;
}

/**
 * Checks the route's 200 body and returns up to 3 days, or null when nothing
 * usable came back. Exercises must be known to `known` (the catalogue the app
 * shows); numbers are clamped and duplicates dropped. Days left empty are removed.
 */
export function parsePlan(json: unknown, known: (id: string) => boolean): PlanDay[] | null {
  if (!isObj(json) || !isObj(json.plan) || !Array.isArray(json.plan.days)) return null;
  const out: PlanDay[] = [];
  for (const [i, raw] of json.plan.days.slice(0, MAX_DAYS).entries()) {
    if (!isObj(raw) || !Array.isArray(raw.exercises)) continue;
    const exercises: PlanExercise[] = [];
    for (const e of raw.exercises) {
      if (exercises.length >= MAX_PER_DAY) break;
      if (!isObj(e) || typeof e.exercise_id !== "string" || !ID_RE.test(e.exercise_id) || !known(e.exercise_id)) continue;
      if (exercises.some((x) => x.exercise_id === e.exercise_id)) continue;
      const sets = typeof e.target_sets === "number" && Number.isFinite(e.target_sets) ? Math.round(e.target_sets) : 3;
      const reps = typeof e.target_reps === "string" && REPS_RE.test(e.target_reps.trim()) ? e.target_reps.trim() : DEFAULT_REPS;
      exercises.push({ exercise_id: e.exercise_id, target_sets: Math.min(MAX_SETS, Math.max(1, sets)), target_reps: reps });
    }
    if (exercises.length === 0) continue;
    out.push({
      name: cleanText(raw.name, 60) ?? `Day ${i + 1}`,
      muscles: Array.isArray(raw.muscles) ? [...new Set(raw.muscles.filter(isMuscle))] : [],
      notes: cleanText(raw.notes, MAX_NOTE),
      exercises,
    });
  }
  return out.length ? out : null;
}

/** Saves the chosen days as routines (source "ai"), in plan order. Returns the new ids. */
export async function savePlanDays(days: PlanDay[]): Promise<string[]> {
  const ids: string[] = [];
  for (const d of days) {
    ids.push(
      await createRoutine({
        name: d.name,
        exercises: d.exercises.map((e) => ({ ...e })),
        source: "ai",
        kind: "routine",
        notes: d.notes ?? undefined,
      }),
    );
  }
  return ids;
}

/** History for the request: finished workouts over the last HISTORY_DAYS days. */
export async function loadHistory(now = new Date()): Promise<HistoryEntry[]> {
  return buildHistory(await workoutsBetween(addDays(now, -HISTORY_DAYS), addDays(now, 1)));
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "review"; days: PlanDay[]; keep: boolean[] }
  | { kind: "saving"; days: PlanDay[]; keep: boolean[] }
  | { kind: "saved"; count: number };

const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/** Generate a 3-day plan, review it, keep the days you want, save them as routines. */
export function GeneratePlan({
  getHistory = loadHistory,
  split: splitProp,
  equipment: equipmentProp,
}: {
  getHistory?: () => Promise<HistoryEntry[]>;
  /** Defaults to the saved split. */
  split?: Split;
  /** Defaults to the saved equipment. */
  equipment?: Equipment[];
} = {}) {
  const savedSplit = useSplit();
  const savedEquipment = useEquipment();
  const split = splitProp ?? savedSplit;
  const equipment = equipmentProp ?? savedEquipment;
  const { get } = useCatalogue();
  const [state, setState] = useState<State>({ kind: "idle" });

  const generate = async () => {
    if (!hasTrainingDay(split)) {
      setState({ kind: "error", message: MSG_NO_SPLIT });
      return;
    }
    if (offline()) {
      setState({ kind: "error", message: MSG_OFFLINE });
      return;
    }
    setState({ kind: "loading" });
    try {
      let history: HistoryEntry[] = [];
      try {
        history = await getHistory();
      } catch {
        history = [];
      }
      const res = await fetch(ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildRequestBody(split, equipment, history)),
      });
      if (res.status === 503) {
        setState({ kind: "error", message: MSG_UNAVAILABLE });
        return;
      }
      if (!res.ok) {
        setState({ kind: "error", message: MSG_FAILED });
        return;
      }
      const body: unknown = await res.json();
      // Make sure the built-in catalogue is loaded so ids can be checked and named.
      let builtIn: Set<string> = new Set();
      try {
        builtIn = new Set((await loadCatalogue()).list.map((e) => e.id));
      } catch {
        // Unreachable catalogue: only exercises already known to the app count.
      }
      const days = parsePlan(body, (id) => builtIn.has(id) || !!get(id));
      setState(days ? { kind: "review", days, keep: days.map(() => true) } : { kind: "error", message: MSG_FAILED });
    } catch {
      setState({ kind: "error", message: offline() ? MSG_OFFLINE : MSG_FAILED });
    }
  };

  const toggle = (i: number) =>
    setState((s) => (s.kind === "review" ? { ...s, keep: s.keep.map((k, j) => (j === i ? !k : k)) } : s));

  const save = async (days: PlanDay[], keep: boolean[]) => {
    const chosen = days.filter((_, i) => keep[i]);
    if (chosen.length === 0) return;
    setState({ kind: "saving", days, keep });
    try {
      await savePlanDays(chosen);
      setState({ kind: "saved", count: chosen.length });
    } catch {
      setState({ kind: "error", message: "Could not save the routines. Try again." });
    }
  };

  const reviewing = state.kind === "review" || state.kind === "saving";
  const kept = reviewing ? state.keep.filter(Boolean).length : 0;

  return (
    <div className="card p-3 mt-3">
      <div className="flex items-start justify-between gap-2">
        <span>
          <span className="block text-sm font-semibold">Generate 3-day plan</span>
          <span className="block text-xs text-muted">From your split, equipment and recent training.</span>
        </span>
        {!reviewing && (
          <button type="button" className="chip text-xs shrink-0" onClick={generate} disabled={state.kind === "loading"}>
            {state.kind === "loading" ? "Working..." : "Generate"}
          </button>
        )}
      </div>

      {state.kind === "error" && (
        <p role="status" className="text-xs text-muted mt-2">
          {state.message}
        </p>
      )}
      {state.kind === "saved" && (
        <p role="status" className="text-xs text-muted mt-2">
          Saved {state.count} routine{state.count === 1 ? "" : "s"}.
        </p>
      )}

      {reviewing && (
        <>
          <p className="text-xs text-muted mt-2">Review the plan. Untick a day to leave it out, then save.</p>
          <ul className="mt-2 space-y-2" aria-label="Generated plan">
            {state.days.map((d, i) => (
              <li key={i} className="rounded-xl border border-border p-2">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={state.keep[i]}
                    onChange={() => toggle(i)}
                    disabled={state.kind === "saving"}
                    aria-label={`Keep ${d.name}`}
                  />
                  <span className="text-sm font-semibold flex-1">{d.name}</span>
                </label>
                {d.notes && <p className="text-xs text-muted mt-1">{d.notes}</p>}
                <ul className="mt-1 space-y-0.5">
                  {d.exercises.map((e) => (
                    <li key={e.exercise_id} className="flex justify-between gap-2 text-xs">
                      <span className="truncate">{get(e.exercise_id)?.name ?? e.exercise_id}</span>
                      <span className="text-muted tabular-nums shrink-0">
                        {e.target_sets} x {e.target_reps}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <div className="flex gap-2 mt-3">
            <button
              type="button"
              className="btn-primary flex-1"
              disabled={kept === 0 || state.kind === "saving"}
              onClick={() => save(state.days, state.keep)}
            >
              {state.kind === "saving" ? "Saving..." : `Save ${kept} routine${kept === 1 ? "" : "s"}`}
            </button>
            <button
              type="button"
              className="btn-ghost flex-1"
              disabled={state.kind === "saving"}
              onClick={() => setState({ kind: "idle" })}
            >
              Discard
            </button>
          </div>
        </>
      )}
    </div>
  );
}
