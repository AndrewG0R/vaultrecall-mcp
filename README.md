# vaultrecall-mcp

[![npm version](https://img.shields.io/npm/v/vaultrecall-mcp.svg)](https://www.npmjs.com/package/vaultrecall-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A local MCP server that turns an Obsidian vault into a searchable second brain for Claude** —
meaning-based search (not just keyword matching), safe note read/write, and a few small tools that
surface things a human tends to miss (stale TODOs, contradicting notes). Everything runs on your
machine: no API keys, no accounts, no data ever leaves your disk except to download the (one-time,
local) embedding model.

> `vaultrecall-mcp` is the working package name — not yet published to npm, and could still change.
> Everything below assumes this name; if it changes, only the package name in the examples changes.

## Contents

- [Why this exists](#why-this-exists)
- [Quick start](#quick-start)
- [Tools](#tools)
- [Security model](#security-model)
- [Installing from source](#installing-from-source-for-contributors)
- [Connecting to Claude Desktop manually](#connecting-to-claude-desktop-manually)
- [Try it](#try-it)
- [Optional: make Claude use it automatically](#optional-make-claude-use-it-automatically)
- [Known limitations](#known-limitations)
- [Releases](#releases-for-maintainers)
- [License](#license)

## Why this exists

Obsidian's own search is exact-text. That's fine until you want "what did I decide about X" and
don't remember the exact words you used, or the note is in a different language than the question,
or the fact you're looking for is buried in a screenshot you pasted in six months ago. This server
gives Claude:

- **Meaning-based search** across your whole vault, in any language mix — a Russian question can
  find an English note and vice versa.
- **Hybrid search** that combines exact-match and meaning-based search when you're not sure which
  one will find it.
- **Searchable screenshots and PDFs** — OCR text from embedded attachments gets folded into the
  index (never written back into your notes).
- **Two "someone should look at this" reports**: notes that quietly contradict each other, and notes
  with open TODOs nobody has touched in a while.
- Safe reads/writes that never leave the vault folder, and an index that lives entirely outside it.

Nothing here runs on a schedule or edits a note without you explicitly asking for it — see
[Security model](#security-model).

## Quick start

```bash
npx vaultrecall-mcp init
```

This asks for your vault path (or offers the current folder if it contains `.obsidian/`), shows you
the exact Claude Desktop config block it wants to add, and — only with your confirmation — merges it
in without touching any other MCP servers you already have configured. Restart Claude Desktop
completely (quit, don't just close the window) and you're done.

No `git clone`, no `npm install`, no manual JSON editing required — `npx` downloads and runs the
package on demand.

## Tools

### Reading and writing notes

| Tool | What it does |
|---|---|
| `second_brain_read_note` | Read a note's frontmatter and body separately. |
| `second_brain_write_note` | Create, append to, or overwrite a note. If new `frontmatter.tags` look like a near-duplicate of an existing tag, the response suggests the existing one instead (e.g. flags `investing` when `investments` is already used). |
| `second_brain_list_notes` | List every note path, optionally filtered to a folder. |
| `second_brain_list_tags` | Every tag in use (frontmatter + inline `#tags`), with counts. |

### Search

| Tool | What it does |
|---|---|
| `second_brain_search_keyword` | Exact substring match, line by line. Fast and precise when you know the wording. |
| `second_brain_search_semantic` | Search by meaning, not exact words — finds a note even if it uses none of your query's vocabulary, including across languages. |
| `second_brain_search_hybrid` | Runs both of the above and merges the results; a note that matches both ranks highest. The best default when you're unsure which kind of search will find it. |

### Maintenance

| Tool | What it does |
|---|---|
| `second_brain_reindex` | Rebuilds the semantic index. Incremental — only re-embeds notes that actually changed — and self-healing: switching the embedding model, or deleting a note from disk, is picked up automatically on the next run. Also OCRs any image/PDF a changed note embeds via `![[file.png]]` and folds that text into the index (see [Known limitations](#known-limitations) for what this doesn't cover). |

### Insight reports (read-only, heuristic)

| Tool | What it does |
|---|---|
| `second_brain_check_consistency` | Flags pairs of notes that talk about the same specific thing but disagree in the details — a candidate contradiction, not a confirmed one. Never edits anything; you decide what to do with a flagged pair. |
| `second_brain_stale_notes` | Lists notes that are old *and* still contain an open item — an unchecked `- [ ]`, or a heading like "Next steps"/"TODO" (English and Russian phrasings both recognized). Purely a report; nothing gets archived or checked off automatically. |

**Nothing here writes on its own.** `write_note` and `reindex` are the only two tools that touch
your files or the index, and both only run when you (or the model, on your behalf, in the same turn)
explicitly call them — nothing is scheduled, and no tool rewrites note content as a side effect of
being called.

## Security model

- Every path goes through one gate (`resolveInVault`) that rejects anything resolving outside the
  vault — `../../etc/passwd`-style traversal included.
- `.obsidian`, `.git`, `.trash`, and `node_modules` are never read or written.
- Writes are only ever allowed to `.md`/`.markdown` files.
- The search index (SQLite) lives outside the vault, at `~/.second-brain-mcp/` — so it never shows
  up in Obsidian Sync, your vault's git history, or backups as a stray binary "note."
- Embeddings run through a local model (`@xenova/transformers`, `paraphrase-multilingual-MiniLM-L12-v2`,
  ~470MB, downloaded once) — no network calls after that one-time download.

That said, **back up your vault before first use** (an easy way: `git init` in the vault folder and
commit its current state). This is a young project, and `write_note` in `overwrite` mode irreversibly
replaces a file's content.

## Installing from source (for contributors)

Skip this if you just want to use the tool — [Quick start](#quick-start) is all you need. This is
for working on the server itself:

```bash
git clone https://github.com/AndrewG0R/vaultrecall-mcp.git
cd vaultrecall-mcp
npm install     # builds dist/ automatically via the "prepare" script
npm test
```

Point Claude Desktop at your local build instead of the published package by using
`"command": "node", "args": ["/full/path/to/dist/index.js"]` in place of the `npx` line below.

The vault path is passed as the first CLI argument or via `OBSIDIAN_VAULT_PATH`. `.env.example`
documents that variable for reference, but the server doesn't load `.env` files itself (no `dotenv`
dependency) — export the variable yourself if running it outside an MCP client.

**Requirements:** Node.js 18+. Running an older version prints a clear version error instead of a
cryptic crash.

## Connecting to Claude Desktop manually

Prefer [`npx vaultrecall-mcp init`](#quick-start) — it does the following for you. Manual steps:

1. Open your Claude Desktop config:
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

2. Add an entry under `mcpServers` (keep any others already there):

   ```json
   {
     "mcpServers": {
       "second-brain": {
         "command": "npx",
         "args": ["-y", "vaultrecall-mcp"],
         "env": {
           "OBSIDIAN_VAULT_PATH": "/full/path/to/your/vault"
         }
       }
     }
   }
   ```

3. Restart Claude Desktop completely (quit, not just close the window).

## Try it

1. **"What tags are in my vault?"** — if it answers with your real tags, the connection works.
2. **"Reindex my vault."** — first run downloads the embedding model (~470MB, once) and indexes
   every note; can take a couple of minutes on a large vault. Progress shows in the server log
   (Claude Desktop → Developer → MCP Log). No network? You get a clear error, not a silent hang.
3. **Ask something conceptual, not exact-wording** — e.g. "what have I written about saving for the
   future" — and confirm it surfaces a note about investing even if "saving" never appears in it.

## Optional: make Claude use it automatically

Everything above is manual — you ask, Claude calls a tool, once. If you want Claude to *proactively*
recall context at the start of a conversation and save a summary at the end without being asked each
time, add something like this to Claude Desktop's Custom Instructions (Settings → Custom
Instructions, or per-project instructions):

```text
This vault is my second brain, available via the second_brain_* MCP tools.

At the start of a conversation, if the topic plausibly connects to something I've written before,
silently call second_brain_search_hybrid with a query based on the topic and read any clearly
relevant notes with second_brain_read_note before responding. Don't narrate the search unless it's
relevant to mention what you found.

At the end of a substantive conversation (skip this for quick one-off questions), save a short
summary via second_brain_write_note:
- If it continues an existing note's topic, use mode "append".
- Otherwise, create a new note (mode "create_only") in a folder consistent with the vault's existing
  structure — check second_brain_list_notes or second_brain_list_tags first if unsure where it fits.
- End your reply with "Saved: <path>" so it's clear something was written.

Every few sessions, or after several new/edited notes, call second_brain_reindex so search stays
current.
```

**This is a meaningful behavior change, worth understanding before turning it on:** the security
model described above ([Security model](#security-model)) is about the *server* — it never writes on
its own. The instructions above make *Claude* decide, on its own judgment, when to call `write_note`
and what to write, without you asking that specific turn. Claude's judgment on what's "worth saving"
and where it belongs won't always match yours. Start by reviewing what it saves for a while before
trusting it unattended, and remember `write_note` in `overwrite` mode is destructive — the instructions
above only use `append`/`create_only`, and it's worth keeping it that way.

This lives entirely in Claude Desktop's settings, not in this server — remove or edit the instructions
text at any time to change or turn off the behavior.

## Known limitations

- **Search doesn't scale past personal-vault size.** It's brute-force cosine similarity over every
  chunk, no ANN index. Thousands of notes: fine. Tens of thousands: you'd want a vector index (e.g.
  HNSW) — open an issue if you get there.
- **The embedding model isn't small** (~470MB). Multilingual support is worth the size, but the
  first download and first `reindex` are heavier than a smaller single-language model would be.
- **Chunking is markdown-aware, not content-aware.** Each `##` section becomes one chunk (oversized
  sections get sub-split by character count); notes without `##` headings are split by character
  count entirely. Works well for typical notes, less precisely for unusually structured ones.
- **Not every index-affecting change auto-invalidates the index.** Swapping the embedding model
  triggers a full automatic rebuild. Changes to chunking logic, or to what gets folded into a
  chunk's embedding text (tags, title), do *not* — they only apply to notes that change afterward.
  Force a full rebuild by deleting the index file under `~/.second-brain-mcp/` and reindexing.
- **PDF support is text-layer-only, not real OCR.** Images get true OCR (`tesseract.js`, English +
  Russian by default). PDFs only have their existing text layer extracted (`pdfjs-dist`) — a
  scanned, image-only PDF yields no text. Real OCR of scanned PDFs would need page rasterization,
  which pulls in a native `canvas` dependency this project deliberately avoids for easy installs.
- **An attachment's OCR text is only refreshed when its note is reindexed.** If just the attachment
  changes but the note's markdown doesn't, `reindex` won't notice — same caveat as chunking above.
- **`check_consistency` is a heuristic**, tuned on this project's own test vault — a flagged pair is
  worth a look, not a verdict. Tune the thresholds in `constants.ts` if it's too noisy/quiet for you.
- **`npx` cold starts are slow twice over on a first run** — once to fetch the package itself, once
  to fetch the embedding model. Both are cached after that.

## Releases (for maintainers)

`.github/workflows/publish.yml` publishes to npm on any `vX.Y.Z` tag push:

```bash
npm version patch   # or minor / major — bumps package.json and creates the git tag
git push --follow-tags
```

Needs a repository secret `NPM_TOKEN` (an npm automation token with publish rights). The workflow
runs `npm test` first; a failing suite blocks the release.

## License

MIT — see [LICENSE](LICENSE).
