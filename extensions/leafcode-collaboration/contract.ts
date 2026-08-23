export const LEAFCODE_COLLABORATION_EXTENSION_NAME = "leafcode-collaboration" as const;

export const LEAFCODE_COLLABORATION_TOOL_NAMES = [
  "leafcode_collab",
  "leafcode_write",
  "leafcode_edit",
  "leafcode_check",
  "leafcode_commit",
] as const;

export type LeafCodeCollaborationToolName = (typeof LEAFCODE_COLLABORATION_TOOL_NAMES)[number];

export const LEAFCODE_STRICT_BLOCKED_TOOL_NAMES = ["bash", "write", "edit"] as const;

export type LeafCodeCollaborationMode = "strict" | "permissive" | "off";
