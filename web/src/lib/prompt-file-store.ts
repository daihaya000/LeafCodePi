import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dataDir, sameOrDescendantPath, samePath } from "./paths";
import type { PromptFileInput } from "./prompt-images";

/** Attachments too large to inline in the prompt; the model reads them with tools. */
export function promptFileStoreDir(): string {
  return join(dataDir(), "prompt-files");
}

function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[<>:"|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/[. ]+$/, "")
    .trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "attachment.txt";
}

export function storePromptFileContent(file: PromptFileInput, content: string): string {
  const directory = join(promptFileStoreDir(), randomUUID());
  mkdirSync(directory, { recursive: true });
  const path = join(directory, safeFileName(file.name));
  writeFileSync(path, content, "utf8");
  return path;
}

/** Only resolve paths inside the store so a forged marker cannot read arbitrary files. */
export function readStoredPromptFileContent(path: string): string | null {
  const root = promptFileStoreDir();
  const target = resolve(path);
  if (samePath(target, root) || !sameOrDescendantPath(target, root)) return null;
  try {
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
}
