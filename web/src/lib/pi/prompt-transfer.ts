import { join } from "node:path";
import { MAX_AGENTS_MD_BYTES, readAgentsMdFile, resolvePiAgentDir, writeAgentsMdFile } from "@/lib/agents-md";
import { PROMPT_FILE_NAMES, type PromptBackup, type PromptFileName } from "@/lib/prompt-transfer-format";
import { withTransferRecovery } from "@/lib/pi/transfer-recovery";

const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const allowedNames = new Set<string>(PROMPT_FILE_NAMES);

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("プロンプトのバックアップ形式が不正です");
  return value as Record<string, unknown>;
}

export function exportPromptBackup(): PromptBackup {
  const files: PromptBackup["files"] = {};
  const agentDir = resolvePiAgentDir();
  for (const name of PROMPT_FILE_NAMES) {
    const item = readAgentsMdFile(join(agentDir, name));
    if (item.exists) files[name] = item.content;
  }
  const backup: PromptBackup = {
    format: "leafcode-pi-prompts", version: 1, exportedAt: new Date().toISOString(), files,
  };
  if (Buffer.byteLength(JSON.stringify(backup), "utf8") > MAX_BACKUP_BYTES) invalid("バックアップが大きすぎます");
  return backup;
}

export function validatePromptBackup(raw: unknown): PromptBackup {
  const value = record(raw);
  if (value.format !== "leafcode-pi-prompts" || value.version !== 1 ||
    typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt))) {
    invalid("対応していないプロンプトのバックアップ形式です");
  }
  const rawFiles = record(value.files);
  const files: PromptBackup["files"] = {};
  for (const [name, content] of Object.entries(rawFiles)) {
    if (!allowedNames.has(name) || typeof content !== "string" ||
      Buffer.byteLength(content, "utf8") > MAX_AGENTS_MD_BYTES) invalid(`プロンプトファイルが不正です: ${name}`);
    files[name as PromptFileName] = content;
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_BACKUP_BYTES) invalid("バックアップが大きすぎます");
  return { format: "leafcode-pi-prompts", version: 1, exportedAt: value.exportedAt as string, files };
}

/** Omitted files are never deleted; only explicitly selected names are written. */
export async function importPromptBackup(
  raw: unknown,
  selected: unknown,
  afterWrite?: () => void,
): Promise<PromptFileName[]> {
  const backup = validatePromptBackup(raw);
  if (!Array.isArray(selected) || selected.length === 0 || selected.length > PROMPT_FILE_NAMES.length ||
    selected.some((name) => typeof name !== "string" || !allowedNames.has(name) ||
      !Object.hasOwn(backup.files, name)) || new Set(selected).size !== selected.length) {
    invalid("インポート対象を選択してください");
  }
  const names = selected as PromptFileName[];
  const agentDir = resolvePiAgentDir();
  const paths = names.map((name) => join(agentDir, name));
  // Reject oversized files, symlinks and directories before touching any destination.
  paths.forEach((path) => readAgentsMdFile(path));
  await withTransferRecovery(paths, async () => {
    for (const name of names) {
      writeAgentsMdFile(join(agentDir, name), backup.files[name]!);
      afterWrite?.();
    }
  });
  return names;
}
