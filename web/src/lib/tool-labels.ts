import type { ToolState } from "@/lib/types";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Pi の単一実行と workflow/tasks 形式から、最初の子タスクを取り出す。 */
function firstSubagentTask(input: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(input.tasks)) return null;
  for (const item of input.tasks) {
    const task = recordValue(item);
    if (task) return task;
  }
  return null;
}

function subagentValue(input: Record<string, unknown>, key: string): string | null {
  return asString(input[key]) ?? asString(firstSubagentTask(input)?.[key]);
}

function subagentInstruction(input: Record<string, unknown>): string | null {
  return subagentValue(input, "prompt") ?? subagentValue(input, "task");
}

/** Return the skill directory name when a read tool is loading a SKILL.md file. */
export function skillNameFromReadInput(
  tool: string,
  input: Record<string, unknown> | undefined,
): string | null {
  if (!tool.toLowerCase().includes("read")) return null;
  const path =
    asString(input?.path) ?? asString(input?.filePath) ?? asString(input?.file_path);
  if (!path) return null;

  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const match = /(?:^|\/)([^/]+)\/SKILL\.md$/i.exec(normalized);
  return match?.[1] ?? null;
}

export function isSkillRead(
  tool: string,
  input: Record<string, unknown> | undefined,
): boolean {
  return skillNameFromReadInput(tool, input) !== null;
}

/** 本家 LeafCode のタイムラインと同じ日本語ラベル・要約規則。 */
export function toolLabel(tool: string, input?: Record<string, unknown>): string {
  const t = tool.toLowerCase();
  if (isSkillRead(tool, input)) return "スキル";
  if (t.includes("subagent") || t === "task") return "サブエージェント";
  if (t === "question") return "確認";
  if (t.includes("bash") || t.includes("shell")) return "コマンド";
  if (t.includes("read")) return "読取";
  if (t.includes("todo")) return "ToDo";
  if (t.includes("write") || t.includes("edit") || t.includes("patch")) return "編集";
  if (t.includes("grep") || t.includes("glob") || t.includes("find")) return "検索";
  if (t === "ls" || t.includes("list")) return "一覧";
  if (t.includes("web") || t.includes("fetch")) return "取得";
  return tool;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function todoSummary(input: Record<string, unknown>): string | null {
  if (!Array.isArray(input.todos)) return null;
  const todos = input.todos as { status?: unknown }[];
  const done = todos.filter(
    (todo) => todo?.status === "completed" || todo?.status === "cancelled",
  ).length;
  return `${done}/${todos.length} 件`;
}

/** カード見出しの 1 行要約。tool 名と同じだけの title は無視する。 */
export function toolSummary(tool: string, state: ToolState | undefined): string {
  const input = state?.input ?? {};
  const t = tool.toLowerCase();
  const skillName = skillNameFromReadInput(tool, input);
  if (skillName) return `読み込み済み: ${skillName}`;

  const title = state?.title?.trim();
  if (title && title.toLowerCase() !== tool.toLowerCase()) return title;
  if (t.includes("todo")) {
    return todoSummary(input) ?? toolLabel(tool, input);
  }
  if (t.includes("subagent") || t === "task") {
    const instruction = subagentInstruction(input);
    return (
      subagentValue(input, "description") ??
      subagentValue(input, "label") ??
      (instruction ? clip(instruction.replace(/\s+/g, " "), 80) : null) ??
      subagentValue(input, "agent") ??
      subagentValue(input, "subagent_type") ??
      "サブエージェント"
    );
  }
  if (t.includes("bash") || t.includes("shell")) {
    const command = asString(input.command);
    return (
      asString(input.description) ?? (command ? clip(command, 120) : null) ?? tool
    );
  }
  const path =
    asString(input.path) ?? asString(input.filePath) ?? asString(input.file_path);
  if (path) return path;
  return (
    asString(input.pattern) ??
    asString(input.glob) ??
    asString(input.url) ??
    asString(input.query) ??
    asString(input.description) ??
    tool
  );
}

export type ToolField = { label: string; value: string };

/** 展開時に見せるラベル付き入力。JSON をそのまま吐かない。 */
export function toolInputFields(
  tool: string,
  input: Record<string, unknown> | undefined,
): ToolField[] {
  if (!input) return [];
  const t = tool.toLowerCase();
  const fields: ToolField[] = [];
  const add = (label: string, key: string, transform?: (value: string) => string) => {
    const value = asString(input[key]);
    if (value) fields.push({ label, value: transform ? transform(value) : value });
  };

  if (t.includes("todo")) {
    if (Array.isArray(input.todos)) {
      const lines = (input.todos as { status?: unknown; content?: unknown }[])
        .map((todo) => `${asString(todo?.status) ?? "?"} ${asString(todo?.content) ?? ""}`.trim())
        .join("\n");
      if (lines) fields.push({ label: "ToDo", value: lines });
    }
    return fields;
  }
  if (t.includes("subagent") || t === "task") {
    const description = subagentValue(input, "description") ?? subagentValue(input, "label");
    const instruction = subagentInstruction(input);
    const agent = subagentValue(input, "agent") ?? subagentValue(input, "subagent_type");
    if (description) {
      fields.push({ label: "内容", value: description });
    } else if (instruction) {
      fields.push({ label: "内容", value: clip(instruction.replace(/\s+/g, " "), 80) });
    }
    if (agent) fields.push({ label: "エージェント", value: agent });
    if (instruction) fields.push({ label: "指示", value: clip(instruction, 200) });
    return fields;
  }
  if (t.includes("bash") || t.includes("shell")) {
    add("説明", "description");
    add("コマンド", "command");
    return fields;
  }

  const skillName = skillNameFromReadInput(tool, input);
  if (skillName) fields.push({ label: "スキル", value: skillName });

  add("パス", "path");
  add("パス", "filePath");
  add("パス", "file_path");
  add("パターン", "pattern");
  add("グロブ", "glob");
  add("クエリ", "query");
  add("URL", "url");
  add("説明", "description");
  return fields;
}
