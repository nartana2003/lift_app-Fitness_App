"use client";

// A saved mini workout (routine kind "mini") as a card in "My Routines": the
// video thumbnail (or a plain placeholder), a text platform label (no brand
// artwork), the creator and a link to the original video. Also the pure
// filter helpers the routine list uses for its platform and muscle chips.
import Link from "next/link";
import type { RoutineRow } from "@/lib/offline/db";

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

/** Thumbnails load from https only, so a page served over https never mixes content. */
export function safeThumbnailUrl(raw: string | null | undefined): string | null {
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
    </article>
  );
}
