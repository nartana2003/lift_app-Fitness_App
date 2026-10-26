"use client";

// A saved mini workout (routine kind "mini") as a card in "My Routines": the
// video thumbnail (or a plain placeholder), a text platform label (no brand
// artwork), the creator and a link to the original video. Also the pure
// filter helpers the routine list uses for its platform and muscle chips.
import Link from "next/link";
import { useState } from "react";
import type { RoutineRow } from "@/lib/offline/db";
import { dayKey, getDay, planDay, routineUsedOnOtherDay } from "@/lib/planner";
import { createRoutine, getRoutine, updateRoutine } from "@/lib/routines";
import { addExercises, getActive } from "@/lib/workout";

export type Platform = NonNullable<RoutineRow["platform"]>;

/** Platforms in chip order. */
export const PLATFORMS = ["tiktok", "instagram", "youtube"] as const satisfies readonly Platform[];
// Compile-time check the other way: every platform the row type allows has a chip.
const allPlatformsListed: [Exclude<Platform, (typeof PLATFORMS)[number]>] extends [never] ? true : false = true;
void allPlatformsListed;

const PLATFORM_LABELS: Record<Platform, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
};

/** Plain text platform name, or null for none or an unknown value. */
export function platformLabel(p: RoutineRow["platform"] | string | null | undefined): string | null {
  return typeof p === "string" && Object.prototype.hasOwnProperty.call(PLATFORM_LABELS, p)
    ? PLATFORM_LABELS[p as Platform]
    : null;
}

/** The URL if it is an absolute http(s) link, else null (no javascript:, data: and the like). */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Thumbnails load from https (so a page served over https never mixes content) or are a stored cover data URL. */
export function safeThumbnailUrl(raw: string | null | undefined): string | null {
  if (typeof raw === "string" && raw.length <= 300_000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(raw)) return raw;
  const u = safeHttpUrl(raw);
  return u && u.startsWith("https:") ? u : null;
}

export type RoutineFilter = { platform: Platform | null; muscle: string | null };

export const NO_FILTER: RoutineFilter = { platform: null, muscle: null };

/**
 * Routines that pass the filter, in their original order. A platform filter
 * keeps only routines saved from that platform; a muscle filter keeps routines
 * with at least one exercise for that muscle. Never changes the input.
 */
export function filterRoutines<R extends Pick<RoutineRow, "platform">>(
  routines: readonly R[],
  filter: RoutineFilter,
  musclesOf: (r: R) => readonly string[],
): R[] {
  return routines.filter(
    (r) =>
      (filter.platform === null || r.platform === filter.platform) &&
      (filter.muscle === null || musclesOf(r).includes(filter.muscle)),
  );
}

/** Platforms present among the routines, in chip order. */
export function platformsIn(routines: readonly Pick<RoutineRow, "platform">[]): Platform[] {
  return PLATFORMS.filter((p) => routines.some((r) => r.platform === p));
}

/** Muscles present among the routines, sorted by name. */
export function musclesIn<R>(routines: readonly R[], musclesOf: (r: R) => readonly string[]): string[] {
  return [...new Set(routines.flatMap((r) => [...musclesOf(r)]))].sort((a, b) => a.localeCompare(b));
}

export const ADD_MESSAGES = {
  empty: "This mini workout has no exercises.",
  workout: "Added to your current workout.",
  inWorkout: "Already in your current workout.",
  closed: "Today's workout is already done, skipped or moved.",
  already: "Already planned for today.",
  planned: "Planned for today.",
} as const;

/**
 * Notes prefix marking a routine as a copy addMiniToToday made for today's
 * plan. Later adds on a day planned with such a copy go into it (updateRoutine)
 * instead of making another copy.
 */
export const TODAY_COPY_NOTE = "Today's plan:";

export const isTodayCopy = (r: Pick<RoutineRow, "notes">) =>
  typeof r.notes === "string" && r.notes.startsWith(TODAY_COPY_NOTE);

/**
 * "Add to today's workout" for a mini workout, local-first, with the existing
 * workout and planner helpers:
 * - a workout in progress: its exercises are appended with addExercises
 *   (exercises already in the workout are skipped);
 * - today planned with a routine: a copy of that routine plus the mini's
 *   exercises is planned today instead, so the saved routine never changes.
 *   The copy is marked with TODAY_COPY_NOTE; when today's routine is already
 *   such a copy, the mini's new exercises are appended to it, so repeated adds
 *   never pile up copies. A copy another day also uses is never changed in
 *   place: a fresh copy is made for today instead;
 * - nothing planned today: the mini workout itself is planned today.
 * A day already done, skipped or moved is left alone. Returns a plain message.
 */
export async function addMiniToToday(routineId: string, now = new Date()): Promise<string> {
  const mini = await getRoutine(routineId);
  if (!mini || mini.exercises.length === 0) return ADD_MESSAGES.empty;

  const active = await getActive();
  if (active) {
    const have = new Set(active.exercises.map((e) => e.exercise_id));
    const ids = [...new Set(mini.exercises.map((e) => e.exercise_id))].filter((id) => !have.has(id));
    if (ids.length === 0) return ADD_MESSAGES.inWorkout;
    await addExercises(ids);
    return ADD_MESSAGES.workout;
  }

  const today = dayKey(now);
  const planned = await getDay(today);
  if (planned && planned.status !== "planned") return ADD_MESSAGES.closed;
  if (planned?.routine_id === mini.id) return ADD_MESSAGES.already;
  const base = planned?.routine_id ? await getRoutine(planned.routine_id) : undefined;
  if (base) {
    const have = new Set(base.exercises.map((e) => e.exercise_id));
    const extra = mini.exercises
      .filter((e, i, all) => !have.has(e.exercise_id) && all.findIndex((x) => x.exercise_id === e.exercise_id) === i)
      .map((e) => ({ exercise_id: e.exercise_id, target_sets: e.target_sets, target_reps: e.target_reps }));
    if (extra.length === 0) return ADD_MESSAGES.already;
    const exercises = [
      ...base.exercises.map((e) => ({ exercise_id: e.exercise_id, target_sets: e.target_sets, target_reps: e.target_reps })),
      ...extra,
    ];
    const name = `${base.name} + ${mini.name}`;
    // Reuse the marked copy only if no other day uses it, so another day's plan never changes.
    if (isTodayCopy(base) && !(await routineUsedOnOtherDay(base.id, today))) {
      await updateRoutine(base.id, { name, notes: `${TODAY_COPY_NOTE} ${name}`, exercises });
      return `Added to ${base.name} today.`;
    }
    const id = await createRoutine({ name, notes: `${TODAY_COPY_NOTE} ${name}`, exercises });
    await planDay(today, id);
    return `Added to ${base.name} today.`;
  }
  await planDay(today, mini.id);
  return ADD_MESSAGES.planned;
}

type Props = {
  routine: Pick<RoutineRow, "id" | "name" | "platform" | "creator" | "source_url" | "thumbnail_url">;
  exerciseCount: number;
  muscles: readonly string[];
  busy?: boolean;
  onStart?: () => void;
};

/** One mini workout in the routines row. */
export function MiniWorkoutCard({ routine, exerciseCount, muscles, busy = false, onStart }: Props) {
  const platform = platformLabel(routine.platform);
  const href = safeHttpUrl(routine.source_url);
  const thumb = safeThumbnailUrl(routine.thumbnail_url);
  const creator = routine.creator?.trim() || null;
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function addToToday() {
    if (adding) return;
    setAdding(true);
    try {
      setNotice(await addMiniToToday(routine.id));
    } catch {
      setNotice("Could not add this mini workout. Try again.");
    } finally {
      setAdding(false);
    }
  }

  return (
    <article className="card h-full p-3 flex flex-col" aria-label={`Mini workout: ${routine.name}`}>
      <div className="aspect-video rounded-lg overflow-hidden bg-surface-2 mb-2">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb}
            alt={`${routine.name} video thumbnail`}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="size-full object-cover"
          />
        ) : (
          <div className="size-full grid place-items-center text-xs text-muted" data-testid="mini-thumb-placeholder">
            Mini workout
          </div>
        )}
      </div>
      <div className="flex items-start gap-2">
        <p className="flex-1 font-semibold leading-tight line-clamp-2">{routine.name}</p>
        <Link href={`/routines/${routine.id}`} className="text-muted text-lg leading-none px-1" aria-label="Edit routine">
          ⋯
        </Link>
      </div>
      <p className="text-xs text-muted mt-1">
        {[platform ?? "Mini", creator].filter(Boolean).join(" · ")}
      </p>
      <p className="text-xs text-muted mt-0.5">
        {exerciseCount} exercise{exerciseCount === 1 ? "" : "s"}
      </p>
      <p className="text-xs text-muted mt-0.5 line-clamp-2 flex-1">{muscles.join(", ") || "—"}</p>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-semibold underline mt-1"
        >
          Open original{platform ? ` on ${platform}` : ""}
        </a>
      )}
      {onStart && (
        <button className="btn-primary w-full mt-2 py-2 text-sm" disabled={busy} onClick={onStart}>
          {busy ? "Starting…" : "Start"}
        </button>
      )}
      <button
        type="button"
        className="btn-ghost w-full mt-1.5 py-2 text-xs"
        disabled={adding || busy}
        onClick={addToToday}
      >
        {adding ? "Adding…" : "Add to today's workout"}
      </button>
      <p role="status" className="text-xs text-muted mt-1 empty:hidden">
        {notice}
      </p>
    </article>
  );
}
