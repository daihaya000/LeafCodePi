import { DEFAULT_AGENT } from "@/lib/default-agent";

export const GIT_COMMIT_AUTHOR_SETTING_KEY = "git-commit-author";
export const DEFAULT_GIT_COMMIT_AGENT_NAME = DEFAULT_AGENT;

export type GitCommitAuthorSettings = {
  nameTemplate: string;
  emailTemplate: string;
};

export const DEFAULT_GIT_COMMIT_AUTHOR_SETTINGS: GitCommitAuthorSettings = {
  nameTemplate: "{agent}",
  emailTemplate: "{agent}@leafcodepi.local",
};

const AGENT_TOKEN = "{agent}";
const MAX_NAME_TEMPLATE_LENGTH = 255;
const MAX_EMAIL_TEMPLATE_LENGTH = 320;

/** Normalize and validate user-configured author templates. */
export function normalizeGitCommitAuthorSettings(value: unknown): GitCommitAuthorSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const settings = value as Record<string, unknown>;
  if (typeof settings.nameTemplate !== "string" || typeof settings.emailTemplate !== "string") {
    return null;
  }

  const nameTemplate = settings.nameTemplate.trim();
  const emailTemplate = settings.emailTemplate.trim();
  if (
    !nameTemplate ||
    nameTemplate.length > MAX_NAME_TEMPLATE_LENGTH ||
    /[\u0000-\u001f\u007f<>]/.test(nameTemplate)
  ) {
    return null;
  }
  if (
    !emailTemplate ||
    emailTemplate.length > MAX_EMAIL_TEMPLATE_LENGTH ||
    /[\s\u0000-\u001f\u007f<>]/.test(emailTemplate) ||
    (emailTemplate.match(/@/g)?.length ?? 0) !== 1 ||
    emailTemplate.startsWith("@") ||
    emailTemplate.endsWith("@")
  ) {
    return null;
  }
  return { nameTemplate, emailTemplate };
}

export function validateGitCommitAuthorSetting(value: string): string | null {
  try {
    const normalized = normalizeGitCommitAuthorSettings(JSON.parse(value));
    return normalized ? JSON.stringify(normalized) : null;
  } catch {
    return null;
  }
}

export function parseGitCommitAuthorSettings(value: string | null): GitCommitAuthorSettings {
  if (!value) return { ...DEFAULT_GIT_COMMIT_AUTHOR_SETTINGS };
  try {
    return normalizeGitCommitAuthorSettings(JSON.parse(value)) ?? {
      ...DEFAULT_GIT_COMMIT_AUTHOR_SETTINGS,
    };
  } catch {
    return { ...DEFAULT_GIT_COMMIT_AUTHOR_SETTINGS };
  }
}

export function resolveGitCommitAuthor(
  agentName: string,
  settings: GitCommitAuthorSettings,
): { name: string; email: string } {
  return {
    name: settings.nameTemplate.split(AGENT_TOKEN).join(agentName),
    email: settings.emailTemplate.split(AGENT_TOKEN).join(agentName),
  };
}
