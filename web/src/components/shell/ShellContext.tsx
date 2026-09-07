"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type ShellContextValue = {
  mobileNavOpen: boolean;
  openMobileNav: () => void;
  closeMobileNav: () => void;
};

const ShellContext = createContext<ShellContextValue | null>(null);

export function ShellProvider({ children }: { children: ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // モバイルナビが開いている間、背景のスクロールとタップを防ぐ
  useEffect(() => {
    if (!mobileNavOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onTouchMove = (event: TouchEvent) => {
      const drawer = document.querySelector("[data-mobile-drawer]");
      if (drawer?.contains(event.target as Node)) return; // ドロワー内のスクロールは許可
      event.preventDefault();
    };
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileNavOpen]);

  const value = useMemo(
    () => ({
      mobileNavOpen,
      openMobileNav: () => setMobileNavOpen(true),
      closeMobileNav: () => setMobileNavOpen(false),
    }),
    [mobileNavOpen],
  );
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useOptionalShellMobileNav() {
  return useContext(ShellContext);
}

export function useShellMobileNav() {
  const value = useOptionalShellMobileNav();
  if (!value) throw new Error("ShellProvider is required");
  return value;
}
