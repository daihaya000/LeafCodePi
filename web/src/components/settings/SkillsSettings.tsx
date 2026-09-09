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

export function SkillsSettings() {
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [skillsPath, setSkillsPath] = useState<string>("");
  const [bundledSkillsPath, setBundledSkillsPath] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
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

  async function toggle(skill: SkillDto, scope: SkillScope) {
    const key = `${skill.id}:${scope}`;
    if (busyKey) return;
    setBusyKey(key);
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
      setBusyKey(null);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">スキル</h3>
        <Button variant="secondary" size="sm" onClick={() => reload()} disabled={loading || Boolean(busyKey)}>
          再読込
        </Button>
      </div>
      <p className="text-xs text-muted">
        Pi のグローバルスキルと LeafCodePi の同梱スキルを、CodeとBotで別々に有効／無効にします。Codeは通常のタスク、BotはBotの会話とルームに適用され、開いているセッションへ即時反映します。
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
        <>
          <div className="mt-3 hidden grid-cols-[minmax(0,1fr)_5rem_5rem] gap-3 px-3 text-center text-xs font-medium text-muted sm:grid" aria-hidden="true">
            <span />
            <span>Code</span>
            <span>Bot</span>
          </div>
          <ul className="space-y-2">
            {skills.map((skill) => {
              const codeEnabled = isEnabled(skill, "code");
              const botEnabled = isEnabled(skill, "bot");
              const status = codeEnabled && botEnabled ? "両方有効" : codeEnabled ? "Codeのみ" : botEnabled ? "Botのみ" : "両方無効";
              return (
                <li
                  key={skill.id}
                  aria-busy={busyKey?.startsWith(`${skill.id}:`) || undefined}
                  className="grid gap-3 rounded-xl border border-border bg-surface-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_5rem_5rem]"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 truncate text-sm font-medium text-text" title={skill.id}>
                        {skill.name}
                      </p>
                      <Badge tone={codeEnabled || botEnabled ? "success" : "neutral"}>{status}</Badge>
                      <Badge tone="neutral">{skill.source === "bundled" ? "LeafCodePi" : ".pi/agent"}</Badge>
                    </div>
                    {skill.description && (
                      <p className="mt-0.5 break-words text-xs text-muted">{skill.description}</p>
                    )}
                  </div>
                  {(["code", "bot"] as const).map((scope) => {
                    const enabled = isEnabled(skill, scope);
                    const key = `${skill.id}:${scope}`;
                    return (
                      <div key={scope} className="flex items-center justify-between gap-2 sm:justify-center">
                        <span className="text-xs text-muted sm:hidden">{scope === "code" ? "Code" : "Bot"}</span>
                        <Switch
                          checked={enabled}
                          onChange={() => void toggle(skill, scope)}
                          label={`${skill.name}（${scope === "code" ? "Code" : "Bot"}）を${enabled ? "無効化" : "有効化"}`}
                          busy={busyKey === key}
                        />
                      </div>
                    );
                  })}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}
