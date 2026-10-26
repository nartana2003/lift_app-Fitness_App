// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/offline/db";
import type { Exercise } from "@/lib/exercises";
import { MUSCLE_GROUPS, type MuscleGroup } from "@/lib/muscles";
import {
  CACHE_DAYS,
  EVIDENCE_ROUTE,
  EvidencePicks,
  MSG_CANCELLED,
  MSG_EVIDENCE_PARTIAL,
  MSG_EVIDENCE_UNAVAILABLE,
  cacheKey,
  claimSegments,
  numberSources,
  parseEvidence,
  readEntry,
  safeUrl,
  type EvidenceGoals,
} from "@/components/goals/EvidencePicks";

const ex = (id: string, name: string, muscle: MuscleGroup, over: Partial<Exercise> = {}): Exercise => ({
  id, name, muscle_groups: [muscle], secondary_groups: [], equipment: "Barbell", category: "strength",
  mechanic: "compound", force: null, level: "beginner", instructions: [], image_urls: [], tiktok_url: "", ...over,
});
const CAT: Exercise[] = [
  ex("bench", "Bench Press", "Chest"),
  ex("incline-db", "Incline Dumbbell Press", "Chest", { equipment: "Dumbbell" }),
  ex("cable-fly", "Cable Fly", "Chest", { equipment: "Machine/Cable" }),
  ex("pec-deck", "Pec Deck", "Chest", { equipment: "Machine/Cable" }),
  ex("row", "Barbell Row", "Back"),
  ex("custom-1", "My Press", "Chest"),
];
const get = (id: string) => CAT.find((e) => e.id === id);
const GOALS: EvidenceGoals = { goalType: "build_muscle", experience: "intermediate", sessionsPerWeek: 3, focusMuscles: ["Chest"] };
const src = (id: number, over: Record<string, unknown> = {}) => ({
  id, title: `T${id}`, url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`, publisher: "PubMed", kind: "journal", quote: `Quote ${id}`, ...over,
});
const pick = (over: Record<string, unknown> = {}) => ({ muscle: "Chest", exercise_id: "bench", claim: "Good [1].", source_ids: [1], ...over });
const body = (over: Record<string, unknown> = {}) => ({ source: "ai", picks: [pick()], sources: [src(1)], evidence: { Chest: "strong" }, ...over });
const parse = (b: unknown, m: MuscleGroup[] = ["Chest"]) => parseEvidence(b, m, get, []);

describe("safeUrl forged and lookalike links", () => {
  it.each([
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,<script>1</script>",
    "http://example.org/x", "ftp://example.org", "file:///etc/passwd", "//example.org/x", "/relative", "https://",
    "https://user:pw@example.org/", "https://user@example.org/", "vbscript:x", "blob:https://example.org/uuid", "", "https:",
  ])("rejects %s", (u) => expect(safeUrl(u)).toBeNull());
  it("rejects non-strings", () => {
    for (const v of [null, undefined, 5, {}, [], ["https://a.org"], true]) expect(safeUrl(v)).toBeNull();
  });
  it("rejects over 2048 chars and accepts exactly the cap", () => {
    const base = "https://example.org/";
    expect(safeUrl(base + "a".repeat(2048 - base.length))).not.toBeNull();
    expect(safeUrl(base + "a".repeat(2049 - base.length))).toBeNull();
  });
  it("only ever returns https hrefs", () => {
    for (const u of ["https://EXAMPLE.org/a b", "https://example.org:8443/x?y=1#z", "HTTPS://example.org"]) {
      const r = safeUrl(u);
      expect(r === null || r.startsWith("https://")).toBe(true);
    }
  });
  it("an https url carrying javascript: in its query is still https", () => {
    const r = safeUrl("https://example.org/?u=javascript:alert(1)");
    expect(r).not.toBeNull();
    expect(new URL(r!).protocol).toBe("https:");
  });
  it("tab-obfuscated schemes never yield a non-https url", () => {
    expect(safeUrl("java\tscript:alert(1)")).toBeNull();
    const r = safeUrl("ht\ntps://example.org");
    expect(r === null || r.startsWith("https://")).toBe(true);
  });
});

describe("parseEvidence sources", () => {
  it("drops sources with bad urls and picks that cite them", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "http://a.org", "https://u:p@a.org/"]) {
      expect(parse(body({ sources: [src(1, { url })] }))!.size, url).toBe(0);
    }
  });
  it("duplicate ids: first wins; duplicate urls: second dropped", () => {
    const r = parse(body({ sources: [src(1), src(1, { url: "https://other.org/", quote: "EVIL" })] }));
    expect(r!.get("Chest")!.sources[0].quote).toBe("Quote 1");
    const r2 = parse(body({ picks: [pick({ claim: "x [1][2]", source_ids: [1, 2] })], sources: [src(1), src(2, { url: src(1).url })] }));
    expect(r2!.size).toBe(0);
  });
  it("rejects ids 0, negative, fractional, 1000, NaN, string", () => {
    for (const id of [0, -1, 1.5, 1000, NaN, "1", null, Infinity]) {
      expect(parse(body({ sources: [src(1, { id })], picks: [pick({ claim: "x [1]", source_ids: [id] })] }))!.size).toBe(0);
    }
  });
  it("rejects unknown kind and empty quote or publisher", () => {
    expect(parse(body({ sources: [src(1, { kind: "blog" })] }))!.size).toBe(0);
    expect(parse(body({ sources: [src(1, { quote: "  ​ " })] }))!.size).toBe(0);
    expect(parse(body({ sources: [src(1, { publisher: "" })] }))!.size).toBe(0);
  });
  it("caps lengths and strips invisible and bidi chars", () => {
    const r = parse(body({ sources: [src(1, { title: "a‮b​c" + "x".repeat(500), quote: "q".repeat(900), publisher: "p".repeat(500) })] }));
    const s = r!.get("Chest")!.sources[0];
    expect(s.title.length).toBeLessThanOrEqual(200);
    expect(s.quote.length).toBe(300);
    expect(s.publisher.length).toBe(100);
    expect(s.title).not.toMatch(/[‮​]/);
  });
  it("falls back to publisher when title is empty", () => {
    expect(parse(body({ sources: [src(1, { title: "" })] }))!.get("Chest")!.sources[0].title).toBe("PubMed");
  });
  it("only looks at the first 40 sources", () => {
    const many = Array.from({ length: 60 }, (_, i) => src(i + 1));
    expect(parse(body({ sources: many, picks: [pick({ claim: "x [50]", source_ids: [50] })] }))!.size).toBe(0);
    expect(parse(body({ sources: many, picks: [pick({ claim: "x [40]", source_ids: [40] })] }))!.size).toBe(1);
  });
  it("tolerates huge junk arrays quickly", () => {
    const junk = Array.from({ length: 50_000 }, (_, i) => (i % 2 ? null : { id: "x" }));
    const t = Date.now();
    expect(parse(body({ sources: junk, picks: junk }))!.size).toBe(0);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe("parseEvidence picks and markers", () => {
  it("rejects non-research shapes", () => {
    for (const j of [null, undefined, 5, "s", [], { source: "rules", picks: [], sources: [] }, { source: "ai" }, { source: "ai", picks: {}, sources: [] }]) {
      expect(parse(j)).toBeNull();
    }
  });
  it("dangling marker drops the whole pick", () => {
    expect(parse(body({ picks: [pick({ claim: "x [1][2]", source_ids: [1] })] }))!.size).toBe(0);
    expect(parse(body({ picks: [pick({ claim: "x [9]", source_ids: [1] })] }))!.size).toBe(0);
  });
  it("source_ids that do not exist drop the pick", () => {
    expect(parse(body({ picks: [pick({ claim: "x [1]", source_ids: [1, 7] })] }))!.size).toBe(0);
  });
  it("pick with no marker, empty source_ids, or empty claim is dropped", () => {
    expect(parse(body({ picks: [pick({ claim: "no marker" })] }))!.size).toBe(0);
    expect(parse(body({ picks: [pick({ source_ids: [] })] }))!.size).toBe(0);
    expect(parse(body({ picks: [pick({ claim: "   " })] }))!.size).toBe(0);
    expect(parse(body({ picks: [pick({ source_ids: "1" })] }))!.size).toBe(0);
  });
  it("duplicate markers and duplicate source_ids are deduped", () => {
    const r = parse(body({ picks: [pick({ claim: "a [1] b [1]", source_ids: [1, 1] })] }));
    expect(r!.get("Chest")!.picks[0].source_ids).toEqual([1]);
  });
  it("a source cited only by a dropped pick is not listed", () => {
    const r = parse(body({
      picks: [pick(), pick({ exercise_id: "incline-db", claim: "x [2]", source_ids: [3] })],
      sources: [src(1), src(2), src(3)],
    }));
    expect(r!.get("Chest")!.sources.map((s) => s.id)).toEqual([1]);
  });
  it("4-digit marker is not a marker; 999 is accepted", () => {
    expect(parse(body({ picks: [pick({ claim: "x [1000]", source_ids: [1] })] }))!.size).toBe(0);
    expect(parse(body({ picks: [pick({ claim: "x [999]", source_ids: [999] })], sources: [src(999)] }))!.size).toBe(1);
  });
  it("rejects custom, unknown, wrong-muscle, non-string and odd exercise ids", () => {
    for (const id of ["custom-1", "nope", "row", 5, null, "../bench", "BENCH", "bench "]) {
      expect(parse(body({ picks: [pick({ exercise_id: id })] }))!.size, String(id)).toBe(0);
    }
  });
  it("ignores picks for muscles not requested and invalid muscles", () => {
    expect(parse(body({ picks: [pick({ muscle: "Back", exercise_id: "row" })] }))!.size).toBe(0);
    expect(parse(body({ picks: [pick({ muscle: "Wings" })] }))!.size).toBe(0);
    expect(parse(body({ picks: [pick({ muscle: ["Chest"] })] }))!.size).toBe(0);
  });
  it("repeats are dropped and max 3 picks per muscle", () => {
    const ids = ["bench", "bench", "incline-db", "cable-fly", "pec-deck"];
    const r = parse(body({ picks: ids.map((id) => pick({ exercise_id: id })) }));
    expect(r!.get("Chest")!.picks.map((p) => p.exercise_id)).toEqual(["bench", "incline-db", "cable-fly"]);
  });
  it("equipment filter removes exercises the user lacks", () => {
    const r = parseEvidence(body({ picks: [pick({ exercise_id: "cable-fly" })] }), ["Chest"], get, ["Barbell"]);
    expect(r!.size).toBe(0);
  });
  it("claim over 300 chars dropped, exactly 300 kept", () => {
    const pad = (n: number) => "a".repeat(n - 4) + " [1]";
    expect(parse(body({ picks: [pick({ claim: pad(300) })] }))!.size).toBe(1);
    expect(parse(body({ picks: [pick({ claim: pad(301) })] }))!.size).toBe(0);
  });
  it("level defaults to limited when unknown or missing", () => {
    expect(parse(body({ evidence: { Chest: "amazing" } }))!.get("Chest")!.level).toBe("limited");
    expect(parse(body({ evidence: undefined }))!.get("Chest")!.level).toBe("limited");
    expect(parse(body({ evidence: [] }))!.get("Chest")!.level).toBe("limited");
  });
  it("markup stays literal text", () => {
    const r = parse(body({ picks: [pick({ claim: "<img src=x onerror=alert(1)> [1]" })], sources: [src(1, { title: "<script>x</script>" })] }));
    expect(r!.get("Chest")!.picks[0].claim).toContain("<img");
    expect(r!.get("Chest")!.sources[0].title).toBe("<script>x</script>");
  });
  it("proto-style keys are harmless", () => {
    const j = JSON.parse('{"source":"ai","picks":[{"muscle":"__proto__","exercise_id":"bench","claim":"x [1]","source_ids":[1]}],"sources":[],"evidence":{"__proto__":"strong"}}');
    expect(parse(j)!.size).toBe(0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("huge claim does not hang", () => {
    const t = Date.now();
    parse(body({ picks: [pick({ claim: "[1]".repeat(200_000) })] }));
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe("claimSegments", () => {
  it("empty and marker-only", () => {
    expect(claimSegments("")).toEqual([]);
    expect(claimSegments("[1][22]")).toEqual([{ ref: 1 }, { ref: 22 }]);
  });
  it("roundtrips text and ignores non-markers", () => {
    const c = "a [x] [] [1234] b[3]c [ 4 ]";
    const segs = claimSegments(c);
    expect(segs.filter((s) => "ref" in s)).toEqual([{ ref: 3 }]);
    expect(segs.map((s) => ("text" in s ? s.text : `[${s.ref}]`)).join("")).toBe(c);
  });
  it("fuzz with fixed seed reconstructs input", () => {
    let s = 12345;
    const rnd = () => (s = (s * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
    const alpha = ["[", "]", "1", "2", "9", " ", "a", "<"];
    for (let i = 0; i < 300; i++) {
      const c = Array.from({ length: Math.floor(rnd() * 30) }, () => alpha[Math.floor(rnd() * alpha.length)]).join("");
      const out = claimSegments(c).map((x) => ("text" in x ? x.text : `[${x.ref}]`)).join("");
      expect(out).toBe(c);
    }
  });
});

describe("numberSources", () => {
  const entry = (muscle: MuscleGroup, sources: ReturnType<typeof src>[], picks: { claim: string; ids: number[] }[]) => ({
    muscle, level: "limited" as const,
    sources: sources as never,
    picks: picks.map((p, i) => ({ exercise_id: `e${i}`, claim: p.claim, source_ids: p.ids })),
  });
  it("same url gets one number across muscles with different local ids", () => {
    const a = entry("Chest", [src(1)], [{ claim: "a [1]", ids: [1] }]);
    const b = entry("Back", [src(5, { url: src(1).url })], [{ claim: "b [5]", ids: [5] }]);
    const { list, numberOf } = numberSources([a, b]);
    expect(list).toHaveLength(1);
    expect(numberOf(a, 1)).toBe(1);
    expect(numberOf(b, 5)).toBe(1);
  });
  it("numbers in order of first citation; unknown ids give undefined", () => {
    const a = entry("Chest", [src(1), src(2)], [{ claim: "a [2] b [1]", ids: [1, 2] }]);
    const { list, numberOf } = numberSources([a]);
    expect(list.map((s) => s.id)).toEqual([2, 1]);
    expect(numberOf(a, 2)).toBe(1);
    expect(numberOf(a, 77)).toBeUndefined();
  });
  it("empty input", () => {
    expect(numberSources([]).list).toEqual([]);
  });
  it("uncited sources are not listed", () => {
    const a = entry("Chest", [src(1), src(2)], [{ claim: "a [1]", ids: [1] }]);
    expect(numberSources([a]).list.map((s) => s.id)).toEqual([1]);
  });
});

describe("cacheKey collisions", () => {
  it("focus order and duplicates do not matter", () => {
    expect(cacheKey("strength", ["Back", "Chest"], "Quads")).toBe(cacheKey("strength", ["Chest", "Back", "Chest"], "Quads"));
  });
  it("differs by goal type, focus set and muscle", () => {
    const keys = new Set<string>();
    for (const g of ["build_muscle", "strength", "general", "fat_loss"] as const)
      for (const f of [[], ["Chest"], ["Chest", "Back"], ["Back"]] as MuscleGroup[][])
        for (const m of ["Chest", "Back"] as MuscleGroup[]) keys.add(cacheKey(g, f, m));
    expect(keys.size).toBe(4 * 4 * 2);
  });
  it("no two distinct focus subsets of size 1 or 2 collide", () => {
    const keys = new Set<string>();
    let n = 0;
    for (const a of MUSCLE_GROUPS) {
      keys.add(cacheKey("general", [a], "Chest")); n++;
      for (const b of MUSCLE_GROUPS) if (a < b) { keys.add(cacheKey("general", [a, b], "Chest")); n++; }
    }
    expect(keys.size).toBe(n);
  });
});

describe("readEntry", () => {
  const NOW = 1_800_000_000_000;
  const DAY = 86_400_000;
  const raw = (over: Record<string, unknown> = {}) => ({
    v: 1, savedAt: NOW - DAY, muscle: "Chest", level: "strong", picks: [{ exercise_id: "bench", claim: "Good [1].", source_ids: [1] }], sources: [src(1)], ...over,
  });
  const read = (r: unknown, m: MuscleGroup = "Chest", now = NOW) => readEntry(r, m, get, [], now);
  it("valid row is read", () => expect(read(raw())!.picks).toHaveLength(1));
  it("expiry boundary: exactly 30 days ok, 30 days + 1ms expired", () => {
    expect(read(raw({ savedAt: NOW - CACHE_DAYS * DAY }))).not.toBeNull();
    expect(read(raw({ savedAt: NOW - CACHE_DAYS * DAY - 1 }))).toBeNull();
  });
  it("future-dated beyond a day is rejected, within a day ok", () => {
    expect(read(raw({ savedAt: NOW + DAY + 1 }))).toBeNull();
    expect(read(raw({ savedAt: NOW + DAY }))).not.toBeNull();
  });
  it.each([null, undefined, "x", 3, [], {}, raw({ v: 2 }), raw({ v: "1" }), raw({ muscle: "Back" }), raw({ savedAt: "1" }),
    raw({ savedAt: NaN }), raw({ savedAt: Infinity }), raw({ savedAt: -Infinity }), raw({ picks: null }), raw({ picks: "x" }),
    raw({ sources: null }), raw({ sources: [] }), raw({ picks: [null, 5] })])("malformed row %#", (r) => expect(read(r)).toBeNull());
  it("row stored for another muscle is not served for this one", () => {
    expect(read(raw(), "Back")).toBeNull();
  });
  it("stored row is re-validated: tampered url, custom id, dangling marker dropped", () => {
    expect(read(raw({ sources: [src(1, { url: "javascript:alert(1)" })] }))).toBeNull();
    expect(read(raw({ picks: [{ exercise_id: "custom-1", claim: "x [1]", source_ids: [1] }] }))).toBeNull();
    expect(read(raw({ picks: [{ exercise_id: "bench", claim: "x [2]", source_ids: [1] }] }))).toBeNull();
  });
  it("a pick's own muscle field cannot redirect it to another muscle", () => {
    expect(read(raw({ picks: [{ muscle: "Back", exercise_id: "row", claim: "x [1]", source_ids: [1] }] }))).toBeNull();
  });
  it("level garbage becomes limited", () => expect(read(raw({ level: "wow" }))!.level).toBe("limited"));
  it("exercise now missing from catalogue drops the row", () => {
    expect(readEntry(raw(), "Chest", () => undefined, [], NOW)).toBeNull();
  });
});

// ---------- component: no invented citations, cancel, partial ----------
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
function mockFetch(handler: (init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/exercises.json")) return json(CAT.filter((e) => !e.id.startsWith("custom-")).concat([ex("db-row", "One-Arm Dumbbell Row", "Back", { equipment: "Dumbbell" })]));
    if (u === EVIDENCE_ROUTE) return handler(init);
    if (u.startsWith("/api/ai/")) return json({ unavailable: true }, 503);
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const calls = (fn: ReturnType<typeof mockFetch>) => fn.mock.calls.filter((c) => String(c[0]) === EVIDENCE_ROUTE);
const rows = async () => (await db.meta.toArray()).filter((r) => r.key.startsWith("evidence-picks:"));
function renderIt(muscles: MuscleGroup[]) {
  render(<EvidencePicks goals={GOALS} muscles={muscles} equipment={[]} />);
  return screen.getByRole("region", { name: "Evidence-backed exercises" });
}
const find = async (r: HTMLElement) => {
  const b = await within(r).findByRole("button", { name: "Find evidence-backed exercises" });
  await waitFor(() => expect(b).not.toBeDisabled());
  return b;
};

describe("EvidencePicks component (QA)", () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("forged javascript: source never becomes a link; markup is inert; pick citing it is dropped", async () => {
    mockFetch(() => json({
      source: "ai", evidence: { Chest: "strong" },
      picks: [pick({ claim: "<b>hi</b><img src=x onerror=alert(1)> [1][2]", source_ids: [1, 2] })],
      sources: [src(1, { title: "<i>t</i>" }), src(2, { url: "javascript:alert(1)" })],
    }));
    const r = renderIt(["Chest"]);
    fireEvent.click(await find(r));
    await within(r).findByText(MSG_EVIDENCE_UNAVAILABLE);
    expect(r.querySelector("a[href^='javascript']")).toBeNull();
    expect(r.querySelector("img")).toBeNull();
    expect(r.querySelector("sup")).toBeNull();
    expect(await rows()).toHaveLength(0);
  });

  it("every rendered source link is https, new tab, noopener noreferrer", async () => {
    mockFetch(() => json({
      source: "ai", evidence: { Chest: "moderate" },
      picks: [pick({ claim: "x [1][2]", source_ids: [1, 2] })],
      sources: [src(1), src(2, { url: "https://www.acsm.org/a?b=1", kind: "organisation" })],
    }));
    const r = renderIt(["Chest"]);
    fireEvent.click(await find(r));
    const links = await within(r).findAllByRole("link", { name: "Open source" });
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a.getAttribute("href")).toMatch(/^https:\/\//);
      expect(a).toHaveAttribute("target", "_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
    for (const a of r.querySelectorAll("sup a")) expect(a.getAttribute("href")).toMatch(/#/);
  });

  it("rules-source body is a fallback: no markers, no sources, nothing cached", async () => {
    mockFetch(() => json({ source: "rules", picks: [pick()], sources: [src(1)] }));
    const r = renderIt(["Chest"]);
    fireEvent.click(await find(r));
    expect(await within(r).findByText(MSG_EVIDENCE_UNAVAILABLE)).toBeInTheDocument();
    expect(r.querySelector("sup")).toBeNull();
    expect(within(r).queryByRole("list", { name: "Sources" })).toBeNull();
    expect(within(r).queryByRole("link")).toBeNull();
    expect(r.textContent).not.toMatch(/\[\d+\]/);
    expect(await rows()).toHaveLength(0);
  });

  it("partial: valid muscle cited and cached, invalid muscle falls back uncited", async () => {
    mockFetch(() => json({
      source: "ai", evidence: { Chest: "strong" },
      picks: [pick(), { muscle: "Back", exercise_id: "row", claim: "no marker here", source_ids: [1] }],
      sources: [src(1)],
    }));
    const r = renderIt(["Chest", "Back"]);
    fireEvent.click(await find(r));
    expect(await within(r).findByText(MSG_EVIDENCE_PARTIAL)).toBeInTheDocument();
    const fb = within(r).getByRole("list", { name: "Built-in suggestions for Back" });
    expect(fb.textContent).not.toMatch(/\[\d+\]/);
    expect(fb.querySelector("sup, a")).toBeNull();
    const rs = await rows();
    expect(rs).toHaveLength(1);
    expect(rs[0].key).toBe(cacheKey("build_muscle", ["Chest"], "Chest"));
  });

  it("cancel then search again: second result shown, first never saved", async () => {
    let n = 0;
    const fn = mockFetch((init) => {
      n++;
      if (n === 1) {
        return new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("a", "AbortError"))));
      }
      return json({ source: "ai", evidence: { Chest: "limited" }, picks: [pick()], sources: [src(1)] });
    });
    const r = renderIt(["Chest"]);
    fireEvent.click(await find(r));
    fireEvent.click(await within(r).findByRole("button", { name: "Cancel search" }));
    expect(await within(r).findByText(MSG_CANCELLED)).toBeInTheDocument();
    expect(await rows()).toHaveLength(0);
    fireEvent.click(await find(r));
    expect(await within(r).findByText("Bench Press")).toBeInTheDocument();
    expect(within(r).queryByText(MSG_CANCELLED)).toBeNull();
    expect(calls(fn)).toHaveLength(2);
    expect(await rows()).toHaveLength(1);
  });

  it("double click on Find sends one request", async () => {
    const fn = mockFetch(() => new Promise<Response>(() => {}));
    const r = renderIt(["Chest"]);
    const b = await find(r);
    fireEvent.click(b);
    fireEvent.click(b);
    await within(r).findByText("Searching research...");
    expect(calls(fn)).toHaveLength(1);
  });

  it("expired and malformed cache rows are ignored", async () => {
    await db.meta.put({ key: cacheKey("build_muscle", ["Chest"], "Chest"), value: { v: 1, savedAt: Date.now() - 31 * 86_400_000, muscle: "Chest", level: "strong", picks: [{ exercise_id: "bench", claim: "x [1]", source_ids: [1] }], sources: [src(1)] } });
    await db.meta.put({ key: cacheKey("build_muscle", ["Chest"], "Back"), value: "garbage" });
    const fn = mockFetch(() => json({ unavailable: true }, 503));
    const r = renderIt(["Chest", "Back"]);
    await find(r);
    expect(within(r).queryByText("Bench Press")).toBeNull();
    expect(calls(fn)).toHaveLength(0);
  });

  it("request carries at most 6 distinct valid muscles", async () => {
    const fn = mockFetch(() => json({ unavailable: true }, 503));
    const many = [...MUSCLE_GROUPS, "Wings" as MuscleGroup, "Chest" as MuscleGroup];
    const r = renderIt(many);
    fireEvent.click(await find(r));
    await waitFor(() => expect(calls(fn)).toHaveLength(1));
    const sent = JSON.parse(String(calls(fn)[0][1]?.body));
    expect(sent.muscles.length).toBeLessThanOrEqual(6);
    expect(new Set(sent.muscles).size).toBe(sent.muscles.length);
    for (const m of sent.muscles) expect(MUSCLE_GROUPS).toContain(m);
  });
});
