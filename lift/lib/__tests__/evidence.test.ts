import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evidenceById, evidenceFor, EVIDENCE_LIBRARY, EVIDENCE_TOPICS, knownEvidenceIds } from "../evidence/library";
import { MUSCLE_GROUPS } from "../muscles";

const catalogue = JSON.parse(readFileSync(join(__dirname, "../../data/exercises.json"), "utf8")) as { id: string }[];
const catalogueIds = new Set(catalogue.map((e) => e.id));

describe("evidence library data", () => {
  it("has unique ids", () => {
    const ids = EVIDENCE_LIBRARY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has a real-looking PubMed link, PMID and DOI on every source", () => {
    for (const { source: s } of EVIDENCE_LIBRARY) {
      expect(s.pmid).toMatch(/^\d{6,9}$/);
      expect(s.url).toBe(`https://pubmed.ncbi.nlm.nih.gov/${s.pmid}/`);
      expect(s.doi).toMatch(/^10\.\d{4,9}\/\S+$/);
      expect(s.year).toBeGreaterThanOrEqual(2000);
      expect(s.year).toBeLessThanOrEqual(2026);
      for (const text of [s.title, s.authors, s.journal]) expect(text.trim().length).toBeGreaterThan(3);
    }
  });

  it("never cites the same paper under two PMIDs or one PMID under two papers", () => {
    const byPmid = new Map<string, string>();
    for (const { source: s } of EVIDENCE_LIBRARY) {
      const seen = byPmid.get(s.pmid);
      if (seen) expect(seen).toBe(s.title);
      byPmid.set(s.pmid, s.title);
    }
  });

  it("keeps claims short, plain and free of links, markup and emoji", () => {
    for (const e of EVIDENCE_LIBRARY) {
      expect(e.claim.length).toBeGreaterThan(20);
      expect(e.claim.length).toBeLessThanOrEqual(300);
      expect(e.claim).not.toMatch(/https?:|www\.|[<>]/i);
      expect(e.claim).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it("uses only known topics, known muscles and exercise ids that exist in the catalogue", () => {
    for (const e of EVIDENCE_LIBRARY) {
      expect(EVIDENCE_TOPICS).toContain(e.topic);
      for (const m of e.muscles ?? []) expect(MUSCLE_GROUPS).toContain(m);
      for (const id of e.exerciseIds ?? []) expect(catalogueIds.has(id)).toBe(true);
    }
  });

  it("covers volume, frequency, load, failure, rest and prescription in general, and specific muscles", () => {
    for (const t of ["volume", "frequency", "load", "failure", "rest", "prescription"] as const) {
      expect(evidenceFor({ topic: t }).length).toBeGreaterThan(0);
    }
    for (const m of ["Hamstrings", "Triceps", "Quads", "Calves", "Glutes"] as const) {
      expect(evidenceFor({ muscle: m }).length).toBeGreaterThan(0);
    }
  });
});

describe("evidenceFor", () => {
  it("returns everything with no filter", () => {
    expect(evidenceFor()).toHaveLength(EVIDENCE_LIBRARY.length);
  });

  it("filters by topic", () => {
    const rest = evidenceFor({ topic: "rest" });
    expect(rest.length).toBeGreaterThan(1);
    expect(rest.every((e) => e.topic === "rest")).toBe(true);
  });

  it("a muscle filter returns only entries about that muscle, never general ones", () => {
    const tri = evidenceFor({ muscle: "Triceps" });
    expect(tri.map((e) => e.id)).toEqual(["triceps-overhead"]);
    expect(evidenceFor({ muscle: "Biceps" })).toEqual([]);
  });

  it("an exercise filter returns only entries naming that catalogue id", () => {
    expect(evidenceFor({ exerciseId: "Seated_Leg_Curl" }).map((e) => e.id)).toEqual(["hamstrings-seated-curl"]);
    expect(evidenceFor({ exerciseId: "Barbell_Hip_Thrust" }).map((e) => e.id)).toEqual(["glutes-thrust-squat"]);
    expect(evidenceFor({ exerciseId: "not-an-exercise" })).toEqual([]);
  });

  it("combines filters with AND", () => {
    expect(evidenceFor({ muscle: "Triceps", topic: "muscle_length" })).toHaveLength(1);
    expect(evidenceFor({ muscle: "Triceps", topic: "rest" })).toEqual([]);
  });
});

describe("evidenceById and knownEvidenceIds", () => {
  it("finds an entry by id and nothing for an unknown id", () => {
    expect(evidenceById("failure-proximity")?.source.pmid).toBe("36334240");
    expect(evidenceById("made-up")).toBeUndefined();
    expect(evidenceById("__proto__")).toBeUndefined();
  });

  it("keeps only real ids, in order, without repeats", () => {
    expect(knownEvidenceIds(["rest-review", "made-up", "volume-hypertrophy", "rest-review"])).toEqual(["rest-review", "volume-hypertrophy"]);
    expect(knownEvidenceIds([])).toEqual([]);
  });
});
