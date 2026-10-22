"use client";

import { use, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { ExerciseDemo } from "@/components/ExerciseDemo";
import { ExerciseHistory } from "@/components/ExerciseHistory";
import { PrHistory } from "@/components/PrHistory";
import { useCatalogue } from "@/lib/catalogue";
import { renameExercise } from "@/lib/renames";
import { safeHttpUrl } from "@/components/routines/MiniWorkoutCard";

export default function ExerciseDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { get, loading } = useCatalogue();
  const ex = get(decodeURIComponent(id));
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");

  if (loading) return <p className="text-muted pt-8">Loading…</p>;
  if (!ex) return <PageHeader title="Not found" back="/exercises" />;
  const originalVideo = "video_url" in ex && typeof ex.video_url === "string" ? safeHttpUrl(ex.video_url) : null;

  return (
    <>
      <PageHeader
        title={ex.name}
        back="/exercises"
        right={
          <button
            className="text-sm font-medium text-muted underline"
            onClick={() => {
              setDraft(ex.name);
              setRenaming(true);
            }}
          >
            Rename
          </button>
        }
      />
      {ex.original_name && <p className="text-xs text-muted -mt-2 mb-2">Originally &ldquo;{ex.original_name}&rdquo;</p>}
      <ExerciseDemo urls={ex.image_urls} alt={ex.name} />

      <div className="flex flex-wrap gap-2 mt-3">
        {ex.muscle_groups.map((m) => (
          <span key={m} className="chip-on">{m}</span>
        ))}
        {ex.secondary_groups.map((m) => (
          <span key={m} className="chip text-muted">{m}</span>
        ))}
        <span className="chip text-muted">{ex.equipment}</span>
      </div>

      {/* Custom exercises saved from a video link: only http(s) links are shown. */}
      {originalVideo && (
        <a href={originalVideo} target="_blank" rel="noopener noreferrer" className="btn-primary w-full mt-4">
          ▶ Watch the original video
        </a>
      )}

      <a
        href={ex.tiktok_url}
        target="_blank"
        rel="noopener noreferrer"
        className="btn w-full mt-4 bg-[#fe2c55] text-white"
      >
        <svg viewBox="0 0 24 24" className="size-5" fill="currentColor">
          <path d="M16.6 5.82A4.28 4.28 0 0115.54 3h-3.09v12.4a2.59 2.59 0 01-2.59 2.5 2.6 2.6 0 01-2.59-2.6 2.6 2.6 0 013.4-2.47V9.67a5.68 5.68 0 00-.81-.06 5.69 5.69 0 105.69 5.69V9.01a7.34 7.34 0 004.3 1.38V7.3a4.3 4.3 0 01-3.25-1.48z" />
        </svg>
        Watch on TikTok
      </a>

      <ExerciseHistory exerciseId={ex.id} />

      <PrHistory exerciseId={ex.id} />

      <section className="card p-4 mt-4">
        <h2 className="font-semibold mb-2">How to do it</h2>
        <ol className="list-decimal pl-5 space-y-2 text-sm text-muted">
          {ex.instructions.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      </section>

      {renaming && (
        <div className="fixed inset-0 z-[60] bg-black/40 flex items-end" onClick={() => setRenaming(false)}>
          <div className="w-full max-w-lg mx-auto card rounded-b-none p-5 pb-safe space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">Rename exercise</h2>
            <input
              className="field"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === "Enter" && draft.trim()) {
                  await renameExercise(ex.id, draft);
                  setRenaming(false);
                }
              }}
            />
            <p className="text-xs text-muted">Only the name changes. The photos, muscles and history stay the same, and search still finds it by its original name.</p>
            <button
              className="btn-primary w-full"
              disabled={!draft.trim()}
              onClick={async () => {
                await renameExercise(ex.id, draft);
                setRenaming(false);
              }}
            >
              Save name
            </button>
            {ex.original_name && (
              <button
                className="btn-ghost w-full"
                onClick={async () => {
                  await renameExercise(ex.id, null);
                  setRenaming(false);
                }}
              >
                Reset to &ldquo;{ex.original_name}&rdquo;
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
