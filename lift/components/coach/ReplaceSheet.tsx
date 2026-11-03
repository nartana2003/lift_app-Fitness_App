"use client";

// The per-exercise menu: Replace, Equipment unavailable, Too difficult, Causes
// discomfort, I don't like this, and Why is this exercise here. Swaps one exercise
// for another that trains the same muscle; it never regenerates anything else.
// Rule-based alternatives always show; the swap-exercise route adds Coach picks
// when it answers. The user's limits, never-suggest list and equipment apply to both.
import { useState } from "react";
import { ExerciseDemo } from "../ExerciseDemo";
import { useAiSwap } from "../workout/SwapSheet";
import { EvidenceList } from "./EvidenceList";
import { useCatalogue } from "@/lib/catalogue";
import { equipmentForAi, useEquipment } from "@/lib/equipment";
import type { Exercise } from "@/lib/exercises";
import { dislikeExercise, useGoals } from "@/lib/goals";
import { allowedFor, LIMITATION_NOTE } from "@/lib/limitations";
import { evidenceFor } from "@/lib/evidence/library";
import { REPLACE_REASONS, replaceOptions } from "@/lib/coachReplace";
import type { SwapReason } from "@/lib/swap";

export function ReplaceSheet({
  current,
  why,
  evidenceIds = [],
  exclude = [],
  onPick,
  onClose,
}: {
  current: Exercise;
  /** Why the exercise is in the plan (a Coach change's reason). Left out: a plain line. */
  why?: string;
  evidenceIds?: readonly string[];
  /** Ids already in the plan; never offered. */
  exclude?: readonly string[];
  onPick: (e: Exercise) => void;
  onClose: () => void;
}) {
  const { exercises, get } = useCatalogue();
  const goals = useGoals();
  const equipment = equipmentForAi(useEquipment());
  const [reason, setReason] = useState<SwapReason>("variety");
  const [showWhy, setShowWhy] = useState(false);
  const [noted, setNoted] = useState(false);
  const ai = useAiSwap(current.id, reason);

  const opts = { equipment, exclude, dislikedIds: goals.dislikedIds, limitations: goals.limitations };
  const { options, emptied } = replaceOptions(exercises, current, reason, opts);

  // Coach picks come from a route that does not know the limits or the never-suggest list.
  const skip = new Set([current.id, ...exclude, ...goals.dislikedIds]);
  const picks = (ai.picks ?? []).flatMap((p) => {
    const e = get(p.exercise_id);
    return e && !skip.has(e.id) && allowedFor(e, goals.limitations) ? [{ e, reason: p.reason }] : [];
  });

  const own = evidenceFor({ exerciseId: current.id }).map((e) => e.id);
  const whyText = why ?? `${current.name} trains ${current.muscle_groups.join(", ").toLowerCase()}.`;

  const row = (e: Exercise, extra?: string, tone = "bg-surface-2") => (
    <li key={e.id}>
      <button className={`w-full flex items-start gap-3 rounded-xl ${tone} p-2.5 text-left`} onClick={() => onPick(e)}>
        <ExerciseDemo urls={e.image_urls.slice(0, 1)} alt={e.name} small />
        <span className="flex-1 min-w-0">
          <span className="block font-medium text-sm truncate">{e.name}</span>
          <span className="block text-xs text-muted truncate">
            {e.equipment} · {e.muscle_groups.join(", ")}
          </span>
          {extra && <span className="block text-xs mt-0.5">{extra}</span>}
        </span>
      </button>
    </li>
  );

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-end" onClick={onClose}>
      <div
        role="dialog"
        aria-label={`Replace ${current.name}`}
        className="w-full max-w-lg mx-auto card rounded-b-none p-5 pb-safe max-h-[85dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Replace {current.name}</h2>
        <p className="text-xs text-muted mb-3">{current.muscle_groups.join(", ")}</p>

        <div className="flex flex-wrap gap-1.5 mb-3" role="group" aria-label="Why replace">
          {REPLACE_REASONS.map((r) => (
            <button key={r.v} className={reason === r.v ? "chip-on text-xs" : "chip text-xs"} aria-pressed={reason === r.v} onClick={() => setReason(r.v)}>
              {r.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-1.5 mb-3">
          <button
            className="chip text-xs"
            disabled={noted}
            onClick={async () => {
              await dislikeExercise(current.id);
              setNoted(true);
            }}
          >
            I don&apos;t like this
          </button>
          <button className={showWhy ? "chip-on text-xs" : "chip text-xs"} aria-expanded={showWhy} onClick={() => setShowWhy(!showWhy)}>
            Why is this exercise here?
          </button>
        </div>
        {noted && <p className="text-xs text-muted mb-3">Noted. {current.name} will not be suggested again. Pick a replacement below.</p>}

        {showWhy && (
          <section aria-label="Why this exercise" className="mb-4 space-y-2">
            <p className="text-sm">{whyText}</p>
            <EvidenceList ids={[...evidenceIds, ...own]} />
          </section>
        )}

        {ai.loading && <p className="text-xs text-muted mb-3">Ranking alternatives…</p>}
        {picks.length > 0 && (
          <section aria-label="Coach picks" className="mb-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">Coach picks</h3>
            <ul className="space-y-2">{picks.map((p) => row(p.e, p.reason, "border border-border"))}</ul>
          </section>
        )}

        <ul className="space-y-2" aria-label="Alternatives">
          {options.map((e, i) => row(e, i === 0 ? "Top pick" : undefined))}
          {options.length === 0 && (
            <li className="text-sm text-muted">
              {emptied ? "Your limits and never-suggest list leave no alternative for this exercise. Adjust them in Goals." : "No alternatives found."}
            </li>
          )}
        </ul>
        {goals.limitations.length > 0 && <p className="text-xs text-muted mt-3">{LIMITATION_NOTE}</p>}

        <button className="btn-ghost w-full mt-3" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
