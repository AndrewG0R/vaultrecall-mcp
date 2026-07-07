import { OPEN_ITEM_MARKERS } from "../constants.js";
import { readNote, walkVaultMarkdownFiles } from "./notes.js";
import type { StaleNoteHit } from "../types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function findOpenItemLines(content: string): string[] {
  const hits: string[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const marker = OPEN_ITEM_MARKERS.find((m) => m.pattern.test(rawLine));
    if (marker) hits.push(`[${marker.label}] ${line}`);
  }
  return hits;
}

/**
 * Purely informational: flags notes that look "left open" (old + still has an unchecked item or an
 * open-questions/next-steps heading) so the user can decide whether to revisit or close them out
 * themselves. Never archives, checks off, or edits anything.
 */
export function findStaleNotes(vaultRoot: string, days: number, scope: string | undefined): StaleNoteHit[] {
  const now = Date.now();
  const cutoffMs = days * MS_PER_DAY;
  const results: StaleNoteHit[] = [];

  for (const relPath of walkVaultMarkdownFiles(vaultRoot)) {
    if (scope && !relPath.startsWith(scope)) continue;

    let note;
    try {
      note = readNote(vaultRoot, relPath);
    } catch {
      continue;
    }

    const ageMs = now - note.mtimeMs;
    if (ageMs < cutoffMs) continue;

    const openItems = findOpenItemLines(note.content);
    if (openItems.length === 0) continue;

    results.push({ relPath, ageDays: Math.floor(ageMs / MS_PER_DAY), openItems });
  }

  results.sort((a, b) => b.ageDays - a.ageDays);
  return results;
}
