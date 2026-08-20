"use client";

import { useState } from "react";
import { Cpu } from "lucide-react";
import { providerIconSrc } from "@/lib/provider-icons";
import { cx } from "@/components/ui";

/**
 * Brand icon for a provider id (e.g. anthropic, openai-codex, cursor).
 * Falls back to a generic CPU glyph when no bundled icon matches.
 */
export function ProviderIcon({
  providerID,
  className,
  size = 14,
}: {
  providerID?: string;
  className?: string;
  size?: number;
}) {
  const src = providerIconSrc(providerID ?? "");
  const [broken, setBroken] = useState(false);

  if (src && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className={cx("shrink-0 rounded-[3px] object-contain", className)}
        style={{ width: size, height: size }}
        onError={() => setBroken(true)}
      />
    );
  }

  return (
    <Cpu
      aria-hidden="true"
      data-testid="provider-icon-fallback"
      className={cx("shrink-0", className)}
      style={{ width: size, height: size }}
    />
  );
}
