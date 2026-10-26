// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { getRoutine, listRoutines } from "@/lib/routines";
import type { Exercise } from "@/lib/exercises";
import catalogueJson from "@/data/exercises.json";
import { indexCatalogue, ruleImport, validateInput } from "@/lib/ai/social-import";
import {
  fetchLinkThumbnail,
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
  MSG_NO_MUSCLE,
  MSG_NOTHING_NEW,
  DEFAULT_SAVE_AS,
  SAVE_AS_OPTIONS,
  NoMuscleError,
  saveExercisesFromLink,
  saveExercisesLabel,
  saveRoutineFromLink,
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
  linkableDays,
} from "@/components/routines/SaveFromLink";
import { saveSplit, type Split } from "@/lib/splits";

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
  it("reads a post, shows it for review and saves the kept exercises as a routine (SOC-06 default)", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Save routine" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved Core 10 as a routine.");

    const saved = await listRoutines();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: "Core 10", kind: "routine", source: "social", source_url: LINK, platform: "tiktok" });
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
    expect(await screen.findByRole("link", { name: "New routine" })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Save routine" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved Ab finisher as a routine.");
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
    fireEvent.click(screen.getByRole("button", { name: "Save routine" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved Ab finisher as a routine.");
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
    fireEvent.click(screen.getByRole("button", { name: "Save routine" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved Ab finisher as a routine.");
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

// ---------- SOC-06: Save as Routine or Exercise ----------

describe("Save as options", () => {
  it("offers exactly Routine (the default) and Exercise", () => {
    expect(SAVE_AS_OPTIONS.map((o) => o.label)).toEqual(["Routine", "Exercise"]);
    expect(DEFAULT_SAVE_AS).toBe("routine");
    expect(saveExercisesLabel(1)).toBe("Save 1 exercise");
    expect(saveExercisesLabel(2)).toBe("Save 2 exercises");
  });
});

describe("saveRoutineFromLink", () => {
  it("saves a normal social routine with the link, thumbnail and creator", async () => {
    const r = parseImport(okBody(), known)!;
    const id = await saveRoutineFromLink({
      name: r.name,
      notes: r.notes,
      url: LINK,
      platform: "tiktok",
      exercises: r.exercises,
      thumbnail_url: "https://p16.example.com/t.jpg",
      creator: "@coach",
    });
    const saved = (await getRoutine(id))!;
    expect(saved).toMatchObject({
      name: "Ab finisher",
      kind: "routine",
      source: "social",
      source_url: LINK,
      platform: "tiktok",
      thumbnail_url: "https://p16.example.com/t.jpg",
      creator: "@coach",
    });
    expect(saved.exercises).toHaveLength(2);
    const queued = await db.outbox.toArray();
    expect(
      queued.some((q) => q.table === "routines" && (q.row as { kind?: string; source_url?: string }).kind === "routine" && (q.row as { source_url?: string }).source_url === LINK),
    ).toBe(true);
  });

  it("leaves saveMiniWorkout saving kind mini", async () => {
    const r = parseImport(okBody(), known)!;
    const id = await saveMiniWorkout({ name: "M", notes: null, url: LINK, platform: "tiktok", exercises: r.exercises });
    expect((await getRoutine(id))!.kind).toBe("mini");
  });
});

describe("saveExercisesFromLink", () => {
  const item = (name: string, muscles: Exercise["muscle_groups"], exercise_id: string | null = null) => ({
    exercise_id,
    name,
    custom: exercise_id === null,
    muscle_groups: muscles,
    equipment: "Bodyweight" as const,
    target_sets: 3,
    target_reps: "10",
  });

  it("saves new moves as custom exercises with the link as video and creates no routine", async () => {
    const res = await saveExercisesFromLink({
      url: LINK,
      exercises: [item("Hollow hold", ["Abs/Core"]), item("Crunch", ["Abs/Core"], "crunch"), item("Bear crawl", ["Shoulders", "Abs/Core"])],
      knownNames: CATALOGUE.map((e) => e.name),
    });
    expect(res).toEqual({ saved: ["Hollow hold", "Bear crawl"], existing: ["Crunch"] });
    const custom = await db.custom_exercises.toArray();
    expect(custom.map((c) => [c.name, c.video_url, c.muscle_groups, c.equipment]).sort()).toEqual(
      [
        ["Bear crawl", LINK, ["Shoulders", "Abs/Core"], "Bodyweight"],
        ["Hollow hold", LINK, ["Abs/Core"], "Bodyweight"],
      ].sort(),
    );
    expect(await listRoutines()).toEqual([]);
    const queued = await db.outbox.toArray();
    expect(queued.filter((q) => q.table === "exercises")).toHaveLength(2);
    expect(queued.some((q) => q.table === "routines" || q.table === "routine_exercises")).toBe(false);
  });

  it("reports catalogue names and already-saved custom exercises without duplicating", async () => {
    await saveExercisesFromLink({ url: LINK, exercises: [item("Hollow hold", ["Abs/Core"])] });
    const res = await saveExercisesFromLink({
      url: LINK,
      exercises: [item("hollow HOLD", ["Abs/Core"]), item("push-up", ["Chest"])],
      knownNames: ["Push-Up"],
    });
    expect(res).toEqual({ saved: [], existing: ["hollow HOLD", "push-up"] });
    expect(await db.custom_exercises.count()).toBe(1);
  });

  it("writes nothing when a new move has no muscle group", async () => {
    await expect(
      saveExercisesFromLink({ url: LINK, exercises: [item("Hollow hold", ["Abs/Core"]), item("Bear crawl", [])] }),
    ).rejects.toBeInstanceOf(NoMuscleError);
    expect(await db.custom_exercises.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });
});

describe("SaveFromLink Save as", () => {
  async function review() {
    const fn = mockFetch(() => json(okBody()));
    render(<SaveFromLink />);
    fillForm();
    const list = await screen.findByRole("list", { name: "Imported exercises" });
    await waitFor(() => expect(within(list).getByText("Crunch")).toBeInTheDocument());
    return fn;
  }

  it("shows the new description and no mini workout option", async () => {
    mockFetch(() => json(okBody()));
    render(<SaveFromLink />);
    expect(
      screen.getByText("Save a workout from a TikTok, Instagram or YouTube link as a routine, or a single move as an exercise."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/as a mini workout/)).toBeNull();
    fillForm();
    await screen.findByRole("list", { name: "Imported exercises" });
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("value"))).toEqual(["routine", "exercise"]);
    expect(screen.queryByRole("button", { name: /mini workout/i })).toBeNull();
    expect(screen.queryByText(/mini workout/i)).toBeNull();
  });

  it("defaults to Routine with sets and reps shown", async () => {
    await review();
    expect(screen.getByRole("radio", { name: "Routine" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Exercise" })).not.toBeChecked();
    expect(screen.getByLabelText("Sets for Crunch")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save routine" })).toBeEnabled();
  });

  it("saves the ticked new move as an exercise, reports the catalogue one and creates no routine", async () => {
    await review();
    fireEvent.click(screen.getByRole("radio", { name: "Exercise" }));
    expect(screen.queryByLabelText("Sets for Crunch")).toBeNull();
    expect(screen.queryByLabelText("Reps for Hollow hold")).toBeNull();
    expect(screen.getByText("Already in your exercises")).toBeInTheDocument();
    const group = screen.getByRole("group", { name: "Muscle groups for Hollow hold" });
    expect(within(group).getByRole("button", { name: "Abs/Core" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(group).getByRole("button", { name: "Glutes" }));
    expect(within(group).getByRole("button", { name: "Glutes" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Save 1 exercise" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Saved 1 exercise: Hollow hold. Already in your exercises: Crunch.",
    );
    const custom = await db.custom_exercises.toArray();
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({ name: "Hollow hold", video_url: LINK, muscle_groups: ["Abs/Core", "Glutes"] });
    expect(await listRoutines()).toEqual([]);
    const queued = await db.outbox.toArray();
    expect(queued.filter((q) => q.table === "exercises").map((q) => (q.row as { video_url?: string }).video_url)).toEqual([LINK]);
    expect(queued.some((q) => q.table === "routines")).toBe(false);
  });

  it("counts only ticked new moves and disables Save when none are new", async () => {
    await review();
    fireEvent.click(screen.getByRole("radio", { name: "Exercise" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep Hollow hold" }));
    expect(screen.getByRole("button", { name: "Save 0 exercises" })).toBeDisabled();
    expect(await db.custom_exercises.count()).toBe(0);
  });

  it("keeps the review open with a plain message when a new move has no muscle group", async () => {
    await review();
    fireEvent.click(screen.getByRole("radio", { name: "Exercise" }));
    const group = screen.getByRole("group", { name: "Muscle groups for Hollow hold" });
    fireEvent.click(within(group).getByRole("button", { name: "Abs/Core" }));
    fireEvent.click(screen.getByRole("button", { name: "Save 1 exercise" }));
    expect(await screen.findByRole("status")).toHaveTextContent(MSG_NO_MUSCLE);
    expect(screen.getByRole("list", { name: "Imported exercises" })).toBeInTheDocument();
    expect(await db.custom_exercises.count()).toBe(0);
    expect(await listRoutines()).toEqual([]);
  });

  it("reports a move already saved as a custom exercise and does not duplicate it", async () => {
    await saveExercisesFromLink({
      url: LINK,
      exercises: [{ exercise_id: null, name: "Hollow hold", custom: true, muscle_groups: ["Abs/Core"], equipment: "Bodyweight", target_sets: 3, target_reps: "10" }],
    });
    await review();
    fireEvent.click(screen.getByRole("radio", { name: "Exercise" }));
    await waitFor(() => expect(screen.getAllByText("Already in your exercises")).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Save 0 exercises" })).toBeDisabled();
    expect(await db.custom_exercises.count()).toBe(1);
    expect(MSG_NOTHING_NEW).toBe("These are already in your exercises.");
  });

  it("switching back to Routine shows sets and reps and saves a routine", async () => {
    await review();
    fireEvent.click(screen.getByRole("radio", { name: "Exercise" }));
    fireEvent.click(screen.getByRole("radio", { name: "Routine" }));
    expect(screen.getByLabelText("Sets for Crunch")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save routine" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved Ab finisher as a routine.");
    const saved = await listRoutines();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ kind: "routine", source: "social", source_url: LINK });
  });
});

// ---------- LINK-03: pick a split day for the saved routine ----------

const UL: Split = {
  name: "Upper / Lower",
  days: [
    { name: "Upper", muscles: ["Chest", "Back"] },
    { name: "Lower", muscles: ["Quads"] },
  ],
};

async function savedDayIds() {
  await saveSplit(UL);
  return ((await db.meta.get("split"))!.value as Split).days.map((d) => d.id!);
}

async function openReview() {
  mockFetch(() => json(okBody()));
  render(<SaveFromLink />);
  fillForm();
  await screen.findByRole("list", { name: "Imported exercises" });
}

describe("LINK-03 linkableDays", () => {
  it("lists days with an id in split order, naming unnamed days, skipping repeats", () => {
    expect(
      linkableDays({
        days: [
          { id: "a", name: "Push", muscles: [] },
          { name: "No id", muscles: [] },
          { id: "b", name: "  ", muscles: [] },
          { id: "a", name: "Repeat", muscles: [] },
        ],
      }),
    ).toEqual([
      { id: "a", name: "Push" },
      { id: "b", name: "Day 3" },
    ]);
    expect(linkableDays({ days: [] })).toEqual([]);
  });
});

describe("LINK-03 saveRoutineFromLink split day", () => {
  it("links the routine when a day is given and writes no field otherwise", async () => {
    const r = parseImport(okBody(), known)!;
    const linked = await saveRoutineFromLink({ name: "A", notes: null, url: LINK, platform: "tiktok", exercises: r.exercises, split_day_id: "day-1" });
    const plain = await saveRoutineFromLink({ name: "B", notes: null, url: LINK, platform: "tiktok", exercises: r.exercises });
    expect((await db.routines.get(linked))!.split_day_id).toBe("day-1");
    expect("split_day_id" in (await db.routines.get(plain))!).toBe(false);
  });
});

describe("LINK-03 SaveFromLink Split day picker", () => {
  it("is not shown when there is no split", async () => {
    await openReview();
    expect(screen.queryByRole("combobox", { name: "Split day" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save routine" })).toBeInTheDocument();
  });

  it("defaults to None and then saves with no link", async () => {
    await savedDayIds();
    await openReview();
    const picker = await screen.findByRole("combobox", { name: "Split day" });
    expect(picker).toHaveValue("");
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual(["None", "Upper", "Lower"]);
    fireEvent.click(screen.getByRole("button", { name: "Save routine" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved Ab finisher as a routine.");
    const [row] = await db.routines.toArray();
    expect("split_day_id" in row).toBe(false);
  });

  it("a chosen day links the saved routine", async () => {
    const [, lower] = await savedDayIds();
    await openReview();
    fireEvent.change(await screen.findByRole("combobox", { name: "Split day" }), { target: { value: lower } });
    fireEvent.click(screen.getByRole("button", { name: "Save routine" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved Ab finisher as a routine.");
    const saved = await listRoutines();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ kind: "routine", source: "social", source_url: LINK, split_day_id: lower });
  });

  it("is hidden in Exercise mode", async () => {
    await savedDayIds();
    await openReview();
    await screen.findByRole("combobox", { name: "Split day" });
    fireEvent.click(screen.getByRole("radio", { name: "Exercise" }));
    expect(screen.queryByRole("combobox", { name: "Split day" })).toBeNull();
  });
});

describe("fetchLinkThumbnail", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the https thumbnail for a supported link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ platform: "tiktok", title: "T", thumbnail_url: "https://img.example.com/t.jpg" }), { status: 200 })),
    );
    expect(await fetchLinkThumbnail(LINK)).toBe("https://img.example.com/t.jpg");
  });

  it("is null for an unsupported link without calling the route", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    expect(await fetchLinkThumbnail("https://example.com/v")).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it("is null when the lookup fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect(await fetchLinkThumbnail(LINK)).toBeNull();
  });
});
