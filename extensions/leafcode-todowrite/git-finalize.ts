import { lstat } from "node:fs/promises";
import { posix, relative, resolve, sep } from "node:path";
import { Type } from "typebox";

export const GIT_FINALIZE_NAME = "git_finalize";
const text = Type.String({ minLength: 1, maxLength: 2_000 });
const paths = Type.Array(text, { minItems: 1, maxItems: 100 });
const operation = (name: string, fields = {}) => Type.Object({ operation: Type.Literal(name), ...fields }, { additionalProperties: false });
export const GitFinalizeParams = Type.Union([
  operation("status"),
  operation("diff", { staged: Type.Optional(Type.Boolean()), paths: Type.Optional(paths) }),
  operation("log", { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
  operation("show", { revision: Type.Optional(text) }),
  operation("add", { paths }),
  operation("commit", { message: text }),
  operation("push", { remote: Type.Optional(text), branch: Type.Optional(text) }),
  operation("fetch", { remote: Type.Optional(text) }),
  operation("rev_parse", { revision: Type.Optional(text) }),
]);

const OPERATION_FIELDS: Record<string, readonly string[]> = {
  status: [], diff: ["staged", "paths"], log: ["limit"], show: ["revision"], add: ["paths"],
  commit: ["message"], push: ["remote", "branch"], fetch: ["remote"], rev_parse: ["revision"],
};

/** No raw argv, shell text, cwd override, global config, force, merge or history rewriting. */
export function buildGitFinalizeArgs(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Git操作を指定してください。");
  const params = input as Record<string, unknown>;
  const name = params.operation;
  if (typeof name !== "string" || !Object.hasOwn(OPERATION_FIELDS, name)
    || Object.keys(params).some((key) => key !== "operation" && !OPERATION_FIELDS[name]!.includes(key))) throw Error("未対応のGit操作・引数です。");
  const scalar = (value: unknown): string => {
    if (typeof value !== "string" || !value.trim() || value.length > 2_000 || /[\0\r\n]/.test(value)) throw Error("Git文字列引数が不正です。");
    return value;
  };
  const revision = (value: unknown) => {
    const ref = scalar(value ?? "HEAD");
    if (!/^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]*$/.test(ref)) throw Error("Git参照が不正です。");
    return ref;
  };
  const remote = () => {
    const value = scalar(params.remote ?? "origin");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw Error("登録済みremote名を指定してください。");
    return value;
  };
  const filePaths = (required: boolean) => {
    if (!required && params.paths === undefined) return [];
    if (!Array.isArray(params.paths) || !params.paths.length || params.paths.length > 100) throw Error("明示的なファイルパスを指定してください。");
    return params.paths.map((path) => {
      const value = scalar(path);
      const normalized = posix.normalize(value.replace(/\\/g, "/"));
      if (normalized === "." || normalized === "/" || /^[A-Za-z]:\/?$/.test(normalized)) throw Error("一括stageは不可です。対象ファイルを列挙してください。");
      return value;
    });
  };
  let args: string[];
  switch (name) {
    case "status": args = ["status", "--short"]; break;
    case "diff":
      if (params.staged !== undefined && typeof params.staged !== "boolean") throw Error("stagedはbooleanで指定してください。");
      args = ["diff", "--no-ext-diff", "--no-textconv", ...(params.staged ? ["--cached"] : []), "--", ...filePaths(false)]; break;
    case "log": {
      const limit = params.limit ?? 5;
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw Error("limitは1〜100です。");
      args = ["log", "--oneline", `-${limit}`]; break;
    }
    case "show": args = ["show", "--no-ext-diff", "--no-textconv", revision(params.revision), "--"]; break;
    case "add": args = ["add", "--", ...filePaths(true)]; break;
    case "commit": args = ["commit", "-m", scalar(params.message)]; break;
    case "push": args = ["push", remote(), ...(params.branch === undefined ? [] : [revision(params.branch)])]; break;
    case "fetch": args = ["fetch", remote()]; break;
    default: args = ["rev-parse", "--verify", revision(params.revision)];
  }
  return ["--no-pager", "--literal-pathspecs", ...args];
}

/** Directories (including missing tracked directories) must never stage unrelated files. */
export async function validateGitFinalizeAddPaths(
  input: unknown, cwd: string, readTracked: (paths: string[]) => Promise<readonly string[]>,
): Promise<void> {
  const params = input as { operation: string; paths?: string[] };
  if (params.operation !== "add") return;
  const missing: string[] = [];
  await Promise.all(params.paths!.map(async (path) => {
    try {
      const entry = await lstat(resolve(cwd, path));
      if (!entry.isFile() && !entry.isSymbolicLink()) throw Error("一括stageは不可です。対象ファイルを列挙してください。");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(path);
    }
  }));
  if (!missing.length) return;
  const tracked = new Set(await readTracked(missing));
  for (const path of missing) {
    const canonical = relative(cwd, resolve(cwd, path)).split(sep).join("/");
    if (!tracked.has(canonical)) throw Error("存在しないパスは追跡済みファイルの削除だけstageできます。");
  }
}

export function gitFinalizeCommand(args: readonly string[], shell: "powershell" | "bash"): string {
  const quote = (value: string) => shell === "powershell"
    ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, `'"'"'`)}'`;
  if (shell === "powershell" && args[2] === "commit" && args[3] === "-m") {
    // Windows PowerShell's legacy native argv strips embedded double quotes. UTF-8 stdin
    // preserves the exact message on both 5.1 and 7, without shell interpolation.
    return `$OutputEncoding=[System.Text.UTF8Encoding]::new($false); ${quote(args[4]!)} | git ${args.slice(0, 3).map(quote).join(" ")} '--file=-'; exit $LASTEXITCODE`;
  }
  return `git ${args.map(quote).join(" ")}`;
}
