import { describe, expect, it } from "vitest";
import { isNeutralLabel, OWNER_MISMATCH_TEXT, syncLabel } from "../syncLabel";

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

describe("syncLabel round 3", () => {
  const base = { online: true, pending: 0, justSynced: false, stuck: false };

  it("counts items the server rejected, neutral", () => {
    expect(syncLabel({ ...base, deadLetters: 1 })).toBe("1 item could not sync");
    expect(syncLabel({ ...base, deadLetters: 3, justSynced: true })).toBe("3 items could not sync");
    expect(isNeutralLabel("3 items could not sync")).toBe(true);
    expect(syncLabel({ ...base, deadLetters: 0 })).toBeNull();
  });

  it("another account on this device wins over everything, neutral", () => {
    expect(syncLabel({ ...base, online: false, pending: 2, ownerMismatch: true })).toBe(OWNER_MISMATCH_TEXT);
    expect(OWNER_MISMATCH_TEXT).toMatch(/Another account is signed in on this device/);
    expect(isNeutralLabel(OWNER_MISMATCH_TEXT)).toBe(true);
    expect(isNeutralLabel("Synced ✓")).toBe(false);
    expect(isNeutralLabel("Offline")).toBe(false);
  });
});
