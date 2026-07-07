import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { OCR_IMAGE_EXTENSIONS, OCR_LANGUAGES } from "../constants.js";
import { appDataDir } from "./vaultPath.js";

export function hashFile(absPath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(absPath)).digest("hex");
}

// Lazy worker init, same rationale as embeddings.ts's lazy pipeline: OCR language data (~a few MB
// per language) only downloads the first time OCR actually runs, not on server startup.
type OcrWorker = { recognize: (path: string) => Promise<{ data: { text: string } }> };
let workerPromise: Promise<OcrWorker> | null = null;

async function getOcrWorker(): Promise<OcrWorker> {
  if (!workerPromise) {
    // Same fix as embeddings.ts: if loading fails (no network for the language data on first run),
    // reset to null so the next call retries instead of replaying the same rejection forever.
    workerPromise = (async () => {
      const { createWorker } = await import("tesseract.js");
      // Without an explicit cachePath, tesseract.js dumps multi-MB *.traineddata files into
      // whatever the current working directory happens to be — redirect it next to the sqlite
      // index instead, consistent with how every other on-disk cache in this project is kept out
      // of both the vault and the project/package directory.
      return (await createWorker(OCR_LANGUAGES, undefined, { cachePath: appDataDir() })) as unknown as OcrWorker;
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

async function extractImageText(absPath: string): Promise<string> {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(absPath);
  return data.text.trim();
}

/**
 * Pulls the embedded text layer out of a PDF — this is NOT full OCR: a scanned/image-only PDF (no
 * text layer) yields empty text here. True OCR of scanned PDF pages would require rasterizing each
 * page to an image first, which needs a canvas implementation (native bindings) that this project
 * deliberately avoids for install-friendliness. Documented as a known limitation in the README.
 */
async function extractPdfText(absPath: string): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(absPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;

  const pageTexts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pageTexts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  return pageTexts.join("\n").trim();
}

export async function extractAttachmentText(absPath: string): Promise<string> {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === ".pdf") return extractPdfText(absPath);
  if (OCR_IMAGE_EXTENSIONS.includes(ext)) return extractImageText(absPath);
  return "";
}
