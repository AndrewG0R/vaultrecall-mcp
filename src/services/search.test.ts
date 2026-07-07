import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { recencyBoost, mergeHybridHits } from "./search.js";
import type { SemanticSearchHit, KeywordSearchHit } from "../types.js";

describe("recencyBoost", () => {
  const now = Date.parse("2026-07-07T00:00:00Z");

  test("is 0 when mtime is unknown", () => {
    assert.equal(recencyBoost(undefined, now), 0);
  });

  test("is at its max for a note edited right now", () => {
    assert.equal(recencyBoost(now, now), 0.05);
  });

  test("decays monotonically with age, roughly halving at the half-life (30 days)", () => {
    const oneDayAgo = now - 1 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;

    const boostFresh = recencyBoost(oneDayAgo, now);
    const boostHalfLife = recencyBoost(thirtyDaysAgo, now);
    const boostOld = recencyBoost(oneYearAgo, now);

    assert.ok(boostFresh > boostHalfLife, "fresh note should beat a half-life-old note");
    assert.ok(boostHalfLife > boostOld, "half-life-old note should beat a year-old note");
    assert.ok(Math.abs(boostHalfLife - 0.025) < 0.001, `expected ~half of max at the half-life, got ${boostHalfLife}`);
    assert.ok(boostOld < 0.0001, "a year-old note should have a negligible boost");
  });

  test("treats a future mtime (clock skew) the same as 'now' rather than going negative", () => {
    const future = now + 1000;
    assert.equal(recencyBoost(future, now), 0.05);
  });
});

describe("mergeHybridHits", () => {
  test("regression: keeps a note's BEST-scoring chunk, not whichever chunk was processed last", () => {
    // semanticSearch returns hits sorted best-first, so this is the real shape of the input:
    // the same note appearing twice, high score first. A prior bug did `merged.set(...)`
    // unconditionally per hit, so the later (lower-scoring) entry silently clobbered the best one.
    const semanticHits: SemanticSearchHit[] = [
      { relPath: "note.md", chunkIndex: 0, score: 0.9, snippet: "best chunk" },
      { relPath: "note.md", chunkIndex: 1, score: 0.3, snippet: "weaker chunk" },
    ];
    const result = mergeHybridHits(semanticHits, [], new Map(), 10);
    assert.equal(result.length, 1);
    assert.equal(result[0].score, 0.9);
    assert.equal(result[0].snippet, "best chunk");
  });

  test("keyword-only hit for a note absent from semantic results still surfaces", () => {
    const keywordHits: KeywordSearchHit[] = [{ relPath: "other.md", line: 3, snippet: "exact match" }];
    const result = mergeHybridHits([], keywordHits, new Map(), 10);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].sources, ["keyword"]);
  });

  test("a note matching both signals sums their scores and lists both sources", () => {
    const semanticHits: SemanticSearchHit[] = [{ relPath: "both.md", chunkIndex: 0, score: 0.6, snippet: "s" }];
    const keywordHits: KeywordSearchHit[] = [{ relPath: "both.md", line: 1, snippet: "k" }];
    const result = mergeHybridHits(semanticHits, keywordHits, new Map(), 10);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].sources.sort(), ["keyword", "semantic"]);
    // keyword rank score for the sole (index 0) hit: 1 - 0 / (1 * 2) = 1
    assert.equal(result[0].score, 0.6 + 1);
  });

  test("respects topK after merging", () => {
    const semanticHits: SemanticSearchHit[] = [
      { relPath: "a.md", chunkIndex: 0, score: 0.9, snippet: "" },
      { relPath: "b.md", chunkIndex: 0, score: 0.5, snippet: "" },
      { relPath: "c.md", chunkIndex: 0, score: 0.1, snippet: "" },
    ];
    const result = mergeHybridHits(semanticHits, [], new Map(), 2);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((r) => r.relPath), ["a.md", "b.md"]);
  });
});
