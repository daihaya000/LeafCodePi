import { describe, expect, it } from "vitest";
import { buildQuickAccessEntries, userFolderCandidates } from "./browse-quick-access";

describe("userFolderCandidates", () => {
  it("keeps Windows candidates as English home + OneDrive twins", () => {
    const folders = userFolderCandidates({
      home: "C:\\Users\\me",
      cloudRoot: "C:\\Users\\me\\OneDrive",
      platform: "win32",
    });
    expect(folders.find((item) => item.kind === "desktop")?.folders).toEqual([
      "C:\\Users\\me\\Desktop",
      "C:\\Users\\me\\OneDrive\\Desktop",
    ]);
    expect(folders.find((item) => item.kind === "downloads")?.folders).toEqual([
      "C:\\Users\\me\\Downloads",
    ]);
  });

  it("prefers XDG and localized names on Linux", () => {
    const folders = userFolderCandidates({
      home: "/home/me",
      xdg: { desktop: "/home/me/デスクトップ", downloads: "/mnt/data/Downloads" },
      platform: "linux",
    });
    expect(folders.find((item) => item.kind === "desktop")?.folders).toEqual([
      "/home/me/デスクトップ",
      "/home/me/Desktop",
      "/home/me/デスクトップ",
    ]);
    expect(folders.find((item) => item.kind === "downloads")?.folders[0]).toBe("/mnt/data/Downloads");
    expect(folders.find((item) => item.kind === "documents")?.folders).toContain("/home/me/ドキュメント");
  });
});

describe("buildQuickAccessEntries", () => {
  it("exposes home plus existing Linux user folders, not missing ones", () => {
    const existing = new Set(["/home/me", "/home/me/デスクトップ", "/home/me/Downloads"]);
    const entries = buildQuickAccessEntries({
      home: "/home/me",
      xdg: { desktop: "/home/me/デスクトップ" },
      platform: "linux",
      isDirectory: (path) => existing.has(path),
      resolvePath: (path) => path,
    });
    expect(entries.map((entry) => entry.kind)).toEqual(["home", "desktop", "downloads"]);
    expect(entries.find((entry) => entry.kind === "desktop")?.path).toBe("/home/me/デスクトップ");
    expect(entries.find((entry) => entry.kind === "documents")).toBeUndefined();
  });

  it("still appends Windows Quick Access pins after the static shortcuts", () => {
    const existing = new Set(["C:\\Users\\me", "C:\\Users\\me\\Desktop", "D:\\pins\\work"]);
    const entries = buildQuickAccessEntries({
      home: "C:\\Users\\me",
      platform: "win32",
      windowsEntries: [{ name: "Work", path: "D:\\pins\\work" }],
      isDirectory: (path) => existing.has(path),
      resolvePath: (path) => path,
    });
    expect(entries.map((entry) => ({ name: entry.name, kind: entry.kind }))).toEqual([
      { name: "ホーム", kind: "home" },
      { name: "デスクトップ", kind: "desktop" },
      { name: "Work", kind: undefined },
    ]);
  });
});
