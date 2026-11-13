"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { ExerciseBrowser } from "@/components/ExerciseBrowser";
import { RoutineList } from "@/components/routines/RoutineList";
import { LibrarySwitch, ROUTINES_HREF, parseLibraryView } from "@/components/routines/LibrarySwitch";
import { useCatalogue } from "@/lib/catalogue";
import { saveSwap } from "@/lib/catchUpSwaps";

function ExercisesInner() {
  const router = useRouter();
  const params = useSearchParams();
  const muscle = params.get("m") ?? undefined;
  const view = parseLibraryView(params.get("view"));
  const { exercises, loading, get } = useCatalogue();

  // Swap mode, from a catch-up suggestion: pick a replacement, then go back to where it came from.
  const [swapDate, swapId] = (params.get("swap") ?? "").split("|");
  const week = params.get("week") ?? "";
  const back = params.get("back") ?? "";
  const swapping = !!swapDate && !!swapId && !!week;
  const returnTo = back.startsWith("/") && !back.startsWith("//") ? back : "/progress";
  const keep = swapping ? `&swap=${encodeURIComponent(`${swapDate}|${swapId}`)}&week=${encodeURIComponent(week)}&back=${encodeURIComponent(returnTo)}` : "";

  return (
    <>
      <PageHeader
        title={swapping ? "Pick a replacement" : view === "routines" ? "Routines" : "Exercises"}
        back={swapping ? returnTo : undefined}
        right={
          <Link
            href={view === "routines" ? "/routines/new" : "/exercises/new"}
            className="size-8 rounded-full bg-surface-2 grid place-items-center text-xl leading-none"
            aria-label={view === "routines" ? "New routine" : "New exercise"}
          >
            +
          </Link>
        }
      />
      {swapping && (
        <p className="text-sm text-muted mb-3" role="status">
          Choose an exercise to use instead of {get(swapId)?.name ?? "this one"} on{" "}
          {new Date(swapDate + "T00:00:00").toLocaleDateString(undefined, { weekday: "long" })}.
        </p>
      )}
      {!swapping && <LibrarySwitch
        view={view}
        onChange={(v) => router.replace(v === "routines" ? ROUTINES_HREF : "/exercises", { scroll: false })}
      />}
      {view === "routines" && !swapping ? (
        <RoutineList />
      ) : loading ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <ExerciseBrowser
          exercises={exercises}
          muscle={muscle}
          onMuscle={(m) =>
            router.replace(m ? `/exercises?m=${encodeURIComponent(m)}${keep}` : `/exercises${keep ? `?${keep.slice(1)}` : ""}`, { scroll: false })
          }
          onPick={
            swapping
              ? (e) => {
                  saveSwap(week, swapDate, swapId, e.id);
                  router.push(returnTo);
                }
              : undefined
          }
        />
      )}
    </>
  );
}

export default function ExercisesPage() {
  return (
    <Suspense>
      <ExercisesInner />
    </Suspense>
  );
}
