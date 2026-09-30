import { isAvatarEyeColor, randomAvatarColor } from "./bot-avatar.mjs";
import { DEFAULT_SKILLS } from "./bot-config.mjs";

/**
 * Pure construction of a Bot record: the defaults a new Bot is created with,
 * and the merge rules a patch follows. File writes, SOUL handling and task
 * synchronization stay with the caller.
 */
export function createBotConfig({ id, name, model, thinkingLevel, permissionMode, now, defaultToolNames }) {
  const trimmed = (name ?? "").trim() || "New bot";
  return {
    id, name: trimmed, label: "",
    avatarColor: randomAvatarColor(), avatarImage: null, avatarShape: "circle",
    avatarGlasses: false, avatarMustache: false,
    createdAt: now, updatedAt: now,
    model: model ?? null, ttsVoice: null, thinkingLevel: thinkingLevel ?? null,
    permissionMode: permissionMode ?? "allow", codeAutoApprove: true,
    skills: { mode: DEFAULT_SKILLS.mode, include: [...DEFAULT_SKILLS.include], exclude: [...DEFAULT_SKILLS.exclude] }, tools: [...defaultToolNames],
    extraRoots: [], enabled: true, notificationsEnabled: true,
    intercomEnabled: false, intercomScopeId: "", intercomFanoutEnabled: false,
    codeSessionTaskId: null,
  };
}

/**
 * Merge a patch into a stored config. `soul` is stripped: it is file content, not
 * config. An empty or whitespace voice clears the voice, and an explicit eye
 * color that is not one of the two allowed values clears it back to automatic
 * (assigned as undefined so it disappears when the config is serialized).
 */
export function applyBotConfigPatch(current, patch, { now }) {
  const ttsVoice = patch.ttsVoice === undefined
    ? current.ttsVoice
    : (typeof patch.ttsVoice === "string" && patch.ttsVoice.trim() ? patch.ttsVoice.trim() : null);
  const next = {
    ...current,
    ...patch,
    ttsVoice,
    avatarEyeColor: patch.avatarEyeColor === undefined
      ? current.avatarEyeColor
      : (isAvatarEyeColor(patch.avatarEyeColor) ? patch.avatarEyeColor : undefined),
    skills: patch.skills ?? current.skills,
    updatedAt: now,
  };
  delete next.soul;
  return next;
}
