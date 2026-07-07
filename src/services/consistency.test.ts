import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initSchema, commitFileIndex } from "./db.js";
import { checkConsistency } from "./consistency.js";

const DIMS = 384;

/** A unit vector with a 1 in position `dim` — easy to reason about cosine similarity: same dim -> 1.0, different dims -> 0.0. */
function oneHot(dim: number): Float32Array {
  const v = new Float32Array(DIMS);
  v[dim] = 1;
  return v;
}

function setup() {
  const db = new Database(":memory:");
  initSchema(db);
  return db;
}

describe("checkConsistency", () => {
  test("flags cross-note chunks that are similar in meaning but different in wording", () => {
    const db = setup();
    commitFileIndex(db, { rel_path: "a.md", mtime_ms: 1, content_hash: "h1" }, [
      { text: "Стратегия предполагает пять процентов доходности в год по плану", embedding: oneHot(0) },
    ]);
    commitFileIndex(db, { rel_path: "b.md", mtime_ms: 2, content_hash: "h2" }, [
      { text: "План рассчитан на восемь процентов прибыли ежегодно согласно расчётам", embedding: oneHot(0) },
    ]);

    const pairs = checkConsistency(db, undefined, 10);
    assert.equal(pairs.length, 1);
    assert.deepEqual([pairs[0].noteA, pairs[0].noteB].sort(), ["a.md", "b.md"]);
    assert.ok(pairs[0].score > 0.99);
  });

  test("excludes near-duplicate wording (same underlying text) even at high similarity", () => {
    const db = setup();
    const text = "Стратегия предполагает пять процентов доходности в год по плану на будущее";
    commitFileIndex(db, { rel_path: "a.md", mtime_ms: 1, content_hash: "h1" }, [
      { text, embedding: oneHot(0) },
    ]);
    commitFileIndex(db, { rel_path: "b.md", mtime_ms: 2, content_hash: "h2" }, [
      { text, embedding: oneHot(0) },
    ]);

    const pairs = checkConsistency(db, undefined, 10);
    assert.equal(pairs.length, 0, "identical wording should be treated as a duplicate, not a contradiction candidate");
  });

  test("never flags two chunks from the SAME note", () => {
    const db = setup();
    commitFileIndex(db, { rel_path: "a.md", mtime_ms: 1, content_hash: "h1" }, [
      { text: "first chunk about the topic", embedding: oneHot(0) },
      { text: "second chunk phrased totally differently", embedding: oneHot(0) },
    ]);

    const pairs = checkConsistency(db, undefined, 10);
    assert.equal(pairs.length, 0);
  });

  test("excludes pairs below the similarity threshold (unrelated topics)", () => {
    const db = setup();
    commitFileIndex(db, { rel_path: "a.md", mtime_ms: 1, content_hash: "h1" }, [
      { text: "note about investing strategy", embedding: oneHot(0) },
    ]);
    commitFileIndex(db, { rel_path: "b.md", mtime_ms: 2, content_hash: "h2" }, [
      { text: "completely unrelated note about gardening", embedding: oneHot(1) }, // orthogonal -> cosine 0
    ]);

    const pairs = checkConsistency(db, undefined, 10);
    assert.equal(pairs.length, 0);
  });

  test("scope restricts comparison to notes under the given folder prefix", () => {
    const db = setup();
    commitFileIndex(db, { rel_path: "Folder1/a.md", mtime_ms: 1, content_hash: "h1" }, [
      { text: "in-scope note one talking about the topic", embedding: oneHot(0) },
    ]);
    commitFileIndex(db, { rel_path: "Folder1/b.md", mtime_ms: 2, content_hash: "h2" }, [
      { text: "in-scope note two phrased very differently about it", embedding: oneHot(0) },
    ]);
    commitFileIndex(db, { rel_path: "Folder2/c.md", mtime_ms: 3, content_hash: "h3" }, [
      { text: "out-of-scope note phrased completely differently again", embedding: oneHot(0) },
    ]);

    const pairs = checkConsistency(db, "Folder1/", 10);
    assert.equal(pairs.length, 1);
    assert.deepEqual([pairs[0].noteA, pairs[0].noteB].sort(), ["Folder1/a.md", "Folder1/b.md"]);
  });
});
