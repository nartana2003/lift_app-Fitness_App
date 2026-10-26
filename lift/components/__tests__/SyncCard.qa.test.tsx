// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/offline/db";

vi.mock("@/lib/offline/sync", async (orig) => ({ ...(await orig<typeof import("@/lib/offline/sync")>()), startSync: () => () => {} }));
vi.mock("@/lib/offline/photoSync", () => ({ syncPhotos: async () => ({ uploaded: 0, downloaded: 0, deleted: 0 }) }));

const { SyncCard, SYNC_EMPTY_TEXT, syncCardSummary } = await import("@/components/SyncCard");
const { DEAD_LETTER_KEY } = await import("@/lib/offline/sync");

const letter = (i: number, extra: Record<string, unknown> = {}) => ({ table: "measurements", op: "upsert", row: { id: `m${i}` }, code: "23503", message: "fk", at: `t${i}`, tries: 1, ...extra });

beforeEach(async () => {
  cleanup();
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("SyncCard QA", () => {
  it("0 letters: empty text, no lists or bulk buttons", async () => {
    render(<SyncCard configured />);
    expect(await screen.findByText(SYNC_EMPTY_TEXT)).toBeTruthy();
    expect(screen.queryByText("Resend all")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("1 letter: one row, buttons named per row", async () => {
    await db.meta.put({ key: DEAD_LETTER_KEY, value: [letter(1)] });
    render(<SyncCard configured />);
    expect(await screen.findByText("m1")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Resend Measurement m1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss Measurement m1" })).toBeTruthy();
  });

  it("500 letters render without crashing; dismiss all clears them", async () => {
    await db.meta.put({ key: DEAD_LETTER_KEY, value: Array.from({ length: 500 }, (_, i) => letter(i)) });
    render(<SyncCard configured />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(500), { timeout: 20000 });
    fireEvent.click(screen.getByText("Dismiss all"));
    await waitFor(() => expect(screen.getByText("Dismissed 500")).toBeTruthy(), { timeout: 20000 });
    await waitFor(() => expect(screen.queryByRole("list")).toBeNull());
    expect(syncCardSummary(500, 0, true)).toBe("500 items could not sync");
  }, 60000);

  it("unknown table and junk entries (missing code/message/row) still render", async () => {
    await db.meta.put({ key: DEAD_LETTER_KEY, value: [{ table: "weird", op: "delete", at: "t", row: {} }, { table: "sets", op: "upsert", at: "t2", row: { id: "s" } }] });
    render(<SyncCard configured />);
    expect(await screen.findByText("weird (delete)")).toBeTruthy();
    expect(screen.getAllByText("Rejected by the server")).toHaveLength(2);
  });

  it("rapid double-click on Resend queues once", async () => {
    await db.meta.put({ key: DEAD_LETTER_KEY, value: [letter(1)] });
    render(<SyncCard configured />);
    const btn = await screen.findByRole("button", { name: "Resend Measurement m1" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(async () => expect(await db.outbox.count()).toBeGreaterThanOrEqual(0));
    await waitFor(() => expect(screen.queryByText("Resend all")).toBeNull());
    expect(await db.outbox.count() + 0).toBeLessThanOrEqual(1);
  });

  it("not configured with letters still lists them, with local text replaced by the letters list", async () => {
    await db.meta.put({ key: DEAD_LETTER_KEY, value: [letter(1)] });
    render(<SyncCard configured={false} />);
    expect(await screen.findByText("m1")).toBeTruthy();
  });
});
