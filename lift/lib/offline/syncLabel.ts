/** How long the outbox may stay non-empty while online before the banner says so. */
export const STUCK_AFTER_MS = 60_000;

const changes = (n: number) => `${n} change${n === 1 ? "" : "s"}`;

/**
 * Pure: the SyncStatus banner text, or null for no banner. The offline and
 * "Synced" texts are the existing ones; "not synced" is shown (neutral style)
 * when changes have waited online for STUCK_AFTER_MS.
 */
export const OWNER_MISMATCH_TEXT = "Another account is signed in on this device. Its changes are not synced.";

const items = (n: number) => `${n} item${n === 1 ? "" : "s"}`;

export function syncLabel(s: {
  online: boolean;
  pending: number;
  justSynced: boolean;
  stuck: boolean;
  /** Dead-lettered items (rejected by the server). */
  deadLetters?: number;
  /** Sync refused: another account owns this device's unsent data. */
  ownerMismatch?: boolean;
}): string | null {
  if (s.ownerMismatch) return OWNER_MISMATCH_TEXT;
  if (!s.online) return s.pending ? `Offline — ${changes(s.pending)} will sync` : "Offline";
  if (s.stuck && s.pending > 0) return `${changes(s.pending)} not synced`;
  if (s.deadLetters && s.deadLetters > 0) return `${items(s.deadLetters)} could not sync`;
  if (s.justSynced && !s.pending) return "Synced ✓";
  return null;
}

/** True for the neutral (grey) pill styles: stuck, rejected items, another account. */
export function isNeutralLabel(text: string | null): boolean {
  return !!text && (text === OWNER_MISMATCH_TEXT || text.endsWith(" not synced") || text.endsWith(" could not sync"));
}
