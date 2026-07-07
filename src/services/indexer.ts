import crypto from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import { MAX_FILES_PER_REINDEX_PASS } from "../constants.js";
import { chunkText, readNote, walkVaultFiles, walkVaultMarkdownFiles } from "./notes.js";
import {
  allKnownRelPaths,
  commitFileIndex,
  deleteFileAndChunks,
  getAttachmentCache,
  getFileRow,
  upsertAttachmentCache,
} from "./db.js";
import { embedText } from "./embeddings.js";
import { findAttachmentEmbeds, resolveAttachment } from "./attachments.js";
import { extractAttachmentText, hashFile } from "./ocr.js";
import type { ParsedNote, ReindexResult } from "../types.js";

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * A tag-only or topic-only query (e.g. "what do I have about investing") should be able to surface
 * a note even when that exact word never appears in its body. Prepending the note's tags and title
 * to the FIRST chunk's embedding input (only) gives the vector that context, without touching what's
 * actually stored/returned as the chunk's text — search snippets still show real note content.
 */
function buildEmbeddingInput(note: ParsedNote, bodyChunk: string, chunkIndex: number): string {
  if (chunkIndex !== 0) return bodyChunk;

  const title = path.basename(note.relPath, path.extname(note.relPath));
  const tags = Array.isArray(note.frontmatter.tags) ? note.frontmatter.tags.map(String) : [];
  const metaLines = [`Title: ${title}`, tags.length ? `Tags: ${tags.join(", ")}` : null].filter(
    (line): line is string => line !== null
  );
  return metaLines.length ? `${metaLines.join("\n")}\n\n${bodyChunk}` : bodyChunk;
}

/**
 * OCRs (images) or extracts the text layer (PDFs) of every attachment a note embeds via
 * `![[file.png]]`/`![[file.pdf]]`, so a search for words that only appear in a screenshot or a
 * scanned document can still find the note. Purely additive to the SEARCH INDEX — never written
 * back into the note file. Each attachment's extracted text is cached by content hash, so an
 * unchanged attachment is never re-OCR'd on a later reindex. A failure on any one attachment (bad
 * file, OCR error, unsupported format) is logged and skipped — it never fails the whole reindex.
 */
export async function extractAttachmentsText(
  db: Database.Database,
  vaultRoot: string,
  relPath: string,
  noteContent: string,
  allVaultFiles: string[]
): Promise<string> {
  const embedRefs = findAttachmentEmbeds(noteContent);
  if (embedRefs.length === 0) return "";

  const texts: string[] = [];
  for (const ref of embedRefs) {
    try {
      const resolved = resolveAttachment(vaultRoot, ref, allVaultFiles);
      if (!resolved) continue;

      const absPath = path.join(vaultRoot, resolved);
      const hash = hashFile(absPath);
      const cached = getAttachmentCache(db, resolved);

      const text =
        cached && cached.content_hash === hash ? cached.extracted_text : await extractAttachmentText(absPath);

      if (!cached || cached.content_hash !== hash) {
        upsertAttachmentCache(db, { rel_path: resolved, content_hash: hash, extracted_text: text });
      }
      if (text) texts.push(`[Attachment: ${path.basename(resolved)}]\n${text}`);
    } catch (err) {
      console.error(
        `Skipping attachment "${ref}" referenced by "${relPath}" (OCR/extraction failed): ` +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }
  return texts.join("\n\n");
}

export async function reindexVault(vaultRoot: string, db: Database.Database): Promise<ReindexResult> {
  const start = Date.now();
  const allFiles = walkVaultMarkdownFiles(vaultRoot).slice(0, MAX_FILES_PER_REINDEX_PASS);
  const allVaultFiles = walkVaultFiles(vaultRoot); // every file, any extension — used to resolve ![[attachment]] embeds
  const knownPaths = allKnownRelPaths(db);
  const seenPaths = new Set<string>();

  let filesUpdated = 0;
  let chunksIndexed = 0;

  for (const relPath of allFiles) {
    seenPaths.add(relPath);
    let note;
    try {
      note = readNote(vaultRoot, relPath);
    } catch {
      continue; // unreadable file (permissions, race with external edit, etc.) — skip, don't crash the pass
    }

    const contentHash = hashContent(note.content);
    const existing = getFileRow(db, relPath);
    if (existing && existing.content_hash === contentHash) {
      continue; // unchanged since last index — skip re-embedding
    }

    const chunks = chunkText(note.content);
    const attachmentsText = await extractAttachmentsText(db, vaultRoot, relPath, note.content, allVaultFiles);
    if (attachmentsText) chunks.push(...chunkText(attachmentsText));

    const embedded: { text: string; embedding: Float32Array }[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const vec = await embedText(buildEmbeddingInput(note, chunks[i], i));
      embedded.push({ text: chunks[i], embedding: vec });
    }

    commitFileIndex(db, { rel_path: relPath, mtime_ms: note.mtimeMs, content_hash: contentHash }, embedded);
    filesUpdated += 1;
    chunksIndexed += embedded.length;
  }

  // Anything indexed previously but no longer present on disk gets dropped from the index.
  let filesDeleted = 0;
  for (const known of knownPaths) {
    if (!seenPaths.has(known)) {
      deleteFileAndChunks(db, known);
      filesDeleted += 1;
    }
  }

  return {
    filesScanned: allFiles.length,
    filesUpdated,
    filesDeleted,
    chunksIndexed,
    durationMs: Date.now() - start,
  };
}
