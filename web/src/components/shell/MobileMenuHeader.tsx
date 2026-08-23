"use client";

import { Menu } from "lucide-react";
import Image from "next/image";
import { useShellMobileNav } from "./ShellContext";

export function MobileMenuButton() {
  const { openMobileNav } = useShellMobileNav();
  return (
    <button
      type="button"
      aria-label="メニュー"
      onClick={openMobileNav}
      className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 md:hidden"
    >
      <Menu className="h-5 w-5" />
    </button>
  );
}

export function MobileMenuHeader() {
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2 pb-2 md:hidden"
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
    >
      <MobileMenuButton />
      <Image src="/icon.svg" alt="" width={20} height={20} className="h-5 w-5 rounded-[4px]" />
      <span className="text-sm font-semibold">LeafCodePi</span>
    </div>
  );
}
