"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { db, uuid, type MeasurementRow, type PhotoRow } from "@/lib/offline/db";
import { queuePhotoDelete } from "@/lib/offline/photoSync";
import { loadCatalogue } from "@/lib/catalogue";
import { allWorkouts } from "@/lib/history";
import type { MuscleGroup } from "@/lib/muscles";
import { dayKey, periodStats, type WorkoutLite } from "@/lib/progress";
import { applySet, emptyBests, setPrs, type Bests } from "@/lib/prs";
import { useSettings } from "@/lib/settings";
import { addMonths } from "@/lib/stats";
import type { Unit } from "@/lib/units";
import { toBaseStats } from "./RecapCard";
import { Segmented } from "./Segmented";

type Pose = "front" | "side" | "back";
const POSES: { v: Pose; label: string }[] = [
  { v: "front", label: "Front" },
  { v: "side", label: "Side" },
  { v: "back", label: "Back" },
];

/** Downscale to ≤1280px JPEG so photos stay small on the phone. */
async function shrink(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", 0.85));
}

function useObjectUrl(blob: Blob | undefined) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

function Photo({ p, className = "" }: { p: PhotoRow; className?: string }) {
  const url = useObjectUrl(p.blob);
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt="Progress photo" className={`object-cover ${className}`} /> : <div className={`bg-surface-2 ${className}`} />;
}

const dateLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

// ---------------------------------------------------------------------------
// Monthly analysis (POST /api/ai/photo-analysis)
//
// On tap, the first and last photo of the chosen month (same pose when there
// is one) and that month's training stats go to the route, which answers with
// a short progress comment and a few tips. Nothing is fetched on render, and
// nothing is sent unless the user taps. Any failure (no key, offline, bad
// answer) shows a short plain message; the gallery and compare are untouched.
// The last answer per month is kept on this device in db.meta.
// ---------------------------------------------------------------------------

export const ANALYSIS_ROUTE = "/api/ai/photo-analysis";
export const MSG_ANALYSIS_UNAVAILABLE = "The monthly analysis is not available right now. Your photos are unchanged.";
export const MSG_ANALYSIS_OFFLINE = "The monthly analysis is available when back online.";
export const MSG_ANALYSIS_FAILED = "Could not get the monthly analysis. Try again later.";
export const MSG_ANALYSIS_NO_PHOTO = "No photo from this month can be sent. Add a new photo and try again.";

/** Same bounds the route validates (lib/ai/photo-analysis.ts). */
export const ANALYSIS_MEDIA_TYPES = ["image/jpeg", "image/png"] as const;
export type AnalysisMediaType = (typeof ANALYSIS_MEDIA_TYPES)[number];
export const MAX_ANALYSIS_IMAGE_BYTES = 1_500_000;
export const MAX_ANALYSIS_TOTAL_BYTES = 2_500_000;
const MIN_ANALYSIS_IMAGE_BYTES = 32;
const MAX_PR_COUNT = 100;
const MIN_BODYWEIGHT = 20;
const MAX_BODYWEIGHT = 400;
/** What the card keeps from the answer. */
const MAX_COMMENT_LINES = 4;
const MAX_COMMENT_LINE = 240;
const MAX_FOCUS = 3;
const MAX_FOCUS_TEXT = 200;

export const analysisKey = (month: string) => `photo_analysis:${month}`;

export type AnalysisPhoto = { taken_on: string; pose: Pose | null; media_type: AnalysisMediaType; data: string };
export type AnalysisStats = {
  sessions: number;
  duration_sec: number;
  volume: number;
  sets_by_muscle: Partial<Record<MuscleGroup, number>>;
  pr_count: number;
  bodyweight_start: number | null;
  bodyweight_end: number | null;
};
export type AnalysisBody = { month: string; unit: Unit; photos: AnalysisPhoto[]; stats: AnalysisStats };
export type Analysis = { month: string; comment: string[]; focus: string[] };

/** "YYYY-MM" of a timestamp, in local time. */
export const monthOf = (iso: string) => dayKey(new Date(iso)).slice(0, 7);

export const monthTitle = (month: string) =>
  new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });

/** Months that have photos, newest first. */
export function photoMonths(photos: { taken_at: string }[]): string[] {
  return [...new Set(photos.map((p) => monthOf(p.taken_at)))].sort((a, b) => b.localeCompare(a));
}

const isMediaType = (t: string): t is AnalysisMediaType => (ANALYSIS_MEDIA_TYPES as readonly string[]).includes(t);
const sendable = (p: PhotoRow) =>
  isMediaType(p.blob.type) && p.blob.size >= MIN_ANALYSIS_IMAGE_BYTES && p.blob.size <= MAX_ANALYSIS_IMAGE_BYTES;

/**
 * First and last sendable photo of the month, oldest first. The last photo
 * decides the pose: the first one is the earliest photo with the same pose
 * when there is one. One photo when the month has only one (or the pair is
 * over the total size cap).
 */
export function pickAnalysisPhotos(photos: PhotoRow[], month: string): PhotoRow[] {
  const list = photos.filter((p) => monthOf(p.taken_at) === month && sendable(p)).sort((a, b) => a.taken_at.localeCompare(b.taken_at));
  const last = list.at(-1);
  if (!last) return [];
  const first = (last.pose ? list.find((p) => p.pose === last.pose && p.id !== last.id) : undefined) ?? list[0];
  if (first.id === last.id || first.blob.size + last.blob.size > MAX_ANALYSIS_TOTAL_BYTES) return [last];
  return [first, last];
}

/** Bounds of the month as local dates, [from, to). */
export function monthRange(month: string): { from: Date; to: Date } {
  const from = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
  return { from, to: addMonths(from, 1) };
}

/**
 * Exercise sessions in [from, to) that beat the heaviest weight or best e1RM
 * of every earlier session of that exercise. A first-ever session is not a PR.
 */
export function countPrs(workouts: WorkoutLite[], from: Date, to: Date): number {
  const sorted = [...workouts].sort((a, b) => a.started_at.localeCompare(b.started_at));
  const bests = new Map<string, Bests>();
  let n = 0;
  for (const w of sorted) {
    const t = Date.parse(w.started_at);
    if (t >= to.getTime()) break;
    const inMonth = t >= from.getTime();
    for (const e of w.exercises) {
      const prior = bests.get(e.exercise_id);
      if (inMonth && prior && prior.weight > 0 && e.sets.some((s) => setPrs(s, prior).some((k) => k === "weight" || k === "e1rm"))) n++;
      bests.set(e.exercise_id, e.sets.reduce(applySet, prior ?? emptyBests()));
    }
  }
  return n;
}

const bodyweight = (v: number | undefined) => (v !== undefined && Number.isFinite(v) && v >= MIN_BODYWEIGHT && v <= MAX_BODYWEIGHT ? Math.round(v * 100) / 100 : null);

/** The month's stats in the route's shape, clamped to its bounds. */
export function monthStats(
  workouts: WorkoutLite[],
  month: string,
  muscleOf: (exerciseId: string) => string[],
  measurements: MeasurementRow[],
): AnalysisStats {
  const { from, to } = monthRange(month);
  const base = toBaseStats(periodStats(workouts, from, to, muscleOf));
  const weights = measurements
    .filter((m) => m.type === "body_weight" && m.date.startsWith(`${month}-`))
    .sort((a, b) => a.date.localeCompare(b.date));
  const two = weights.length >= 2;
  return {
    sessions: base.sessions,
    duration_sec: base.duration_sec,
    volume: base.volume,
    sets_by_muscle: base.sets_by_muscle,
    pr_count: Math.min(MAX_PR_COUNT, countPrs(workouts, from, to)),
    bodyweight_start: two ? bodyweight(weights[0].value) : null,
    bodyweight_end: two ? bodyweight(weights[weights.length - 1].value) : null,
  };
}

/** Base64 of a blob (no data: prefix). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : "");
    };
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

export async function toAnalysisPhoto(p: PhotoRow): Promise<AnalysisPhoto> {
  return { taken_on: dayKey(new Date(p.taken_at)), pose: p.pose, media_type: p.blob.type as AnalysisMediaType, data: await blobToBase64(p.blob) };
}

export function buildAnalysisBody(month: string, unit: Unit, photos: AnalysisPhoto[], stats: AnalysisStats): AnalysisBody {
  return { month, unit, photos, stats };
}

/** One plain line: control characters dropped, whitespace collapsed, capped. */
function plainLine(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

/** Checks the route's 200 body. Null when there is no usable comment line. */
export function parseAnalysis(json: unknown, month: string): Analysis | null {
  if (typeof json !== "object" || json === null) return null;
  const { comment, focus } = json as { comment?: unknown; focus?: unknown };
  if (!Array.isArray(comment)) return null;
  const lines: string[] = [];
  for (const l of comment) {
    const s = plainLine(l, MAX_COMMENT_LINE);
    if (s && !lines.includes(s) && lines.length < MAX_COMMENT_LINES) lines.push(s);
  }
  if (lines.length === 0) return null;
  const tips: string[] = [];
  if (Array.isArray(focus)) {
    for (const f of focus) {
      if (typeof f !== "object" || f === null || tips.length >= MAX_FOCUS) continue;
      const text = plainLine((f as { text?: unknown }).text, MAX_FOCUS_TEXT);
      if (text && !tips.includes(text)) tips.push(text);
    }
  }
  return { month, comment: lines, focus: tips };
}

/** A saved answer from db.meta, re-checked. */
export function readSavedAnalysis(value: unknown, month: string): Analysis | null {
  if (typeof value !== "object" || value === null || (value as { month?: unknown }).month !== month) return null;
  return parseAnalysis(value, month);
}

/** Default stats loader: workouts, catalogue muscles and body weight from this device. */
export async function loadMonthStats(month: string): Promise<AnalysisStats> {
  const [workouts, measurements, custom] = await Promise.all([
    allWorkouts(),
    db.measurements.where("type").equals("body_weight").toArray(),
    db.custom_exercises.toArray(),
  ]);
  let byId = new Map<string, string[]>();
  try {
    const cat = await loadCatalogue();
    byId = new Map([...cat.byId].map(([id, e]) => [id, e.muscle_groups as string[]]));
  } catch {
    // catalogue not reachable: sets_by_muscle only covers custom exercises
  }
  for (const c of custom) byId.set(c.id, c.muscle_groups);
  return monthStats(workouts, month, (id) => byId.get(id) ?? [], measurements);
}

type AnalysisState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; analysis: Analysis };

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/** "Monthly analysis" card under the gallery. */
export function MonthlyAnalysis({
  photos,
  unit,
  loadStats = loadMonthStats,
}: {
  photos: PhotoRow[];
  unit: Unit;
  loadStats?: (month: string) => Promise<AnalysisStats>;
}) {
  const months = useMemo(() => photoMonths(photos), [photos]);
  const [chosen, setChosen] = useState<string | null>(null);
  const month = chosen && months.includes(chosen) ? chosen : (months[0] ?? null);
  const [state, setState] = useState<AnalysisState>({ kind: "idle" });

  // Show the last saved answer for the month, if any.
  useEffect(() => {
    let live = true;
    setState({ kind: "idle" });
    if (!month) return;
    db.meta
      .get(analysisKey(month))
      .then((row) => {
        const saved = readSavedAnalysis(row?.value, month);
        if (live && saved) setState((s) => (s.kind === "idle" ? { kind: "done", analysis: saved } : s));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [month]);

  if (!month) return null;

  const run = async () => {
    if (isOffline()) {
      setState({ kind: "error", message: MSG_ANALYSIS_OFFLINE });
      return;
    }
    const picked = pickAnalysisPhotos(photos, month);
    if (picked.length === 0) {
      setState({ kind: "error", message: MSG_ANALYSIS_NO_PHOTO });
      return;
    }
    setState({ kind: "loading" });
    try {
      const [stats, sent] = await Promise.all([loadStats(month), Promise.all(picked.map(toAnalysisPhoto))]);
      const res = await fetch(ANALYSIS_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildAnalysisBody(month, unit, sent, stats)),
      });
      if (res.status === 503) {
        setState({ kind: "error", message: MSG_ANALYSIS_UNAVAILABLE });
        return;
      }
      if (!res.ok) {
        setState({ kind: "error", message: MSG_ANALYSIS_FAILED });
        return;
      }
      const analysis = parseAnalysis(await res.json(), month);
      if (!analysis) {
        setState({ kind: "error", message: MSG_ANALYSIS_FAILED });
        return;
      }
      setState({ kind: "done", analysis });
      await db.meta.put({ key: analysisKey(month), value: analysis }).catch(() => {});
    } catch {
      setState({ kind: "error", message: isOffline() ? MSG_ANALYSIS_OFFLINE : MSG_ANALYSIS_FAILED });
    }
  };

  return (
    <section className="card p-3 mt-4" aria-label="Monthly analysis">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">Monthly analysis</h3>
        <button type="button" className="btn-ghost text-sm" onClick={run} disabled={state.kind === "loading"}>
          {state.kind === "loading" ? "Analysing..." : state.kind === "done" ? "Refresh" : "Analyse month"}
        </button>
      </div>
      {months.length > 1 && (
        <select
          aria-label="Analysis month"
          className="mt-2 w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-sm"
          value={month}
          onChange={(e) => setChosen(e.target.value)}
          disabled={state.kind === "loading"}
        >
          {months.map((m) => (
            <option key={m} value={m}>
              {monthTitle(m)}
            </option>
          ))}
        </select>
      )}
      {state.kind !== "done" && (
        <p className="text-xs text-muted mt-1">
          Compares the first and last photo of {monthTitle(month)} with that month&apos;s training. Only those two photos are sent, on tap, and they are not stored.
        </p>
      )}
      {state.kind === "error" && (
        <p role="status" className="text-sm text-muted mt-2">
          {state.message}
        </p>
      )}
      {state.kind === "done" && (
        <div className="mt-2 space-y-2">
          <div className="space-y-1 text-sm" aria-label="Analysis comment">
            {state.analysis.comment.map((l) => (
              <p key={l}>{l}</p>
            ))}
          </div>
          {state.analysis.focus.length > 0 && (
            <>
              <h4 className="text-xs font-semibold text-muted uppercase tracking-wide">Next month</h4>
              <ul aria-label="Next month focus" className="space-y-1 text-sm list-disc pl-5">
                {state.analysis.focus.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Finish-screen photo prompt
//
// After a workout is saved, the Finish screen offers one photo per pose
// (front, side, back). The camera opens through a file input with `capture`.
// Each photo is kept on this device like the gallery's, tagged with its pose
// and linked to the workout through `workout_id` (an extra, unindexed field
// on the photos row, so no schema change). Retaking a pose replaces that
// photo. Skipping saves nothing.
// ---------------------------------------------------------------------------

/** A photos row; `workout_id` is set when the photo was taken on the Finish screen. */
export type ProgressPhotoRow = PhotoRow & { workout_id?: string };

export const FINISH_POSES: readonly { v: Pose; label: string }[] = POSES;
export const MSG_FINISH_PHOTO_FAILED = "Could not read that photo. Try another one.";

/** The row saved for a Finish-screen photo. */
export function finishPhotoRow(p: { id: string; workoutId: string; pose: Pose; blob: Blob; takenAt: string }): ProgressPhotoRow {
  return { id: p.id, taken_at: p.takenAt, pose: p.pose, blob: p.blob, workout_id: p.workoutId };
}

/** Photos linked to a workout, in front, side, back order. */
export async function workoutPhotos(workoutId: string): Promise<ProgressPhotoRow[]> {
  const order = (p: PhotoRow) => (p.pose ? POSES.findIndex((x) => x.v === p.pose) : POSES.length);
  const all = (await db.photos.toArray()) as ProgressPhotoRow[];
  return all.filter((p) => p.workout_id === workoutId).sort((a, b) => order(a) - order(b));
}

/**
 * Saves (or replaces, when `id` is given) the photo for one pose of a workout.
 * Returns the row id.
 */
export async function saveFinishPhoto(workoutId: string, pose: Pose, blob: Blob, id: string = uuid(), takenAt: string = new Date().toISOString()): Promise<string> {
  await db.photos.put(finishPhotoRow({ id, workoutId, pose, blob, takenAt }));
  return id;
}

function PoseSlot({
  pose,
  label,
  photo,
  busy,
  onFile,
}: {
  pose: Pose;
  label: string;
  photo: PhotoRow | undefined;
  busy: boolean;
  onFile: (pose: Pose, file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-1">
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        aria-label={`${label} photo file`}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(pose, f);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        className={`relative aspect-[3/4] rounded-xl overflow-hidden grid place-items-center text-muted ${photo ? "" : "border border-dashed border-border"}`}
        onClick={() => input.current?.click()}
        disabled={busy}
        aria-label={photo ? `Retake ${label.toLowerCase()} photo` : `Take ${label.toLowerCase()} photo`}
      >
        {photo ? <Photo p={photo} className="size-full" /> : <span className="text-2xl leading-none">{busy ? "…" : "+"}</span>}
      </button>
      <span className="text-xs text-center text-muted">{label}</span>
    </div>
  );
}

/** Bottom sheet shown after Finish: front, side and back photos linked to the workout. */
export function FinishPhotos({
  workoutId,
  onDone,
  prepare = shrink,
}: {
  workoutId: string;
  onDone: () => void;
  /** Turns the picked file into the stored blob (downscaled JPEG by default). */
  prepare?: (file: File) => Promise<Blob>;
}) {
  const [taken, setTaken] = useState<Partial<Record<Pose, PhotoRow>>>({});
  const [busy, setBusy] = useState<Pose | null>(null);
  const [error, setError] = useState<string | null>(null);
  const count = Object.keys(taken).length;

  async function onFile(pose: Pose, file: File) {
    setBusy(pose);
    setError(null);
    try {
      const blob = await prepare(file);
      const takenAt = new Date().toISOString();
      const id = await saveFinishPhoto(workoutId, pose, blob, taken[pose]?.id ?? uuid(), takenAt);
      setTaken((t) => ({ ...t, [pose]: { id, taken_at: takenAt, pose, blob } }));
    } catch {
      setError(MSG_FINISH_PHOTO_FAILED);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-end">
      <section
        className="w-full max-w-lg mx-auto card rounded-b-none p-5 pb-safe space-y-3"
        role="dialog"
        aria-modal="true"
        aria-labelledby="finish-photos-title"
      >
        <h2 id="finish-photos-title" className="text-lg font-semibold">Progress photos</h2>
        <p className="text-sm text-muted">Take a front, side and back photo to track your progress. They stay on this device and are linked to this workout.</p>
        <div className="grid grid-cols-3 gap-2">
          {FINISH_POSES.map((p) => (
            <PoseSlot key={p.v} pose={p.v} label={p.label} photo={taken[p.v]} busy={busy !== null} onFile={onFile} />
          ))}
        </div>
        {error && (
          <p role="status" className="text-sm text-muted">
            {error}
          </p>
        )}
        <button type="button" className="btn-primary w-full" disabled={busy !== null || count === 0} onClick={onDone}>
          {count === 0 ? "Done" : `Done (${count}/${FINISH_POSES.length})`}
        </button>
        {count === 0 && (
          <button type="button" className="btn-ghost w-full" disabled={busy !== null} onClick={onDone}>
            Skip
          </button>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slider overlay compare
//
// The two picked photos are stacked: the earlier one underneath, the later one
// on top, clipped from the right. A labelled range input (keyboard, touch and
// mouse) sets how much of the later photo shows; dragging on the photos does
// the same. The side-by-side view stays the default.
// ---------------------------------------------------------------------------

export type CompareMode = "side" | "slider";
export const COMPARE_MODES: { value: CompareMode; label: string }[] = [
  { value: "side", label: "Side by side" },
  { value: "slider", label: "Slider" },
];
export const REVEAL_DEFAULT = 50;
export const REVEAL_LABEL = "Reveal later photo";

/** A reveal percentage as a whole number in 0..100 (default when not a number). */
export function clampReveal(v: number): number {
  if (!Number.isFinite(v)) return REVEAL_DEFAULT;
  return Math.min(100, Math.max(0, Math.round(v)));
}

/** CSS clip-path that shows the left `reveal` percent of the top photo. */
export const revealClip = (reveal: number) => `inset(0 ${100 - clampReveal(reveal)}% 0 0)`;

/** Reveal percentage for a pointer at `x` over a box starting at `left` with `width`. */
export function revealAt(x: number, left: number, width: number): number {
  if (!(width > 0)) return REVEAL_DEFAULT;
  return clampReveal(((x - left) / width) * 100);
}

/** The pair oldest first: [before, after]. */
export function orderPair<T extends { taken_at: string }>(a: T, b: T): [T, T] {
  return a.taken_at.localeCompare(b.taken_at) <= 0 ? [a, b] : [b, a];
}

export function CompareSlider({ a, b, initial = REVEAL_DEFAULT }: { a: PhotoRow; b: PhotoRow; initial?: number }) {
  const [before, after] = orderPair(a, b);
  const [reveal, setReveal] = useState(() => clampReveal(initial));
  const dragging = useRef(false);

  const fromPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setReveal(revealAt(e.clientX, r.left, r.width));
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3 p-2">
      <div
        className="relative flex-1 min-h-0 rounded-xl overflow-hidden bg-surface-2 select-none touch-none"
        data-testid="compare-slider-stage"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          fromPointer(e);
        }}
        onPointerMove={(e) => {
          if (dragging.current) fromPointer(e);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        <Photo p={before} className="absolute inset-0 size-full" />
        <div className="absolute inset-0" style={{ clipPath: revealClip(reveal) }} data-testid="compare-slider-top">
          <Photo p={after} className="size-full" />
        </div>
        <div className="absolute inset-y-0 w-0.5 -ml-px bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)] pointer-events-none" style={{ left: `${reveal}%` }} aria-hidden="true" />
        <span className="absolute top-2 left-2 bg-black/55 text-white text-[10px] px-1.5 py-1 rounded">{dateLabel(after.taken_at)}</span>
        <span className="absolute top-2 right-2 bg-black/55 text-white text-[10px] px-1.5 py-1 rounded">{dateLabel(before.taken_at)}</span>
      </div>
      <label className="flex flex-col gap-1 text-xs text-muted">
        <span>{REVEAL_LABEL}</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={reveal}
          aria-label={REVEAL_LABEL}
          aria-valuetext={`${reveal}% of ${dateLabel(after.taken_at)} over ${dateLabel(before.taken_at)}`}
          className="w-full accent-accent"
          onChange={(e) => setReveal(clampReveal(Number(e.target.value)))}
        />
      </label>
    </div>
  );
}

export function PhotosTab() {
  const photos = useLiveQuery(async () => (await db.photos.toArray()).sort((a, b) => b.taken_at.localeCompare(a.taken_at)), []);
  const input = useRef<HTMLInputElement>(null);
  const [pose, setPose] = useState<Pose | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<PhotoRow | null>(null);
  const [comparing, setComparing] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [showCompare, setShowCompare] = useState(false);
  const [compareMode, setCompareMode] = useState<CompareMode>("side");
  const { unit } = useSettings();

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        await db.photos.put({ id: uuid(), taken_at: new Date().toISOString(), pose, blob: await shrink(f) });
      }
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  if (!photos) return null;
  const pair = picked.map((id) => photos.find((p) => p.id === id)).filter((p): p is PhotoRow => !!p);

  return (
    <>
      <div className="flex items-center gap-2 mb-3 overflow-x-auto no-scrollbar">
        <span className="text-xs text-muted shrink-0">Pose</span>
        {POSES.map((p) => (
          <button key={p.v} className={pose === p.v ? "chip-on" : "chip"} onClick={() => setPose(pose === p.v ? null : p.v)}>
            {p.label}
          </button>
        ))}
      </div>

      <input ref={input} type="file" accept="image/*" multiple className="hidden" onChange={(e) => onFiles(e.target.files)} />

      {photos.length === 0 && <p className="text-sm text-muted mb-3">Add your first progress photo.</p>}
      <div className="grid grid-cols-3 gap-2">
        <button
          className="aspect-[3/4] rounded-xl border border-dashed border-border grid place-items-center text-muted"
          onClick={() => input.current?.click()}
          disabled={busy}
        >
          <span className="text-center">
            <span className="block text-2xl leading-none">{busy ? "…" : "+"}</span>
            <span className="text-xs">Add</span>
          </span>
        </button>
        {photos.map((p) => {
          const sel = picked.includes(p.id);
          return (
            <button
              key={p.id}
              className={`relative aspect-[3/4] rounded-xl overflow-hidden ${sel ? "ring-2 ring-accent ring-offset-2" : ""}`}
              onClick={() => (comparing ? setPicked(sel ? picked.filter((x) => x !== p.id) : [...picked, p.id].slice(-2)) : setView(p))}
            >
              <Photo p={p} className="size-full" />
              <span className="absolute bottom-0 inset-x-0 bg-black/55 text-white text-[10px] px-1.5 py-1 text-left">
                {dateLabel(p.taken_at)}
                {p.pose ? ` · ${p.pose}` : ""}
              </span>
            </button>
          );
        })}
      </div>

      {photos.length > 1 && (
        <div className="mt-4 flex gap-2">
          <button className="btn-ghost flex-1" onClick={() => { setComparing(!comparing); setPicked([]); }}>
            {comparing ? "Cancel compare" : "Compare two photos"}
          </button>
          {comparing && (
            <button className="btn-primary flex-1" disabled={pair.length !== 2} onClick={() => setShowCompare(true)}>
              Compare ({pair.length}/2)
            </button>
          )}
        </div>
      )}
      {photos.length > 0 && <MonthlyAnalysis photos={photos} unit={unit} />}
      <p className="text-xs text-muted mt-4">Photos stay on this device for now. Cloud backup comes with the online setup.</p>

      {view && (
        <div className="fixed inset-0 z-[60] bg-black flex flex-col" onClick={() => setView(null)}>
          <div className="flex items-center justify-between p-4 pt-safe text-white">
            <span className="text-sm">{dateLabel(view.taken_at)}{view.pose ? ` · ${view.pose}` : ""}</span>
            {(view as ProgressPhotoRow).workout_id && (
              <Link
                href={`/history/${(view as ProgressPhotoRow).workout_id}`}
                className="text-sm underline"
                onClick={(e) => e.stopPropagation()}
              >
                View workout
              </Link>
            )}
            <button
              className="text-sm"
              onClick={async (e) => {
                e.stopPropagation();
                if (confirm("Delete this photo?")) {
                  await db.photos.delete(view.id);
                  // Remove the cloud backup copy too (no-op when not synced).
                  await queuePhotoDelete(view.id);
                  setView(null);
                }
              }}
            >
              Delete
            </button>
          </div>
          <div className="flex-1 min-h-0 grid place-items-center p-2">
            <Photo p={view} className="max-h-full max-w-full object-contain" />
          </div>
        </div>
      )}

      {showCompare && pair.length === 2 && (
        <div className="fixed inset-0 z-[60] bg-bg flex flex-col">
          <div className="flex items-center justify-between p-4 pt-safe">
            <h2 className="font-semibold">Compare</h2>
            <button className="text-sm" onClick={() => { setShowCompare(false); setComparing(false); setPicked([]); setCompareMode("side"); }}>Close</button>
          </div>
          <div className="px-4 pb-2">
            <Segmented options={COMPARE_MODES} value={compareMode} onChange={setCompareMode} />
          </div>
          {compareMode === "slider" ? (
            <CompareSlider a={pair[0]} b={pair[1]} />
          ) : (
          <div className="flex-1 min-h-0 grid grid-cols-2 gap-2 p-2">
            {[...pair].sort((a, b) => a.taken_at.localeCompare(b.taken_at)).map((p) => (
              <div key={p.id} className="flex flex-col min-h-0">
                <Photo p={p} className="flex-1 min-h-0 w-full rounded-xl" />
                <p className="text-xs text-center mt-1 text-muted">{dateLabel(p.taken_at)}</p>
              </div>
            ))}
          </div>
          )}
        </div>
      )}
    </>
  );
}
