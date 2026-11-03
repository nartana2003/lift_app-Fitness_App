"use client";

import Link from "next/link";
import { EXPERIENCE_LABELS, GOAL_LABELS, goalsChanged, useGoals, type Experience, type GoalType } from "@/lib/goals";
import { useSplit } from "@/lib/splits";

/** Query value that opens the Optimise card on /coach. */
export const OPEN_OPTIMISE = "optimise";
export const OPTIMISE_HREF = `/coach?open=${OPEN_OPTIMISE}`;

/**
 * Plain summary of a split's builtFor (a goalsFingerprint), e.g.
 * "Build muscle · Intermediate · 3×/week · Biceps first". Null when it cannot be read.
 */
export function builtForSummary(builtFor: string | undefined): string | null {
  if (!builtFor) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(builtFor);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const [goalType, experience, sessions, , priorities] = parsed as unknown[];
  if (typeof goalType !== "string" || !(goalType in GOAL_LABELS)) return null;
  const parts = [GOAL_LABELS[goalType as GoalType]];
  if (typeof experience === "string" && experience in EXPERIENCE_LABELS) parts.push(EXPERIENCE_LABELS[experience as Experience]);
  if (typeof sessions === "number" && Number.isFinite(sessions)) parts.push(`${sessions}×/week`);
  const high = Array.isArray(priorities)
    ? priorities.filter((p): p is string => typeof p === "string" && p.endsWith(":high")).map((p) => p.slice(0, -":high".length))
    : [];
  if (high.length) parts.push(`${high.join(", ")} first`);
  return parts.join(" · ");
}

const Icon = () => (
  <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 19L19 5M14 5l2-2M19 10l2-2M17 3v2M21 7h-2" />
  </svg>
);

/** Home card that points to the Coach, and nudges to re-optimise when the goals changed since the split was built. */
export function CoachCard() {
  const goals = useGoals();
  const split = useSplit();
  const iconBox = <span className="shrink-0 size-9 rounded-xl bg-surface-2 grid place-items-center text-muted"><Icon /></span>;

  if (!goalsChanged(goals, split)) {
    return (
      <Link href="/coach" className="card mt-4 flex items-center gap-3 px-4 py-3.5">
        {iconBox}
        <span className="flex-1 min-w-0">
          <span className="block font-semibold text-[15px]">Coach</span>
          <span className="block text-xs text-muted truncate mt-0.5">Build or optimise your split</span>
        </span>
        <svg viewBox="0 0 24 24" className="size-5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </Link>
    );
  }

  const summary = builtForSummary(split.builtFor);
  return (
    <section className="card mt-4 px-4 py-3.5" aria-label="Coach">
      <div className="flex items-center gap-3">
        {iconBox}
        <span className="flex-1 min-w-0">
          <span className="block font-semibold text-[15px]">Your goals changed</span>
          <span className="block text-xs text-muted mt-0.5">
            {summary ? `Your split was built for ${summary}.` : "Your split was built for your earlier goals."}
          </span>
        </span>
      </div>
      <Link href={OPTIMISE_HREF} className="btn-primary w-full mt-3">
        Optimise for new goals
      </Link>
    </section>
  );
}
