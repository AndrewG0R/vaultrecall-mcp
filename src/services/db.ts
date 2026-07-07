import path from "node:path";
import Database from "better-sqlite3";
import { EMBEDDING_DIMS, EMBEDDING_MODEL } from "../constants.js";
import { appDataDir, vaultIndexId } from "./vaultPath.js";
import type { AttachmentCacheRow, ChunkRow, FileIndexRow } from "../types.js";

/**
 * The index database lives OUTSIDE the vault (in the OS user data dir), never inside it.
 * Reasons: it's a binary sqlite file, not a note; Obsidian sync/git tools shouldn't have to
 * deal with it; and it must survive even if the vault folder itself gets moved or re-cloned.
 */
function indexDbPath(vaultRoot: string): string {
  return path.join(appDataDir(), `${vaultIndexId(vaultRoot)}.sqlite`);
}

/** Creates the schema on a fresh or existing Database handle. Exported (in addition to openIndexDb) so tests can build an isolated in-memory index without going through the vault-path-derived file location. */
export function initSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      rel_path TEXT PRIMARY KEY,
      mtime_ms REAL NOT NULL,
      content_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rel_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_rel_path ON chunks(rel_path);
    CREATE TABLE IF NOT EXISTS attachments (
      rel_path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      extracted_text TEXT NOT NULL
    );
  `);
  ensureEmbeddingModelVersion(db);
}

export function openIndexDb(vaultRoot: string): Database.Database {
  const db = new Database(indexDbPath(vaultRoot));
  initSchema(db);
  return db;
}

/**
 * Embeddings from different models aren't comparable. If the configured model changed since this
 * index was built, the stored vectors are stale garbage — wipe files+chunks so the next reindex
 * treats every note as new and rebuilds the index from scratch under the current model.
 */
function ensureEmbeddingModelVersion(db: Database.Database): void {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'embedding_model'").get() as
    | { value: string }
    | undefined;
  if (row?.value === EMBEDDING_MODEL) return;

  db.exec("DELETE FROM chunks; DELETE FROM files;");
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('embedding_model', @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run({ value: EMBEDDING_MODEL });
}

export function getFileRow(db: Database.Database, relPath: string): FileIndexRow | undefined {
  return db.prepare("SELECT rel_path, mtime_ms, content_hash FROM files WHERE rel_path = ?").get(relPath) as
    | FileIndexRow
    | undefined;
}

/**
 * Replaces a file's chunks and updates its file row in one transaction, so a process kill
 * mid-write can never leave chunks committed without the matching file row (or vice versa) —
 * on restart, SQLite rolls back the incomplete transaction and the file is simply re-indexed
 * on the next reindex pass, exactly as if the write had never started.
 */
export function commitFileIndex(
  db: Database.Database,
  fileRow: FileIndexRow,
  chunks: { text: string; embedding: Float32Array }[]
): void {
  const delChunks = db.prepare("DELETE FROM chunks WHERE rel_path = ?");
  const insertChunk = db.prepare(
    "INSERT INTO chunks (rel_path, chunk_index, text, embedding) VALUES (?, ?, ?, ?)"
  );
  const upsertFile = db.prepare(
    `INSERT INTO files (rel_path, mtime_ms, content_hash) VALUES (@rel_path, @mtime_ms, @content_hash)
     ON CONFLICT(rel_path) DO UPDATE SET mtime_ms = excluded.mtime_ms, content_hash = excluded.content_hash`
  );
  const tx = db.transaction(() => {
    delChunks.run(fileRow.rel_path);
    chunks.forEach((c, i) => {
      insertChunk.run(fileRow.rel_path, i, c.text, Buffer.from(c.embedding.buffer));
    });
    upsertFile.run(fileRow);
  });
  tx();
}

/** Same atomicity concern in reverse: a deleted note must lose its file row and its chunks together, or an orphaned chunk row survives forever (it's no longer in `files`, so the next reindex's known-paths comparison never sees it again to clean it up). */
export function deleteFileAndChunks(db: Database.Database, relPath: string): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM files WHERE rel_path = ?").run(relPath);
    db.prepare("DELETE FROM chunks WHERE rel_path = ?").run(relPath);
  });
  tx();
}

export function allKnownRelPaths(db: Database.Database): Set<string> {
  const rows = db.prepare("SELECT rel_path FROM files").all() as { rel_path: string }[];
  return new Set(rows.map((r) => r.rel_path));
}

export function allFileMtimes(db: Database.Database): Map<string, number> {
  const rows = db.prepare("SELECT rel_path, mtime_ms FROM files").all() as {
    rel_path: string;
    mtime_ms: number;
  }[];
  return new Map(rows.map((r) => [r.rel_path, r.mtime_ms]));
}

export function allChunks(db: Database.Database): ChunkRow[] {
  return db.prepare("SELECT id, rel_path, chunk_index, text, embedding FROM chunks").all() as ChunkRow[];
}

/** OCR/text-extraction is comparatively expensive, so its output is cached by attachment content hash — an unchanged attachment is never re-processed on subsequent reindexes. */
export function getAttachmentCache(db: Database.Database, relPath: string): AttachmentCacheRow | undefined {
  return db.prepare("SELECT rel_path, content_hash, extracted_text FROM attachments WHERE rel_path = ?").get(relPath) as
    | AttachmentCacheRow
    | undefined;
}

export function upsertAttachmentCache(db: Database.Database, row: AttachmentCacheRow): void {
  db.prepare(
    `INSERT INTO attachments (rel_path, content_hash, extracted_text) VALUES (@rel_path, @content_hash, @extracted_text)
     ON CONFLICT(rel_path) DO UPDATE SET content_hash = excluded.content_hash, extracted_text = excluded.extracted_text`
  ).run(row);
}

export function bufferToFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

export function assertDims(vec: Float32Array): void {
  if (vec.length !== EMBEDDING_DIMS) {
    throw new Error(`Embedding dimension mismatch: expected ${EMBEDDING_DIMS}, got ${vec.length}`);
  }
}
