"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, cx } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";

type SkillDto = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
};

type SkillsResponse = {
  skills: SkillDto[];
  skillsDir: string;
};

function SkillSwitch({
  name,
  enabled,
  busy,
  onToggle,
}: {
  name: string;
  enabled: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`${name} を${enabled ? "無効化" : "有効化"}`}
      disabled={busy}
      onClick={onToggle}
      className={cx(
        "relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary",
        enabled ? "bg-primary" : "bg-surface-3",
      )}
    >
      <span
        className={cx(
          "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-surface shadow transition-transform",
          enabled ? "translate-x-5" : "translate-x-0",
        )}
      />
    </button>
  );
}

export function SkillsSettings() {
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [skillsPath, setSkillsPath] = useState<string>("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    void getJson<SkillsResponse>("/api/skills")
      .then((result) => {
        setSkills(result.skills);
        setSkillsPath(result.skillsDir);
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

  async function toggle(skill: SkillDto) {
    if (busyId) return;
    setBusyId(skill.id);
    setError(null);
    try {
      const result = await sendJson<{ skills: SkillDto[] }>(
        `/api/skills/${encodeURIComponent(skill.id)}`,
        { enabled: !skill.enabled },
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
        <h2 className="text-sm font-semibold">スキル</h2>
        <Button variant="secondary" size="sm" onClick={() => reload()} disabled={loading || Boolean(busyId)}>
          再読込
        </Button>
      </div>
      <p className="text-xs text-muted">
        Pi のグローバルスキル（
        <span className="font-mono">~/.pi/agent/skills</span>
        ）を有効／無効にします。無効化は状態ファイルに記録し、開いているセッションへ即時反映します。
      </p>
      {skillsPath && (
        <p className="mt-1 break-all font-mono text-[11px] text-faint">{skillsPath}</p>
      )}
      {loading && skills.length === 0 ? (
        <p className="mt-3 text-sm text-muted">読み込み中…</p>
      ) : skills.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          スキルがありません。{" "}
          <span className="font-mono">~/.pi/agent/skills/&lt;name&gt;/SKILL.md</span>{" "}
          を追加してください。
        </p>
      ) : (
        <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto">
          {skills.map((skill) => (
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
                  <Badge tone={skill.enabled ? "success" : "neutral"}>
                    {skill.enabled ? "有効" : "無効"}
                  </Badge>
                </div>
                {skill.description && (
                  <p className="mt-0.5 text-xs break-words text-faint">{skill.description}</p>
                )}
              </div>
              <SkillSwitch
                name={skill.name}
                enabled={skill.enabled}
                busy={busyId === skill.id}
                onToggle={() => void toggle(skill)}
              />
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
