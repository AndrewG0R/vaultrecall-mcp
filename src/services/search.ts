import type Database from "better-sqlite3";
import { RECENCY_BOOST_WEIGHT, RECENCY_HALF_LIFE_DAYS } from "../constants.js";
import { readNote, walkVaultMarkdownFiles } from "./notes.js";
import { allChunks, allFileMtimes, bufferToFloat32 } from "./db.js";
import { cosineSim, embedText } from "./embeddings.js";
import type { HybridSearchHit, KeywordSearchHit, SemanticSearchHit } from "../types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Small time-decay nudge for recently-edited notes (see RECENCY_BOOST_WEIGHT/RECENCY_HALF_LIFE_DAYS
 * for the tuning). Exported standalone so it's independently testable without a db or the embedding
 * model.
 */
export function recencyBoost(mtimeMs: number | undefined, now: number = Date.now()): number {
  if (mtimeMs === undefined) return 0;
  const ageDays = Math.max((now - mtimeMs) / MS_PER_DAY, 0);
  return RECENCY_BOOST_WEIGHT * Math.pow(2, -ageDays / RECENCY_HALF_LIFE_DAYS);
}

async function rawSemanticHits(db: Database.Database, query: string, topK: number): Promise<SemanticSearchHit[]> {
  const queryVec = await embedText(query);
  const chunks = allChunks(db);

  const scored = chunks.map((c) => ({
    relPath: c.rel_path,
    chunkIndex: c.chunk_index,
    score: cosineSim(queryVec, bufferToFloat32(c.embedding)),
    snippet: c.text.length > 400 ? `${c.text.slice(0, 400)}…` : c.text,
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export async function semanticSearch(
  db: Database.Database,
  query: string,
  topK: number
): Promise<SemanticSearchHit[]> {
  const hits = await rawSemanticHits(db, query, topK);
  const mtimes = allFileMtimes(db);
  return hits
    .map((h) => ({ ...h, score: h.score + recencyBoost(mtimes.get(h.relPath)) }))
    .sort((a, b) => b.score - a.score);
}

export function keywordSearch(vaultRoot: string, query: string, topK: number): KeywordSearchHit[] {
  const needle = query.toLowerCase();
  const hits: KeywordSearchHit[] = [];

  for (const relPath of walkVaultMarkdownFiles(vaultRoot)) {
    if (hits.length >= topK) break;
    let note;
    try {
      note = readNote(vaultRoot, relPath);
    } catch {
      continue;
    }
    const lines = note.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        hits.push({ relPath, line: i + 1, snippet: lines[i].trim().slice(0, 300) });
        if (hits.length >= topK) break;
      }
    }
  }

  return hits;
}

/**
 * Merges semantic + keyword results at note level: semantic contributes its cosine score (0-1),
 * keyword contributes a rank-based score (exact substring matches are strong signal but have no
 * natural 0-1 score of their own). Notes hit by both searches get their scores summed, so
 * agreement between the two methods surfaces the note higher than either alone would. The recency
 * boost is applied exactly once per note, AFTER both signals are combined — applying it inside each
 * signal separately would double-count it for a note that matches both.
 *
 * Pure and synchronous (no db/model access) so it's directly unit-testable with fabricated hits —
 * in particular the "best chunk per note" merge behavior above, which previously had a bug where a
 * later, weaker chunk from the same note silently overwrote its best-scoring chunk.
 */
export function mergeHybridHits(
  semanticHits: SemanticSearchHit[],
  keywordHits: KeywordSearchHit[],
  mtimes: Map<string, number>,
  topK: number
): HybridSearchHit[] {
  const merged = new Map<string, HybridSearchHit>();

  // A note can contribute multiple chunks to semanticHits; keep its best-scoring chunk as the
  // note's representative score+snippet rather than letting a later, weaker chunk overwrite it.
  for (const hit of semanticHits) {
    const existing = merged.get(hit.relPath);
    if (!existing) {
      merged.set(hit.relPath, { relPath: hit.relPath, score: hit.score, sources: ["semantic"], snippet: hit.snippet });
    } else if (hit.score > existing.score) {
      existing.score = hit.score;
      existing.snippet = hit.snippet;
    }
  }

  keywordHits.forEach((hit, i) => {
    const rankScore = 1 - i / (keywordHits.length * 2); // decays from ~1 toward ~0.5 across the result list
    const existing = merged.get(hit.relPath);
    if (existing) {
      existing.score += rankScore;
      if (!existing.sources.includes("keyword")) existing.sources.push("keyword");
    } else {
      merged.set(hit.relPath, {
        relPath: hit.relPath,
        score: rankScore,
        sources: ["keyword"],
        snippet: hit.snippet,
      });
    }
  });

  return [...merged.values()]
    .map((hit) => ({ ...hit, score: hit.score + recencyBoost(mtimes.get(hit.relPath)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export async function hybridSearch(
  db: Database.Database,
  vaultRoot: string,
  query: string,
  topK: number
): Promise<HybridSearchHit[]> {
  const fanOut = Math.max(topK * 3, topK);
  const [semanticHits, keywordHits] = await Promise.all([
    rawSemanticHits(db, query, fanOut),
    Promise.resolve(keywordSearch(vaultRoot, query, fanOut)),
  ]);
  const mtimes = allFileMtimes(db);

  return mergeHybridHits(semanticHits, keywordHits, mtimes, topK);
}
