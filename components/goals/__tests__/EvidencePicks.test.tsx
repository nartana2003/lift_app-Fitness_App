// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import { DEFAULT_GOALS } from "@/lib/goals";
import type { Exercise } from "@/lib/exercises";
import type { MuscleGroup } from "@/lib/muscles";
import type { Split } from "@/lib/splits";
import {
  DISCLAIMER as ROUTE_DISCLAIMER,
  EVIDENCE_LEVELS as ROUTE_LEVELS,
  type EvidenceLevel as RouteLevel,
} from "@/lib/ai/evidence-picks";
import { SOURCE_KINDS as ROUTE_KINDS, type SourceKind as RouteKind } from "@/lib/ai/evidenceDomains";
import {
  CACHE_DAYS,
  EVIDENCE_DISCLAIMER,
  EVIDENCE_LEVELS,
  EVIDENCE_ROUTE,
  EvidencePicks,
  MSG_CANCELLED,
  MSG_EVIDENCE_OFFLINE,
  MSG_EVIDENCE_PARTIAL,
  MSG_EVIDENCE_UNAVAILABLE,
  MSG_EXPLAIN,
  MSG_REFRESH_FAILED,
  MSG_SEARCHING,
  SOURCE_KINDS,
  cacheKey,
  claimSegments,
  evidenceRequestBody,
  foundLabel,
  numberSources,
  parseEvidence,
  readEntry,
  ruleEvidencePicks,
  safeUrl,
  type CacheEntry,
  type EvidenceGoals,
  type EvidenceLevel,
  type SourceKind,
} from "@/components/goals/EvidencePicks";
import { CoachSetup, evidenceMusclesFor } from "@/components/goals/CoachSetup";

// ---------- compile-time checks: the local copies match lib/ai both ways ----------

const _levels = EVIDENCE_LEVELS satisfies readonly RouteLevel[];
const _routeLevels = ROUTE_LEVELS satisfies readonly EvidenceLevel[];
const _kinds = SOURCE_KINDS satisfies readonly RouteKind[];
const _routeKinds = ROUTE_KINDS satisfies readonly SourceKind[];
type _NoMissingLevel = [Exclude<RouteLevel, EvidenceLevel>] extends [never] ? true : never;
type _NoExtraLevel = [Exclude<EvidenceLevel, RouteLevel>] extends [never] ? true : never;
type _NoMissingKind = [Exclude<RouteKind, SourceKind>] extends [never] ? true : never;
type _NoExtraKind = [Exclude<SourceKind, RouteKind>] extends [never] ? true : never;
const _checks: [_NoMissingLevel, _NoExtraLevel, _NoMissingKind, _NoExtraKind] = [true, true, true, true];
void [_levels, _routeLevels, _kinds, _routeKinds, _checks];

// ---------- fixtures ----------

const ex = (id: string, name: string, muscle: MuscleGroup, over: Partial<Exercise> = {}): Exercise => ({
  id,
  name,
  muscle_groups: [muscle],
  secondary_groups: [],
  equipment: "Barbell",
  category: "strength",
  mechanic: "compound",
  force: null,
  level: "beginner",
  instructions: [],
  image_urls: [],
  tiktok_url: "",
  ...over,
});

const CATALOGUE: Exercise[] = [
  ex("bench", "Bench Press", "Chest"),
  ex("incline-db", "Incline Dumbbell Press", "Chest", { equipment: "Dumbbell" }),
  ex("cable-fly", "Cable Fly", "Chest", { equipment: "Machine/Cable", mechanic: "isolation" }),
  ex("row", "Barbell Row", "Back"),
  ex("db-row", "One-Arm Dumbbell Row", "Back", { equipment: "Dumbbell" }),
  ex("squat", "Barbell Squat", "Quads"),
  ex("leg-press", "Leg Press", "Quads", { equipment: "Machine/Cable" }),
  ex("curl", "Barbell Curl", "Biceps", { mechanic: "isolation" }),
];
const byId = new Map(CATALOGUE.map((e) => [e.id, e]));
const get = (id: string) => byId.get(id);

const GOALS: EvidenceGoals = { goalType: "build_muscle", experience: "intermediate", sessionsPerWeek: 3, focusMuscles: ["Chest"] };

const SRC_A = { id: 1, title: "Bench study", url: "https://pubmed.ncbi.nlm.nih.gov/111/", publisher: "PubMed", kind: "journal" as const, quote: "Bench press increased chest thickness." };
const SRC_B = { id: 2, title: "Position stand", url: "https://www.acsm.org/stand", publisher: "ACSM", kind: "organisation" as const, quote: "Multi-joint lifts are recommended." };
const SRC_C = { id: 3, title: "Row study", url: "https://www.frontiersin.org/row", publisher: "Frontiers", kind: "news" as const, quote: "Rows trained the back." };

const answer = (over: Record<string, unknown> = {}) => ({
  picks: [
    { muscle: "Chest", exercise_id: "bench", claim: "Bench press builds the chest [1][2].", source_ids: [1, 2] },
    { muscle: "Back", exercise_id: "row", claim: "Rows train the back well [3].", source_ids: [3] },
  ],
  sources: [SRC_A, SRC_B, SRC_C],
  evidence: { Chest: "moderate", Back: "limited" },
  disclaimer: ROUTE_DISCLAIMER,
  source: "ai",
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Handler = (init?: RequestInit) => Response | Promise<Response>;

function mockFetch(evidence: Handler = () => json({ unavailable: true }, 503), extra: Record<string, Handler> = {}) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/exercises.json")) return json(CATALOGUE);
    if (u === EVIDENCE_ROUTE) return evidence(init);
    if (extra[u]) return extra[u](init);
    if (u.startsWith("/api/ai/")) return json({ unavailable: true }, 503);
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const evidenceCalls = (fn: ReturnType<typeof mockFetch>) =>
  fn.mock.calls.filter((c) => String(c[0]) === EVIDENCE_ROUTE).map((c) => JSON.parse(String(c[1]?.body)));

function setOnline(v: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => v });
}

const storedFavs = async () => ((await db.meta.get("favorites"))?.value as string[] | undefined) ?? [];
const cacheRows = async () => (await db.meta.toArray()).filter((r) => r.key.startsWith("evidence-picks:"));

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  setOnline(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPicks(muscles: MuscleGroup[] = ["Chest", "Back"]) {
  render(<EvidencePicks goals={GOALS} muscles={muscles} equipment={[]} />);
  return screen.getByRole("region", { name: "Evidence-backed exercises" });
}
const findButton = async (region: HTMLElement) => {
  const b = await within(region).findByRole("button", { name: "Find evidence-backed exercises" });
  await waitFor(() => expect(b).not.toBeDisabled());
  return b;
};

// ---------- copies ----------

describe("copies of the route constants", () => {
  it("match lib/ai exactly", () => {
    expect(EVIDENCE_DISCLAIMER).toBe(ROUTE_DISCLAIMER);
    expect([...EVIDENCE_LEVELS]).toEqual([...ROUTE_LEVELS]);
    expect([...SOURCE_KINDS]).toEqual([...ROUTE_KINDS]);
  });
});

// ---------- pure helpers ----------

describe("safeUrl", () => {
  it("allows https only, without credentials", () => {
    expect(safeUrl("https://pubmed.ncbi.nlm.nih.gov/1/")).toBe("https://pubmed.ncbi.nlm.nih.gov/1/");
    expect(safeUrl("http://pubmed.ncbi.nlm.nih.gov/1/")).toBeNull();
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("https://user:pw@example.org/")).toBeNull();
    expect(safeUrl("not a url")).toBeNull();
    expect(safeUrl(42)).toBeNull();
  });
});

describe("claimSegments", () => {
  it("splits text and markers", () => {
    expect(claimSegments("A [1] b [12].")).toEqual([{ text: "A " }, { ref: 1 }, { text: " b " }, { ref: 12 }, { text: "." }]);
    expect(claimSegments("No markers")).toEqual([{ text: "No markers" }]);
  });
});

describe("parseEvidence", () => {
  it("keeps valid picks per muscle with only the sources they cite", () => {
    const out = parseEvidence(answer(), ["Chest", "Back"], get, [])!;
    expect(out.get("Chest")).toEqual({
      muscle: "Chest",
      level: "moderate",
      picks: [{ exercise_id: "bench", claim: "Bench press builds the chest [1][2].", source_ids: [1, 2] }],
      sources: [SRC_A, SRC_B],
    });
    expect(out.get("Back")!.sources).toEqual([SRC_C]);
  });

  it("is null for a rules answer, a 503 body or a bad shape", () => {
    expect(parseEvidence(answer({ source: "rules" }), ["Chest"], get, [])).toBeNull();
    expect(parseEvidence({ unavailable: true }, ["Chest"], get, [])).toBeNull();
    expect(parseEvidence(answer({ picks: "x" }), ["Chest"], get, [])).toBeNull();
    expect(parseEvidence(null, ["Chest"], get, [])).toBeNull();
  });

  it("drops a pick with a dangling marker or an unknown source id", () => {
    const out = parseEvidence(
      answer({
        picks: [
          { muscle: "Chest", exercise_id: "bench", claim: "Bench works [1][4].", source_ids: [1] },
          { muscle: "Chest", exercise_id: "incline-db", claim: "Incline works [9].", source_ids: [9] },
          { muscle: "Chest", exercise_id: "cable-fly", claim: "No marker here.", source_ids: [1] },
          { muscle: "Back", exercise_id: "row", claim: "Rows work [3].", source_ids: [3] },
        ],
      }),
      ["Chest", "Back"],
      get,
      [],
    )!;
    expect(out.has("Chest")).toBe(false);
    expect(out.get("Back")!.picks).toHaveLength(1);
  });

  it("drops non-https, duplicate, kindless and quoteless sources, and string ids", () => {
    const out = parseEvidence(
      answer({
        sources: [
          { ...SRC_A, url: "http://pubmed.ncbi.nlm.nih.gov/111/" },
          { ...SRC_B, id: "2" },
          { ...SRC_C, kind: "blog" },
        ],
      }),
      ["Chest", "Back"],
      get,
      [],
    );
    expect(out!.size).toBe(0);
    const dup = parseEvidence(answer({ sources: [SRC_A, { ...SRC_B, url: SRC_A.url }, { ...SRC_C, quote: "" }] }), ["Chest", "Back"], get, []);
    expect(dup!.size).toBe(0);
  });

  it("drops unknown, custom, wrong-muscle, filtered-out, repeated and unrequested exercises", () => {
    const pick = (muscle: string, exercise_id: string) => ({ muscle, exercise_id, claim: "Works [1].", source_ids: [1] });
    const out = parseEvidence(
      answer({
        picks: [
          pick("Chest", "nope"),
          pick("Chest", "custom-abc"),
          pick("Chest", "row"),
          pick("Chest", "incline-db"),
          pick("Chest", "bench"),
          pick("Chest", "bench"),
          pick("Quads", "squat"),
        ],
      }),
      ["Chest", "Back"],
      get,
      ["Barbell"],
    )!;
    expect(out.get("Chest")!.picks.map((p) => p.exercise_id)).toEqual(["bench"]);
    expect(out.has("Quads" as MuscleGroup)).toBe(false);
  });

  it("caps picks at three per muscle and lowers an unknown level to limited", () => {
    const many = ["bench", "incline-db", "cable-fly"].map((id) => ({ muscle: "Chest", exercise_id: id, claim: "x [1]", source_ids: [1] }));
    const extra = { muscle: "Chest", exercise_id: "bench", claim: "y [1]", source_ids: [1] };
    const out = parseEvidence(answer({ picks: [...many, extra], evidence: { Chest: "proven" } }), ["Chest"], get, [])!;
    expect(out.get("Chest")!.picks).toHaveLength(3);
    expect(out.get("Chest")!.level).toBe("limited");
  });

  it("keeps markup in a claim as plain text", () => {
    const out = parseEvidence(
      answer({ picks: [{ muscle: "Chest", exercise_id: "bench", claim: "<img src=x onerror=alert(1)> works [1]", source_ids: [1] }] }),
      ["Chest"],
      get,
      [],
    )!;
    expect(out.get("Chest")!.picks[0].claim).toBe("<img src=x onerror=alert(1)> works [1]");
  });
});

describe("numberSources", () => {
  it("numbers sources across muscles in order of first citation, one number per url", () => {
    const out = parseEvidence(answer(), ["Chest", "Back"], get, [])!;
    const chest = out.get("Chest")!;
    const back = { ...out.get("Back")!, sources: [{ ...SRC_C, id: 1 }], picks: [{ exercise_id: "row", claim: "Rows [1].", source_ids: [1] }] };
    const { list, numberOf } = numberSources([chest, back]);
    expect(list.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(numberOf(back, 1)).toBe(3);
    expect(numberOf(chest, 2)).toBe(2);
  });
});

describe("cache helpers", () => {
  it("keys by goal type, focus muscles (any order) and muscle", () => {
    expect(cacheKey("build_muscle", ["Back", "Chest"], "Chest")).toBe(cacheKey("build_muscle", ["Chest", "Back"], "Chest"));
    expect(cacheKey("strength", ["Chest"], "Chest")).not.toBe(cacheKey("build_muscle", ["Chest"], "Chest"));
    expect(cacheKey("build_muscle", ["Chest"], "Back")).not.toBe(cacheKey("build_muscle", ["Chest"], "Chest"));
  });

  it("reads a fresh entry, rejects expired and malformed ones", () => {
    const now = Date.UTC(2026, 9, 26);
    const entry = parseEvidence(answer(), ["Chest"], get, [])!.get("Chest")!;
    const stored: CacheEntry = { ...entry, v: 1, savedAt: now - 3 * 86_400_000 };
    expect(readEntry(stored, "Chest", get, [], now)).toEqual(stored);
    expect(readEntry({ ...stored, savedAt: now - (CACHE_DAYS + 1) * 86_400_000 }, "Chest", get, [], now)).toBeNull();
    expect(readEntry({ ...stored, muscle: "Back" }, "Chest", get, [], now)).toBeNull();
    expect(readEntry({ ...stored, v: 2 }, "Chest", get, [], now)).toBeNull();
    expect(readEntry({ ...stored, sources: [{ ...SRC_A, url: "http://x.org" }] }, "Chest", get, [], now)).toBeNull();
    expect(readEntry("junk", "Chest", get, [], now)).toBeNull();
  });

  it("labels the age", () => {
    const now = Date.UTC(2026, 9, 26, 12);
    expect(foundLabel(now - 1000, now)).toBe("Found today");
    expect(foundLabel(now - 86_400_000, now)).toBe("Found 1 day ago");
    expect(foundLabel(now - 3 * 86_400_000, now)).toBe("Found 3 days ago");
  });
});

describe("evidenceRequestBody and ruleEvidencePicks", () => {
  it("sends only enums, at most six muscles", () => {
    const body = evidenceRequestBody({ ...GOALS, sessionsPerWeek: 9 }, ["Chest", "Back", "Quads", "Biceps", "Triceps", "Glutes", "Abs/Core"], []);
    expect(body.muscles).toHaveLength(6);
    expect(body.goals).toEqual({ goalType: "build_muscle", experience: "intermediate", sessionsPerWeek: 7, focusMuscles: ["Chest"] });
    expect(body.equipment).toEqual([]);
  });

  it("gives catalogue suggestions per muscle, never custom ones", () => {
    const custom = ex("custom-1", "My Press", "Chest");
    const picks = ruleEvidencePicks(GOALS, ["Chest", "Back"], [custom, ...CATALOGUE], []);
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.every((p) => !p.exercise.id.startsWith("custom-"))).toBe(true);
    expect(new Set(picks.map((p) => p.muscle))).toEqual(new Set(["Chest", "Back"]));
  });

  it("CoachSetup sends focus muscles first, capped at six", () => {
    expect(evidenceMusclesFor(["Chest", "Back", "Quads", "Biceps", "Triceps", "Glutes", "Calves"], ["Calves"])).toEqual([
      "Calves",
      "Chest",
      "Back",
      "Quads",
      "Biceps",
      "Triceps",
    ]);
  });
});

// ---------- component ----------

describe("EvidencePicks", () => {
  it("fetches nothing until the button is tapped, then shows picks, markers, sources and the disclaimer", async () => {
    const fn = mockFetch(() => json(answer()));
    const region = renderPicks();
    expect(within(region).getByText(MSG_EXPLAIN)).toBeInTheDocument();
    expect(within(region).getByText(EVIDENCE_DISCLAIMER)).toBeInTheDocument();
    const b = await findButton(region);
    expect(evidenceCalls(fn)).toHaveLength(0);

    fireEvent.click(b);
    expect(await within(region).findByText("Bench Press")).toBeInTheDocument();
    expect(evidenceCalls(fn)).toEqual([
      { goals: { goalType: "build_muscle", experience: "intermediate", sessionsPerWeek: 3, focusMuscles: ["Chest"] }, muscles: ["Chest", "Back"], equipment: [] },
    ]);
    expect(within(region).getByText("Evidence: moderate")).toBeInTheDocument();
    const marker = within(region).getByRole("link", { name: "Source 2" });
    expect(marker.closest("sup")).not.toBeNull();
    const sources = within(region).getByRole("list", { name: "Sources" });
    const items = within(sources).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(marker.getAttribute("href")).toBe(`#${items[1].id}`);
    expect(within(sources).getByText("Journal")).toBeInTheDocument();
    expect(within(sources).getByText("Organisation")).toBeInTheDocument();
    expect(within(sources).getByText("News")).toBeInTheDocument();
    expect(within(sources).getByText(/Bench press increased chest thickness\./)).toBeInTheDocument();
    for (const a of within(sources).getAllByRole("link", { name: "Open source" })) {
      expect(a.getAttribute("href")).toMatch(/^https:\/\//);
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(within(region).getByText("Found today")).toBeInTheDocument();
    expect(within(region).getByText(EVIDENCE_DISCLAIMER)).toBeInTheDocument();
    await waitFor(async () => expect(await cacheRows()).toHaveLength(2));
    // Clicking a marker does not navigate away.
    fireEvent.click(marker);
  });

  it("renders a claim with markup as plain text", async () => {
    mockFetch(() =>
      json(answer({ picks: [{ muscle: "Chest", exercise_id: "bench", claim: "<b>bold</b> claim [1]", source_ids: [1] }], sources: [SRC_A] })),
    );
    const region = renderPicks(["Chest"]);
    fireEvent.click(await findButton(region));
    expect(await within(region).findByText("<b>bold</b> claim")).toBeInTheDocument();
    expect(region.querySelector("b")).toBeNull();
  });

  it("shows a cached answer without fetching, with its age and a Refresh that searches again", async () => {
    const savedAt = Date.now() - 3 * 86_400_000 - 1000;
    const chest = parseEvidence(answer(), ["Chest"], get, [])!.get("Chest")!;
    await db.meta.put({ key: cacheKey("build_muscle", ["Chest"], "Chest"), value: { ...chest, v: 1, savedAt } });
    const fn = mockFetch(() =>
      json(answer({ picks: [{ muscle: "Chest", exercise_id: "incline-db", claim: "Incline works [1].", source_ids: [1] }], sources: [SRC_A], evidence: { Chest: "strong" } })),
    );
    const region = renderPicks(["Chest"]);
    expect(await within(region).findByText("Bench Press")).toBeInTheDocument();
    expect(within(region).getByText("Found 3 days ago")).toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: "Find evidence-backed exercises" })).toBeNull();
    expect(evidenceCalls(fn)).toHaveLength(0);

    fireEvent.click(within(region).getByRole("button", { name: "Refresh" }));
    expect(await within(region).findByText("Incline Dumbbell Press")).toBeInTheDocument();
    expect(within(region).queryByText("Bench Press")).toBeNull();
    expect(within(region).getByText("Found today")).toBeInTheDocument();
    expect(within(region).getByText("Evidence: strong")).toBeInTheDocument();
    expect(evidenceCalls(fn)).toHaveLength(1);
  });

  it("only searches muscles that are not cached", async () => {
    const chest = parseEvidence(answer(), ["Chest"], get, [])!.get("Chest")!;
    await db.meta.put({ key: cacheKey("build_muscle", ["Chest"], "Chest"), value: { ...chest, v: 1, savedAt: Date.now() } });
    const fn = mockFetch(() => json(answer()));
    const region = renderPicks(["Chest", "Back"]);
    await within(region).findByText("Bench Press");
    fireEvent.click(await findButton(region));
    expect(await within(region).findByText("Barbell Row")).toBeInTheDocument();
    expect(evidenceCalls(fn)[0].muscles).toEqual(["Back"]);
  });

  it("a failed refresh keeps the earlier answer", async () => {
    const chest = parseEvidence(answer(), ["Chest"], get, [])!.get("Chest")!;
    await db.meta.put({ key: cacheKey("build_muscle", ["Chest"], "Chest"), value: { ...chest, v: 1, savedAt: Date.now() } });
    mockFetch(() => json({ unavailable: true }, 503));
    const region = renderPicks(["Chest"]);
    await within(region).findByText("Bench Press");
    fireEvent.click(within(region).getByRole("button", { name: "Refresh" }));
    expect(await within(region).findByText(MSG_REFRESH_FAILED)).toBeInTheDocument();
    expect(within(region).getByText("Bench Press")).toBeInTheDocument();
  });

  it("Cancel aborts the search, shows a plain note and stores nothing", async () => {
    let signal: AbortSignal | undefined;
    mockFetch(
      (init) =>
        new Promise<Response>((_, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const region = renderPicks(["Chest"]);
    fireEvent.click(await findButton(region));
    expect(await within(region).findByText(MSG_SEARCHING)).toBeInTheDocument();
    fireEvent.click(within(region).getByRole("button", { name: "Cancel search" }));
    expect(signal?.aborted).toBe(true);
    expect(await within(region).findByText(MSG_CANCELLED)).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Find evidence-backed exercises" })).toBeInTheDocument();
    expect(await cacheRows()).toHaveLength(0);
  });

  it("on 503 shows the rule suggestions with no markers or sources and caches nothing", async () => {
    mockFetch();
    const region = renderPicks(["Chest", "Back"]);
    fireEvent.click(await findButton(region));
    expect(await within(region).findByText(MSG_EVIDENCE_UNAVAILABLE)).toBeInTheDocument();
    expect(within(region).getByRole("list", { name: "Built-in suggestions for Chest" })).toBeInTheDocument();
    expect(within(region).getByRole("list", { name: "Built-in suggestions for Back" })).toBeInTheDocument();
    expect(within(region).getAllByText("Evidence: limited")).toHaveLength(2);
    expect(region.querySelector("sup")).toBeNull();
    expect(within(region).queryByRole("list", { name: "Sources" })).toBeNull();
    expect(within(region).queryAllByRole("link")).toHaveLength(0);
    expect(within(region).getByText(EVIDENCE_DISCLAIMER)).toBeInTheDocument();
    expect(await cacheRows()).toHaveLength(0);
  });

  it("falls back on a rules answer, an error, a network failure and offline", async () => {
    mockFetch(() => json(answer({ source: "rules", sources: [] })));
    let region = renderPicks(["Chest"]);
    fireEvent.click(await findButton(region));
    expect(await within(region).findByText(MSG_EVIDENCE_UNAVAILABLE)).toBeInTheDocument();
    expect(region.querySelector("sup")).toBeNull();
    document.body.innerHTML = "";

    mockFetch(() => json({ error: "x" }, 500));
    region = renderPicks(["Chest"]);
    fireEvent.click(await findButton(region));
    expect(await within(region).findByText(MSG_EVIDENCE_UNAVAILABLE)).toBeInTheDocument();
    document.body.innerHTML = "";

    mockFetch(() => {
      throw new TypeError("network");
    });
    region = renderPicks(["Chest"]);
    fireEvent.click(await findButton(region));
    expect(await within(region).findByText(MSG_EVIDENCE_UNAVAILABLE)).toBeInTheDocument();
    document.body.innerHTML = "";

    const fn = mockFetch(() => json(answer()));
    region = renderPicks(["Chest"]);
    const b = await findButton(region);
    setOnline(false);
    fireEvent.click(b);
    expect(await within(region).findByText(MSG_EVIDENCE_OFFLINE)).toBeInTheDocument();
    expect(evidenceCalls(fn)).toHaveLength(0);
  });

  it("drops a pick with a dangling marker and shows the rules for that muscle", async () => {
    mockFetch(() =>
      json(
        answer({
          picks: [
            { muscle: "Chest", exercise_id: "bench", claim: "Bench works [1][7].", source_ids: [1] },
            { muscle: "Back", exercise_id: "row", claim: "Rows work [3].", source_ids: [3] },
          ],
        }),
      ),
    );
    const region = renderPicks(["Chest", "Back"]);
    fireEvent.click(await findButton(region));
    expect(await within(region).findByText(MSG_EVIDENCE_PARTIAL)).toBeInTheDocument();
    expect(within(region).queryByText(/Bench works/)).toBeNull();
    expect(within(region).getByText(/Rows work/)).toBeInTheDocument();
    expect(within(region).getByRole("list", { name: "Built-in suggestions for Chest" })).toBeInTheDocument();
    const sources = within(region).getByRole("list", { name: "Sources" });
    expect(within(sources).getAllByRole("listitem")).toHaveLength(1);
    await waitFor(async () => expect((await cacheRows()).map((r) => r.key)).toEqual([cacheKey("build_muscle", ["Chest"], "Back")]));
  });

  it("adds a pick to the pool (favourites) with one tap and nothing automatically", async () => {
    mockFetch(() => json(answer()));
    const region = renderPicks(["Chest", "Back"]);
    fireEvent.click(await findButton(region));
    await within(region).findByText("Bench Press");
    expect(await storedFavs()).toEqual([]);
    fireEvent.click(within(region).getByRole("button", { name: "Add Bench Press" }));
    await waitFor(async () => expect(await storedFavs()).toEqual(["bench"]));
    expect(await within(region).findByRole("button", { name: "Bench Press added" })).toBeInTheDocument();
  });

  it("uses no emojis", async () => {
    mockFetch(() => json(answer()));
    const region = renderPicks();
    fireEvent.click(await findButton(region));
    await within(region).findByText("Bench Press");
    expect(region.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("CoachSetup review step", () => {
  const PPL: Split = {
    name: "Push Pull Legs",
    days: [
      { name: "Push", muscles: ["Chest"] },
      { name: "Pull", muscles: ["Back"] },
    ],
  };

  it("offers the opt-in search on Review, falls back on 503 and stages added picks until Save", async () => {
    const fn = mockFetch();
    render(<CoachSetup goals={{ ...DEFAULT_GOALS, focusMuscles: ["Chest"] }} split={PPL} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up with coach" }));
    const panel = screen.getByRole("region", { name: "Coach setup" });
    const nav = within(panel).getByRole("group", { name: "Step navigation" });
    for (let i = 0; i < 4; i++) fireEvent.click(within(nav).getByRole("button", { name: "Next" }));
    const region = await within(panel).findByRole("region", { name: "Evidence-backed exercises" });
    expect(evidenceCalls(fn)).toHaveLength(0);

    fireEvent.click(await findButton(region));
    expect(await within(region).findByText(MSG_EVIDENCE_UNAVAILABLE)).toBeInTheDocument();
    expect(evidenceCalls(fn)[0].muscles).toEqual(["Chest", "Back"]);
    const list = within(region).getByRole("list", { name: "Built-in suggestions for Chest" });
    const add = within(list).getAllByRole("button", { name: /^Add / })[0];
    const name = add.getAttribute("aria-label")!.replace(/^Add /, "");
    fireEvent.click(add);
    expect(within(region).getByRole("button", { name: `${name} added` })).toBeInTheDocument();
    expect(await storedFavs()).toEqual([]);
    fireEvent.click(within(nav).getByRole("button", { name: "Save" }));
    const id = CATALOGUE.find((e) => e.name === name)!.id;
    await waitFor(async () => expect(await storedFavs()).toEqual([id]));
  });
});
