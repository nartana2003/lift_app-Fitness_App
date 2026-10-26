"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useCatalogue } from "@/lib/catalogue";
import { searchExercises } from "@/lib/exercises";
import type { LyftaWorkout } from "@/lib/lyfta/convert";
import { buildPlan, fetchLyfta, forgetKey, getSavedKey, runImport, saveKey, type ImportResult, type PlanRow } from "@/lib/lyfta/run";
import { useSettings } from "@/lib/settings";
import type { Unit } from "@/lib/units";

type Stage = "start" | "loading" | "review" | "importing" | "done";

const BADGE: Record<PlanRow["confidence"], { label: string; cls: string }> = {
  exact: { label: "Matched", cls: "bg-surface-2 text-text" },
  auto: { label: "Matched", cls: "bg-surface-2 text-text" },
  saved: { label: "Remembered", cls: "bg-surface-2 text-text" },
  review: { label: "Check this", cls: "bg-accent text-accent-ink" },
  none: { label: "No match", cls: "bg-accent text-accent-ink" },
};

export function LyftaImport() {
  const { exercises, get } = useCatalogue();
  const settings = useSettings();
  const [stage, setStage] = useState<Stage>("start");
  const [key, setKey] = useState("");
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [unit, setUnit] = useState<Unit>("kg");
  const [workouts, setWorkouts] = useState<LyftaWorkout[]>([]);
  const [plan, setPlan] = useState<PlanRow[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [isSample, setIsSample] = useState(false);

  useEffect(() => {
    void getSavedKey().then((k) => {
      setKey(k);
      setHasSavedKey(!!k);
    });
  }, []);
  useEffect(() => setUnit(settings.unit), [settings.unit]);

  async function load(sandbox: boolean) {
    setError(null);
    setStage("loading");
    try {
      if (!sandbox && key.trim()) {
        await saveKey(key.trim());
        setHasSavedKey(true);
      }
      const ws = await fetchLyfta({ sandbox, key: key.trim() });
      if (ws.length === 0) throw new Error("Lyfta returned no workouts.");
      setIsSample(sandbox);
      setWorkouts(ws);
      setPlan(await buildPlan(ws, exercises));
      setStage("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setStage("start");
    }
  }

  async function doImport() {
    if (isSample && !confirm("These are Lyfta's sample workouts, not yours. Importing adds them to your history and stats (you can delete them later). Import anyway?")) return;
    setStage("importing");
    try {
      setResult(await runImport(workouts, plan, unit));
      setStage("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
      setStage("review");
    }
  }

  const setChoice = (id: string, choice: PlanRow["choice"]) =>
    setPlan((p) => p.map((r) => (r.lyfta_id === id ? { ...r, choice } : r)));

  const sorted = useMemo(() => {
    const rank = { none: 0, review: 1, saved: 2, auto: 3, exact: 4 } as const;
    return [...plan].sort((a, b) => rank[a.confidence] - rank[b.confidence] || b.sets - a.sets);
  }, [plan]);
  const needCheck = plan.filter((r) => r.confidence === "review" || r.confidence === "none").length;

  if (stage === "done" && result) {
    return (
      <div className="space-y-3">
        <p className="font-semibold">Import finished</p>
        <ul className="text-sm space-y-1">
          <li>{result.imported} workouts added ({result.sets} sets)</li>
          {result.alreadyHad > 0 && <li className="text-muted">{result.alreadyHad} were already imported and were left alone</li>}
          {result.customCreated > 0 && <li className="text-muted">{result.customCreated} exercises saved as your own custom exercises</li>}
          {result.skippedSets > 0 && <li className="text-muted">{result.skippedSets} sets skipped (no reps recorded)</li>}
        </ul>
        <p className="text-xs text-muted">Lyfta doesn&apos;t send workout lengths, so imported durations are estimates.</p>
        <Link href="/" className="btn-primary w-full">See them on Home</Link>
        <button className="btn-ghost w-full" onClick={() => setStage("start")}>Import again</button>
      </div>
    );
  }

  if (stage === "review" || stage === "importing") {
    return (
      <div className="space-y-3">
        {isSample && (
          <p className="rounded-xl bg-surface-2 border border-border p-3 text-xs">
            <span className="font-semibold">Sample data.</span> These aren&apos;t your workouts. Use this to see how matching works, then go back and use your own key.
          </p>
        )}
        <p className="text-sm">
          Found <span className="font-semibold">{workouts.length} workouts</span> with{" "}
          <span className="font-semibold">{plan.length} exercises</span>.
          {needCheck > 0 ? ` ${needCheck} need a quick check below.` : " All matched."}
        </p>

        <ul className="space-y-2">
          {sorted.map((r) => {
            const chosen = r.choice.kind === "catalogue" ? get(r.choice.id) : undefined;
            return (
              <li key={r.lyfta_id} className="rounded-xl border border-border p-3">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-muted truncate">
                      Lyfta: {r.name} · {r.sets} sets
                    </p>
                    <p className="font-semibold text-sm">
                      {r.choice.kind === "custom" ? `${r.name} (custom)` : (chosen?.name ?? r.choice.id)}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${BADGE[r.confidence].cls}`}>
                    {BADGE[r.confidence].label}
                  </span>
                </div>
                <button className="text-xs text-muted underline mt-1" onClick={() => setEditing(editing === r.lyfta_id ? null : r.lyfta_id)}>
                  {editing === r.lyfta_id ? "Done" : "Change"}
                </button>
                {editing === r.lyfta_id && <Picker row={r} exercises={exercises} onPick={(c) => setChoice(r.lyfta_id, c)} />}
              </li>
            );
          })}
        </ul>

        <div className="flex items-center justify-between gap-3 text-sm">
          <span>Lyfta weights are in</span>
          <div className="flex gap-2">
            {(["kg", "lb"] as const).map((u) => (
              <button key={u} className={unit === u ? "chip-on" : "chip"} onClick={() => setUnit(u)}>{u}</button>
            ))}
          </div>
        </div>
        {error && <p className="text-sm text-bad">{error}</p>}
        <button className="btn-primary w-full" disabled={stage === "importing"} onClick={doImport}>
          {stage === "importing" ? "Importing…" : isSample ? `Import sample (${workouts.length})` : `Import ${workouts.length} workouts`}
        </button>
        <button className="btn-ghost w-full" disabled={stage === "importing"} onClick={() => setStage("start")}>Back</button>
        <p className="text-xs text-muted">Your choices are remembered, so future imports match these exercises automatically.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Bring your Lyfta workout history into Lift. In Lyfta, sign in on the website, open <span className="font-medium text-text">Community → API</span> and generate a key.
      </p>
      <label className="block">
        <span className="block text-xs text-muted mb-1">Lyfta API key</span>
        <input
          className="field"
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={hasSavedKey ? "Saved on this device" : "Paste your key"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      {error && <p className="text-sm text-bad">{error}</p>}
      <button className="btn-primary w-full" disabled={stage === "loading" || !key.trim()} onClick={() => load(false)}>
        {stage === "loading" ? "Fetching…" : "Fetch my workouts"}
      </button>
      <button className="btn-ghost w-full" disabled={stage === "loading"} onClick={() => load(true)}>
        Try with Lyfta&apos;s sample data
      </button>
      {hasSavedKey && (
        <button
          className="text-xs text-muted underline"
          onClick={async () => {
            await forgetKey();
            setKey("");
            setHasSavedKey(false);
          }}
        >
          Forget saved key
        </button>
      )}
      <p className="text-xs text-muted">
        The key is stored only on this device and used to read your workouts from Lyfta. Lift only reads, but a Lyfta key can also create programs there, so treat it like a password. If it ever leaks, generate a new one in Lyfta to cancel this one.
      </p>
    </div>
  );
}

function Picker({ row, exercises, onPick }: { row: PlanRow; exercises: ReturnType<typeof useCatalogue>["exercises"]; onPick: (c: PlanRow["choice"]) => void }) {
  const [q, setQ] = useState("");
  const results = q.trim() ? searchExercises(exercises, { q }).slice(0, 6) : row.candidates.map((c) => c.exercise);
  const sel = row.choice.kind === "catalogue" ? row.choice.id : "custom";
  return (
    <div className="mt-2 space-y-2">
      <input className="field py-2 text-sm" placeholder="Search our exercises" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="space-y-1">
        {results.map((e) => (
          <li key={e.id}>
            <button className={`w-full text-left rounded-lg px-3 py-2 text-sm ${sel === e.id ? "bg-accent text-accent-ink" : "bg-surface-2"}`} onClick={() => onPick({ kind: "catalogue", id: e.id })}>
              {e.name} <span className="opacity-60 text-xs">· {e.equipment}</span>
            </button>
          </li>
        ))}
        <li>
          <button className={`w-full text-left rounded-lg px-3 py-2 text-sm ${sel === "custom" ? "bg-accent text-accent-ink" : "bg-surface-2"}`} onClick={() => onPick({ kind: "custom" })}>
            Keep as my own exercise: {row.name}
          </button>
        </li>
      </ul>
    </div>
  );
}
