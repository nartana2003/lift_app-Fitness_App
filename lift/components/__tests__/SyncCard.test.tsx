// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/offline/db";

// Profile > Sync card (BLK-04) and the SyncStatus follow-ups. Background sync
// and photo sync are stubbed; nothing touches a live service.
vi.mock("@/lib/offline/sync", async (orig) => ({ ...(await orig<typeof import("@/lib/offline/sync")>()), startSync: () => () => {} }));
vi.mock("@/lib/offline/photoSync", () => ({ syncPhotos: async () => ({ uploaded: 0, downloaded: 0, deleted: 0 }) }));

const { SyncCard, syncCardSummary, SYNC_EMPTY_TEXT, SYNC_LOCAL_TEXT } = await import("@/components/SyncCard");
const { SyncStatus, ERASE_LABEL } = await import("@/components/SyncStatus");
const { DEAD_LETTER_KEY, MAX_DEAD_LETTER_TRIES } = await import("@/lib/offline/sync");
const { OWNER_MISMATCH_EVENT, OWNER_OK_EVENT } = await import("@/lib/offline/owner");
const { OWNER_MISMATCH_TEXT } = await import("@/lib/offline/syncLabel");

const letter = (id: string, extra: Record<string, unknown> = {}) => ({ table: "measurements", op: "upsert", row: { id }, code: "23503", message: "fk violation", at: `t-${id}`, tries: 1, ...extra });

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("syncCardSummary", () => {
  it("dead letters first, then pending, then all sent / local only", () => {
    expect(syncCardSummary(1, 3, true)).toBe("1 item could not sync");
    expect(syncCardSummary(2, 0, true)).toBe("2 items could not sync");
    expect(syncCardSummary(0, 1, true)).toBe("1 change waiting to send");
    expect(syncCardSummary(0, 0, true)).toBe("All changes sent");
    expect(syncCardSummary(0, 0, false)).toBe("Local only");
  });
});

describe("SyncCard", () => {
  it("empty states", async () => {
    const { unmount } = render(<SyncCard configured />);
    expect(screen.getByText(SYNC_EMPTY_TEXT)).toBeTruthy();
    unmount();
    render(<SyncCard configured={false} />);
    expect(screen.getByText(SYNC_LOCAL_TEXT)).toBeTruthy();
  });

  it("lists each dead letter with table, row id, error and tries", async () => {
    await db.meta.put({ key: DEAD_LETTER_KEY, value: [letter("m1"), letter("m2", { tries: MAX_DEAD_LETTER_TRIES, table: "workouts" })] });
    render(<SyncCard configured />);
    expect(await screen.findByText("m1")).toBeTruthy();
    expect(screen.getByText("Measurement")).toBeTruthy();
    expect(screen.getByText("Workout")).toBeTruthy();
    expect(screen.getAllByText("23503: fk violation")).toHaveLength(2);
    expect(screen.getByText("Tried 1 time")).toBeTruthy();
    expect(screen.getByText(`Gave up after ${MAX_DEAD_LETTER_TRIES} tries`)).toBeTruthy();
  });

  it("Dismiss removes one item and clears it from the banner count", async () => {
    await db.meta.put({ key: DEAD_LETTER_KEY, value: [letter("m1", { tries: MAX_DEAD_LETTER_TRIES })] });
    render(
      <>
        <SyncStatus />
        <SyncCard configured />
      </>,
    );
    await screen.findByText("1 item could not sync");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Measurement m1" }));
    await waitFor(() => expect(screen.queryByText("1 item could not sync")).toBeNull());
    expect(await screen.findByText(SYNC_EMPTY_TEXT)).toBeTruthy();
    expect((await db.meta.get(DEAD_LETTER_KEY))?.value).toEqual([]);
  });

  it("Resend queues one item; Resend all and Dismiss all act on every item", async () => {
    await db.meta.put({ key: DEAD_LETTER_KEY, value: [letter("m1"), letter("m2"), letter("m3")] });
    render(<SyncCard configured />);
    fireEvent.click(await screen.findByRole("button", { name: "Resend Measurement m1" }));
    await waitFor(async () => expect(await db.outbox.count()).toBe(1));
    expect(await screen.findByText("Queued 1 to send again")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resend all" }));
    await waitFor(async () => expect(await db.outbox.count()).toBe(3));
    await db.meta.put({ key: DEAD_LETTER_KEY, value: [letter("m4"), letter("m5")] });
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss all" }));
    await waitFor(async () => expect((await db.meta.get(DEAD_LETTER_KEY))?.value).toEqual([]));
  });
});

describe("SyncStatus follow-ups", () => {
  it("the mismatch banner clears when the right account is back with nothing to send", async () => {
    render(<SyncStatus />);
    act(() => void window.dispatchEvent(new CustomEvent(OWNER_MISMATCH_EVENT)));
    await screen.findByText(OWNER_MISMATCH_TEXT);
    act(() => void window.dispatchEvent(new CustomEvent(OWNER_OK_EVENT)));
    await waitFor(() => expect(screen.queryByText(OWNER_MISMATCH_TEXT)).toBeNull());
    expect(screen.queryByRole("button", { name: ERASE_LABEL })).toBeNull();
  });

  it("erase also clears the app's localStorage keys", async () => {
    localStorage.setItem("lift:rest", "{}");
    localStorage.setItem("lift-theme", "dark");
    localStorage.setItem("someone-else", "keep");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const del = vi.spyOn(db, "delete").mockResolvedValue(undefined);
    const close = vi.spyOn(db, "close").mockImplementation(() => {});
    const assign = vi.fn();
    const loc = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...loc, assign } });
    render(<SyncStatus />);
    act(() => void window.dispatchEvent(new CustomEvent(OWNER_MISMATCH_EVENT)));
    fireEvent.click(await screen.findByRole("button", { name: ERASE_LABEL }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(localStorage.getItem("lift:rest")).toBeNull();
    expect(localStorage.getItem("lift-theme")).toBeNull();
    expect(localStorage.getItem("someone-else")).toBe("keep");
    Object.defineProperty(window, "location", { configurable: true, value: loc });
    confirm.mockRestore();
    del.mockRestore();
    close.mockRestore();
  });
});
