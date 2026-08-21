/** Lightweight syntax tint for diff lines (no heavy highlighter dep). */

const KEYWORDS =
  /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|type|interface|new|try|catch|throw|switch|case|break|continue|default|null|undefined|true|false|this|typeof|extends|implements|public|private|protected|static|void|number|string|boolean|package|func|defer|go|chan|select|match|fn|mut|pub|use|mod|struct|enum|impl)\b/g;

const TINT_EXTS = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs",
  "java", "kt", "cs", "rb", "php", "css", "scss",
];

export function tintCodeLine(text: string, filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (!TINT_EXTS.includes(ext)) {
    return escapeHtml(text);
  }
  let s = escapeHtml(text);
  // Keyword pass runs FIRST, on the plain escaped text. The comment/string
  // passes that follow only look for `//`, `#`, `&quot;`, `&#39;` or backticks,
  // none of which appear in the `<span class="…">` markup we inject — so the
  // `class` attribute of our own markup can never be re-matched as a keyword
  // (KEYWORDS includes `class`), which used to corrupt the emitted HTML.
  s = s.replace(KEYWORDS, '<span class="text-accent">$&</span>');
  // R15#3: comments — avoid matching `#` in HTML entities like `&#39;`
  // Use negative lookbehind to exclude `#` preceded by `&`
  s = s.replace(/(\/\/.*$|(?<!&)#.*$)/g, '<span class="text-faint">$1</span>');
  // strings
  s = s.replace(
    /(&quot;.*?&quot;|&#39;.*?&#39;|`.*?`)/g,
    '<span class="text-success">$1</span>',
  );
  return s;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
