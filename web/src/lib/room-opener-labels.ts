import type { RoomOpenerReasonKind } from "@/lib/types";

/** Short chip label for why this bot opened the turn. */
export function roomOpenerReasonLabel(reason: RoomOpenerReasonKind): string {
  return reason === "keyword" ? "キーワード一致" : "LLM選択";
}
