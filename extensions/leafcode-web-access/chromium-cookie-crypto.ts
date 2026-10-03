/**
 * Shared Chromium cookie crypto and profile paths.
 *
 * leafcode-web-access (Gemini / fetch cookies) and CodexBar cookie auto-pull
 * both use this. Windows DPAPI / AES-GCM stays in each consumer.
 *
 * Must match web/src/lib/codexbar/chromium-cookie-crypto.ts (that copy is what
 * Next bundles; production mirrors only sync `web/`).
 */

import { execFile, execFileSync } from "node:child_process";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const DEFAULT_LINUX_SAFE_STORAGE_PASSWORD = "peanuts";
const LEGACY_LINUX_SAFE_STORAGE_SCHEMA = "chrome_libsecret_os_crypt_password";

export type ChromiumBrowserConfig = {
	id: string;
	name: string;
	baseDir: string;
	usesLocalAppData?: boolean;
	keychainService?: string;
	keychainAccount?: string;
	secretToolApp?: string;
};

export const MACOS_BROWSER_CONFIGS: ChromiumBrowserConfig[] = [
	{ id: "helium", name: "Helium", baseDir: "Library/Application Support/net.imput.helium", keychainService: "Helium Storage Key", keychainAccount: "Helium" },
	{ id: "chrome", name: "Chrome", baseDir: "Library/Application Support/Google/Chrome", keychainService: "Chrome Safe Storage", keychainAccount: "Chrome" },
	{ id: "brave", name: "Brave", baseDir: "Library/Application Support/BraveSoftware/Brave-Browser", keychainService: "Brave Safe Storage", keychainAccount: "Brave" },
	{ id: "arc", name: "Arc", baseDir: "Library/Application Support/Arc/User Data", keychainService: "Arc Safe Storage", keychainAccount: "Arc" },
];

export const LINUX_BROWSER_CONFIGS: ChromiumBrowserConfig[] = [
	{ id: "chromium", name: "Chromium", baseDir: ".config/chromium", secretToolApp: "chromium" },
	{ id: "chromium", name: "Chromium (Flatpak)", baseDir: ".var/app/org.chromium.Chromium/config/chromium", secretToolApp: "chromium" },
	{ id: "chrome", name: "Chrome", baseDir: ".config/google-chrome", secretToolApp: "chrome" },
	{ id: "brave", name: "Brave", baseDir: ".config/BraveSoftware/Brave-Browser", secretToolApp: "brave" },
	{ id: "edge", name: "Edge", baseDir: ".config/microsoft-edge", secretToolApp: "microsoft-edge" },
];

export const WINDOWS_BROWSER_CONFIGS: ChromiumBrowserConfig[] = [
	{ id: "chrome", name: "Chrome", baseDir: "Google/Chrome/User Data", usesLocalAppData: true },
	{ id: "edge", name: "Edge", baseDir: "Microsoft/Edge/User Data", usesLocalAppData: true },
];

export type LinuxSafeStoragePassword = {
	password: string;
	cacheable: boolean;
};

export function chromiumBrowserConfigsForPlatform(
	platform: NodeJS.Platform = process.platform,
): ChromiumBrowserConfig[] {
	if (platform === "darwin") return MACOS_BROWSER_CONFIGS;
	if (platform === "linux") return LINUX_BROWSER_CONFIGS;
	if (platform === "win32") return WINDOWS_BROWSER_CONFIGS;
	return [];
}

export function chromiumUserDataDir(
	config: ChromiumBrowserConfig,
	home = homedir(),
	env: NodeJS.Dict<string> = process.env,
): string {
	if (config.usesLocalAppData) {
		return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), config.baseDir);
	}
	const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
	if (xdgConfigHome && isAbsolute(xdgConfigHome) && config.baseDir.startsWith(".config/")) {
		return join(xdgConfigHome, config.baseDir.slice(".config/".length));
	}
	return join(home, config.baseDir);
}

/** Prefer Chrome 96+ Network/Cookies, then the legacy Cookies file. */
export function chromiumCookieDatabasePath(profilePath: string): string | null {
	const networkCookies = join(profilePath, "Network", "Cookies");
	if (existsSync(networkCookies)) return networkCookies;
	const legacyCookies = join(profilePath, "Cookies");
	return existsSync(legacyCookies) ? legacyCookies : null;
}

export function listChromiumProfileDirs(userDataDir: string): string[] {
	const profiles = new Set<string>();
	try {
		for (const entry of readdirSync(userDataDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const profilePath = join(userDataDir, entry.name);
			if (chromiumCookieDatabasePath(profilePath)) profiles.add(profilePath);
		}
	} catch {
		/* missing user-data dir */
	}
	return [...profiles];
}

export function deriveChromiumSafeStorageKey(
	password: string,
	platform: NodeJS.Platform = process.platform,
): Buffer {
	const iterations = platform === "darwin" ? 1003 : 1;
	return pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
}

function removePkcs7Padding(buf: Buffer): Buffer {
	if (!buf.length) return buf;
	const padding = buf[buf.length - 1];
	return !padding || padding > 16 ? buf : buf.subarray(0, buf.length - padding);
}

/**
 * Linux / macOS Chromium cookie values: v10/v11 AES-128-CBC with the Safe Storage key.
 * `stripHash` matches Chrome cookie meta version >= 24 (32-byte SHA256 prefix).
 */
export function decryptChromiumSafeStorageCookie(
	encrypted: Uint8Array,
	key: Buffer,
	stripHash: boolean,
): string | null {
	const buf = Buffer.from(encrypted);
	if (buf.length < 3 || !/^v\d\d$/.test(buf.subarray(0, 3).toString("utf8"))) return null;
	const ciphertext = buf.subarray(3);
	if (!ciphertext.length) return "";
	try {
		const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
		decipher.setAutoPadding(false);
		const unpadded = removePkcs7Padding(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
		const bytes = stripHash && unpadded.length >= 32 ? unpadded.subarray(32) : unpadded;
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		let i = 0;
		while (i < decoded.length && decoded.charCodeAt(i) < 0x20) i++;
		return decoded.slice(i);
	} catch {
		return null;
	}
}

function peanutsFallback(cacheable: boolean): LinuxSafeStoragePassword {
	return { password: DEFAULT_LINUX_SAFE_STORAGE_PASSWORD, cacheable };
}

/** Current entries use an app attribute; older Chromium entries have only the v1 schema. */
type LinuxSecretToolLookup = (attribute: string, value: string) => string | null;
type AsyncLinuxSecretToolLookup = (attribute: string, value: string) => string | null | Promise<string | null>;
type LinuxSecretToolLookupResult = { password: string; miss: boolean };

function isSecretToolNoMatch(error: unknown, stderrOutput?: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const details = error as { code?: unknown; status?: unknown; stderr?: unknown };
	const code = details.status ?? details.code;
	const stderrValue = stderrOutput ?? details.stderr;
	const stderr = Buffer.isBuffer(stderrValue) ? stderrValue.toString("utf8") : String(stderrValue ?? "");
	return String(code) === "1" && !stderr.trim();
}

function lookupLinuxSafeStorageValueSync(
	attribute: string,
	value: string,
	run?: LinuxSecretToolLookup,
): LinuxSecretToolLookupResult {
	try {
		const password = run
			? run(attribute, value)?.trim() ?? ""
			: execFileSync("secret-tool", ["lookup", attribute, value], {
					encoding: "utf8",
					timeout: 5000,
					stdio: ["ignore", "pipe", "pipe"],
				}).trim();
		return { password, miss: !password };
	} catch (error) {
		return { password: "", miss: isSecretToolNoMatch(error) };
	}
}

function lookupLinuxSafeStorageValue(
	attribute: string,
	value: string,
	run?: AsyncLinuxSecretToolLookup,
): Promise<LinuxSecretToolLookupResult> {
	if (run) {
		return Promise.resolve().then(() => run(attribute, value)).then((password) => {
			const normalized = password?.trim() ?? "";
			return { password: normalized, miss: !normalized };
		}).catch(() => ({ password: "", miss: false }));
	}
	return new Promise((resolve) => {
		try {
			execFile("secret-tool", ["lookup", attribute, value], { encoding: "utf8", timeout: 5000 }, (err, stdout, stderr) => {
				if (err) {
					resolve({ password: "", miss: isSecretToolNoMatch(err, stderr) });
					return;
				}
				const password = stdout.trim();
				resolve({ password, miss: !password });
			});
		} catch (error) {
			resolve({ password: "", miss: isSecretToolNoMatch(error) });
		}
	});
}

export function lookupLinuxSafeStoragePasswordSync(
	secretToolApp?: string,
	run?: LinuxSecretToolLookup,
): LinuxSafeStoragePassword {
	if (!secretToolApp) return peanutsFallback(true);
	const current = lookupLinuxSafeStorageValueSync("application", secretToolApp, run);
	if (current.password) return { password: current.password, cacheable: true };
	if (!current.miss) return peanutsFallback(false);
	const legacy = lookupLinuxSafeStorageValueSync("xdg:schema", LEGACY_LINUX_SAFE_STORAGE_SCHEMA, run);
	return legacy.password ? { password: legacy.password, cacheable: true } : peanutsFallback(false);
}

export async function lookupLinuxSafeStoragePassword(
	secretToolApp?: string,
	run?: AsyncLinuxSecretToolLookup,
): Promise<LinuxSafeStoragePassword> {
	if (!secretToolApp) return peanutsFallback(true);
	const current = await lookupLinuxSafeStorageValue("application", secretToolApp, run);
	if (current.password) return { password: current.password, cacheable: true };
	if (!current.miss) return peanutsFallback(false);
	const legacy = await lookupLinuxSafeStorageValue("xdg:schema", LEGACY_LINUX_SAFE_STORAGE_SCHEMA, run);
	return legacy.password ? { password: legacy.password, cacheable: true } : peanutsFallback(false);
}
