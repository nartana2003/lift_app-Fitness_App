// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db, type PhotoRow } from "@/lib/offline/db";
import {
  FINISH_POSES,
  FinishPhotos,
  PhotosTab,
  MSG_FINISH_PHOTO_FAILED,
  finishPhotoRow,
  photoMonths,
  saveFinishPhoto,
  workoutPhotos,
  type ProgressPhotoRow,
} from "@/components/progress/PhotosTab";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const jpeg = (tag = "x") => new Blob([`jpeg-${tag}`], { type: "image/jpeg" });
const file = (name = "a.jpg") => new File(["raw"], name, { type: "image/jpeg" });

const origCreate = URL.createObjectURL;
const origRevoke = URL.revokeObjectURL;
beforeAll(() => {
  URL.createObjectURL = vi.fn(() => "blob:test");
  URL.revokeObjectURL = vi.fn();
});
afterAll(() => {
  URL.createObjectURL = origCreate;
  URL.revokeObjectURL = origRevoke;
});

beforeEach(async () => {
  await db.photos.clear();
});

const fileInput = (label: string) => screen.getByLabelText(`${label} photo file`) as HTMLInputElement;
const pick = (label: string, f: File = file()) => fireEvent.change(fileInput(label), { target: { files: [f] } });

// ---------- pure helpers ----------

describe("finishPhotoRow", () => {
  it("tags the pose and links the workout", () => {
    const blob = jpeg();
    const row = finishPhotoRow({ id: "p1", workoutId: "w1", pose: "side", blob, takenAt: "2026-10-01T09:00:00.000Z" });
    expect(row).toEqual({ id: "p1", taken_at: "2026-10-01T09:00:00.000Z", pose: "side", blob, workout_id: "w1" });
  });

  it("is still a plain photos row for the gallery helpers", () => {
    const row: PhotoRow = finishPhotoRow({ id: "p1", workoutId: "w1", pose: "front", blob: jpeg(), takenAt: "2026-10-01T09:00:00.000Z" });
    expect(photoMonths([row])).toHaveLength(1);
  });
});

describe("FINISH_POSES", () => {
  it("offers front, side and back in that order", () => {
    expect(FINISH_POSES.map((p) => p.v)).toEqual(["front", "side", "back"]);
  });
});

// ---------- storage ----------

describe("saveFinishPhoto / workoutPhotos", () => {
  it("stores one row per pose linked to the workout, front-side-back order", async () => {
    await saveFinishPhoto("w1", "back", jpeg("b"), "pb", "2026-10-01T09:00:02.000Z");
    await saveFinishPhoto("w1", "front", jpeg("f"), "pf", "2026-10-01T09:00:00.000Z");
    await saveFinishPhoto("w1", "side", jpeg("s"), "ps", "2026-10-01T09:00:01.000Z");
    await saveFinishPhoto("w2", "front", jpeg("o"), "po", "2026-10-01T09:00:00.000Z");
    const rows = await workoutPhotos("w1");
    expect(rows.map((r) => [r.id, r.pose, r.workout_id])).toEqual([
      ["pf", "front", "w1"],
      ["ps", "side", "w1"],
      ["pb", "back", "w1"],
    ]);
  });

  it("replaces a pose when saved again with the same id", async () => {
    await saveFinishPhoto("w1", "front", jpeg("1"), "pf");
    await saveFinishPhoto("w1", "front", jpeg("2"), "pf");
    expect(await db.photos.count()).toBe(1);
  });

  it("ignores gallery photos with no workout", async () => {
    await db.photos.put({ id: "g1", taken_at: "2026-10-01T09:00:00.000Z", pose: "front", blob: jpeg() });
    expect(await workoutPhotos("w1")).toEqual([]);
  });
});

// ---------- component ----------

describe("FinishPhotos", () => {
  const prepare = vi.fn(async () => jpeg("shrunk"));

  beforeEach(() => prepare.mockClear());

  it("offers a camera input per pose and Skip saves nothing", async () => {
    const onDone = vi.fn();
    render(<FinishPhotos workoutId="w1" onDone={onDone} prepare={prepare} />);
    expect(screen.getByRole("heading", { name: "Progress photos" })).toBeInTheDocument();
    for (const label of ["Front", "Side", "Back"]) {
      const input = fileInput(label);
      expect(input).toHaveAttribute("capture", "environment");
      expect(input).toHaveAttribute("accept", "image/*");
      expect(screen.getByRole("button", { name: `Take ${label.toLowerCase()} photo` })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(await db.photos.count()).toBe(0);
  });

  it("saves each pose linked to the workout and Done finishes", async () => {
    const onDone = vi.fn();
    render(<FinishPhotos workoutId="w1" onDone={onDone} prepare={prepare} />);
    pick("Front");
    await screen.findByRole("button", { name: "Retake front photo" });
    pick("Back");
    await screen.findByRole("button", { name: "Retake back photo" });

    const rows = (await db.photos.toArray()) as ProgressPhotoRow[];
    expect(rows.map((r) => [r.pose, r.workout_id]).sort()).toEqual([
      ["back", "w1"],
      ["front", "w1"],
    ]);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done (2/3)" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("retaking a pose replaces its photo", async () => {
    render(<FinishPhotos workoutId="w1" onDone={() => {}} prepare={prepare} />);
    pick("Side");
    await screen.findByRole("button", { name: "Retake side photo" });
    const first = (await db.photos.toArray())[0];
    pick("Side");
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    await waitFor(async () => {
      const rows = await db.photos.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(first.id);
      expect(rows[0].taken_at >= first.taken_at).toBe(true);
    });
  });

  it("shows a plain message when a photo cannot be read, and saves nothing", async () => {
    const bad = vi.fn(async () => {
      throw new Error("decode");
    });
    render(<FinishPhotos workoutId="w1" onDone={() => {}} prepare={bad} />);
    pick("Front");
    expect(await screen.findByText(MSG_FINISH_PHOTO_FAILED)).toBeInTheDocument();
    expect(await db.photos.count()).toBe(0);
    expect(screen.getByRole("button", { name: "Skip" })).toBeEnabled();
  });
});

// ---------- gallery viewer ----------

describe("PhotosTab viewer", () => {
  beforeEach(async () => {
    await db.photos.put(finishPhotoRow({ id: "p1", workoutId: "w1", pose: "front", blob: jpeg("f"), takenAt: "2026-10-01T09:00:00.000Z" }));
    await db.photos.put({ id: "g1", taken_at: "2026-10-02T09:00:00.000Z", pose: "back", blob: jpeg("b") });
  });

  it("links a Finish-screen photo to its workout", async () => {
    render(<PhotosTab />);
    fireEvent.click(await screen.findByRole("button", { name: /· front$/ }));
    const link = await screen.findByRole("link", { name: "View workout" });
    expect(link).toHaveAttribute("href", "/history/w1");
  });

  it("shows no workout link for a gallery photo", async () => {
    render(<PhotosTab />);
    fireEvent.click(await screen.findByRole("button", { name: /· back$/ }));
    expect(await screen.findByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View workout" })).toBeNull();
  });
});
