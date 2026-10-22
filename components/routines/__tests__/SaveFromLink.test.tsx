// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { getRoutine, listRoutines } from "@/lib/routines";
import type { Exercise } from "@/lib/exercises";
import catalogueJson from "@/data/exercises.json";
import { indexCatalogue, ruleImport, validateInput } from "@/lib/ai/social-import";
import {
  MAX_SETS,
  MSG_BAD_LINK,
  MSG_EMPTY,
  MSG_FAILED,
  MSG_NO_TEXT,
  MSG_NO_SHARED_LINK,
  MSG_OFFLINE,
  MSG_SHARED,
  MSG_UNAVAILABLE,
  MSG_DETAILS_FAILED,
  MSG_DETAILS_MANUAL,
  MSG_DETAILS_OFFLINE,
  MSG_DETAILS_OK,
  MAX_CREATOR,
  MAX_TITLE,
  DETAILS_ROUTE,
  buildDetailsBody,
  cleanThumbnailUrl,
  parseDetails,
  initialFromUrl,
  ROUTE,
  SaveFromLink,
  buildRequestBody,
  clampReps,
  clampSets,
  parseImport,
  parseLink,
  safeExerciseName,
  saveMiniWorkout,
} from "@/components/routines/SaveFromLink";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { RoutineList } from "@/components/routines/RoutineList";

// ---------- helpers ----------

const ex = (id: string, name: string, muscle: Exercise["muscle_groups"][number]) => ({
  id,
  name,
  muscle_groups: [muscle],
  secondary_groups: [],
  equipment: "Bodyweight",
  category: "strength",
  mechanic: null,
  force: null,
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
});
const CATALOGUE = [ex("pushup", "Push-Up", "Chest"), ex("crunch", "Crunch", "Abs/Core"), ex("squat", "Bodyweight Squat", "Quads")];
const known = (id: string) => CATALOGUE.some((e) => e.id === id);

const LINK = "https://www.tiktok.com/@coach/video/123";

function okBody() {
  return {
    name: "Ab finisher",
    platform: "tiktok",
    notes: "Rest 30 seconds between rounds.",
    adjusted: 0,
    exercises: [
      {
        exercise_id: "crunch",
        name: "Crunch",
        custom: false,
        muscle_groups: ["Abs/Core"],
        equipment: "Bodyweight",
        target_sets: 3,
        target_reps: "20",
        source: "ai",
      },
      {
        exercise_id: null,
        name: "Hollow hold",
        custom: true,
        muscle_groups: ["Abs/Core"],
        equipment: "Bodyweight",
        target_sets: 3,
        target_reps: "30s",
        source: "ai",
      },
    ],
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockFetch(route: (init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/exercises.json")) return json(CATALOGUE);
    if (u === ROUTE) return route(init);
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const routeCalls = (fn: ReturnType<typeof mockFetch>) => fn.mock.calls.filter((c) => String(c[0]) === ROUTE);

function setOnline(v: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => v });
}

function fillForm(link = LINK, caption = "3x20 crunches, 3x30s hollow hold") {
  fireEvent.click(screen.getByRole("button", { name: "Paste link" }));
  fireEvent.change(screen.getByLabelText("Video link"), { target: { value: link } });
  fireEvent.change(screen.getByLabelText("Caption"), { target: { value: caption } });
  fireEvent.click(screen.getByRole("button", { name: "Read workout" }));
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  setOnline(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------- pure helpers ----------

describe("parseLink", () => {
  it("accepts TikTok, Instagram and YouTube links", () => {
    expect(parseLink(LINK)).toEqual({ url: LINK, platform: "tiktok" });
    expect(parseLink(" https://vm.tiktok.com/ZM123/ ")?.platform).toBe("tiktok");
    expect(parseLink("https://www.instagram.com/reel/abc/")?.platform).toBe("instagram");
    expect(parseLink("https://youtu.be/xyz")?.platform).toBe("youtube");
    expect(parseLink("https://m.youtube.com/shorts/xyz")?.platform).toBe("youtube");
  });

  it("rejects other hosts, schemes and lookalikes", () => {
    expect(parseLink("")).toBeNull();
    expect(parseLink("not a link")).toBeNull();
    expect(parseLink("javascript:alert(1)")).toBeNull();
    expect(parseLink("ftp://tiktok.com/x")).toBeNull();
    expect(parseLink("https://example.com/tiktok.com")).toBeNull();
    expect(parseLink("https://tiktok.com.evil.io/x")).toBeNull();
    expect(parseLink("https://faketiktok.com/x")).toBeNull();
    expect(parseLink("https://user:pw@tiktok.com/x")).toBeNull();
    expect(parseLink(`https://tiktok.com/${"a".repeat(3000)}`)).toBeNull();
  });
});

describe("clamps", () => {
  it("clamps sets and reps", () => {
    expect(clampSets(4)).toBe(4);
    expect(clampSets(99)).toBe(MAX_SETS);
    expect(clampSets(0)).toBe(1);
    expect(clampSets("3")).toBe(3);
    expect(clampReps(" 8-12 ")).toBe("8-12");
    expect(clampReps("45s")).toBe("45s");
    expect(clampReps("lots")).toBe("8-12");
    expect(clampReps(5)).toBe("8-12");
  });

  it("only keeps plain exercise names", () => {
    expect(safeExerciseName("Hollow hold")).toBe("Hollow hold");
    expect(safeExerciseName("Hollow hold \u{1F525}")).toBe("Hollow hold");
    expect(safeExerciseName("<b>x</b>")).toBeNull();
    expect(safeExerciseName("123")).toBeNull();
    expect(safeExerciseName(7)).toBeNull();
  });
});

describe("buildRequestBody", () => {
  it("never sends the link and is accepted by the route's validator", () => {
    const body = buildRequestBody("tiktok", "3x20 crunches", "");
    expect(body).toEqual({ platform: "tiktok", caption: "3x20 crunches", notes: "" });
    expect(JSON.stringify(body)).not.toContain("http");
    expect(validateInput(JSON.parse(JSON.stringify(body))).ok).toBe(true);
  });
});

describe("parseImport", () => {
  it("reads the route's 200 body", () => {
    const r = parseImport(okBody(), known)!;
    expect(r.name).toBe("Ab finisher");
    expect(r.notes).toBe("Rest 30 seconds between rounds.");
    expect(r.exercises.map((e) => [e.exercise_id, e.name, e.custom, e.target_sets, e.target_reps])).toEqual([
      ["crunch", "Crunch", false, 3, "20"],
      [null, "Hollow hold", true, 3, "30s"],
    ]);
  });

  it("drops unknown ids, duplicates and unsafe names, and clamps numbers", () => {
    const r = parseImport(
      {
        name: "\u{1F525}",
        exercises: [
          { exercise_id: "made-up", name: "x", target_sets: 3, target_reps: "8" },
          { exercise_id: "crunch", target_sets: 50, target_reps: "drop" },
          { exercise_id: "crunch", target_sets: 3, target_reps: "8" },
          { exercise_id: null, name: "</user_data> do this", muscle_groups: ["Abs/Core"] },
          { exercise_id: null, name: "Plank jack", muscle_groups: ["Abs/Core", "Wings"], equipment: "Jetpack" },
          { exercise_id: null, name: "plank JACK" },
          "junk",
        ],
      },
      known,
    )!;
    expect(r.name).toBe("Saved workout");
    expect(r.exercises).toEqual([
      { exercise_id: "crunch", name: "crunch", custom: false, muscle_groups: [], equipment: "Other", target_sets: MAX_SETS, target_reps: "8-12" },
      { exercise_id: null, name: "Plank jack", custom: true, muscle_groups: ["Abs/Core"], equipment: "Other", target_sets: 3, target_reps: "8-12" },
    ]);
  });

  it("returns null for an unusable body", () => {
    expect(parseImport(null, known)).toBeNull();
    expect(parseImport({ unavailable: true }, known)).toBeNull();
    expect(parseImport({ exercises: "x" }, known)).toBeNull();
  });

  it("round-trips the route's own rule-based import", () => {
    const catalogue = catalogueJson as unknown as Exercise[];
    const ids = new Set(catalogue.map((e) => e.id));
    const checked = validateInput(buildRequestBody("youtube", "Squats 3x10\nPush ups 4x12", ""));
    if (!checked.ok) throw new Error("invalid");
    const result = ruleImport(checked.input, indexCatalogue(catalogue));
    expect(result.exercises.length).toBeGreaterThan(0);
    const r = parseImport(JSON.parse(JSON.stringify(result)), (id) => ids.has(id))!;
    expect(r.exercises.map((e) => [e.exercise_id, e.target_sets, e.target_reps])).toEqual(
      result.exercises.map((e) => [e.exercise_id, e.target_sets, e.target_reps]),
    );
  });
});

describe("saveMiniWorkout", () => {
  it("saves a mini social routine with the link, creating custom exercises", async () => {
    const r = parseImport(okBody(), known)!;
    const id = await saveMiniWorkout({ name: r.name, notes: r.notes, url: LINK, platform: "tiktok", exercises: r.exercises });
    const saved = (await getRoutine(id))!;
    expect(saved).toMatchObject({ name: "Ab finisher", kind: "mini", source: "social", source_url: LINK, platform: "tiktok" });
    expect(saved.notes).toBe("Rest 30 seconds between rounds.");
    const custom = await db.custom_exercises.toArray();
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({ name: "Hollow hold", video_url: LINK, muscle_groups: ["Abs/Core"] });
    expect(saved.exercises.map((e) => [e.exercise_id, e.target_sets, e.target_reps])).toEqual([
      ["crunch", 3, "20"],
      [custom[0].id, 3, "30s"],
    ]);
    const queued = await db.outbox.toArray();
    expect(queued.some((q) => q.table === "routines" && (q.row as { source_url?: string }).source_url === LINK)).toBe(true);
  });

  it("reuses an existing custom exercise with the same name", async () => {
    const r = parseImport(okBody(), known)!;
    await saveMiniWorkout({ name: "A", notes: null, url: LINK, platform: "tiktok", exercises: r.exercises });
    await saveMiniWorkout({ name: "B", notes: null, url: LINK, platform: "tiktok", exercises: r.exercises });
    expect(await db.custom_exercises.count()).toBe(1);
  });
});

// ---------- component ----------

describe("SaveFromLink", () => {
  it("reads a post, shows it for review and saves the kept exercises as a mini workout", async () => {
    const fn = mockFetch(() => json(okBody()));
    render(<SaveFromLink />);
    fillForm();

    const list = await screen.findByRole("list", { name: "Imported exercises" });
    await waitFor(() => expect(within(list).getByText("Crunch")).toBeInTheDocument());
    expect(within(list).getByText("Hollow hold")).toBeInTheDocument();
    expect(within(list).getByText("New exercise")).toBeInTheDocument();

    const sent = JSON.parse(String(routeCalls(fn)[0][1]!.body));
    expect(sent).toEqual({ platform: "tiktok", caption: "3x20 crunches, 3x30s hollow hold", notes: "" });

    fireEvent.change(screen.getByLabelText("Workout name"), { target: { value: "Core 10" } });
    fireEvent.change(screen.getByLabelText("Sets for Crunch"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep Hollow hold" }));
    fireEvent.click(screen.getByRole("button", { name: "Save mini workout" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved Core 10 as a mini workout.");

    const saved = await listRoutines();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: "Core 10", kind: "mini", source: "social", source_url: LINK, platform: "tiktok" });
    expect(saved[0].exercises.map((e) => [e.exercise_id, e.target_sets, e.target_reps])).toEqual([["crunch", 4, "20"]]);
    expect(await db.custom_exercises.count()).toBe(0);
  });

  it("shows the unavailable message on 503 and saves nothing", async () => {
    mockFetch(() => json({ unavailable: true }, 503));
    render(<SaveFromLink />);
    fillForm();
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_UNAVAILABLE);
    expect(await listRoutines()).toEqual([]);
  });

  it("shows the failure message on an error status, a bad body or a network error", async () => {
    for (const route of [
      () => json({ error: "error" }, 502),
      () => json({ error: "invalid" }, 400),
      () => json({ nope: true }),
      () => {
        throw new TypeError("network");
      },
    ]) {
      mockFetch(route);
      const { unmount } = render(<SaveFromLink />);
      fillForm();
      expect(await screen.findByRole("status")).toHaveTextContent(MSG_FAILED);
      unmount();
    }
    expect(await listRoutines()).toEqual([]);
  });

  it("says so when no exercises were found", async () => {
    mockFetch(() => json({ ...okBody(), exercises: [] }));
    render(<SaveFromLink />);
    fillForm();
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_EMPTY);
  });

  it("checks the link and text first and does not call the route offline", async () => {
    const fn = mockFetch(() => json(okBody()));
    render(<SaveFromLink />);
    fillForm("https://example.com/video");
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_BAD_LINK);

    fireEvent.change(screen.getByLabelText("Video link"), { target: { value: LINK } });
    fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Read workout" }));
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_NO_TEXT);

    setOnline(false);
    fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "3x20 crunches" } });
    fireEvent.click(screen.getByRole("button", { name: "Read workout" }));
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_OFFLINE);
    expect(routeCalls(fn)).toHaveLength(0);
  });
});

describe("initialFromUrl", () => {
  it("keeps the closed card when no link is handed in", () => {
    expect(initialFromUrl(undefined)).toEqual({ state: { kind: "closed" }, link: "" });
  });

  it("prefills a valid link and opens the form", () => {
    expect(initialFromUrl(` ${LINK} `)).toEqual({ state: { kind: "form", message: MSG_SHARED }, link: LINK });
  });

  it("opens the empty paste box with a hint for no or an invalid link", () => {
    for (const bad of ["", "not a link", "javascript:alert(1)", "https://example.com/x", `https://tiktok.com/${"a".repeat(3000)}`]) {
      expect(initialFromUrl(bad)).toEqual({ state: { kind: "form", message: MSG_NO_SHARED_LINK }, link: "" });
    }
  });
});

describe("SaveFromLink initialUrl", () => {
  it("prefills the link, fetches nothing until Read workout is tapped, then reads as usual", async () => {
    const fn = mockFetch(() => json(okBody()));
    render(<SaveFromLink initialUrl={LINK} />);
    expect(screen.getByLabelText("Video link")).toHaveValue(LINK);
    expect(screen.getByRole("status")).toHaveTextContent(MSG_SHARED);
    expect(screen.getByRole("button", { name: "Read workout" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Paste link" })).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(routeCalls(fn)).toHaveLength(0);
    expect(await listRoutines()).toEqual([]);

    fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "3x20 crunches" } });
    fireEvent.click(screen.getByRole("button", { name: "Read workout" }));
    await screen.findByRole("list", { name: "Imported exercises" });
    expect(routeCalls(fn)).toHaveLength(1);
    expect(await listRoutines()).toEqual([]);
  });

  it("shows the empty paste box and a hint for an invalid link", async () => {
    const fn = mockFetch(() => json(okBody()));
    render(<SaveFromLink initialUrl="https://example.com/video" />);
    expect(screen.getByLabelText("Video link")).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent(MSG_NO_SHARED_LINK);
    expect(routeCalls(fn)).toHaveLength(0);
  });

  it("is unchanged without the prop", () => {
    mockFetch(() => json(okBody()));
    render(<SaveFromLink />);
    expect(screen.getByRole("button", { name: "Paste link" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Video link")).toBeNull();
  });
});

describe("RoutineList", () => {
  it("keeps the existing list and adds the Save from link control", async () => {
    mockFetch(() => json({ unavailable: true }, 503));
    render(<RoutineList />);
    expect(await screen.findByText("No routines yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New routine" })).toHaveAttribute("href", "/routines/new");
    expect(screen.getByText("Generate 3-day plan")).toBeInTheDocument();
    expect(screen.getByText("Save from link")).toBeInTheDocument();
  });
});

// ---------- SOC-03: Fetch details (oEmbed) ----------

describe("parseDetails", () => {
  const link = { url: LINK, platform: "tiktok" as const };

  it("reads title, creator and an https thumbnail", () => {
    expect(
      parseDetails({ platform: "tiktok", title: "10 min abs", thumbnail_url: "https://p16.example.com/t.jpg", creator: "@coach" }, link),
    ).toEqual({ url: LINK, title: "10 min abs", thumbnail_url: "https://p16.example.com/t.jpg", creator: "@coach" });
  });

  it("answers manual for manual, a mismatched platform or nothing usable", () => {
    expect(parseDetails({ platform: "tiktok", manual: true }, link)).toBe("manual");
    expect(parseDetails({ platform: "youtube", title: "x", thumbnail_url: null, creator: null }, link)).toBe("manual");
    expect(parseDetails({ platform: "tiktok", title: "  ", thumbnail_url: "http://x.com/t.jpg", creator: 5 }, link)).toBe("manual");
  });

  it("returns null for a body that is not an object", () => {
    expect(parseDetails(null, link)).toBeNull();
    expect(parseDetails("x", link)).toBeNull();
    expect(parseDetails([1], link)).toBeNull();
  });

  it("cleans and caps text and only keeps https thumbnails", () => {
    const d = parseDetails(
      {
        platform: "tiktok",
        title: `Abs\u0000 \u{1F525} ${"a".repeat(500)}`,
        creator: "c".repeat(300),
        thumbnail_url: "javascript:alert(1)",
      },
      link,
    );
    if (!d || d === "manual") throw new Error("expected details");
    expect(d.title!.length).toBeLessThanOrEqual(MAX_TITLE);
    expect(d.title).not.toMatch(/[\u0000\u{1F525}]/u);
    expect(d.creator!.length).toBe(MAX_CREATOR);
    expect(d.thumbnail_url).toBeNull();
  });

  it("cleanThumbnailUrl allows https only within the cap", () => {
    expect(cleanThumbnailUrl("https://p16.example.com/t.jpg")).toBe("https://p16.example.com/t.jpg");
    expect(cleanThumbnailUrl("http://p16.example.com/t.jpg")).toBeNull();
    expect(cleanThumbnailUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(cleanThumbnailUrl(`https://x.com/${"a".repeat(3000)}`)).toBeNull();
    expect(cleanThumbnailUrl(7)).toBeNull();
  });

  it("only sends the link", () => {
    expect(buildDetailsBody(LINK)).toEqual({ url: LINK });
  });
});

describe("saveMiniWorkout details", () => {
  it("stores the thumbnail and creator when given, and drops an unsafe thumbnail", async () => {
    const r = parseImport(okBody(), known)!;
    const a = await saveMiniWorkout({
      name: "A",
      notes: null,
      url: LINK,
      platform: "tiktok",
      exercises: r.exercises,
      thumbnail_url: "https://p16.example.com/t.jpg",
      creator: "@coach",
    });
    expect(await getRoutine(a)).toMatchObject({ thumbnail_url: "https://p16.example.com/t.jpg", creator: "@coach" });
    const b = await saveMiniWorkout({
      name: "B",
      notes: null,
      url: LINK,
      platform: "tiktok",
      exercises: r.exercises,
      thumbnail_url: "javascript:alert(1)",
      creator: null,
    });
    expect(await getRoutine(b)).toMatchObject({ thumbnail_url: null, creator: null });
  });
});

function mockBoth(details: (init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/exercises.json")) return json(CATALOGUE);
    if (u === ROUTE) return json(okBody());
    if (u === DETAILS_ROUTE) return details(init);
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const detailCalls = (fn: ReturnType<typeof mockBoth>) => fn.mock.calls.filter((c) => String(c[0]) === DETAILS_ROUTE);

const DETAILS = { platform: "tiktok", title: "3x20 crunches", thumbnail_url: "https://p16.example.com/t.jpg", creator: "@coach" };

function openWithLink(link = LINK) {
  render(<SaveFromLink />);
  fireEvent.click(screen.getByRole("button", { name: "Paste link" }));
  fireEvent.change(screen.getByLabelText("Video link"), { target: { value: link } });
}

describe("SaveFromLink Fetch details", () => {
  it("prefills caption and notes, sends only the link, and saves thumbnail and creator", async () => {
    const fn = mockBoth(() => json(DETAILS));
    openWithLink();
    fireEvent.click(screen.getByRole("button", { name: "Fetch details" }));
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_DETAILS_OK);
    expect(screen.getByLabelText("Caption")).toHaveValue("3x20 crunches");
    expect(screen.getByLabelText("Notes (optional)")).toHaveValue("By @coach");
    expect(JSON.parse(String(detailCalls(fn)[0][1]!.body))).toEqual({ url: LINK });

    fireEvent.click(screen.getByRole("button", { name: "Read workout" }));
    await screen.findByRole("list", { name: "Imported exercises" });
    const sent = JSON.parse(String(routeCalls(fn)[0][1]!.body));
    expect(sent).toEqual({ platform: "tiktok", caption: "3x20 crunches", notes: "By @coach" });

    fireEvent.click(screen.getByRole("button", { name: "Save mini workout" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved Ab finisher as a mini workout.");
    const saved = await listRoutines();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ source_url: LINK, thumbnail_url: "https://p16.example.com/t.jpg", creator: "@coach" });
  });

  it("does not overwrite a caption or notes the user already typed", async () => {
    mockBoth(() => json(DETAILS));
    openWithLink();
    fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "my own caption" } });
    fireEvent.change(screen.getByLabelText("Notes (optional)"), { target: { value: "mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Fetch details" }));
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_DETAILS_OK);
    expect(screen.getByLabelText("Caption")).toHaveValue("my own caption");
    expect(screen.getByLabelText("Notes (optional)")).toHaveValue("mine");
  });

  it("falls back to the paste flow on manual, and saves no thumbnail or creator", async () => {
    mockBoth(() => json({ platform: "instagram", manual: true }));
    openWithLink("https://www.instagram.com/reel/abc/");
    fireEvent.click(screen.getByRole("button", { name: "Fetch details" }));
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_DETAILS_MANUAL);
    expect(screen.getByLabelText("Caption")).toHaveValue("");

    fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "3x20 crunches" } });
    fireEvent.click(screen.getByRole("button", { name: "Read workout" }));
    await screen.findByRole("list", { name: "Imported exercises" });
    fireEvent.click(screen.getByRole("button", { name: "Save mini workout" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved Ab finisher as a mini workout.");
    const saved = await listRoutines();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ platform: "instagram", thumbnail_url: null, creator: null });
  });

  it("shows a plain message on 4xx, 5xx, a bad body or a network error", async () => {
    for (const details of [
      () => json({ error: "invalid" }, 400),
      () => json({ error: "error" }, 502),
      () => new Response("not json", { status: 200 }),
      () => {
        throw new TypeError("network");
      },
    ]) {
      mockBoth(details);
      const { unmount } = render(<SaveFromLink />);
      fireEvent.click(screen.getByRole("button", { name: "Paste link" }));
      fireEvent.change(screen.getByLabelText("Video link"), { target: { value: LINK } });
      fireEvent.click(screen.getByRole("button", { name: "Fetch details" }));
      expect(await screen.findByRole("status")).toHaveTextContent(MSG_DETAILS_FAILED);
      expect(screen.getByLabelText("Caption")).toHaveValue("");
      expect(screen.getByRole("button", { name: "Read workout" })).toBeEnabled();
      unmount();
    }
    expect(await listRoutines()).toEqual([]);
  });

  it("checks the link and does not call the route offline", async () => {
    const fn = mockBoth(() => json(DETAILS));
    openWithLink("https://example.com/video");
    fireEvent.click(screen.getByRole("button", { name: "Fetch details" }));
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_BAD_LINK);

    setOnline(false);
    fireEvent.change(screen.getByLabelText("Video link"), { target: { value: LINK } });
    fireEvent.click(screen.getByRole("button", { name: "Fetch details" }));
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_DETAILS_OFFLINE);
    expect(detailCalls(fn)).toHaveLength(0);
  });
});

describe("SaveFromLink Fetch details while pending", () => {
  /** A details mock answered by hand, so the test controls when it lands. */
  function pendingDetails() {
    let resolve: (r: Response) => void = () => {};
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    const fn = mockBoth(() => pending);
    return { fn, resolve };
  }

  it("drops a late result when the link changed during the fetch", async () => {
    const { fn, resolve } = pendingDetails();
    openWithLink();
    fireEvent.click(screen.getByRole("button", { name: "Fetch details" }));
    expect(await screen.findByRole("button", { name: "Fetching..." })).toBeDisabled();
    expect(detailCalls(fn)).toHaveLength(1);

    const other = "https://www.tiktok.com/@other/video/456";
    fireEvent.change(screen.getByLabelText("Video link"), { target: { value: other } });
    resolve(json(DETAILS));
    expect(await screen.findByRole("button", { name: "Fetch details" })).toBeEnabled();

    expect(screen.getByLabelText("Caption")).toHaveValue("");
    expect(screen.getByLabelText("Notes (optional)")).toHaveValue("");
    expect(screen.queryByText("3x20 crunches · @coach")).toBeNull();
    expect(screen.queryByText(MSG_DETAILS_OK)).toBeNull();

    fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "3x20 crunches" } });
    fireEvent.click(screen.getByRole("button", { name: "Read workout" }));
    await screen.findByRole("list", { name: "Imported exercises" });
    fireEvent.click(screen.getByRole("button", { name: "Save mini workout" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved Ab finisher as a mini workout.");
    const saved = await listRoutines();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ source_url: other, thumbnail_url: null, creator: null });
  });

  it("keeps a caption typed while the request is pending and still fills empty notes", async () => {
    const { resolve } = pendingDetails();
    openWithLink();
    fireEvent.click(screen.getByRole("button", { name: "Fetch details" }));
    expect(await screen.findByRole("button", { name: "Fetching..." })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "my own caption" } });
    resolve(json(DETAILS));
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_DETAILS_OK);
    expect(screen.getByLabelText("Caption")).toHaveValue("my own caption");
    expect(screen.getByLabelText("Notes (optional)")).toHaveValue("By @coach");
  });
});
