import type { Link, PhrasingContent, Root } from "mdast";
import { normalizeLinkUrl } from "@/lib/link-preview-shared";

function isTextLabel(node: PhrasingContent): boolean {
  return node.type === "text" || node.type === "inlineCode"
    || ((node.type === "emphasis" || node.type === "strong" || node.type === "delete") && node.children.every(isTextLabel));
}

function isPreviewLink(node: PhrasingContent): node is Link {
  return node.type === "link" && node.children.every(isTextLabel) && Boolean(normalizeLinkUrl(node.url));
}

function labelText(node: PhrasingContent): string | null {
  if (node.type === "text") return node.value;
  if (node.type !== "emphasis" && node.type !== "strong" && node.type !== "delete") return null;
  const parts = node.children.map(labelText);
  return parts.some((part) => part === null) ? null : parts.join("");
}

function sourceLinks(children: PhrasingContent[]): Set<Link> {
  const lines: PhrasingContent[][] = [[]];
  for (const child of children) {
    if (child.type === "break") { lines.push([]); continue; }
    if (child.type !== "text") { lines[lines.length - 1].push(child); continue; }
    child.value.split("\n").forEach((value, index) => {
      if (index) lines.push([]);
      lines[lines.length - 1].push({ type: "text", value });
    });
  }
  const links = new Set<Link>();
  for (const line of lines) {
    const first = line.findIndex(isPreviewLink);
    if (first < 0) continue;
    const prefix = line.slice(0, first).map(labelText);
    if (prefix.some((part) => part === null) || !/^(?:出典|参照|参考|ソース|sources?)\s*[:：]\s*$/i.test(prefix.join("").trim())) continue;
    const rest = line.slice(first);
    if (!rest.every((child) => isPreviewLink(child) || (child.type === "text" && /^[\s/／・,，、|｜]*$/.test(child.value)))) continue;
    for (const child of rest) if (isPreviewLink(child)) links.add(child);
  }
  return links;
}

/** Preview standalone URLs and source-labelled lines; ordinary prose/code/internal links stay unchanged. */
export function remarkLinkCards() {
  return (tree: Root) => {
    let count = 0;
    const seen = new Set<string>();
    const stack: { type: string; children?: unknown[] }[] = [tree];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.type === "paragraph" && node.children) {
        const children = node.children as PhrasingContent[];
        const standalone = children.every((child) => child.type === "text" ? !child.value.trim() : isPreviewLink(child));
        const sources = standalone ? null : sourceLinks(children);
        for (const link of children) {
          if (!isPreviewLink(link) || (!standalone && !sources?.has(link)) || count >= 12) continue;
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
