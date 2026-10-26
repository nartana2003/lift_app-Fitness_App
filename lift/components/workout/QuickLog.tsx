"use client";

import { useState } from "react";
import { db, uuid, type ActiveExercise, type ActiveSet } from "@/lib/offline/db";
import { dispNum, type Unit } from "@/lib/units";

/** The parse-log route (app/api/ai/parse-log). */
export const ROUTE = "/api/ai/parse-log";

/** Same caps as lib/ai/parse-log.ts (MAX_TEXT, MAX_EXERCISES, MAX_SETS, MAX_REPS, MAX_WEIGHT_KG, MAX_ALTERNATES). */
export const MAX_TEXT = 1_000;
export const MAX_EXERCISES = 20;
export const MAX_SETS = 20;
export const MAX_REPS = 100;
export const MAX_WEIGHT_KG = 1_000;
export const MAX_ALTERNATES = 4;
const MAX_NAME = 80;

export const MSG_UNAVAILABLE = "Quick log is not available right now. You can still add exercises by hand.";
export const MSG_OFFLINE = "You are offline. You can still add exercises by hand.";
export const MSG_FAILED = "Could not read that. You can still add exercises by hand.";
export const MSG_EMPTY = "Nothing to log was found. Try something like bench 3x8 at 60.";
export const MSG_SAVE_FAILED = "Could not add those sets. Try again.";

export type QuickLogSet = { reps: number; weight_kg: number | null };

/** One parsed exercise, as shown in the preview. */
export type QuickLogItem = {
  /** The user's words (or the catalogue name). */
  name: string;
  /** Best catalogue id the app knows, or null when nothing matched. */
  exercise_id: string | null;
  confidence: "high" | "low" | "none";
  /** Other known catalogue ids, best first (the "Did you mean" picker). */
  alternates: string[];
  sets: QuickLogSet[];
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Plain display name: no control characters or angle brackets, capped. */
function safeName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
  return s || null;
}

function cleanSet(v: unknown): QuickLogSet | null {
  if (!isObj(v)) return null;
  if (typeof v.reps !== "number" || !Number.isFinite(v.reps)) return null;
  const reps = Math.min(Math.round(v.reps), MAX_REPS);
  if (reps < 1) return null;
  const w = v.weight_kg;
  const weight_kg =
    typeof w === "number" && Number.isFinite(w) && w > 0 ? Math.min(Math.round(w * 100) / 100, MAX_WEIGHT_KG) : null;
  return { reps, weight_kg };
}

/**
 * Checks the route's 200 body on the client. Ids the app does not know
 * (`known`) are dropped (an unknown best id becomes null, so the user picks).
 * Exercises with no usable sets are dropped. Null when the shape is unusable.
 */
export function parseQuickLog(body: unknown, known: (id: string) => boolean): QuickLogItem[] | null {
  if (!isObj(body) || !Array.isArray(body.exercises)) return null;
  const out: QuickLogItem[] = [];
  for (const raw of body.exercises as unknown[]) {
    if (out.length >= MAX_EXERCISES) break;
    if (!isObj(raw)) continue;
    const sets = (Array.isArray(raw.sets) ? (raw.sets as unknown[]) : [])
      .map(cleanSet)
      .filter((s): s is QuickLogSet => s !== null)
      .slice(0, MAX_SETS);
    if (sets.length === 0) continue;
    const id = typeof raw.exercise_id === "string" && known(raw.exercise_id) ? raw.exercise_id : null;
    const alternates: string[] = [];
    if (Array.isArray(raw.alternates)) {
      for (const a of raw.alternates as unknown[]) {
        if (typeof a === "string" && a !== id && known(a) && !alternates.includes(a)) alternates.push(a);
        if (alternates.length >= MAX_ALTERNATES) break;
      }
    }
    const name = safeName(raw.name);
    if (!name && !id) continue;
    const confidence = id === null ? "none" : raw.confidence === "high" ? "high" : "low";
    out.push({ name: name ?? "Exercise", exercise_id: id, confidence, alternates, sets });
  }
  return out;
}

/** Active-workout rows for confirmed items (sets already done, weights in kg). */
export function toActiveExercises(items: { exercise_id: string; sets: QuickLogSet[] }[], makeId: () => string = uuid): ActiveExercise[] {
  return items.map((it) => ({
    id: makeId(),
    exercise_id: it.exercise_id,
    sets: it.sets.map(
      (s): ActiveSet => ({ id: makeId(), reps: s.reps, weight: s.weight_kg ?? 0, is_warmup: false, rir: null, done: true }),
    ),
  }));
}

/** Appends confirmed items to the running workout. Returns false when no workout is running. */
export async function logToWorkout(items: { exercise_id: string; sets: QuickLogSet[] }[]): Promise<boolean> {
  const rows = toActiveExercises(items);
  let ok = false;
  await db.transaction("rw", db.active, async () => {
    const w = await db.active.get("active");
    if (!w) return;
    w.exercises.push(...rows);
    await db.active.put(w);
    ok = true;
  });
  return ok;
}

/** "3 x 8 @ 60kg", "8, 8, 6 @ 60kg" or "3 x 10" for bodyweight. */
export function setsSummary(sets: QuickLogSet[], unit: Unit): string {
  const groups: { reps: number; w: number | null; n: number }[] = [];
  for (const s of sets) {
    const w = s.weight_kg === null ? null : dispNum(s.weight_kg, unit);
    const last = groups[groups.length - 1];
    if (last && last.reps === s.reps && last.w === w) last.n++;
    else groups.push({ reps: s.reps, w, n: 1 });
  }
  return groups.map((g) => `${g.n} x ${g.reps}${g.w === null ? "" : ` @ ${g.w}${unit}`}`).join(", ");
}

type Row = QuickLogItem & { pick: string | null; keep: boolean };

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "preview"; rows: Row[]; saving: boolean; saveError?: string };

const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/**
 * Quick-log box for the live workout: type (or dictate) "bench 3x8 at 60",
 * preview the parsed sets matched to the catalogue, confirm to add them.
 * Nothing is logged before confirmation. Any failure shows a short message;
 * manual logging is untouched.
 */
export function QuickLog({
  unit,
  nameOf,
  onLog = logToWorkout,
}: {
  unit: Unit;
  /** Catalogue name for an id, or undefined when the app does not know it. */
  nameOf: (id: string) => string | undefined;
  onLog?: (items: { exercise_id: string; sets: QuickLogSet[] }[]) => Promise<boolean | void>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  const close = () => {
    setOpen(false);
    setText("");
    setState({ kind: "idle" });
  };

  const preview = async () => {
    const t = text.trim();
    if (!t) return;
    if (offline()) {
      setState({ kind: "error", message: MSG_OFFLINE });
      return;
    }
    setState({ kind: "loading" });
    try {
      const res = await fetch(ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t.slice(0, MAX_TEXT), unit }),
      });
      if (res.status === 503) {
        setState({ kind: "error", message: MSG_UNAVAILABLE });
        return;
      }
      if (!res.ok) {
        setState({ kind: "error", message: MSG_FAILED });
        return;
      }
      const items = parseQuickLog(await res.json(), (id) => nameOf(id) !== undefined);
      if (!items) {
        setState({ kind: "error", message: MSG_FAILED });
        return;
      }
      if (items.length === 0) {
        setState({ kind: "error", message: MSG_EMPTY });
        return;
      }
      setState({
        kind: "preview",
        saving: false,
        // Only confident matches are ticked; the rest wait for the user's pick.
        rows: items.map((it) => ({ ...it, pick: it.exercise_id, keep: it.exercise_id !== null && it.confidence === "high" })),
      });
    } catch {
      setState({ kind: "error", message: offline() ? MSG_OFFLINE : MSG_FAILED });
    }
  };

  const update = (i: number, patch: Partial<Row>) =>
    setState((s) => (s.kind === "preview" ? { ...s, rows: s.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) } : s));

  const confirm = async (rows: Row[]) => {
    const chosen = rows.filter((r) => r.keep && r.pick).map((r) => ({ exercise_id: r.pick as string, sets: r.sets }));
    if (chosen.length === 0) return;
    setState({ kind: "preview", rows, saving: true });
    try {
      const ok = await onLog(chosen);
      if (ok === false) {
        setState({ kind: "preview", rows, saving: false, saveError: MSG_SAVE_FAILED });
        return;
      }
      close();
    } catch {
      setState({ kind: "preview", rows, saving: false, saveError: MSG_SAVE_FAILED });
    }
  };

  if (!open) {
    return (
      <button type="button" className="btn-ghost w-full mt-3 py-3 border border-border" onClick={() => setOpen(true)}>
        Quick log
      </button>
    );
  }

  const rows = state.kind === "preview" ? state.rows : null;
  const kept = rows ? rows.filter((r) => r.keep && r.pick).length : 0;

  return (
    <section className="card p-3 mt-3 space-y-2" aria-label="Quick log">
      <label className="block">
        <span className="block text-sm font-semibold">Quick log</span>
        <span className="block text-xs text-muted">Type or dictate what you did, for example bench 3x8 at 60.</span>
        <textarea
          className="field mt-2 text-sm"
          rows={2}
          maxLength={MAX_TEXT}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (state.kind === "error") setState({ kind: "idle" });
          }}
          aria-label="Quick log text"
          placeholder="bench 3x8 at 60, then curls 3x12 at 12"
        />
      </label>

      {state.kind === "error" && (
        <p className="text-sm text-muted" role="status">
          {state.message}
        </p>
      )}

      {!rows && (
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-primary flex-1 py-2"
            onClick={preview}
            disabled={state.kind === "loading" || text.trim() === ""}
          >
            {state.kind === "loading" ? "Reading..." : "Preview"}
          </button>
          <button type="button" className="btn-ghost flex-1 py-2" onClick={close}>
            Cancel
          </button>
        </div>
      )}

      {rows && state.kind === "preview" && (
        <>
          <ul className="space-y-2" aria-label="Parsed sets">
            {rows.map((r, i) => {
              const options = [r.exercise_id, ...r.alternates].filter((id): id is string => id !== null);
              const label = r.pick ? nameOf(r.pick) ?? r.name : r.name;
              const unsure = r.confidence !== "high" || r.pick === null;
              return (
                <li key={i} className="rounded-xl border border-border p-2">
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 accent-current"
                      checked={r.keep && r.pick !== null}
                      disabled={r.pick === null || state.saving}
                      onChange={(e) => update(i, { keep: e.target.checked })}
                      aria-label={`Log ${label}`}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-semibold truncate">{label}</span>
                      <span className="block text-xs text-muted">{setsSummary(r.sets, unit)}</span>
                    </span>
                  </label>
                  {unsure && (
                    <div className="mt-2">
                      {options.length > 0 ? (
                        <label className="block text-xs text-muted">
                          {r.pick === null ? `No match for "${r.name}". Did you mean:` : "Did you mean:"}
                          <select
                            className="field mt-1 text-sm"
                            value={r.pick ?? ""}
                            disabled={state.saving}
                            onChange={(e) => update(i, { pick: e.target.value || null, keep: e.target.value !== "" })}
                            aria-label={`Exercise for ${r.name}`}
                          >
                            {r.pick === null && <option value="">Choose an exercise</option>}
                            {options.map((id) => (
                              <option key={id} value={id}>
                                {nameOf(id) ?? id}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : (
                        <p className="text-xs text-muted">No match for &quot;{r.name}&quot;. Add it with Add exercise instead.</p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {state.saveError && (
            <p className="text-sm text-muted" role="status">
              {state.saveError}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-primary flex-1 py-2"
              onClick={() => confirm(rows)}
              disabled={kept === 0 || state.saving}
            >
              {kept === 1 ? "Log 1 exercise" : `Log ${kept} exercises`}
            </button>
            <button type="button" className="btn-ghost flex-1 py-2" onClick={() => setState({ kind: "idle" })} disabled={state.saving}>
              Edit
            </button>
          </div>
          <button type="button" className="w-full text-sm text-muted py-1" onClick={close} disabled={state.saving}>
            Cancel
          </button>
        </>
      )}
    </section>
  );
}
