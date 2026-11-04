"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { ExerciseBrowser } from "@/components/ExerciseBrowser";
import { RoutineList } from "@/components/routines/RoutineList";
import { LibrarySwitch, ROUTINES_HREF, parseLibraryView } from "@/components/routines/LibrarySwitch";
import { useCatalogue } from "@/lib/catalogue";

function ExercisesInner() {
  const router = useRouter();
  const params = useSearchParams();
  const muscle = params.get("m") ?? undefined;
  const view = parseLibraryView(params.get("view"));
  const { exercises, loading } = useCatalogue();

  return (
    <>
      <PageHeader
        title={view === "routines" ? "Routines" : "Exercises"}
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
      <LibrarySwitch
        view={view}
        onChange={(v) => router.replace(v === "routines" ? ROUTINES_HREF : "/exercises", { scroll: false })}
      />
      {view === "routines" ? (
        <RoutineList />
      ) : loading ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <ExerciseBrowser
          exercises={exercises}
          muscle={muscle}
          onMuscle={(m) => router.replace(m ? `/exercises?m=${encodeURIComponent(m)}` : "/exercises", { scroll: false })}
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
