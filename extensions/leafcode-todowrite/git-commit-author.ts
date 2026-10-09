import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GIT_COMMIT_AGENT_NAME,
  GIT_COMMIT_AUTHOR_SETTING_KEY,
  parseGitCommitAuthorSettings,
  resolveGitCommitAuthor,
} from "../../shared/git-commit-author.ts";
import { getMachineName } from "../../backend/runtime-src/lib/machine-name.ts";

const SAFE_AGENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function dataDir(): string {
  const override = process.env.LEAFCODE_PI_DATA_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA?.trim();
    if (roaming) return join(roaming, "leafcode-pi");
  }
  return join(homedir(), ".leafcode-pi");
}

function readAuthorSetting(): string | null {
  try {
    const settings = JSON.parse(readFileSync(join(dataDir(), "web-settings.json"), "utf8")) as Record<string, unknown>;
    const value = settings?.[GIT_COMMIT_AUTHOR_SETTING_KEY];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** Resolve the same configured identity used by the Git commit API. */
export function resolveConfiguredGitCommitAuthor(agentName?: unknown): { name: string; email: string } {
  const agent = typeof agentName === "string" && SAFE_AGENT.test(agentName)
    ? agentName
    : DEFAULT_GIT_COMMIT_AGENT_NAME;
  return resolveGitCommitAuthor(
    agent,
    parseGitCommitAuthorSettings(readAuthorSetting()),
    getMachineName(),
  );
}
