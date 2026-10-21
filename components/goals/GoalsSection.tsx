"use client";

import { useState } from "react";
import { MUSCLE_GROUPS, type MuscleGroup } from "@/lib/muscles";
import {
  allTargets,
  defaultTarget,
  EXPERIENCE_LABELS,
  GOAL_LABELS,
  saveGoals,
  setTarget,
  useGoals,
  type Experience,
  type GoalType,
} from "@/lib/goals";
import { useSplit } from "@/lib/splits";
import { useSettings } from "@/lib/settings";
import { AiTargets } from "./AiTargets";

/** Goals + per-muscle weekly set targets. Lives in Profile; saves as you tap. */
export function GoalsSection() {
  const goals = useGoals();
  const split = useSplit();
  const { weekStart } = useSettings();
  const [showTargets, setShowTargets] = useState(false);
  const targets = allTargets(goals);
  const totalSets = Object.values(targets).reduce((a, n) => a + n, 0);

  const toggleFocus = (m: MuscleGroup) =>
    saveGoals({
      focusMuscles: goals.focusMuscles.includes(m)
        ? goals.focusMuscles.filter((x) => x !== m)
        : [...goals.focusMuscles, m],
    });

  return (
    <div className="space-y-4">
      <Field label="What are you training for?">
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(GOAL_LABELS) as GoalType[]).map((t) => (
            <button key={t} className={goals.goalType === t ? "chip-on justify-center py-2" : "chip justify-center py-2"} onClick={() => saveGoals({ goalType: t })}>
              {GOAL_LABELS[t]}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Experience">
        <div className="grid grid-cols-3 gap-2">
          {(Object.keys(EXPERIENCE_LABELS) as Experience[]).map((e) => (
            <button key={e} className={goals.experience === e ? "chip-on justify-center py-2" : "chip justify-center py-2"} onClick={() => saveGoals({ experience: e })}>
              {EXPERIENCE_LABELS[e]}
            </button>
          ))}
        </div>
      </Field>

      <Field label={`Workouts per week · ${goals.sessionsPerWeek}`}>
        <input
          type="range"
          min={1}
          max={7}
          value={goals.sessionsPerWeek}
          onChange={(e) => saveGoals({ sessionsPerWeek: Number(e.target.value) })}
          className="w-full accent-[var(--accent)]"
        />
      </Field>

      <Field label="Focus muscles — these get more sets">
        <div className="flex flex-wrap gap-1.5">
          {MUSCLE_GROUPS.map((m) => (
            <button key={m} className={goals.focusMuscles.includes(m) ? "chip-on text-xs" : "chip text-xs"} onClick={() => toggleFocus(m)}>
              {m}
            </button>
          ))}
        </div>
      </Field>

      <div>
        <button className="flex w-full items-center justify-between py-1" onClick={() => setShowTargets(!showTargets)}>
          <span className="text-left">
            <span className="block text-sm font-semibold">Weekly set targets</span>
            <span className="block text-xs text-muted">{totalSets} sets a week across {MUSCLE_GROUPS.length} muscles</span>
          </span>
          <span className="text-xs text-muted underline">{showTargets ? "Hide" : "Edit"}</span>
        </button>

        {showTargets && (
          <ul className="mt-2 space-y-1">
            {MUSCLE_GROUPS.map((m) => {
              const isCustom = goals.targets[m] !== undefined;
              return (
                <li key={m} className="flex items-center gap-2">
                  <span className="flex-1 text-sm truncate">
                    {m}
                    {goals.focusMuscles.includes(m) && <span className="text-xs text-muted"> · focus</span>}
                  </span>
                  <button className="size-8 rounded-lg bg-surface-2 text-lg leading-none" onClick={() => setTarget(m, targets[m] - 1)} aria-label={`Fewer ${m} sets`}>
                    −
                  </button>
                  <span className={`w-10 text-center text-sm font-semibold ${isCustom ? "" : "text-muted"}`}>{targets[m]}</span>
                  <button className="size-8 rounded-lg bg-surface-2 text-lg leading-none" onClick={() => setTarget(m, targets[m] + 1)} aria-label={`More ${m} sets`}>
                    +
                  </button>
                  <button
                    className={`text-[11px] w-10 text-right ${isCustom ? "text-muted underline" : "opacity-0 pointer-events-none"}`}
                    onClick={() => setTarget(m, null)}
                  >
                    reset
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {showTargets && (
          <p className="text-xs text-muted mt-2">
            Grey numbers are suggestions based on your goal (e.g. Chest {defaultTarget("Chest", goals)}). Change any of them and it turns black.
          </p>
        )}
      </div>

      <AiTargets goals={goals} split={split} weekStart={weekStart} />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-muted mb-1.5">{label}</span>
      {children}
    </label>
  );
}
