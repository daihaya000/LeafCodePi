"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  parsePermissionMode,
  PERMISSION_MODE_SETTING_KEY,
  PERMISSION_OPTIONS,
} from "@/lib/permission-gate";
import {
  DEFAULT_SKILL_PERMISSION,
  parseSkillPermission,
  SKILL_PERMISSION_SETTING_KEY,
} from "@/lib/skill-permission";
import {
  DEFAULT_SUBAGENT_PERMISSION,
  parseSubagentPermission,
  SUBAGENT_PERMISSION_SETTING_KEY,
} from "@/lib/subagent-permission";

/** Load a server setting once, save each change, and roll back on failure. */
function useServerSetting<T extends string>(
  key: string,
  parse: (value: unknown) => T,
  fallback: T,
) {
  const [value, setValue] = useState<T>(fallback);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getJson<{ value: string | null }>(`/api/settings/${key}`)
      .then((result) => {
        if (!active) return;
        setValue(parse(result?.value));
        setLoaded(true);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "設定の読み込みに失敗しました");
      });
    return () => {
      active = false;
    };
  }, [key, parse]);

  async function save(next: T) {
    if (!loaded || saving || next === value) return;
    const previous = value;
    setValue(next);
    setSaving(true);
    setError(null);
    try {
      const result = await sendJson<{ value: string | null }>(`/api/settings/${key}`, { value: next }, "PUT");
      setValue(parse(result?.value));
    } catch (cause) {
      setValue(previous);
      setError(cause instanceof Error ? cause.message : "設定の保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  return { value, loaded, saving, error, save };
}

const APPLY_NOTE = "開いているタスクには次のターンから反映します。";

/** Tool approval for user-started Code tasks (エンジン > アクセスと安全). */
export function PermissionModeSettings() {
  const setting = useServerSetting(PERMISSION_MODE_SETTING_KEY, parsePermissionMode, DEFAULT_PERMISSION_MODE);
  const selected = PERMISSION_OPTIONS.find((option) => option.value === setting.value);
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">権限承認</h3>
      <p className="mt-1 text-xs text-muted">
        Codeタスクの Bash / PowerShell / 画面操作の承認方法です。許可では通常の画面操作を確認なしで実行します。
        OS 等への操作はシステム安全ガードの設定に従います。{APPLY_NOTE}
        Botが開始・監督するCodeタスクはBotの権限に従います。既定は許可です。
      </p>
      <label className="mt-3 flex flex-col gap-1.5 @xl:flex-row @xl:items-center @xl:gap-3">
        <span className="shrink-0 text-sm text-muted">承認モード</span>
        <select
          value={setting.value}
          aria-label="権限承認"
          disabled={!setting.loaded || setting.saving}
          onChange={(event) => {
            if (isPermissionMode(event.target.value)) void setting.save(event.target.value);
          }}
          className="h-9 w-full max-w-[14rem] rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-border-strong disabled:opacity-50"
        >
          {PERMISSION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      {selected && <p className="mt-2 text-xs text-muted">{selected.title}</p>}
      {setting.error && <p role="alert" className="mt-2 text-sm text-danger">{setting.error}</p>}
    </div>
  );
}

function PermissionSwitchCard({
  title,
  description,
  label,
  allowed,
  loaded,
  saving,
  error,
  onToggle,
}: {
  title: string;
  description: string;
  label: string;
  allowed: boolean;
  loaded: boolean;
  saving: boolean;
  error: string | null;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="mt-1 text-xs text-muted">{description}</p>
        </div>
        <Switch checked={allowed} onChange={onToggle} label={label} disabled={!loaded} busy={saving} />
      </div>
      <p className="mt-2 text-[11px] text-muted" aria-live="polite">
        現在: {allowed ? "許可" : "禁止"}
      </p>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}

/** Skill use in Code tasks (エージェント > エージェント用スキル). */
export function SkillPermissionSettings() {
  const setting = useServerSetting(SKILL_PERMISSION_SETTING_KEY, parseSkillPermission, DEFAULT_SKILL_PERMISSION);
  const allowed = setting.value === "allow";
  return (
    <PermissionSwitchCard
      title="スキル使用"
      description={`オフにするとCodeタスクでスキルを読み込みません。${APPLY_NOTE}Botの会話はボット用スキルで管理します。既定は許可です。`}
      label="Codeタスクでスキルを使用する"
      allowed={allowed}
      loaded={setting.loaded}
      saving={setting.saving}
      error={setting.error}
      onToggle={() => void setting.save(allowed ? "deny" : "allow")}
    />
  );
}

/** Subagent launch from Code tasks (エージェント > エージェント運用). */
export function SubagentPermissionSettings() {
  const setting = useServerSetting(SUBAGENT_PERMISSION_SETTING_KEY, parseSubagentPermission, DEFAULT_SUBAGENT_PERMISSION);
  const allowed = setting.value === "allow";
  return (
    <PermissionSwitchCard
      title="サブエージェント使用"
      description={`オンにするとCodeタスクがサブエージェントを起動できます。${APPLY_NOTE}既定は禁止です。`}
      label="Codeタスクでサブエージェントを使用する"
      allowed={allowed}
      loaded={setting.loaded}
      saving={setting.saving}
      error={setting.error}
      onToggle={() => void setting.save(allowed ? "deny" : "allow")}
    />
  );
}
