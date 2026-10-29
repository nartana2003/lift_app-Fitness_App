"use client";

import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { useCatalogue } from "@/lib/catalogue";
import { allWorkouts, type WorkoutDetail } from "@/lib/history";
import { exerciseCaption, exerciseThumb, recordsByWorkout } from "@/lib/homeFeed";
import { formatDuration, startOfWeek } from "@/lib/stats";
import { useSettings } from "@/lib/settings";
import { fmtVolume } from "@/lib/units";

/** Finished workouts, newest first, grouped by week. Lives on the Home screen. */
export function HistoryList() {
  const { get } = useCatalogue();
  const { unit, weekStart } = useSettings();
  // All of history so records compare against every earlier workout; the list shows the last 400 days.
  const all = useLiveQuery(() => allWorkouts(), []);

  if (!all) return null;

  const records = recordsByWorkout(all);
  const since = new Date(Date.now() - 400 * 864e5).toISOString();
  const workouts = all.filter((w) => w.started_at >= since);

  const weeks = new Map<string, WorkoutDetail[]>();
  for (const w of workouts) {
    const k = startOfWeek(new Date(w.started_at), weekStart).toISOString();
    weeks.set(k, [...(weeks.get(k) ?? []), w]);
  }

  return (
    <section className="mt-6">
      <h2 className="text-lg font-bold mb-3">My History</h2>
      {[...weeks.entries()].map(([wk, ws]) => (
        <div key={wk} className="mb-5">
          <h3 className="text-xs uppercase tracking-wide text-muted mb-2">
            Week of {new Date(wk).toLocaleDateString(undefined, { day: "numeric", month: "short" })} · {ws.length}{" "}
            workout{ws.length > 1 ? "s" : ""}
          </h3>
          <ul className="space-y-2">
            {ws.map((w) => {
              const start = new Date(w.started_at);
              const dur = (Date.parse(w.ended_at!) - start.getTime()) / 1000;
              return (
                <li key={w.id}>
                  <Link href={`/history/${w.id}`} className="card block p-4">
                    <p className="font-semibold">{w.notes || start.toLocaleDateString(undefined, { weekday: "long" })}</p>
                    <p className="text-xs text-muted mt-0.5">
                      {start.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} ·{" "}
                      {start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                    </p>
                    <div className="flex gap-6 mt-3">
                      <div>
                        <p className="text-[11px] text-muted">Duration</p>
                        <p className="text-sm font-semibold">{formatDuration(dur)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-muted">Volume</p>
                        <p className="text-sm font-semibold">{fmtVolume(w.volume, unit)}</p>
                      </div>
                      <div className="ml-auto text-right">
                        <p className="text-[11px] text-muted">Records</p>
                        <p className="text-sm font-semibold inline-flex items-center gap-1">
                          <TrophyIcon />
                          {records.get(w.id) ?? 0}
                        </p>
                      </div>
                    </div>
                    {w.exercises.length > 0 && (
                      <ul className="grid grid-cols-3 gap-x-2 gap-y-3 mt-4">
                        {w.exercises.map((e) => {
                          const info = get(e.exercise_id);
                          const name = info?.name ?? e.exercise_id;
                          const thumb = exerciseThumb(info?.image_urls, name);
                          return (
                            <li key={e.id} className="flex flex-col items-center text-center">
                              {thumb.kind === "image" ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={thumb.src}
                                  alt={name}
                                  loading="lazy"
                                  className="size-16 rounded-full object-cover bg-white border border-border"
                                />
                              ) : (
                                <span
                                  aria-hidden
                                  className="size-16 rounded-full bg-surface-2 text-muted flex items-center justify-center text-xl font-semibold"
                                >
                                  {thumb.letter}
                                </span>
                              )}
                              <p className="text-[11px] text-muted mt-1 line-clamp-2">{exerciseCaption(e.sets, name)}</p>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

function TrophyIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z" />
      <path d="M17 6h3v1a3 3 0 0 1-3 3M7 6H4v1a3 3 0 0 0 3 3" />
    </svg>
  );
}
