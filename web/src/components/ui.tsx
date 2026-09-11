"use client";

import React, {
  ButtonHTMLAttributes,
  Children,
  ReactNode,
  SelectHTMLAttributes,
  forwardRef,
  isValidElement,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { useTheme } from "next-themes";
import { Check, ChevronDown, Loader2, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export { cx };

const FOCUSABLE_CONTROL_SELECTOR = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(",");

function focusableControls(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_CONTROL_SELECTOR)).filter(
    (element) => {
      if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    },
  );
}

export function focusAdjacentControl(
  anchor: HTMLElement | null,
  direction: -1 | 1,
  excludedRoot?: HTMLElement | null,
) {
  if (!anchor) return;
  const controls = focusableControls().filter(
    (control) => !excludedRoot?.contains(control),
  );
  const anchorIndex = controls.indexOf(anchor);
  controls[anchorIndex + direction]?.focus();
}

export function GhostSelect({
  icon,
  valueLabel,
  action,
  tone = "default",
  className,
  disabled,
  children,
  value,
  onChange,
  title,
  "aria-label": ariaLabel,
}: Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "className" | "disabled" | "onChange"
> & {
  icon: ReactNode;
  valueLabel: ReactNode;
  action?: ReactNode;
  tone?: "default" | "warning" | "danger";
  className?: string;
  disabled?: boolean;
  value: string;
  onChange: (value: string) => void;
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
  const groupedOptions = useMemo(() => {
    const groups: {
      label?: ReactNode;
      options: { value: string; label: ReactNode; disabled: boolean; title?: string }[];
    }[] = [];

    const readOption = (child: React.ReactElement) => {
      const props = child.props as {
        value?: string;
        children?: ReactNode;
        disabled?: boolean;
        title?: string;
      };
      return {
        value: props.value ?? "",
        label: props.children,
        disabled: props.disabled === true,
        title: props.title,
      };
    };

    Children.forEach(children, (child) => {
      if (!isValidElement(child)) return;
      if (child.type === "option") {
        groups.push({ options: [readOption(child)] });
        return;
      }
      if (child.type !== "optgroup") return;

      const props = child.props as { label?: ReactNode; children?: ReactNode };
      const options = Children.toArray(props.children).flatMap((option) =>
        isValidElement(option) && option.type === "option" ? [readOption(option)] : [],
      );
      groups.push({ label: props.label, options });
    });

    return groups;
  }, [children]);

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
  }, [open, groupedOptions, updateMenuPosition]);

  useLayoutEffect(() => {
    if (!open) return;
    const optionButtons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [],
    );
    const selectedOption = optionButtons.find(
      (option) => option.getAttribute("aria-selected") === "true",
    );
    const fallback = initialFocusRef.current === "last"
      ? optionButtons.at(-1)
      : optionButtons[0];
    (selectedOption ?? fallback)?.focus();
    initialFocusRef.current = "selected";
  }, [open, groupedOptions, value]);

  const handleListboxKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const optionButtons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'),
    );
    if (event.key === "Tab") {
      event.preventDefault();
      if (!event.shiftKey) {
        const actionContainer = menuRef.current?.querySelector<HTMLElement>(
          "[data-ghost-select-action]",
        );
        const firstAction = actionContainer ? focusableControls(actionContainer)[0] : undefined;
        if (firstAction) {
          firstAction.focus();
          return;
        }
      }
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

  const handleActionKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const actionControls = focusableControls(event.currentTarget);
    const eventTarget = event.target as HTMLElement;
    const currentIndex = actionControls.findIndex(
      (control) => control === eventTarget || control.contains(eventTarget),
    );
    if (event.shiftKey && currentIndex <= 0) {
      event.preventDefault();
      const optionButtons = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="option"]:not(:disabled)',
        ) ?? [],
      );
      optionButtons.at(-1)?.focus();
      return;
    }
    if (!event.shiftKey && currentIndex >= actionControls.length - 1) {
      event.preventDefault();
      setOpen(false);
      focusAdjacentControl(triggerRef.current, 1, menuRef.current);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    updateMenuPosition();

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }

    function onFocusIn(event: FocusEvent) {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
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

  const menu = open && !disabled && (
    <div
      ref={menuRef}
      className="fixed z-50 w-max max-w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-border bg-surface text-xs shadow-xl"
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
        aria-label={ariaLabel}
        onKeyDown={handleListboxKeyDown}
        className="max-h-80 overflow-y-auto p-1"
      >
        {groupedOptions.map((group, groupIndex) => (
          <div key={groupIndex}>
            {group.label && (
              <div className="px-2 py-1 text-[11px] font-semibold text-faint">
                {group.label}
              </div>
            )}
            {group.options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                tabIndex={-1}
                disabled={option.disabled}
                title={option.title}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                className={cx(
                  "flex w-full appearance-none items-center gap-2 rounded-lg border-0 bg-transparent px-2 py-1.5 text-left text-muted hover:bg-surface-2 hover:text-text focus:bg-surface-2 focus:text-text focus:outline-none disabled:cursor-not-allowed disabled:opacity-40",
                  option.value === value && "bg-surface-2 text-text",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.value === value && (
                  <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-primary" />
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
      {action && (
        <div
          data-ghost-select-action
          onKeyDown={handleActionKeyDown}
          className="border-t border-border p-1"
        >
          {action}
        </div>
      )}
    </div>
  );

  return (
    <div ref={rootRef} className={cx("relative inline-flex min-w-0", className)}>
      <button
        ref={triggerRef}
        type="button"
        value={value}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        title={title}
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
          "group inline-flex h-full w-full min-w-0 items-center gap-1.5 rounded-lg border bg-bg px-2 py-1.5 text-xs font-medium shadow-sm transition-colors",
          tone === "warning"
            ? "border-warning/40 text-warning hover:bg-warning-bg"
            : tone === "danger"
              ? "border-danger/40 text-danger hover:bg-danger-bg"
              : "border-border text-muted hover:bg-surface-2 hover:text-text",
          disabled && "cursor-not-allowed opacity-40",
        )}
      >
        <span aria-hidden="true" className="shrink-0">{icon}</span>
        <span aria-hidden="true" className="min-w-0 truncate">{valueLabel}</span>
        <span aria-hidden="true" className="shrink-0 text-faint">
          <ChevronDown className="h-3.5 w-3.5" />
        </span>
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type ButtonSize = "sm" | "md" | "lg" | "icon";

const variantClass: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-fg hover:opacity-90 disabled:opacity-40 font-medium",
  secondary: "bg-surface-2 text-text hover:bg-surface-3 disabled:opacity-40 border border-border",
  outline: "bg-transparent text-text hover:bg-surface-2 disabled:opacity-40 border border-border-strong",
  ghost: "bg-transparent text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40",
  danger: "bg-danger-bg text-danger hover:opacity-80 disabled:opacity-40 border border-danger/30",
};

const sizeClass: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-xs rounded-lg gap-1.5",
  md: "h-10 px-3.5 text-sm rounded-lg gap-2",
  lg: "h-12 px-5 text-sm rounded-xl gap-2",
  icon: "h-9 w-9 rounded-lg justify-center",
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    busy?: boolean;
  }
>(function Button(
  { variant = "secondary", size = "md", busy, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex shrink-0 cursor-pointer items-center justify-center transition-colors select-none disabled:cursor-not-allowed",
        variantClass[variant],
        sizeClass[size],
        className,
      )}
      {...rest}
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
});

/**
 * 共有ON/OFFトグル。視覚トラックは24x44pxで固定し、タッチ領域はモバイル全44x44px、
 * `sm`以上ではトラックと同じ大きさに戻す。ONは`success`、focus-visibleは
 * 個別指定をせず`globals.css`の共通`outline: accent`へ委ねる。
 */
export function Switch({
  checked,
  onChange,
  label,
  busy,
  disabled,
  title,
  className,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  busy?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const isDisabled = Boolean(busy || disabled);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={isDisabled}
      onClick={onChange}
      className={cx(
        "inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full disabled:cursor-not-allowed sm:h-6 sm:w-11",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          "relative h-6 w-11 rounded-full transition-colors",
          checked ? "bg-success" : "bg-surface-3",
          isDisabled && "opacity-40",
        )}
      >
        <span
          className={cx(
            "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-surface shadow transition-transform",
            checked && "translate-x-5",
          )}
        />
      </span>
    </button>
  );
}

export function Badge({
  tone = "neutral",
  children,
  pulse,
  className,
}: {
  tone?: "neutral" | "working" | "success" | "warning" | "danger";
  pulse?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-surface-2 text-muted border-border",
    working: "bg-working-bg text-working border-working/25",
    success: "bg-success-bg text-success border-success/25",
    warning: "bg-warning-bg text-warning border-warning/25",
    danger: "bg-danger-bg text-danger border-danger/25",
  };
  const dotColor: Record<string, string> = {
    neutral: "bg-faint",
    working: "bg-working",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
  };
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      <span className={cx("h-1.5 w-1.5 rounded-full", dotColor[tone], pulse && "status-pulse")} />
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("h-4 w-4 animate-spin text-muted", className)} />;
}

export function DiffStat({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span className={cx("inline-flex items-center gap-1.5 font-mono text-xs", className)}>
      <span className="text-success">+{additions}</span>
      <span className="text-danger">−{deletions}</span>
    </span>
  );
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="h-9 w-9" />;
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="テーマ切替"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      {resolvedTheme === "dark" ? <Sun className="h-4.5 w-4.5" /> : <Moon className="h-4.5 w-4.5" />}
    </Button>
  );
}

export function formatMessageTime(iso: string | number | null | undefined): string {
  if (!iso) return "";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const date = new Date(t);
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()}${weekdays[date.getDay()]} ${hours}:${minutes}`;
}

/** 所要時間の表示（Code/Bot のツール実行グループやタスク統計で共有）。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function timeAgo(iso: string | number | null | undefined): string {
  if (!iso) return "";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 60) return "たった今";
  if (sec < 3600) return `${Math.floor(sec / 60)}分前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間前`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}日前`;
  return new Date(t).toLocaleDateString();
}
