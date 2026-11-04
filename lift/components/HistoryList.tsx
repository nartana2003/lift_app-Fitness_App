"use client";

import Link from "next/link";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { deleteWorkout } from "@/lib/offline/sync";
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
  const [menuId, setMenuId] = useState<string | null>(null);

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
          <ul className="space-y-2">
            {ws.map((w) => {
              const start = new Date(w.started_at);
              const dur = (Date.parse(w.ended_at!) - start.getTime()) / 1000;
              return (
                <li key={w.id} className="relative">
                  <button
                    className="absolute top-2 right-2 z-10 size-9 grid place-items-center text-muted"
                    aria-label="Workout options"
                    aria-expanded={menuId === w.id}
                    onClick={() => setMenuId(menuId === w.id ? null : w.id)}
                  >
                    <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden>
                      <circle cx="12" cy="5" r="1.8" />
                      <circle cx="12" cy="12" r="1.8" />
                      <circle cx="12" cy="19" r="1.8" />
                    </svg>
                  </button>
                  {menuId === w.id && (
                    <div className="absolute top-11 right-2 z-10 card shadow-md p-1">
                      <button
                        className="flex items-center gap-2 px-3 py-2 text-sm font-semibold text-bad"
                        onClick={async () => {
                          setMenuId(null);
                          if (confirm("Delete this workout permanently?")) await deleteWorkout(w.id);
                        }}
                      >
                        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5L18 7M9 7V4.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V7" />
                        </svg>
                        Delete workout
                      </button>
                    </div>
                  )}
                  <Link href={`/history/${w.id}`} className="card block p-4">
                    <p className="font-semibold pr-8">{w.notes || start.toLocaleDateString(undefined, { weekday: "long" })}</p>
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

export function TrophyIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z" />
      <path d="M17 6h3v1a3 3 0 0 1-3 3M7 6H4v1a3 3 0 0 0 3 3" />
    </svg>
  );
}
