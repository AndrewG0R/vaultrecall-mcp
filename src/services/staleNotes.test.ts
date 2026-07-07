import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findStaleNotes } from "./staleNotes.js";

function writeNoteWithAge(vaultRoot: string, relPath: string, content: string, ageDays: number): void {
  const abs = path.join(vaultRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  const mtime = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  fs.utimesSync(abs, mtime, mtime);
}

function makeTempVault(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sb-stale-"));
}

describe("findStaleNotes", () => {
  test("flags an old note with an unchecked checkbox", () => {
    const vault = makeTempVault();
    writeNoteWithAge(vault, "old-with-checkbox.md", "Some text\n- [ ] follow up on this\nMore text\n", 60);

    const hits = findStaleNotes(vault, 30, undefined);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].relPath, "old-with-checkbox.md");
    assert.ok(hits[0].openItems[0].includes("follow up on this"));
  });

  test("flags an old note with an English 'Next steps' heading", () => {
    const vault = makeTempVault();
    writeNoteWithAge(vault, "old-with-heading.md", "# Doc\n\n## Next steps\nDo the thing.\n", 45);

    const hits = findStaleNotes(vault, 30, undefined);
    assert.equal(hits.length, 1);
    assert.match(hits[0].openItems[0], /next steps/i);
  });

  test("flags an old note with a Russian 'Дальнейшие шаги' heading", () => {
    const vault = makeTempVault();
    writeNoteWithAge(vault, "old-ru.md", "# Заметка\n\n## Дальнейшие шаги\nСделать X.\n", 90);

    const hits = findStaleNotes(vault, 30, undefined);
    assert.equal(hits.length, 1);
    assert.match(hits[0].openItems[0], /дальнейшие шаги/i);
  });

  test("does not flag an old note with no open-item markers", () => {
    const vault = makeTempVault();
    writeNoteWithAge(vault, "old-done.md", "# Finished project\n\nEverything here is complete.\n", 90);

    const hits = findStaleNotes(vault, 30, undefined);
    assert.equal(hits.length, 0);
  });

  test("does not flag a recently-edited note even with an open item", () => {
    const vault = makeTempVault();
    writeNoteWithAge(vault, "recent.md", "- [ ] still open but edited yesterday\n", 1);

    const hits = findStaleNotes(vault, 30, undefined);
    assert.equal(hits.length, 0);
  });

  test("respects the scope folder-prefix filter", () => {
    const vault = makeTempVault();
    writeNoteWithAge(vault, "InScope/a.md", "- [ ] in scope\n", 60);
    writeNoteWithAge(vault, "OutOfScope/b.md", "- [ ] out of scope\n", 60);

    const hits = findStaleNotes(vault, 30, "InScope/");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].relPath, "InScope/a.md");
  });
});
