"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/offline/db";
import { DEAD_LETTER_KEY, startSync } from "@/lib/offline/sync";
import { clearAppLocalStorage, OWNER_MISMATCH_EVENT, OWNER_OK_EVENT } from "@/lib/offline/owner";
import { supabaseBrowser } from "@/lib/supabase/client";
import { syncPhotos } from "@/lib/offline/photoSync";
import { isNeutralLabel, STUCK_AFTER_MS, syncLabel } from "@/lib/offline/syncLabel";

export const ERASE_LABEL = "Sign out and erase local data on this device";
export const ERASE_CONFIRM =
  "This signs you out and deletes everything stored on this device, including changes from the other account that never synced. Continue?";

/** Explicit, confirmed recovery when another account's unsent data blocks sync. */
async function signOutAndErase() {
  if (!window.confirm(ERASE_CONFIRM)) return;
  try {
    await supabaseBrowser().auth.signOut();
  } catch {
    // erase anyway
  }
  // Device-only preferences mirrored outside Dexie (rest timer, theme) go too.
  clearAppLocalStorage();
  db.close();
  await db.delete();
  window.location.assign("/login");
}

/** Runs background sync and shows a small banner when offline / just synced. */
export function SyncStatus() {
  const [online, setOnline] = useState(true);
  const [justSynced, setJustSynced] = useState(false);
  const pending = useLiveQuery(() => db.outbox.count(), [], 0);
  const [stuck, setStuck] = useState(false);
  const [ownerMismatch, setOwnerMismatch] = useState(false);
  const deadCount = useLiveQuery(async () => {
    const v = (await db.meta.get(DEAD_LETTER_KEY))?.value;
    return Array.isArray(v) ? v.length : 0;
  }, [], 0);

  // Online with changes still queued after a minute: say so (neutral, not an alarm).
  useEffect(() => {
    setStuck(false);
    if (!online || !pending) return;
    const t = setTimeout(() => setStuck(true), STUCK_AFTER_MS);
    return () => clearTimeout(t);
  }, [online, pending]);

  useEffect(() => {
    setOnline(navigator.onLine);
    const stop = startSync();
    // Progress photo cloud backup (no-op unless signed in with Supabase).
    const photos = () => void syncPhotos().catch(() => {});
    photos();
    const photoTimer = setInterval(photos, 5 * 60_000);
    const on = () => {
      setOnline(true);
      photos();
    };
    const off = () => setOnline(false);
    let t: ReturnType<typeof setTimeout>;
    const mismatch = () => setOwnerMismatch(true);
    // The right account is back (even with nothing to send): clear the mismatch.
    const ownerOk = () => setOwnerMismatch(false);
    const synced = () => {
      setOwnerMismatch(false);
      // A workout just uploaded: photos linked to it can follow now.
      photos();
      setJustSynced(true);
      clearTimeout(t);
      t = setTimeout(() => setJustSynced(false), 2500);
    };
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    window.addEventListener("lift:synced", synced);
    window.addEventListener(OWNER_MISMATCH_EVENT, mismatch);
    window.addEventListener(OWNER_OK_EVENT, ownerOk);
    return () => {
      window.removeEventListener(OWNER_OK_EVENT, ownerOk);
      window.removeEventListener(OWNER_MISMATCH_EVENT, mismatch);
      stop();
      clearInterval(photoTimer);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      window.removeEventListener("lift:synced", synced);
    };
  }, []);

  const text = syncLabel({ online, pending, justSynced, stuck, deadLetters: deadCount, ownerMismatch });
  if (!text) return null;
  const neutral = isNeutralLabel(text);

  return (
    <div className="fixed top-0 inset-x-0 z-50 pt-safe pointer-events-none flex flex-col items-center">
      <span className={`mt-1 rounded-full px-3 py-1 text-xs font-medium ${neutral ? "bg-surface-2 text-muted border border-border" : online ? "bg-good text-white" : "bg-surface-2 text-warn border border-border"}`}>
        {text}
      </span>
      {ownerMismatch && (
        <button
          type="button"
          className="pointer-events-auto mt-1 rounded-full px-3 py-1 text-xs bg-surface-2 text-muted border border-border underline"
          onClick={() => void signOutAndErase()}
        >
          {ERASE_LABEL}
        </button>
      )}
    </div>
  );
}
