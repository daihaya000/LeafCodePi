import type { Link, Root } from "mdast";
import { normalizeLinkUrl } from "@/lib/link-preview-shared";

/** Mark only URL-only paragraphs: inline prose, code, images and internal task links stay unchanged. */
export function remarkLinkCards() {
  return (tree: Root) => {
    let count = 0;
    const seen = new Set<string>();
    const stack: { type: string; children?: unknown[] }[] = [tree];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.type === "paragraph" && node.children?.every((child) => {
        const item = child as { type: string; value?: string; url?: string };
        return item.type === "text" ? !item.value?.trim() : item.type === "link" && Boolean(normalizeLinkUrl(item.url));
      })) {
        for (const child of node.children) {
          const link = child as Link;
          if (link.type !== "link" || count >= 6) continue;
          const url = normalizeLinkUrl(link.url)!;
          if (seen.has(url)) continue;
          seen.add(url);
          count++;
          link.data ??= {};
          link.data.hProperties = { ...link.data.hProperties, "data-link-preview": "true" };
        }
      }
      if (node.children) for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index] as typeof node);
    }
  };
}
