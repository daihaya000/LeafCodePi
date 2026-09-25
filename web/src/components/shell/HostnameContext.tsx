"use client";

import { createContext, useContext, type ReactNode } from "react";
import { cx } from "@/components/ui";

const HostnameContext = createContext("");

export function HostnameProvider({ hostname, children }: { hostname: string; children: ReactNode }) {
  return <HostnameContext.Provider value={hostname}>{children}</HostnameContext.Provider>;
}

/** Gray badge matching the SessionLabelBadge placeholder style. */
export function HostnameLabel({ className }: { className?: string }) {
  const hostname = useContext(HostnameContext);
  if (!hostname) return null;
  return (
    <span
      title={hostname}
      className={cx(
        "inline-block max-w-full shrink-0 truncate whitespace-nowrap rounded border border-border bg-surface-2 px-[3px] text-[9px] leading-[14px] text-muted",
        className,
      )}
    >
      {hostname}
    </span>
  );
}
