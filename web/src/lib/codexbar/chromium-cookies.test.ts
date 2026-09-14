import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LINUX_SAFE_STORAGE_PASSWORD,
  decryptChromiumSafeStorageCookie,
  deriveChromiumSafeStorageKey,
  lookupLinuxSafeStoragePasswordSync,
} from "../../../../extensions/leafcode-web-access/chromium-cookie-crypto.ts";
import {
  listChromiumBrowserRoots,
  readChromiumCookiesFromProfile,
} from "./chromium-cookies";
import { extractOpenCodeCookieHeader } from "./browser-cookies";

function encryptLinuxCookie(plaintext: string, password = DEFAULT_LINUX_SAFE_STORAGE_PASSWORD): Buffer {
  const key = pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), encrypted]);
}

describe("Linux Chromium Safe Storage crypto", () => {
  it("round-trips AES-128-CBC with the peanuts key (no real cookie bytes)", () => {
    const key = deriveChromiumSafeStorageKey(DEFAULT_LINUX_SAFE_STORAGE_PASSWORD, "linux");
    const encrypted = encryptLinuxCookie("opencode-session");
    expect(decryptChromiumSafeStorageCookie(encrypted, key, false)).toBe("opencode-session");
  });

  it("strips the Chrome meta v24 hash prefix", () => {
    const key = deriveChromiumSafeStorageKey(DEFAULT_LINUX_SAFE_STORAGE_PASSWORD, "linux");
    const hashed = `${"h".repeat(32)}real-value`;
    const encrypted = encryptLinuxCookie(hashed);
    expect(decryptChromiumSafeStorageCookie(encrypted, key, true)).toBe("real-value");
  });

  it("falls back to peanuts when secret-tool is missing", () => {
    const result = lookupLinuxSafeStoragePasswordSync("chrome", () => {
      throw new Error("ENOENT");
    });
    expect(result).toEqual({
      password: DEFAULT_LINUX_SAFE_STORAGE_PASSWORD,
      cacheable: false,
    });
  });

  it("uses secret-tool output when lookup succeeds", () => {
    expect(lookupLinuxSafeStoragePasswordSync("chrome", () => "custom-pass")).toEqual({
      password: "custom-pass",
      cacheable: true,
    });
  });
});

describe("listChromiumBrowserRoots", () => {
  it("uses XDG Chromium paths on Linux, not AppData", () => {
    const home = "/home/linux-user";
    const roots = listChromiumBrowserRoots("linux", home, {});
    expect(roots.map((r) => r.userData)).toEqual([
      join(home, ".config/chromium"),
      join(home, ".config/google-chrome"),
      join(home, ".config/BraveSoftware/Brave-Browser"),
      join(home, ".config/microsoft-edge"),
    ]);
    expect(roots.every((r) => !r.userData.includes("AppData"))).toBe(true);
    expect(roots.find((r) => r.name === "Chrome")?.secretToolApp).toBe("chrome");
  });

  it("keeps Windows Local AppData Chrome/Edge roots", () => {
    const roots = listChromiumBrowserRoots("win32", "C:\\Users\\sam", {
      LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local",
    });
    expect(roots.map((r) => r.name)).toEqual(["Chrome", "Edge"]);
    expect(roots[0]?.userData.replaceAll("/", "\\")).toContain("Google\\Chrome\\User Data");
    expect(roots.every((r) => r.secretToolApp === undefined)).toBe(true);
  });

  it("does not invent browser roots on macOS (Netscape fallback)", () => {
    expect(listChromiumBrowserRoots("darwin", homedir(), {})).toEqual([]);
  });
});

describe("readChromiumCookiesFromProfile", () => {
  it("returns empty when the profile has no Cookies database", () => {
    expect(
      readChromiumCookiesFromProfile("/tmp/leafcode-missing-chrome-profile", () => true, {
        platform: "linux",
      }),
    ).toEqual([]);
  });
});

describe("OpenCode Chromium fallback still yields to Netscape", () => {
  it("extractOpenCodeCookieHeader remains null without netscape or browser cookies", () => {
    expect(extractOpenCodeCookieHeader({ authPath: "/tmp/missing-opencode-auth.json" })).toBeNull();
  });
});
