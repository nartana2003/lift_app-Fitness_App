"use client";

// "Find evidence-backed exercises" (COACH-05), shown on the Review step of Coach
// setup. Opt-in only: nothing is fetched until the button is tapped. It calls
// /api/ai/evidence-picks (web search with citations), re-validates the answer
// here (https links, numeric ids, every [n] marker maps to a listed source,
// catalogue exercises for that muscle only) and drops anything invalid.
//
// Answers are cached on this device in Dexie meta per (goal type, focus muscles,
// muscle) for 30 days, so a later visit does not search (and bill) again. Only
// research picks the route returned are cached, never the rule-based fallback.
//
// On 503, offline, an error or a rules answer it shows the COACH-01 rule-based
// suggestions (reviewSetup) with a plain "limited evidence" note and no citation
// markers or sources: nothing is ever invented in the browser. All text from the
// route is rendered as plain text.
//
// lib/ai is server-only, so the disclaimer, evidence levels and source kinds are
// copies; components/goals/__tests__/EvidencePicks.test.tsx checks them against
// lib/ai/evidence-picks.ts and lib/ai/evidenceDomains.ts.
import { useEffect, useRef, useState } from "react";
import { db } from "@/lib/offline/db";
import { MUSCLE_GROUPS, type Equipment, type MuscleGroup } from "@/lib/muscles";
import type { Experience, GoalType } from "@/lib/goals";
import type { Exercise } from "@/lib/exercises";
import { useCatalogue } from "@/lib/catalogue";
import { toggleFavorite, useFavorites } from "@/lib/favorites";
import { equipmentForAi } from "@/lib/equipment";
import { isCustomId } from "@/lib/customExercises";
import { reviewSetup } from "@/lib/coachReview";

export const EVIDENCE_ROUTE = "/api/ai/evidence-picks";
/** Same cap as the route. */
export const MAX_EVIDENCE_MUSCLES = 6;
export const MAX_PICKS_PER_MUSCLE = 3;
export const CACHE_DAYS = 30;
const DAY_MS = 86_400_000;
export const CACHE_PREFIX = "evidence-picks:";
const MAX_CLAIM = 300;
const MAX_QUOTE = 300;
const MAX_TITLE = 200;
const MAX_PUBLISHER = 100;
const MAX_URL = 2_048;
const MAX_SOURCES = 40;

/** Copy of DISCLAIMER in lib/ai/evidence-picks.ts (equality tested). */
export const EVIDENCE_DISCLAIMER =
  "General fitness information, not medical advice. Research on the best exercise is limited and findings can conflict.";
/** Copy of EVIDENCE_LEVELS in lib/ai/evidence-picks.ts (checked both ways in the test). */
export const EVIDENCE_LEVELS = ["strong", "moderate", "limited", "mixed"] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];
/** Copy of SOURCE_KINDS in lib/ai/evidenceDomains.ts (checked both ways in the test). */
export const SOURCE_KINDS = ["journal", "organisation", "news"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const KIND_LABELS: Record<SourceKind, string> = { journal: "Journal", organisation: "Organisation", news: "News" };

export const MSG_EXPLAIN = "Searches the web for research on the best exercises for these muscles. It takes a little longer and uses your AI credit.";
export const MSG_SEARCHING = "Searching research...";
export const MSG_EVIDENCE_UNAVAILABLE =
  "Research search is unavailable right now. These suggestions come from the built-in rules, so the evidence is limited.";
export const MSG_EVIDENCE_OFFLINE = "You are offline. These suggestions come from the built-in rules, so the evidence is limited.";
export const MSG_EVIDENCE_PARTIAL =
  "No usable research was found for some muscles. Their suggestions come from the built-in rules, so the evidence is limited.";
export const MSG_REFRESH_FAILED = "Could not refresh all of the research right now. Showing what was found before.";
export const MSG_CANCELLED ="Search cancelled. Nothing was saved.";

export type EvidenceGoals = {
  goalType: GoalType;
  experience: Experience;
  sessionsPerWeek: number;
  focusMuscles: MuscleGroup[];
};

export type EvidenceSourceView = {
  id: number;
  title: string;
  url: string;
  publisher: string;
  kind: SourceKind;
  quote: string;
};
export type EvidencePickView = { exercise_id: string; claim: string; source_ids: number[] };
/** One muscle's research answer: at least one pick, and only the sources its picks cite. */
export type MuscleEvidence = {
  muscle: MuscleGroup;
  level: EvidenceLevel;
  picks: EvidencePickView[];
  sources: EvidenceSourceView[];
};
export type CacheEntry = MuscleEvidence & { v: 1; savedAt: number };
export type RulePick = { muscle: MuscleGroup; exercise: Exercise; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isMuscle = (v: unknown): v is MuscleGroup => typeof v === "string" && (MUSCLE_GROUPS as readonly string[]).includes(v);
const isLevel = (v: unknown): v is EvidenceLevel => typeof v === "string" && (EVIDENCE_LEVELS as readonly string[]).includes(v);
const isKind = (v: unknown): v is SourceKind => typeof v === "string" && (SOURCE_KINDS as readonly string[]).includes(v);
const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 999;

/** Control, zero-width, bidi and BOM characters. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/** Plain text: control characters dropped, whitespace collapsed, trimmed. */
function plain(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
}
const capped = (v: unknown, max: number) => plain(v).slice(0, max);

/** An https link with a host and no credentials, or null. */
export function safeUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > MAX_URL) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

const MARKER = /\[(\d{1,3})\]/g;

/** The claim split into text and [n] citation markers. */
export function claimSegments(claim: string): ({ text: string } | { ref: number })[] {
  const out: ({ text: string } | { ref: number })[] = [];
  let last = 0;
  for (const m of claim.matchAll(MARKER)) {
    if (m.index > last) out.push({ text: claim.slice(last, m.index) });
    out.push({ ref: Number(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < claim.length) out.push({ text: claim.slice(last) });
  return out;
}

/** Catalogue exercise (never custom) that trains the muscle and passes the equipment filter. */
function exerciseFor(
  id: unknown,
  muscle: MuscleGroup,
  get: (id: string) => Exercise | undefined,
  equipment: readonly Equipment[],
): Exercise | null {
  if (typeof id !== "string" || isCustomId(id)) return null;
  const e = get(id);
  if (!e || !e.muscle_groups.includes(muscle)) return null;
  if (equipment.length && !equipment.includes(e.equipment)) return null;
  return e;
}

/**
 * Re-validates a 200 body from the route (or a cached entry). Null unless it is
 * a research answer ("ai"). Returns one entry per requested muscle that has at
 * least one valid pick. Dropped: sources without an https url, a numeric id,
 * a known kind or a quote, repeated ids or urls; picks for other muscles,
 * unknown, custom or wrong-muscle exercises, repeats, empty or overlong claims,
 * picks with no marker, a marker or source id that maps to no valid source.
 */
export function parseEvidence(
  json: unknown,
  muscles: readonly MuscleGroup[],
  get: (id: string) => Exercise | undefined,
  equipment: readonly Equipment[],
): Map<MuscleGroup, MuscleEvidence> | null {
  if (!isObj(json) || json.source !== "ai" || !Array.isArray(json.picks) || !Array.isArray(json.sources)) return null;

  const sources = new Map<number, EvidenceSourceView>();
  const urls = new Set<string>();
  for (const s of json.sources.slice(0, MAX_SOURCES)) {
    if (!isObj(s) || !isId(s.id) || sources.has(s.id) || !isKind(s.kind)) continue;
    const url = safeUrl(s.url);
    const quote = capped(s.quote, MAX_QUOTE);
    const publisher = capped(s.publisher, MAX_PUBLISHER);
    if (!url || urls.has(url) || !quote || !publisher) continue;
    urls.add(url);
    sources.set(s.id, { id: s.id, title: capped(s.title, MAX_TITLE) || publisher, url, publisher, kind: s.kind, quote });
  }

  const byMuscle = new Map<MuscleGroup, EvidencePickView[]>();
  for (const p of json.picks) {
    if (!isObj(p) || !isMuscle(p.muscle) || !muscles.includes(p.muscle)) continue;
    const list = byMuscle.get(p.muscle) ?? [];
    if (list.length >= MAX_PICKS_PER_MUSCLE) continue;
    const e = exerciseFor(p.exercise_id, p.muscle, get, equipment);
    if (!e || list.some((x) => x.exercise_id === e.id)) continue;
    const claim = plain(p.claim);
    if (!claim || claim.length > MAX_CLAIM) continue;
    if (!Array.isArray(p.source_ids) || p.source_ids.length === 0 || !p.source_ids.every((id) => isId(id) && sources.has(id))) continue;
    const ids = [...new Set(p.source_ids as number[])];
    const markers = [...claim.matchAll(MARKER)].map((m) => Number(m[1]));
    if (markers.length === 0 || !markers.every((n) => ids.includes(n))) continue;
    list.push({ exercise_id: e.id, claim, source_ids: ids });
    byMuscle.set(p.muscle, list);
  }

  const levels = isObj(json.evidence) ? json.evidence : {};
  const out = new Map<MuscleGroup, MuscleEvidence>();
  for (const m of muscles) {
    const picks = byMuscle.get(m);
    if (!picks?.length) continue;
    const cited = new Set(picks.flatMap((p) => p.source_ids));
    out.set(m, {
      muscle: m,
      level: isLevel(levels[m]) ? levels[m] : "limited",
      picks,
      sources: [...cited].sort((a, b) => a - b).map((id) => sources.get(id)!),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cache (Dexie meta)
// ---------------------------------------------------------------------------

/** Cache key per (goal type, focus muscles, muscle). Focus order does not matter. */
export function cacheKey(goalType: GoalType, focusMuscles: readonly MuscleGroup[], muscle: MuscleGroup): string {
  const focus = [...new Set(focusMuscles)].sort((a, b) => MUSCLE_GROUPS.indexOf(a) - MUSCLE_GROUPS.indexOf(b));
  return `${CACHE_PREFIX}${goalType}|${focus.join(",")}|${muscle}`;
}

/** A stored entry, re-validated, or null when missing, malformed or older than CACHE_DAYS. */
export function readEntry(
  raw: unknown,
  muscle: MuscleGroup,
  get: (id: string) => Exercise | undefined,
  equipment: readonly Equipment[],
  now: number,
): CacheEntry | null {
  if (!isObj(raw) || raw.v !== 1 || raw.muscle !== muscle) return null;
  const savedAt = raw.savedAt;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt) || savedAt > now + DAY_MS || now - savedAt > CACHE_DAYS * DAY_MS) return null;
  const parsed = parseEvidence(
    { source: "ai", picks: Array.isArray(raw.picks) ? raw.picks.map((p) => (isObj(p) ? { ...p, muscle } : p)) : null, sources: raw.sources, evidence: { [muscle]: raw.level } },
    [muscle],
    get,
    equipment,
  );
  const entry = parsed?.get(muscle);
  return entry ? { ...entry, v: 1, savedAt } : null;
}

export async function loadCached(
  goals: EvidenceGoals,
  muscles: readonly MuscleGroup[],
  get: (id: string) => Exercise | undefined,
  equipment: readonly Equipment[],
  now = Date.now(),
): Promise<Map<MuscleGroup, CacheEntry>> {
  const rows = await db.meta.bulkGet(muscles.map((m) => cacheKey(goals.goalType, goals.focusMuscles, m)));
  const out = new Map<MuscleGroup, CacheEntry>();
  muscles.forEach((m, i) => {
    const e = readEntry(rows[i]?.value, m, get, equipment, now);
    if (e) out.set(m, e);
  });
  return out;
}

/** Stores only what the route returned for each muscle (already validated). */
export async function saveCached(goals: EvidenceGoals, entries: Iterable<MuscleEvidence>, now = Date.now()): Promise<CacheEntry[]> {
  const out: CacheEntry[] = [];
  for (const e of entries) {
    const entry: CacheEntry = { v: 1, savedAt: now, muscle: e.muscle, level: e.level, picks: e.picks, sources: e.sources };
    await db.meta.put({ key: cacheKey(goals.goalType, goals.focusMuscles, e.muscle), value: entry });
    out.push(entry);
  }
  return out;
}

/** "Found today", "Found 1 day ago", "Found 3 days ago". */
export function foundLabel(savedAt: number, now = Date.now()): string {
  const days = Math.max(0, Math.floor((now - savedAt) / DAY_MS));
  if (days === 0) return "Found today";
  return days === 1 ? "Found 1 day ago" : `Found ${days} days ago`;
}

// ---------------------------------------------------------------------------
// Rule-based fallback (COACH-01)
// ---------------------------------------------------------------------------

/** reviewSetup on a one-day split of the muscles with an empty pool, as the route's fallback does. */
export function ruleEvidencePicks(
  goals: EvidenceGoals,
  muscles: readonly MuscleGroup[],
  catalogue: readonly Exercise[],
  equipment: readonly Equipment[],
): RulePick[] {
  if (muscles.length === 0) return [];
  const review = reviewSetup({
    goals: { ...goals, focusMuscles: goals.focusMuscles.filter((m) => muscles.includes(m)) },
    split: { name: "Evidence", days: [{ name: "Evidence", muscles: [...muscles] }] },
    pool: {},
    catalogue: catalogue.filter((e) => !isCustomId(e.id)),
    equipment: [...equipment],
  });
  return review.suggestions
    .filter((s) => muscles.includes(s.muscle))
    .map((s) => ({ muscle: s.muscle, exercise: s.exercise, reason: s.reason }));
}

/** Request body for the route. */
export function evidenceRequestBody(goals: EvidenceGoals, muscles: readonly MuscleGroup[], equipment: readonly Equipment[]) {
  return {
    goals: {
      goalType: goals.goalType,
      experience: goals.experience,
      sessionsPerWeek: Math.max(1, Math.min(7, Math.round(goals.sessionsPerWeek))),
      focusMuscles: [...new Set(goals.focusMuscles.filter(isMuscle))],
    },
    muscles: [...new Set(muscles)].slice(0, MAX_EVIDENCE_MUSCLES),
    equipment: equipmentForAi(equipment),
  };
}

/** Display numbers for sources across muscles: one number per url, in order of first citation. */
export function numberSources(entries: readonly MuscleEvidence[]): {
  list: (EvidenceSourceView & { n: number })[];
  numberOf: (entry: MuscleEvidence, id: number) => number | undefined;
} {
  const byUrl = new Map<string, EvidenceSourceView & { n: number }>();
  for (const e of entries) {
    const local = new Map(e.sources.map((s) => [s.id, s]));
    for (const p of e.picks) {
      const order = [...claimSegments(p.claim).flatMap((s) => ("ref" in s ? [s.ref] : [])), ...p.source_ids];
      for (const id of order) {
        const s = local.get(id);
        if (s && !byUrl.has(s.url)) byUrl.set(s.url, { ...s, n: byUrl.size + 1 });
      }
    }
  }
  return {
    list: [...byUrl.values()],
    numberOf: (entry, id) => {
      const s = entry.sources.find((x) => x.id === id);
      return s ? byUrl.get(s.url)?.n : undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

type Fallback = { note: string; muscles: MuscleGroup[] };

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

export function EvidencePicks({
  goals,
  muscles: musclesIn,
  equipment,
  isAdded,
  onAdd,
  onRemove,
}: {
  goals: EvidenceGoals;
  muscles: readonly MuscleGroup[];
  equipment: readonly Equipment[];
  /** Pool hooks. Default: the starred exercises (favourites), toggled at once. */
  isAdded?: (id: string) => boolean;
  onAdd?: (id: string) => void;
  onRemove?: (id: string) => void;
}) {
  const catalogue = useCatalogue();
  const favorites = useFavorites();
  const muscles = [...new Set(musclesIn.filter(isMuscle))].slice(0, MAX_EVIDENCE_MUSCLES);
  const musclesKey = muscles.join(",");
  const reqKey = `${goals.goalType}|${goals.focusMuscles.join(",")}|${musclesKey}|${equipment.join(",")}`;

  const [entries, setEntries] = useState<Map<MuscleGroup, CacheEntry>>(new Map());
  const [fallback, setFallback] = useState<Fallback | null>(null);
  const [searching, setSearching] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const prefix = `evidence-${reqKey.replace(/[^a-zA-Z0-9]/g, "-")}`;

  const added = (id: string) => (isAdded ? isAdded(id) : favorites.includes(id));
  const toggle = (id: string) => {
    if (added(id)) {
      if (onRemove) onRemove(id);
      else if (!onAdd) void toggleFavorite(id);
    } else if (onAdd) onAdd(id);
    else void toggleFavorite(id);
  };

  // Cached answers are read from this device only (no network).
  const loading = catalogue.loading;
  const get = catalogue.get;
  useEffect(() => {
    if (loading) return;
    let live = true;
    void loadCached(goals, muscles, get, equipmentForAi(equipment)).then((m) => {
      if (live) setEntries(m);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey, loading]);

  useEffect(() => () => abort.current?.abort(), []);

  const search = async (refresh: boolean) => {
    const want = refresh ? muscles : muscles.filter((m) => !entries.has(m));
    if (want.length === 0) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setSearching(true);
    setCancelled(false);
    setFallback(null);
    const eq = equipmentForAi(equipment);
    let found: Map<MuscleGroup, MuscleEvidence> | null = null;
    let note = MSG_EVIDENCE_UNAVAILABLE;
    if (isOffline()) {
      note = MSG_EVIDENCE_OFFLINE;
    } else {
      try {
        const res = await fetch(EVIDENCE_ROUTE, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(evidenceRequestBody(goals, want, equipment)),
          signal: ctrl.signal,
        });
        if (res.ok) found = parseEvidence(await res.json(), want, catalogue.get, eq);
      } catch {
        if (ctrl.signal.aborted) return;
        if (isOffline()) note = MSG_EVIDENCE_OFFLINE;
      }
    }
    if (ctrl.signal.aborted) return;
    const saved = found && found.size ? await saveCached(goals, found.values()) : [];
    if (ctrl.signal.aborted) return;
    // A refresh that finds nothing new keeps the earlier saved answer for that muscle.
    setEntries((prev) => {
      const next = new Map(prev);
      for (const e of saved) next.set(e.muscle, e);
      return next;
    });
    const missing = want.filter((m) => !saved.some((e) => e.muscle === m) && !entries.has(m));
    if (missing.length) setFallback({ note: saved.length ? MSG_EVIDENCE_PARTIAL : note, muscles: missing });
    else if (refresh && saved.length < want.length) setFallback({ note: MSG_REFRESH_FAILED, muscles: [] });
    setSearching(false);
    abort.current = null;
  };

  const cancel = () => {
    abort.current?.abort();
    abort.current = null;
    setSearching(false);
    setCancelled(true);
  };

  if (muscles.length === 0) return null;

  const shown = muscles.flatMap((m) => {
    const e = entries.get(m);
    return e ? [e] : [];
  });
  const { list: sourceList, numberOf } = numberSources(shown);
  const rulePicks = fallback ? ruleEvidencePicks(goals, fallback.muscles, catalogue.exercises, equipmentForAi(equipment)) : [];
  const allCached = muscles.every((m) => entries.has(m));
  const oldest = shown.length ? Math.min(...shown.map((e) => e.savedAt)) : null;

  const scrollTo = (n: number) => {
    const el = typeof document !== "undefined" ? document.getElementById(`${prefix}-source-${n}`) : null;
    el?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  };

  const addButton = (e: Exercise) => {
    const done = added(e.id);
    return (
      <button
        type="button"
        className={done ? "chip-on text-xs shrink-0" : "chip text-xs shrink-0"}
        aria-label={done ? `${e.name} added` : `Add ${e.name}`}
        onClick={() => toggle(e.id)}
      >
        {done ? "Added" : "Add"}
      </button>
    );
  };

  return (
    <section aria-label="Evidence-backed exercises" className="rounded-lg border border-border p-2 space-y-2">
      <p className="text-xs font-semibold">Evidence-backed exercises</p>
      {!searching && !allCached && (
        <div className="space-y-1">
          <p className="text-xs text-muted">{MSG_EXPLAIN}</p>
          <button type="button" className="btn-ghost w-full py-2 text-sm" onClick={() => void search(false)} disabled={catalogue.loading}>
            Find evidence-backed exercises
          </button>
        </div>
      )}
      {searching && (
        <div className="flex items-center justify-between gap-2">
          <p role="status" className="text-xs text-muted">
            {MSG_SEARCHING}
          </p>
          <button type="button" className="chip text-xs" aria-label="Cancel search" onClick={cancel}>
            Cancel
          </button>
        </div>
      )}
      {cancelled && !searching && (
        <p role="status" className="text-xs text-muted">
          {MSG_CANCELLED}
        </p>
      )}

      {oldest !== null && !searching && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted">{foundLabel(oldest)}</p>
          <button type="button" className="chip text-xs" onClick={() => void search(true)}>
            Refresh
          </button>
        </div>
      )}

      {shown.length > 0 && (
        <ul className="space-y-2" aria-label="Research picks">
          {shown.map((entry) => (
            <li key={entry.muscle} className="rounded-lg bg-surface-2 p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{entry.muscle}</span>
                <span className="text-[11px] text-muted">Evidence: {entry.level}</span>
              </div>
              <ul className="space-y-1.5 mt-1">
                {entry.picks.map((p) => {
                  const e = catalogue.get(p.exercise_id);
                  if (!e) return null;
                  return (
                    <li key={p.exercise_id} className="flex items-start justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block text-xs font-semibold">{e.name}</span>
                        <span className="block text-xs text-muted">
                          {claimSegments(p.claim).map((s, i) => {
                            if ("text" in s) return <span key={i}>{s.text}</span>;
                            const n = numberOf(entry, s.ref);
                            if (n === undefined) return null;
                            return (
                              <sup key={i}>
                                <a
                                  href={`#${prefix}-source-${n}`}
                                  className="underline px-px"
                                  aria-label={`Source ${n}`}
                                  onClick={(ev) => {
                                    ev.preventDefault();
                                    scrollTo(n);
                                  }}
                                >
                                  [{n}]
                                </a>
                              </sup>
                            );
                          })}
                        </span>
                      </span>
                      {addButton(e)}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {sourceList.length > 0 && (
        <div>
          <p className="text-xs text-muted mb-1">Sources</p>
          <ol className="space-y-1.5" aria-label="Sources">
            {sourceList.map((s) => (
              <li key={s.url} id={`${prefix}-source-${s.n}`} className="text-xs">
                <span className="font-semibold">[{s.n}] </span>
                <span>{s.title}</span>
                <span className="text-muted"> · {s.publisher} </span>
                <span className="chip text-[10px] px-1.5 py-0">{KIND_LABELS[s.kind]}</span>
                <span className="block text-muted mt-0.5">&ldquo;{s.quote}&rdquo;</span>
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline">
                  Open source
                </a>
              </li>
            ))}
          </ol>
        </div>
      )}

      {fallback && (
        <div className="space-y-2">
          <p role="status" className="text-xs text-muted">
            {fallback.note}
          </p>
          {fallback.muscles.map((m) => {
            const list = rulePicks.filter((p) => p.muscle === m);
            return (
              <div key={m} className="rounded-lg bg-surface-2 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{m}</span>
                  <span className="text-[11px] text-muted">Evidence: limited</span>
                </div>
                {list.length === 0 ? (
                  <p className="text-xs text-muted">No suggestions for this muscle.</p>
                ) : (
                  <ul className="space-y-1 mt-1" aria-label={`Built-in suggestions for ${m}`}>
                    {list.map((p) => (
                      <li key={p.exercise.id} className="flex items-start justify-between gap-2">
                        <span className="min-w-0">
                          <span className="block text-xs font-semibold">{p.exercise.name}</span>
                          <span className="block text-xs text-muted">{p.reason}</span>
                        </span>
                        {addButton(p.exercise)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[11px] text-muted">{EVIDENCE_DISCLAIMER}</p>
    </section>
  );
}
