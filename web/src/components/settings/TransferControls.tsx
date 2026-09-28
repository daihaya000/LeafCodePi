"use client";

import type { ReactNode } from "react";
import { ChevronRight, Download, Loader2, Upload } from "lucide-react";
import { Button, cx } from "@/components/ui";

/**
 * 設定・認証・プロンプトの各エクスポートカードで共通の「エクスポート／インポート」行。
 * インポートはファイル選択を開き、選ばれたファイルを onFile へ渡す。
 */
export function TransferActions({
  accept,
  fileLabel,
  disabled,
  exportBusy = false,
  importBusy = false,
  onExport,
  onFile,
  className,
}: {
  accept: string;
  /** ファイル選択 input のアクセシブル名。 */
  fileLabel: string;
  disabled: boolean;
  exportBusy?: boolean;
  importBusy?: boolean;
  onExport: () => void;
  onFile: (file: File) => void;
  /** 全幅カードでボタンが伸びすぎないよう最大幅を渡す。 */
  className?: string;
}) {
  return (
    <div className={cx("grid grid-cols-2 gap-2", className)}>
      <Button className="w-full" variant="secondary" busy={exportBusy} disabled={disabled} onClick={onExport}>
        <Download className="h-4 w-4" />エクスポート
      </Button>
      <label
        aria-busy={importBusy || undefined}
        className={cx(
          "inline-flex h-10 w-full cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-border bg-surface-2 px-3.5 text-sm text-text transition-colors hover:bg-surface-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent",
          disabled && "pointer-events-none opacity-40",
        )}
      >
        {importBusy && <Loader2 className="h-4 w-4 animate-spin" />}
        <Upload className="h-4 w-4" />インポート
        <input
          type="file"
          accept={accept}
          className="sr-only"
          aria-label={fileLabel}
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // 同じファイルを選び直しても change が発火するよう、受け取った直後に空へ戻す。
            event.currentTarget.value = "";
            if (file) onFile(file);
          }}
        />
      </label>
    </div>
  );
}

/** 初期化・保全ファイルなど、普段は使わない操作を畳んでおく枠。 */
export function SettingsDisclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group/disclosure rounded-lg border border-border bg-surface-2 px-3">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted transition-transform group-open/disclosure:rotate-90" aria-hidden="true" />
        {title}
      </summary>
      <div className="space-y-2 pb-3">{children}</div>
    </details>
  );
}
