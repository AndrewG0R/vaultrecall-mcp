import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findAttachmentEmbeds, resolveAttachment } from "./attachments.js";

describe("findAttachmentEmbeds", () => {
  test("extracts image and PDF embeds", () => {
    const content = "See ![[screenshot.png]] and also ![[report.pdf]].";
    assert.deepEqual(findAttachmentEmbeds(content), ["screenshot.png", "report.pdf"]);
  });

  test("ignores note-to-note embeds (non-OCR-able extensions)", () => {
    const content = "See ![[Some Other Note]] and ![[Some Other Note.md]] for context.";
    assert.deepEqual(findAttachmentEmbeds(content), []);
  });

  test("strips a display-size/alias suffix like |300", () => {
    const content = "![[diagram.png|300]]";
    assert.deepEqual(findAttachmentEmbeds(content), ["diagram.png"]);
  });

  test("deduplicates repeated references to the same attachment", () => {
    const content = "![[scan.pdf]] ... later again ![[scan.pdf]]";
    assert.deepEqual(findAttachmentEmbeds(content), ["scan.pdf"]);
  });

  test("returns an empty array when there are no embeds", () => {
    assert.deepEqual(findAttachmentEmbeds("just plain text, no embeds here"), []);
  });
});

describe("resolveAttachment", () => {
  function makeTempVault(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-attach-"));
    fs.mkdirSync(path.join(dir, "Assets"));
    fs.writeFileSync(path.join(dir, "Assets", "photo.png"), "fake png bytes");
    return dir;
  }

  test("resolves a bare filename by searching the vault (Obsidian's own convention)", () => {
    const vault = makeTempVault();
    const allFiles = ["Assets/photo.png", "note.md"];
    assert.equal(resolveAttachment(vault, "photo.png", allFiles), "Assets/photo.png");
  });

  test("resolves a reference that already includes the correct relative path", () => {
    const vault = makeTempVault();
    const allFiles = ["Assets/photo.png", "note.md"];
    assert.equal(resolveAttachment(vault, "Assets/photo.png", allFiles), "Assets/photo.png");
  });

  test("returns undefined when no matching file exists anywhere in the vault", () => {
    const vault = makeTempVault();
    const allFiles = ["Assets/photo.png", "note.md"];
    assert.equal(resolveAttachment(vault, "missing.png", allFiles), undefined);
  });
});
