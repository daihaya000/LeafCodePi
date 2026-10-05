"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { getJson, sendJson } from "@/lib/client";
import {
  DEFAULT_GIT_COMMIT_AGENT_NAME,
  DEFAULT_GIT_COMMIT_AUTHOR_SETTINGS,
  GIT_COMMIT_AUTHOR_SETTING_KEY,
  normalizeGitCommitAuthorSettings,
  parseGitCommitAuthorSettings,
  resolveGitCommitAuthor,
  type GitCommitAuthorSettings as AuthorSettings,
} from "@/lib/git-commit-author";

const SETTING_PATH = `/api/settings/${GIT_COMMIT_AUTHOR_SETTING_KEY}`;

export function GitCommitAuthorSettings() {
  const [settings, setSettings] = useState<AuthorSettings>({ ...DEFAULT_GIT_COMMIT_AUTHOR_SETTINGS });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    void getJson<{ value: string | null }>(SETTING_PATH)
      .then(({ value }) => {
        if (!active) return;
        setSettings(parseGitCommitAuthorSettings(value));
        setError(null);
      })
      .catch(() => {
        if (active) setError("コミット作者設定を読み込めませんでした");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  async function save(next: AuthorSettings) {
    const normalized = normalizeGitCommitAuthorSettings(next);
    if (!normalized) {
      setError("作者名とメールアドレスの形式を確認してください");
      setSaved(false);
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await sendJson<{ value: string | null }>(
        SETTING_PATH,
        { value: JSON.stringify(normalized) },
        "PUT",
      );
      setSettings(parseGitCommitAuthorSettings(response.value));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "コミット作者設定を保存できませんでした");
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await sendJson<{ value: string | null }>(
        SETTING_PATH,
        { value: null },
        "PUT",
      );
      setSettings(parseGitCommitAuthorSettings(response.value));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "既定値に戻せませんでした");
    } finally {
      setSaving(false);
    }
  }

  const preview = resolveGitCommitAuthor(DEFAULT_GIT_COMMIT_AGENT_NAME, settings);

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <h3 className="text-sm font-semibold">Gitコミット作者</h3>
      <p className="mt-1 text-xs text-muted">
        Gitの作者名・メールを設定します。テンプレート内の <code>{"{agent}"}</code> は実際のエージェント名（default など）に置き換わります。
      </p>
      <label className="mt-3 flex flex-col gap-1.5">
        <span className="text-sm text-muted">作者名テンプレート</span>
        <input
          value={settings.nameTemplate}
          maxLength={255}
          aria-label="作者名テンプレート"
          onChange={(event) => {
            setSettings((current) => ({ ...current, nameTemplate: event.target.value }));
            setSaved(false);
          }}
          className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-border-strong"
        />
      </label>
      <label className="mt-3 flex flex-col gap-1.5">
        <span className="text-sm text-muted">メールテンプレート</span>
        <input
          value={settings.emailTemplate}
          maxLength={320}
          aria-label="メールテンプレート"
          onChange={(event) => {
            setSettings((current) => ({ ...current, emailTemplate: event.target.value }));
            setSaved(false);
          }}
          className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none focus:border-border-strong"
        />
      </label>
      <p className="mt-3 text-xs text-muted">
        既定の作者表記: <code aria-label="コミット作者プレビュー">{preview.name} &lt;{preview.email}&gt;</code>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={loading || saving} onClick={() => void save(settings)}>
          {saving ? "保存中…" : "保存"}
        </Button>
        <Button variant="ghost" size="sm" disabled={loading || saving} onClick={() => void reset()}>
          既定に戻す
        </Button>
        {saved && <span role="status" className="text-xs text-muted">保存しました</span>}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
