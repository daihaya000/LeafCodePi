"use client";

import { createContext, useContext, type ReactNode } from "react";

const HostnameContext = createContext("");

export function HostnameProvider({ hostname, children }: { hostname: string; children: ReactNode }) {
  return <HostnameContext.Provider value={hostname}>{children}</HostnameContext.Provider>;
}

export function HostnameLabel({ className }: { className?: string }) {
  const hostname = useContext(HostnameContext);
  if (!hostname) return null;
  return <span className={className} title={hostname}>{hostname}</span>;
}
