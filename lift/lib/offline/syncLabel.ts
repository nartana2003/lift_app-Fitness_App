/** How long the outbox may stay non-empty while online before the banner says so. */
export const STUCK_AFTER_MS = 60_000;

const changes = (n: number) => `${n} change${n === 1 ? "" : "s"}`;

/**
 * Pure: the SyncStatus banner text, or null for no banner. The offline and
 * "Synced" texts are the existing ones; "not synced" is shown (neutral style)
 * when changes have waited online for STUCK_AFTER_MS.
 */
export function syncLabel(s: { online: boolean; pending: number; justSynced: boolean; stuck: boolean }): string | null {
  if (!s.online) return s.pending ? `Offline — ${changes(s.pending)} will sync` : "Offline";
  if (s.stuck && s.pending > 0) return `${changes(s.pending)} not synced`;
  if (s.justSynced && !s.pending) return "Synced ✓";
  return null;
}
