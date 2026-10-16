"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { EQUIPMENT, MUSCLE_GROUPS, type MuscleGroup } from "@/lib/muscles";
import { searchExercises, type Exercise } from "@/lib/exercises";
import { toggleFavorite, useFavorites } from "@/lib/favorites";
import { MuscleIcon } from "./MuscleIcon";

export const FAVORITES = "Favorites";

/**
 * Search + horizontally scrolling muscle row + filter sheet + 2-column card grid.
 * Browse mode: cards open the exercise page. Pick mode (`onPick`): cards toggle selection.
 */
export function ExerciseBrowser({
  exercises,
  muscle,
  onMuscle,
  onPick,
  picked = [],
}: {
  exercises: Exercise[];
  muscle?: string;
  onMuscle: (m: string | undefined) => void;
  onPick?: (e: Exercise) => void;
  picked?: string[];
}) {
  const favorites = useFavorites();
  const [q, setQ] = useState("");
  const [equip, setEquip] = useState<string[]>([]);
  const [sheet, setSheet] = useState(false);

  const results = useMemo(() => {
    const isFav = muscle === FAVORITES;
    let list = searchExercises(exercises, { muscle: isFav ? undefined : muscle, equipment: equip, q });
    if (isFav) list = list.filter((e) => favorites.includes(e.id));
    return list;
  }, [exercises, muscle, equip, q, favorites]);

  const filterCount = equip.length;

  return (
    <div>
      <div className="relative">
        <input
          className="field rounded-full pl-4 pr-10 py-3"
          placeholder="Search for exercises"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <svg viewBox="0 0 24 24" className="size-5 absolute right-4 top-1/2 -translate-y-1/2 text-muted" fill="none" stroke="currentColor" strokeWidth={2}>
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
        </svg>
      </div>

      {/* Muscle group scroller with pinned Filters button */}
      <div className="flex items-stretch mt-3 -mx-4">
        <div className="flex gap-1 overflow-x-auto no-scrollbar pl-4 pr-2 flex-1 snap-x">
          <MuscleTab label={FAVORITES} active={muscle === FAVORITES} onClick={() => onMuscle(muscle === FAVORITES ? undefined : FAVORITES)}>
            <svg viewBox="0 0 24 24" className="size-7" fill={muscle === FAVORITES ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.8}>
              <path d="M6 3h12v18l-6-4-6 4z" strokeLinejoin="round" />
            </svg>
          </MuscleTab>
          {MUSCLE_GROUPS.map((m) => (
            <MuscleTab key={m} label={shortName(m)} active={muscle === m} onClick={() => onMuscle(muscle === m ? undefined : m)}>
              <MuscleIcon muscle={m as MuscleGroup} className="h-16" />
            </MuscleTab>
          ))}
        </div>
        <button
          onClick={() => setSheet(true)}
          className="relative shrink-0 mr-4 pl-2 border-l border-border flex flex-col items-center justify-center gap-1 text-[11px] text-muted"
        >
          <span className="grid place-items-center size-11 rounded-xl bg-surface-2 border border-border text-text">
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
              <circle cx="16" cy="7" r="2" />
              <circle cx="10" cy="17" r="2" />
            </svg>
          </span>
          Filters
          {filterCount > 0 && (
            <span className="absolute -top-1 right-0 size-4 rounded-full bg-accent text-accent-ink text-[10px] font-bold grid place-items-center">
              {filterCount}
            </span>
          )}
        </button>
      </div>

      <p className="text-xs text-muted mt-3 mb-2">
        {results.length} exercise{results.length === 1 ? "" : "s"}
        {muscle && <> · {muscle}</>}
      </p>

      {muscle === FAVORITES && results.length === 0 && (
        <p className="card p-4 text-sm text-muted">Tap the bookmark on any exercise to save it here.</p>
      )}

      <ul className="grid grid-cols-2 gap-3">
        {results.slice(0, 120).map((e) => (
          <li key={e.id}>
            <ExerciseCard
              e={e}
              fav={favorites.includes(e.id)}
              selected={picked.includes(e.id)}
              onPick={onPick}
            />
          </li>
        ))}
      </ul>
      {results.length > 120 && <p className="text-center text-xs text-muted py-4">Search or pick a muscle to see more…</p>}

      {sheet && (
        <FilterSheet
          equip={equip}
          setEquip={setEquip}
          onClose={() => setSheet(false)}
        />
      )}
    </div>
  );
}

function shortName(m: string) {
  return m === "Hips/Adductors/Abductors" ? "Hips" : m === "Abs/Core" ? "Abs" : m;
}

function MuscleTab({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} className="snap-start shrink-0 w-[72px] flex flex-col items-center gap-1 py-1">
      <span
        className={`grid place-items-center h-[76px] w-16 rounded-2xl border transition ${
          active ? "border-accent bg-accent/10 text-accent" : "border-border bg-surface text-text"
        }`}
      >
        {children}
      </span>
      <span className={`text-[11px] leading-tight ${active ? "text-accent font-semibold" : "text-muted"}`}>{label}</span>
    </button>
  );
}

function ExerciseCard({
  e,
  fav,
  selected,
  onPick,
}: {
  e: Exercise;
  fav: boolean;
  selected: boolean;
  onPick?: (e: Exercise) => void;
}) {
  const body = (
    <>
      <div className="relative aspect-square bg-white">
        {e.image_urls[0] && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={e.image_urls[0]} alt={`${e.name} demonstration`} loading="lazy" className="size-full object-cover" />
        )}
        {selected && (
          <span className="absolute inset-0 bg-accent/30 grid place-items-center">
            <span className="size-10 rounded-full bg-accent text-accent-ink grid place-items-center text-xl font-bold">✓</span>
          </span>
        )}
      </div>
      <div className="p-2.5">
        <h3 className="font-semibold text-sm leading-tight line-clamp-2">{e.name}</h3>
        <p className="text-xs text-muted mt-0.5 line-clamp-1">{e.muscle_groups.join(", ")}</p>
      </div>
    </>
  );

  return (
    <div className={`card overflow-hidden relative h-full ${selected ? "border-accent" : ""}`}>
      {onPick ? (
        <button className="block w-full text-left" onClick={() => onPick(e)}>
          {body}
        </button>
      ) : (
        <Link href={`/exercises/${e.id}`} className="block">
          {body}
        </Link>
      )}
      <button
        onClick={() => toggleFavorite(e.id)}
        className="absolute top-1.5 left-1.5 size-8 grid place-items-center rounded-full bg-white/90 text-text shadow-sm"
        aria-label={fav ? "Remove from favorites" : "Add to favorites"}
      >
        <svg viewBox="0 0 24 24" className="size-4" fill={fav ? "var(--accent)" : "none"} stroke={fav ? "var(--accent)" : "currentColor"} strokeWidth={2}>
          <path d="M6 3h12v18l-6-4-6 4z" strokeLinejoin="round" />
        </svg>
      </button>
      {onPick && (
        <Link
          href={`/exercises/${e.id}`}
          className="absolute top-1.5 right-1.5 size-8 grid place-items-center rounded-full bg-white/90 text-text shadow-sm text-sm font-bold"
          aria-label="View exercise details"
        >
          ?
        </Link>
      )}
    </div>
  );
}

function FilterSheet({
  equip,
  setEquip,
  onClose,
}: {
  equip: string[];
  setEquip: (v: string[]) => void;
  onClose: () => void;
}) {
  const toggle = (e: string) => setEquip(equip.includes(e) ? equip.filter((x) => x !== e) : [...equip, e]);
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-end" onClick={onClose}>
      <div className="w-full max-w-lg mx-auto card rounded-b-none p-5 pb-safe" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border" />
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Filters</h2>
          <button className="text-muted text-xl" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <h3 className="text-xs uppercase tracking-wide text-muted mb-2">Equipment</h3>
        <div className="flex flex-wrap gap-2 mb-6">
          {EQUIPMENT.map((e) => (
            <button key={e} className={equip.includes(e) ? "chip-on" : "chip"} onClick={() => toggle(e)}>
              {e}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button className="btn-ghost" onClick={() => setEquip([])}>Clear all</button>
          <button className="btn-primary" onClick={onClose}>Apply</button>
        </div>
      </div>
    </div>
  );
}
