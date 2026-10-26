"use client";

// "Save from link": paste a TikTok, Instagram or YouTube link plus the post's
// caption, ask POST /api/ai/social-import to read the exercises out of the
// caption, review and edit them, then save them (SOC-06) as a routine
// (createRoutine, kind "routine", source "social"; the default) or each move
// as a custom exercise with the link as its video. Exercises not in the
// catalogue become custom exercises with the link as their video. New saves
// are never mini workouts any more; saveMiniWorkout stays for existing code. The server
// never gets the link: it stays on the device and is stored on the routine.
// Any failure (no key, offline, bad answer) shows a short plain message; the
// manual routine flow is untouched.
//
// "Fetch details" (optional) sends ONLY the link to POST /api/social/import,
// which reads the platform's public oEmbed. The title prefills an empty
// caption, the creator an empty notes box, and the thumbnail and creator are
// stored on the saved mini workout. Manual, offline or any failure shows a
// short plain message and the paste-the-caption flow works as before.
//
// LINK-03: in Routine mode the review offers an optional Split day picker
// (None by default). A chosen day links the saved routine to that split day.
import { useEffect, useRef, useState } from "react";
import { EQUIPMENT, MUSCLE_GROUPS, type Equipment, type MuscleGroup } from "@/lib/muscles";
import { loadCatalogue, useCatalogue } from "@/lib/catalogue";
import { createRoutine } from "@/lib/routines";
import { useSplit, type Split } from "@/lib/splits";
import { ensureCustomExercise } from "@/lib/customExercises";
import { db, type RoutineRow } from "@/lib/offline/db";
import { enqueue } from "@/lib/offline/sync";
import { safeThumbnailUrl } from "@/components/routines/MiniWorkoutCard";

export const ROUTE = "/api/ai/social-import";
/** The oEmbed details route (SOC-01). Gets only { url }. */
export const DETAILS_ROUTE = "/api/social/import";
/** Same caps the route enforces. */
export const MAX_CAPTION = 4_000;
export const MAX_NOTES = 1_000;
export const MAX_URL = 2_048;
export const MAX_EXERCISES = 12;
export const MAX_SETS = 6;
export const MAX_NAME = 60;
/** Same caps as the details route. */
export const MAX_TITLE = 200;
export const MAX_CREATOR = 100;
export const MAX_THUMBNAIL_URL = 2_048;
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
export const MSG_DETAILS_OK = "Details added from the post. Check the caption, then tap Read workout.";
export const MSG_DETAILS_MANUAL = "No details for this link. Paste the caption or describe the workout.";
export const MSG_DETAILS_OFFLINE = "You are offline. Paste the caption or describe the workout.";
export const MSG_DETAILS_FAILED = "Could not fetch details. Paste the caption or describe the workout.";

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

/** Title, thumbnail and creator read from the details route for one link. */
export type LinkDetails = { url: string; title: string | null; thumbnail_url: string | null; creator: string | null };

/** A downloaded cover image (see the details route): a small jpeg, png or webp data URL. */
const COVER_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_COVER_DATA_URL = 300_000;

/** An https thumbnail URL within the cap, a downloaded cover data URL, or null. */
export function cleanThumbnailUrl(v: unknown): string | null {
  if (typeof v === "string" && v.length <= MAX_COVER_DATA_URL && COVER_DATA_URL.test(v)) return v;
  if (typeof v !== "string" || v.length > MAX_THUMBNAIL_URL) return null;
  const u = safeThumbnailUrl(v);
  return u && u.length <= MAX_THUMBNAIL_URL ? u : null;
}

/**
 * Checks the details route's 200 body for `link`. "manual" for
 * { manual: true }, a platform that does not match the link, or a body with
 * nothing usable; null for a body that is not an object. Text is cleaned and
 * capped, the thumbnail must be https.
 */
export function parseDetails(json: unknown, link: { url: string; platform: Platform }): LinkDetails | "manual" | null {
  if (!isObj(json)) return null;
  if (json.manual === true || json.platform !== link.platform) return "manual";
  const title = plainText(json.title, MAX_TITLE);
  const creator = plainText(json.creator, MAX_CREATOR);
  const thumbnail_url = cleanThumbnailUrl(json.thumbnail_url) ?? cleanThumbnailUrl(json.cover_data_url);
  if (!title && !creator && !thumbnail_url) return "manual";
  return { url: link.url, title, thumbnail_url, creator };
}

/** The details body: only the link. */
export function buildDetailsBody(url: string) {
  return { url };
}

/** The post's thumbnail for a pasted link, or null when offline, unsupported or the lookup fails. */
export async function fetchLinkThumbnail(raw: string): Promise<string | null> {
  const parsed = parseLink(raw);
  if (!parsed || (typeof navigator !== "undefined" && navigator.onLine === false)) return null;
  try {
    const res = await fetch(DETAILS_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildDetailsBody(parsed.url)),
    });
    if (!res.ok) return null;
    const d = parseDetails(await res.json(), parsed);
    return d && d !== "manual" ? d.thumbnail_url : null;
  } catch {
    return null;
  }
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
export async function saveMiniWorkout(input: SocialRoutineInput): Promise<string> {
  return saveSocialRoutine(input, "mini");
}

type SocialRoutineInput = {
  name: string;
  notes: string | null;
  url: string;
  platform: Platform;
  exercises: ImportItem[];
  /** From Fetch details; optional. */
  thumbnail_url?: string | null;
  creator?: string | null;
  /** LINK-03: the split day to link the routine to. Left out or empty: no link (the field is not written). */
  split_day_id?: string | null;
};

/**
 * SOC-06: saves the reviewed exercises as a normal routine (kind "routine",
 * source "social") with the link, platform, thumbnail and creator kept. Same
 * path as saveMiniWorkout. Returns the new id.
 */
export async function saveRoutineFromLink(input: SocialRoutineInput): Promise<string> {
  return saveSocialRoutine(input, "routine");
}

/** What Save from link stores: a routine (the default) or single exercises. */
export type SaveAs = "routine" | "exercise";
export const SAVE_AS_OPTIONS: readonly { value: SaveAs; label: string }[] = [
  { value: "routine", label: "Routine" },
  { value: "exercise", label: "Exercise" },
];
export const DEFAULT_SAVE_AS: SaveAs = "routine";

export const MSG_NO_MUSCLE = "Pick at least one muscle group for each new exercise.";
export const MSG_NOTHING_NEW = "These are already in your exercises.";
export const MSG_SAVE_EXERCISES_FAILED = "Could not save the exercises. Try again.";

/** Lowercased, trimmed name used to match exercises. */
export const nameKey = (s: string) => s.trim().toLowerCase();

/** "Save 1 exercise", "Save 2 exercises". */
export const saveExercisesLabel = (n: number) => `Save ${n} ${n === 1 ? "exercise" : "exercises"}`;

export class NoMuscleError extends Error {
  constructor() {
    super(MSG_NO_MUSCLE);
  }
}

/**
 * SOC-06: saves each reviewed exercise as a custom exercise with the link as
 * its video (so it shows Watch original). No routine is created. Catalogue
 * exercises (an id, or a name in `knownNames`) and custom exercises already
 * saved under the same name are reported in `existing` and not duplicated.
 * Every new one needs at least one muscle group, otherwise nothing is written
 * and NoMuscleError is thrown.
 */
export async function saveExercisesFromLink(input: {
  url: string;
  exercises: ImportItem[];
  /** Names of exercises the app already has (built-in catalogue). */
  knownNames?: Iterable<string>;
  /** The post's thumbnail, used as each new exercise's picture. */
  thumbnail_url?: string | null;
}): Promise<{ saved: string[]; existing: string[] }> {
  const known = new Set([...(input.knownNames ?? [])].map(nameKey));
  for (const c of await db.custom_exercises.toArray()) known.add(nameKey(c.name));
  const existing: string[] = [];
  const todo: { name: string; item: ImportItem; muscles: MuscleGroup[] }[] = [];
  for (const e of input.exercises) {
    const name = e.exercise_id === null ? safeExerciseName(e.name) : plainText(e.name, MAX_NAME);
    if (!name) continue;
    const key = nameKey(name);
    if (e.exercise_id !== null || known.has(key)) {
      if (!existing.some((x) => nameKey(x) === key)) existing.push(name);
      continue;
    }
    if (todo.some((t) => nameKey(t.name) === key)) continue;
    todo.push({ name, item: e, muscles: [...new Set(e.muscle_groups.filter(isMuscle))] });
  }
  if (todo.some((t) => t.muscles.length === 0)) throw new NoMuscleError();
  const saved: string[] = [];
  for (const t of todo) {
    await ensureCustomExercise(t.name, {
      muscle_groups: t.muscles,
      equipment: isEquipment(t.item.equipment) ? t.item.equipment : "Other",
      video_url: input.url,
      thumbnail_url: cleanThumbnailUrl(input.thumbnail_url),
    });
    saved.push(t.name);
  }
  return { saved, existing };
}

async function saveSocialRoutine(input: SocialRoutineInput, kind: "mini" | "routine"): Promise<string> {
  const exercises: { exercise_id: string; target_sets: number; target_reps: string }[] = [];
  for (const e of input.exercises) {
    let id = e.exercise_id;
    if (id === null) {
      const c = await ensureCustomExercise(e.name, {
        muscle_groups: e.muscle_groups,
        equipment: e.equipment,
        video_url: input.url,
        thumbnail_url: cleanThumbnailUrl(input.thumbnail_url),
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
    kind,
    notes: input.notes ?? undefined,
    ...(input.split_day_id ? { split_day_id: input.split_day_id } : {}),
  });
  // createRoutine has no link fields: add them to the saved row and queue it again (upserts are idempotent).
  // Read, write and queue in one transaction (with db.outbox), so a pull cannot land in between.
  await db.transaction("rw", db.routines, db.outbox, async () => {
    const row = await db.routines.get(id);
    if (!row) return;
    const next: RoutineRow = {
      ...row,
      source_url: input.url,
      platform: input.platform,
      thumbnail_url: cleanThumbnailUrl(input.thumbnail_url) ?? row.thumbnail_url ?? null,
      creator: plainText(input.creator, MAX_CREATOR) ?? row.creator ?? null,
    };
    await db.routines.put(next);
    await enqueue([{ table: "routines", op: "upsert", row: next }]);
  });
  return id;
}

type Review = {
  result: ImportResult;
  keep: boolean[];
  url: string;
  platform: Platform;
  saveAs: SaveAs;
  /** LINK-03: the split day picked for the routine ("" = None). */
  splitDayId: string;
  error?: string;
};

const reviewOf = (s: Review): Review => ({
  result: s.result,
  keep: s.keep,
  url: s.url,
  platform: s.platform,
  saveAs: s.saveAs,
  splitDayId: s.splitDayId,
});

/** LINK-03: split days a routine can be linked to (days with an id), in split order. */
export function linkableDays(split: Pick<Split, "days">): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const [i, d] of split.days.entries()) {
    if (typeof d.id !== "string" || !d.id || out.some((x) => x.id === d.id)) continue;
    out.push({ id: d.id, name: d.name.trim() || `Day ${i + 1}` });
  }
  return out;
}

type State =
  | { kind: "closed" }
  | { kind: "form"; message?: string }
  | { kind: "loading" }
  | ({ kind: "review" } & Review)
  | ({ kind: "saving" } & Review)
  | { kind: "saved"; message: string };

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

/** Save a workout from a TikTok, Instagram or YouTube post as a routine, or its moves as exercises. */
export function SaveFromLink({ initialUrl }: { initialUrl?: string } = {}) {
  const { get, exercises: allExercises } = useCatalogue();
  const splitDays = linkableDays(useSplit());
  const [initial] = useState(() => initialFromUrl(initialUrl));
  const [state, setState] = useState<State>(initial.state);
  const [link, setLink] = useState(initial.link);
  const [caption, setCaption] = useState("");
  const [notes, setNotes] = useState("");
  const [details, setDetails] = useState<LinkDetails | null>(null);
  const [fetching, setFetching] = useState(false);
  const linkRef = useRef(link);
  useEffect(() => {
    linkRef.current = link;
  }, [link]);

  const fetchDetails = async () => {
    const parsed = parseLink(link);
    if (!parsed) {
      setState({ kind: "form", message: MSG_BAD_LINK });
      return;
    }
    if (offline()) {
      setState({ kind: "form", message: MSG_DETAILS_OFFLINE });
      return;
    }
    setFetching(true);
    let message = MSG_DETAILS_FAILED;
    let found: LinkDetails | null = null;
    try {
      const res = await fetch(DETAILS_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildDetailsBody(parsed.url)),
      });
      if (res.ok) {
        const d = parseDetails(await res.json(), parsed);
        if (d === "manual") message = MSG_DETAILS_MANUAL;
        else if (d) {
          found = d;
          message = MSG_DETAILS_OK;
        }
      }
    } catch {
      message = offline() ? MSG_DETAILS_OFFLINE : MSG_DETAILS_FAILED;
    }
    setFetching(false);
    // The link changed while fetching: these details belong to another post.
    if (parseLink(linkRef.current)?.url !== parsed.url) return;
    if (found) {
      const d = found;
      setDetails(d);
      const title = d.title;
      const creator = d.creator;
      if (title) setCaption((c) => (c.trim() ? c : title.slice(0, MAX_CAPTION)));
      if (creator) setNotes((n) => (n.trim() ? n : `By ${creator}`.slice(0, MAX_NOTES)));
    }
    setState((s) => (s.kind === "form" ? { kind: "form", message } : s));
  };

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
      setState({ kind: "review", result, keep: result.exercises.map(() => true), ...parsed, saveAs: DEFAULT_SAVE_AS, splitDayId: "" });
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

  const knownNames = new Set(allExercises.map((e) => nameKey(e.name)));
  /** Display name of a reviewed exercise (catalogue name when it has an id). */
  const displayName = (e: ImportItem) => (e.exercise_id ? (get(e.exercise_id)?.name ?? e.name) : e.name);
  /** Already in the app: a catalogue id, or a name the app already has. */
  const isExisting = (e: ImportItem) => e.exercise_id !== null || knownNames.has(nameKey(e.name));

  const resetForm = () => {
    setLink("");
    setCaption("");
    setNotes("");
    setDetails(null);
  };

  const saveExercises = async (r: Review) => {
    const chosen = r.result.exercises.filter((_, i) => r.keep[i]).map((e) => ({ ...e, name: displayName(e) }));
    if (chosen.length === 0) return;
    if (chosen.some((e) => !isExisting(e) && e.muscle_groups.length === 0)) {
      setState({ ...r, kind: "review", error: MSG_NO_MUSCLE });
      return;
    }
    setState({ ...r, kind: "saving" });
    try {
      const { saved, existing } = await saveExercisesFromLink({
        url: r.url,
        exercises: chosen,
        knownNames: allExercises.map((e) => e.name),
        thumbnail_url: details && details.url === r.url ? details.thumbnail_url : await fetchLinkThumbnail(r.url),
      });
      if (saved.length === 0) {
        setState({ ...r, kind: "review", error: MSG_NOTHING_NEW });
        return;
      }
      const parts = [`Saved ${saved.length === 1 ? "1 exercise" : `${saved.length} exercises`}: ${saved.join(", ")}.`];
      if (existing.length) parts.push(`Already in your exercises: ${existing.join(", ")}.`);
      setState({ kind: "saved", message: parts.join(" ") });
      resetForm();
    } catch (err) {
      setState({ ...r, kind: "review", error: err instanceof NoMuscleError ? MSG_NO_MUSCLE : MSG_SAVE_EXERCISES_FAILED });
    }
  };

  const save = async (r: Review) => {
    if (r.saveAs === "exercise") return saveExercises(r);
    const chosen = r.result.exercises.filter((_, i) => r.keep[i]);
    if (chosen.length === 0) return;
    setState({ ...r, kind: "saving" });
    try {
      const d = details && details.url === r.url ? details : null;
      // Only a day still in the split is linked (it may have been removed meanwhile).
      const dayId = splitDays.some((x) => x.id === r.splitDayId) ? r.splitDayId : "";
      await saveRoutineFromLink({
        name: r.result.name,
        notes: r.result.notes,
        url: r.url,
        platform: r.platform,
        exercises: chosen,
        thumbnail_url: d ? d.thumbnail_url : await fetchLinkThumbnail(r.url),
        creator: d?.creator ?? null,
        ...(dayId ? { split_day_id: dayId } : {}),
      });
      setState({ kind: "saved", message: `Saved ${plainText(r.result.name, MAX_NAME) ?? DEFAULT_NAME} as a routine.` });
      resetForm();
    } catch {
      setState({ ...r, kind: "review", error: MSG_SAVE_FAILED });
    }
  };

  const reviewing = state.kind === "review" || state.kind === "saving";
  const kept = reviewing ? state.keep.filter(Boolean).length : 0;
  const asExercise = reviewing && state.saveAs === "exercise";
  const newCount = reviewing ? state.result.exercises.filter((e, i) => state.keep[i] && !isExisting(e)).length : 0;
  const showForm = state.kind === "form" || state.kind === "loading";

  return (
    <div className="card p-3 mt-3">
      <div className="flex items-start justify-between gap-2">
        <span>
          <span className="block text-sm font-semibold">Save from link</span>
          <span className="block text-xs text-muted">Save a workout from a TikTok, Instagram or YouTube link as a routine, or a single move as an exercise.</span>
        </span>
        {(state.kind === "closed" || state.kind === "saved") && (
          <button type="button" className="chip text-xs shrink-0" onClick={() => setState({ kind: "form" })}>
            Paste link
          </button>
        )}
      </div>

      {state.kind === "saved" && (
        <p role="status" className="text-xs text-muted mt-2">
          {state.message}
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
          <button
            type="button"
            className="chip text-xs"
            disabled={fetching || state.kind === "loading"}
            onClick={() => void fetchDetails()}
          >
            {fetching ? "Fetching..." : "Fetch details"}
          </button>
          {details && details.url === parseLink(link)?.url && (details.title || details.creator) && (
            <p className="text-xs text-muted">{[details.title, details.creator].filter(Boolean).join(" · ")}</p>
          )}
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
          <fieldset className="mt-2">
            <legend className="block text-xs text-muted mb-1">Save as</legend>
            <div className="flex gap-2">
              {SAVE_AS_OPTIONS.map((o) => (
                <label key={o.value} className={`${state.saveAs === o.value ? "chip-on" : "chip"} text-xs cursor-pointer`}>
                  <input
                    type="radio"
                    name="save-as"
                    className="sr-only"
                    value={o.value}
                    checked={state.saveAs === o.value}
                    disabled={state.kind === "saving"}
                    onChange={() => patch((r) => ({ ...r, saveAs: o.value }))}
                  />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>
          {!asExercise && splitDays.length > 0 && (
            <label className="block mt-2">
              <span className="block text-xs text-muted mb-1">Split day</span>
              <select
                className="field py-1.5 text-sm"
                value={splitDays.some((x) => x.id === state.splitDayId) ? state.splitDayId : ""}
                disabled={state.kind === "saving"}
                onChange={(e) => {
                  const v = e.target.value;
                  patch((r) => ({ ...r, splitDayId: v }));
                }}
              >
                <option value="">None</option>
                {splitDays.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ul className="mt-2 space-y-2" aria-label="Imported exercises">
            {state.result.exercises.map((e, i) => {
              const name = displayName(e);
              const existing = isExisting(e);
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
                    {asExercise && existing ? (
                      <span className="text-xs text-muted shrink-0">Already in your exercises</span>
                    ) : (
                      e.custom && <span className="text-xs text-muted shrink-0">New exercise</span>
                    )}
                  </label>
                  {asExercise && !existing && (
                    <div className="flex flex-wrap gap-1 mt-1" role="group" aria-label={`Muscle groups for ${name}`}>
                      {MUSCLE_GROUPS.map((m) => {
                        const on = e.muscle_groups.includes(m);
                        return (
                          <button
                            key={m}
                            type="button"
                            className={`${on ? "chip-on" : "chip"} text-xs`}
                            aria-pressed={on}
                            disabled={state.kind === "saving"}
                            onClick={() =>
                              editItem(i, { muscle_groups: on ? e.muscle_groups.filter((x) => x !== m) : [...e.muscle_groups, m] })
                            }
                          >
                            {m}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {!asExercise && (
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
                  )}
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
              disabled={kept === 0 || (asExercise && newCount === 0) || state.kind === "saving"}
              onClick={() => void save(reviewOf(state))}
            >
              {state.kind === "saving" ? "Saving..." : asExercise ? saveExercisesLabel(newCount) : "Save routine"}
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
