"use client";

import { useEffect, useState } from "react";
import { ExerciseDemo } from "../ExerciseDemo";
import { useCatalogue } from "@/lib/catalogue";
import { equipmentForAi, getEquipment } from "@/lib/equipment";
import { searchExercises, type Exercise } from "@/lib/exercises";
import { swapOptions, SWAP_REASONS, type SwapReason } from "@/lib/swap";

/** "Machine busy?" — pick a replacement that trains the same muscle. */
export function SwapSheet({
  current,
  onPick,
  onClose,
}: {
  current: Exercise;
  onPick: (e: Exercise) => void;
  onClose: () => void;
}) {
  const { exercises, get } = useCatalogue();
  const [reason, setReason] = useState<SwapReason>("busy");
  const [q, setQ] = useState("");
  const ai = useAiSwap(current.id, reason);

  const options = q.trim()
    ? searchExercises(exercises, { q }).filter((e) => e.id !== current.id).slice(0, 8)
    : swapOptions(exercises, current, reason, 6);

  // Coach picks: only ids the local catalogue knows, never the current exercise.
  const picks = q.trim()
    ? []
    : (ai.picks ?? []).flatMap((p) => {
        const e = get(p.exercise_id);
        return e && e.id !== current.id ? [{ e, reason: p.reason }] : [];
      });

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-end" onClick={onClose}>
      <div className="w-full max-w-lg mx-auto card rounded-b-none p-5 pb-safe max-h-[85dvh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Swap {current.name}</h2>
        <p className="text-xs text-muted mb-3">{current.muscle_groups.join(", ")}</p>

        <div className="flex flex-wrap gap-1.5 mb-3">
          {SWAP_REASONS.map((r) => (
            <button key={r.v} className={reason === r.v ? "chip-on text-xs" : "chip text-xs"} onClick={() => { setReason(r.v); setQ(""); }}>
              {r.label}
            </button>
          ))}
        </div>

        <input className="field mb-3 py-2 text-sm" placeholder="Or search for one" value={q} onChange={(e) => setQ(e.target.value)} />

        {!q.trim() && ai.loading && <p className="text-xs text-muted mb-3">Ranking alternatives…</p>}
        {picks.length > 0 && (
          <section aria-label="Coach picks" className="mb-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">Coach picks</h3>
            <ul className="space-y-2">
              {picks.map(({ e, reason: why }) => (
                <li key={e.id}>
                  <button className="w-full flex items-start gap-3 rounded-xl border border-border p-2.5 text-left" onClick={() => onPick(e)}>
                    <ExerciseDemo urls={e.image_urls.slice(0, 1)} alt={e.name} small />
                    <span className="flex-1 min-w-0">
                      <span className="block font-medium text-sm truncate">{e.name}</span>
                      <span className="block text-xs text-muted truncate">
                        {e.equipment} · {e.muscle_groups.join(", ")}
                      </span>
                      <span className="block text-xs mt-0.5">{why}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <ul className="space-y-2">
          {options.map((e) => (
            <li key={e.id}>
              <button className="w-full flex items-center gap-3 rounded-xl bg-surface-2 p-2.5 text-left" onClick={() => onPick(e)}>
                <ExerciseDemo urls={e.image_urls.slice(0, 1)} alt={e.name} small />
                <span className="flex-1 min-w-0">
                  <span className="block font-medium text-sm truncate">{e.name}</span>
                  <span className="block text-xs text-muted truncate">
                    {e.equipment} · {e.muscle_groups.join(", ")}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {options.length === 0 && <li className="text-sm text-muted">No alternatives found.</li>}
        </ul>

        <button className="btn-ghost w-full mt-3" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI ranking (POST /api/ai/swap-exercise). The rule-based list above is always
// shown as it is; when the route answers, a "Coach picks" section with a short
// reason per alternative is added above it. Offline, 503 unavailable or any
// failure adds nothing.
// ---------------------------------------------------------------------------

/** Mirrors the route's limits in lib/ai/swap-exercise.ts (client code may not import lib/ai). */
export const SWAP_AI = {
  maxAlternatives: 6,
  maxReason: 200,
  maxId: 120,
} as const;

export type SwapPick = { exercise_id: string; reason: string };

/** Plain one-line reason: control/format characters and emoji removed, capped. Null when nothing is left. */
export function cleanSwapReason(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SWAP_AI.maxReason)
    .trim();
  return s || null;
}

/** The request body the swap-exercise route accepts. Null when the id cannot be sent. */
export function buildSwapRequest(exerciseId: string, reason: SwapReason, equipment: string[]) {
  if (!exerciseId || exerciseId.length > SWAP_AI.maxId) return null;
  if (!SWAP_REASONS.some((r) => r.v === reason)) return null;
  return { exercise_id: exerciseId, reason, equipment };
}

/**
 * The ranked picks from the route's 200 body, or null when the body is
 * unusable or is for another exercise. Items without a usable id or reason,
 * duplicates and the swapped exercise itself are dropped; at most
 * SWAP_AI.maxAlternatives are kept, in the route's order.
 */
export function parseSwapResponse(json: unknown, exerciseId: string): SwapPick[] | null {
  if (typeof json !== "object" || json === null) return null;
  const { exercise_id, alternatives } = json as Record<string, unknown>;
  if (exercise_id !== exerciseId || !Array.isArray(alternatives)) return null;
  const out: SwapPick[] = [];
  for (const item of alternatives as unknown[]) {
    if (out.length >= SWAP_AI.maxAlternatives) break;
    if (typeof item !== "object" || item === null) continue;
    const { exercise_id: id, reason } = item as Record<string, unknown>;
    if (typeof id !== "string" || !id || id.length > SWAP_AI.maxId || id === exerciseId) continue;
    if (out.some((p) => p.exercise_id === id)) continue;
    const text = cleanSwapReason(reason);
    if (text) out.push({ exercise_id: id, reason: text });
  }
  return out;
}

/** Answers per request body, so reopening the sheet does not ask again. */
const aiCache = new Map<string, SwapPick[]>();
/** Set once the route says AI is unavailable; no more requests this page session. */
let aiOff = false;

/** Clears the in-memory AI answers (tests). */
export function resetSwapAi() {
  aiCache.clear();
  aiOff = false;
}

/** Fetches ranked picks for the exercise and reason. Picks stay null until (and unless) an answer arrives. */
function useAiSwap(exerciseId: string, reason: SwapReason): { picks: SwapPick[] | null; loading: boolean } {
  const [state, setState] = useState<{ key: string; picks: SwapPick[] | null; loading: boolean } | null>(null);
  const key = `${exerciseId}\u0000${reason}`;

  useEffect(() => {
    if (aiOff) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    let live = true;
    void (async () => {
      let equipment: string[] = [];
      try {
        equipment = equipmentForAi(await getEquipment());
      } catch {
        equipment = [];
      }
      const req = buildSwapRequest(exerciseId, reason, equipment);
      if (!req || !live || aiOff) return;
      const body = JSON.stringify(req);
      const cached = aiCache.get(body);
      if (cached) {
        setState({ key, picks: cached, loading: false });
        return;
      }
      setState({ key, picks: null, loading: true });
      let picks: SwapPick[] | null = null;
      try {
        const res = await fetch("/api/ai/swap-exercise", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (res.status === 503) aiOff = true;
        else if (res.ok) picks = parseSwapResponse(await res.json(), exerciseId);
      } catch {
        picks = null; // network error: the rule-based list stays as it is
      }
      if (picks) aiCache.set(body, picks);
      if (live) setState({ key, picks, loading: false });
    })();
    return () => {
      live = false;
    };
  }, [exerciseId, reason, key]);

  return state?.key === key ? { picks: state.picks, loading: state.loading } : { picks: null, loading: false };
}
