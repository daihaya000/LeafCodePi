/** Shared model-name heuristics used by Auto routing. */

export function modelIntelligenceScore(modelID: string): number {
  const id = modelID.toLowerCase().replaceAll("_", "-");
  let score = 0;

  if (/gpt-/.test(id)) {
    score += 400_000;
    if (/\bsol\b/.test(id)) score += 100_000;
    else if (/\bterra\b/.test(id)) score += 80_000;
    else if (/\bluna\b/.test(id)) score += 40_000;
    else score += 10_000;
  } else if (/claude-/.test(id)) {
    score += 400_000;
    if (id.includes("fable")) score += 120_000;
    else if (id.includes("opus")) score += 100_000;
    else if (id.includes("sonnet")) score += 60_000;
    else if (id.includes("haiku")) score += 20_000;
  } else if (/\bo[1-9]\b/.test(id) || /^o[1-9]/.test(id)) {
    score += 390_000;
  } else if (/glm-/.test(id)) {
    score += 360_000;
  } else if (/deepseek/.test(id)) {
    score += 300_000;
  } else if (/kimi/.test(id)) {
    score += 280_000;
  } else if (/composer/.test(id)) {
    score += 260_000;
  } else if (id === "auto") {
    score += 200_000;
  }

  if (/\bpro\b/.test(id)) score += 50_000;
  if (/\bmax\b/.test(id)) score += 60_000;
  if (/\bultra\b/.test(id)) score += 70_000;
  if (/\bflash\b/.test(id)) score -= 40_000;
  if (/\bmini\b/.test(id)) score -= 50_000;
  if (/\bnano\b/.test(id)) score -= 70_000;
  if (/\bfast\b/.test(id)) score -= 20_000;
  if (/\blite\b/.test(id)) score -= 30_000;

  const version =
    id.match(/gpt-(\d+)\.(\d+)/) ??
    id.match(/gpt-(\d+)/) ??
    // 日付付きモデル ID（claude-sonnet-4-20250514 等）の 8 桁日付を
    // バージョン小数部として読まない（+2 億スコアで Auto 選択を壊す）。
    id.match(/claude-[\w]+-(\d+)[.-](\d{1,4})(?!\d)/) ??
    id.match(/claude-[\w]+-(\d+)/) ??
    id.match(/glm-(\d+)[.-](\d+)/) ??
    id.match(/glm-(\d+)/) ??
    id.match(/v(\d+)(?:[.-](\d+))?/) ??
    id.match(/(?:^|-)(\d+)\.(\d+)/);
  if (version) {
    const major = Number(version[1]);
    const minor = Number(version[2] ?? 0);
    if (Number.isFinite(major)) score += major * 1_000 + minor * 10;
  }

  return score;
}
