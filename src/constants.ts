/**
 * Local embedding model. Runs fully on-device via @xenova/transformers — no API key, no network calls, nothing leaves this machine.
 * Multilingual (paraphrase-multilingual-MiniLM-L12-v2) so cross-language queries (e.g. a Russian query matching an
 * English note) stay meaningful. Changing this value invalidates every stored embedding — see db.ts's model-version
 * check, which wipes the index automatically so the next reindex rebuilds it under the new model.
 */
export const EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const EMBEDDING_DIMS = 384;

/** Chunking parameters for building the semantic index (character-based, simple and predictable). */
export const CHUNK_SIZE_CHARS = 800;
export const CHUNK_OVERLAP_CHARS = 150;

/** Only these extensions are ever read/written/indexed. Everything else is invisible to the server. */
export const ALLOWED_EXTENSIONS = [".md", ".markdown"];

/** Folders that are never walked, read, written, or indexed, even though they live inside the vault. */
export const IGNORED_DIR_NAMES = new Set([".obsidian", ".git", ".trash", "node_modules"]);

/** Hard cap on how much text a single tool response will return, to keep context usage predictable. */
export const RESPONSE_CHARACTER_LIMIT = 12000;

/** Max number of files walked per reindex call, to keep a single tool call bounded on huge vaults. */
export const MAX_FILES_PER_REINDEX_PASS = 5000;

export const DEFAULT_SEARCH_TOP_K = 8;
export const MAX_SEARCH_TOP_K = 30;

/**
 * Recency nudge applied to search scores so a recently-edited note wins a near-tie against an
 * older one with a marginally higher relevance score. Deliberately small relative to a typical
 * cosine-similarity gap (~0.05-0.4) — this breaks ties, it doesn't override real relevance.
 * Boost = RECENCY_BOOST_WEIGHT * 2^(-ageInDays / RECENCY_HALF_LIFE_DAYS), so it's RECENCY_BOOST_WEIGHT
 * for a note edited right now, half that at one half-life old, and negligible well beyond it.
 */
export const RECENCY_BOOST_WEIGHT = 0.05;
export const RECENCY_HALF_LIFE_DAYS = 30;

/**
 * second_brain_check_consistency tuning. CONSISTENCY_SIMILARITY_THRESHOLD is a cosine-similarity
 * cutoff (same embedding space as search) above which two chunks from DIFFERENT notes are considered
 * "about the same specific thing" and worth flagging as a possible contradiction — picked empirically
 * against this project's real vault, where same-topic-different-specifics note pairs scored ~0.6-0.8
 * and unrelated pairs scored ~0.1-0.4. CONSISTENCY_DUPLICATE_JACCARD_THRESHOLD then excludes pairs
 * whose matched text is essentially the same wording (a near-duplicate, not a contradiction) — measured
 * via Jaccard similarity over CONSISTENCY_SHINGLE_SIZE-word shingles.
 */
export const CONSISTENCY_SIMILARITY_THRESHOLD = 0.6;
export const CONSISTENCY_DUPLICATE_JACCARD_THRESHOLD = 0.5;
export const CONSISTENCY_SHINGLE_SIZE = 5;
export const DEFAULT_CONSISTENCY_TOP_K = 15;

/** second_brain_stale_notes default lookback window when the caller doesn't specify one. */
export const DEFAULT_STALE_DAYS = 30;

/**
 * Line-level markers that flag a note as having open/unfinished items. Deliberately a plain data
 * array (not hardcoded logic) so it's easy to extend for more languages or phrasings without
 * touching the matching code — this vault mixes Russian and English notes, so both are covered.
 */
export const OPEN_ITEM_MARKERS: { label: string; pattern: RegExp }[] = [
  { label: "unchecked checkbox", pattern: /^\s*[-*]\s\[\s\]/ },
  {
    label: "open-items heading (en)",
    pattern: /^#{1,6}\s*(next steps|todo|to-do|action items?|open questions)\b/i,
  },
  {
    // No trailing `\b` here: JS regex word boundaries are ASCII-only (`\w` doesn't include
    // Cyrillic), so `\b` right after a Cyrillic word silently fails to match at all.
    label: "open-items heading (ru)",
    pattern: /^#{1,6}\s*(дальнейшие шаги|следующие шаги|открытые вопросы|незакрытые вопросы)/i,
  },
];

/** Attachment extensions second_brain_reindex will try to OCR/extract text from when embedded via ![[...]]. */
export const OCR_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"];
export const OCR_PDF_EXTENSIONS = [".pdf"];

/** tesseract.js language packs loaded for image OCR. Extend if your vault uses other languages. */
export const OCR_LANGUAGES = ["eng", "rus"];
