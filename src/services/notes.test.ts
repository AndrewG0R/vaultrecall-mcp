import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chunkText, suggestTagCorrections } from "./notes.js";

describe("chunkText", () => {
  test("splits into one chunk per ## section", () => {
    const md = "# Title\n\nintro paragraph\n\n## Section A\ncontent a\n\n## Section B\ncontent b";
    const chunks = chunkText(md, 200, 20);
    assert.equal(chunks.length, 3);
    assert.match(chunks[0], /^# Title/);
    assert.match(chunks[1], /^## Section A/);
    assert.match(chunks[2], /^## Section B/);
  });

  test("sub-chunks a section that's larger than chunkSize, with overlap", () => {
    const bigSection = "## Big Section\n" + "word ".repeat(50); // ~265 chars
    const chunks = chunkText(bigSection, 60, 10);
    assert.ok(chunks.length > 1, "expected the oversized section to be split into multiple chunks");
    for (const c of chunks) {
      assert.ok(c.length <= 60, `chunk exceeds chunkSize: ${c.length}`);
    }
    // Overlap: the tail of one chunk should reappear at the head of the next.
    const tailOfFirst = chunks[0].slice(-10);
    assert.ok(chunks[1].startsWith(tailOfFirst));
  });

  test("falls back to char-based chunking when there are no ## headings", () => {
    const flat = "plain text with no markdown headers at all ".repeat(5);
    const chunks = chunkText(flat, 60, 10);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length <= 60));
  });

  test("returns an empty array for empty/whitespace-only input", () => {
    assert.deepEqual(chunkText("   \n\n  "), []);
  });
});

describe("suggestTagCorrections", () => {
  function makeTempVault(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-tags-"));
    fs.writeFileSync(
      path.join(dir, "note.md"),
      "---\ntags:\n  - investing\n  - fitness\n---\nbody text, no inline tags here.\n"
    );
    return dir;
  }

  test("marks an exact (case-insensitive) match as existing, with no suggestions", () => {
    const vault = makeTempVault();
    const [result] = suggestTagCorrections(vault, ["Investing"]);
    assert.equal(result.existing, true);
    assert.deepEqual(result.similarTags, []);
  });

  test("suggests a near-duplicate existing tag for a new, similarly-spelled tag", () => {
    const vault = makeTempVault();
    const [result] = suggestTagCorrections(vault, ["investings"]);
    assert.equal(result.existing, false);
    assert.ok(result.similarTags.includes("investing"), `expected "investing" in ${JSON.stringify(result.similarTags)}`);
  });

  test("proposes no suggestions for a genuinely novel, unrelated tag", () => {
    const vault = makeTempVault();
    const [result] = suggestTagCorrections(vault, ["completely-unrelated-topic-xyz"]);
    assert.equal(result.existing, false);
    assert.deepEqual(result.similarTags, []);
  });
});
