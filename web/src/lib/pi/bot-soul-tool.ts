import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { patchBot } from "@/lib/bots";

export const BOT_SOUL_TOOL = "update_soul";
export const BOT_SOUL_MAX_BYTES = 128 * 1024;

const BOT_SOUL_TOOL_DESCRIPTION =
  "Update this Bot's own SOUL.md. Use only after the user explicitly asks you to change your personality, role, or standing instructions. Read the current SOUL.md first, preserve instructions the user did not ask to remove, and provide the complete replacement Markdown. This tool cannot edit any other file or another Bot's SOUL.md.";

type SoulUpdateCallback = () => void;

/** Register the narrowly scoped tool that lets a Bot update only its own SOUL.md. */
export function botSoulTool(
  botId: string,
  onUpdated?: SoulUpdateCallback,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool({
      name: BOT_SOUL_TOOL,
      label: "Update SOUL.md",
      description: BOT_SOUL_TOOL_DESCRIPTION,
      promptSnippet: "update_soul: update your own SOUL.md after an explicit user request",
      promptGuidelines: [
        "Only use update_soul when the user explicitly requests a change to your own SOUL.md.",
        "Read the current SOUL.md first and send the complete replacement content; this tool cannot edit other files.",
      ],
      parameters: Type.Object({
        content: Type.String({
          description: "Complete replacement contents for this Bot's SOUL.md",
        }),
      }),
      async execute(_toolCallId, input) {
        if (Buffer.byteLength(input.content, "utf8") > BOT_SOUL_MAX_BYTES) {
          throw new Error(`SOUL.md is too large (maximum ${BOT_SOUL_MAX_BYTES} bytes)`);
        }
        if (input.content.includes("\0")) {
          throw new Error("SOUL.md cannot contain null bytes");
        }
        const updated = patchBot(botId, { soul: input.content });
        if (!updated) throw new Error("Bot not found");
        onUpdated?.();
        return {
          content: [{
            type: "text",
            text: "Updated this Bot's SOUL.md. The new instructions will be loaded on the next turn.",
          }],
          details: { updated: true },
        };
      },
    });
  };
}
