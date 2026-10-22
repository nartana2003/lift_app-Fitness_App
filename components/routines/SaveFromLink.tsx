"use client";

// "Save from link": paste a TikTok, Instagram or YouTube link plus the post's
// caption, ask POST /api/ai/social-import to read the exercises out of the
// caption, review and edit them, then save them as a mini workout
// (createRoutine, kind "mini", source "social"). Exercises not in the
// catalogue become custom exercises with the link as their video. The server
// never gets the link: it stays on the device and is stored on the routine.
// Any failure (no key, offline, bad answer) shows a short plain message; the
// manual routine flow is untouched.
import { useState } from "react";
import { EQUIPMENT, MUSCLE_GROUPS, type Equipment, type MuscleGroup } from "@/lib/muscles";
import { loadCatalogue, useCatalogue } from "@/lib/catalogue";
import { createRoutine } from "@/lib/routines";
import { ensureCustomExercise } from "@/lib/customExercises";
import { db, type RoutineRow } from "@/lib/offline/db";
import { enqueue } from "@/lib/offline/sync";

export const ROUTE = "/api/ai/social-import";
/** Same caps the route enforces. */
export const MAX_CAPTION = 4_000;
export const MAX_NOTES = 1_000;
export const MAX_URL = 2_048;
export const MAX_EXERCISES = 12;
export const MAX_SETS = 6;
export const MAX_NAME = 60;
const MAX_NOTE = 240;
const DEFAULT_SETS = 3;
const DEFAULT_REPS = "8-12";
const DEFAULT_NAME = "Saved workout";

export const MSG_UNAVAILABLE = "Reading workouts from links is not available right now. You can still build routines by hand.";
export const MSG_OFFLINE = "You are offline. You can still build routines by hand.";
export const MSG_FAILED = "Could not read a workout from that post. You can still build routines by hand.";
export const MSG_BAD_LINK = "Paste a TikTok, Instagram or YouTube link.";
export const MSG_NO_TEXT = "Paste the caption or describe the workout.";
export const MSG_EMPTY = "No exercises found in that post. You can still build routines by hand.";
export const MSG_SAVE_FAILED = "Could not save the workout. Try again.";
export const MSG_SHARED = "Link added. Paste the caption or describe the workout, then tap Read workout.";
export const MSG_NO_SHARED_LINK = "No link came through. Paste a TikTok, Instagram or YouTube link.";

export type Platform = NonNullable<RoutineRow["platform"]>;

export const PLATFORM_LABEL: Record<Platform, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube" };

const HOSTS: [RegExp, Platform][] = [
  [/(^|\.)tiktok\.com$/, "tiktok"],
  [/(^|\.)instagram\.com$/, "instagram"],
  [/(^|\.)youtube\.com$/, "youtube"],
  [/^youtu\.be$/, "youtube"],
];

/** The link and its platform, or null when it is not an http(s) TikTok, Instagram or YouTube link. */
export function parseLink(raw: string): { url: string; platform: Platform } | null {
  const s = raw.trim();
  if (!s || s.length > MAX_URL) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  const hit = HOSTS.find(([re]) => re.test(host));
  return hit ? { url: u.href, platform: hit[1] } : null;
}

export type ImportItem = {
  /** Catalogue id, or null for a new custom exercise. */
  exercise_id: string | null;
  name: string;
  custom: boolean;
  muscle_groups: MuscleGroup[];
  equipment: Equipment;
  target_sets: number;
  target_reps: string;
};

export type ImportResult = { name: string; notes: string | null; exercises: ImportItem[] };

const ID_RE = /^[A-Za-z0-9_\-]{1,120}$/;
const REPS_RE = /^(\d{1,2}(-\d{1,2})?|\d{1,3}s)$/;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .,'’()/&+:#-]*$/u;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isMuscle = (v: unknown): v is MuscleGroup => typeof v === "string" && (MUSCLE_GROUPS as readonly string[]).includes(v);
const isEquipment = (v: unknown): v is Equipment => typeof v === "string" && (EQUIPMENT as readonly string[]).includes(v);

/** Plain single-line text: no control characters, no emojis, collapsed whitespace, capped. */
export function plainText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[︎️]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return s || null;
}

/** A custom exercise name the app will store, or null. */
export function safeExerciseName(v: unknown): string | null {
  const s = plainText(v, MAX_NAME);
  if (!s || !NAME_RE.test(s) || !/\p{L}/u.test(s)) return null;
  return s;
}

export const clampSets = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(MAX_SETS, Math.max(1, Math.round(v))) : DEFAULT_SETS;

export const clampReps = (v: unknown): string => {
  if (typeof v !== "string") return DEFAULT_REPS;
  const s = v.trim().replace(/\s+/g, "");
  return REPS_RE.test(s) ? s : DEFAULT_REPS;
};

/**
 * Checks the route's 200 body. Catalogue ids must be known to the app;
 * anything else must be a custom exercise with a safe name. Duplicates are
 * dropped and numbers clamped. Null when the body is not usable at all.
 */
export function parseImport(json: unknown, known: (id: string) => boolean): ImportResult | null {
  if (!isObj(json) || !Array.isArray(json.exercises)) return null;
  const exercises: ImportItem[] = [];
  for (const e of json.exercises) {
    if (exercises.length >= MAX_EXERCISES) break;
    if (!isObj(e)) continue;
    const target_sets = clampSets(e.target_sets);
    const target_reps = clampReps(e.target_reps);
    const muscle_groups = Array.isArray(e.muscle_groups) ? [...new Set(e.muscle_groups.filter(isMuscle))].slice(0, 3) : [];
    const equipment: Equipment = isEquipment(e.equipment) ? e.equipment : "Other";
    if (typeof e.exercise_id === "string") {
      if (!ID_RE.test(e.exercise_id) || !known(e.exercise_id)) continue;
      if (exercises.some((x) => x.exercise_id === e.exercise_id)) continue;
      exercises.push({
        exercise_id: e.exercise_id,
        name: plainText(e.name, MAX_NAME) ?? e.exercise_id,
        custom: false,
        muscle_groups,
        equipment,
        target_sets,
        target_reps,
      });
      continue;
    }
    if (e.exercise_id !== null) continue;
    const name = safeExerciseName(e.name);
    if (!name) continue;
    if (exercises.some((x) => x.custom && x.name.toLowerCase() === name.toLowerCase())) continue;
    exercises.push({ exercise_id: null, name, custom: true, muscle_groups, equipment, target_sets, target_reps });
  }
  return {
    name: plainText(json.name, MAX_NAME) ?? DEFAULT_NAME,
    notes: plainText(json.notes, MAX_NOTE),
    exercises,
  };
}

/** Request body in the route's shape. The link is never sent. */
export function buildRequestBody(platform: Platform, caption: string, notes: string) {
  return { platform, caption: caption.slice(0, MAX_CAPTION), notes: notes.slice(0, MAX_NOTES) };
}

/**
 * Saves the reviewed exercises as a mini workout (kind "mini", source
 * "social") with the link and platform on the routine. Custom exercises are
 * found by name or created, with the link as their video. Returns the new id.
 */
export async function saveMiniWorkout(input: {
  name: string;
  notes: string | null;
  url: string;
  platform: Platform;
  exercises: ImportItem[];
}): Promise<string> {
  const exercises: { exercise_id: string; target_sets: number; target_reps: string }[] = [];
  for (const e of input.exercises) {
    let id = e.exercise_id;
    if (id === null) {
      const c = await ensureCustomExercise(e.name, {
        muscle_groups: e.muscle_groups,
        equipment: e.equipment,
        video_url: input.url,
      });
      id = c.id;
    }
    if (exercises.some((x) => x.exercise_id === id)) continue;
    exercises.push({ exercise_id: id, target_sets: clampSets(e.target_sets), target_reps: clampReps(e.target_reps) });
  }
  const id = await createRoutine({
    name: plainText(input.name, MAX_NAME) ?? DEFAULT_NAME,
    exercises,
    source: "social",
    kind: "mini",
    notes: input.notes ?? undefined,
  });
  // createRoutine has no link fields: add them to the saved row and queue it again (upserts are idempotent).
  const row = await db.routines.get(id);
  if (row) {
    const next: RoutineRow = { ...row, source_url: input.url, platform: input.platform };
    await db.routines.put(next);
    await enqueue([{ table: "routines", op: "upsert", row: next }]);
  }
  return id;
}

type Review = { result: ImportResult; keep: boolean[]; url: string; platform: Platform; error?: string };

const reviewOf = (s: Review): Review => ({ result: s.result, keep: s.keep, url: s.url, platform: s.platform });

type State =
  | { kind: "closed" }
  | { kind: "form"; message?: string }
  | { kind: "loading" }
  | ({ kind: "review" } & Review)
  | ({ kind: "saving" } & Review)
  | { kind: "saved"; name: string };

const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/**
 * Opening state for a link handed in from outside (the /save?url= page used
 * by the iOS Shortcut). Undefined keeps the normal closed card. A valid link
 * is prefilled; no or an invalid link opens the empty paste box with a hint.
 * Nothing is fetched or saved until the user taps the existing buttons.
 */
export function initialFromUrl(initialUrl: string | undefined): { state: State; link: string } {
  if (initialUrl === undefined) return { state: { kind: "closed" }, link: "" };
  const parsed = parseLink(initialUrl);
  if (!parsed) return { state: { kind: "form", message: MSG_NO_SHARED_LINK }, link: "" };
  return { state: { kind: "form", message: MSG_SHARED }, link: parsed.url };
}

/** Save a workout from a TikTok, Instagram or YouTube post as a mini workout. */
export function SaveFromLink({ initialUrl }: { initialUrl?: string } = {}) {
  const { get } = useCatalogue();
  const [initial] = useState(() => initialFromUrl(initialUrl));
  const [state, setState] = useState<State>(initial.state);
  const [link, setLink] = useState(initial.link);
  const [caption, setCaption] = useState("");
  const [notes, setNotes] = useState("");

  const read = async () => {
    const parsed = parseLink(link);
    if (!parsed) {
      setState({ kind: "form", message: MSG_BAD_LINK });
      return;
    }
    if (!caption.trim() && !notes.trim()) {
      setState({ kind: "form", message: MSG_NO_TEXT });
      return;
    }
    if (offline()) {
      setState({ kind: "form", message: MSG_OFFLINE });
      return;
    }
    setState({ kind: "loading" });
    try {
      const res = await fetch(ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildRequestBody(parsed.platform, caption, notes)),
      });
      if (res.status === 503) {
        setState({ kind: "form", message: MSG_UNAVAILABLE });
        return;
      }
      if (!res.ok) {
        setState({ kind: "form", message: MSG_FAILED });
        return;
      }
      const body: unknown = await res.json();
      let builtIn: Set<string> = new Set();
      try {
        builtIn = new Set((await loadCatalogue()).list.map((e) => e.id));
      } catch {
        // Unreachable catalogue: only exercises already known to the app count.
      }
      const result = parseImport(body, (id) => builtIn.has(id) || !!get(id));
      if (!result) {
        setState({ kind: "form", message: MSG_FAILED });
        return;
      }
      if (result.exercises.length === 0) {
        setState({ kind: "form", message: MSG_EMPTY });
        return;
      }
      setState({ kind: "review", result, keep: result.exercises.map(() => true), ...parsed });
    } catch {
      setState({ kind: "form", message: offline() ? MSG_OFFLINE : MSG_FAILED });
    }
  };

  const patch = (fn: (r: Review) => Review) => setState((s) => (s.kind === "review" ? { ...fn(reviewOf(s)), kind: "review" } : s));
  const editItem = (i: number, change: Partial<ImportItem>) =>
    patch((r) => ({
      ...r,
      result: { ...r.result, exercises: r.result.exercises.map((e, j) => (j === i ? { ...e, ...change } : e)) },
    }));

  const save = async (r: Review) => {
    const chosen = r.result.exercises.filter((_, i) => r.keep[i]);
    if (chosen.length === 0) return;
    setState({ ...r, kind: "saving" });
    try {
      await saveMiniWorkout({ name: r.result.name, notes: r.result.notes, url: r.url, platform: r.platform, exercises: chosen });
      setState({ kind: "saved", name: plainText(r.result.name, MAX_NAME) ?? DEFAULT_NAME });
      setLink("");
      setCaption("");
      setNotes("");
    } catch {
      setState({ ...r, kind: "review", error: MSG_SAVE_FAILED });
    }
  };

  const reviewing = state.kind === "review" || state.kind === "saving";
  const kept = reviewing ? state.keep.filter(Boolean).length : 0;
  const showForm = state.kind === "form" || state.kind === "loading";

  return (
    <div className="card p-3 mt-3">
      <div className="flex items-start justify-between gap-2">
        <span>
          <span className="block text-sm font-semibold">Save from link</span>
          <span className="block text-xs text-muted">A TikTok, Instagram or YouTube workout as a mini workout.</span>
        </span>
        {(state.kind === "closed" || state.kind === "saved") && (
          <button type="button" className="chip text-xs shrink-0" onClick={() => setState({ kind: "form" })}>
            Paste link
          </button>
        )}
      </div>

      {state.kind === "saved" && (
        <p role="status" className="text-xs text-muted mt-2">
          Saved {state.name} as a mini workout.
        </p>
      )}

      {showForm && (
        <form
          className="mt-2 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void read();
          }}
        >
          <label className="block">
            <span className="block text-xs text-muted mb-1">Video link</span>
            <input
              type="url"
              inputMode="url"
              className="w-full rounded-xl border border-border px-3 py-2 text-sm bg-white"
              placeholder="https://www.tiktok.com/@creator/video/..."
              value={link}
              maxLength={MAX_URL}
              onChange={(e) => setLink(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="block text-xs text-muted mb-1">Caption</span>
            <textarea
              className="w-full rounded-xl border border-border px-3 py-2 text-sm bg-white"
              rows={4}
              placeholder="Paste the caption or type what is in the video"
              value={caption}
              maxLength={MAX_CAPTION}
              onChange={(e) => setCaption(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="block text-xs text-muted mb-1">Notes (optional)</span>
            <input
              type="text"
              className="w-full rounded-xl border border-border px-3 py-2 text-sm bg-white"
              value={notes}
              maxLength={MAX_NOTES}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          {state.kind === "form" && state.message && (
            <p role="status" className="text-xs text-muted">
              {state.message}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" className="btn-primary flex-1" disabled={state.kind === "loading"}>
              {state.kind === "loading" ? "Reading..." : "Read workout"}
            </button>
            <button type="button" className="btn-ghost flex-1" onClick={() => setState({ kind: "closed" })}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {reviewing && (
        <>
          <p className="text-xs text-muted mt-2">
            From {PLATFORM_LABEL[state.platform]}. Review and edit, untick anything to leave out, then save.
          </p>
          <label className="block mt-2">
            <span className="block text-xs text-muted mb-1">Workout name</span>
            <input
              type="text"
              className="w-full rounded-xl border border-border px-3 py-2 text-sm bg-white"
              value={state.result.name}
              maxLength={MAX_NAME}
              disabled={state.kind === "saving"}
              onChange={(e) => patch((r) => ({ ...r, result: { ...r.result, name: e.target.value } }))}
            />
          </label>
          {state.result.notes && <p className="text-xs text-muted mt-1">{state.result.notes}</p>}
          <ul className="mt-2 space-y-2" aria-label="Imported exercises">
            {state.result.exercises.map((e, i) => {
              const name = e.exercise_id ? (get(e.exercise_id)?.name ?? e.name) : e.name;
              return (
                <li key={`${e.exercise_id ?? "custom"}-${i}`} className="rounded-xl border border-border p-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={state.keep[i]}
                      disabled={state.kind === "saving"}
                      onChange={() => patch((r) => ({ ...r, keep: r.keep.map((k, j) => (j === i ? !k : k)) }))}
                      aria-label={`Keep ${name}`}
                    />
                    <span className="text-sm font-semibold flex-1 truncate">{name}</span>
                    {e.custom && <span className="text-xs text-muted shrink-0">New exercise</span>}
                  </label>
                  <div className="flex items-center gap-2 mt-1 text-xs">
                    <input
                      type="number"
                      min={1}
                      max={MAX_SETS}
                      className="w-14 rounded-lg border border-border px-2 py-1 bg-white tabular-nums"
                      value={e.target_sets}
                      disabled={state.kind === "saving"}
                      aria-label={`Sets for ${name}`}
                      onChange={(ev) => editItem(i, { target_sets: clampSets(Number(ev.target.value)) })}
                    />
                    <span className="text-muted">sets x</span>
                    <input
                      type="text"
                      className="w-20 rounded-lg border border-border px-2 py-1 bg-white tabular-nums"
                      value={e.target_reps}
                      maxLength={8}
                      disabled={state.kind === "saving"}
                      aria-label={`Reps for ${name}`}
                      onChange={(ev) => editItem(i, { target_reps: ev.target.value })}
                      onBlur={(ev) => editItem(i, { target_reps: clampReps(ev.target.value) })}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
          {state.kind === "review" && state.error && (
            <p role="status" className="text-xs text-muted mt-2">
              {state.error}
            </p>
          )}
          <div className="flex gap-2 mt-3">
            <button
              type="button"
              className="btn-primary flex-1"
              disabled={kept === 0 || state.kind === "saving"}
              onClick={() => save(reviewOf(state))}
            >
              {state.kind === "saving" ? "Saving..." : "Save mini workout"}
            </button>
            <button
              type="button"
              className="btn-ghost flex-1"
              disabled={state.kind === "saving"}
              onClick={() => setState({ kind: "form" })}
            >
              Discard
            </button>
          </div>
        </>
      )}
    </div>
  );
}
