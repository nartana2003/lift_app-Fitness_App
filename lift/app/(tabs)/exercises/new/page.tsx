"use client";

import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { NewExerciseForm } from "@/components/NewExerciseForm";

/** Add an exercise the catalogue doesn't have. */
export default function NewExercisePage() {
  const router = useRouter();
  return (
    <>
      <PageHeader title="New exercise" back="/exercises" />
      <NewExerciseForm onCreated={(id) => router.replace(`/exercises/${id}`)} />
    </>
  );
}
