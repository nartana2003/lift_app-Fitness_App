"use client";

// Coach > Optimise (CO-06): compares the saved split and its routines with the
// goals, shows a per-muscle analysis and "Lift noticed" lines, and proposes
// changes the user accepts, rejects or swaps one by one. Apply all writes every
// change that is not rejected (lib/coachApply.ts) and offers one step of Undo.
// The changes come from the rules (lib/coachOptimise.ts) in the browser; when
// /api/ai/optimise-split answers, its order and wording are used, clamped to the
// rule changes. On 503, offline or a bad answer the rule result is shown as is.
// Past workouts are never touched.
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/offline/db";
import { listRoutines } from "@/lib/routines";
import { ensureSplitDayIds, useSplit, type Split } from "@/lib/splits";
import { goalsFingerprint, useGoals, type Goals } from "@/lib/goals";
import { useCatalogue } from "@/lib/catalogue";
import { equipmentForAi, useEquipment } from "@/lib/equipment";
import { isCustomId } from "@/lib/customExercises";
import type { Exercise } from "@/lib/exercises";
import type { Equipment, MuscleGroup } from "@/lib/muscles";
import { analyseSplit, proposeChanges, type Analysis, type Change, type MuscleStatus, type PlanRoutine } from "@/lib/coachOptimise";
import { applyChanges, undoOptimise, UNDO_KEY, type ApplyResult } from "@/lib/coachApply";
import { MSG_AI_UNAVAILABLE, MSG_OFFLINE } from "../goals/CoachSetup";
import { EvidenceList } from "./EvidenceList";
import { ReplaceSheet } from "./ReplaceSheet";

export const OPTIMISE_ROUTE = "/api/ai/optimise-split";
/** Same caps as the route (lib/ai/optimise-split.ts). */
const MAX_ROUTINES = 14;
const MAX_EXERCISES_PER_ROUTINE = 20;
const MAX_DISLIKED = 100;
const MAX_WHY = 240;

export const STATUS_LABELS: Record<MuscleStatus, string> = { good: "Good", ok: "OK", low: "Low", none: "Not trained" };
export const MSG_NOTHING_TO_CHANGE = "Your split and routines already fit your goals. Nothing to change.";
export const MSG_UNDONE = "Undone. Your split and routines are back as they were.";

type Decision = "accepted" | "rejected";

type Result = {
  analysis: Analysis;
  changes: Change[];
  emptied: MuscleGroup[];
  source: "ai" | "rules";
  message: string | null;
  /** Day names at the time of the run. */
  dayNames: Record<string, string>;
  /** Exercise ids in each routine at the time of the run. */
  routineIds: Record<string, string[]>;
};

/** The routines the Coach reads: kind "routine", newest first, as PlanRoutine. */
export function planRoutines(rows: readonly { id: string; name: string; kind: string; split_day_id?: string | null; exercises: readonly { exercise_id: string; target_sets: number; target_reps: string }[] }[]): PlanRoutine[] {
  return rows
    .filter((r) => r.kind === "routine")
    .map((r) => ({
      id: r.id,
      name: r.name,
      split_day_id: r.split_day_id ?? null,
      exercises: r.exercises.map((e) => ({ exercise_id: e.exercise_id, target_sets: e.target_sets, target_reps: e.target_reps })),
    }));
}

/**
 * The body for /api/ai/optimise-split. Only routines linked to a split day are
 * sent, and custom exercises are never sent (the route only knows the catalogue).
 */
export function optimiseRequestBody(goals: Goals, split: Split, routines: readonly PlanRoutine[], equipment: readonly Equipment[]) {
  const dayIds = new Set(split.days.flatMap((d) => (d.id ? [d.id] : [])));
  return {
    goals: {
      goalType: goals.goalType,
      experience: goals.experience,
      sessionsPerWeek: goals.sessionsPerWeek,
      focusMuscles: goals.focusMuscles,
      priorities: goals.priorities,
      targets: goals.targets,
      limitations: goals.limitations,
      dislikedIds: goals.dislikedIds.filter((id) => !isCustomId(id)).slice(0, MAX_DISLIKED),
    },
    split: { name: split.name, days: split.days.filter((d) => d.id).map((d) => ({ id: d.id, name: d.name, muscles: d.muscles })) },
    routines: routines
      .filter((r) => r.split_day_id && dayIds.has(r.split_day_id))
      .slice(0, MAX_ROUTINES)
      .map((r) => ({
        id: r.id,
        split_day_id: r.split_day_id,
        exercises: r.exercises.filter((e) => !isCustomId(e.exercise_id)).slice(0, MAX_EXERCISES_PER_ROUTINE),
      })),
    equipment: equipmentForAi(equipment),
  };
}

/**
 * The route's answer clamped to the rule changes: the rule changes in the answer's
 * order (unknown ids and repeats dropped), each with the answer's reason when it is
 * a short plain line, then the ones it left out in rule order. Null when the answer
 * has no usable change.
 */
export function readOptimiseAnswer(json: unknown, rule: readonly Change[]): Change[] | null {
  if (!json || typeof json !== "object" || !Array.isArray((json as { changes?: unknown }).changes)) return null;
  const byId = new Map(rule.map((c) => [c.id, c]));
  const out: Change[] = [];
  for (const raw of (json as { changes: unknown[] }).changes) {
    if (!raw || typeof raw !== "object") continue;
    const { id, why } = raw as { id?: unknown; why?: unknown };
    const base = typeof id === "string" ? byId.get(id) : undefined;
    if (!base || out.some((c) => c.id === base.id)) continue;
    const text = typeof why === "string" ? why.trim() : "";
    out.push({ ...base, why: text && text.length <= MAX_WHY && !/[<>]/.test(text) ? text : base.why });
  }
  if (out.length === 0) return null;
  for (const c of rule) if (!out.some((x) => x.id === c.id)) out.push(c);
  return out;
}

/** One plain headline for a change card. */
export function changeTitle(c: Change, nameOf: (id: string | null) => string, dayName: string): string {
  if (c.kind === "add_muscle") return `Add ${c.muscle} to ${dayName}`;
  if (c.kind === "add_exercise") return `Add ${nameOf(c.exerciseId)} to ${dayName}`;
  if (c.kind === "swap_exercise") return `Swap ${nameOf(c.replaceExerciseId)} for ${nameOf(c.exerciseId)}`;
  return `Add a set to ${nameOf(c.exerciseId)}`;
}

function changeDetail(c: Change, dayName: string): string {
  if (c.kind === "add_muscle") return "Split day";
  if (c.kind === "add_exercise") return `${dayName} · ${c.sets ?? 3} x ${c.reps ?? "8-12"}`;
  if (c.kind === "swap_exercise") return `${dayName} · same sets and reps`;
  return `${dayName} · ${c.sets} sets`;
}

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

async function askRoute(body: unknown, rule: readonly Change[]): Promise<{ changes: Change[] | null; offline: boolean }> {
  if (isOffline()) return { changes: null, offline: true };
  try {
    const res = await fetch(OPTIMISE_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return { changes: null, offline: false };
    const json = (await res.json()) as { source?: unknown };
    // A "rules" answer is the same rules the browser already ran.
    return { changes: json?.source === "ai" ? readOptimiseAnswer(json, rule) : null, offline: false };
  } catch {
    return { changes: null, offline: isOffline() };
  }
}

const badge = (s: MuscleStatus) =>
  `shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${s === "good" ? "bg-accent text-accent-ink" : s === "ok" ? "border border-border" : "bg-surface-2"}`;

export function OptimiseSplit() {
  const goals = useGoals();
  const split = useSplit();
  const catalogue = useCatalogue();
  const equipment = useEquipment();
  const routines = useLiveQuery(() => listRoutines(), []);
  const hasUndo = useLiveQuery(async () => !!(await db.meta.get(UNDO_KEY))?.value, []);

  const [result, setResult] = useState<Result | null>(null);
  const [running, setRunning] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  /** Change id -> the exercise the user picked instead. */
  const [picked, setPicked] = useState<Record<string, Exercise>>({});
  const [evidenceOpen, setEvidenceOpen] = useState<string | null>(null);
  const [swapping, setSwapping] = useState<Change | null>(null);
  const [applied, setApplied] = useState<(ApplyResult & { routineIds: string[] }) | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const nameOf = (id: string | null) => (id ? (catalogue.get(id)?.name ?? id) : "");

  /** The change as it will be applied: with the user's swapped-in exercise. */
  const finalChange = (c: Change): Change => {
    const e = picked[c.id];
    return e ? { ...c, exerciseId: e.id, why: `${e.name} is the replacement you chose for ${nameOf(c.kind === "swap_exercise" ? c.replaceExerciseId : c.exerciseId)}.` } : c;
  };

  async function run() {
    setRunning(true);
    setStatus(null);
    setApplied(null);
    setDecisions({});
    setPicked({});
    setEvidenceOpen(null);
    const current = (await ensureSplitDayIds()) ?? split;
    const plan = planRoutines(await listRoutines());
    const input = { goals, split: current, routines: plan, catalogue: catalogue.exercises, equipment: equipmentForAi(equipment) };
    const analysis = analyseSplit(input);
    const proposals = proposeChanges(input);
    const dayNames = Object.fromEntries(current.days.flatMap((d) => (d.id ? [[d.id, d.name]] : [])));
    const routineIds = Object.fromEntries(plan.map((r) => [r.id, r.exercises.map((x) => x.exercise_id)]));
    let changes = proposals.changes;
    let source: Result["source"] = "rules";
    let message: string | null = null;
    if (changes.length > 0) {
      const ai = await askRoute(optimiseRequestBody(goals, current, plan, equipment), changes);
      if (ai.changes) {
        changes = ai.changes;
        source = "ai";
      } else message = ai.offline ? MSG_OFFLINE : MSG_AI_UNAVAILABLE;
    }
    setResult({ analysis, changes, emptied: proposals.emptied, source, message, dayNames, routineIds });
    setRunning(false);
  }

  const decide = (id: string, d: Decision) => setDecisions((cur) => ({ ...cur, [id]: d }));

  async function applyAll() {
    if (!result) return;
    const list = result.changes.filter((c) => decisions[c.id] !== "rejected").map(finalChange);
    const res = await applyChanges(list, { builtFor: goalsFingerprint(goals) });
    const routineIds = [...new Set(list.filter((c) => res.applied.includes(c.id) && c.routineId).map((c) => c.routineId!))];
    setApplied({ ...res, routineIds });
    setStatus(res.applied.length === 0 ? "Nothing was applied: your split or routines changed since. Run Optimise again." : null);
  }

  async function undo() {
    if (await undoOptimise()) {
      setApplied(null);
      setResult(null);
      setStatus(MSG_UNDONE);
    }
  }

  if (split.days.length === 0) {
    return <p className="px-4 pb-4 text-sm text-muted">Set up a split first in Build a split, then Optimise checks it against your goals.</p>;
  }

  const toApply = result ? result.changes.filter((c) => decisions[c.id] !== "rejected").length : 0;
  const routineName = (id: string) => routines?.find((r) => r.id === id)?.name ?? "Routine";

  return (
    <div className="px-4 pb-4 space-y-4" aria-label="Optimise" role="region">
      <button className={applied ? "btn-ghost w-full" : "btn-primary w-full"} onClick={run} disabled={running || !routines}>
        {running ? "Checking your split…" : result || applied ? "Optimise again" : "Optimise my split"}
      </button>
      {status && <p className="text-sm">{status}</p>}

      {result && !applied && (
        <>
          <section aria-label="Muscle analysis">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">Analysis</h3>
            <ul className="space-y-1.5">
              {result.analysis.rows.map((r) => (
                <li key={r.muscle} className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2">
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium">{r.muscle}</span>
                    <span className="block text-xs text-muted">
                      {r.estimated ? "About " : ""}
                      {r.weeklySets} of {r.target} sets a week{r.priority ? ` · ${r.priority} priority` : ""}
                    </span>
                  </span>
                  <span className={badge(r.status)}>{STATUS_LABELS[r.status]}</span>
                </li>
              ))}
            </ul>
          </section>

          {result.analysis.notes.length > 0 && (
            <section aria-label="Lift noticed">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">Lift noticed</h3>
              <ul className="space-y-1 text-sm list-disc pl-5">
                {result.analysis.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </section>
          )}

          {result.emptied.length > 0 && (
            <p className="text-xs text-muted">Your limits and never-suggest list leave nothing to suggest for {result.emptied.join(", ")}.</p>
          )}

          {result.changes.length === 0 ? (
            <p className="text-sm">{MSG_NOTHING_TO_CHANGE}</p>
          ) : (
            <section aria-label="Suggested changes">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">Suggested changes</h3>
              {result.message && <p className="text-xs text-muted mb-2">{result.message}</p>}
              <ul className="space-y-2">
                {result.changes.map((raw) => {
                  const c = finalChange(raw);
                  const day = result.dayNames[c.dayId] ?? "a day";
                  const title = changeTitle(c, nameOf, day);
                  const d = decisions[c.id];
                  const canSwap = (c.kind === "add_exercise" || c.kind === "swap_exercise") && !!catalogue.get(c.exerciseId ?? "");
                  return (
                    <li key={c.id} aria-label={title} className={`rounded-xl border border-border p-3 ${d === "rejected" ? "opacity-50" : ""}`}>
                      <p className="text-sm font-semibold">{title}</p>
                      <p className="text-xs text-muted">{changeDetail(c, day)}</p>
                      <p className="text-sm mt-1.5">{c.why}</p>
                      {d && <p className="text-xs font-semibold mt-1.5">{d === "accepted" ? "Accepted" : "Rejected"}</p>}
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        <button className={d === "accepted" ? "chip-on text-xs" : "chip text-xs"} aria-pressed={d === "accepted"} onClick={() => decide(c.id, "accepted")}>
                          Accept
                        </button>
                        <button className={d === "rejected" ? "chip-on text-xs" : "chip text-xs"} aria-pressed={d === "rejected"} onClick={() => decide(c.id, "rejected")}>
                          Reject
                        </button>
                        {canSwap && (
                          <button className="chip text-xs" onClick={() => setSwapping(raw)}>
                            Swap exercise
                          </button>
                        )}
                        <button
                          className={evidenceOpen === c.id ? "chip-on text-xs" : "chip text-xs"}
                          aria-expanded={evidenceOpen === c.id}
                          onClick={() => setEvidenceOpen(evidenceOpen === c.id ? null : c.id)}
                        >
                          View Evidence
                        </button>
                      </div>
                      {evidenceOpen === c.id && (
                        <div className="mt-2">
                          <EvidenceList ids={c.evidenceIds} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              <button className="btn-primary w-full mt-3" onClick={applyAll} disabled={toApply === 0}>
                Apply all ({toApply})
              </button>
              <p className="text-xs text-muted mt-1.5">Applies every change you have not rejected. Past workouts are never changed.</p>
            </section>
          )}
        </>
      )}

      {applied && applied.applied.length > 0 && (
        <section aria-label="Updated split" className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Updated split</h3>
          <p className="text-sm">
            {applied.applied.length} {applied.applied.length === 1 ? "change" : "changes"} applied
            {applied.skipped.length > 0 ? `, ${applied.skipped.length} skipped because the plan changed since` : ""}.
          </p>
          <ul className="space-y-1.5">
            {split.days.map((d, i) => (
              <li key={d.id ?? i} className="rounded-xl bg-surface-2 px-3 py-2 text-sm">
                <span className="font-medium">{d.name}</span>
                <span className="block text-xs text-muted">{d.muscles.join(", ")}</span>
              </li>
            ))}
          </ul>
          {applied.routineIds.length > 0 && (
            <p className="text-xs text-muted">Routines updated: {applied.routineIds.map(routineName).join(", ")}</p>
          )}
        </section>
      )}

      {hasUndo && (
        <button className="btn-ghost w-full" onClick={undo}>
          Undo
        </button>
      )}

      {swapping && catalogue.get(swapping.exerciseId ?? "") && (
        <ReplaceSheet
          current={picked[swapping.id] ?? catalogue.get(swapping.exerciseId!)!}
          why={finalChange(swapping).why}
          evidenceIds={swapping.evidenceIds}
          exclude={[
            ...(swapping.routineId ? (result?.routineIds[swapping.routineId] ?? []) : []),
            ...(result?.changes.flatMap((c) => (c.exerciseId ? [finalChange(c).exerciseId!] : [])) ?? []),
          ]}
          onPick={(e) => {
            setPicked((cur) => ({ ...cur, [swapping.id]: e }));
            setSwapping(null);
          }}
          onClose={() => setSwapping(null)}
        />
      )}
    </div>
  );
}
