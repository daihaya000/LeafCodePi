"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ImageIcon } from "lucide-react";
import { ProviderIcon } from "@/components/ProviderIcon";
import { cx, focusAdjacentControl } from "@/components/ui";
import { providerLabel, usageTone } from "@/lib/codexbar";
import type { ModelOption } from "@/lib/types";

export function modelSupportsImage(option: ModelOption | undefined): boolean {
  return Boolean(option?.input?.includes("image"));
}

/** Match a stored logical model to an integrated option without choosing another account. */
export function modelOptionForValue(
  options: readonly ModelOption[],
  value: string | null | undefined,
): ModelOption | undefined {
  if (!value) return undefined;
  const exact = options.find((option) => option.value === value);
  if (exact) return exact;
  return options.find(
    (option) =>
      option.routingMode === "integrated" &&
      (value === `${option.providerID}::${option.modelID}` ||
        value.endsWith(`::${option.providerID}::${option.modelID}`)),
  );
}

function modelUsageTone(option: ModelOption | undefined) {
  if (!option) return null;
  const hasIntegratedPercent =
    option.routingMode === "integrated" &&
    option.codexbarIntegratedUsedPercent !== undefined;
  return usageTone({
    usedPercent: hasIntegratedPercent
      ? option.codexbarIntegratedUsedPercent!
      : option.codexbarUsedPercent ?? null,
    limited: hasIntegratedPercent ? false : option.codexbarLimited === true,
    maxed: hasIntegratedPercent ? false : option.codexbarMaxed === true,
    error: null,
    windows: [],
    credits: null,
  });
}

/** Provider rate limit is close (>=75%): render the option in orange. */
export function modelNearLimit(option: ModelOption | undefined): boolean {
  return modelUsageTone(option) === "warn";
}

/** Provider hit its limit (100%): render the option in red (still selectable). */
export function modelLimitReached(option: ModelOption | undefined): boolean {
  return modelUsageTone(option) === "danger";
}

/** モデルドロップダウンのグループ見出し（プロバイダ × アカウント）。 */
function groupHeader(option: ModelOption): string {
  const providerName = providerLabel(option.providerID);
  return option.accountLabel ? `${providerName} · ${option.accountLabel}` : providerName;
}

export function ModelSelect({
  value,
  options,
  disabled,
  loading = false,
  onChange,
  className,
  title,
  ariaLabel,
  emptyLabel = "モデルなし",
}: {
  value: string;
  options: ModelOption[];
  disabled?: boolean;
  loading?: boolean;
  onChange: (value: string) => void;
  className?: string;
  title?: string;
  ariaLabel?: string;
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
    minWidth: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const initialFocusRef = useRef<"selected" | "first" | "last">("selected");
  const listboxId = useId();

  // exact 照合だけでは integrated / 旧アカウント接頭辞の値が「モデル」空表示になる。
  const selected = modelOptionForValue(options, value);
  const selectedSupportsImage = modelSupportsImage(selected);

  // アカウント指定があれば「プロバイダ × アカウント」で枠を分ける。
  const grouped = useMemo(() => {
    const order: { key: string; header: string; options: ModelOption[] }[] = [];
    const index = new Map<string, number>();
    for (const option of options) {
      const key = `${option.providerID}::${option.accountId ?? ""}`;
      let team = index.get(key);
      if (team === undefined) {
        team = order.length;
        index.set(key, team);
        order.push({ key, header: groupHeader(option), options: [] });
      }
      order[team].options.push(option);
    }
    return order;
  }, [options]);

  const chooseOption = useCallback(
    (option: ModelOption) => {
      onChange(option.value);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [onChange],
  );

  const updateMenuPosition = useCallback(() => {
    const root = rootRef.current;
    if (!root || typeof window === "undefined") return;
    const rect = root.getBoundingClientRect();
    const menuRect = menuRef.current?.getBoundingClientRect();
    const viewportPadding = 16;
    const gap = 4;
    const maxMenuWidth = window.innerWidth - viewportPadding * 2;
    const menuWidth = Math.min(
      Math.max(menuRect?.width || Math.max(rect.width, 224), rect.width),
      maxMenuWidth,
    );
    const menuHeight = Math.min(
      menuRect?.height || 320,
      window.innerHeight - viewportPadding * 2,
    );
    const topAbove = rect.top - menuHeight - gap;
    const topBelow = rect.bottom + gap;
    const top =
      topAbove >= viewportPadding
        ? topAbove
        : Math.min(topBelow, window.innerHeight - viewportPadding - menuHeight);
    setMenuPosition({
      top: Math.max(viewportPadding, top),
      left: Math.max(
        viewportPadding,
        Math.min(
          rect.right - menuWidth,
          window.innerWidth - viewportPadding - menuWidth,
        ),
      ),
      minWidth: Math.min(rect.width, maxMenuWidth),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updateMenuPosition();
  }, [open, grouped, updateMenuPosition]);

  useLayoutEffect(() => {
    if (!open) return;
    const optionButtons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
    );
    const selectedOption = optionButtons.find(
      (option) => option.getAttribute("aria-selected") === "true",
    );
    const fallback = initialFocusRef.current === "last"
      ? optionButtons.at(-1)
      : optionButtons[0];
    (selectedOption ?? fallback)?.focus();
    initialFocusRef.current = "selected";
  }, [open, grouped, value]);

  const handleListboxKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const optionButtons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    );
    if (event.key === "Tab") {
      event.preventDefault();
      setOpen(false);
      focusAdjacentControl(triggerRef.current, event.shiftKey ? -1 : 1, menuRef.current);
      return;
    }
    if (optionButtons.length === 0) return;
    const current = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="option"]');

    if (event.key === "Enter" || event.key === " ") {
      if (!current) return;
      event.preventDefault();
      current.click();
      return;
    }

    const currentIndex = current ? optionButtons.indexOf(current) : -1;
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % optionButtons.length;
    if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + optionButtons.length) % optionButtons.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = optionButtons.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    optionButtons[nextIndex]?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    updateMenuPosition();

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    }

    function onFocusIn(event: FocusEvent) {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, updateMenuPosition]);

  const isDisabled = disabled || loading || options.length === 0;
  const emptyStateLabel = loading
    ? "モデルを読み込み中…"
    : options.length === 0
      ? emptyLabel
      : "モデル";
  const selectedNearLimit = !isDisabled && modelNearLimit(selected);
  const selectedMaxed = !isDisabled && modelLimitReached(selected);

  const menu = open && !isDisabled && (
    <div
      ref={menuRef}
      className="fixed z-50 w-max max-w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-surface text-xs shadow-xl"
      style={{
        top: menuPosition?.top ?? 0,
        left: menuPosition?.left ?? 0,
        minWidth: menuPosition?.minWidth,
        visibility: menuPosition ? undefined : "hidden",
      }}
    >
      <div
        id={listboxId}
        role="listbox"
        aria-label={ariaLabel ?? "モデル"}
        onKeyDown={handleListboxKeyDown}
        className="max-h-[min(20rem,calc(100dvh-2rem))] overflow-y-auto p-1"
      >
        {grouped.map((group) => (
          <div key={group.key}>
            <div className="min-w-0 truncate px-2 py-1 text-[11px] font-semibold text-faint" title={group.header}>
              {group.header}
            </div>
            {group.options.map((option) => {
              const image = modelSupportsImage(option);
              const maxed = modelLimitReached(option);
              const nearLimit = modelNearLimit(option);
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  tabIndex={-1}
                  title={option.label}
                  onClick={() => chooseOption(option)}
                  className={cx(
                    "flex w-full appearance-none items-center gap-2 rounded-lg border-0 bg-transparent px-2 py-1.5 text-left hover:bg-surface-2 focus:bg-surface-2 focus:outline-none",
                    maxed
                      ? "text-danger hover:text-danger focus:text-danger"
                      : nearLimit
                        ? "text-warning hover:text-warning focus:text-warning"
                        : "text-muted hover:text-text focus:text-text",
                    option.value === value && "bg-surface-2",
                  )}
                >
                  <ProviderIcon providerID={option.providerID} size={14} />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {image && (
                    <span title="画像入力対応" className="inline-flex shrink-0">
                      <ImageIcon
                        aria-label="画像入力対応"
                        className="h-3.5 w-3.5 text-primary"
                      />
                    </span>
                  )}
                  {option.value === value && (
                    <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-primary" />
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className={cx("relative inline-flex shrink-0", className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={isDisabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-busy={loading || undefined}
        aria-label={ariaLabel ?? "モデル"}
        title={title ?? selected?.label ?? (loading ? "モデルを読み込み中…" : emptyStateLabel)}
        onClick={() => {
          initialFocusRef.current = "selected";
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          initialFocusRef.current = event.key === "ArrowUp" ? "last" : "first";
          setOpen(true);
        }}
        className={cx(
          "group inline-flex h-full w-full min-w-24 items-center gap-1.5 rounded-lg border border-border bg-bg px-2 py-1.5 text-xs font-medium text-muted shadow-sm transition-colors hover:bg-surface-2 hover:text-text",
          isDisabled && "cursor-not-allowed opacity-40",
        )}
      >
        <ProviderIcon providerID={selected?.providerID} size={14} />
        <span
          className={cx(
            "min-w-0 flex-1 truncate text-left",
            selectedNearLimit && "text-warning",
            selectedMaxed && "text-danger",
          )}
        >
          {selected?.label ?? (loading ? "モデルを読み込み中…" : emptyStateLabel)}
        </span>
        {selectedSupportsImage && (
          <span title="画像入力対応" className="inline-flex shrink-0">
            <ImageIcon
              aria-label="画像入力対応"
              className="h-3.5 w-3.5 text-primary"
            />
          </span>
        )}
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden="true" />
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
