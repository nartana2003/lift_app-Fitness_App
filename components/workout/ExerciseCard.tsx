"use client";

import Link from "next/link";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { ActiveExercise } from "@/lib/offline/db";
import type { Exercise } from "@/lib/exercises";
import { lastSession } from "@/lib/history";
import { formatSets, parseRepRange, suggest } from "@/lib/overload";
import { PR_LABEL, type PrType } from "@/lib/prs";
import { restTimer } from "@/lib/restTimer";
import {
  addSet,
  getRestSec,
  moveExercise,
  removeExercise,
  removeSet,
  setRestSec,
  swapExercise,
  toggleSetDone,
  updateSet,
} from "@/lib/workout";
import { ExerciseDemo } from "../ExerciseDemo";
import { SwapSheet } from "./SwapSheet";
import { WeightInput } from "../WeightInput";
import { useSettings } from "@/lib/settings";
import { dispNum, fmtWeight } from "@/lib/units";
import { fmtClock } from "@/lib/restTimer";

export const RIR_OPTIONS = [
  { v: 3, emoji: "😎", label: "Easy" },
  { v: 2, emoji: "💪", label: "Good" },
  { v: 1, emoji: "😤", label: "Hard" },
  { v: 0, emoji: "🔥", label: "Failure" },
];

export function ExerciseCard({
  ex,
  info,
  onPr,
  repTarget,
}: {
  ex: ActiveExercise;
  info?: Exercise;
  onPr: (name: string, prs: PrType[]) => void;
  repTarget?: string;
}) {
  const last = useLiveQuery(() => lastSession(ex.exercise_id), [ex.exercise_id]);
  const rest = useLiveQuery(() => getRestSec(ex.exercise_id), [ex.exercise_id], 90);
  const { unit } = useSettings();
  const [menu, setMenu] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const name = info?.name ?? ex.exercise_id;

  const lastWork = last?.sets.filter((s) => !s.is_warmup) ?? [];
  const sug = last ? suggest(last.sets, parseRepRange(repTarget ?? ex.target_reps), info?.equipment ?? "Other") : null;
  // Ask for effort on the most recently ticked working set, until it's rated.
  const lastDone = ex.sets.findLast((s) => s.done && !s.is_warmup);
  const rateSet = lastDone?.rir === null ? lastDone : undefined;

  async function tick(setId: string, wasDone: boolean) {
    if (!wasDone) restTimer.start(rest ?? 90, `Rest · ${name}`);
    const prs = await toggleSetDone(ex.id, setId);
    if (prs.length) onPr(name, prs);
  }

  function applySuggestion() {
    if (!sug) return;
    for (const s of ex.sets) {
      if (!s.done && !s.is_warmup) void updateSet(ex.id, s.id, { weight: sug.weight, reps: sug.reps });
    }
  }

  return (
    <section className="card p-3">
      <div className="flex items-start gap-3">
        <Link href={`/exercises/${ex.exercise_id}`}>
          <ExerciseDemo urls={info?.image_urls.slice(0, 1) ?? []} alt={name} small />
        </Link>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold leading-tight">{name}</h3>
          <p className="text-xs text-muted mt-0.5">
            {lastWork.length ? `Last time: ${formatSets(lastWork, unit)}` : "First time — set a baseline"}
          </p>
        </div>
        <button className="p-1 text-muted text-xl leading-none" onClick={() => setMenu(!menu)} aria-label="Options">
          ⋯
        </button>
      </div>

      {menu && (
        <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <button className="btn-ghost py-2" onClick={() => moveExercise(ex.id, -1)}>↑ Move up</button>
          <button className="btn-ghost py-2" onClick={() => moveExercise(ex.id, 1)}>↓ Move down</button>
          <label className="btn-ghost py-2 col-span-2">
            Rest
            <select
              className="bg-transparent"
              value={rest}
              onChange={(e) => setRestSec(ex.exercise_id, Number(e.target.value))}
            >
              {[30, 45, 60, 75, 90, 120, 150, 180, 240, 300].map((s) => (
                <option key={s} value={s}>{fmtClock(s)}</option>
              ))}
            </select>
          </label>
          <button
            className="btn-ghost py-2 col-span-2"
            onClick={() => {
              setMenu(false);
              setSwapping(true);
            }}
          >
            ⇄ Swap exercise
          </button>
          <button className="btn-ghost py-2 col-span-2 text-bad" onClick={() => removeExercise(ex.id)}>
            Remove exercise
          </button>
        </div>
      )}

      {sug && !ex.sets.every((s) => s.done) && (
        <button onClick={applySuggestion} className="mt-3 w-full text-left rounded-xl bg-accent/10 border border-accent/30 px-3 py-2">
          <p className="text-xs text-accent font-semibold">
            Today: {sug.sets}×{sug.reps} @ {fmtWeight(sug.weight, unit)} <span className="text-muted font-normal">· tap to use</span>
          </p>
          <p className="text-[11px] text-muted">{sug.reason}</p>
        </button>
      )}

      <div className="mt-3">
        <div className="grid grid-cols-[2rem_1fr_4.5rem_4rem_2.75rem] gap-2 text-[11px] uppercase tracking-wide text-muted px-1 mb-1">
          <span>Set</span>
          <span>Previous</span>
          <span className="text-center">{unit}</span>
          <span className="text-center">Reps</span>
          <span />
        </div>
        {ex.sets.map((s, i) => {
          const prev = lastWork[i];
          const workIndex = ex.sets.slice(0, i + 1).filter((x) => !x.is_warmup).length;
          return (
            <div
              key={s.id}
              className={`grid grid-cols-[2rem_1fr_4.5rem_4rem_2.75rem] gap-2 items-center rounded-lg px-1 py-1 ${
                s.done ? "bg-good/10" : ""
              }`}
            >
              <button
                className={`text-sm font-semibold ${s.is_warmup ? "text-warn" : ""}`}
                onClick={() => updateSet(ex.id, s.id, { is_warmup: !s.is_warmup })}
                title="Tap to toggle warm-up"
              >
                {s.is_warmup ? "W" : workIndex}
              </button>
              <span className="text-xs text-muted truncate">
                {prev ? `${dispNum(prev.weight, unit)}×${prev.reps}` : "—"}
                {s.pr && <span className="ml-1">🏆</span>}
              </span>
              <WeightInput
                className="field py-1.5 px-1 text-center"
                kg={s.weight}
                unit={unit}
                placeholderKg={prev?.weight}
                onChangeKg={(kg) => updateSet(ex.id, s.id, { weight: kg })}
              />
              <input
                className="field py-1.5 px-1 text-center"
                inputMode="numeric"
                value={s.reps}
                placeholder={prev ? String(prev.reps) : "0"}
                onChange={(e) => updateSet(ex.id, s.id, { reps: e.target.value === "" ? "" : Number(e.target.value) })}
              />
              <button
                onClick={() => tick(s.id, s.done)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void removeSet(ex.id, s.id);
                }}
                className={`h-9 rounded-lg grid place-items-center font-bold ${
                  s.done ? "bg-good text-white" : "bg-surface-2 border border-border text-muted"
                }`}
                aria-label={s.done ? "Undo set" : "Complete set"}
              >
                ✓
              </button>
            </div>
          );
        })}
      </div>

      {rateSet && (
        <div className="mt-2 rounded-xl bg-surface-2 p-2">
          <p className="text-xs text-muted mb-1.5 px-1">How did the last reps feel?</p>
          <div className="grid grid-cols-4 gap-1.5">
            {RIR_OPTIONS.map((o) => (
              <button
                key={o.v}
                className="rounded-lg bg-surface border border-border py-1.5 text-xs"
                onClick={() => updateSet(ex.id, rateSet.id, { rir: o.v })}
              >
                <span className="block text-base">{o.emoji}</span>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2 mt-2">
        <button className="btn-ghost flex-1 py-2 text-sm" onClick={() => addSet(ex.id)}>+ Add set</button>
        {ex.sets.some((s) => !s.done) && ex.sets.length > 1 && (
          <button
            className="btn-ghost py-2 px-3 text-sm text-muted"
            onClick={() => {
              const undone = ex.sets.findLast((s) => !s.done);
              if (undone) void removeSet(ex.id, undone.id);
            }}
          >
            − Set
          </button>
        )}
      </div>

      {swapping && info && (
        <SwapSheet
          current={info}
          onClose={() => setSwapping(false)}
          onPick={async (picked) => {
            await swapExercise(ex.id, picked.id);
            setSwapping(false);
          }}
        />
      )}
    </section>
  );
}

export function prText(prs: PrType[]) {
  return prs.map((p) => PR_LABEL[p]).join(" · ");
}
