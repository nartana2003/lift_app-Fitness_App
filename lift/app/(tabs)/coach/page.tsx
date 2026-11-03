"use client";

import { PageHeader } from "@/components/PageHeader";
import { Collapsible } from "@/components/Collapsible";
import { GoalsSection } from "@/components/goals/GoalsSection";
import { PrioritiesSection } from "@/components/goals/PrioritiesSection";
import { CoachSetup } from "@/components/goals/CoachSetup";
import { SplitEditor } from "@/components/goals/SplitEditor";
import { AskCoach } from "@/components/goals/AskCoach";
import { useSplit } from "@/lib/splits";
import { allTargets, GOAL_LABELS, useGoals } from "@/lib/goals";

const ICONS = {
  split: "M4 6h7M4 12h7M4 18h7M15 6h5M15 12h5M15 18h5",
  target: "M12 21a9 9 0 110-18 9 9 0 010 18zM12 16.5a4.5 4.5 0 110-9 4.5 4.5 0 010 9zM12 13a1 1 0 110-2 1 1 0 010 2z",
  sliders: "M4 7h10M18 7h2M4 17h4M12 17h8",
  wand: "M5 19L19 5M14 5l2-2M19 10l2-2M17 3v2M21 7h-2",
} as const;

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

/** Coach tab: goals, priorities, build a split, the split itself and the coach. Optimise joins here in a later step. */
export default function CoachPage() {
  const goals = useGoals();
  const split = useSplit();
  const high = Object.values(goals.priorities).filter((p) => p === "high").length;

  return (
    <div>
      <PageHeader title="Coach" />

      <Collapsible
        title="Goals"
        icon={<Icon d={ICONS.target} />}
        subtitle={`${GOAL_LABELS[goals.goalType]} · ${goals.sessionsPerWeek}×/week · ${Object.values(allTargets(goals)).reduce((a, n) => a + n, 0)} sets`}
      >
        <GoalsSection />
      </Collapsible>

      <Collapsible
        title="Priorities and limits"
        icon={<Icon d={ICONS.sliders} />}
        subtitle={`${high} high priority · ${goals.limitations.length ? goals.limitations.join(", ") : "no limits"}`}
      >
        <PrioritiesSection />
      </Collapsible>

      <Collapsible
        title="Build a split"
        icon={<Icon d={ICONS.wand} />}
        subtitle={split.days.length ? "Rebuild your split and routines from your goals" : "Make a split and routines from your goals"}
      >
        <CoachSetup goals={goals} split={split} />
      </Collapsible>

      <Collapsible
        title="My split"
        icon={<Icon d={ICONS.split} />}
        subtitle={split.days.length ? `${split.name || "Split"} · ${split.days.map((d) => d.name).join(" · ")}` : "Not set up yet"}
      >
        <SplitEditor />
      </Collapsible>

      <AskCoach />
    </div>
  );
}
