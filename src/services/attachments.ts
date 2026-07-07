import fs from "node:fs";
import path from "node:path";
import { OCR_IMAGE_EXTENSIONS, OCR_PDF_EXTENSIONS } from "../constants.js";

const EMBED_RE = /!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

/** Extracts vault-embed (`![[file.png]]`) references from a note body that point at an OCR-able attachment (image or PDF), deduplicated. Ignores note-to-note embeds like `![[Other Note]]`. */
export function findAttachmentEmbeds(content: string): string[] {
  const refs = new Set<string>();
  const re = new RegExp(EMBED_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const ref = m[1].trim();
    const ext = path.extname(ref).toLowerCase();
    if (OCR_IMAGE_EXTENSIONS.includes(ext) || OCR_PDF_EXTENSIONS.includes(ext)) {
      refs.add(ref);
    }
  }
  return [...refs];
}

/**
 * Resolves a `![[...]]` embed reference to an actual vault-relative file path. Obsidian embeds are
 * often a bare filename (no folder), and Obsidian itself resolves those by searching the whole
 * vault for a matching filename — it doesn't require the embed to include the attachment's folder.
 * We mirror that: try the reference as a direct vault-relative path first, then fall back to a
 * vault-wide filename search.
 */
export function resolveAttachment(vaultRoot: string, embedRef: string, allVaultFiles: string[]): string | undefined {
  const normalizedRef = embedRef.replace(/\\/g, "/").replace(/^\/+/, "");
  const direct = path.join(vaultRoot, normalizedRef);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
    return normalizedRef;
  }

  const basename = path.basename(normalizedRef);
  return allVaultFiles.find((f) => path.basename(f) === basename);
}
