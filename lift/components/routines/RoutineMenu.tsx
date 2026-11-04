"use client";

import Link from "next/link";
import { useState } from "react";
import { deleteRoutine } from "@/lib/routines";
import { toggleFavorite, useFavorites } from "@/lib/favorites";

/** Bookmark and three dots on a routine card: save it to Favorites, or open a sheet to edit or delete it. */
export function RoutineMenu({ id, name }: { id: string; name: string }) {
  const [open, setOpen] = useState(false);
  const fav = useFavorites().includes(id);

  return (
    <>
      <button
        type="button"
        className="text-muted px-1 leading-none"
        aria-label={fav ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
        aria-pressed={fav}
        onClick={() => toggleFavorite(id)}
      >
        <svg viewBox="0 0 24 24" className="size-5" fill={fav ? "var(--accent)" : "none"} stroke={fav ? "var(--accent)" : "currentColor"} strokeWidth={2}>
          <path d="M6 3h12v18l-6-4-6 4z" strokeLinejoin="round" />
        </svg>
      </button>
      <button
        type="button"
        className="text-muted text-lg leading-none px-1"
        aria-label={`Options for ${name}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        ⋯
      </button>
      {open && (
        <div className="fixed inset-0 z-[60] bg-black/40 flex items-end" onClick={() => setOpen(false)}>
          <div
            role="dialog"
            aria-label={`${name} options`}
            className="w-full max-w-lg mx-auto card rounded-b-none p-5 pb-safe space-y-2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-border" />
            <p className="font-semibold truncate mb-1">{name}</p>
            <Link href={`/routines/${id}`} className="btn-ghost w-full" aria-label="Edit routine">
              Edit
            </Link>
            <button
              type="button"
              className="btn-ghost w-full text-bad"
              onClick={async () => {
                if (!confirm("Delete this routine? Your logged workouts aren't affected.")) return;
                await deleteRoutine(id);
                setOpen(false);
              }}
            >
              Delete routine
            </button>
            <button type="button" className="btn-ghost w-full" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
