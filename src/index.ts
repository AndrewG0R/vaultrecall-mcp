#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { DEFAULT_CONSISTENCY_TOP_K, DEFAULT_SEARCH_TOP_K, DEFAULT_STALE_DAYS, MAX_SEARCH_TOP_K, RESPONSE_CHARACTER_LIMIT } from "./constants.js";
import { checkConsistency } from "./services/consistency.js";
import { openIndexDb } from "./services/db.js";
import { reindexVault } from "./services/indexer.js";
import { listTags, readNote, suggestTagCorrections, walkVaultMarkdownFiles, writeNote } from "./services/notes.js";
import { hybridSearch, keywordSearch, semanticSearch } from "./services/search.js";
import { findStaleNotes } from "./services/staleNotes.js";
import { VaultPathError } from "./services/vaultPath.js";
import { runInit } from "./init.js";

const [, , firstArg, secondArg] = process.argv;

if (firstArg === "init") {
  await runInit(secondArg);
  process.exit(process.exitCode ?? 0);
}

const vaultRoot = firstArg ?? process.env.OBSIDIAN_VAULT_PATH;

if (!vaultRoot) {
  console.error(
    "Missing vault path. Pass it as the first CLI arg or set OBSIDIAN_VAULT_PATH in the server env."
  );
  process.exit(1);
}

const resolvedVaultRoot = path.resolve(vaultRoot);
if (!fs.existsSync(resolvedVaultRoot) || !fs.statSync(resolvedVaultRoot).isDirectory()) {
  console.error(`Vault path does not exist or is not a directory: ${resolvedVaultRoot}`);
  process.exit(1);
}

const db = openIndexDb(resolvedVaultRoot);

function truncate(text: string): string {
  return text.length > RESPONSE_CHARACTER_LIMIT
    ? `${text.slice(0, RESPONSE_CHARACTER_LIMIT)}\n\n[...truncated, response exceeded ${RESPONSE_CHARACTER_LIMIT} characters]`
    : text;
}

function errorResult(err: unknown) {
  const message = err instanceof VaultPathError ? err.message : err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

const server = new McpServer({ name: "second-brain-mcp-server", version: "1.0.0" });

server.registerTool(
  "second_brain_read_note",
  {
    title: "Read Note",
    description: `Read a single note from the vault by its path relative to the vault root (e.g. "Инвестиции/2026-07-06.md").

Returns the note's frontmatter (parsed as an object), its body content (frontmatter stripped), and its raw file content.

Error Handling:
  - Returns "Error: ...ENOENT..." if the note doesn't exist.
  - Returns "Error: Refusing to access..." if the path resolves outside the vault or targets a protected system directory.`,
    inputSchema: {
      path: z.string().min(1).describe('Vault-relative path to the note, e.g. "Работа/статус.md"'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ path: relPath }) => {
    try {
      const note = readNote(resolvedVaultRoot, relPath);
      const output = {
        path: note.relPath,
        frontmatter: note.frontmatter,
        content: note.content,
      };
      return {
        content: [{ type: "text", text: truncate(JSON.stringify(output, null, 2)) }],
        structuredContent: output,
      };
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "second_brain_write_note",
  {
    title: "Write Note",
    description: `Create, overwrite, or append to a note in the vault.

Args:
  - path (string): Vault-relative path, must end in .md or .markdown.
  - content (string): Body text to write.
  - mode ('create_only' | 'overwrite' | 'append'):
      'create_only' fails if the file already exists (safe default for new notes).
      'overwrite' replaces the entire file content.
      'append' adds content to the end of the existing body, merging frontmatter if provided.
  - frontmatter (object, optional): Key-value frontmatter fields (e.g. { tags: ["investing"] }).

Returns confirmation with the path and bytes written. If frontmatter.tags includes a tag that isn't
already used elsewhere in the vault, the response's "tagSuggestions" field lists similarly-named
existing tags (if any) — check it to avoid creating an accidental synonym (e.g. "investing" vs
"investments") instead of reusing the existing tag.

Error Handling:
  - Returns "Error: ... already exists" if mode is 'create_only' and the file exists — retry with 'append' or 'overwrite'.
  - Returns "Error: Refusing to write..." for non-markdown extensions or paths outside the vault.`,
    inputSchema: {
      path: z.string().min(1).describe('Vault-relative path ending in .md, e.g. "Инвестиции/заметка.md"'),
      content: z.string().describe("Body text to write (frontmatter is handled separately)."),
      mode: z.enum(["create_only", "overwrite", "append"]).default("create_only"),
      frontmatter: z.record(z.unknown()).optional().describe('Optional frontmatter object, e.g. {"tags": ["work"]}'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ path: relPath, content, mode, frontmatter }) => {
    try {
      const result = writeNote(resolvedVaultRoot, relPath, content, mode, frontmatter);
      const proposedTags = Array.isArray(frontmatter?.tags) ? frontmatter.tags.map(String) : [];
      const tagSuggestions = proposedTags.length
        ? suggestTagCorrections(resolvedVaultRoot, proposedTags).filter((s) => !s.existing && s.similarTags.length > 0)
        : [];
      const output = { ...result, tagSuggestions };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "second_brain_list_notes",
  {
    title: "List Notes",
    description: `List every note path in the vault, optionally filtered by a prefix (e.g. a folder name like "Инвестиции/").

Returns an array of vault-relative paths and the total count.`,
    inputSchema: {
      prefix: z.string().optional().describe('Optional folder/path prefix filter, e.g. "Инвестиции/"'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ prefix }) => {
    const all = walkVaultMarkdownFiles(resolvedVaultRoot);
    const filtered = prefix ? all.filter((p) => p.startsWith(prefix)) : all;
    const output = { count: filtered.length, paths: filtered };
    return {
      content: [{ type: "text", text: truncate(JSON.stringify(output, null, 2)) }],
      structuredContent: output,
    };
  }
);

server.registerTool(
  "second_brain_list_tags",
  {
    title: "List Tags",
    description: `List every tag used across the vault (from frontmatter "tags" arrays and inline #tags in note bodies), with usage counts.`,
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const counts = listTags(resolvedVaultRoot);
    const output = Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
    return {
      content: [{ type: "text", text: truncate(JSON.stringify(output, null, 2)) }],
      structuredContent: output,
    };
  }
);

server.registerTool(
  "second_brain_reindex",
  {
    title: "Reindex Vault (Semantic)",
    description: `Rebuild the semantic (meaning-based) search index over the vault. Incremental: only files that changed since the last reindex are re-embedded, so repeated calls are cheap. The first-ever call on a large vault, or right after adding many notes, may take a while (a local embedding model runs per chunk, no network calls).

If a changed note embeds an image or PDF via "![[file.png]]"/"![[file.pdf]]", its text is extracted
(OCR for images, the existing text layer for PDFs) and folded into that note's search index — never
written back into the note file, purely for search. Extracted text is cached by attachment content
hash, so an unchanged attachment isn't re-processed on later reindexes. A failed attachment is
skipped (logged), it never fails the whole reindex.

Call this before second_brain_search_semantic if you suspect the index is stale (you just wrote several notes and want them searchable immediately). Otherwise, run it periodically or once at the start of a session.`,
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      const result = await reindexVault(resolvedVaultRoot, db);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "second_brain_search_semantic",
  {
    title: "Search Notes By Meaning",
    description: `Search the vault by MEANING rather than exact keywords — finds notes conceptually related to the query even if they don't share vocabulary with it. Use this for "what have I written about X" style questions.

Requires the index to be reasonably up to date; call second_brain_reindex first if notes were just added or edited and you need them to show up immediately.

Args:
  - query (string): Natural-language description of what you're looking for.
  - top_k (number, 1-30): Max number of chunk matches to return (default 8).

Returns matches sorted by relevance score (cosine similarity, roughly 0-1, higher is more similar —
plus a small recency boost for recently-edited notes, so the score can slightly exceed 1), each with
the source note path and a text snippet.`,
    inputSchema: {
      query: z.string().min(1),
      top_k: z.number().int().min(1).max(MAX_SEARCH_TOP_K).default(DEFAULT_SEARCH_TOP_K),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ query, top_k }) => {
    try {
      const hits = await semanticSearch(db, query, top_k);
      if (hits.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No indexed chunks found. The index may be empty — call second_brain_reindex first.",
            },
          ],
        };
      }
      const output = { count: hits.length, hits };
      return {
        content: [{ type: "text", text: truncate(JSON.stringify(output, null, 2)) }],
        structuredContent: output,
      };
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "second_brain_search_keyword",
  {
    title: "Search Notes By Keyword",
    description: `Search the vault for an exact substring match (case-insensitive), line by line. Use this when you need an exact term, name, or number rather than a conceptual match — faster and more precise than semantic search for that case.

Args:
  - query (string): Substring to search for.
  - top_k (number, 1-30): Max number of matching lines to return (default 8).`,
    inputSchema: {
      query: z.string().min(1),
      top_k: z.number().int().min(1).max(MAX_SEARCH_TOP_K).default(DEFAULT_SEARCH_TOP_K),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ query, top_k }) => {
    const hits = keywordSearch(resolvedVaultRoot, query, top_k);
    const output = { count: hits.length, hits };
    return {
      content: [{ type: "text", text: truncate(JSON.stringify(output, null, 2)) }],
      structuredContent: output,
    };
  }
);

server.registerTool(
  "second_brain_search_hybrid",
  {
    title: "Search Notes By Meaning + Keyword (Hybrid)",
    description: `Search the vault using BOTH meaning-based and exact-substring search, then merge the results
into one ranked list. A note that matches on both signals ranks above a note that only matches one —
this is usually the best default search when you're not sure whether a conceptual or exact-term
match is more likely to work.

Requires the semantic index to be reasonably up to date; call second_brain_reindex first if notes
were just added or edited.

Args:
  - query (string): Natural-language query, exact term, or both.
  - top_k (number, 1-30): Max number of notes to return (default 8).

Returns matches sorted by combined relevance score (semantic cosine score plus a keyword rank score,
plus a small recency boost for recently-edited notes — not a normalized 0-1 scale), each with the
source note path, which search(es) matched it ("semantic", "keyword", or both), and a text snippet.`,
    inputSchema: {
      query: z.string().min(1),
      top_k: z.number().int().min(1).max(MAX_SEARCH_TOP_K).default(DEFAULT_SEARCH_TOP_K),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ query, top_k }) => {
    try {
      const hits = await hybridSearch(db, resolvedVaultRoot, query, top_k);
      if (hits.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No matches found. The semantic index may be empty — call second_brain_reindex first.",
            },
          ],
        };
      }
      const output = { count: hits.length, hits };
      return {
        content: [{ type: "text", text: truncate(JSON.stringify(output, null, 2)) }],
        structuredContent: output,
      };
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "second_brain_check_consistency",
  {
    title: "Check Cross-Note Consistency",
    description: `Reports pairs of notes that talk about the same specific thing (high semantic similarity) but
are worded differently enough that they're NOT just near-duplicate text — i.e. candidates for a
factual contradiction (two notes with different numbers, dates, or decisions about the same topic).

This is a heuristic report, not an authoritative check: a high score means "worth a human look," not
"definitely contradictory." It never modifies or merges anything — resolving a real contradiction
(editing one of the notes) is on you, via second_brain_write_note.

Requires the semantic index to be up to date; call second_brain_reindex first if unsure.

Args:
  - scope (string, optional): Restrict to notes under a folder prefix, e.g. "Инвестиции/".
  - top_k (number, 1-30): Max number of pairs to return (default ${DEFAULT_CONSISTENCY_TOP_K}).

Returns pairs sorted by similarity score, each with both note paths, the similarity score, a text-overlap
ratio (low = different wording, which is what makes it a contradiction candidate rather than a duplicate),
and a snippet from each note's most similar passage.`,
    inputSchema: {
      scope: z.string().optional().describe('Optional folder prefix filter, e.g. "Инвестиции/"'),
      top_k: z.number().int().min(1).max(MAX_SEARCH_TOP_K).default(DEFAULT_CONSISTENCY_TOP_K),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ scope, top_k }) => {
    try {
      const pairs = checkConsistency(db, scope, top_k);
      if (pairs.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No candidate contradictions found above the similarity threshold. The semantic index may also be empty or stale — call second_brain_reindex first if unsure.",
            },
          ],
        };
      }
      const output = { count: pairs.length, pairs };
      return {
        content: [{ type: "text", text: truncate(JSON.stringify(output, null, 2)) }],
        structuredContent: output,
      };
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "second_brain_stale_notes",
  {
    title: "Find Stale Notes With Open Items",
    description: `Lists notes that haven't been edited in a while AND still contain an open-item marker — an
unchecked checkbox ("- [ ]") or a heading like "Next steps"/"TODO"/"Open questions" (English or
Russian, e.g. "Дальнейшие шаги"/"Открытые вопросы"). Purely informational: nothing is archived,
checked off, or edited — this just flags candidates for the user to revisit or close out manually.

Args:
  - days (number, optional): Minimum age in days since last edit (default ${DEFAULT_STALE_DAYS}).
  - scope (string, optional): Restrict to notes under a folder prefix, e.g. "PhD/".

Returns notes sorted oldest-first, each with its path, age in days, and the matched open-item lines.`,
    inputSchema: {
      days: z.number().int().min(1).default(DEFAULT_STALE_DAYS),
      scope: z.string().optional().describe('Optional folder prefix filter, e.g. "PhD/"'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ days, scope }) => {
    const hits = findStaleNotes(resolvedVaultRoot, days, scope);
    const output = { count: hits.length, notes: hits };
    return {
      content: [{ type: "text", text: truncate(JSON.stringify(output, null, 2)) }],
      structuredContent: output,
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`second-brain-mcp-server running. Vault: ${resolvedVaultRoot}`);
}

main().catch((err) => {
  console.error("Fatal server error:", err);
  process.exit(1);
});
