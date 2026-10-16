"use client";

import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, uuid, type PhotoRow } from "@/lib/offline/db";

type Pose = "front" | "side" | "back";
const POSES: { v: Pose; label: string }[] = [
  { v: "front", label: "Front" },
  { v: "side", label: "Side" },
  { v: "back", label: "Back" },
];

/** Downscale to ≤1280px JPEG so photos stay small on the phone. */
async function shrink(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", 0.85));
}

function useObjectUrl(blob: Blob | undefined) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

function Photo({ p, className = "" }: { p: PhotoRow; className?: string }) {
  const url = useObjectUrl(p.blob);
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt="Progress photo" className={`object-cover ${className}`} /> : <div className={`bg-surface-2 ${className}`} />;
}

const dateLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export function PhotosTab() {
  const photos = useLiveQuery(async () => (await db.photos.toArray()).sort((a, b) => b.taken_at.localeCompare(a.taken_at)), []);
  const input = useRef<HTMLInputElement>(null);
  const [pose, setPose] = useState<Pose | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<PhotoRow | null>(null);
  const [comparing, setComparing] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [showCompare, setShowCompare] = useState(false);

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        await db.photos.put({ id: uuid(), taken_at: new Date().toISOString(), pose, blob: await shrink(f) });
      }
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  if (!photos) return null;
  const pair = picked.map((id) => photos.find((p) => p.id === id)).filter((p): p is PhotoRow => !!p);

  return (
    <>
      <div className="flex items-center gap-2 mb-3 overflow-x-auto no-scrollbar">
        <span className="text-xs text-muted shrink-0">Pose</span>
        {POSES.map((p) => (
          <button key={p.v} className={pose === p.v ? "chip-on" : "chip"} onClick={() => setPose(pose === p.v ? null : p.v)}>
            {p.label}
          </button>
        ))}
      </div>

      <input ref={input} type="file" accept="image/*" multiple className="hidden" onChange={(e) => onFiles(e.target.files)} />

      {photos.length === 0 && <p className="text-sm text-muted mb-3">Add your first progress photo.</p>}
      <div className="grid grid-cols-3 gap-2">
        <button
          className="aspect-[3/4] rounded-xl border border-dashed border-border grid place-items-center text-muted"
          onClick={() => input.current?.click()}
          disabled={busy}
        >
          <span className="text-center">
            <span className="block text-2xl leading-none">{busy ? "…" : "+"}</span>
            <span className="text-xs">Add</span>
          </span>
        </button>
        {photos.map((p) => {
          const sel = picked.includes(p.id);
          return (
            <button
              key={p.id}
              className={`relative aspect-[3/4] rounded-xl overflow-hidden ${sel ? "ring-2 ring-accent ring-offset-2" : ""}`}
              onClick={() => (comparing ? setPicked(sel ? picked.filter((x) => x !== p.id) : [...picked, p.id].slice(-2)) : setView(p))}
            >
              <Photo p={p} className="size-full" />
              <span className="absolute bottom-0 inset-x-0 bg-black/55 text-white text-[10px] px-1.5 py-1 text-left">
                {dateLabel(p.taken_at)}
                {p.pose ? ` · ${p.pose}` : ""}
              </span>
            </button>
          );
        })}
      </div>

      {photos.length > 1 && (
        <div className="mt-4 flex gap-2">
          <button className="btn-ghost flex-1" onClick={() => { setComparing(!comparing); setPicked([]); }}>
            {comparing ? "Cancel compare" : "Compare two photos"}
          </button>
          {comparing && (
            <button className="btn-primary flex-1" disabled={pair.length !== 2} onClick={() => setShowCompare(true)}>
              Compare ({pair.length}/2)
            </button>
          )}
        </div>
      )}
      <p className="text-xs text-muted mt-4">Photos stay on this device for now. Cloud backup and the monthly AI progress comment come with the online setup.</p>

      {view && (
        <div className="fixed inset-0 z-[60] bg-black flex flex-col" onClick={() => setView(null)}>
          <div className="flex items-center justify-between p-4 pt-safe text-white">
            <span className="text-sm">{dateLabel(view.taken_at)}{view.pose ? ` · ${view.pose}` : ""}</span>
            <button
              className="text-sm"
              onClick={async (e) => {
                e.stopPropagation();
                if (confirm("Delete this photo?")) {
                  await db.photos.delete(view.id);
                  setView(null);
                }
              }}
            >
              Delete
            </button>
          </div>
          <div className="flex-1 min-h-0 grid place-items-center p-2">
            <Photo p={view} className="max-h-full max-w-full object-contain" />
          </div>
        </div>
      )}

      {showCompare && pair.length === 2 && (
        <div className="fixed inset-0 z-[60] bg-bg flex flex-col">
          <div className="flex items-center justify-between p-4 pt-safe">
            <h2 className="font-semibold">Compare</h2>
            <button className="text-sm" onClick={() => { setShowCompare(false); setComparing(false); setPicked([]); }}>Close</button>
          </div>
          <div className="flex-1 min-h-0 grid grid-cols-2 gap-2 p-2">
            {[...pair].sort((a, b) => a.taken_at.localeCompare(b.taken_at)).map((p) => (
              <div key={p.id} className="flex flex-col min-h-0">
                <Photo p={p} className="flex-1 min-h-0 w-full rounded-xl" />
                <p className="text-xs text-center mt-1 text-muted">{dateLabel(p.taken_at)}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
