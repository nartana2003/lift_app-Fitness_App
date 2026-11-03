"use client";

// The Exercises | Routines switch at the top of the Exercises tab. The view is
// kept in the URL (?view=routines) so the routine editor can send you back to it.

export type LibraryView = "exercises" | "routines";

export const ROUTINES_HREF = "/exercises?view=routines";

/** Anything other than "routines" (missing, empty, unknown) is the Exercises view. */
export function parseLibraryView(param: string | null | undefined): LibraryView {
  return param === "routines" ? "routines" : "exercises";
}

const VIEWS: { id: LibraryView; label: string }[] = [
  { id: "exercises", label: "Exercises" },
  { id: "routines", label: "Routines" },
];

export function LibrarySwitch({ view, onChange }: { view: LibraryView; onChange: (v: LibraryView) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2 mb-3" role="radiogroup" aria-label="Show exercises or routines">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          role="radio"
          aria-checked={view === v.id}
          className={view === v.id ? "chip-on justify-center py-2" : "chip justify-center py-2"}
          onClick={() => view !== v.id && onChange(v.id)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}
