import { describe, expect, it } from "vitest";
import { syncLabel } from "../syncLabel";

describe("syncLabel", () => {
  const base = { online: true, pending: 0, justSynced: false, stuck: false };

  it("keeps the existing offline and synced texts", () => {
    expect(syncLabel({ ...base, online: false })).toBe("Offline");
    expect(syncLabel({ ...base, online: false, pending: 1 })).toBe("Offline — 1 change will sync");
    expect(syncLabel({ ...base, online: false, pending: 3 })).toBe("Offline — 3 changes will sync");
    expect(syncLabel({ ...base, justSynced: true })).toBe("Synced ✓");
    expect(syncLabel(base)).toBeNull();
  });

  it("says plainly when changes are stuck while online", () => {
    expect(syncLabel({ ...base, pending: 4, stuck: true })).toBe("4 changes not synced");
    expect(syncLabel({ ...base, pending: 1, stuck: true })).toBe("1 change not synced");
    expect(syncLabel({ ...base, pending: 0, stuck: true })).toBeNull();
    expect(syncLabel({ ...base, pending: 2 })).toBeNull();
    expect(/\p{Extended_Pictographic}/u.test(syncLabel({ ...base, pending: 2, stuck: true })!)).toBe(false);
  });
});
