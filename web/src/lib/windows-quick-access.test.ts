import { describe, expect, it } from "vitest";
import { parseWindowsQuickAccess } from "@/lib/windows-quick-access";

describe("parseWindowsQuickAccess", () => {
  it("accepts PowerShell JSON for both one and many shell items", () => {
    expect(
      parseWindowsQuickAccess(JSON.stringify({ name: "Desktop", path: "C:\\Users\\Daichi\\Desktop" })),
    ).toEqual([{ name: "Desktop", path: "C:\\Users\\Daichi\\Desktop" }]);
    expect(
      parseWindowsQuickAccess(
        JSON.stringify([
          { name: "AI", path: "C:\\Users\\Daichi\\OneDrive\\AI" },
          { name: "Download", path: "G:\\Download" },
        ]),
      ),
    ).toEqual([
      { name: "AI", path: "C:\\Users\\Daichi\\OneDrive\\AI" },
      { name: "Download", path: "G:\\Download" },
    ]);
  });

  it("ignores malformed and virtual shell items", () => {
    expect(parseWindowsQuickAccess("not json")).toEqual([]);
    expect(
      parseWindowsQuickAccess(
        JSON.stringify([
          { name: "", path: "C:\\Users\\Daichi" },
          { name: "relative", path: "projects" },
          { name: "virtual", path: "shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}" },
        ]),
      ),
    ).toEqual([]);
  });
});
