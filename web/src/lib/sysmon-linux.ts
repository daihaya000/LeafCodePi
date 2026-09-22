import { execFile as nodeExecFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { posix } from "node:path";
import { clampPercent, type GpuMetric } from "@/lib/sysmon";

export type LinuxSysFs = {
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  runCommand?: (command: string, args: readonly string[]) => Promise<string>;
};

export function createNodeSysFs(): LinuxSysFs {
  return {
    async readdir(path: string) {
      return readdir(path);
    },
    async readFile(path: string) {
      return readFile(path, "utf8");
    },
    runCommand(command, args) {
      return new Promise((resolve, reject) => {
        nodeExecFile(
          command,
          [...args],
          { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 1000, windowsHide: true },
          (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          },
        );
      });
    },
  };
}

const CPU_THERMAL_TYPES = /x86_pkg_temp|cpu-thermal|cpu_thermal|acpitz|soc-thermal|k10temp|coretemp|zenpower/i;
const IGNORE_THERMAL_TYPES = /nvme|wifi|wlan|pch|battery|ambient|iwlwifi|ath10k|ath11k|gpu|amdgpu|radeon|i915|nouveau/i;
const CPU_HWMON_NAMES = /k10temp|coretemp|zenpower|acpitz|cpu_thermal|cpu-thermal|soc_thermal|soc-thermal/i;
const CPU_HWMON_LABELS = /tctl|tdie|package|core(?!\s*temp)|cpu/i;

/** Linux sysfs paths are always POSIX, even when unit tests run on Windows. */
const join = posix.join;

export function parseMilliCelsius(raw: string): number | null {
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  const tempC = n / 1000;
  if (tempC < -50 || tempC > 150) return null;
  return tempC;
}

export function isCpuThermalType(type: string): boolean {
  const value = type.trim();
  if (!value || IGNORE_THERMAL_TYPES.test(value)) return false;
  return CPU_THERMAL_TYPES.test(value);
}

export function isCpuHwmonName(name: string): boolean {
  return CPU_HWMON_NAMES.test(name.trim());
}

export function isCpuHwmonLabel(label: string): boolean {
  return CPU_HWMON_LABELS.test(label.trim());
}

export function pickHottestTemperature(values: readonly number[]): number | null {
  const valid = values.filter((value) => Number.isFinite(value) && value >= -50 && value <= 150);
  return valid.length > 0 ? Math.max(...valid) : null;
}

async function readOptional(fs: LinuxSysFs, path: string): Promise<string | null> {
  try {
    return await fs.readFile(path);
  } catch {
    return null;
  }
}

async function listOptional(fs: LinuxSysFs, path: string): Promise<string[]> {
  try {
    return await fs.readdir(path);
  } catch {
    return [];
  }
}

/** Hottest CPU-related reading from thermal zones + hwmon. Unknown chips stay unused. */
export async function collectLinuxCpuTemperature(
  fs: LinuxSysFs,
  roots = { thermal: "/sys/class/thermal", hwmon: "/sys/class/hwmon" },
): Promise<number | null> {
  const temperatures: number[] = [];

  for (const entry of await listOptional(fs, roots.thermal)) {
    if (!/^thermal_zone\d+$/.test(entry)) continue;
    const base = join(roots.thermal, entry);
    const type = (await readOptional(fs, join(base, "type"))) ?? "";
    if (!isCpuThermalType(type)) continue;
    const temp = parseMilliCelsius((await readOptional(fs, join(base, "temp"))) ?? "");
    if (temp !== null) temperatures.push(temp);
  }

  for (const entry of await listOptional(fs, roots.hwmon)) {
    if (!/^hwmon\d+$/.test(entry)) continue;
    const base = join(roots.hwmon, entry);
    const name = (await readOptional(fs, join(base, "name"))) ?? "";
    if (!isCpuHwmonName(name)) continue;
    const files = await listOptional(fs, base);
    const labeled: number[] = [];
    const unlabeled: number[] = [];
    for (const file of files) {
      const match = file.match(/^temp(\d+)_input$/);
      if (!match) continue;
      const temp = parseMilliCelsius((await readOptional(fs, join(base, file))) ?? "");
      if (temp === null) continue;
      const label = (await readOptional(fs, join(base, `temp${match[1]}_label`))) ?? "";
      if (!label || isCpuHwmonLabel(label)) labeled.push(temp);
      else unlabeled.push(temp);
    }
    temperatures.push(...(labeled.length > 0 ? labeled : unlabeled));
  }

  return pickHottestTemperature(temperatures);
}

export function isAmdPciVendor(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  return value === "0x1002" || value === "1002";
}

export function parseAmdGpuBusyPercent(raw: string): number | null {
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return clampPercent(n);
}

export function parseVramBytes(raw: string): number | null {
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

const KNOWN_AMD_GPU_NAMES: Record<string, string> = {
  "1002:7551/1eae:9801": "AMD Radeon AI PRO 9700",
};

export function parseKnownAmdGpuName(raw: string): string | null {
  const pciId = String(raw).match(/(?:^|\n)PCI_ID=([0-9a-f]{4}:[0-9a-f]{4})/i)?.[1].toLowerCase();
  if (!pciId) return null;
  const subsystemId = String(raw).match(/(?:^|\n)PCI_SUBSYS_ID=([0-9a-f]{4}:[0-9a-f]{4})/i)?.[1].toLowerCase();
  return (subsystemId ? KNOWN_AMD_GPU_NAMES[`${pciId}/${subsystemId}`] : null) ?? null;
}

export function parsePciSlotName(raw: string): string | null {
  return String(raw).match(/(?:^|\n)PCI_SLOT_NAME=([0-9a-f:.]+)/i)?.[1] ?? null;
}

export function parseLspciGpuName(raw: string): string | null {
  const line = String(raw)
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  const match = line?.match(/^\S+\s+[^:]+:\s*(.+)$/);
  if (!match) return null;
  return (
    match[1]
      .replace(/\s+\(rev [^)]+\)\s*$/, "")
      .replace(/^Advanced Micro Devices, Inc\. \[AMD\/ATI\]\s*/i, "")
      .trim() || null
  );
}

async function readLinuxGpuName(fs: LinuxSysFs, deviceDir: string, entry: string): Promise<string> {
  const uevent = (await readOptional(fs, join(deviceDir, "uevent"))) ?? "";
  const knownName = parseKnownAmdGpuName(uevent);
  if (knownName) return knownName;

  const product = ((await readOptional(fs, join(deviceDir, "product_name"))) ?? "").trim();
  if (product) return product;

  const slot = parsePciSlotName(uevent);
  if (slot && fs.runCommand) {
    try {
      const name = parseLspciGpuName(await fs.runCommand("lspci", ["-nn", "-s", slot]));
      if (name) return name;
    } catch {
      // pciutils is optional; keep the sysfs fallback when lspci is unavailable.
    }
  }
  return `AMD GPU (${entry})`;
}

async function readAmdGpuTemp(fs: LinuxSysFs, deviceDir: string): Promise<number | null> {
  const hwmonRoot = join(deviceDir, "hwmon");
  const temps: number[] = [];
  for (const entry of await listOptional(fs, hwmonRoot)) {
    if (!/^hwmon\d+$/.test(entry)) continue;
    const base = join(hwmonRoot, entry);
    for (const file of await listOptional(fs, base)) {
      if (!/^temp\d+_input$/.test(file)) continue;
      const temp = parseMilliCelsius((await readOptional(fs, join(base, file))) ?? "");
      if (temp !== null) temps.push(temp);
    }
  }
  return pickHottestTemperature(temps);
}

/** amdgpu sysfs cards only. Missing util/VRAM/temp stay null — never invented. */
export async function collectLinuxAmdGpus(
  fs: LinuxSysFs,
  drmRoot = "/sys/class/drm",
): Promise<GpuMetric[]> {
  const cards: GpuMetric[] = [];
  for (const entry of await listOptional(fs, drmRoot)) {
    if (!/^card\d+$/.test(entry)) continue;
    const deviceDir = join(drmRoot, entry, "device");
    const vendor = await readOptional(fs, join(deviceDir, "vendor"));
    if (!vendor || !isAmdPciVendor(vendor)) continue;
    const usedPercent = parseAmdGpuBusyPercent((await readOptional(fs, join(deviceDir, "gpu_busy_percent"))) ?? "");
    const vramUsedBytes = parseVramBytes((await readOptional(fs, join(deviceDir, "mem_info_vram_used"))) ?? "");
    const vramTotalBytes = parseVramBytes((await readOptional(fs, join(deviceDir, "mem_info_vram_total"))) ?? "");
    const tempC = await readAmdGpuTemp(fs, deviceDir);
    if (usedPercent === null && vramUsedBytes === null && vramTotalBytes === null && tempC === null) {
      continue;
    }
    const vramUsedPercent =
      vramUsedBytes !== null && vramTotalBytes !== null && vramTotalBytes > 0
        ? (vramUsedBytes / vramTotalBytes) * 100
        : null;
    cards.push({
      available: true,
      name: await readLinuxGpuName(fs, deviceDir, entry),
      usedPercent,
      vramUsedPercent,
      vramUsedBytes,
      vramTotalBytes,
      tempC,
      tempMaxC: null,
      reason: null,
    });
  }
  return cards.sort((a, b) => (b.vramTotalBytes ?? 0) - (a.vramTotalBytes ?? 0));
}
