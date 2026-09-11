"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Switch } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import type { SkillScope } from "@/lib/skills";

type SkillDto = {
  id: string;
  name: string;
  description?: string;
  /** Old API responses only have `enabled`, which means Code. */
  enabled: boolean;
  codeEnabled?: boolean;
  botEnabled?: boolean;
  source: "pi" | "bundled";
  filePath?: string;
};

type SkillsResponse = {
  skills: SkillDto[];
  skillsDir: string;
  bundledSkillsDir?: string | null;
};

export function SkillsSettings({ scope = "code" }: { scope?: SkillScope } = {}) {
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [skillsPath, setSkillsPath] = useState<string>("");
  const [bundledSkillsPath, setBundledSkillsPath] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    void getJson<SkillsResponse>("/api/skills")
      .then((result) => {
        setSkills(result.skills);
        setSkillsPath(result.skillsDir);
        setBundledSkillsPath(result.bundledSkillsDir ?? null);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "スキル一覧の取得に失敗しました");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  function isEnabled(skill: SkillDto, scope: SkillScope): boolean {
    return (scope === "code" ? skill.codeEnabled : skill.botEnabled) ?? skill.enabled;
  }

  async function toggle(skill: SkillDto) {
    if (busyId) return;
    setBusyId(skill.id);
    setError(null);
    try {
      const result = await sendJson<{ skills: SkillDto[] }>(
        `/api/skills/${encodeURIComponent(skill.id)}`,
        { enabled: !isEnabled(skill, scope), scope },
        "PATCH",
      );
      setSkills(result.skills);
    } catch (err) {
      setError(err instanceof Error ? err.message : "スキルの切替に失敗しました");
      reload();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">スキル</h3>
        <Button variant="secondary" size="sm" onClick={() => reload()} disabled={loading || Boolean(busyId)}>
          再読込
        </Button>
      </div>
      <p className="text-xs text-muted">
        Pi のグローバルスキルと LeafCodePi の同梱スキルを、{scope === "code" ? "Codeの通常タスク" : "Botの会話とルーム"}で別々に有効／無効にします。開いているセッションへバックグラウンドで反映します。
      </p>
      {(skillsPath || bundledSkillsPath) && (
        <div className="mt-1 space-y-0.5 font-mono text-[11px] text-muted">
          {skillsPath && <p className="break-all">{skillsPath}</p>}
          {bundledSkillsPath && <p className="break-all">{bundledSkillsPath}</p>}
        </div>
      )}
      {loading && skills.length === 0 ? (
        <p className="mt-3 text-sm text-muted">読み込み中…</p>
      ) : skills.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          スキルがありません。{" "}
          <span className="font-mono">~/.pi/agent/skills/&lt;name&gt;/SKILL.md</span>{" "}
          または <span className="font-mono">skills/&lt;name&gt;/SKILL.md</span> を追加してください。
        </p>
      ) : (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {skills.map((skill) => {
            const enabled = isEnabled(skill, scope);
            return (
              <li
                key={skill.id}
                aria-busy={busyId === skill.id || undefined}
                className="flex items-start gap-3 rounded-xl border border-border bg-surface-2 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 truncate text-sm font-medium text-text" title={skill.id}>
                      {skill.name}
                    </p>
                    <Badge tone={enabled ? "success" : "neutral"}>{enabled ? "有効" : "無効"}</Badge>
                    <Badge tone="neutral">{skill.source === "bundled" ? "LeafCodePi" : ".pi/agent"}</Badge>
                  </div>
                  {skill.description && (
                    <p className="mt-0.5 break-words text-xs text-muted">{skill.description}</p>
                  )}
                </div>
                <Switch
                  checked={enabled}
                  onChange={() => void toggle(skill)}
                  label={`${skill.name}（${scope === "code" ? "Code" : "Bot"}）を${enabled ? "無効化" : "有効化"}`}
                  busy={busyId === skill.id}
                />
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}
