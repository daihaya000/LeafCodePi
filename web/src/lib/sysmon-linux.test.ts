import { describe, expect, it } from "vitest";
import {
  collectLinuxAmdGpus,
  collectLinuxCpuTemperature,
  isAmdPciVendor,
  isCpuHwmonName,
  isCpuThermalType,
  parseAmdGpuBusyPercent,
  parseLspciGpuName,
  parseMilliCelsius,
  parsePciSlotName,
  parseVramBytes,
  pickHottestTemperature,
  type LinuxSysFs,
} from "./sysmon-linux";

type RunCommand = (command: string, args: readonly string[]) => Promise<string>;

function memoryFs(
  files: Record<string, string>,
  dirs: Record<string, string[]>,
  runCommand?: RunCommand,
): LinuxSysFs {
  return {
    async readdir(path) {
      if (!(path in dirs)) throw new Error(`ENOENT: ${path}`);
      return dirs[path];
    },
    async readFile(path) {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
    ...(runCommand ? { runCommand } : {}),
  };
}

describe("linux thermal parsers", () => {
  it("converts millidegree sysfs values and rejects junk", () => {
    expect(parseMilliCelsius("55000\n")).toBe(55);
    expect(parseMilliCelsius("not-a-number")).toBeNull();
    expect(parseMilliCelsius("200000")).toBeNull();
    expect(pickHottestTemperature([41.2, 55, Number.NaN])).toBe(55);
    expect(pickHottestTemperature([])).toBeNull();
  });

  it("accepts CPU thermal types and hwmon chips, not nvme/wifi/gpu", () => {
    expect(isCpuThermalType("x86_pkg_temp")).toBe(true);
    expect(isCpuThermalType("acpitz")).toBe(true);
    expect(isCpuThermalType("nvme")).toBe(false);
    expect(isCpuThermalType("amdgpu")).toBe(false);
    expect(isCpuHwmonName("k10temp")).toBe(true);
    expect(isCpuHwmonName("coretemp")).toBe(true);
    expect(isCpuHwmonName("amdgpu")).toBe(false);
  });
});

describe("collectLinuxCpuTemperature", () => {
  it("returns the hottest CPU-related reading and ignores other zones", async () => {
    const fs = memoryFs(
      {
        "/sys/class/thermal/thermal_zone0/type": "x86_pkg_temp",
        "/sys/class/thermal/thermal_zone0/temp": "47000",
        "/sys/class/thermal/thermal_zone1/type": "nvme",
        "/sys/class/thermal/thermal_zone1/temp": "65000",
        "/sys/class/hwmon/hwmon0/name": "k10temp",
        "/sys/class/hwmon/hwmon0/temp1_input": "51250",
        "/sys/class/hwmon/hwmon0/temp1_label": "Tctl",
        "/sys/class/hwmon/hwmon1/name": "amdgpu",
        "/sys/class/hwmon/hwmon1/temp1_input": "80000",
      },
      {
        "/sys/class/thermal": ["thermal_zone0", "thermal_zone1"],
        "/sys/class/hwmon": ["hwmon0", "hwmon1"],
        "/sys/class/hwmon/hwmon0": ["name", "temp1_input", "temp1_label"],
        "/sys/class/hwmon/hwmon1": ["name", "temp1_input"],
      },
    );
    expect(await collectLinuxCpuTemperature(fs)).toBe(51.25);
  });

  it("returns null when no reliable CPU sensor exists", async () => {
    const fs = memoryFs(
      {
        "/sys/class/thermal/thermal_zone0/type": "nvme",
        "/sys/class/thermal/thermal_zone0/temp": "42000",
      },
      {
        "/sys/class/thermal": ["thermal_zone0"],
        "/sys/class/hwmon": [],
      },
    );
    expect(await collectLinuxCpuTemperature(fs)).toBeNull();
  });
});

describe("collectLinuxAmdGpus", () => {
  it("uses lspci when amdgpu product_name is unavailable", async () => {
    expect(parsePciSlotName("DRIVER=amdgpu\nPCI_SLOT_NAME=0000:03:00.0\n")).toBe("0000:03:00.0");
    expect(
      parseLspciGpuName(
        "0000:03:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Radeon RX [1002:7551] (rev c0)\n",
      ),
    ).toBe("Radeon RX [1002:7551]");

    const commands: string[][] = [];
    const fs = memoryFs(
      {
        "/sys/class/drm/card1/device/vendor": "0x1002",
        "/sys/class/drm/card1/device/uevent": "DRIVER=amdgpu\nPCI_SLOT_NAME=0000:03:00.0\n",
        "/sys/class/drm/card1/device/gpu_busy_percent": "40",
        "/sys/class/drm/card1/device/mem_info_vram_used": "1073741824",
        "/sys/class/drm/card1/device/mem_info_vram_total": "8589934592",
      },
      {
        "/sys/class/drm": ["card1"],
        "/sys/class/drm/card1/device/hwmon": [],
      },
      async (command, args) => {
        commands.push([command, ...args]);
        return "0000:03:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Radeon RX [1002:7551] (rev c0)\n";
      },
    );

    await expect(collectLinuxAmdGpus(fs)).resolves.toMatchObject([
      { name: "Radeon RX [1002:7551]" },
    ]);
    expect(commands).toEqual([["lspci", "-nn", "-s", "0000:03:00.0"]]);
  });

  it("reads amdgpu sysfs cards and sorts larger VRAM first", async () => {
    expect(isAmdPciVendor("0x1002")).toBe(true);
    expect(parseAmdGpuBusyPercent("37\n")).toBe(37);
    expect(parseAmdGpuBusyPercent("")).toBeNull();
    expect(parseVramBytes("2147483648")).toBe(2147483648);
    expect(parseVramBytes("")).toBeNull();
    expect(parseVramBytes("0")).toBeNull();

    const fs = memoryFs(
      {
        "/sys/class/drm/card0/device/vendor": "0x1002",
        "/sys/class/drm/card0/device/product_name": "AMD Radeon Graphics",
        "/sys/class/drm/card0/device/gpu_busy_percent": "8",
        "/sys/class/drm/card0/device/mem_info_vram_used": "268435456",
        "/sys/class/drm/card0/device/mem_info_vram_total": "536870912",
        "/sys/class/drm/card1/device/vendor": "0x1002",
        "/sys/class/drm/card1/device/product_name": "AMD Radeon RX",
        "/sys/class/drm/card1/device/gpu_busy_percent": "40",
        "/sys/class/drm/card1/device/mem_info_vram_used": "1073741824",
        "/sys/class/drm/card1/device/mem_info_vram_total": "8589934592",
        "/sys/class/drm/card1/device/hwmon/hwmon2/temp1_input": "61000",
        "/sys/class/drm/card2/device/vendor": "0x10de",
      },
      {
        "/sys/class/drm": ["card0", "card1", "card2", "card1-HDMI-A-1", "renderD128"],
        "/sys/class/drm/card0/device/hwmon": [],
        "/sys/class/drm/card1/device/hwmon": ["hwmon2"],
        "/sys/class/drm/card1/device/hwmon/hwmon2": ["temp1_input"],
      },
    );

    const gpus = await collectLinuxAmdGpus(fs);
    expect(gpus.map((gpu) => gpu.name)).toEqual(["AMD Radeon RX", "AMD Radeon Graphics"]);
    expect(gpus[0]).toMatchObject({
      usedPercent: 40,
      vramTotalBytes: 8589934592,
      tempC: 61,
      tempMaxC: null,
    });
    expect(gpus[1].tempC).toBeNull();
  });

  it("skips AMD cards that have no readable metrics", async () => {
    const fs = memoryFs(
      { "/sys/class/drm/card0/device/vendor": "0x1002" },
      { "/sys/class/drm": ["card0"], "/sys/class/drm/card0/device/hwmon": [] },
    );
    expect(await collectLinuxAmdGpus(fs)).toEqual([]);
  });
});
