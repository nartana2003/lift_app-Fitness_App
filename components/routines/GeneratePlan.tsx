"use client";

// "Generate 3-day plan": asks POST /api/ai/generate-routines for three routines
// built from the user's split, equipment and recent history, shows them for
// review, and saves only the days the user keeps (createRoutine, source "ai").
// Any failure (no key, offline, bad answer) shows a short plain message; the
// existing manual routine flow is untouched.
//
// GEN-03 adds, collapsed by default and all optional: a Favourites picker (the
// saved favourites, editable for this plan only), a Tell the coach box (free
// text, max 400 chars), Ask for changes after a plan is shown, and Build a
// split from this (POST /api/ai/suggest-split, rule-based buildSplit() when the
// route is unavailable). The label follows the split's training days (2 to 6).
// With none of the extras used the card sends and shows exactly what it did.
//
// LINK-03: each saved routine is linked to the split day its plan day was built
// from (planDayLinks), so it shows under that day. Merged or repeated plan days
// link to the first matching split day. Days without an id are not linked.
import { useMemo, useState } from "react";
import { MUSCLE_GROUPS, EQUIPMENT, type Equipment, type MuscleGroup } from "@/lib/muscles";
import { saveSplit, useSplit, type Split, type SplitDay } from "@/lib/splits";
import { equipmentForAi, useEquipment } from "@/lib/equipment";
import { loadCatalogue, useCatalogue } from "@/lib/catalogue";
import { useFavorites } from "@/lib/favorites";
import { isCustomId } from "@/lib/customExercises";
import { buildSplit } from "@/lib/splitBuilder";
import type { Exercise } from "@/lib/exercises";
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

/** GEN-03: the split route, the limits it and generate-routines enforce. */
export const SPLIT_ROUTE = "/api/ai/suggest-split";
export const MAX_FAVORITES = 30;
export const MAX_REQUEST = 400;
export const MIN_PLAN_DAYS = 2;
export const MAX_PLAN_DAYS = 6;
/** Plan days when there is no split (and the default the route assumes). */
export const DEFAULT_PLAN_DAYS = 3;
const MAX_SEARCH_RESULTS = 8;

export const MSG_BUILD_FIRST = "You have no split yet. Build one from your picks first, then generate a plan.";
export const MSG_SPLIT_UNAVAILABLE = "AI is not available right now. This split was built without AI from your picks.";
export const MSG_SPLIT_OFFLINE = "You are offline. This split was built without AI from your picks.";
export const MSG_SPLIT_FAILED = "Could not build a split with AI. This one was built without AI from your picks.";
export const MSG_SPLIT_NONE = "Could not build a split. You can still set one up in Profile.";
export const MSG_SPLIT_SAVED = "Split saved.";
export const COACH_PLACEHOLDER = "e.g. I want more arms and shoulders, 4 days a week";

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

/** Optional GEN-03 extras for the generate-routines body. */
export type PlanExtras = { plan_days?: number; favorites?: readonly string[]; request?: string | null };

/**
 * Request body in the route's shape. Names are made safe, unknown values dropped.
 * Extras are only added when used: plan_days when it is not the default 3,
 * favourites when there are any (catalogue ids only, deduplicated, capped),
 * request when it has text (trimmed, capped at MAX_REQUEST). With no extras
 * the body is exactly the original three fields.
 */
export function buildRequestBody(split: Split, equipment: readonly Equipment[], history: HistoryEntry[], extras: PlanExtras = {}) {
  const days = split.days.slice(0, MAX_SPLIT_DAYS).map((d, i) => ({
    name: safeName(d.name, `Day ${i + 1}`),
    muscles: [...new Set(d.muscles.filter(isMuscle))],
  }));
  const body: {
    split: { name: string; days: { name: string; muscles: MuscleGroup[] }[] };
    equipment: Equipment[];
    history: HistoryEntry[];
    plan_days?: number;
    favorites?: string[];
    request?: string;
  } = {
    split: { name: safeName(split.name, ""), days },
    equipment: equipmentForAi(equipment.filter(isEquipment)),
    history: history.slice(0, MAX_HISTORY),
  };
  const n = extras.plan_days;
  if (typeof n === "number" && Number.isInteger(n) && n !== DEFAULT_PLAN_DAYS) {
    body.plan_days = Math.min(MAX_PLAN_DAYS, Math.max(MIN_PLAN_DAYS, n));
  }
  const favorites = sendableFavorites(extras.favorites ?? []);
  if (favorites.length) body.favorites = favorites;
  const request = cleanRequest(extras.request);
  if (request) body.request = request;
  return body;
}

/** Training days in the split (days with at least one known muscle). */
export function trainingDayCount(split: Split): number {
  return split.days.filter((d) => d.muscles.some(isMuscle)).length;
}

/**
 * Plan length for the split: its training days clamped to 2..6, or the
 * default 3 when there is no split.
 */
export function planDaysFor(split: Split): number {
  const n = trainingDayCount(split);
  return n === 0 ? DEFAULT_PLAN_DAYS : Math.min(MAX_PLAN_DAYS, Math.max(MIN_PLAN_DAYS, n));
}

/**
 * Favourites the routes accept: catalogue ids only (custom exercises are
 * never sent), deduplicated, in order, at most MAX_FAVORITES.
 */
export function sendableFavorites(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (out.length >= MAX_FAVORITES) break;
    if (typeof id !== "string" || !ID_RE.test(id) || isCustomId(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** Typed request: trimmed and capped at MAX_REQUEST characters; empty becomes null. */
export function cleanRequest(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, MAX_REQUEST).trim();
  return s || null;
}

/**
 * Refine: the earlier request plus the new text, at most MAX_REQUEST
 * characters. The new text is always kept whole (it is capped on its own);
 * when the two do not fit, the start of the earlier request is dropped.
 */
export function combineRequest(earlier: string | null, next: string): string | null {
  const add = cleanRequest(next);
  const prev = cleanRequest(earlier);
  if (!add) return prev;
  if (!prev) return add;
  const joined = (head: string) => (/[.!?]$/.test(head) ? `${head} ${add}` : `${head}. ${add}`);
  const full = joined(prev);
  if (full.length <= MAX_REQUEST) return full;
  const room = MAX_REQUEST - add.length - 2;
  if (room <= 0) return add;
  const head = prev.slice(prev.length - room).trim();
  return head ? joined(head).slice(-MAX_REQUEST) : add;
}

/** Body for /api/ai/suggest-split. Only fields that are used are sent. */
export function buildSplitRequestBody(favorites: readonly string[], request: string | null, equipment: readonly Equipment[]) {
  const body: { favorites?: string[]; request?: string; equipment: Equipment[] } = {
    equipment: equipmentForAi(equipment.filter(isEquipment)),
  };
  const favs = sendableFavorites(favorites);
  if (favs.length) body.favorites = favs;
  const req = cleanRequest(request);
  if (req) body.request = req;
  return body;
}

export type ProposedSplit = { split: Split; notes: string | null; source: "ai" | "rules" };

/**
 * Checks the suggest-split 200 body: 2 to 6 days, each with a name and
 * muscles from MUSCLE_GROUPS (unknown muscles dropped, empty days dropped).
 * Returns null when nothing usable came back.
 */
export function parseSplit(json: unknown): ProposedSplit | null {
  if (!isObj(json) || !isObj(json.split) || !Array.isArray(json.split.days)) return null;
  const days: SplitDay[] = [];
  for (const [i, raw] of json.split.days.entries()) {
    if (days.length >= MAX_PLAN_DAYS) break;
    if (!isObj(raw) || !Array.isArray(raw.muscles)) continue;
    const muscles = [...new Set(raw.muscles.filter(isMuscle))];
    if (muscles.length === 0) continue;
    days.push({ name: cleanText(raw.name, MAX_NAME) ?? `Day ${i + 1}`, muscles });
  }
  if (days.length < MIN_PLAN_DAYS) return null;
  return {
    split: { name: cleanText(json.split.name, MAX_NAME) ?? "My split", days },
    notes: cleanText(json.notes, MAX_NOTE),
    source: json.source === "ai" ? "ai" : "rules",
  };
}

/** The rule-based split, built in the browser (no key, offline). Null if it cannot be built. */
export function localSplit(
  favorites: readonly string[],
  request: string | null,
  equipment: readonly Equipment[],
  byId: ReadonlyMap<string, Exercise>,
): ProposedSplit | null {
  try {
    const r = buildSplit(
      {
        favorites: sendableFavorites(favorites).filter((id) => byId.has(id)),
        request: cleanRequest(request),
        days_per_week: null,
        equipment: equipmentForAi(equipment.filter(isEquipment)),
      },
      byId,
    );
    return parseSplit({ split: r.split, notes: r.notes, source: "rules" });
  } catch {
    return null;
  }
}

/** Case-insensitive name search over exercises; every word must match. */
export function searchExercises<T extends { id: string; name: string }>(list: readonly T[], query: string, exclude: readonly string[], max = MAX_SEARCH_RESULTS): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const out: T[] = [];
  for (const e of list) {
    if (out.length >= max) break;
    if (exclude.includes(e.id)) continue;
    const name = e.name.toLowerCase();
    if (words.every((w) => name.includes(w))) out.push(e);
  }
  return out;
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
 * Checks the route's 200 body and returns up to `maxDays` days (default 3), or null when nothing
 * usable came back. Exercises must be known to `known` (the catalogue the app
 * shows); numbers are clamped and duplicates dropped. Days left empty are removed.
 */
export function parsePlan(json: unknown, known: (id: string) => boolean, maxDays: number = MAX_DAYS): PlanDay[] | null {
  return parsePlanIndexed(json, known, maxDays)?.days ?? null;
}

/**
 * LINK-03: parsePlan, plus for each kept day its index in the route's answer
 * (days dropped as empty shift the list, the index does not).
 */
export function parsePlanIndexed(
  json: unknown,
  known: (id: string) => boolean,
  maxDays: number = MAX_DAYS,
): { days: PlanDay[]; indices: number[] } | null {
  if (!isObj(json) || !isObj(json.plan) || !Array.isArray(json.plan.days)) return null;
  const limit = Number.isInteger(maxDays) ? Math.min(MAX_PLAN_DAYS, Math.max(1, maxDays)) : MAX_DAYS;
  const out: PlanDay[] = [];
  const indices: number[] = [];
  for (const [i, raw] of json.plan.days.slice(0, limit).entries()) {
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
    indices.push(i);
  }
  return out.length ? { days: out, indices } : null;
}

/**
 * LINK-03: the split day id each plan day was built from. The route turns the
 * split's training days (the first MAX_SPLIT_DAYS days with a known muscle)
 * into `count` plan days: fewer days repeat (plan day i is training day
 * i mod n), more days are merged round-robin (plan day i holds training days
 * i, i + count, ...). Either way the first matching day is training day
 * i mod n. Null for a day with no id or no training day.
 */
export function planDayLinks(split: Split, indices: readonly number[]): (string | null)[] {
  const src = split.days.slice(0, MAX_SPLIT_DAYS).filter((d) => d.muscles.some(isMuscle));
  return indices.map((i) => {
    if (src.length === 0 || !Number.isInteger(i) || i < 0) return null;
    const id = src[i % src.length].id;
    return typeof id === "string" && id ? id : null;
  });
}

/**
 * Saves the chosen days as routines (source "ai"), in plan order. Returns the new ids.
 * LINK-03: `links[i]` (optional) is the split day id for `days[i]`; null or
 * missing saves the routine with no link (the field is not written).
 */
export async function savePlanDays(days: PlanDay[], links: readonly (string | null | undefined)[] = []): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, d] of days.entries()) {
    const link = links[i];
    ids.push(
      await createRoutine({
        name: d.name,
        exercises: d.exercises.map((e) => ({ ...e })),
        source: "ai",
        kind: "routine",
        notes: d.notes ?? undefined,
        ...(link ? { split_day_id: link } : {}),
      }),
    );
  }
  return ids;
}

/** History for the request: finished workouts over the last HISTORY_DAYS days. */
export async function loadHistory(now = new Date()): Promise<HistoryEntry[]> {
  return buildHistory(await workoutsBetween(addDays(now, -HISTORY_DAYS), addDays(now, 1)));
}

type PlanReview = {
  days: PlanDay[];
  keep: boolean[];
  request: string | null;
  note: string | null;
  refining: boolean;
  /** LINK-03: split day id per plan day (null: not linked). */
  links: (string | null)[];
};

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "needSplit" }
  | ({ kind: "review" } & PlanReview)
  | ({ kind: "saving" } & PlanReview)
  | { kind: "saved"; count: number };

type SplitState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "review"; proposal: ProposedSplit; message: string | null; confirming: boolean; saving: boolean }
  | { kind: "saved" }
  | { kind: "error"; message: string };

type PlanResult = { ok: true; days: PlanDay[]; links: (string | null)[] } | { ok: false; message: string };

const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/** Generate an N-day plan, review it, keep the days you want, save them as routines. */
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
  const { get, exercises } = useCatalogue();
  const savedFavs = useFavorites();
  const [state, setState] = useState<State>({ kind: "idle" });
  const [splitState, setSplitState] = useState<SplitState>({ kind: "idle" });

  // Favourites for this plan only: the saved ones until the user edits the list.
  // They are sent only once the user has opened the picker ("used" it).
  const [favOpen, setFavOpen] = useState(false);
  const [favUsed, setFavUsed] = useState(false);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const [coachOpen, setCoachOpen] = useState(false);
  const [request, setRequest] = useState("");
  const [change, setChange] = useState("");

  const shownFavs = picked ?? sendableFavorites(savedFavs);
  const sentFavs = favUsed ? shownFavs : [];
  const typed = cleanRequest(request);
  const canBuild = sentFavs.length > 0 || typed !== null;
  const hasCustomFav = savedFavs.some(isCustomId);
  const planDays = planDaysFor(split);
  const builtIn = useMemo(() => exercises.filter((e) => !isCustomId(e.id)), [exercises]);
  const results = favOpen ? searchExercises(builtIn, query, shownFavs) : [];

  const editFavs = (fn: (cur: string[]) => string[]) => setPicked(sendableFavorites(fn(shownFavs)));

  const fetchPlan = async (req: string | null): Promise<PlanResult> => {
    if (offline()) return { ok: false, message: MSG_OFFLINE };
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
        body: JSON.stringify(
          buildRequestBody(split, equipment, history, { plan_days: planDays, favorites: sentFavs, request: req }),
        ),
      });
      if (res.status === 503) return { ok: false, message: MSG_UNAVAILABLE };
      if (!res.ok) return { ok: false, message: MSG_FAILED };
      const body: unknown = await res.json();
      // Make sure the built-in catalogue is loaded so ids can be checked and named.
      let ids: Set<string> = new Set();
      try {
        ids = new Set((await loadCatalogue()).list.map((e) => e.id));
      } catch {
        // Unreachable catalogue: only exercises already known to the app count.
      }
      const parsed = parsePlanIndexed(body, (id) => ids.has(id) || !!get(id), planDays);
      return parsed
        ? { ok: true, days: parsed.days, links: planDayLinks(split, parsed.indices) }
        : { ok: false, message: MSG_FAILED };
    } catch {
      return { ok: false, message: offline() ? MSG_OFFLINE : MSG_FAILED };
    }
  };

  const generate = async () => {
    if (!hasTrainingDay(split)) {
      // With picks or a typed request there is a way forward: build a split first.
      setState(canBuild ? { kind: "needSplit" } : { kind: "error", message: MSG_NO_SPLIT });
      return;
    }
    if (offline()) {
      setState({ kind: "error", message: MSG_OFFLINE });
      return;
    }
    setState({ kind: "loading" });
    const r = await fetchPlan(typed);
    setState(
      r.ok
        ? { kind: "review", days: r.days, keep: r.days.map(() => true), request: typed, note: null, refining: false, links: r.links }
        : { kind: "error", message: r.message },
    );
  };

  const refine = async () => {
    if (state.kind !== "review" || state.refining) return;
    const add = cleanRequest(change);
    if (!add) return;
    const combined = combineRequest(state.request, add);
    setState({ ...state, refining: true, note: null });
    const r = await fetchPlan(combined);
    if (r.ok) {
      setChange("");
      setState({ kind: "review", days: r.days, keep: r.days.map(() => true), request: combined, note: null, refining: false, links: r.links });
    } else {
      // The plan on screen stays as it was; nothing is saved.
      setState((s) => (s.kind === "review" ? { ...s, refining: false, note: r.message } : s));
    }
  };

  const buildSplitFromPicks = async () => {
    setSplitState({ kind: "loading" });
    const favs = sentFavs;
    let byId: ReadonlyMap<string, Exercise> = new Map();
    try {
      byId = (await loadCatalogue()).byId;
    } catch {
      // No catalogue: the rule-based split still works from the typed request.
    }
    const fallback = (message: string) => {
      const proposal = localSplit(favs, typed, equipment, byId);
      setSplitState(
        proposal
          ? { kind: "review", proposal, message, confirming: false, saving: false }
          : { kind: "error", message: MSG_SPLIT_NONE },
      );
    };
    if (offline()) return fallback(MSG_SPLIT_OFFLINE);
    try {
      const sendFavs = byId.size > 0 ? favs.filter((id) => byId.has(id)) : favs;
      const res = await fetch(SPLIT_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildSplitRequestBody(sendFavs, typed, equipment)),
      });
      if (res.status === 503) return fallback(MSG_SPLIT_UNAVAILABLE);
      if (!res.ok) return fallback(MSG_SPLIT_FAILED);
      const proposal = parseSplit(await res.json());
      if (!proposal) return fallback(MSG_SPLIT_FAILED);
      setSplitState({ kind: "review", proposal, message: null, confirming: false, saving: false });
    } catch {
      fallback(offline() ? MSG_SPLIT_OFFLINE : MSG_SPLIT_FAILED);
    }
  };

  const applyProposal = async (confirmed: boolean) => {
    if (splitState.kind !== "review" || splitState.saving) return;
    // An existing split is only replaced after an explicit confirm.
    if (!confirmed && (hasTrainingDay(savedSplit) || hasTrainingDay(split))) {
      setSplitState({ ...splitState, confirming: true });
      return;
    }
    setSplitState({ ...splitState, saving: true });
    try {
      await saveSplit(splitState.proposal.split);
      setSplitState({ kind: "saved" });
      setState((s) => (s.kind === "needSplit" || s.kind === "error" ? { kind: "idle" } : s));
    } catch {
      setSplitState({ kind: "error", message: "Could not save the split. Try again." });
    }
  };

  const toggle = (i: number) =>
    setState((s) => (s.kind === "review" ? { ...s, keep: s.keep.map((k, j) => (j === i ? !k : k)) } : s));

  const save = async (s: PlanReview) => {
    const chosen = s.days.filter((_, i) => s.keep[i]);
    if (chosen.length === 0) return;
    // Only days still in the saved split are linked (it may have changed meanwhile).
    const live = new Set(split.days.map((d) => d.id).filter((id): id is string => !!id));
    const links = s.links.filter((_, i) => s.keep[i]).map((id) => (id && live.has(id) ? id : null));
    setState({ ...s, kind: "saving", refining: false });
    try {
      await savePlanDays(chosen, links);
      setState({ kind: "saved", count: chosen.length });
    } catch {
      setState({ kind: "error", message: "Could not save the routines. Try again." });
    }
  };

  const reviewing = state.kind === "review" || state.kind === "saving";
  const kept = reviewing ? state.keep.filter(Boolean).length : 0;
  const busy = reviewing && (state.kind === "saving" || state.refining);
  const splitBusy = splitState.kind === "loading" || splitState.kind === "review";
  /** LINK-03: name of the split day a plan day links to, or null. */
  const dayName = (id: string | null | undefined): string | null => {
    if (!id) return null;
    const i = split.days.findIndex((d) => d.id === id);
    return i < 0 ? null : split.days[i].name.trim() || `Day ${i + 1}`;
  };

  return (
    <div className="card p-3 mt-3">
      <div className="flex items-start justify-between gap-2">
        <span>
          <span className="block text-sm font-semibold">Generate {planDays}-day plan</span>
          <span className="block text-xs text-muted">From your split, equipment and recent training.</span>
        </span>
        {!reviewing && (
          <button type="button" className="chip text-xs shrink-0" onClick={generate} disabled={state.kind === "loading"}>
            {state.kind === "loading" ? "Working..." : "Generate"}
          </button>
        )}
      </div>

      {!reviewing && (
        <div className="flex flex-wrap gap-2 mt-2">
          <button
            type="button"
            className={favOpen ? "chip-on text-xs" : "chip text-xs"}
            aria-expanded={favOpen}
            onClick={() => {
              setFavOpen((o) => !o);
              setFavUsed(true);
            }}
          >
            Favourites
          </button>
          <button
            type="button"
            className={coachOpen ? "chip-on text-xs" : "chip text-xs"}
            aria-expanded={coachOpen}
            onClick={() => setCoachOpen((o) => !o)}
          >
            Tell the coach
          </button>
        </div>
      )}

      {!reviewing && favOpen && (
        <div className="mt-2 rounded-xl border border-border p-2" role="group" aria-label="Favourites for this plan">
          <p className="text-xs text-muted">Exercises to build this plan around. Changes here are for this plan only.</p>
          {shownFavs.length === 0 ? (
            <p className="text-xs text-muted mt-1">No favourites picked. Search below to add some.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5 mt-2" aria-label="Picked exercises">
              {shownFavs.map((id) => {
                const name = get(id)?.name ?? id;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      className="chip text-xs"
                      aria-label={`Remove ${name}`}
                      onClick={() => editFavs((cur) => cur.filter((x) => x !== id))}
                    >
                      {name} x
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {hasCustomFav && <p className="text-xs text-muted mt-1">Your own exercises are not sent to the coach.</p>}
          <input
            type="search"
            className="field text-sm mt-2"
            aria-label="Search exercises"
            placeholder="Search exercises to add"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {results.length > 0 && (
            <ul className="mt-1 space-y-0.5" aria-label="Search results">
              {results.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    className="w-full text-left text-xs py-1 disabled:opacity-50"
                    aria-label={`Add ${e.name}`}
                    disabled={shownFavs.length >= MAX_FAVORITES}
                    onClick={() => editFavs((cur) => [...cur, e.id])}
                  >
                    + {e.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!reviewing && coachOpen && (
        <label className="block mt-2">
          <span className="block text-xs text-muted mb-1">Tell the coach</span>
          <textarea
            className="w-full rounded-xl border border-border px-3 py-2 text-sm bg-white"
            rows={3}
            maxLength={MAX_REQUEST}
            placeholder={COACH_PLACEHOLDER}
            value={request}
            onChange={(e) => setRequest(e.target.value)}
          />
        </label>
      )}

      {!reviewing && canBuild && !splitBusy && state.kind !== "needSplit" && (
        <button type="button" className="chip text-xs mt-2" onClick={buildSplitFromPicks}>
          Build a split from this
        </button>
      )}

      {state.kind === "error" && (
        <p role="status" className="text-xs text-muted mt-2">
          {state.message}
        </p>
      )}
      {state.kind === "needSplit" && (
        <div className="mt-2">
          <p role="status" className="text-xs text-muted">
            {MSG_BUILD_FIRST}
          </p>
          {!splitBusy && (
            <button type="button" className="chip text-xs mt-2" onClick={buildSplitFromPicks}>
              Build a split first
            </button>
          )}
        </div>
      )}
      {state.kind === "saved" && (
        <p role="status" className="text-xs text-muted mt-2">
          Saved {state.count} routine{state.count === 1 ? "" : "s"}.
        </p>
      )}

      {splitState.kind === "loading" && <p className="text-xs text-muted mt-2">Building a split...</p>}
      {splitState.kind === "error" && (
        <p role="status" className="text-xs text-muted mt-2">
          {splitState.message}
        </p>
      )}
      {splitState.kind === "saved" && (
        <p role="status" className="text-xs text-muted mt-2">
          {MSG_SPLIT_SAVED}
        </p>
      )}
      {splitState.kind === "review" && (
        <div className="mt-2 rounded-xl border border-border p-2">
          {splitState.message && (
            <p role="status" className="text-xs text-muted">
              {splitState.message}
            </p>
          )}
          <p className="text-sm font-semibold mt-1">{splitState.proposal.split.name}</p>
          {splitState.proposal.notes && <p className="text-xs text-muted mt-0.5">{splitState.proposal.notes}</p>}
          <ul className="mt-1 space-y-0.5" aria-label="Proposed split">
            {splitState.proposal.split.days.map((d, i) => (
              <li key={i} className="text-xs">
                <span className="font-semibold">{d.name}</span>
                <span className="text-muted">: {d.muscles.join(", ")}</span>
              </li>
            ))}
          </ul>
          {splitState.confirming ? (
            <>
              <p className="text-xs mt-2">
                Replace your current split{savedSplit.name ? ` "${savedSplit.name}"` : ""}? It is kept until you confirm.
              </p>
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  className="btn-primary flex-1"
                  disabled={splitState.saving}
                  onClick={() => applyProposal(true)}
                >
                  Replace split
                </button>
                <button
                  type="button"
                  className="btn-ghost flex-1"
                  disabled={splitState.saving}
                  onClick={() => setSplitState({ ...splitState, confirming: false })}
                >
                  Keep current split
                </button>
              </div>
            </>
          ) : (
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                className="btn-primary flex-1"
                disabled={splitState.saving}
                onClick={() => applyProposal(false)}
              >
                Use this split
              </button>
              <button
                type="button"
                className="btn-ghost flex-1"
                disabled={splitState.saving}
                onClick={() => setSplitState({ kind: "idle" })}
              >
                Discard split
              </button>
            </div>
          )}
        </div>
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
                    disabled={busy}
                    aria-label={`Keep ${d.name}`}
                  />
                  <span className="text-sm font-semibold flex-1">{d.name}</span>
                </label>
                {dayName(state.links[i]) && <p className="text-xs text-muted mt-1">For {dayName(state.links[i])}</p>}
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
          <label className="block mt-3">
            <span className="block text-xs text-muted mb-1">Ask for changes</span>
            <textarea
              className="w-full rounded-xl border border-border px-3 py-2 text-sm bg-white"
              rows={2}
              maxLength={MAX_REQUEST}
              placeholder="e.g. Swap squats for leg press"
              value={change}
              disabled={busy}
              onChange={(e) => setChange(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="chip text-xs mt-1 disabled:opacity-50"
            disabled={busy || cleanRequest(change) === null}
            onClick={refine}
          >
            {state.kind === "review" && state.refining ? "Working..." : "Regenerate"}
          </button>
          {state.note && (
            <p role="status" className="text-xs text-muted mt-2">
              {state.note}
            </p>
          )}
          <div className="flex gap-2 mt-3">
            <button
              type="button"
              className="btn-primary flex-1"
              disabled={kept === 0 || busy}
              onClick={() => save(state)}
            >
              {state.kind === "saving" ? "Saving..." : `Save ${kept} routine${kept === 1 ? "" : "s"}`}
            </button>
            <button
              type="button"
              className="btn-ghost flex-1"
              disabled={busy}
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
