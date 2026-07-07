export interface NoteFrontmatter {
  [key: string]: unknown;
  tags?: string[];
}

export interface ParsedNote {
  /** Path relative to the vault root, using forward slashes, e.g. "Инвестиции/2026-07-06.md" */
  relPath: string;
  frontmatter: NoteFrontmatter;
  /** Body content, frontmatter stripped */
  content: string;
  /** Raw file content, frontmatter included, as stored on disk */
  raw: string;
  mtimeMs: number;
}

export interface ChunkRow {
  id: number;
  rel_path: string;
  chunk_index: number;
  text: string;
  embedding: Buffer;
}

export interface FileIndexRow {
  rel_path: string;
  mtime_ms: number;
  content_hash: string;
}

export interface SemanticSearchHit {
  relPath: string;
  chunkIndex: number;
  score: number;
  snippet: string;
}

export interface KeywordSearchHit {
  relPath: string;
  line: number;
  snippet: string;
}

export interface HybridSearchHit {
  relPath: string;
  score: number;
  sources: ("semantic" | "keyword")[];
  snippet: string;
}

export interface ReindexResult {
  filesScanned: number;
  filesUpdated: number;
  filesDeleted: number;
  chunksIndexed: number;
  durationMs: number;
}

export interface ConsistencyPair {
  noteA: string;
  noteB: string;
  score: number;
  textOverlap: number;
  snippetA: string;
  snippetB: string;
}

export interface StaleNoteHit {
  relPath: string;
  ageDays: number;
  openItems: string[];
}

export interface AttachmentCacheRow {
  rel_path: string;
  content_hash: string;
  extracted_text: string;
}
