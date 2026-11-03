"use client";

import { evidenceById, evidenceStrength } from "@/lib/evidence/library";

/**
 * The research behind a suggestion, from the Lift Evidence Library: what it found,
 * how strong the source is, and a link to the paper. Unknown ids are skipped.
 */
export function EvidenceList({ ids }: { ids: readonly string[] }) {
  const entries = [...new Set(ids)].flatMap((id) => {
    const e = evidenceById(id);
    return e ? [e] : [];
  });
  if (entries.length === 0) return <p className="text-xs text-muted">No research in the Lift Evidence Library covers this yet.</p>;
  return (
    <div>
      <ul aria-label="Evidence" className="space-y-2">
        {entries.map((e) => {
          const authors = e.source.authors.split(",");
          return (
            <li key={e.id} className="rounded-xl bg-surface-2 p-2.5 text-sm">
              <p>{e.claim}</p>
              <p className="text-xs text-muted mt-1">{evidenceStrength(e)}</p>
              <p className="text-xs text-muted">
                {authors.slice(0, 2).join(",")}
                {authors.length > 2 ? " et al" : ""} ({e.source.year}), {e.source.journal}
              </p>
              <a className="text-xs font-semibold underline" href={e.source.url} target="_blank" rel="noreferrer">
                View paper
              </a>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted mt-2">General fitness information, not medical advice.</p>
    </div>
  );
}
