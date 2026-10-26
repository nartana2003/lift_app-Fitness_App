"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { PageHeader } from "@/components/PageHeader";
import { VolumeChart } from "@/components/progress/VolumeChart";
import { MonthCalendar } from "@/components/progress/MonthCalendar";
import { PeriodCard } from "@/components/progress/PeriodCard";
import { WeeklyGoalsCard } from "@/components/goals/WeeklyGoalsCard";
import { PlateauCard } from "@/components/progress/PlateauCard";
import { ExercisesTab } from "@/components/progress/ExercisesTab";
import { MeasurementsTab } from "@/components/progress/MeasurementsTab";
import { PhotosTab } from "@/components/progress/PhotosTab";
import { allWorkouts } from "@/lib/history";
import { useSettings } from "@/lib/settings";

const TABS = [
  { key: "progress", label: "Progress" },
  { key: "exercises", label: "Exercises" },
  { key: "measurements", label: "Measurements" },
  { key: "photos", label: "Photos" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function ProgressInner() {
  const router = useRouter();
  const raw = useSearchParams().get("tab");
  const tab: TabKey = TABS.some((t) => t.key === raw) ? (raw as TabKey) : "progress";
  const { unit, weekStart } = useSettings();
  const workouts = useLiveQuery(() => allWorkouts(), []);

  return (
    <>
      <PageHeader title="Progress" />
      <div className="flex gap-1 overflow-x-auto no-scrollbar border-b border-border -mx-4 px-4 mb-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => router.replace(t.key === "progress" ? "/progress" : `/progress?tab=${t.key}`, { scroll: false })}
            className={`shrink-0 px-3 py-3 text-sm font-medium border-b-2 -mb-px ${
              tab === t.key ? "border-accent text-text" : "border-transparent text-muted"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "progress" && workouts && (
        <div className="space-y-3">
          <VolumeChart workouts={workouts} unit={unit} weekStart={weekStart} />
          <MonthCalendar workouts={workouts} unit={unit} weekStart={weekStart} />
          <PeriodCard workouts={workouts} unit={unit} weekStart={weekStart} />
          <WeeklyGoalsCard workouts={workouts} />
          <PlateauCard />
        </div>
      )}
      {tab === "exercises" && <ExercisesTab />}
      {tab === "measurements" && <MeasurementsTab />}
      {tab === "photos" && <PhotosTab />}
    </>
  );
}

export default function ProgressPage() {
  return (
    <Suspense>
      <ProgressInner />
    </Suspense>
  );
}
