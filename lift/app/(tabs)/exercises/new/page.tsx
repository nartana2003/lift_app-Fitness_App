"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { fetchLinkDetails, fetchLinkThumbnail } from "@/components/routines/SaveFromLink";
import { createCustomExercise } from "@/lib/customExercises";
import { EQUIPMENT, MUSCLE_GROUPS, type Equipment, type MuscleGroup } from "@/lib/muscles";

/** Add an exercise the catalogue doesn't have. */
export default function NewExercisePage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [muscles, setMuscles] = useState<MuscleGroup[]>([]);
  const [equipment, setEquipment] = useState<Equipment>("Machine/Cable");
  const [video, setVideo] = useState("");
  const [steps, setSteps] = useState("");
  const [busy, setBusy] = useState(false);

  const toggle = (m: MuscleGroup) => setMuscles((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));

  async function create() {
    setBusy(true);
    try {
      const link = video.trim();
      const ex = await createCustomExercise({
        name,
        muscle_groups: muscles,
        equipment,
        video_url: link || undefined,
        thumbnail_url: link ? await fetchLinkThumbnail(link) : null,
        instructions: steps
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      router.replace(`/exercises/${ex.id}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="New exercise" back="/exercises" />

      <label className="block mb-4">
        <span className="block text-xs text-muted mb-1">Name</span>
        <input className="field" autoFocus placeholder="e.g. Lever Hip Abduction" value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <div className="mb-4">
        <span className="block text-xs text-muted mb-1.5">Muscles worked</span>
        <div className="flex flex-wrap gap-1.5">
          {MUSCLE_GROUPS.map((m) => (
            <button key={m} className={muscles.includes(m) ? "chip-on text-xs" : "chip text-xs"} onClick={() => toggle(m)}>
              {m}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4">
        <span className="block text-xs text-muted mb-1.5">Equipment</span>
        <div className="flex flex-wrap gap-1.5">
          {EQUIPMENT.map((e) => (
            <button key={e} className={equipment === e ? "chip-on text-xs" : "chip text-xs"} onClick={() => setEquipment(e)}>
              {e}
            </button>
          ))}
        </div>
      </div>

      <label className="block mb-4">
        <span className="block text-xs text-muted mb-1">Video link (optional)</span>
        <input
          className="field"
          inputMode="url"
          placeholder="TikTok, Instagram or YouTube link"
          value={video}
          onChange={(e) => setVideo(e.target.value)}
          onBlur={async () => {
            // Prefill an empty name from the post title.
            if (name.trim() || !video.trim()) return;
            const title = (await fetchLinkDetails(video.trim()))?.title;
            if (title) setName((n) => (n.trim() ? n : title.slice(0, 60)));
          }}
        />
      </label>

      <label className="block mb-4">
        <span className="block text-xs text-muted mb-1">How to do it (optional, one step per line)</span>
        <textarea className="field min-h-24" value={steps} onChange={(e) => setSteps(e.target.value)} />
      </label>

      <button className="btn-primary w-full" disabled={busy || !name.trim() || muscles.length === 0} onClick={create}>
        {busy ? "Creating…" : "Create exercise"}
      </button>
      {muscles.length === 0 && <p className="text-xs text-muted mt-2 text-center">Pick at least one muscle so it counts towards your weekly goals.</p>}
    </>
  );
}
