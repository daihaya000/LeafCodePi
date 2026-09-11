"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { getJson } from "@/lib/client";
import { Badge, Button, cx } from "@/components/ui";
import type { BotSkillsConfig } from "@/lib/types";

type SkillDto = {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  botEnabled?: boolean;
  source?: "pi" | "bundled";
};

type SkillsResponse = {
  skills?: SkillDto[];
};

type SkillMode = BotSkillsConfig["mode"];

const MODE_OPTIONS: readonly { value: SkillMode; label: string; description: string }[] = [
  { value: "inherit", label: "全体設定に従う", description: "設定のBotスキルをそのまま使う" },
  { value: "include", label: "選択したものだけ", description: "チェックしたスキルだけ使う" },
  { value: "exclude", label: "選択したものを除外", description: "チェックしたスキル以外を使う" },
];

function namesFromText(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}

export function BotSkillsSettings({
  skills: value,
  disabled = false,
  onChange,
}: {
  skills: BotSkillsConfig;
  disabled?: boolean;
  onChange: (skills: BotSkillsConfig) => void | Promise<void>;
}) {
  const modeName = useId();
  const [catalog, setCatalog] = useState<SkillDto[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const activeKey: "include" | "exclude" = value.mode === "include" ? "include" : "exclude";
  const activeNames = value[activeKey];
  const activeNamesText = activeNames.join("\n");
  const activeLabel = activeKey === "include" ? "使う" : "除外する";
  const selectedNames = useMemo(() => new Set(activeNames), [activeNames]);
  const availableNames = useMemo(() => new Set(catalog.map((skill) => skill.name)), [catalog]);
  const customNames = useMemo(
    () => activeNames.filter((name) => !availableNames.has(name)),
    [activeNames, availableNames],
  );
  const [customDraft, setCustomDraft] = useState("");

  useEffect(() => {
    setCustomDraft(activeNamesText);
  }, [activeKey, activeNamesText]);

  const loadSkills = useCallback(() => {
    setCatalogLoading(true);
    setCatalogError(null);
    void getJson<SkillsResponse>("/api/skills")
      .then((result) => {
        setCatalog(Array.isArray(result.skills) ? result.skills : []);
      })
      .catch((reason) => {
        setCatalogError(reason instanceof Error ? reason.message : "スキル一覧の取得に失敗しました");
      })
      .finally(() => setCatalogLoading(false));
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  function save(next: BotSkillsConfig): void {
    if (!disabled) void onChange(next);
  }

  function changeMode(mode: SkillMode): void {
    if (mode !== value.mode) save({ ...value, mode });
  }

  function updateNames(names: string[]): void {
    const next = activeKey === "include"
      ? { ...value, include: names }
      : { ...value, exclude: names };
    save(next);
  }

  function toggleSkill(name: string, checked: boolean): void {
    const names = new Set(activeNames);
    if (checked) names.add(name);
    else names.delete(name);
    updateNames([...names]);
  }

  const filteredSkills = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return catalog
      .filter((skill) => !term || `${skill.name} ${skill.description ?? ""}`.toLocaleLowerCase().includes(term))
      .sort((a, b) => Number(selectedNames.has(b.name)) - Number(selectedNames.has(a.name)) || a.name.localeCompare(b.name, "en"));
  }, [catalog, query, selectedNames]);

  const applyCustomNames = () => {
    const names = namesFromText(customDraft);
    setCustomDraft(names.join("\n"));
    updateNames(names);
  };

  return (
    <section className="space-y-4 rounded-2xl border border-border bg-bg p-4" aria-label="スキル設定">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">スキル</h3>
            <p className="mt-1 text-xs leading-5 text-muted">このBotが読み込むスキルを個別に指定します。</p>
          </div>
          {disabled && <span className="shrink-0 text-xs text-muted" role="status" aria-live="polite">保存中…</span>}
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-muted">適用方法</legend>
        <div className="grid gap-2">
          {MODE_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={cx(
                "flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2.5 transition-colors",
                value.mode === option.value ? "border-accent bg-accent/5" : "border-border bg-surface hover:bg-surface-2",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                type="radio"
                name={modeName}
                value={option.value}
                checked={value.mode === option.value}
                disabled={disabled}
                onChange={() => changeMode(option.value)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="mt-0.5 block text-xs text-muted">{option.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {value.mode === "inherit" ? (
        <div className="rounded-xl bg-surface-2 p-3 text-xs leading-5 text-muted">
          <p>設定の「Bot」スキルで有効になっているスキルを使います。</p>
          <p className="mt-1">Botだけ別の構成にする場合は、上の「選択したものだけ」または「選択したものを除外」を選んでください。</p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-medium">{activeLabel}スキル</p>
              <p className="mt-1 text-xs text-muted">{activeNames.length}件指定中。選択した項目は一覧の先頭に表示されます。</p>
            </div>
            <label className="sm:w-44">
              <span className="sr-only">スキルを検索</span>
              <input
                type="search"
                value={query}
                disabled={disabled}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="スキルを検索"
                aria-label="スキルを検索"
                className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-xs outline-none focus:border-accent"
              />
            </label>
          </div>

          {catalogLoading && <p className="text-xs text-muted" role="status">スキル一覧を読み込み中…</p>}
          {catalogError && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-xs">
              <p className="text-danger" role="alert">{catalogError}</p>
              <Button size="sm" variant="ghost" onClick={loadSkills} disabled={catalogLoading}>再読み込み</Button>
            </div>
          )}
          {!catalogLoading && !catalogError && catalog.length === 0 && (
            <p className="rounded-xl bg-surface-2 px-3 py-2 text-xs text-muted">利用できるスキルが見つかりません。下の「名前で指定」から追加できます。</p>
          )}
          {!catalogLoading && catalog.length > 0 && filteredSkills.length === 0 && (
            <p className="rounded-xl bg-surface-2 px-3 py-2 text-xs text-muted">検索条件に一致するスキルはありません。</p>
          )}
          {filteredSkills.length > 0 && (
            <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2" aria-label={`${activeLabel}スキルの一覧`}>
              {filteredSkills.map((skill) => {
                const botEnabled = skill.botEnabled ?? skill.enabled ?? true;
                const checked = selectedNames.has(skill.name);
                return (
                  <li key={skill.id} className="rounded-xl border border-border bg-surface px-3 py-2">
                    <label className="flex cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={(event) => toggleSkill(skill.name, event.target.checked)}
                        aria-label={`${skill.name}を${activeLabel}スキルに指定`}
                        className="mt-1 h-4 w-4 shrink-0 accent-accent"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="min-w-0 break-words text-sm font-medium">{skill.name}</span>
                          <Badge tone={botEnabled ? "success" : "warning"}>{botEnabled ? "Bot全体で有効" : "Bot全体で無効"}</Badge>
                          {skill.source && <Badge tone="neutral">{skill.source === "bundled" ? "同梱" : ".pi/agent"}</Badge>}
                        </span>
                        {skill.description && <span className="mt-1 block break-words text-xs leading-5 text-muted">{skill.description}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {value.mode === "include" && activeNames.length === 0 && (
            <p className="text-xs text-warning" role="status">選択がないため、このBotではスキルを読み込みません。</p>
          )}

          {customNames.length > 0 && (
            <div className="rounded-xl border border-accent/30 bg-accent/5 p-3">
              <p className="text-xs font-medium">一覧にない指定</p>
              <ul className="mt-2 space-y-1">
                {customNames.map((name) => (
                  <li key={name} className="flex items-center gap-2 text-xs">
                    <code className="min-w-0 flex-1 break-all">{name}</code>
                    <button type="button" disabled={disabled} onClick={() => updateNames(activeNames.filter((item) => item !== name))} className="shrink-0 text-danger hover:underline disabled:opacity-50">削除</button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <details open={customOpen || customNames.length > 0} onToggle={(event) => setCustomOpen(event.currentTarget.open)} className="rounded-xl border border-border bg-surface">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium">名前で指定（一覧にないスキル向け）</summary>
            <div className="space-y-2 border-t border-border p-3">
              <textarea
                value={customDraft}
                disabled={disabled}
                onChange={(event) => setCustomDraft(event.target.value)}
                rows={3}
                aria-label={`${activeLabel}スキル名`}
                placeholder="skill-name（1行1件）"
                className="w-full resize-y rounded-lg border border-border bg-bg px-2 py-1.5 font-mono text-xs outline-none focus:border-accent"
              />
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-muted">空行と重複は保存時に整理します。</p>
                <Button size="sm" onClick={applyCustomNames} disabled={disabled}>適用</Button>
              </div>
            </div>
          </details>
        </div>
      )}

      <p className="text-[11px] leading-5 text-muted">全体設定で無効なスキルは、個別に選択しても読み込まれません。保存後、新しいBotセッションから適用されます。</p>
    </section>
  );
}
