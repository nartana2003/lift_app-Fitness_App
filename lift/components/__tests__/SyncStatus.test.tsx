// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/offline/db";

// Background sync and photo sync are stubbed; only the banner is under test.
vi.mock("@/lib/offline/sync", async (orig) => ({ ...(await orig<typeof import("@/lib/offline/sync")>()), startSync: () => () => {} }));
vi.mock("@/lib/offline/photoSync", () => ({ syncPhotos: async () => ({ uploaded: 0, downloaded: 0, deleted: 0 }) }));

const { SyncStatus, ERASE_LABEL } = await import("@/components/SyncStatus");
const { DEAD_LETTER_KEY } = await import("@/lib/offline/sync");
const { OWNER_MISMATCH_EVENT } = await import("@/lib/offline/owner");
const { OWNER_MISMATCH_TEXT } = await import("@/lib/offline/syncLabel");

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("SyncStatus", () => {
  it("shows nothing when all is synced", () => {
    const { container } = render(<SyncStatus />);
    expect(container.textContent).toBe("");
  });

  it("shows how many items could not sync, in the neutral style", async () => {
    await db.meta.put({ key: DEAD_LETTER_KEY, value: [{ row: { id: "a" } }, { row: { id: "b" } }] });
    render(<SyncStatus />);
    const pill = await screen.findByText("2 items could not sync");
    expect(pill.className).toContain("text-muted");
    expect(pill.className).not.toContain("bg-good");
  });

  it("another account: neutral message and an explicit, confirmed erase button", async () => {
    render(<SyncStatus />);
    act(() => void window.dispatchEvent(new CustomEvent(OWNER_MISMATCH_EVENT)));
    await screen.findByText(OWNER_MISMATCH_TEXT);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const del = vi.spyOn(db, "delete");
    fireEvent.click(screen.getByRole("button", { name: ERASE_LABEL }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(del).not.toHaveBeenCalled();
    confirm.mockRestore();
    del.mockRestore();
  });
});
