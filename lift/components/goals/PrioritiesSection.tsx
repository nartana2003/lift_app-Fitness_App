"use client";

// Priorities and limits (Coach): your goals in order, how much each muscle matters,
// injuries to work around and exercises never to suggest. Everything saves as you go
// and powers Build and Optimise, so it is set once.
import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/offline/db";
import { useCatalogue } from "@/lib/catalogue";
import { MAX_RANKED_GOALS, normalizeGoals, PRIORITY_LABELS, saveGoals, setPriority, toggleLimitation, undislikeExercise, useGoals, type Goals, type Priority } from "@/lib/goals";
import { LIMITATIONS, LIMITATION_NOTE } from "@/lib/limitations";
import { MUSCLE_GROUPS } from "@/lib/muscles";

/** Longest typed goal, the same as the Coach setup box. */
export const MAX_GOAL_TEXT = 300;

const pad = (goals: readonly string[]) => Array.from({ length: MAX_RANKED_GOALS }, (_, i) => goals[i] ?? "");

export function PrioritiesSection() {
  const goals = useGoals();
  const { get } = useCatalogue();

  // The typed goals are edited locally and saved when a box loses focus. They are read
  // from storage once, so a save never overwrites what is being typed in another box.
  const stored = useLiveQuery(async () => ((await db.meta.get("goals"))?.value as Partial<Goals> | undefined) ?? null, []);
  const [draft, setDraft] = useState<string[]>(pad([]));
  const ready = useRef(false);
  useEffect(() => {
    if (stored === undefined || ready.current) return;
    ready.current = true;
    setDraft(pad(normalizeGoals(stored ?? undefined).rankedGoals));
  }, [stored]);

  return (
    <div className="space-y-4">
      <section aria-label="Your goals in order">
        <p className="text-sm font-semibold mb-1">Your goals, most important first</p>
        <div className="space-y-2">
          {draft.map((text, i) => (
            <input
              key={i}
              className="field py-2 text-sm"
              aria-label={`Goal ${i + 1}`}
              maxLength={MAX_GOAL_TEXT}
              placeholder={i === 0 ? "e.g. Bigger arms" : i === 1 ? "e.g. Defined abs" : "e.g. A wider back"}
              value={text}
              onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? e.target.value.slice(0, MAX_GOAL_TEXT) : x)))}
              onBlur={() => void saveGoals({ rankedGoals: draft })}
            />
          ))}
        </div>
      </section>

      <section aria-label="Muscle priorities">
        <p className="text-sm font-semibold mb-1">How much each muscle matters</p>
        <p className="text-xs text-muted mb-2">High priority muscles get more sets and more days. Leave a muscle on None for the default.</p>
        <ul className="space-y-1.5">
          {MUSCLE_GROUPS.map((m) => (
            <li key={m} className="flex items-center justify-between gap-2">
              <label htmlFor={`priority-${m}`} className="text-sm">
                {m}
              </label>
              <select id={`priority-${m}`} className="field py-1 px-2 text-sm w-32" value={goals.priorities[m] ?? ""} onChange={(e) => void setPriority(m, (e.target.value || null) as Priority | null)}>
                <option value="">None</option>
                {(Object.keys(PRIORITY_LABELS) as Priority[]).reverse().map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABELS[p]}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Limits">
        <p className="text-sm font-semibold mb-1">Anything to work around?</p>
        <div className="flex flex-wrap gap-1.5">
          {LIMITATIONS.map((l) => {
            const on = goals.limitations.includes(l);
            return (
              <button key={l} type="button" aria-pressed={on} className={on ? "chip-on text-xs" : "chip text-xs"} onClick={() => void toggleLimitation(l)}>
                {l}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted mt-2">The Coach leaves out exercises that load these areas. {LIMITATION_NOTE}</p>
      </section>

      <section aria-label="Never suggest">
        <p className="text-sm font-semibold mb-1">Never suggest</p>
        {goals.dislikedIds.length === 0 ? (
          <p className="text-xs text-muted">Nothing yet. Use I don&apos;t like this in an exercise menu to add one.</p>
        ) : (
          <ul className="space-y-1.5">
            {goals.dislikedIds.map((id) => {
              const name = get(id)?.name ?? id;
              return (
                <li key={id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate">{name}</span>
                  <button type="button" className="chip text-xs shrink-0" aria-label={`Allow ${name} again`} onClick={() => void undislikeExercise(id)}>
                    Allow
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
