"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { ExerciseBrowser } from "@/components/ExerciseBrowser";
import { useCatalogue } from "@/lib/catalogue";

function ExercisesInner() {
  const router = useRouter();
  const muscle = useSearchParams().get("m") ?? undefined;
  const { exercises, loading } = useCatalogue();

  return (
    <>
      <PageHeader
        title="Exercises"
        right={
          <Link
            href="/exercises/new"
            className="size-8 rounded-full bg-surface-2 grid place-items-center text-xl leading-none"
            aria-label="New exercise"
          >
            +
          </Link>
        }
      />
      {loading ? (
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
