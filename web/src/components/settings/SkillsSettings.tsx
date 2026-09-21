"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Switch } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import { SKILL_GROUPS, type SkillGroupDefinition } from "@/lib/skill-groups";
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
    const enabled = !isEnabled(skill, scope);
    setBusyId(skill.id);
    setError(null);
    setSkills((current) => current.map((item) => {
      if (item.id !== skill.id) return item;
      return scope === "code"
        ? { ...item, enabled, codeEnabled: enabled }
        : { ...item, botEnabled: enabled };
    }));
    try {
      const result = await sendJson<{ skills: SkillDto[] }>(
        `/api/skills/${encodeURIComponent(skill.id)}`,
        { enabled, scope },
        "PATCH",
      );
      setSkills(result.skills);
    } catch (err) {
      setSkills((current) => current.map((item) => item.id === skill.id ? skill : item));
      setError(err instanceof Error ? err.message : "スキルの切替に失敗しました");
      reload();
    } finally {
      setBusyId(null);
    }
  }

  async function toggleGroup(group: SkillGroupDefinition, members: SkillDto[]) {
    if (busyId) return;
    const enabled = !members.every((skill) => isEnabled(skill, scope));
    const memberIds = new Set(members.map((skill) => skill.id));
    setBusyId(group.id);
    setError(null);
    setSkills((current) => current.map((skill) => {
      if (!memberIds.has(skill.id)) return skill;
      return scope === "code"
        ? { ...skill, enabled, codeEnabled: enabled }
        : { ...skill, botEnabled: enabled };
    }));
    try {
      const result = await sendJson<{ skills: SkillDto[] }>(
        "/api/skills",
        { names: members.map((skill) => skill.name), enabled, scope },
        "POST",
      );
      setSkills(result.skills);
    } catch (err) {
      setSkills((current) => current.map((skill) => memberIds.has(skill.id)
        ? members.find((member) => member.id === skill.id) ?? skill
        : skill));
      setError(err instanceof Error ? err.message : "スキルの切替に失敗しました");
      reload();
    } finally {
      setBusyId(null);
    }
  }

  const bundledSkills = skills.filter((skill) => skill.source === "bundled");
  const userSkills = skills.filter((skill) => skill.source !== "bundled");

  function renderSkillItems(items: SkillDto[], grouped: boolean) {
    const groups = grouped ? SKILL_GROUPS : [];
    return (
      <>
        {groups.map((group) => {
          const members = items.filter((skill) => group.skillNames.includes(skill.name));
          if (members.length === 0) return null;
          const enabledCount = members.filter((skill) => isEnabled(skill, scope)).length;
          const enabled = enabledCount === members.length;
          const mixed = enabledCount > 0 && !enabled;
          return (
            <li
              key={group.id}
              data-testid={`skill-group-${group.id}`}
              aria-busy={busyId === group.id || undefined}
              className="flex items-start gap-3 rounded-xl border border-border bg-surface-2 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 truncate text-sm font-medium text-text" title={group.label}>
                    {group.label}
                  </p>
                  <Badge tone={mixed ? "warning" : enabled ? "success" : "neutral"}>
                    {mixed ? "一部有効" : enabled ? "有効" : "無効"}
                  </Badge>
                  <Badge tone="neutral">公式Skills {members.length}件</Badge>
                </div>
                <p className="mt-0.5 break-words text-xs text-muted">{group.description}</p>
              </div>
              <Switch
                checked={enabled}
                onChange={() => void toggleGroup(group, members)}
                label={`${group.label}（${scope === "code" ? "Code" : "Bot"}）を${enabled ? "無効化" : "有効化"}`}
                busy={busyId === group.id}
              />
            </li>
          );
        })}
        {items
          .filter((skill) => !groups.some((group) => group.skillNames.includes(skill.name)))
          .map((skill) => {
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
      </>
    );
  }

  function renderSkillSection(
    id: string,
    title: string,
    description: string | null,
    items: SkillDto[],
    grouped: boolean,
    pathLabel: string | null,
    path: string | null,
  ) {
    return (
      <section data-testid={id} className="rounded-xl border border-border bg-surface p-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-semibold">{title}</h4>
          <Badge tone="neutral">{items.length}件</Badge>
        </div>
        {description && <p className="mt-1 text-xs text-muted">{description}</p>}
        {path && (
          <p className="mt-1 break-all text-[11px] text-muted">{pathLabel && <span className="font-semibold">{pathLabel}: </span>}<span className="font-mono">{path}</span></p>
        )}
        {items.length === 0 ? (
          <p className="mt-3 text-sm text-muted">該当するスキルはありません。</p>
        ) : (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">{renderSkillItems(items, grouped)}</ul>
        )}
      </section>
    );
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
      {loading && skills.length === 0 ? (
        <p className="mt-3 text-sm text-muted">読み込み中…</p>
      ) : skills.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          スキルがありません。{" "}
          <span className="font-mono">~/.pi/agent/skills/&lt;name&gt;/SKILL.md</span>{" "}
          または <span className="font-mono">skills/&lt;name&gt;/SKILL.md</span> を追加してください。
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {renderSkillSection(
            "skills-bundled",
            "組み込み",
            null,
            bundledSkills,
            true,
            null,
            bundledSkillsPath,
          )}
          {renderSkillSection(
            "skills-user",
            "ユーザー追加",
            null,
            userSkills,
            false,
            null,
            skillsPath,
          )}
        </div>
      )}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}
