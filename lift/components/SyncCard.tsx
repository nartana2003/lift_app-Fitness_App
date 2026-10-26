"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type SyncTable } from "@/lib/offline/db";
import { DEAD_LETTER_KEY, deadLetterKey, DISMISSED_KEY, dismissDeadLetters, MAX_DEAD_LETTER_TRIES, resendDeadLetters, validDeadLetters, type DeadLetter } from "@/lib/offline/sync";

/** Plain names for the synced tables, shown in the Profile > Sync list. */
export const TABLE_LABELS: Record<SyncTable, string> = {
  workouts: "Workout",
  workout_exercises: "Workout exercise",
  sets: "Set",
  personal_records: "Personal record",
  measurements: "Measurement",
  exercises: "Custom exercise",
  routines: "Routine",
  routine_exercises: "Routine exercise",
  planned_days: "Planned day",
};

export const SYNC_EMPTY_TEXT = "Nothing is waiting. Every change on this device has been sent.";
export const SYNC_LOCAL_TEXT = "Sync is off. Everything is stored on this device.";

/** Collapsed-card subtitle for Profile > Sync. */
export function syncCardSummary(dead: number, pending: number, configured: boolean): string {
  if (dead > 0) return `${dead} ${dead === 1 ? "item" : "items"} could not sync`;
  if (pending > 0) return `${pending} ${pending === 1 ? "change" : "changes"} waiting to send`;
  return configured ? "All changes sent" : "Local only";
}

function readLetters(v: unknown): DeadLetter[] {
  return validDeadLetters(v);
}

/** Corrupt stored entries that cannot be shown. */
export const unreadableText = (n: number) => `${n} unreadable ${n === 1 ? "entry" : "entries"}. Dismiss all to clear.`;

/** "2 dismissed changes are kept on this device and not uploaded." */
export const dismissedText = (n: number) => `${n} dismissed ${n === 1 ? "change is" : "changes are"} kept on this device and not uploaded.`;

/**
 * Profile > Sync body: the changes the server rejected (dead letters) with
 * Resend and Dismiss per item and for all. Dismissing removes an item from the
 * list (and from the banner count); the data on this device is not touched.
 */
export function SyncCard({ configured }: { configured: boolean }) {
  const stored = useLiveQuery(async () => (await db.meta.get(DEAD_LETTER_KEY))?.value, []);
  const letters = readLetters(stored);
  // Corrupt entries are not listed, but still count in the banner: "Dismiss all" clears them.
  const unreadable = (Array.isArray(stored) ? stored.length : 0) - letters.length;
  const pending = useLiveQuery(() => db.outbox.count(), [], 0);
  const dismissed = useLiveQuery(async () => {
    const v = (await db.meta.get(DISMISSED_KEY))?.value;
    return Array.isArray(v) ? v.length : 0;
  }, [], 0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function run(action: () => Promise<number>, done: (n: number) => string) {
    setBusy(true);
    try {
      setNote(done(await action()));
    } catch {
      setNote("That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const resend = (keys?: string[]) => run(() => resendDeadLetters(keys), (n) => (n ? `Queued ${n} to send again` : "Nothing to send: newer changes replaced it"));
  const dismiss = (keys?: string[]) => run(() => dismissDeadLetters(keys), (n) => `Dismissed ${n}`);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        {!configured
          ? SYNC_LOCAL_TEXT
          : letters.length
            ? "The server refused these changes. Resend them (for example after an app update) or dismiss them. Dismissing keeps the data on this device."
            : SYNC_EMPTY_TEXT}
      </p>
      {dismissed > 0 && <p className="text-xs text-muted">{dismissedText(dismissed)}</p>}
      {pending > 0 && (
        <p className="text-xs text-muted">
          {pending} {pending === 1 ? "change" : "changes"} waiting to send
        </p>
      )}

      {unreadable > 0 && <p className="text-xs text-muted">{unreadableText(unreadable)}</p>}
      {(letters.length > 0 || unreadable > 0) && (
        <>
          {letters.length > 0 && (
            <ul className="divide-y divide-border border border-border rounded-xl" aria-label="Changes that could not sync">
              {letters.map((d, i) => {
                const key = deadLetterKey(d);
                const id = String(d.row?.id ?? "");
                const label = `${TABLE_LABELS[d.table] ?? d.table}${d.op === "delete" ? " (delete)" : ""}`;
                const tries = d.tries ?? 1;
                return (
                  <li key={`${key}#${i}`} className="p-3 space-y-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{label}</p>
                      <p className="text-xs text-muted truncate" title={id}>
                        {id}
                      </p>
                      <p className="text-xs text-muted break-words">
                        {[d.code, d.message].filter(Boolean).join(": ") || "Rejected by the server"}
                      </p>
                      <p className="text-xs text-muted">
                        {tries >= MAX_DEAD_LETTER_TRIES ? `Gave up after ${tries} tries` : `Tried ${tries} ${tries === 1 ? "time" : "times"}`}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button type="button" className="chip" disabled={busy} aria-label={`Resend ${label} ${id}`} onClick={() => void resend([key])}>
                        Resend
                      </button>
                      <button type="button" className="chip" disabled={busy} aria-label={`Dismiss ${label} ${id}`} onClick={() => void dismiss([key])}>
                        Dismiss
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="btn-ghost w-full" disabled={busy} onClick={() => void resend()}>
              Resend all
            </button>
            <button type="button" className="btn-ghost w-full" disabled={busy} onClick={() => void dismiss()}>
              Dismiss all
            </button>
          </div>
        </>
      )}
      {note && (
        <p className="text-xs text-muted" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
