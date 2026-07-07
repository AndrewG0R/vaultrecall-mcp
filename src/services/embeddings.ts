import { EMBEDDING_MODEL } from "../constants.js";

// Lazy import + lazy pipeline init: the model (~470MB) only loads into memory
// the first time it's actually needed (first reindex or first semantic search),
// not on server startup. Cached by @xenova/transformers under its own cache dir
// after first download, so subsequent runs are offline.
type FeatureExtractionPipeline = (
  text: string,
  options: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: Float32Array }>;

interface ModelFileProgressEvent {
  status: "initiate" | "download" | "progress" | "done" | string;
  file?: string;
  progress?: number;
}

/**
 * The model download can take a while (~470MB over a slow connection) and @xenova/transformers is
 * silent by default — without this, the server just looks hung on first use. Printed to STDERR
 * only: this is an MCP stdio server, so stdout is the JSON-RPC protocol channel and must never
 * carry anything else. Throttled to ~every 10% per file so it doesn't spam the log.
 */
function logModelDownloadProgress(): (event: ModelFileProgressEvent) => void {
  const lastLoggedPct = new Map<string, number>();
  return (event) => {
    if (!event.file) return;
    if (event.status === "initiate") {
      console.error(`Downloading embedding model file: ${event.file}...`);
    } else if (event.status === "progress" && typeof event.progress === "number") {
      const pct = Math.floor(event.progress);
      const last = lastLoggedPct.get(event.file) ?? -10;
      if (pct >= last + 10) {
        console.error(`  ${event.file}: ${pct}%`);
        lastLoggedPct.set(event.file, pct);
      }
    } else if (event.status === "done") {
      console.error(`  ${event.file}: done.`);
    }
  };
}

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

async function loadPipeline(): Promise<FeatureExtractionPipeline> {
  console.error(`Loading embedding model "${EMBEDDING_MODEL}" (first use downloads it, ~470MB — this happens once)...`);
  const { pipeline } = await import("@xenova/transformers");
  const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, {
    progress_callback: logModelDownloadProgress(),
  });
  console.error("Embedding model ready.");
  return extractor as unknown as FeatureExtractionPipeline;
}

async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise) {
    // If loading fails (e.g. no network on first run, so the ~470MB model can't download), reset
    // to null so the NEXT call retries instead of replaying the same cached rejection forever —
    // otherwise a transient failure would require a full server restart to recover from.
    pipelinePromise = loadPipeline().catch((err) => {
      pipelinePromise = null;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to load embedding model "${EMBEDDING_MODEL}". If this is the first run, it needs to ` +
          `download the model (~470MB) and requires an internet connection — check connectivity and retry. ` +
          `Original error: ${message}`
      );
    });
  }
  return pipelinePromise;
}

export async function embedText(text: string): Promise<Float32Array> {
  const extractor = await getPipeline();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Float32Array.from(output.data);
}

export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  const results: Float32Array[] = [];
  for (const t of texts) {
    results.push(await embedText(t));
  }
  return results;
}

/** Vectors are already L2-normalized (normalize: true above), so dot product == cosine similarity. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
