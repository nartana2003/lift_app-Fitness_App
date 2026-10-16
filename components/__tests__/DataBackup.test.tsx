// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { BACKUP_FORMAT } from "@/lib/dataExport";
import { DataBackup } from "@/components/DataBackup";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

const fileOf = (text: string, name = "lift-backup.json") => {
  const f = new File([text], name, { type: "application/json" });
  // jsdom's File may lack text(); give it one that returns our content.
  Object.defineProperty(f, "text", { value: () => Promise.resolve(text) });
  return f;
};

const backupText = JSON.stringify({
  format: BACKUP_FORMAT,
  version: 1,
  exported_at: "2026-10-16T12:00:00.000Z",
  tables: {
    workouts: [{ id: "w1", started_at: "2026-10-01T10:00:00.000Z", ended_at: null, notes: null, routine_id: null }],
  },
});

function choose(file: File) {
  fireEvent.change(screen.getByLabelText("Backup file"), { target: { files: [file] } });
}

describe("DataBackup", () => {
  it("shows an error for an invalid file and writes nothing", async () => {
    render(<DataBackup />);
    choose(fileOf("{oops"));
    expect(await screen.findByText("This file is not valid JSON.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
    expect(await db.workouts.count()).toBe(0);
  });

  it("previews a valid file, imports only after confirming, and reports the result", async () => {
    render(<DataBackup />);
    choose(fileOf(backupText));
    const list = await screen.findByRole("list", { name: "Backup contents" });
    expect(list).toHaveTextContent("Workouts1");
    expect(await db.workouts.count()).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText("1 workouts added")).toBeInTheDocument();
    expect(await db.workouts.get("w1")).toBeDefined();
  });

  it("cancel leaves the database alone", async () => {
    render(<DataBackup />);
    choose(fileOf(backupText));
    await screen.findByRole("list", { name: "Backup contents" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Export data" })).toBeInTheDocument();
    expect(await db.workouts.count()).toBe(0);
  });

  it("export builds a JSON download", async () => {
    const createObjectURL = vi.fn(() => "blob:lift");
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await db.workouts.put({ id: "w1", started_at: "2026-10-01T10:00:00.000Z", ended_at: null, notes: null, routine_id: null });

    render(<DataBackup />);
    fireEvent.click(screen.getByRole("button", { name: "Export data" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe("application/json");
    expect(await screen.findByText(/^Saved lift-backup-\d{4}-\d{2}-\d{2}\.json$/)).toBeInTheDocument();
    click.mockRestore();
  });
});
