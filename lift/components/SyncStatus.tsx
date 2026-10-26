"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/offline/db";
import { startSync } from "@/lib/offline/sync";

/** Runs background sync and shows a small banner when offline / just synced. */
export function SyncStatus() {
  const [online, setOnline] = useState(true);
  const [justSynced, setJustSynced] = useState(false);
  const pending = useLiveQuery(() => db.outbox.count(), [], 0);

  useEffect(() => {
    setOnline(navigator.onLine);
    const stop = startSync();
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    let t: ReturnType<typeof setTimeout>;
    const synced = () => {
      setJustSynced(true);
      clearTimeout(t);
      t = setTimeout(() => setJustSynced(false), 2500);
    };
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    window.addEventListener("lift:synced", synced);
    return () => {
      stop();
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      window.removeEventListener("lift:synced", synced);
    };
  }, []);

  let text: string | null = null;
  if (!online) text = pending ? `Offline — ${pending} change${pending > 1 ? "s" : ""} will sync` : "Offline";
  else if (justSynced && !pending) text = "Synced ✓";
  if (!text) return null;

  return (
    <div className="fixed top-0 inset-x-0 z-50 pt-safe pointer-events-none flex justify-center">
      <span className={`mt-1 rounded-full px-3 py-1 text-xs font-medium ${online ? "bg-good text-white" : "bg-surface-2 text-warn border border-border"}`}>
        {text}
      </span>
    </div>
  );
}
