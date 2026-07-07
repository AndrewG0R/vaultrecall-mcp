import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { ALLOWED_EXTENSIONS, IGNORED_DIR_NAMES } from "../constants.js";

/**
 * Shared app-data directory for everything this server caches on disk (the sqlite index, OCR
 * language data, etc) — deliberately outside both the vault and the project/package directory, so
 * it survives reinstalls, isn't mistaken for vault content, and (for tesseract.js specifically)
 * doesn't default to dumping multi-MB *.traineddata files into whatever the current working
 * directory happens to be.
 */
export function appDataDir(): string {
  const dir = path.join(os.homedir(), ".second-brain-mcp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export class VaultPathError extends Error {}

/**
 * Resolves a vault-relative path to an absolute path, guaranteeing the
 * result stays inside vaultRoot. Throws VaultPathError otherwise.
 * This is the single choke point all file tools go through — nothing
 * reads or writes a path that hasn't passed through here.
 */
export function resolveInVault(vaultRoot: string, relPath: string): string {
  if (relPath.includes("\0")) {
    throw new VaultPathError("Path contains a null byte.");
  }
  const normalizedRel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const absolute = path.resolve(vaultRoot, normalizedRel);
  const rootWithSep = path.resolve(vaultRoot) + path.sep;

  if (!absolute.startsWith(rootWithSep) && absolute !== path.resolve(vaultRoot)) {
    throw new VaultPathError(
      `Refusing to access "${relPath}": it resolves outside the vault root.`
    );
  }

  const segments = normalizedRel.split("/");
  for (const seg of segments) {
    if (IGNORED_DIR_NAMES.has(seg)) {
      throw new VaultPathError(
        `Refusing to access "${relPath}": "${seg}" is a protected/system directory.`
      );
    }
  }

  return absolute;
}

export function assertMarkdownExtension(relPath: string): void {
  const ext = path.extname(relPath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new VaultPathError(
      `Refusing to write "${relPath}": only ${ALLOWED_EXTENSIONS.join(", ")} files are allowed.`
    );
  }
}

export function ensureParentDirExists(absolutePath: string): void {
  const dir = path.dirname(absolutePath);
  fs.mkdirSync(dir, { recursive: true });
}

/** Deterministic, filesystem-safe id derived from the vault's absolute path, used to name its private index file. */
export function vaultIndexId(vaultRoot: string): string {
  return crypto.createHash("sha256").update(path.resolve(vaultRoot)).digest("hex").slice(0, 16);
}
