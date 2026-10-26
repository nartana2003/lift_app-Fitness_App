"use client";

import { useRef, useState } from "react";
import {
  BACKUP_TABLES,
  backupCounts,
  backupFilename,
  exportBackup,
  importBackup,
  parseBackup,
  serializeBackup,
  TABLE_LABELS,
  type Backup,
  type ImportSummary,
} from "@/lib/dataExport";

type Stage = "idle" | "working" | "review" | "done";

/** Export all local data to one JSON file, or restore from such a file (adds only, never overwrites). */
export function DataBackup() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ name: string; backup: Backup } | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [exported, setExported] = useState<string | null>(null);

  async function doExport() {
    setError(null);
    setExported(null);
    setStage("working");
    try {
      const now = new Date();
      const blob = new Blob([serializeBackup(await exportBackup(now))], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = backupFilename(now);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExported(a.download);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    }
    setStage("idle");
  }

  async function pickFile(file: File | undefined) {
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    setError(null);
    setExported(null);
    setSummary(null);
    const parsed = parseBackup(await file.text());
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setPending({ name: file.name, backup: parsed.backup });
    setStage("review");
  }

  async function doImport() {
    if (!pending) return;
    setStage("working");
    try {
      setSummary(await importBackup(pending.backup));
      setPending(null);
      setStage("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed. Nothing was changed.");
      setStage("review");
    }
  }

  if (stage === "review" && pending) {
    const counts = backupCounts(pending.backup);
    const rows = BACKUP_TABLES.filter((t) => counts[t] > 0);
    return (
      <div className="space-y-3">
        <p className="text-sm">
          <span className="font-semibold">{pending.name}</span>
          <span className="text-muted"> · exported {pending.backup.exported_at.slice(0, 10)}</span>
        </p>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">This backup is empty.</p>
        ) : (
          <ul className="text-sm space-y-1" aria-label="Backup contents">
            {rows.map((t) => (
              <li key={t} className="flex justify-between">
                <span>{TABLE_LABELS[t]}</span>
                <span className="text-muted">{counts[t]}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">
          Only adds what this device does not already have. Nothing here is deleted or overwritten, so importing the same file twice is safe.
        </p>
        {error && <p className="text-sm text-bad">{error}</p>}
        <button className="btn-primary w-full" onClick={doImport} disabled={rows.length === 0}>
          Import
        </button>
        <button
          className="btn-ghost w-full"
          onClick={() => {
            setPending(null);
            setError(null);
            setStage("idle");
          }}
        >
          Cancel
        </button>
      </div>
    );
  }

  const totalAdded = summary ? BACKUP_TABLES.reduce((n, t) => n + summary.added[t], 0) : 0;
  const totalSkipped = summary ? BACKUP_TABLES.reduce((n, t) => n + summary.skipped[t], 0) : 0;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Save everything on this device (workouts, routines, measurements, photos, settings) to one file, or restore from one.
      </p>
      <button className="btn-primary w-full" onClick={doExport} disabled={stage === "working"}>
        Export data
      </button>
      <button className="btn-ghost w-full" onClick={() => fileRef.current?.click()} disabled={stage === "working"}>
        Import from file
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-label="Backup file"
        onChange={(e) => void pickFile(e.target.files?.[0])}
      />
      {exported && <p className="text-sm">Saved {exported}</p>}
      {error && <p className="text-sm text-bad">{error}</p>}
      {stage === "done" && summary && (
        <div className="text-sm space-y-1" role="status">
          <p className="font-semibold">Import finished</p>
          {totalAdded === 0 ? (
            <p className="text-muted">Nothing new. This device already had everything in the file.</p>
          ) : (
            <ul className="space-y-1">
              {BACKUP_TABLES.filter((t) => summary.added[t] > 0).map((t) => (
                <li key={t}>
                  {summary.added[t]} {TABLE_LABELS[t].toLowerCase()} added
                </li>
              ))}
            </ul>
          )}
          {totalSkipped > 0 && totalAdded > 0 && <p className="text-muted">{totalSkipped} already here and left as they were</p>}
        </div>
      )}
    </div>
  );
}
