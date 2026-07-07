import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { initSchema, commitFileIndex, allChunks, allKnownRelPaths, getFileRow } from "./db.js";
import { readNote } from "./notes.js";
import { reindexVault, extractAttachmentsText } from "./indexer.js";

const DIMS = 384;
function fakeEmbedding(): Float32Array {
  return new Float32Array(DIMS).fill(0.1);
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

describe("reindexVault delete-detection", () => {
  test("purges a note's file row and chunks once it's no longer on disk, without touching unrelated notes", async () => {
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sb-vault-"));
    fs.writeFileSync(path.join(vaultRoot, "keep.md"), "Hello world, this note stays.\n");

    const db = new Database(":memory:");
    initSchema(db);

    // Pre-populate the index as if "keep.md" and "ghost.md" were both indexed in a previous pass.
    // "keep.md" is given the CONTENT HASH IT ACTUALLY HAS ON DISK so reindexVault sees it as
    // unchanged and skips re-embedding it — this keeps the test independent of the real embedding
    // model (no network, no model download) while still exercising the real reindexVault code path.
    const keepNote = readNote(vaultRoot, "keep.md");
    const keepHash = hashContent(keepNote.content);
    commitFileIndex(db, { rel_path: "keep.md", mtime_ms: keepNote.mtimeMs, content_hash: keepHash }, [
      { text: keepNote.content, embedding: fakeEmbedding() },
    ]);
    commitFileIndex(db, { rel_path: "ghost.md", mtime_ms: Date.now(), content_hash: "stale-hash" }, [
      { text: "a note that has since been deleted from disk", embedding: fakeEmbedding() },
    ]);

    assert.equal(allKnownRelPaths(db).size, 2, "sanity check: both files indexed before reindex");

    const result = await reindexVault(vaultRoot, db);

    assert.equal(result.filesDeleted, 1);
    assert.equal(result.filesUpdated, 0, "keep.md's hash matched, so it should NOT have been re-embedded");

    assert.equal(getFileRow(db, "ghost.md"), undefined, "ghost.md's file row should be purged");
    assert.ok(
      !allChunks(db).some((c) => c.rel_path === "ghost.md"),
      "ghost.md's chunks should be purged, not just its file row"
    );

    assert.ok(getFileRow(db, "keep.md") !== undefined, "keep.md should be untouched");
    assert.ok(allChunks(db).some((c) => c.rel_path === "keep.md"), "keep.md's chunks should remain");

    db.close();
    fs.rmSync(vaultRoot, { recursive: true, force: true });
  });
});

describe("extractAttachmentsText graceful failure handling", () => {
  test("a note referencing an attachment that doesn't exist on disk is skipped, not thrown", async () => {
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sb-vault-"));
    const db = new Database(":memory:");
    initSchema(db);

    const text = await extractAttachmentsText(
      db,
      vaultRoot,
      "note.md",
      "See ![[does-not-exist.png]] for the diagram.",
      [] // no files in the vault at all
    );

    assert.equal(text, "", "unresolvable attachment should be silently skipped, contributing no text");

    db.close();
    fs.rmSync(vaultRoot, { recursive: true, force: true });
  });

  test("a note with no attachment embeds at all short-circuits without touching the cache", async () => {
    const db = new Database(":memory:");
    initSchema(db);
    const text = await extractAttachmentsText(db, "/irrelevant", "note.md", "just plain text, no embeds", []);
    assert.equal(text, "");
    db.close();
  });
});

describe("commitFileIndex atomicity", () => {
  test("a failure partway through leaves neither the chunks nor the file row written (all-or-nothing)", () => {
    const db = new Database(":memory:");
    initSchema(db);

    // The second "chunk" has a malformed embedding (not a Float32Array), so `.buffer` access
    // throws partway through the transaction. If commitFileIndex weren't atomic, the first
    // chunk's INSERT would already be durably committed at that point.
    const badChunks = [
      { text: "chunk one", embedding: fakeEmbedding() },
      { text: "chunk two", embedding: null as unknown as Float32Array },
    ];

    assert.throws(() => {
      commitFileIndex(db, { rel_path: "broken.md", mtime_ms: Date.now(), content_hash: "h" }, badChunks);
    });

    assert.equal(getFileRow(db, "broken.md"), undefined, "file row must not exist after a rolled-back write");
    assert.equal(
      allChunks(db).filter((c) => c.rel_path === "broken.md").length,
      0,
      "no partial chunks should survive a rolled-back write"
    );

    db.close();
  });

  test("replacing an existing file's chunks is also atomic on failure (old chunks preserved, not half-deleted)", () => {
    const db = new Database(":memory:");
    initSchema(db);

    commitFileIndex(db, { rel_path: "existing.md", mtime_ms: 1, content_hash: "v1" }, [
      { text: "original chunk", embedding: fakeEmbedding() },
    ]);

    const badChunks = [{ text: "new chunk", embedding: null as unknown as Float32Array }];
    assert.throws(() => {
      commitFileIndex(db, { rel_path: "existing.md", mtime_ms: 2, content_hash: "v2" }, badChunks);
    });

    const row = getFileRow(db, "existing.md");
    assert.equal(row?.content_hash, "v1", "file row must still reflect the last successful commit");
    const chunks = allChunks(db).filter((c) => c.rel_path === "existing.md");
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, "original chunk");

    db.close();
  });
});
