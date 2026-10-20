import { describe, it, expect } from "vitest";
import { summarizeTexts, type FeedbackTextRow } from "../../src/workflows/feedback-summary.js";

/*
 * The feedback summary is a pure function of stored rows (Task 9, ADR 0028). It counts distinct items per term, never
 * occurrences, and it has no clock, no randomness and no model. These tests need no database.
 */

function row(id: string, text: string, createdAt: string): FeedbackTextRow {
  return { id, text, createdAt: new Date(createdAt) };
}

describe("feedback summary (pure)", () => {
  it("counts distinct feedback items per term, not occurrences", () => {
    const summary = summarizeTexts([
      row("fb-a", "Soup soup soup was cold", "2026-10-01T10:00:00Z"),
      row("fb-b", "soup was great", "2026-10-01T11:00:00Z"),
      row("fb-c", "great", "2026-10-01T12:00:00Z"),
    ]);

    expect(summary.total).toBe(3);
    // "soup" appears five times across two items: its count is 2.
    expect(summary.themes).toEqual([
      { term: "great", count: 2 },
      { term: "soup", count: 2 },
      { term: "cold", count: 1 },
    ]);
  });

  it("ignores stop words and very short tokens", () => {
    const summary = summarizeTexts([
      row("fb-a", "The food was in a box and it is ok. Don't like it.", "2026-10-01T10:00:00Z"),
      row("fb-b", "Crème brûlée was lovely", "2026-10-01T11:00:00Z"),
    ]);

    const terms = summary.themes.map((t) => t.term);
    for (const dropped of ["the", "was", "and", "in", "it", "is", "ok", "don"]) {
      expect(terms, dropped).not.toContain(dropped);
    }
    // Unicode letters are kept as they are, and an apostrophe splits a word, leaving no fragment of two letters.
    expect(terms).toContain("crème");
    expect(terms).toContain("brûlée");
    expect(terms).toContain("food");
    expect(terms).toContain("box");
    expect(terms).not.toContain("t");
    expect(terms.every((term) => term.length >= 3)).toBe(true);
  });

  it("orders themes by count then term", () => {
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];
    const summary = summarizeTexts([
      row("fb-01", words.join(" "), "2026-10-01T10:00:00Z"),
      row("fb-02", "pasta bread", "2026-10-01T10:01:00Z"),
      row("fb-03", "pasta", "2026-10-01T10:02:00Z"),
      row("fb-04", "pasta and bread pasta", "2026-10-01T10:03:00Z"),
    ]);

    // pasta (3 items) then bread (2 items), then the count-1 terms in ascending order. Only the first ten are kept.
    expect(summary.themes).toEqual([
      { term: "pasta", count: 3 },
      { term: "bread", count: 2 },
      { term: "alpha", count: 1 },
      { term: "bravo", count: 1 },
      { term: "charlie", count: 1 },
      { term: "delta", count: 1 },
      { term: "echo", count: 1 },
      { term: "foxtrot", count: 1 },
      { term: "golf", count: 1 },
      { term: "hotel", count: 1 },
    ]);
  });

  it("the sample is the earliest items truncated to 140 characters", () => {
    const summary = summarizeTexts([
      row("fb-c", "C".repeat(200), "2026-10-03T10:00:00Z"),
      row("fb-a", "A".repeat(200), "2026-10-01T10:00:00Z"),
      row("fb-e", "E", "2026-10-05T10:00:00Z"),
      row("fb-b", "B short", "2026-10-02T10:00:00Z"),
      row("fb-d", "D", "2026-10-04T10:00:00Z"),
    ]);

    expect(summary.sample).toEqual(["A".repeat(140), "B short", "C".repeat(140)]);
    expect(summary.sample[0]).toHaveLength(140);
    expect(summary.sample[2]).toHaveLength(140);
  });

  it("the same rows always give the same summary", () => {
    const rows = [
      row("fb-z", "pasta sauce too salty", "2026-10-02T10:00:00Z"),
      row("fb-m", "pasta sauce lovely", "2026-10-02T10:00:00Z"),
      row("fb-a", "fries cold", "2026-10-01T10:00:00Z"),
      row("fb-k", "fries crispy", "2026-10-03T10:00:00Z"),
    ];
    const first = summarizeTexts(rows);
    const again = summarizeTexts(rows);
    // The same rows in another order give the same answer: ties are broken by id, not by input order.
    const shuffled = summarizeTexts([rows[2], rows[0], rows[3], rows[1]]);

    expect(again).toEqual(first);
    expect(shuffled).toEqual(first);
    // Ties on createdAt are ordered by id ("fb-m" before "fb-z").
    expect(first.sample).toEqual(["fries cold", "pasta sauce lovely", "pasta sauce too salty"]);
  });

  it("does not change its input", () => {
    const rows = [
      row("fb-b", "second", "2026-10-02T10:00:00Z"),
      row("fb-a", "first", "2026-10-01T10:00:00Z"),
    ];
    const before = rows.map((r) => ({ id: r.id, text: r.text, createdAt: new Date(r.createdAt.getTime()) }));
    const order = rows.map((r) => r.id);

    summarizeTexts(rows);

    expect(rows.map((r) => r.id)).toEqual(order);
    expect(rows).toEqual(before);
  });

  it("an empty list gives empty themes and no sample", () => {
    expect(summarizeTexts([])).toEqual({ themes: [], sample: [], total: 0 });
  });
});
