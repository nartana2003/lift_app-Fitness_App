import { describe, expect, it } from "vitest";
import { chartSummary } from "../progress";

const data = [
  { label: "1 Oct - 7 Oct", value: 100 },
  { label: "8 Oct - 14 Oct", value: 0 },
  { label: "15 Oct - 21 Oct", value: 250 },
];

describe("chartSummary", () => {
  it("is the total for the range when no bar is picked", () => {
    expect(chartSummary(data, null)).toEqual({ label: null, value: 350 });
  });

  it("is the picked bar's week and value", () => {
    expect(chartSummary(data, 2)).toEqual({ label: "15 Oct - 21 Oct", value: 250 });
    expect(chartSummary(data, 1)).toEqual({ label: "8 Oct - 14 Oct", value: 0 });
  });

  it("falls back to the total for an index that is not a bar", () => {
    expect(chartSummary(data, 3)).toEqual({ label: null, value: 350 });
    expect(chartSummary(data, -1)).toEqual({ label: null, value: 350 });
    expect(chartSummary(data, 1.5)).toEqual({ label: null, value: 350 });
    expect(chartSummary(data, Number.NaN)).toEqual({ label: null, value: 350 });
  });

  it("is zero with no data", () => {
    expect(chartSummary([], null)).toEqual({ label: null, value: 0 });
    expect(chartSummary([], 0)).toEqual({ label: null, value: 0 });
  });
});
