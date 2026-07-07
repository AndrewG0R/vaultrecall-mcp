import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
  assertMarkdownExtension,
  ensureParentDirExists,
  resolveInVault,
} from "./vaultPath.js";
import { ALLOWED_EXTENSIONS, CHUNK_OVERLAP_CHARS, CHUNK_SIZE_CHARS, IGNORED_DIR_NAMES } from "../constants.js";
import type { ParsedNote } from "../types.js";

/** Recursively lists every file's vault-relative path, skipping ignored/system directories. Optionally filtered. */
export function walkVaultFiles(vaultRoot: string, filter?: (relPath: string) => boolean): string[] {
  const results: string[] = [];

  function walk(absDir: string, relDir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIR_NAMES.has(entry.name)) continue;
      const absChild = path.join(absDir, entry.name);
      const relChild = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(absChild, relChild);
      } else if (entry.isFile()) {
        if (!filter || filter(relChild)) results.push(relChild);
      }
    }
  }

  walk(vaultRoot, "");
  return results;
}

/** Recursively lists every markdown file's vault-relative path, skipping ignored/system directories. */
export function walkVaultMarkdownFiles(vaultRoot: string): string[] {
  return walkVaultFiles(vaultRoot, (relPath) => ALLOWED_EXTENSIONS.includes(path.extname(relPath).toLowerCase()));
}

export function readNote(vaultRoot: string, relPath: string): ParsedNote {
  const abs = resolveInVault(vaultRoot, relPath);
  const raw = fs.readFileSync(abs, "utf-8");
  const stat = fs.statSync(abs);
  const parsed = matter(raw);
  return {
    relPath,
    frontmatter: parsed.data ?? {},
    content: parsed.content,
    raw,
    mtimeMs: stat.mtimeMs,
  };
}

export type WriteMode = "overwrite" | "append" | "create_only";

export function writeNote(
  vaultRoot: string,
  relPath: string,
  content: string,
  mode: WriteMode,
  frontmatter?: Record<string, unknown>
): { relPath: string; bytesWritten: number; mode: WriteMode } {
  assertMarkdownExtension(relPath);
  const abs = resolveInVault(vaultRoot, relPath);
  ensureParentDirExists(abs);

  const exists = fs.existsSync(abs);
  if (mode === "create_only" && exists) {
    throw new Error(
      `"${relPath}" already exists. Use mode "append" to add to it or "overwrite" to replace it.`
    );
  }

  if (mode === "append" && exists) {
    const existingRaw = fs.readFileSync(abs, "utf-8");
    const existingParsed = matter(existingRaw);
    const mergedFm = { ...existingParsed.data, ...(frontmatter ?? {}) };
    const newBody = `${existingParsed.content.replace(/\s+$/, "")}\n\n${content}\n`;
    const out = Object.keys(mergedFm).length > 0 ? matter.stringify(newBody, mergedFm) : newBody;
    fs.writeFileSync(abs, out, "utf-8");
    return { relPath, bytesWritten: Buffer.byteLength(out, "utf-8"), mode };
  }

  const out = frontmatter && Object.keys(frontmatter).length > 0
    ? matter.stringify(content, frontmatter)
    : content;
  fs.writeFileSync(abs, out, "utf-8");
  return { relPath, bytesWritten: Buffer.byteLength(out, "utf-8"), mode };
}

export function listTags(vaultRoot: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const relPath of walkVaultMarkdownFiles(vaultRoot)) {
    try {
      const note = readNote(vaultRoot, relPath);
      const fmTags = Array.isArray(note.frontmatter.tags) ? note.frontmatter.tags : [];
      for (const t of fmTags) {
        const key = String(t);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const inlineMatches = note.content.match(/#[a-zA-Zа-яА-ЯёЁ0-9_/-]+/g) ?? [];
      for (const m of inlineMatches) {
        const key = m.slice(1);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    } catch {
      // unreadable file, skip
    }
  }
  return counts;
}

/**
 * Compares newly-proposed tags against the vault's existing tag vocabulary, to nudge against
 * accidentally creating near-duplicate synonyms (e.g. "investing" vs "investments"). Purely
 * advisory — returns suggestions, never blocks the write.
 */
export interface TagSuggestion {
  tag: string;
  existing: boolean;
  similarTags: string[];
}

export function suggestTagCorrections(vaultRoot: string, proposedTags: string[]): TagSuggestion[] {
  const known = [...listTags(vaultRoot).keys()];
  const knownLower = new Map(known.map((t) => [t.toLowerCase(), t]));

  return proposedTags.map((tag) => {
    const lower = tag.toLowerCase();
    if (knownLower.has(lower)) {
      return { tag, existing: true, similarTags: [] };
    }
    const similarTags = known
      .filter((k) => k.toLowerCase() !== lower)
      .map((k) => ({ tag: k, distance: levenshtein(lower, k.toLowerCase()) }))
      .filter(({ tag: k, distance }) => distance <= 2 || k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase()))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3)
      .map((m) => m.tag);
    return { tag, existing: false, similarTags };
  });
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/**
 * Splits note body into chunks for embedding, preferring markdown structure over raw character
 * offsets: each "## " section becomes its own chunk (keeping headings and their content together),
 * falling back to character-based splitting only when a section is too large, or when the note has
 * no "##" headings at all.
 */
export function chunkText(text: string, chunkSize = CHUNK_SIZE_CHARS, overlap = CHUNK_OVERLAP_CHARS): string[] {
  const clean = text.trim();
  if (!clean) return [];

  const sections = splitByH2Sections(clean);
  if (sections.length <= 1) {
    return chunkByChars(clean, chunkSize, overlap);
  }

  const chunks: string[] = [];
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    if (trimmed.length <= chunkSize) {
      chunks.push(trimmed);
    } else {
      chunks.push(...chunkByChars(trimmed, chunkSize, overlap));
    }
  }
  return chunks;
}

/** Splits on lines starting with "## " (a level-2 heading), keeping each heading with the content that follows it. */
function splitByH2Sections(text: string): string[] {
  const lines = text.split("\n");
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^##\s+/.test(line) && current.length > 0) {
      sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) sections.push(current.join("\n"));
  return sections;
}

/** Overlapping character-based split. Simple and predictable beats clever and fragile here. */
function chunkByChars(text: string, chunkSize: number, overlap: number): string[] {
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - overlap;
  }
  return chunks;
}
