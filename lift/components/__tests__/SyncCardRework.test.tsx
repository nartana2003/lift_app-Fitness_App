// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/offline/db";

// BLK-04 rework: the Sync card says dismissed changes are kept on the device,
// and corrupt stored entries can be cleared with Dismiss all. Mocked only.
vi.mock("@/lib/offline/photoSync", () => ({ syncPhotos: async () => ({ uploaded: 0, downloaded: 0, deleted: 0 }) }));

const { SyncCard, dismissedText, unreadableText } = await import("@/components/SyncCard");
const { DEAD_LETTER_KEY } = await import("@/lib/offline/sync");

const letter = (id: string) => ({ table: "workouts", op: "upsert", row: { id }, code: "23503", message: "fk", at: `t-${id}`, tries: 1 });

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("SyncCard rework", () => {
  it("after Dismiss the card says the change is kept on this device", async () => {
    await db.meta.put({ key: DEAD_LETTER_KEY, value: [letter("w1")] });
    render(<SyncCard configured />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss Workout w1" }));
    expect(await screen.findByText(dismissedText(1))).toBeTruthy();
    expect(dismissedText(2)).toBe("2 dismissed changes are kept on this device and not uploaded.");
  });

  it("unreadable entries are counted and Dismiss all clears them", async () => {
    await db.meta.put({ key: DEAD_LETTER_KEY, value: [null, 5] });
    render(<SyncCard configured />);
    expect(await screen.findByText(unreadableText(2))).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss all" }));
    await waitFor(async () => expect((await db.meta.get(DEAD_LETTER_KEY))?.value).toEqual([]));
    await waitFor(() => expect(screen.queryByText(unreadableText(2))).toBeNull());
  });
});
