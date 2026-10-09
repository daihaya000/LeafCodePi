import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LINUX_SAFE_STORAGE_PASSWORD,
  decryptChromiumSafeStorageCookie,
  deriveChromiumSafeStorageKey,
  lookupLinuxSafeStoragePassword,
  lookupLinuxSafeStoragePasswordSync,
} from "./chromium-cookie-crypto";
import {
  decryptChromeCookie,
  listChromiumBrowserRoots,
  readChromiumCookiesFromProfile,
} from "./chromium-cookies";
import { extractOpenCodeCookieHeader } from "./browser-cookies";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Drop the leading block comment so the two "Must match" headers can differ. */
function bodyAfterHeader(source: string): string {
  return source.replace(/^\/\*[\s\S]*?\*\/\s*/, "");
}

function encryptLinuxCookie(plaintext: string, password = DEFAULT_LINUX_SAFE_STORAGE_PASSWORD): Buffer {
  const key = pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), encrypted]);
}

describe("chromium-cookie-crypto parity with leafcode-web-access", () => {
  it("keeps the same implementation body as the extension copy", () => {
    const webCopy = readFileSync(join(HERE, "..", "..", "..", "..", "backend", "runtime-src", "lib", "codexbar", "chromium-cookie-crypto.ts"), "utf8");
    const extensionCopy = readFileSync(
      join(HERE, "..", "..", "..", "..", "extensions", "leafcode-web-access", "chromium-cookie-crypto.ts"),
      "utf8",
    );
    expect(bodyAfterHeader(webCopy)).toBe(bodyAfterHeader(extensionCopy));
  });
});

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

  it("falls back to peanuts without retrying when secret-tool is unavailable", () => {
    let calls = 0;
    const result = lookupLinuxSafeStoragePasswordSync("chrome", () => {
      calls += 1;
      throw new Error("ENOENT");
    });
    expect(result).toEqual({
      password: DEFAULT_LINUX_SAFE_STORAGE_PASSWORD,
      cacheable: false,
    });
    expect(calls).toBe(1);
  });

  it("uses secret-tool output when lookup succeeds", () => {
    expect(lookupLinuxSafeStoragePasswordSync("chrome", () => "custom-pass")).toEqual({
      password: "custom-pass",
      cacheable: true,
    });
  });

  it("finds app-less legacy Chromium secrets by their v1 schema", () => {
    const queries: Array<[string, string]> = [];
    const result = lookupLinuxSafeStoragePasswordSync("chrome", (attribute, value) => {
      queries.push([attribute, value]);
      if (attribute === "application") {
        throw Object.assign(new Error("no match"), { status: 1, stderr: Buffer.alloc(0) });
      }
      return "legacy-pass";
    });

    expect(result).toEqual({ password: "legacy-pass", cacheable: true });
    expect(queries).toEqual([
      ["application", "chrome"],
      ["xdg:schema", "chrome_libsecret_os_crypt_password"],
    ]);
  });

  it("uses the same legacy schema fallback in the async extension path", async () => {
    const queries: Array<[string, string]> = [];
    const result = await lookupLinuxSafeStoragePassword("chromium", async (attribute, value) => {
      queries.push([attribute, value]);
      return attribute === "xdg:schema" ? "legacy-pass" : null;
    });

    expect(result).toEqual({ password: "legacy-pass", cacheable: true });
    expect(queries).toEqual([
      ["application", "chromium"],
      ["xdg:schema", "chrome_libsecret_os_crypt_password"],
    ]);
  });
});

describe("listChromiumBrowserRoots", () => {
  it("uses XDG Chromium paths on Linux, not AppData", () => {
    const home = "/home/linux-user";
    const roots = listChromiumBrowserRoots("linux", home, {});
    expect(roots.map((r) => r.userData)).toEqual([
      join(home, ".config/chromium"),
      join(home, ".var/app/org.chromium.Chromium/config/chromium"),
      join(home, ".config/google-chrome"),
      join(home, ".config/BraveSoftware/Brave-Browser"),
      join(home, ".config/microsoft-edge"),
      join(home, "snap/chromium/common/chromium"),
    ]);
    expect(roots.every((r) => !r.userData.includes("AppData"))).toBe(true);
    expect(roots.find((r) => r.name === "Chrome")?.secretToolApp).toBe("chrome");
  });

  it("uses XDG_CONFIG_HOME for Linux Chromium roots", () => {
    // join() so the expectation matches the host separator, like the test above.
    const config = "/run/user/1000/config";
    const roots = listChromiumBrowserRoots("linux", "/home/linux-user", {
      XDG_CONFIG_HOME: config,
    });
    expect(roots.slice(0, 1).map((r) => r.userData)).toEqual([
      join(config, "chromium"),
    ]);
    expect(roots.slice(2, 5).map((r) => r.userData)).toEqual([
      join(config, "google-chrome"),
      join(config, "BraveSoftware/Brave-Browser"),
      join(config, "microsoft-edge"),
    ]);
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

describe("Windows Chromium App-Bound cookies", () => {
  it("does not send v20 payloads to the user-DPAPI fallback", () => {
    let unprotectCalls = 0;
    const cookie = Buffer.from("v20app-bound-ciphertext");
    const result = decryptChromeCookie(cookie, null, () => {
      unprotectCalls += 1;
      return Buffer.from("must not be used");
    });

    expect(result).toBeNull();
    expect(unprotectCalls).toBe(0);
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
