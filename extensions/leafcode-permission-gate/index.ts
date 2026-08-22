/**
 * LeafCode Permission Gate for Pi
 *
 * - 危険な bash コマンド実行前に承認ダイアログを出す (permission-gate)
 * - 保護パスへの write/edit をブロックする (protected-paths)
 * - WebUI の Composer から設定される「承認モード」に連動して動作を切り替える
 *
 * WebUI からは `/api/tasks/:id/permission` で承認モードを設定する。
 * 未設定時は "ask"（確認）。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type PermissionMode = "allow" | "ask" | "deny";

type StoredConfig = {
  mode: PermissionMode;
};

const CONFIG_DIR = ".pi/leafcode";
const CONFIG_FILE = "permission-gate.json";
const SESSION_KEY = "leafcode-permission-gate";

const DANGEROUS_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\brm\s+(-[rf]*|--recursive|--force)/i, label: "rm -rf / rm --recursive" },
  { pattern: /\bsudo\b/i, label: "sudo" },
  { pattern: /\b(chmod|chown)\b.*777/i, label: "chmod/chown 777" },
  { pattern: /\bdd\s+(if|of)=/i, label: "dd disk write" },
  { pattern: /\bmkfs\./i, label: "mkfs" },
  { pattern: /\b(fdisk|parted)\b/i, label: "partition tool" },
  { pattern: /\bwget\s+.*\|\s*(ba)?sh/i, label: "pipe-to-shell" },
  { pattern: /\bcurl\s+.*\|\s*(ba)?sh/i, label: "pipe-to-shell" },
  { pattern: /\bgit\s+push\s+--force\b/i, label: "git push --force" },
  { pattern: /\b(git\s+reset\s+--hard|git\s+clean\s+-fd)/i, label: "destructive git" },
];

const PROTECTED_PATHS = [".env", ".git/", "node_modules/", ".pi/agent/auth.json", ".ssh/", ".aws/"];

function configPath(cwd: string): string {
  return `${cwd}/${CONFIG_DIR}/${CONFIG_FILE}`;
}

function readConfig(cwd: string): StoredConfig {
  try {
    const { readFileSync } = require("node:fs");
    const raw = JSON.parse(readFileSync(configPath(cwd), "utf8"));
    if (raw && (raw.mode === "allow" || raw.mode === "ask" || raw.mode === "deny")) {
      return { mode: raw.mode };
    }
  } catch {
    /* ignore */
  }
  return { mode: "ask" };
}

function sessionMode(ctx: ExtensionContext): PermissionMode {
  try {
    const stored = (ctx as unknown as Record<string, unknown>)[SESSION_KEY];
    if (stored === "allow" || stored === "ask" || stored === "deny") return stored;
  } catch {
    /* ignore */
  }
  return "ask";
}

function setSessionMode(ctx: ExtensionContext, mode: PermissionMode): void {
  try {
    (ctx as unknown as Record<string, unknown>)[SESSION_KEY] = mode;
  } catch {
    /* ignore */
  }
}

export function getPermissionMode(ctx: ExtensionContext): PermissionMode {
  return sessionMode(ctx);
}

export function setPermissionMode(ctx: ExtensionContext, mode: PermissionMode): void {
  setSessionMode(ctx, mode);
}

function isProtectedPath(path: string): { protected: boolean; reason?: string } {
  const normalized = path.replace(/\\/g, "/");
  for (const p of PROTECTED_PATHS) {
    if (normalized.includes(p)) return { protected: true, reason: `protected path "${p}"` };
  }
  return { protected: false };
}

function matchedDanger(command: string): { dangerous: boolean; labels: string[] } {
  const labels = DANGEROUS_PATTERNS.filter(({ pattern }) => pattern.test(command)).map((d) => d.label);
  return { dangerous: labels.length > 0, labels };
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    try {
      const config = readConfig(ctx.cwd);
      setSessionMode(ctx, config.mode);
    } catch {
      setSessionMode(ctx, "ask");
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      const command = (event.input as { command?: string }).command ?? "";
      const { dangerous, labels } = matchedDanger(command);
      if (dangerous) {
        const mode = sessionMode(ctx);
        if (mode === "deny") {
          return { block: true, reason: `Dangerous command blocked: ${labels.join(", ")}` };
        }
        if (mode === "ask") {
          if (!ctx.hasUI) {
            return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
          }
          const choice = await ctx.ui.select(
            `危険なコマンドを検出しました:\n  ${command}\n\n許可しますか?`,
            ["Yes", "No"],
          );
          if (choice !== "Yes") {
            return { block: true, reason: "Blocked by user" };
          }
        }
      }
      return undefined;
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const path = (event.input as { path?: string }).path ?? "";
      const check = isProtectedPath(path);
      if (check.protected) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Blocked write to ${check.reason}`, "warning");
        }
        return { block: true, reason: `Path "${path}" is protected (${check.reason})` };
      }
      return undefined;
    }

    return undefined;
  });

  pi.registerCommand("leafcode-permission", {
    description: "Set LeafCode permission mode: allow, ask, deny",
    handler: async (args, ctx) => {
      const mode = args.trim() as PermissionMode;
      if (mode !== "allow" && mode !== "ask" && mode !== "deny") {
        ctx.ui.notify("Usage: /leafcode-permission allow|ask|deny", "warning");
        return;
      }
      setSessionMode(ctx, mode);
      ctx.ui.notify(`Permission mode set to: ${mode}`, "info");
    },
  });
}
